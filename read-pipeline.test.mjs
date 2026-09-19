// The reply pipeline as a state machine: what a caller receives for the same read
// under each option, what it is said to hold afterwards, what each mode books in
// the ledger, and which behaviours turn into hints. No relay, no page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReadPipeline, budgetLevel, normalizeShapeOpts, isNarrowed, readTargetKey } from './read-pipeline.mjs';

const rows = (n, pad = 0) => Array.from({ length: n }, (_, i) => ({ id: i + 1, status: i % 2 ? 'open' : 'done', owner: `user-${i}`, note: 'n'.repeat(pad) }));
const dump = (n, pad) => ({ store: 'orders', keyPath: 'id', count: n, rows: rows(n, pad) });

// who-asked and hint-cost counters are bookkeeping about the calls, not savings: kept apart so a
// mode's ledger entry can be asserted on its own
const COUNTER_KEYS = new Set(['readPlain', 'readExplicit', 'readLean', 'hintBytes']);

function harness() {
  const booked = [];
  const counters = [];
  let clock = 1000;
  const pipeline = createReadPipeline({ bump: (key, bytes) => (COUNTER_KEYS.has(key) ? counters : booked).push([key, bytes]), now: () => clock });
  const call = (over = {}) => {
    const full = over.full ?? dump(20);
    return pipeline.shape({ sessionId: 1, type: 'idb.dump', agentName: 'default', params: { store: 'orders' }, cacheKey: 'default::idb.dump::{"store":"orders"}', hit: false, actionId: 10, opts: {}, budget: null, ...over, full });
  };
  return { pipeline, booked, counters, call, tick: (ms) => { clock += ms; }, keys: () => booked.map(([k]) => k) };
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

test('a pointer distrusted (re-asked for the raw body afterwards) is measured, same as a peek', () => {
  const h = harness();
  const full = dump(30);
  const entry = { cachedAt: 't0', actionId: 10 };
  h.call({ full, actionId: 10, opts: { ifChanged: true } }); // establishes what the caller holds
  h.call({ full, hit: true, entry, opts: { ifChanged: true } }); // pointer: "unchanged, you already have it"
  const again = h.call({ full, hit: true, entry: { cachedAt: 't1', actionId: 10 } }); // dropped --if-changed: wanted the body anyway
  assert.equal(again.mode, 'full');
  assert.ok(h.keys().includes('pointerThenFull'));
});

test('a pointer followed by a narrower read on the same target is measured as narrowed, not full', () => {
  const h = harness();
  const full = dump(30);
  const entry = { cachedAt: 't0', actionId: 10 };
  h.call({ full, actionId: 10, opts: { ifChanged: true } });
  h.call({ full, hit: true, entry, opts: { ifChanged: true } });
  const narrower = h.call({ full: dump(3), params: { store: 'orders', where: { id: 1 } }, cacheKey: 'k-where', actionId: 11 });
  assert.equal(narrower.mode, 'full');
  assert.ok(h.keys().includes('pointerThenNarrowed'));
  assert.ok(!h.keys().includes('pointerThenFull'));
});

test('a pointer followed by another pointer is still trust, not a re-ask', () => {
  const h = harness();
  const full = dump(30);
  const entry = { cachedAt: 't0', actionId: 10 };
  h.call({ full, actionId: 10, opts: { ifChanged: true } });
  h.call({ full, hit: true, entry, opts: { ifChanged: true } });
  h.call({ full, hit: true, entry: { cachedAt: 't1', actionId: 10 }, opts: { ifChanged: true } });
  assert.ok(!h.keys().includes('pointerThenFull'));
  assert.ok(!h.keys().includes('pointerThenNarrowed'));
});

test('a distrusted delta is measured under its own name, and forgotten after the window', () => {
  const h = harness();
  const v1 = dump(60);
  h.call({ full: v1, actionId: 10 });
  const v2 = { ...v1, rows: v1.rows.map((r) => (r.id === 7 ? { ...r, status: 'shipped' } : r)) };
  h.call({ full: v2, actionId: 11, opts: { delta: true } });
  const full = h.call({ full: v2, hit: true, entry: { cachedAt: 't', actionId: 11 } });
  assert.equal(full.mode, 'full');
  assert.ok(h.keys().includes('deltaThenFull'));

  const h2 = harness();
  h2.call({ full: v1, actionId: 10 });
  h2.call({ full: v2, actionId: 11, opts: { delta: true } });
  h2.tick(91000);
  h2.call({ full: v2, hit: true, entry: { cachedAt: 't', actionId: 11 } });
  assert.ok(!h2.keys().includes('deltaThenFull'));
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

// ---------- lean sessions, who asked, and quiet hints ----------

test('a lean session shapes by default: a table, a pointer for a repeat, a peek for a large body', () => {
  const h = harness();
  const big = dump(200, 60);
  const first = h.call({ full: big, actionId: 10, lean: true });
  assert.equal(first.mode, 'guard', 'over the lean guard: the shape, without the caller asking');
  assert.equal(first.out.guarded, true);
  const small = dump(30);
  const t = h.call({ full: small, actionId: 11, cacheKey: 'k-small', lean: true });
  assert.equal(t.mode, 'table', 'small enough to deliver, still stated as a table');
  const pointer = h.call({ full: small, hit: true, entry: { cachedAt: 't', actionId: 11 }, cacheKey: 'k-small', lean: true });
  assert.equal(pointer.mode, 'pointer', 'the caller holds this exact result: unchanged, one line');
  assert.deepEqual(h.counters.map(([k]) => k).filter((k) => k !== 'hintBytes'), ['readLean', 'readLean', 'readLean']);
});

test('--no-guard on a call in a lean session gives the body without the lean defaults', () => {
  const h = harness();
  const big = dump(200, 60);
  const r = h.call({ full: big, actionId: 10, lean: true, opts: { noGuard: true } });
  assert.equal(r.mode, 'full');
  assert.equal(r.out.rows.length, 200);
  const again = h.call({ full: big, hit: true, entry: { cachedAt: 't', actionId: 10 }, lean: true, opts: { noGuard: true } });
  assert.equal(again.mode, 'full', 'no implied pointer either: they asked for the body');
});

test('a session that is not lean is unchanged by the lean code path', () => {
  const h = harness();
  const r = h.call({ full: dump(200, 60), actionId: 10 });
  assert.equal(r.mode, 'full');
  assert.deepEqual(h.counters.map(([k]) => k), ['readPlain']);
});

test('reads are counted by who chose the shaping: the caller, the session, or nobody', () => {
  const h = harness();
  h.call({ full: dump(20), opts: { table: true }, cacheKey: 'a' });
  h.call({ full: dump(20), cacheKey: 'b' });
  h.call({ full: dump(20), cacheKey: 'c', lean: true });
  assert.deepEqual(h.counters.map(([k]) => k), ['readExplicit', 'readPlain', 'readLean']);
  assert.ok(h.counters.every(([, bytes]) => bytes > 0), 'each carries the bytes delivered, so plain reads show how much flowed unshaped');
});

test('hints are capped per session and go quiet for a kind the caller keeps ignoring', () => {
  const h = harness();
  const big = dump(150, 60);
  const sent = [];
  for (let i = 0; i < 8; i += 1) {
    const target = `{"store":"s${i}"}`;
    const scopedKey = `default::idb.dump::{"store":"s${i}","limit":5}`;
    h.call({ full: dump(5), params: { store: `s${i}`, limit: 5 }, cacheKey: scopedKey, actionId: 100 + i });
    const r = h.call({ full: big, params: { store: `s${i}` }, cacheKey: `default::idb.dump::${target}`, actionId: 200 + i });
    if (r.hint) sent.push(r.hint);
  }
  assert.equal(sent.length, 2, `a kind the caller ignored twice stops: ${sent.length} hints sent`);
});

test('the hint text sent and the bytes an adopting call saved are both booked, so a hint can be costed', () => {
  const h = harness();
  const big = dump(120, 60);
  const entry = { cachedAt: 't', actionId: 10 };
  h.call({ full: big, actionId: 10 });
  const r1 = h.call({ full: big, hit: true, entry });
  const r2 = h.call({ full: big, hit: true, entry });
  assert.match(r2.hint ?? r1.hint, /--if-changed/);
  const sentBytes = h.counters.filter(([k]) => k === 'hintBytes').reduce((a, [, b]) => a + b, 0);
  assert.ok(sentBytes > 100, 'the hint itself is a cost');
  h.call({ full: big, hit: true, entry, opts: { ifChanged: true } });
  const adopted = h.booked.filter(([k]) => k === 'hintAdopted');
  assert.equal(adopted.length, 1);
  assert.ok(adopted[0][1] > 1000, 'credited with what the adopting call kept off the screen');
});
