// The replay benchmark: anonymising keeps what a replay needs and nothing else, a session
// exported from a real relay database replays, and the committed traces of real CRV sessions
// hold their measured lean bands. token-benchmark.test.mjs is a scripted best case; these are
// what callers actually read.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { anonymize, standIn, exportTrace, replayTrace, sweepGuard, readTrace, SWEEP_GUARDS } from './trace.mjs';
import { startTestRelay, connectFakeAgent } from './test-relay.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));

// ---------- export from a real relay database ----------
//
// Runs FIRST, before any test() call below, even the two pure ones right after it: a test()
// declared before this top-level await, followed by more test() calls once the await resolves,
// was found to silently run only the pre-await tests under `--test-force-exit` (the exact CI
// invocation, CONTRIBUTING.md) - no failure, no skip, just tests missing from the count (this
// file lost 9 of 11 that way).
const relay = await startTestRelay();
const BASE = `http://127.0.0.1:${relay.port}`;
const skipLive = relay.live ? 'skipped under WEBSCOUT_TEST_LIVE=1' : false;
let tab;
let sessionId;
const rows = Array.from({ length: 60 }, (_, i) => ({ id: i + 1, owner: `person-${i}`, note: 'n'.repeat(80) }));

async function api(method, route, body) {
  const res = await fetch(`${BASE}${route}`, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  return (await res.json()).result;
}
const read = (type, params) => api('POST', '/command', { type, params, agent: 'trace-tab' });

before(async () => {
  if (relay.live) return;
  tab = await connectFakeAgent(relay.port, {
    'idb.dump': (p) => ({ store: p.store, keyPath: 'id', count: rows.length, rows }),
    'idb.put': () => ({ stored: true }),
    eval: () => ({ value: 'x'.repeat(300) }),
  }, { name: 'trace-tab', epoch: 0 });
  sessionId = (await api('POST', '/sessions', { goal: 'trace-replay.test.mjs', context: 'automated', briefing: false, agent: 'trace-tab' })).id;
});
after(async () => { tab?.close(); await relay.stop(); });

test('a stand-in has the same length, is stable, and differs for different strings', () => {
  for (const s of ['a', 'ab', 'open', 'some longer piece of text that is data', 'x'.repeat(500)]) {
    assert.equal(standIn(s).length, s.length);
    assert.equal(standIn(s), standIn(s));
  }
  assert.notEqual(standIn('customer-1'), standIn('customer-2'));
  assert.notEqual(standIn('a real note'), 'a real note');
  assert.equal(standIn(''), '');
});

test('anonymising keeps structure, numbers and nulls, hides strings, and keeps only what it is told to', () => {
  const src = { store: 'orders', keyPath: 'id', rows: [{ id: 1, owner: 'Ann Example', paid: true, note: null, tags: ['vip', 'vip', 'new'] }], count: 1 };
  const out = anonymize(src);
  assert.equal(JSON.stringify(out).length, JSON.stringify(src).length, 'byte size is preserved');
  assert.equal(out.keyPath, 'id', 'a keyPath value names a field and is schema');
  assert.notEqual(out.store, 'orders');
  assert.notEqual(out.rows[0].owner, 'Ann Example');
  assert.equal(out.rows[0].id, 1);
  assert.equal(out.rows[0].paid, true);
  assert.equal(out.rows[0].note, null);
  assert.equal(out.rows[0].tags[0], out.rows[0].tags[1], 'equal values stay equal');
  assert.notEqual(out.rows[0].tags[0], out.rows[0].tags[2], 'different values stay different');
  assert.ok(!JSON.stringify(out).includes('Ann'));
  assert.equal(anonymize(src, { keep: ['store', 'keyPath'] }).store, 'orders');
});

test('a session exported from a relay database keeps reads shapeable and everything else as a size', { skip: skipLive }, async () => {
  await read('idb.dump', { store: 'secret_orders' });
  await read('eval', { expr: '1+1' });
  await read('idb.put', { store: 'secret_orders', row: { id: 99, owner: 'Zed Private' } });
  tab.state.epoch += 1;
  await read('idb.dump', { store: 'secret_orders' });
  const trace = await exportTrace({ dbPath: relay.env.WEBSCOUT_DB_PATH, sessionId });
  assert.equal(trace.source.anonymised, true);
  const reads = trace.events.filter((e) => e.result);
  assert.equal(reads.length, 2);
  assert.deepEqual(trace.events.map((e) => e.type), ['idb.dump', 'eval', 'idb.put', 'idb.dump']);
  assert.ok(trace.events[1].bytes > 100 && trace.events[1].result === undefined, 'a non-read carries only its size');
  const text = JSON.stringify(trace);
  assert.ok(!text.includes('secret_orders') && !text.includes('person-') && !text.includes('Zed Private'), 'no content survives');
  assert.equal(reads[0].result.keyPath, 'id');
  assert.equal(reads[0].result.store, reads[1].result.store, 'the same store is still recognisably the same store');
});

// ---------- replay ----------

const dump = (n, pad, tag = 'a') => ({ store: `s${tag}`, keyPath: 'id', count: n, rows: Array.from({ length: n }, (_, i) => ({ id: i + 1, status: i % 2 ? 'open' : 'done', owner: `user-${i}`, note: 'n'.repeat(pad) })) });
const ev = (type, params, result) => ({ t: 0, type, ok: true, params, ...(result ? { result } : { bytes: 40 }) });

test('replay: the lean band is ordered, and huge reads seen once are mostly saved', () => {
  const trace = { version: 1, events: [ev('idb.dump', { store: 'a' }, dump(300, 60, 'a')), ev('idb.dump', { store: 'b' }, dump(20, 5, 'b')), ev('eval', {}), ev('idb.dump', { store: 'c' }, dump(400, 60, 'c'))] };
  const r = replayTrace(trace);
  assert.equal(r.reads, 3);
  assert.ok(r.readRatio.leanBest < 0.2, `three reads, two of them huge: ${r.readRatio.leanBest}`);
  assert.ok(r.readRatio.leanBest <= r.readRatio.leanWorst, 'a caller who re-asks for the body cannot cost less than one who does not');
  assert.equal(r.strategies.leanWorst.followUps, 2);
  assert.equal(r.strategies.default.fixedBytes, 40, 'a non-read costs the same in every strategy');
});

test('replay: a re-read after the page changed is a delta in a lean session', () => {
  const v1 = dump(60, 20);
  const v2 = { ...v1, rows: v1.rows.map((r) => (r.id === 3 ? { ...r, status: 'shipped' } : r)) };
  const trace = { version: 1, events: [ev('idb.dump', { store: 'a' }, v1), ev('idb.put', {}), ev('idb.dump', { store: 'a' }, v2)] };
  const r = replayTrace(trace);
  assert.equal(r.strategies.leanBest.modes.delta, 1);
  assert.ok(r.strategies.leanBest.readBytes < r.strategies.default.readBytes * 0.7);
});

test('the guard sweep reports every threshold, and a higher guard peeks no more often', () => {
  const trace = { version: 1, events: [1, 2, 3, 4].map((n) => ev('idb.dump', { store: `s${n}` }, dump(40 * n, 60, String(n)))) };
  const sweep = sweepGuard(trace);
  assert.deepEqual(sweep.map((r) => r.leanGuardTokens), SWEEP_GUARDS);
  const peeks = SWEEP_GUARDS.map((g) => replayTrace(trace, { leanGuardTokens: g }).strategies.leanBest.modes.guard ?? 0);
  assert.deepEqual(peeks, [...peeks].sort((a, b) => b - a), 'monotone: raising the threshold cannot add peeks');
});

// ---------- the committed traces of real sessions ----------

// Measured with `node tools/web-scout/trace.mjs replay traces/*.json.gz` at the default guard
// (V33, revised: leanWorst now also re-asks a distrusted pointer/delta, not only a peek/guard -
// see [[web-scout-v33-round]]/[[web-scout-v34-round]] - the old worst-case numbers here were an
// undercount, since pointer/delta follow-ups were not simulated at all). Read-bytes ratios of a
// lean session against the default, best and worst case; each ceiling is the measurement plus a
// margin, so a change that makes lean replies bigger fails. These four traces are one project's
// CRV sessions - a small sample, not a promise.
const MEASURED = {
  'crv-dump-heavy': { best: 0.543, worst: 1.027 },
  'crv-mutation-verify': { best: 0.395, worst: 1.075 },
  'crv-monitoring': { best: 0.584, worst: 1.033 },
  'crv-ai-capture': { best: 0.049, worst: 1.012 },
};
const MARGIN = 0.03;

for (const [name, expected] of Object.entries(MEASURED)) {
  test(`real trace ${name}: lean holds its measured band`, () => {
    const file = path.join(dir, 'traces', `${name}.json.gz`);
    assert.ok(fs.existsSync(file), `${file} is committed`);
    const r = replayTrace(readTrace(file));
    assert.ok(r.reads >= 10, 'a real session, not a stub');
    assert.ok(r.readRatio.leanBest <= expected.best + MARGIN, `lean best case ${r.readRatio.leanBest} > ${expected.best} + ${MARGIN}`);
    assert.ok(r.readRatio.leanWorst <= expected.worst + MARGIN, `lean worst case ${r.readRatio.leanWorst} > ${expected.worst} + ${MARGIN}`);
    // Distrusting every shaped reply now costs slightly MORE than never shaping at all (the shape
    // itself is a paid round trip before the retry) - a small, bounded premium, not the free
    // worst case the old, undercounted simulation reported. See the MEASURED comment above.
    assert.ok(r.readRatio.leanWorst < 1.15, `a fully-distrusted lean session should not cost much more than the default: ${r.readRatio.leanWorst}`);
  });
}

test('every committed trace is anonymised and listed above', () => {
  const files = fs.readdirSync(path.join(dir, 'traces')).filter((f) => f.endsWith('.json.gz')).map((f) => f.replace('.json.gz', ''));
  assert.deepEqual(files.sort(), Object.keys(MEASURED).sort(), 'add a MEASURED entry for a new trace');
  for (const f of files) assert.equal(readTrace(path.join(dir, 'traces', `${f}.json.gz`)).source.anonymised, true);
});
