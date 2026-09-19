// intent-import turns an agent transcript into a "why" per logged action. The transcript shapes
// here are hand-built from the documented Claude Code JSONL and the observed Codex rollout format
// - if a host changes its format, these are the tests that should be updated alongside the parser.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { condenseWhy, parseTranscript, matchCallsToActions, discoverTranscripts, importIntents, readTranscriptFile } from './intent-import.mjs';

const BASE = Date.parse('2026-09-19T10:00:00.000Z');
const iso = (sec) => new Date(BASE + sec * 1000).toISOString();
const jsonl = (...lines) => lines.map((l) => JSON.stringify(l)).join('\n');

const claudeText = (sec, text, extra = {}) => ({ type: 'assistant', timestamp: iso(sec), message: { role: 'assistant', content: [{ type: 'text', text }] }, ...extra });
const claudeTool = (sec, id, name, input, extra = {}) => ({ type: 'assistant', timestamp: iso(sec), message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] }, ...extra });
const claudeResult = (sec, id) => ({ type: 'user', timestamp: iso(sec), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
const row = (id, type, sec) => ({ id, type, started_at: iso(sec) });

describe('condenseWhy', () => {
  test('keeps a short sentence, takes the last paragraph of a long one, clips the rest', () => {
    assert.equal(condenseWhy('  checking   the row  '), 'checking the row');
    assert.equal(condenseWhy('First I looked at things.\n\nNow saving the form.'), 'Now saving the form.');
    const long = `${'blah '.repeat(80)}. Then I will click save.`;
    const out = condenseWhy(long);
    assert.ok(out.length <= 285);
    assert.match(out, /click save\.$/);
    assert.equal(condenseWhy(''), '');
  });
});

describe('parseTranscript - Claude Code', () => {
  test('narration just before a web-scout call becomes its why; the result closes the window', () => {
    const t = jsonl(
      claudeText(0, 'Checking whether the save wrote a row.'),
      claudeTool(1, 'toolu_a', 'Bash', { command: 'node tools/web-scout/cli.mjs idb dump skills' }),
      claudeResult(3, 'toolu_a'),
    );
    const { calls, format, stats } = parseTranscript(t);
    assert.equal(format, 'claude');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].why, 'Checking whether the save wrote a row.');
    assert.equal(calls[0].source, 'transcript');
    assert.equal(calls[0].at, BASE + 1000);
    assert.equal(calls[0].endAt, BASE + 3000);
    assert.equal(stats.scoutCalls, 1);
    assert.equal(stats.narrated, 1);
  });

  test('other tools are ignored, MCP web-scout tools are recognised', () => {
    const t = jsonl(
      claudeText(0, 'Reading the file.'),
      claudeTool(1, 'r', 'Read', { file_path: 'x' }),
      claudeResult(2, 'r'),
      claudeText(3, 'Clicking save.'),
      claudeTool(4, 'm', 'mcp__web-scout__webscout_dom', { action: 'click', selector: '#save' }),
    );
    const { calls, stats } = parseTranscript(t);
    assert.equal(stats.toolCalls, 2);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].sig, 'domclick');
  });

  test('a call with no narration of its own inherits a recent one, labelled as carried', () => {
    const t = jsonl(
      claudeText(0, 'First thing.'),
      claudeTool(1, 'a', 'Bash', { command: 'node cli.mjs dom query x' }),
      claudeResult(2, 'a'),
      claudeTool(3, 'b', 'Bash', { command: 'node cli.mjs dom query y' }),
    );
    const { calls, stats } = parseTranscript(t);
    assert.deepEqual([calls[0].why, calls[0].source], ['First thing.', 'transcript']);
    assert.deepEqual([calls[1].why, calls[1].source], ['First thing.', 'transcript-carried']);
    assert.equal(stats.carried, 1);
  });

  test('the carry stops two calls after the narration, counting every tool call, not just web-scout ones', () => {
    const scout = (sec, id) => claudeTool(sec, id, 'Bash', { command: `node cli.mjs dom query ${id}` });
    const other = (sec, id) => claudeTool(sec, id, 'Read', { file_path: id });
    const t = jsonl(
      claudeText(0, 'Doing the thing.'),
      other(1, 'r1'), claudeResult(2, 'r1'),
      scout(3, 's1'), claudeResult(4, 's1'), // 1 tool call after the narration: carried
      scout(5, 's2'), claudeResult(6, 's2'), // 2: carried
      scout(7, 's3'), // 3: too far
    );
    const { calls } = parseTranscript(t);
    assert.deepEqual(calls.map((c) => c.source), ['transcript-carried', 'transcript-carried', null]);
    assert.equal(calls[2].why, '');
  });

  test('a new user prompt forgets the old narration; a tool result does not', () => {
    const t = jsonl(
      claudeText(0, 'Old plan.'),
      claudeTool(1, 'a', 'Bash', { command: 'node cli.mjs dom query a' }),
      claudeResult(2, 'a'),
      { type: 'user', timestamp: iso(3), message: { role: 'user', content: 'now do something else' } },
      claudeTool(4, 'b', 'Bash', { command: 'node cli.mjs dom query b' }),
    );
    const { calls } = parseTranscript(t);
    assert.equal(calls[0].source, 'transcript');
    assert.equal(calls[1].source, null);
  });

  test('a call\'s own narration always beats a carried one', () => {
    const t = jsonl(
      claudeText(0, 'Plan.'), claudeTool(1, 'a', 'Bash', { command: 'node cli.mjs dom query a' }), claudeResult(2, 'a'),
      claudeText(3, 'Now the second thing.'), claudeTool(4, 'b', 'Bash', { command: 'node cli.mjs dom query b' }),
    );
    const { calls } = parseTranscript(t);
    assert.deepEqual([calls[1].why, calls[1].source], ['Now the second thing.', 'transcript']);
  });

  test('a reasoning block stands in when there was no narration, and is labelled as such', () => {
    const t = jsonl(
      { type: 'assistant', timestamp: iso(0), message: { content: [{ type: 'thinking', thinking: 'The row may not have saved; look at the store.' }] } },
      claudeTool(1, 'a', 'Bash', { command: 'node cli.mjs idb dump skills' }),
    );
    const { calls } = parseTranscript(t);
    assert.equal(calls[0].source, 'transcript-thinking');
    assert.match(calls[0].why, /row may not have saved/);
  });

  test('the same carry applies to a Codex rollout, and a user message ends it', () => {
    const call = (sec, id) => ({ timestamp: iso(sec), type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: `node cli.mjs dom query ${id}` }), call_id: id } });
    const out = (sec, id) => ({ timestamp: iso(sec), type: 'response_item', payload: { type: 'function_call_output', call_id: id, output: '{}' } });
    const t = jsonl(
      { timestamp: iso(0), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Checking the form.' }] } },
      call(1, 'a'), out(2, 'a'), call(3, 'b'), out(4, 'b'),
      { timestamp: iso(5), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'next task' }] } },
      call(6, 'c'),
    );
    const { calls } = parseTranscript(t);
    assert.deepEqual(calls.map((c) => c.source), ['transcript', 'transcript-carried', null]);
  });

  test('parallel calls in one turn share the narration; a subagent has its own', () => {
    const t = jsonl(
      claudeText(0, 'Reading both stores.'),
      claudeTool(1, 'a', 'Bash', { command: 'node cli.mjs idb dump a' }),
      claudeTool(1, 'b', 'Bash', { command: 'node cli.mjs idb dump b' }),
      claudeText(1, 'Subagent thought.', { isSidechain: true, agentId: 's1' }),
      claudeTool(2, 'c', 'Bash', { command: 'node cli.mjs dom query z' }, { isSidechain: true, agentId: 's1' }),
    );
    const { calls } = parseTranscript(t);
    assert.deepEqual(calls.map((c) => c.why), ['Reading both stores.', 'Reading both stores.', 'Subagent thought.']);
  });

  test('junk lines are counted, not fatal', () => {
    const { stats, calls } = parseTranscript(`not json\n{"broken":\n${jsonl(claudeTool(1, 'a', 'Bash', { command: 'node cli.mjs status' }))}`);
    assert.equal(stats.unparsable, 1);
    assert.equal(calls.length, 1);
  });
});

