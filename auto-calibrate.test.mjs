// transcript-tokens.mjs's autoCalibrateIfMissing(): the estimator stays "uncalibrated" until
// someone remembers to run transcript-tokens.mjs --write by hand, and nobody does (confirmed:
// token-calibration.json still did not exist after several rounds of this tool being built). This
// closes that gap by trying once, automatically, the first time a session starts with nothing
// calibrated yet - see relay.mjs's maybeAutoCalibrate for the WEBSCOUT_AUTO_CALIBRATE opt-in and
// why it is opt-in, not opt-out (a test run once wrote a REAL token-calibration.json from this
// machine's real transcripts before that flip - see [[web-scout-v35-round]]).
//
// CALIBRATION_PATH (token-estimate.mjs) is a load-time constant read from
// WEBSCOUT_TOKEN_CALIBRATION once, at import - so every case here that needs a specific
// calibration path runs in its OWN fresh child process (same pattern token-estimate.test.mjs and
// transcript-tokens.test.mjs already use), never by mutating process.env in this process and
// calling the already-imported function directly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnClean, startTestRelay } from './test-relay.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));

let seq = 0;
const nextTs = () => new Date(2026, 0, 1, 0, 0, seq++).toISOString();
const usage = (input) => ({ input_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: input, output_tokens: 0 });
function assistantLine({ id, promptTokens, outputTokens = 20, blocks }) {
  return JSON.stringify({ type: 'assistant', isSidechain: false, timestamp: nextTs(), message: { id, role: 'assistant', content: blocks, usage: { ...usage(promptTokens), output_tokens: outputTokens } } });
}
function toolUse(id, name, input) { return { type: 'tool_use', id, name, input }; }
function userResultLine({ toolUseId, text }) {
  return JSON.stringify({ type: 'user', isSidechain: false, timestamp: nextTs(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: [{ type: 'text', text }] }] } });
}
function cleanStep(promptSoFar, { chars, ratio, overhead = 0, outputTokens = 20 }) {
  const id = `msg_${promptSoFar}_${chars}`;
  const toolId = `tool_${id}`;
  const replyTokens = Math.round(overhead + chars / ratio);
  const lines = [
    assistantLine({ id, promptTokens: promptSoFar, outputTokens, blocks: [toolUse(toolId, 'Bash', { command: 'node tools/web-scout/cli.mjs idb dump notes' })] }),
    userResultLine({ toolUseId: toolId, text: 'x'.repeat(chars) }),
  ];
  return { lines, nextPrompt: promptSoFar + outputTokens + replyTokens };
}

// A dozen clean gaps of varying size (fitLine needs spread >= 2x between smallest and largest to
// separate the per-char cost from the per-reply constant) at a known, exact ratio.
function buildTranscript({ ratio = 3, n = 12 } = {}) {
  let prompt = 1000;
  const lines = [];
  for (let i = 0; i < n; i += 1) {
    const { lines: stepLines, nextPrompt } = cleanStep(prompt, { chars: 400 + i * 300, ratio });
    lines.push(...stepLines);
    prompt = nextPrompt;
  }
  lines.push(assistantLine({ id: 'close', promptTokens: prompt, blocks: [{ type: 'text', text: 'done' }] }));
  return lines.join('\n');
}

function fixtureHome(transcriptText) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'webscout-autocal-home-'));
  if (transcriptText !== null) {
    const projDir = path.join(home, '.claude', 'projects', 'fixture-project');
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, 'session.jsonl'), transcriptText);
  }
  return home;
}

