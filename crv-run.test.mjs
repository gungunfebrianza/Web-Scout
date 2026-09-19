// "crv run": baseline -> action -> verify in ONE call (relay.mjs's POST /crv/run, sharing
// verifyAgainstBaseline with /state/verify - crv-verify.test.mjs covers the expectation syntax
// itself). What this covers: the action actually runs between the two snapshots, a failing action
// fails the whole call, idb.snapshot is refused as the action, and the CLI wiring.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestRelay, connectFakeAgent, spawnAsync } from './test-relay.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const relay = await startTestRelay();
const BASE = `http://127.0.0.1:${relay.port}`;
const skipLive = relay.live ? 'skipped under WEBSCOUT_TEST_LIVE=1' : false;
let tab;
const db = { notes: [{ id: 1, body: 'one' }], tags: [{ id: 1, label: 'a' }] };

async function api(method, route, body) {
  const res = await fetch(`${BASE}${route}`, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json();
  return json.ok ? json.result : Object.assign(new Error(json.error), { status: res.status });
}
const run = (body) => api('POST', '/crv/run', { agent: 'crv-run-tab', ...body });

before(async () => {
  if (relay.live) return;
  tab = await connectFakeAgent(relay.port, {
    'idb.snapshot': (p) => ({ stores: Object.fromEntries((p.stores ?? Object.keys(db)).map((s) => [s, { keyPath: 'id', rows: structuredClone(db[s]) }])) }),
    'idb.put': (p) => {
      if (p.row?.id === 'fail') throw new Error('unique index conflict on id');
      db[p.store] = [...db[p.store].filter((r) => r.id !== p.row.id), p.row];
      return { stored: p.row };
    },
  }, { name: 'crv-run-tab', epoch: 0 });
  await api('POST', '/sessions', { goal: 'crv-run.test.mjs', context: 'automated', agent: 'crv-run-tab', briefing: false });
});
after(async () => { tab?.close(); await relay.stop(); });

test('pass: the action runs, the fresh snapshot sees what it wrote, and expect holds', { skip: skipLive }, async () => {
  const before = tab.seen.filter((m) => m.type === 'idb.snapshot').length;
  const r = await run({ stores: ['notes'], type: 'idb.put', params: { store: 'notes', row: { id: 2, body: 'two' } }, expect: 'notes:+1' });
  assert.equal(r.action.type, 'idb.put');
  assert.equal(r.action.ok, true);
  assert.deepEqual(r.action.result, { stored: { id: 2, body: 'two' } });
  assert.equal(r.passed, true, JSON.stringify(r));
  assert.deepEqual(r.changedStores, { notes: '+1-0~0' });
  // exactly two snapshots (before/after), not the whole-session strict-crv shape
  assert.equal(tab.seen.filter((m) => m.type === 'idb.snapshot').length - before, 2);
});

test('the action ran but the expectation was wrong: fails, with rows for the mismatch', { skip: skipLive }, async () => {
  const r = await run({ stores: ['notes'], type: 'idb.put', params: { store: 'notes', row: { id: 3, body: 'three' } }, expect: 'notes:+2' });
  assert.equal(r.action.ok, true, 'the write itself succeeded');
  assert.equal(r.passed, false);
  assert.equal(r.failed[0].problem, 'added 1, expected 2');
});

test('the action itself failing fails the whole call - no verify report, nothing to explain', { skip: skipLive }, async () => {
  const err = await run({ stores: ['notes'], type: 'idb.put', params: { store: 'notes', row: { id: 'fail' } }, expect: 'notes:+1' });
  assert.ok(err instanceof Error);
  assert.match(err.message, /unique index conflict/);
  assert.equal(err.passed, undefined, 'not a verify report at all');
});

test('idb.snapshot is refused as the action - take the baseline with "idb snapshot" instead', { skip: skipLive }, async () => {
  const err = await run({ stores: ['notes'], type: 'idb.snapshot', params: {} });
  assert.equal(err.status, 400);
  assert.match(err.message, /use "idb snapshot"/);
});

test('stores and type are both required, before anything is dispatched', { skip: skipLive }, async () => {
  const noStores = await run({ type: 'idb.put', params: { store: 'notes', row: { id: 4 } } });
  assert.equal(noStores.status, 400);
  assert.match(noStores.message, /stores/);
  const noType = await run({ stores: ['notes'] });
  assert.equal(noType.status, 400);
  assert.match(noType.message, /type is required/);
});

test('CLI: "crv run --stores --type --params --expect" end to end', { skip: skipLive }, async () => {
  // spawnAsync, not spawnClean: this command dispatches to the page, and the fake agent
  // answering it lives in THIS process - see spawnAsync's own comment in test-relay.mjs.
  const r = await spawnAsync([
    path.join(dir, 'cli.mjs'), 'crv', 'run',
    '--stores', 'notes', '--type', 'idb.put', '--params', JSON.stringify({ store: 'notes', row: { id: 5, body: 'five' } }),
    '--expect', 'notes:+1', '--agent', 'crv-run-tab',
  ], { env: relay.env, cwd: dir });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.action.type, 'idb.put');
  assert.equal(out.passed, true, r.stdout);
});
