// transcript-tokens.mjs: measures chars-per-token from a Claude Code transcript's own `usage`
// deltas, so calibration works with no ANTHROPIC_API_KEY. Fixtures are synthetic JSONL built to
// the same shape intent-import.mjs already parses, with a known, exact chars/token ratio baked
// in, so calibrateFromSamples's fitted output can be checked against ground truth.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractGaps, calibrateFromSamples, scoutKind, classifyText, readTranscripts, MIN_GAP_CHARS } from './transcript-tokens.mjs';
import { spawnClean } from './test-relay.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));

let seq = 0;
const nextTs = () => new Date(2026, 0, 1, 0, 0, seq++).toISOString();
const usage = (input) => ({ input_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: input, output_tokens: 0 });

function assistantLine({ id, promptTokens, outputTokens = 20, blocks }) {
  return JSON.stringify({ type: 'assistant', isSidechain: false, timestamp: nextTs(), message: { id, role: 'assistant', content: blocks, usage: { ...usage(promptTokens), output_tokens: outputTokens } } });
}
function toolUse(id, name, input) { return { type: 'tool_use', id, name, input }; }
function userResultLine({ toolUseId, text, extraText, image }) {
  const results = [{ type: 'tool_result', tool_use_id: toolUseId, content: image ? [{ type: 'image', source: {} }] : [{ type: 'text', text }] }];
  const content = extraText ? [...results, { type: 'text', text: extraText }] : results;
  return JSON.stringify({ type: 'user', isSidechain: false, timestamp: nextTs(), message: { role: 'user', content } });
}
function attachmentLine(chars) {
  return JSON.stringify({ type: 'attachment', timestamp: nextTs(), attachment: { blob: 'x'.repeat(chars) } });
}

// Builds one clean "assistant calls a web-scout command, gets exactly `chars` of reply text back,
// costing exactly round(overhead + chars / ratio) prompt tokens" step, chained onto `promptSoFar`.
function cleanStep(promptSoFar, { command = 'node tools/web-scout/cli.mjs idb dump notes', chars, ratio, overhead = 0, outputTokens = 20 }) {
  const id = `msg_${promptSoFar}_${chars}`;
  const toolId = `tool_${id}`;
  const replyTokens = Math.round(overhead + chars / ratio);
  const lines = [
    assistantLine({ id, promptTokens: promptSoFar, outputTokens, blocks: [toolUse(toolId, 'Bash', { command })] }),
    userResultLine({ toolUseId: toolId, text: 'x'.repeat(chars) }),
  ];
  return { lines, nextPrompt: promptSoFar + outputTokens + replyTokens };
}

test('a clean gap yields exactly one sample with the right kind, chars and tokens', () => {
  let prompt = 1000;
  const { lines, nextPrompt } = cleanStep(prompt, { chars: 900, ratio: 3 });
  prompt = nextPrompt;
  // a closing assistant message so the gap has a "next" usage to diff against
  const closing = assistantLine({ id: 'close', promptTokens: prompt, blocks: [{ type: 'text', text: 'done' }] });
  const text = [...lines, closing].join('\n');
  const { samples, stats } = extractGaps(text);
  assert.equal(samples.length, 1);
  assert.equal(samples[0].kind, 'json');
  assert.equal(samples[0].chars, 900);
  assert.equal(samples[0].tokens, 300);
  assert.equal(stats.used, 1);
  assert.equal(stats.gaps, 1);
});

test('dom/react commands are classified html, help is prose, an unrelated Bash command is skipped', () => {
  assert.equal(scoutKind('Bash', { command: 'node tools/web-scout/cli.mjs dom query .row' }), 'html');
  assert.equal(scoutKind('Bash', { command: 'node tools/web-scout/cli.mjs react tree .app' }), 'html');
  assert.equal(scoutKind('Bash', { command: 'node tools/web-scout/cli.mjs help idb dump' }), 'prose');
  assert.equal(scoutKind('Bash', { command: 'git status' }), null);
  assert.equal(scoutKind('mcp__web-scout__webscout_dom', { action: 'query' }), 'html'); // Claude Code's actual "mcp__<server>__<tool>" shape
  assert.equal(scoutKind('webscout_idb', { action: 'dump' }), 'json');
});

test('classifyText tells JSON, HTML and prose apart for --all-tools sampling', () => {
  assert.equal(classifyText('{"a":1,"b":[1,2,3]}'), 'json');
  assert.equal(classifyText('<div class="x"><span>hi</span></div>'), 'html');
  assert.equal(classifyText('This is a plain English sentence about the weather.'), 'prose');
});

