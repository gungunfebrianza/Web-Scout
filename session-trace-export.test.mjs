// "session end --trace" grows the trace.mjs replay corpus without a separate offline step:
// POST /sessions/:id/trace anonymises the session (the same way trace.mjs's own "export" CLI
// command does) and writes it under WEBSCOUT_TRACE_DIR (traces/auto/ by default - gitignored,
// never auto-promoted into the committed, benchmarked traces/*.json.gz).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestRelay, connectFakeAgent, spawnClean } from './test-relay.mjs';
import { readTrace, writeTrace } from './trace.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const relay = await startTestRelay();
const BASE = `http://127.0.0.1:${relay.port}`;
const skip = relay.live ? 'skipped under WEBSCOUT_TEST_LIVE=1' : false;
// The relay was spawned with this pointing at its own throwaway temp dir (test-relay.mjs), so
// "session end --trace" writes there, never into the real project's traces/auto/.
const traceDir = relay.env.WEBSCOUT_TRACE_DIR;
let tab;

async function api(method, route, body) {
  const res = await fetch(`${BASE}${route}`, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json() };
}

before(async () => {
  if (relay.live) return;
  tab = await connectFakeAgent(relay.port, { 'idb.dump': (p) => ({ store: p.store, rows: [{ id: 1, owner: 'Ann', note: 'n'.repeat(200) }] }) }, { name: 'trace-export-tab', epoch: 0 });
});
after(async () => { tab?.close(); await relay.stop(); });

test('POST /sessions/:id/trace writes an anonymised trace file and reports its counts', { skip }, async () => {
  const session = (await api('POST', '/sessions', { goal: 'trace-export.test.mjs', context: 'automated', briefing: false, agent: 'trace-export-tab' })).json.result;
  await api('POST', '/command', { type: 'idb.dump', params: { store: 'exported' }, agent: 'trace-export-tab' });
  await api('POST', `/sessions/${session.id}/end`);

  const r = await api('POST', `/sessions/${session.id}/trace`);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const { file, events, reads } = r.json.result;
  assert.ok(events >= 1);
  assert.equal(reads, 1);
  assert.ok(fs.existsSync(file), `${file} was written`);
  const trace = readTrace(file);
  assert.equal(trace.source.anonymised, true);
  assert.equal(trace.source.sessionId, session.id);
  const text = JSON.stringify(trace);
  assert.ok(!text.includes('"owner":"Ann"') && !text.includes('"store":"exported"'), 'no real content survives export (only the field name "exportedAt" legitimately contains "export")');
});

test('an unknown session id 404s instead of writing a stray file', { skip }, async () => {
  const before = fs.existsSync(traceDir) ? fs.readdirSync(traceDir).length : 0;
  const r = await api('POST', '/sessions/999999/trace');
  assert.equal(r.status, 404);
  const after = fs.existsSync(traceDir) ? fs.readdirSync(traceDir).length : 0;
  assert.equal(after, before);
});

const countFiles = () => (fs.existsSync(traceDir) ? fs.readdirSync(traceDir).length : 0);

test('CLI: "session end --trace" ends the session, exports it, and says where', { skip }, async () => {
  // Only WEBSCOUT_PORT matters to the CLI itself - the relay (already running, spawned with
  // WEBSCOUT_TRACE_DIR by test-relay.mjs) is what actually decides where the file lands.
  const start = spawnClean([path.join(dir, 'cli.mjs'), 'session', 'start', 'session-trace-export.test.mjs CLI', 'automated', '--no-briefing'], { env: relay.env, cwd: dir });
  assert.equal(start.status, 0, start.stderr);
  await api('POST', '/command', { type: 'idb.dump', params: { store: 'cli-exported' }, agent: 'trace-export-tab' });
  const before = countFiles();
  const end = spawnClean([path.join(dir, 'cli.mjs'), 'session', 'end', '--trace'], { env: relay.env, cwd: dir });
  assert.equal(end.status, 0, end.stderr);
  assert.match(end.stderr, /exported to .*\.json\.gz/);
  assert.match(end.stderr, /grows the trace\.mjs corpus/);
  assert.equal(countFiles(), before + 1, 'exactly one new trace file');
  // Nothing else is in traceDir yet worth ranking above (or well below) it - it should land near
  // the top of a 1-2 file corpus and get the "consider promoting" nudge.
  assert.match(end.stderr, /this trace ranks #\d+ of \d+ in traces\/auto\/ by distrust rate/);
  assert.match(end.stderr, /"trace\.mjs rank-auto" for the full list/);
});

test('the rank-auto nudge stays quiet when the new trace is not actually near the top', { skip }, async () => {
  // Seed several "loud" traces (big reads, each re-asked in full under the leanWorst strategy -
  // same fixture shape as trace-replay.test.mjs's own high-distrust case) so a trivial one-read
  // export from this test cannot possibly rank in the top 3.
  const dump = (n, pad, tag) => ({ store: `s${tag}`, keyPath: 'id', count: n, rows: Array.from({ length: n }, (_, i) => ({ id: i + 1, note: 'n'.repeat(pad) })) });
  const ev = (type, params, result) => ({ t: 0, type, ok: true, params, ...(result ? { result } : { bytes: 40 }) });
  fs.mkdirSync(traceDir, { recursive: true });
  for (let i = 0; i < 4; i += 1) {
    writeTrace(path.join(traceDir, `loud-${i}.json`), {
      version: 1,
      events: [ev('idb.dump', { store: 'a' }, dump(300, 60, `${i}a`)), ev('idb.dump', { store: 'b' }, dump(400, 60, `${i}b`))],
    });
  }
  const start = spawnClean([path.join(dir, 'cli.mjs'), 'session', 'start', 'session-trace-export.test.mjs quiet-nudge', 'automated', '--no-briefing'], { env: relay.env, cwd: dir });
  assert.equal(start.status, 0, start.stderr);
  const end = spawnClean([path.join(dir, 'cli.mjs'), 'session', 'end', '--trace'], { env: relay.env, cwd: dir });
  assert.equal(end.status, 0, end.stderr);
  assert.match(end.stderr, /exported to .*\.json\.gz/);
  assert.doesNotMatch(end.stderr, /this trace ranks/, `a near-empty session should not outrank 4 loud traces: ${end.stderr}`);
});

test('CLI: "session end" without --trace writes nothing', { skip }, async () => {
  const start = spawnClean([path.join(dir, 'cli.mjs'), 'session', 'start', 'session-trace-export.test.mjs no-flag', 'automated', '--no-briefing'], { env: relay.env, cwd: dir });
  assert.equal(start.status, 0, start.stderr);
  const before = countFiles();
  const end = spawnClean([path.join(dir, 'cli.mjs'), 'session', 'end'], { env: relay.env, cwd: dir });
  assert.equal(end.status, 0, end.stderr);
  assert.doesNotMatch(end.stderr, /exported to/);
  assert.equal(countFiles(), before);
});
