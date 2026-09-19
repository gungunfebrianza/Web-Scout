// schema-budget.test.mjs caps what is paid before anything happens (the MCP tool list, help
// slices) - both static text. This caps actual RUNTIME replies for a handful of representative,
// deterministic scenarios, so an innocent-looking field added to a reply (a new briefing key, an
// extra sample row in a verify report, an unbounded table) fails the build instead of being
// noticed later as "why did this session cost more than it used to".
//
// Each budget is measured against a FIXED fixture, not real usage, so the number is reproducible.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildVerifyReport } from './crv-verify.mjs';
import { startTestRelay, connectFakeAgent } from './test-relay.mjs';

// idb verify, PASS: one expectation, nothing unexpected changed, not verbose - the everyday
// "it worked" reply idb verify.mjs's own doc calls "a few lines". Measured 122 bytes.
const VERIFY_PASS_MAX_BYTES = 250;
// session start's briefing, worst case within its own BRIEFING_MAX_STORES=60 cap (60 shown +
// storesOmitted + a long store-name fixture, so this is close to the largest a briefing gets).
// Measured 2931 bytes.
const BRIEFING_MAX_BYTES = 3500;
// idb dump shaped --table: keys stated once, one row per array entry. Measured 2299 bytes for 40 rows.
const TABLE_DUMP_MAX_BYTES = 2800;
// --crv-compact's samples block, near its own worst case: 3 stores, each hitting sampleStoreDiff's
// 3-rows-per-bucket cap on all 3 buckets (added/removed/changed) at once. Measured 3697 bytes for
// the whole crv reply (samples alone: 3477).
const CRV_COMPACT_MAX_BYTES = 4400;

// Every test() call below must be declared AFTER this top-level await, not before it: a test
// declared before an async gap, followed by more tests declared once the gap resolves, was found
// to silently run only the first (pre-gap) test under `--test-force-exit` - the exact CI
// invocation (CONTRIBUTING.md) - with no failure or skip reported, just tests missing from the
// count. Moving the await here so ALL tests register in one synchronous burst after it fixes that.
const relay = await startTestRelay();
const BASE = `http://127.0.0.1:${relay.port}`;
const skip = relay.live ? 'skipped under WEBSCOUT_TEST_LIVE=1' : false;
let tab;

async function api(method, route, body) {
  const res = await fetch(`${BASE}${route}`, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  return (await res.json()).result;
}

// 80 stores (60 shown, 20 omitted) with long-ish real-looking names - near the worst case a
// briefing gets before storesOmitted starts absorbing the rest.
const STORE_COUNTS = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`cfi_controlled_decision_admissions_${i}`, 1000 - i]));

// 3 stores, each with 5 rows added + 5 removed + 5 changed between the before/after snapshot -
// well past sampleStoreDiff's 3-rows-per-bucket cap on every bucket at once, the worst case
// --crv-compact actually ships (a store touched by only one bucket, or fewer than 3 rows, is
// smaller than this).
const CRV_STORES = ['notes', 'tags', 'accounts'];
function crvRows(store, n, prefix) {
  return Array.from({ length: n }, (_, i) => ({ id: `${prefix}-${i}`, body: `${store}-${prefix}-${i}-${'x'.repeat(40)}`, owner: `user-${i}`, tag: `t${i}` }));
}
const CRV_BEFORE = {};
const CRV_AFTER = {};
for (const s of CRV_STORES) {
  const stay = crvRows(s, 1, 'stay');
  const removed = crvRows(s, 5, 'gone');
  const changedBefore = crvRows(s, 5, 'chg');
  CRV_BEFORE[s] = [...stay, ...removed, ...changedBefore];
  const added = crvRows(s, 5, 'new');
  const changedAfter = changedBefore.map((r) => ({ ...r, body: `${r.body}-EDITED` }));
  CRV_AFTER[s] = [...stay, ...added, ...changedAfter];
}
let crvSnapshotCall = 0;