test('a bundled multi-tool step is skipped (ambiguous which tool the reply cost belongs to)', () => {
  let prompt = 500;
  const id = 'multi';
  const a = assistantLine({ id, promptTokens: prompt, blocks: [toolUse('t1', 'Bash', { command: 'node tools/web-scout/cli.mjs idb dump a' }), toolUse('t2', 'Bash', { command: 'node tools/web-scout/cli.mjs idb dump b' })] });
  const u1 = userResultLine({ toolUseId: 't1', text: 'x'.repeat(400) });
  const u2 = userResultLine({ toolUseId: 't2', text: 'x'.repeat(400) });
  const close = assistantLine({ id: 'close', promptTokens: prompt + 200 });
  const { samples, stats } = extractGaps([a, u1, u2, close].join('\n'));
  assert.equal(samples.length, 0);
  assert.equal(stats.skipped.multiTool, 1);
});

test('a step whose result never arrives is skipped, not crashed on', () => {
  const a = assistantLine({ id: 'orphan', promptTokens: 500, blocks: [toolUse('t1', 'Bash', { command: 'node tools/web-scout/cli.mjs idb dump a' })] });
  const close = assistantLine({ id: 'close', promptTokens: 700 });
  const { samples, stats } = extractGaps([a, close].join('\n'));
  assert.equal(samples.length, 0);
  assert.equal(stats.skipped.noResult, 1);
});

test('extra prose alongside the tool result, an attachment riding in the gap, an image reply, and a too-small reply are all skipped', () => {
  let prompt = 1000;
  const mk = (extra) => {
    const id = `s_${Math.random()}`;
    const a = assistantLine({ id, promptTokens: prompt, blocks: [toolUse(`t_${id}`, 'Bash', { command: 'node tools/web-scout/cli.mjs idb dump a' })] });
    return { id, a, toolId: `t_${id}` };
  };
  const { a: a1, toolId: t1 } = mk();
  const u1 = userResultLine({ toolUseId: t1, text: 'x'.repeat(900), extraText: 'y'.repeat(300) });
  const { a: a2, toolId: t2 } = mk();
  const between = attachmentLine(500);
  const u2 = userResultLine({ toolUseId: t2, text: 'x'.repeat(900) });
  const { a: a3, toolId: t3 } = mk();
  const u3 = userResultLine({ toolUseId: t3, text: '', image: true });
  const { a: a4, toolId: t4 } = mk();
  const u4 = userResultLine({ toolUseId: t4, text: 'x'.repeat(MIN_GAP_CHARS - 50) });
  const close = assistantLine({ id: 'close', promptTokens: prompt + 5000 });
  const { samples, stats } = extractGaps([a1, u1, a2, between, u2, a3, u3, a4, u4, close].join('\n'));
  assert.equal(samples.length, 0);
  assert.equal(stats.skipped.userText, 1);
  assert.equal(stats.skipped.interloper, 1);
  assert.equal(stats.skipped.image, 1);
  assert.equal(stats.skipped.small, 1);
});

test('a shrinking prompt (context compaction between calls) never yields a negative-token sample', () => {
  const a = assistantLine({ id: 'a', promptTokens: 50000, blocks: [toolUse('t1', 'Bash', { command: 'node tools/web-scout/cli.mjs idb dump a' })] });
  const u = userResultLine({ toolUseId: 't1', text: 'x'.repeat(900) });
  const close = assistantLine({ id: 'close', promptTokens: 4000 }); // compacted - smaller than before
  const { samples, stats } = extractGaps([a, u, close].join('\n'));
  assert.equal(samples.length, 0);
  assert.equal(stats.skipped.negative, 1);
});

test('calibrateFromSamples recovers a known ratio from many clean gaps, ignoring the per-reply constant', () => {
  const ratio = 2.6;
  const overhead = 40;
  const samples = [];
  for (let i = 0; i < 30; i += 1) {
    const chars = 300 + i * 150; // wide spread, required to separate slope from intercept
    samples.push({ kind: 'json', chars, tokens: Math.round(overhead + chars / ratio) });
  }
  const cal = calibrateFromSamples({ samples });
  assert.ok(cal.kinds.json, JSON.stringify(cal.detail));
  assert.ok(Math.abs(cal.kinds.json.ratio - ratio) < 0.05, `expected ~${ratio}, got ${cal.kinds.json.ratio}`);
  assert.ok(cal.kinds.json.low <= cal.kinds.json.ratio && cal.kinds.json.ratio <= cal.kinds.json.high);
  assert.ok(Math.abs(cal.perReplyConstantTokens - overhead) < 15);
});

