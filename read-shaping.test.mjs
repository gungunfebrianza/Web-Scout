// The read-shaping options end to end through a real relay and a stand-in tab:
// what the caller receives for --if-changed / --delta / --peek / --table, the
// token-budget guard, the behaviour hints, the session-start briefing, and how
// each of them shows up in the ledger and the session receipt.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestRelay, connectFakeAgent } from './test-relay.mjs';

const relay = await startTestRelay();
const BASE = `http://127.0.0.1:${relay.port}`;
const skipLive = relay.live ? 'skipped under WEBSCOUT_TEST_LIVE=1' : false;
let tab;
const data = { orders: [], log: [] };

const makeRows = (n, pad = 0, status = 'open') => Array.from({ length: n }, (_, i) => ({ id: i + 1, status, owner: `user-${i}`, note: 'n'.repeat(pad) }));

async function raw(method, route, body) {
  const res = await fetch(`${BASE}${route}`, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  return { headers: res.headers, json: await res.json() };
}
const api = async (method, route, body) => (await raw(method, route, body)).json.result;
const read = (type, params, opts, agent = 'shape-tab') => raw('POST', '/command', { type, params, agent, opts });
const report = async () => (await api('GET', '/token-report')).savings;
const shaping = async () => (await report()).readStrategy.shaping;

before(async () => {
  if (relay.live) return;
  data.orders = makeRows(80, 30);
  tab = await connectFakeAgent(relay.port, {
    'idb.dump': (p) => ({ store: p.store, keyPath: 'id', totalCount: data.orders.length, count: data.orders.length, rows: data.orders }),
    'idb.list': () => ({ stores: ['orders', 'empty', 'log'], counts: { orders: data.orders.length, empty: 0, log: 7 } }),
    'db.version': () => ({ name: 'app', version: 42 }),
    'net.log': () => ({ count: data.log.length, entries: data.log }),
    'dom.click': () => ({ clicked: true }),
  }, { name: 'shape-tab', epoch: 0 });
});

after(async () => {
  tab?.close();
  await relay.stop();
});

test('session start carries a warm-start briefing, and briefing:false leaves it out', { skip: skipLive }, async () => {
  const started = await api('POST', '/sessions', { goal: 'read-shaping.test.mjs', context: 'automated', agent: 'shape-tab' });
  assert.equal(started.briefing.available, true);
  assert.deepEqual(started.briefing.db, { name: 'app', version: 42 });
  assert.equal(started.briefing.storeCount, 3);
  assert.deepEqual(started.briefing.stores, { orders: 80, log: 7 });
  assert.equal(started.briefing.emptyStores, 1);
  assert.equal(started.briefing.tab.agentStale, false);
  assert.ok(!tab.seen.some((m) => m.type === 'ping'), 'the briefing is two reads, not a probe loop');
  await api('POST', `/sessions/${started.id}/end`);
  const quiet = await api('POST', '/sessions', { goal: 'read-shaping.test.mjs quiet', context: 'automated', agent: 'shape-tab', briefing: false });
  assert.equal(quiet.briefing, undefined);
  await api('POST', `/sessions/${quiet.id}/end`);
});

test('no tab for the briefing is reported, not an error', { skip: skipLive }, async () => {
  const s = await api('POST', '/sessions', { goal: 'read-shaping.test.mjs no tab', context: 'automated', agent: 'nobody-home' });
  assert.equal(s.briefing.available, false);
  assert.match(s.briefing.reason, /no tab connected/);
  await api('POST', `/sessions/${s.id}/end`);
});

test('--if-changed answers an unchanged repeat with a pointer and a changed page with the body', { skip: skipLive }, async () => {
  await api('POST', '/sessions', { goal: 'read-shaping.test.mjs pointer', context: 'automated', briefing: false });
  const before = await shaping();
  const first = (await read('idb.dump', { store: 'orders' }, { ifChanged: true })).json.result;
  assert.equal(first.rows.length, 80, 'nothing held yet: the body');
  const second = (await read('idb.dump', { store: 'orders' }, { ifChanged: true })).json.result;
  assert.equal(second.unchanged, true);
  assert.ok(Number.isInteger(second.sameAs), 'points at the action that delivered the body');
  assert.equal(second.rows, undefined);
  assert.ok(second.omittedBytes > 5000);
  const mid = await shaping();
  assert.equal(mid.pointer.calls - before.pointer.calls, 1);
  assert.ok(mid.pointer.bytesSaved - before.pointer.bytesSaved > 5000);
  tab.state.epoch += 1; // the page changed on its own
  const third = (await read('idb.dump', { store: 'orders' }, { ifChanged: true })).json.result;
  assert.equal(third.rows.length, 80, 'a changed page must be re-read, never answered "unchanged"');
  assert.equal(third.unchanged, undefined);
});

test('a plain repeat read is still the full cached body, unchanged from before', { skip: skipLive }, async () => {
  const plain = (await read('idb.dump', { store: 'orders' })).json.result;
  assert.equal(plain.__cacheHit, true);
  assert.equal(plain.rows.length, 80);
});

test('--delta returns only what changed when the page moved', { skip: skipLive }, async () => {
  const before = await shaping();
  await read('idb.dump', { store: 'orders' }, { delta: true }); // body held
  data.orders = data.orders.map((r) => (r.id === 5 ? { ...r, status: 'shipped' } : r)).concat([{ id: 81, status: 'new', owner: 'user-81', note: 'n'.repeat(30) }]);
  tab.state.epoch += 1;
  const d = (await read('idb.dump', { store: 'orders' }, { delta: true })).json.result;
  assert.equal(d.__delta, true);
  assert.deepEqual(d.arrays.rows.changed.map((r) => r.id), [5]);
  assert.deepEqual(d.arrays.rows.added.map((r) => r.id), [81]);
  assert.ok(d.unchangedKeys.includes('store'));
  assert.ok(JSON.stringify(d).length < 1000);
  const after = await shaping();
  assert.equal(after.delta.calls - before.delta.calls, 1);
  assert.ok(after.delta.bytesSaved - before.delta.bytesSaved > 5000);
  const unchangedAgain = (await read('idb.dump', { store: 'orders' }, { delta: true })).json.result;
  assert.equal(unchangedAgain.unchanged, true, 'nothing moved since the delta: a pointer, chained off the delta');
});

test('--peek returns the shape, and the full body is then a free cache hit', { skip: skipLive }, async () => {
  data.orders = makeRows(120, 60);
  tab.state.epoch += 1;
  const peek = (await read('idb.dump', { store: 'orders' }, { peek: true })).json.result;
  assert.equal(peek.peek, true);
  assert.equal(peek.arrays.rows.count, 120);
  assert.deepEqual(peek.arrays.rows.columns, ['id', 'status', 'owner', 'note']);
  assert.ok(JSON.stringify(peek).length < 2000);
  const dispatchedBefore = tab.seen.filter((m) => m.type === 'idb.dump').length;
  const full = (await read('idb.dump', { store: 'orders' })).json.result;
  assert.equal(full.rows.length, 120);
  assert.equal(full.__cacheHit, true, 'the peek cached the body, so the follow-up asks the page nothing');
  assert.equal(tab.seen.filter((m) => m.type === 'idb.dump').length, dispatchedBefore);
  const s = await shaping();
  assert.ok(s.peek.calls >= 1);
  assert.ok(s.peek.followedByFull >= 1, 'the follow-up full read is measured');
  assert.ok(s.peek.bytesSpentAfterwards > 5000, 'and its bytes are taken back out of the peek saving');
});

test('--table states the keys once', { skip: skipLive }, async () => {
  const before = await shaping();
  const t = (await read('idb.dump', { store: 'orders' }, { table: true })).json.result;
  assert.equal(t.__table, true);
  assert.deepEqual(t.rows.columns, ['id', 'status', 'owner', 'note']);
  assert.equal(t.rows.rows.length, 120);
  assert.deepEqual(t.rows.rows[0].slice(0, 3), [1, 'open', 'user-0']);
  assert.ok((await shaping()).table.bytesSaved - before.table.bytesSaved > 3000);
});

test('an identical full re-delivery draws a hint once, and using --if-changed counts as following it', { skip: skipLive }, async () => {
  data.orders = makeRows(150, 60);
  tab.state.epoch += 1;
  const hints = [];
  for (let i = 0; i < 4; i += 1) hints.push((await read('idb.dump', { store: 'hinted' })).headers.get('x-webscout-hint'));
  assert.equal(hints.filter(Boolean).length, 1, `exactly one hint in ${JSON.stringify(hints)}`);
  assert.match(hints.find(Boolean), /--if-changed/);
  const before = (await report()).readStrategy.hints;
  assert.ok(before.reuse >= 1);
  await read('idb.dump', { store: 'hinted' }, { ifChanged: true });
  assert.ok((await report()).readStrategy.hints.adopted > before.adopted);
});

test('the session receipt counts shaped replies and the tokens actually delivered', { skip: skipLive }, async () => {
  const current = (await api('GET', '/health')).active_session;
  const ended = await api('POST', `/sessions/${current.id}/end`);
  assert.ok(ended.savingsReceipt.shapedCalls >= 5);
  assert.ok(ended.savingsReceipt.shapedBytes > 15000);
  assert.equal(typeof ended.savingsReceipt.deliveredEstTokens, 'number');
});

test('a token budget arms the guard: past 60% a large read returns its shape, --no-guard forces it', { skip: skipLive }, async () => {
  data.orders = makeRows(100, 60);
  tab.state.epoch += 1;
  const s = await api('POST', '/sessions', { goal: 'read-shaping.test.mjs budget', context: 'automated', token_budget: 4000, briefing: false });
  assert.equal(s.budget.tokens, 4000);
  assert.equal(s.budget.tightenAtTokens, 2400);
  const first = await read('idb.dump', { store: 'a' });
  assert.equal(first.json.result.rows.length, 100, 'under the mark: delivered whole');
  assert.equal(first.headers.get('x-webscout-budget'), null);
  data.orders = makeRows(250, 60); // the next read is well over the 3000-token guard
  const second = await read('idb.dump', { store: 'b' });
  assert.equal(second.json.result.peek, true, 'over 60% of the budget: shape only');
  assert.equal(second.json.result.guarded, true);
  assert.match(second.headers.get('x-webscout-budget'), /Tightened mode/);
  const third = await read('idb.dump', { store: 'c' });
  assert.equal(third.headers.get('x-webscout-budget'), null, 'announced once per level');
  const forced = (await read('idb.dump', { store: 'b' }, { noGuard: true })).json.result;
  assert.equal(forced.__table, true, 'forced through, still tabular');
  assert.equal(forced.rows.rows.length, 250);
  const stats = await shaping();
  assert.ok(stats.peek.guardedCalls >= 2);
  await api('POST', `/sessions/${s.id}/end`);
});

test('the token report shows shaping as a delivery ledger and labels its estimator', { skip: skipLive }, async () => {
  const sv = await report();
  const ledger = sv.ledgers.find((l) => l.key === 'deliveryShaping');
  assert.ok(ledger, 'deliveryShaping ledger');
  assert.equal(ledger.kind, 'delivery');
  assert.ok(ledger.bytesSaved > 15000);
  assert.ok(sv.byKind.delivery.bytesSaved >= ledger.bytesSaved);
  assert.equal(sv.estimator.unit, 'chars/4');
  assert.equal(typeof sv.estimator.calibrated, 'boolean');
  assert.ok(sv.estimator.kinds.json.low < sv.estimator.kinds.json.high);
  assert.ok(sv.spend.estTokensBand.low <= sv.spend.estTokensBand.high);
  const today = sv.trend.find((t) => t.day === new Date().toISOString().slice(0, 10));
  assert.ok(today.shapedBytes > 0, 'the trend has a shaped-bytes column');
});

test('one delivered-bytes number: the per-type report, the running total and the receipt all follow what the caller was handed', { skip: skipLive }, async () => {
  data.orders = makeRows(200, 60);
  tab.state.epoch += 1;
  const s = await api('POST', '/sessions', { goal: 'read-shaping.test.mjs delivered', context: 'automated', briefing: false });
  const peeked = await read('idb.dump', { store: 'big' }, { peek: true });
  assert.equal(peeked.json.result.peek, true);
  const perType = await api('GET', `/sessions/${s.id}/token-report`);
  const row = perType.byType.find((r) => r.type === 'idb.dump');
  assert.ok(row.resultBytes > 10000, 'the full result is still what was logged');
  assert.ok(row.deliveredBytes < 2500, `but the caller got the peek: ${row.deliveredBytes}`);
  assert.equal(row.withheldBytes, row.resultBytes - row.deliveredBytes);
  assert.equal(row.estTokens, Math.round((row.deliveredBytes + row.paramsBytes) / 4), 'tokens follow delivered bytes, not the logged result');
  assert.equal(perType.totalEstTokens, row.estTokens, 'the running total agrees with the report');
  assert.equal(Number(peeked.headers.get('x-webscout-session-tokens')), row.estTokens);
  const ended = await api('POST', `/sessions/${s.id}/end`);
  assert.equal(ended.savingsReceipt.deliveredEstTokens, row.estTokens);
});

test('a lean session shapes plain reads by default, --no-guard gets the body, and adoption is counted', { skip: skipLive }, async () => {
  data.orders = makeRows(200, 60);
  tab.state.epoch += 1;
  const before = (await report()).readStrategy.adoption;
  const s = await api('POST', '/sessions', { goal: 'read-shaping.test.mjs lean', context: 'automated', briefing: false, lean: true });
  assert.equal(s.lean, true);
  assert.match(s.leanProfile.note, /lean session/);

  const big = (await read('idb.dump', { store: 'lean-a' })).json.result; // no flags at all
  assert.equal(big.peek, true, 'a large body came back as its shape without the caller asking');
  assert.equal(big.guarded, true);
  const body = (await read('idb.dump', { store: 'lean-a' }, { noGuard: true })).json.result;
  assert.equal(body.rows.length ?? body.rows.rows.length, 200, 'noGuard gives the whole result');

  data.orders = makeRows(20, 5);
  tab.state.epoch += 1;
  const small = (await read('idb.dump', { store: 'lean-b' })).json.result;
  assert.equal(small.__table, true, 'a small body still comes back as a table');
  const repeat = (await read('idb.dump', { store: 'lean-b' })).json.result;
  assert.equal(repeat.unchanged, true, 'a repeat of what they hold is one line');

  const after = (await report()).readStrategy.adoption;
  assert.ok(after.lean.calls - before.lean.calls >= 3);
  assert.ok(after.plain.calls - before.plain.calls >= 1, 'a noGuard call opts OUT of shaping, so it counts as an unshaped read');
  await api('POST', `/sessions/${s.id}/end`);

  const plain = await api('POST', '/sessions', { goal: 'read-shaping.test.mjs not lean', context: 'automated', briefing: false });
  assert.equal(plain.lean, false);
  assert.equal(plain.leanProfile, undefined);
  const untouched = (await read('idb.dump', { store: 'lean-c' })).json.result;
  assert.equal(untouched.rows.length, 20, 'without --lean nothing changes');
  await api('POST', `/sessions/${plain.id}/end`);
});

test('the token report costs the hints: bytes sent against bytes the adopting calls saved', { skip: skipLive }, async () => {
  const hints = (await report()).readStrategy.hints;
  assert.ok(hints.sentBytes > 0, 'earlier tests drew hints, and their size is booked');
  assert.equal(hints.netBytes, hints.adoptedBytesSaved - hints.sentBytes);
});