describe('parseTranscript - Codex rollout', () => {
  test('assistant message + shell call + output', () => {
    const t = jsonl(
      { timestamp: iso(0), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Looking at the skills store.' }] } },
      { timestamp: iso(1), type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', 'node tools/web-scout/cli.mjs idb dump skills'] }), call_id: 'c1' } },
      { timestamp: iso(4), type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: '{}' } },
    );
    const { calls, format } = parseTranscript(t);
    assert.equal(format, 'codex');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].why, 'Looking at the skills store.');
    assert.equal(calls[0].endAt, BASE + 4000);
    assert.match(calls[0].sig, /idbdumpskills/);
  });

  test('a reasoning summary is used when there is no message', () => {
    const t = jsonl(
      { timestamp: iso(0), type: 'response_item', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Need to confirm the write.' }] } },
      { timestamp: iso(1), type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: 'node cli.mjs idb dump s' }), call_id: 'c1' } },
    );
    const { calls } = parseTranscript(t);
    assert.equal(calls[0].source, 'transcript-thinking');
  });

  test('an explicit format overrides detection', () => {
    assert.equal(parseTranscript(jsonl(claudeText(0, 'x')), { format: 'claude' }).format, 'claude');
  });
});

describe('matchCallsToActions', () => {
  const call = (over) => ({ callId: 'c', at: BASE + 1000, endAt: BASE + 4000, sig: 'domclick', why: 'why', source: 'transcript', ...over });

  test('every action started inside a call window gets that call, so one call can own several rows', () => {
    const actions = [row(1, 'idb.snapshot', 1.1), row(2, 'dom.click', 1.5), row(3, 'idb.snapshot', 2), row(4, 'dom.query', 30)];
    const { items, unmatched } = matchCallsToActions([call({})], actions);
    assert.deepEqual(items.map((i) => i.actionId), [1, 2, 3]);
    assert.equal(unmatched, 1);
    assert.equal(items[0].callId, 'c');
  });

  test('overlapping windows are told apart by what the command said', () => {
    const calls = [call({ callId: 'A', sig: 'idbdumpskills', why: 'reading skills' }), call({ callId: 'B', sig: 'domclicksave', why: 'clicking save', at: BASE + 1100 })];
    const { items } = matchCallsToActions(calls, [row(1, 'dom.click', 2), row(2, 'idb.dump', 2)]);
    assert.equal(items.find((i) => i.actionId === 1).callId, 'B');
    assert.equal(items.find((i) => i.actionId === 2).callId, 'A');
  });

  test('timestamp jitter is tolerated; anything wider is a different call', () => {
    const { items } = matchCallsToActions([call({ at: BASE + 10_000, endAt: BASE + 12_000 })], [row(1, 'dom.click', 9.9), row(2, 'dom.click', 9), row(3, 'dom.click', 20)]);
    assert.deepEqual(items.map((i) => i.actionId), [1]);
  });

  test('back-to-back calls do not claim each other\'s actions', () => {
    const calls = [
      call({ callId: 'A', sig: 'domclick', why: 'first', at: BASE, endAt: BASE + 1000 }),
      call({ callId: 'B', sig: 'domclick', why: 'second', at: BASE + 1100, endAt: BASE + 2000 }),
    ];
    const { items } = matchCallsToActions(calls, [row(1, 'dom.click', 0.5), row(2, 'dom.click', 1.5)]);
    assert.deepEqual(items.map((i) => [i.actionId, i.callId]), [[1, 'A'], [2, 'B']]);
  });

  test('a call whose result was never seen still owns a bounded window; unnarrated calls own nothing', () => {
    const open = matchCallsToActions([call({ endAt: null })], [row(1, 'dom.click', 5), row(2, 'dom.click', 500)]);
    assert.deepEqual(open.items.map((i) => i.actionId), [1]);
    const silent = matchCallsToActions([call({ why: '', source: null })], [row(1, 'dom.click', 2)]);
    assert.equal(silent.items.length, 0);
    assert.equal(silent.unmatched, 1);
  });
});

