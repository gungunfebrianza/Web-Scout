// The reply pipeline as a state machine: what a caller receives for the same read
// under each option, what it is said to hold afterwards, what each mode books in
// the ledger, and which behaviours turn into hints. No relay, no page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReadPipeline, budgetLevel, normalizeShapeOpts, isNarrowed, readTargetKey } from './read-pipeline.mjs';

const rows = (n, pad = 0) => Array.from({ length: n }, (_, i) => ({ id: i + 1, status: i % 2 ? 'open' : 'done', owner: `user-${i}`, note: 'n'.repeat(pad) }));
const dump = (n, pad) => ({ store: 'orders', keyPath: 'id', count: n, rows: rows(n, pad) });

function harness() {
  const booked = [];
  let clock = 1000;
  const pipeline = createReadPipeline({ bump: (key, bytes) => booked.push([key, bytes]), now: () => clock });
  const call = (over = {}) => {
    const full = over.full ?? dump(20);
    return pipeline.shape({ sessionId: 1, type: 'idb.dump', agentName: 'default', params: { store: 'orders' }, cacheKey: 'default::idb.dump::{"store":"orders"}', hit: false, actionId: 10, opts: {}, budget: null, ...over, full });
  };
  return { pipeline, booked, call, tick: (ms) => { clock += ms; }, keys: () => booked.map(([k]) => k) };
}

test('with no options the caller gets the full result and nothing is booked', () => {
  const h = harness();
  const r = h.call();
  assert.equal(r.mode, 'full');
  assert.equal(r.out, dump(20) && r.out);
  assert.equal(r.spared, 0);
  assert.deepEqual(h.booked, []);
});

test('--if-changed on an unchanged cache hit is a pointer, but only after a full delivery', () => {
  const h = harness();
  const full = dump(30);
  const entry = { cachedAt: 't0', actionId: 10 };
  const first = h.call({ full, actionId: 10, opts: { ifChanged: true } });
  assert.equal(first.mode, 'full', 'the caller holds nothing yet, so the first read is the body');
  const again = h.call({ full, hit: true, entry, opts: { ifChanged: true } });
  assert.equal(again.mode, 'pointer');
  assert.equal(again.out.unchanged, true);
  assert.equal(again.out.sameAs, 10);
  assert.ok(again.outBytes < 300 && again.spared > 1000);
  assert.deepEqual(h.booked.map(([k]) => k), ['unchangedPointer']);
});

test('a pointer is never offered for a result the caller was only shown a peek of', () => {
  const h = harness();
  const full = dump(80, 40);
  assert.equal(h.call({ full, opts: { peek: true } }).mode, 'peek');
  const hit = h.call({ full, hit: true, entry: { cachedAt: 't', actionId: 10 }, opts: { ifChanged: true } });
  assert.equal(hit.mode, 'full', 'they never received this body, so "unchanged" would be a lie');
});

test('a pointer needs the caller to hold THIS result, not just an older one of the same call', () => {
  const h = harness();
  const v1 = dump(60, 30);
  const v2 = { ...v1, rows: v1.rows.map((r) => (r.id === 3 ? { ...r, status: 'shipped' } : r)) };
  h.call({ full: v1, actionId: 10 });
  assert.equal(h.call({ full: v2, actionId: 11, opts: { peek: true } }).mode, 'peek', 'the page moved, and this time only the shape was handed over');
  const hit = h.call({ full: v2, hit: true, entry: { cachedAt: 't', actionId: 11 }, opts: { ifChanged: true } });
  assert.equal(hit.mode, 'full', 'the caller holds v1, so "unchanged since what you hold" would be false');
});

test('--delta after the page changed returns only what changed, and chains', () => {
  const h = harness();
  const v1 = dump(60);
  h.call({ full: v1, actionId: 10 });
  const v2 = { ...v1, rows: v1.rows.map((r) => (r.id === 7 ? { ...r, status: 'shipped' } : r)) };
  const d = h.call({ full: v2, actionId: 11, opts: { delta: true } });
  assert.equal(d.mode, 'delta');
  assert.equal(d.out.sameAs, 10);
  assert.deepEqual(d.out.arrays.rows.changed.map((r) => r.id), [7]);
  const v3 = { ...v2, rows: v2.rows.map((r) => (r.id === 9 ? { ...r, owner: 'zed' } : r)) };
  const d2 = h.call({ full: v3, actionId: 12, opts: { delta: true } });
  assert.equal(d2.mode, 'delta');
  assert.equal(d2.out.sameAs, 11, 'the second delta is against the result the first one rebuilt');
  assert.deepEqual(h.keys(), ['deltaRead', 'deltaRead']);
});