before(async () => {
  if (relay.live) return;
  tab = await connectFakeAgent(relay.port, {
    'idb.list': () => ({ stores: Object.keys(STORE_COUNTS), counts: STORE_COUNTS }),
    'db.version': () => ({ name: 'AgentCapitalOS', version: 112 }),
    'idb.dump': () => ({ store: 'orders', keyPath: 'id', count: 40, rows: Array.from({ length: 40 }, (_, i) => ({ id: i + 1, status: i % 2 ? 'open' : 'done', owner: `user-${i}`, note: 'n'.repeat(30) })) }),
    'idb.snapshot': (p) => {
      crvSnapshotCall += 1;
      const src = crvSnapshotCall === 1 ? CRV_BEFORE : CRV_AFTER;
      return { stores: Object.fromEntries((p.stores ?? CRV_STORES).map((s) => [s, { keyPath: 'id', rows: structuredClone(src[s]) }])) };
    },
    'idb.put': (p) => ({ stored: p.row }),
  }, { name: 'budget-tab', epoch: 0 });
});
after(async () => { tab?.close(); await relay.stop(); });

test('idb verify PASS reply (one expectation, no surprises) stays a few lines', () => {
  const report = buildVerifyReport({
    baselineId: 101, afterId: 102, diffId: 103,
    summary: { notes: { added: 1, removed: 0, changed: 0 } },
    diff: { notes: { added: [{ id: 42, key: 42, title: 'a new note', tag: 'x' }], removed: [], changed: [] } },
    expectations: [{ store: 'notes', added: 1 }],
  });
  assert.equal(report.passed, true);
  const bytes = JSON.stringify(report).length;
  assert.ok(bytes <= VERIFY_PASS_MAX_BYTES, `PASS verify report is ${bytes} bytes, cap ${VERIFY_PASS_MAX_BYTES}: ${JSON.stringify(report)}`);
});

test('session start briefing stays bounded near its own worst case (60 shown stores)', { skip }, async () => {
  const session = await api('POST', '/sessions', { goal: 'reply-budget.test.mjs briefing', context: 'automated', agent: 'budget-tab' });
  assert.equal(session.briefing.available, true, JSON.stringify(session.briefing));
  assert.equal(Object.keys(session.briefing.stores).length, 60, 'BRIEFING_MAX_STORES');
  assert.equal(session.briefing.storesOmitted, 20);
  const bytes = JSON.stringify(session.briefing).length;
  assert.ok(bytes <= BRIEFING_MAX_BYTES, `briefing is ${bytes} bytes, cap ${BRIEFING_MAX_BYTES}`);
  await api('POST', `/sessions/${session.id}/end`);
});

test('a --table idb dump reply stays bounded for a representative row count', { skip }, async () => {
  const session = await api('POST', '/sessions', { goal: 'reply-budget.test.mjs table', context: 'automated', briefing: false, agent: 'budget-tab' });
  const out = await api('POST', '/command', { type: 'idb.dump', params: { store: 'orders' }, agent: 'budget-tab', opts: { table: true } });
  assert.deepEqual(out.rows.columns, ['id', 'status', 'owner', 'note']);
  const bytes = JSON.stringify(out).length;
  assert.ok(bytes <= TABLE_DUMP_MAX_BYTES, `table reply is ${bytes} bytes, cap ${TABLE_DUMP_MAX_BYTES}`);
  await api('POST', `/sessions/${session.id}/end`);
});

test('a --crv-compact reply near its own worst case (3 buckets x 3 stores, cap hit everywhere) stays bounded', { skip }, async () => {
  await api('POST', '/sessions', { goal: 'reply-budget.test.mjs crv-compact', strict_crv: true, strict_crv_stores: CRV_STORES, crv_compact: true, agent: 'budget-tab', briefing: false });
  const out = await api('POST', '/command', { type: 'idb.put', params: { store: 'notes', row: { id: 'x', body: 'y' } }, agent: 'budget-tab' });
  assert.equal(Object.keys(out.crv.samples).length, 3);
  const bytes = JSON.stringify(out.crv).length;
  assert.ok(bytes <= CRV_COMPACT_MAX_BYTES, `crv-compact reply is ${bytes} bytes, cap ${CRV_COMPACT_MAX_BYTES}`);
  const active = (await api('GET', '/sessions')).find((s) => s.status === 'active');
  await api('POST', `/sessions/${active.id}/end`);
});
