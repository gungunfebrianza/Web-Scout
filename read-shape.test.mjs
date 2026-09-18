// The three reshapers are pure, so they are driven directly: what each returns
// for the cases a real read produces, and - as important - when each declines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tabulate, peekSummary, computeReadDelta, sizeOf } from './read-shape.mjs';

const rows = (n, extra = {}) => Array.from({ length: n }, (_, i) => ({ id: i + 1, status: i % 2 ? 'open' : 'done', owner: `user-${i}`, ...extra }));

test('tabulate states the keys once and is lossless', () => {
  const result = { store: 'orders', count: 6, rows: rows(6) };
  const t = tabulate(result);
  assert.equal(t.changed, true);
  assert.deepEqual(t.result.rows.columns, ['id', 'status', 'owner']);
  assert.equal(t.result.rows.rows.length, 6);
  assert.deepEqual(t.result.rows.rows[1], [2, 'open', 'user-1']);
  assert.equal(t.result.__table, true);
  assert.equal(t.result.store, 'orders');
  assert.ok(sizeOf(t.result) < sizeOf(result), 'the table form is smaller');
  const back = t.result.rows.rows.map((r) => Object.fromEntries(t.result.rows.columns.map((c, i) => [c, r[i]])));
  assert.deepEqual(back, result.rows);
});

test('tabulate leaves small, non-row and single-column arrays alone', () => {
  const small = { rows: rows(2) };
  assert.equal(tabulate(small).changed, false);
  assert.equal(tabulate(small).result, small);
  assert.equal(tabulate({ rows: [1, 2, 3, 4] }).changed, false);
  assert.equal(tabulate({ rows: [{ a: 1 }, { a: 2 }, { a: 3 }] }).changed, false);
  assert.equal(tabulate('text').changed, false);
});

test('tabulate flags sparse rows instead of hiding that a missing key became null', () => {
  const t = tabulate({ rows: [{ a: 1, b: 2 }, { a: 3 }, { a: 4, b: 5 }] });
  assert.equal(t.result.rows.sparse, true);
  assert.deepEqual(t.result.rows.rows[1], [3, null]);
});

test('peekSummary describes a big read without carrying it', () => {
  const big = { store: 'orders', keyPath: 'id', count: 200, rows: rows(200, { notes: 'x'.repeat(300) }) };
  const peek = peekSummary('idb.dump', big, { estTokens: 20000 });
  assert.equal(peek.peek, true);
  assert.equal(peek.arrays.rows.count, 200);
  assert.deepEqual(peek.arrays.rows.columns, ['id', 'status', 'owner', 'notes']);
  assert.match(peek.arrays.rows.sample.notes, /\+\d+ chars/, 'a long sample string is clipped');
  assert.equal(peek.scalars.store, 'orders');
  assert.match(peek.next, /--where/);
  assert.match(peek.next, /without --peek/);
  assert.ok(sizeOf(peek) < sizeOf(big) / 20, `peek is ${sizeOf(peek)} bytes for a ${sizeOf(big)}-byte read`);
});

test('peekSummary of a guarded read says why and how to force it', () => {
  const peek = peekSummary('net.log', { count: 3, entries: rows(3) }, { estTokens: 5000, guarded: true, guardTokens: 1000 });
  assert.equal(peek.guarded, true);
  assert.match(peek.next, /1000-token guard/);
  assert.match(peek.next, /--no-guard/);
});

test('peekSummary describes a long string field and a nested object', () => {
  const peek = peekSummary('dom.query', { found: true, outerHTML: '<div>'.repeat(200), attrs: { id: 'a', class: 'b' } }, { estTokens: 300 });
  assert.equal(peek.scalars.found, true);
  assert.equal(peek.scalars.outerHTML.chars, 1000);
  assert.deepEqual(peek.objects.attrs.keys, ['id', 'class']);
});

test('delta by id reports added, changed and removed rows and the untouched keys', () => {
  const prev = { store: 'orders', keyPath: 'id', totalCount: 30, rows: rows(30) };
  const next = { ...prev, rows: [...rows(30).slice(1).map((r) => (r.id === 5 ? { ...r, status: 'shipped' } : r)), { id: 31, status: 'new', owner: 'user-31' }], totalCount: 30 };
  const d = computeReadDelta(prev, next);
  assert.ok(d, 'a small change is worth a delta');
  assert.deepEqual(d.unchangedKeys.sort(), ['keyPath', 'store', 'totalCount']);
  assert.equal(d.arrays.rows.by, 'id');
  assert.deepEqual(d.arrays.rows.removed, [1]);
  assert.deepEqual(d.arrays.rows.added.map((r) => r.id), [31]);
  assert.deepEqual(d.arrays.rows.changed.map((r) => r.status), ['shipped']);
  assert.ok(sizeOf(d) < sizeOf(next) * 0.7);
});

test('delta without a row id matches by content: added rows listed, removed rows counted', () => {
  const log = (n, from = 0) => Array.from({ length: n }, (_, i) => ({ via: 'fetch', url: `/api/${from + i}`, status: 200, startedAt: `t${from + i}` }));
  const prev = { count: 40, entries: log(40) };
  const next = { count: 40, entries: [...log(40).slice(3), ...log(3, 40)] };
  const d = computeReadDelta(prev, next);
  assert.ok(d);
  assert.equal(d.arrays.entries.by, 'content');
  assert.equal(d.arrays.entries.added.length, 3);
  assert.equal(d.arrays.entries.removedCount, 3);
  assert.match(d.arrays.entries.removedNote, /no id/);
});

test('an unchanged result under a bumped page epoch is a tiny delta, not a resend', () => {
  const result = { store: 'orders', rows: rows(40) };
  const d = computeReadDelta(result, JSON.parse(JSON.stringify(result)));
  assert.deepEqual(d, { unchangedKeys: ['store', 'rows'] });
});

test('delta declines when it would not be smaller, or for non-objects', () => {
  assert.equal(computeReadDelta({ rows: rows(3) }, { rows: rows(3).map((r) => ({ ...r, status: 'changed', owner: 'z' })) }), null, 'everything changed - just send it');
  assert.equal(computeReadDelta('a', 'b'), null);
  assert.equal(computeReadDelta([1], [2]), null);
});

test('delta notes a removed top-level key and a new one', () => {
  const prev = { a: 'x'.repeat(200), gone: 1, rows: rows(30) };
  const next = { a: 'x'.repeat(200), fresh: true, rows: rows(30) };
  const d = computeReadDelta(prev, next);
  assert.deepEqual(d.removedKeys, ['gone']);
  assert.deepEqual(d.changed, { fresh: true });
});
