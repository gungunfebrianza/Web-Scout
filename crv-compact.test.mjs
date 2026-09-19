// `session start --strict-crv --crv-compact`: the auto before/after/diff block's own reply (from
// POST /command, not /crv/run - this is the WHOLE-SESSION strict-crv shape) carries a sampled
// preview of what changed alongside the existing counts, instead of only counts - sparing the
// separate "idb diff <idA> <idB>" full-body fetch a caller otherwise makes by hand. Off by default:
// this file's first test proves an ordinary --strict-crv session's reply is BYTE-IDENTICAL in
// shape to before this round (no `samples` key at all).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestRelay, connectFakeAgent } from './test-relay.mjs';

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

before(async () => {
  if (relay.live) return;
  tab = await connectFakeAgent(relay.port, {
    'idb.snapshot': (p) => ({ stores: Object.fromEntries((p.stores ?? Object.keys(db)).map((s) => [s, { keyPath: 'id', rows: structuredClone(db[s]) }])) }),
    'idb.put': (p) => {
      db[p.store] = [...db[p.store].filter((r) => r.id !== p.row.id), p.row];
      return { stored: p.row };
    },
  }, { name: 'crv-compact-tab', epoch: 0 });
});
after(async () => { tab?.close(); await relay.stop(); });

test('without --crv-compact, a strict-crv reply has no samples key at all (unchanged shape)', { skip: skipLive }, async () => {
  await api('POST', '/sessions', { goal: 'crv-compact off', strict_crv: true, strict_crv_stores: ['notes'], agent: 'crv-compact-tab', briefing: false });
  const r = await api('POST', '/command', { type: 'idb.put', params: { store: 'notes', row: { id: 10, body: 'ten' } }, agent: 'crv-compact-tab' });
  assert.equal(r.crv.diff_summary.notes.added, 1);
  assert.ok(!('samples' in r.crv), JSON.stringify(r.crv));
  const active = (await api('GET', '/sessions')).find((s) => s.status === 'active');
  await api('POST', `/sessions/${active.id}/end`);
});

test('with --crv-compact, a strict-crv reply carries a sampled preview alongside the counts', { skip: skipLive }, async () => {
  await api('POST', '/sessions', { goal: 'crv-compact on', strict_crv: true, strict_crv_stores: ['notes'], crv_compact: true, agent: 'crv-compact-tab', briefing: false });
  const r = await api('POST', '/command', { type: 'idb.put', params: { store: 'notes', row: { id: 11, body: 'eleven' } }, agent: 'crv-compact-tab' });
  assert.equal(r.crv.diff_summary.notes.added, 1);
  assert.ok(r.crv.samples, JSON.stringify(r.crv));
  assert.equal(r.crv.samples.notes.added.rows[0].id, 11);
  assert.equal(r.crv.samples.notes.added.rows[0].body, 'eleven');
  const active = (await api('GET', '/sessions')).find((s) => s.status === 'active');
  await api('POST', `/sessions/${active.id}/end`);
});

test('a store the session never touches never shows up in samples', { skip: skipLive }, async () => {
  await api('POST', '/sessions', { goal: 'crv-compact scoped', strict_crv: true, strict_crv_stores: ['notes', 'tags'], crv_compact: true, agent: 'crv-compact-tab', briefing: false });
  const r = await api('POST', '/command', { type: 'idb.put', params: { store: 'notes', row: { id: 12, body: 'twelve' } }, agent: 'crv-compact-tab' });
  assert.deepEqual(Object.keys(r.crv.samples), ['notes'], 'tags never changed, so it is absent - same as diff_summary already is');
  const active = (await api('GET', '/sessions')).find((s) => s.status === 'active');
  await api('POST', `/sessions/${active.id}/end`);
});