describe('importIntents / discoverTranscripts', () => {
  test('end to end: parse, match, and report what was left over', () => {
    const t = jsonl(claudeText(0, 'Clicking save.'), claudeTool(1, 'a', 'Bash', { command: 'node cli.mjs dom click "#save"' }), claudeResult(3, 'a'));
    const out = importIntents({ actions: [row(1, 'dom.click', 1.5), row(2, 'dom.query', 60)], sources: [{ label: 't.jsonl', text: t }] });
    assert.equal(out.items.length, 1);
    assert.equal(out.unmatchedActions, 1);
    assert.equal(out.transcripts[0].format, 'claude');
    assert.equal(out.transcripts[0].matchedActions, 1);
  });

  test('an action matched by a newer transcript is not re-claimed by an older one', () => {
    const mk = (why) => jsonl(claudeText(0, why), claudeTool(1, 'a', 'Bash', { command: 'node cli.mjs dom click x' }), claudeResult(3, 'a'));
    const out = importIntents({ actions: [row(1, 'dom.click', 1.5)], sources: [{ label: 'new', text: mk('new why') }, { label: 'old', text: mk('old why') }] });
    assert.equal(out.items.length, 1);
    assert.equal(out.items[0].text, 'new why');
    assert.equal(out.transcripts[1].matchedActions, 0);
  });

  test('finds Claude and Codex transcripts newer than the session, newest first, and skips old ones', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-intent-'));
    try {
      const claudeDir = path.join(home, '.claude', 'projects', 'proj-a');
      const codexDir = path.join(home, '.codex', 'sessions', '2026', '09', '19');
      fs.mkdirSync(claudeDir, { recursive: true });
      fs.mkdirSync(codexDir, { recursive: true });
      const fresh = path.join(claudeDir, 'fresh.jsonl');
      const old = path.join(claudeDir, 'old.jsonl');
      const rollout = path.join(codexDir, 'rollout-abc.jsonl');
      for (const f of [fresh, old, rollout]) fs.writeFileSync(f, '{}\n');
      fs.writeFileSync(path.join(claudeDir, 'notes.txt'), 'x');
      const now = Date.now();
      fs.utimesSync(old, new Date(now - 3_600_000), new Date(now - 3_600_000));
      fs.utimesSync(rollout, new Date(now - 1000), new Date(now - 1000));
      const found = discoverTranscripts({ homeDir: home, sinceMs: now - 60_000 });
      assert.deepEqual(found.map((f) => path.basename(f.path)), ['fresh.jsonl', 'rollout-abc.jsonl']);
      assert.deepEqual(new Set(found.map((f) => f.kind)), new Set(['claude', 'codex']));
      assert.deepEqual(discoverTranscripts({ homeDir: path.join(home, 'nowhere') }), []);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('readTranscriptFile only reads .jsonl files', () => {
    assert.throws(() => readTranscriptFile(path.join(os.tmpdir(), 'secrets.txt')), /not a \.jsonl/);
  });
});