test('--delta falls back to the full body when the change is large', () => {
  const h = harness();
  h.call({ full: dump(6), actionId: 10 });
  const r = h.call({ full: { ...dump(6), rows: rows(6).map((x) => ({ ...x, status: 'z', owner: 'q' })) }, actionId: 11, opts: { delta: true } });
  assert.equal(r.mode, 'full');
});

test('--peek returns the shape, books the saving, and declines when the result is already tiny', () => {
  const h = harness();
  const r = h.call({ full: dump(120, 50), opts: { peek: true } });
  assert.equal(r.mode, 'peek');
  assert.equal(r.out.arrays.rows.count, 120);
  assert.equal(h.keys()[0], 'peek');
  assert.ok(Array.isArray(r.out.estTokensBand) && r.out.estTokensBand[0] <= r.out.estTokens && r.out.estTokens <= r.out.estTokensBand[1] * 2);
  const tiny = h.call({ full: { count: 1, rows: [{ id: 1 }] }, opts: { peek: true } });
  assert.equal(tiny.mode, 'full');
});

test('a peek followed by a narrowed read is the peek working; followed by the full read it is spent', () => {
  const h = harness();
  const full = dump(120, 50);
  h.call({ full, opts: { peek: true } });
  const narrowed = h.call({ full: dump(3), params: { store: 'orders', limit: 3 }, cacheKey: 'k2', actionId: 11 });
  assert.equal(narrowed.mode, 'full');
  assert.ok(h.keys().includes('peekThenNarrowed'));
  const h2 = harness();
  h2.call({ full, opts: { peek: true } });
  const wholeBody = h2.call({ full, hit: true, entry: { cachedAt: 't' } });
  assert.equal(wholeBody.mode, 'full');
  assert.ok(h2.keys().includes('peekThenFull'));
  assert.ok(h2.booked.find(([k]) => k === 'peekThenFull')[1] > 1000, 'the bytes spent afterwards are recorded, so net saving can be computed');
});

test('a peek follow-up is forgotten after the window', () => {
  const h = harness();
  const full = dump(120, 50);
  h.call({ full, opts: { peek: true } });
  h.tick(91000);
  h.call({ full, hit: true, entry: { cachedAt: 't' } });
  assert.ok(!h.keys().includes('peekThenFull'));
});

test('--table lists rows as columns + rows, and only when it is smaller', () => {
  const h = harness();
  const r = h.call({ full: dump(25), opts: { table: true } });
  assert.equal(r.mode, 'table');
  assert.deepEqual(r.out.rows.columns, ['id', 'status', 'owner', 'note']);
  assert.equal(h.keys()[0], 'tabular');
  const noRows = h.call({ full: { found: true, outerHTML: '<x/>' }, params: { selector: 'a' }, type: 'dom.query', cacheKey: 'k3', opts: { table: true } });
  assert.equal(noRows.mode, 'full');
});

test('the budget guard turns a large read into a peek, --no-guard overrides it, small reads pass', () => {
  const h = harness();
  const budget = budgetLevel(10000, 7000);
  assert.equal(budget.level, 'tighten');
  assert.equal(budget.guardTokens, 3000);
  const big = dump(400, 60);
  const guarded = h.call({ full: big, budget });
  assert.equal(guarded.mode, 'guard');
  assert.equal(guarded.out.guarded, true);
  assert.equal(h.keys()[0], 'guardedPeek');
  assert.equal(h.call({ full: big, budget, opts: { noGuard: true }, cacheKey: 'k4' }).mode, 'table', 'forced through, but rows are still tabular in tighten mode');
  const small = h.call({ full: dump(3), budget, cacheKey: 'k5' });
  assert.notEqual(small.mode, 'guard');
});

test('an env guard applies without any budget, and the smaller of the two wins', () => {
  const h = harness();
  assert.equal(h.call({ full: dump(400, 60), envGuardTokens: 2000 }).mode, 'guard');
  const strict = budgetLevel(10000, 9000);
  assert.equal(strict.guardTokens, 1000);
  const both = h.call({ full: dump(400, 60), budget: strict, envGuardTokens: 8000, cacheKey: 'k6' });
  assert.equal(both.out.next.match(/~(\d+)-token guard/)[1], '1000');
});