test('a kind with too few samples, or samples that are all nearly the same size, is skipped rather than guessed', () => {
  const few = [{ kind: 'html', chars: 500, tokens: 200 }, { kind: 'html', chars: 520, tokens: 205 }];
  const cal1 = calibrateFromSamples({ samples: few });
  assert.ok(!cal1.kinds.html);
  assert.match(cal1.detail.html.skipped, /fewer than/);

  const alike = Array.from({ length: 20 }, () => ({ kind: 'html', chars: 500 + Math.round(Math.random() * 5), tokens: 200 }));
  const cal2 = calibrateFromSamples({ samples: alike });
  assert.ok(!cal2.kinds.html);
  assert.match(cal2.detail.html.skipped, /too alike/);
});

test('a fit that lands outside plausible chars/token bounds is rejected, not reported as calibrated', () => {
  // a real, positive, well-separated slope - just an implausible one (50 chars/token - transcript
  // noise, not text), so this exercises the plausibility check, not the "too alike" one.
  const junk = Array.from({ length: 20 }, (_, i) => { const chars = 300 + i * 150; return { kind: 'prose', chars, tokens: Math.round(chars / 50) }; });
  const cal = calibrateFromSamples({ samples: junk });
  assert.ok(!cal.kinds.prose);
  assert.match(cal.detail.prose.skipped, /outside/);
});

test('readTranscripts aggregates several files and reports a read error without throwing', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'webscout-transcripts-'));
  try {
    const ratio = 3;
    let prompt = 1000;
    const lines = [];
    for (let i = 0; i < 15; i += 1) {
      const { lines: step, nextPrompt } = cleanStep(prompt, { chars: 400 + i * 100, ratio });
      lines.push(...step);
      prompt = nextPrompt;
    }
    lines.push(assistantLine({ id: 'close', promptTokens: prompt }));
    const f1 = path.join(tmp, 'a.jsonl');
    fs.writeFileSync(f1, lines.join('\n'));
    const missing = path.join(tmp, 'missing.jsonl');
    const { samples, transcripts } = readTranscripts([f1, missing]);
    assert.ok(samples.length >= 10);
    assert.equal(transcripts.find((t) => t.file === f1).used, samples.length);
    assert.ok(transcripts.find((t) => t.file === missing).error);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('CLI: --write stores a token-calibration.json labelled method "transcripts", which token-estimate.mjs then reports as its source', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'webscout-transcripts-cli-'));
  try {
    const ratio = 2.8;
    let prompt = 2000;
    const lines = [];
    for (let i = 0; i < 25; i += 1) {
      const { lines: step, nextPrompt } = cleanStep(prompt, { chars: 300 + i * 200, ratio });
      lines.push(...step);
      prompt = nextPrompt;
    }
    lines.push(assistantLine({ id: 'close', promptTokens: prompt }));
    const transcript = path.join(tmp, 'session.jsonl');
    fs.writeFileSync(transcript, lines.join('\n'));
    const calFile = path.join(tmp, 'token-calibration.json');

    const dry = spawnClean([path.join(dir, 'transcript-tokens.mjs'), transcript], { env: { WEBSCOUT_TOKEN_CALIBRATION: calFile } });
    assert.equal(dry.status, 0, dry.stdout + dry.stderr);
    assert.match(dry.stderr, /dry run/);
    assert.ok(!fs.existsSync(calFile));

    const written = spawnClean([path.join(dir, 'transcript-tokens.mjs'), transcript, '--write'], { env: { WEBSCOUT_TOKEN_CALIBRATION: calFile } });
    assert.equal(written.status, 0, written.stdout + written.stderr);
    assert.match(written.stderr, /no API key used/);
    const saved = JSON.parse(fs.readFileSync(calFile, 'utf8'));
    assert.equal(saved.method, 'transcripts');
    assert.ok(saved.kinds.json);
    assert.ok(Math.abs(saved.kinds.json.ratio - ratio) < 0.1);

    const script = `const m = await import(${JSON.stringify(new URL('./token-estimate.mjs', import.meta.url).href)}); console.log(JSON.stringify(m.estimatorInfo()));`;
    const info = spawnClean(['--input-type=module', '-e', script], { env: { WEBSCOUT_TOKEN_CALIBRATION: calFile } });
    assert.equal(info.status, 0, info.stderr);
    const parsed = JSON.parse(info.stdout);
    assert.equal(parsed.method, 'transcripts');
    assert.match(parsed.source, /from session transcripts, an estimate/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('CLI: no transcripts found (nothing to discover) exits 1 with a clear reason, not a crash', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'webscout-transcripts-empty-'));
  try {
    const r = spawnClean([path.join(dir, 'transcript-tokens.mjs'), '--home', tmp]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no Claude Code transcripts found/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