// Runs autoCalibrateIfMissing in a fresh process (see the file header on why) against `homeDir`,
// with `calFile` as WEBSCOUT_TOKEN_CALIBRATION (pre-seeded with `existingCalibration` when given).
function run({ homeDir, calFile, existingCalibration, minSamples = 8 }) {
  if (existingCalibration) fs.writeFileSync(calFile, JSON.stringify(existingCalibration));
  const script = `const m = await import(${JSON.stringify(new URL('./transcript-tokens.mjs', import.meta.url).href)}); console.log(JSON.stringify(m.autoCalibrateIfMissing(${JSON.stringify({ homeDir, minSamples })})));`;
  const r = spawnClean(['--input-type=module', '-e', script], { env: { WEBSCOUT_TOKEN_CALIBRATION: calFile } });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('writes a calibration file when uncalibrated and enough clean samples exist', () => {
  const calDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webscout-autocal-cal-'));
  const calFile = path.join(calDir, 'token-calibration.json');
  const home = fixtureHome(buildTranscript({ ratio: 3 }));
  try {
    const outcome = run({ homeDir: home, calFile });
    assert.equal(outcome.attempted, true);
    assert.equal(outcome.written, true);
    assert.ok(outcome.kinds.includes('json'), JSON.stringify(outcome));
    const written = JSON.parse(fs.readFileSync(calFile, 'utf8'));
    assert.equal(written.method, 'transcripts');
    assert.ok(written.kinds.json.ratio > 0);
  } finally {
    fs.rmSync(calDir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('never overwrites an existing calibration, even a stale/partial one', () => {
  const calDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webscout-autocal-cal-'));
  const calFile = path.join(calDir, 'token-calibration.json');
  const home = fixtureHome(buildTranscript({ ratio: 3 }));
  const existing = { method: 'count_tokens', model: 'claude-x', sampledAt: '2020-01-01T00:00:00.000Z', kinds: { json: { ratio: 5, low: 4, high: 6 } } };
  try {
    const outcome = run({ homeDir: home, calFile, existingCalibration: existing });
    assert.equal(outcome.attempted, false);
    assert.deepEqual(JSON.parse(fs.readFileSync(calFile, 'utf8')), existing, 'left untouched');
  } finally {
    fs.rmSync(calDir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('no transcripts found: attempted, not written, a clear reason', () => {
  const calDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webscout-autocal-cal-'));
  const calFile = path.join(calDir, 'token-calibration.json');
  const home = fixtureHome(null);
  try {
    const outcome = run({ homeDir: home, calFile });
    assert.equal(outcome.attempted, true);
    assert.equal(outcome.written, false);
    assert.match(outcome.reason, /no claude code transcripts found/i);
    assert.ok(!fs.existsSync(calFile));
  } finally {
    fs.rmSync(calDir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('not enough clean samples: attempted, not written, never throws', () => {
  const calDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webscout-autocal-cal-'));
  const calFile = path.join(calDir, 'token-calibration.json');
  const home = fixtureHome(buildTranscript({ ratio: 3, n: 2 })); // well under minSamples
  try {
    const outcome = run({ homeDir: home, calFile, minSamples: 8 });
    assert.equal(outcome.attempted, true);
    assert.equal(outcome.written, false);
    assert.match(outcome.reason, /not enough clean samples/);
  } finally {
    fs.rmSync(calDir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// Real relay wiring: WEBSCOUT_AUTO_CALIBRATE=1 + WEBSCOUT_TRANSCRIPT_HOME pointed at a fixture -
// "session start" on a relay with nothing calibrated yet should produce a real calibration file,
// picked up by a LATER token-report's estimator info without restarting the relay
// (resetCalibrationCache runs in the same process that wrote the file).
test('a real "session start" auto-calibrates once, live, on a relay with nothing calibrated', async (t) => {
  const calDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webscout-autocal-live-'));
  const calFile = path.join(calDir, 'token-calibration.json');
  const home = fixtureHome(buildTranscript({ ratio: 3 }));
  const relay = await startTestRelay({ env: { WEBSCOUT_AUTO_CALIBRATE: '1', WEBSCOUT_TRANSCRIPT_HOME: home, WEBSCOUT_TOKEN_CALIBRATION: calFile } });
  t.after(async () => { await relay.stop(); fs.rmSync(calDir, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); });
  if (relay.live) { t.skip('WEBSCOUT_TEST_LIVE=1 - cannot force a fresh, uncalibrated relay'); return; }
  const base = `http://127.0.0.1:${relay.port}`;
  const before = await (await fetch(`${base}/token-report`)).json();
  assert.equal(before.result.savings.estimator.status, 'uncalibrated');
  // WEBSCOUT_AUTO_CALIBRATE=1 is set on this relay, but no session has started yet, so
  // maybeAutoCalibrate() has not even been scheduled - the note should say so specifically,
  // not just "no usable token-calibration.json" (see token-estimate.mjs's autoCalibrateClause).
  assert.match(before.result.savings.estimator.note, /has not run yet on this relay/);
  await fetch(`${base}/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ goal: 'auto-calibrate smoke test', briefing: false }) });
  // setImmediate-deferred and disk-bound - poll briefly rather than assume it lands on the first tick.
  let after;
  for (let i = 0; i < 30; i += 1) {
    after = await (await fetch(`${base}/token-report`)).json();
    if (after.result.savings.estimator.status !== 'uncalibrated') break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.notEqual(after.result.savings.estimator.status, 'uncalibrated', JSON.stringify(after.result.savings.estimator));
  assert.equal(after.result.savings.estimator.method, 'transcripts');
  assert.ok(fs.existsSync(calFile));
});