test('budget levels and the one-time announcement', () => {
  assert.equal(budgetLevel(undefined, 100), null);
  assert.equal(budgetLevel(1000, 599).level, 'ok');
  assert.equal(budgetLevel(1000, 600).level, 'tighten');
  assert.equal(budgetLevel(1000, 850).level, 'strict');
  const h = harness();
  assert.equal(h.pipeline.budgetNote(1, budgetLevel(1000, 100)), null);
  const first = h.pipeline.budgetNote(1, budgetLevel(1000, 700));
  assert.match(first, /70% used/);
  assert.match(first, /--no-guard/);
  assert.equal(h.pipeline.budgetNote(1, budgetLevel(1000, 720)), null, 'said once per level, not on every call');
  assert.match(h.pipeline.budgetNote(1, budgetLevel(1000, 900)), /Strict mode/);
});

test('a full read after a scoped one hints once at the scope used, and adoption is counted', () => {
  const h = harness();
  const scoped = { ...dump(3), rows: rows(3) };
  h.call({ full: scoped, params: { store: 'orders', fields: ['id'], limit: 3 }, cacheKey: 'scoped' });
  const wide = dump(200, 60);
  const r = h.call({ full: wide, cacheKey: 'wide', actionId: 12 });
  assert.match(r.hint, /read the same target with .*fields/);
  assert.match(r.hint, /"limit":3/);
  assert.ok(h.keys().includes('hintScope'));
  const again = h.call({ full: dump(201, 60), cacheKey: 'wide2', actionId: 13 });
  assert.ok(!again.hint || !/read the same target with/.test(again.hint), 'not repeated for the same target');
  h.call({ full: scoped, params: { store: 'orders', fields: ['id'] }, cacheKey: 'scoped2' });
  assert.ok(h.keys().includes('hintAdopted'), 'scoping again after the hint counts as following it');
});

test('repeated full reads after scoping stop getting scope advice and get reuse advice instead', () => {
  const h = harness();
  h.call({ full: dump(3), params: { store: 'orders', limit: 3 }, cacheKey: 'scoped' });
  const hints = [];
  for (let i = 0; i < 3; i += 1) hints.push(h.call({ full: dump(200 + i, 60), cacheKey: `wide${i}`, actionId: 20 + i }).hint);
  assert.match(hints[0], /Reuse that scope/);
  assert.match(hints[1], /--delta.*--table/);
  assert.ok(h.keys().includes('hintReuse'));
  h.call({ full: dump(203, 60), cacheKey: 'wide1', opts: { delta: true }, actionId: 30 });
  assert.ok(h.keys().includes('hintAdopted'));
});

test('an identical read served from cache and re-delivered in full twice hints at --if-changed', () => {
  const h = harness();
  const full = dump(200, 60);
  const entry = { cachedAt: 't', actionId: 10 };
  h.call({ full, actionId: 10 });
  const first = h.call({ full, hit: true, entry });
  assert.ok(!first.hint);
  const second = h.call({ full, hit: true, entry });
  assert.match(second.hint, /--if-changed/);
  assert.equal(h.call({ full, hit: true, entry }).hint, null, 'said once');
  assert.equal(h.call({ full, hit: true, entry, opts: { ifChanged: true } }).mode, 'pointer');
  assert.ok(h.keys().includes('hintAdopted'));
});

test('small results never draw hints', () => {
  const h = harness();
  h.call({ full: dump(2), params: { store: 'orders', limit: 2 }, cacheKey: 's' });
  assert.equal(h.call({ full: dump(3), cacheKey: 'w' }).hint, null);
});

test('endSession drops what the caller was said to hold', () => {
  const h = harness();
  const full = dump(30);
  h.call({ full, actionId: 10 });
  h.pipeline.endSession(1);
  assert.equal(h.call({ full, hit: true, entry: { cachedAt: 't', actionId: 10 }, opts: { ifChanged: true } }).mode, 'full');
});

test('option and target helpers', () => {
  assert.deepEqual(normalizeShapeOpts(undefined), { table: false, ifChanged: false, delta: false, peek: false, noGuard: false });
  assert.deepEqual(normalizeShapeOpts({ peek: 1, junk: true }), { table: false, ifChanged: false, delta: false, peek: true, noGuard: false });
  assert.equal(isNarrowed('idb.dump', { store: 'a' }), false);
  assert.equal(isNarrowed('idb.dump', { store: 'a', where: { id: 1 } }), true);
  assert.equal(isNarrowed('dom.query', { selector: 'a', meta: false }), false);
  assert.equal(readTargetKey('idb.dump', { store: 'a', limit: 3 }), readTargetKey('idb.dump', { store: 'a' }));
});
