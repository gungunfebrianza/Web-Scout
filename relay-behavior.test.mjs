// Relay behavior that needs a connected tab, exercised end to end through a
// fake in-page agent (see test-relay.mjs) - real relay process, real HTTP,
// real WebSocket protocol, no browser. Covers the parts of this round's
// changes that a static check cannot: registry-driven cache invalidation,
// registry-driven cleanup tracking, and the token-report response headers.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestRelay, connectFakeAgent } from './test-relay.mjs';

const relay = await startTestRelay();
const BASE = `http://127.0.0.1:${relay.port}`;
let agent;
let netLogCalls = 0;
let sessionId;

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  return { json, headers: res.headers, status: res.status };
}
const command = (type, params) => api('POST', '/command', { type, params });

before(async () => {
  if (relay.live) return; // a fake agent would steal the real tab's connection
  agent = await connectFakeAgent(relay.port, {
    'net.log': () => { netLogCalls += 1; return { count: 1, entries: [{ url: `/call-${netLogCalls}` }] }; },
    'net.clear': () => ({ cleared: 1 }),
    eval: (p) => ({ echoed: 'x'.repeat(Number(p.expr) || 0) }),
    'idb.putMany': (p) => ({ store: p.store, stored: p.rows.length, keyPath: 'id', rows: p.rows }),
    'idb.put': (p) => ({ store: p.store, key: p.row.id, row: p.row }),
    'idb.patch': (p) => ({ store: p.store, key: p.key, patched: true }),
  });
  const started = await api('POST', '/sessions', { goal: 'relay-behavior.test.mjs', context: 'automated' });
  sessionId = started.json.result.id;
});

after(async () => {
  agent?.close();
  await relay.stop();
});

const skipLive = relay.live ? 'skipped under WEBSCOUT_TEST_LIVE=1 (a fake agent would replace the real tab)' : false;

test('/health reports pid, start time, uptime and an (empty) stale-source list', { skip: skipLive }, async () => {
  const { json } = await api('GET', '/health');
  assert.equal(typeof json.result.relay.pid, 'number');
  assert.ok(Date.parse(json.result.relay.started_at) > 0);
  assert.ok(json.result.relay.uptime_seconds >= 0);
  assert.deepEqual(json.result.relay.stale_source_files, []);
});

test('an identical net.log is served from cache, and net.clear invalidates it', { skip: skipLive }, async () => {
  const first = await command('net.log', {});
  const second = await command('net.log', {});
  assert.equal(second.json.result.__cacheHit, true, 'second identical read should be a cache hit');
  assert.equal(netLogCalls, 1, 'a cache hit must not dispatch to the page');
  assert.deepEqual(second.json.result.entries, first.json.result.entries);

  await command('net.clear', {});
  const third = await command('net.log', {});
  assert.notEqual(third.json.result.__cacheHit, true, 'net.clear must invalidate the cached net.log');
  assert.equal(netLogCalls, 2, 'after net.clear the read must reach the page again');
});

test('session cleanup sees idb.putMany rows (registry cleanup kind), and ignores idb.patch', { skip: skipLive }, async () => {
  await command('idb.putMany', { store: 'widgets', rows: [{ id: 1 }, { id: 2 }, { id: 3 }] });
  await command('idb.put', { store: 'widgets', row: { id: 9 } });
  await command('idb.patch', { store: 'widgets', key: 9, patch: { a: 1 } });
  const { json } = await api('POST', `/sessions/${sessionId}/cleanup`, {});
  const keys = json.result.pendingDeletes.filter((r) => r.store === 'widgets').map((r) => r.key).sort();
  assert.deepEqual(keys, [1, 2, 3, 9]);
  assert.equal(json.result.mode, 'actionLog');
  assert.match(json.result.note, /idb\.putMany/, 'the tracked-types list in the note is derived from the registry');
});

test('every reply carries the running total; a per-call delta appears from the second reply on', { skip: skipLive }, async () => {
  const a = await command('eval', { expr: '4000' });
  const totalA = Number(a.headers.get('x-webscout-session-tokens'));
  assert.ok(totalA > 0);
  const b = await command('eval', { expr: '4000' });
  const totalB = Number(b.headers.get('x-webscout-session-tokens'));
  const delta = Number(b.headers.get('x-webscout-call-tokens'));
  assert.ok(totalB > totalA, 'total grows with each logged action');
  assert.equal(delta, totalB - totalA, 'delta is exactly what this call added');
  assert.ok(delta >= 1000, `a 4000-char result is ~1000 tokens, got +${delta}`);
});

test('the read-cache hit still counts toward the running total (it is still read by the caller)', { skip: skipLive }, async () => {
  const before = Number((await command('net.clear', {})).headers.get('x-webscout-session-tokens'));
  await command('net.log', {});
  const miss = Number((await command('net.log', {})).headers.get('x-webscout-session-tokens'));
  const hit = Number((await command('net.log', {})).headers.get('x-webscout-session-tokens'));
  assert.ok(miss >= before);
  assert.ok(hit >= miss, 'a cache hit must not lower the total');
});

// A tab that reports its own change counter (inject.js's pageEpoch).
async function connectEpochTab() {
  let domQueryCalls = 0;
  const tab = await connectFakeAgent(relay.port, {
    'dom.query': () => { domQueryCalls += 1; return { found: true, call: domQueryCalls }; },
    'idb.dump': (p) => ({ store: p.store, rows: [{ id: 1 }], count: 1 }),
  }, { name: 'epoch-tab', epoch: 0 });
  return { tab, calls: () => domQueryCalls };
}
const tabQuery = (type, params) => api('POST', '/command', { type, params, agent: 'epoch-tab' });

test('a page that changed on its own is no longer answered from the cache', { skip: skipLive }, async () => {
  const { tab, calls } = await connectEpochTab();
  try {
    const first = await tabQuery('dom.query', { selector: '#x' });
    const second = await tabQuery('dom.query', { selector: '#x' });
    assert.equal(first.json.result.__cacheHit, undefined);
    assert.equal(second.json.result.__cacheHit, true, 'nothing changed - still a hit');
    assert.equal(calls(), 1);

    tab.state.epoch = 5; // the page changed without any command from us
    const third = await tabQuery('dom.query', { selector: '#x' });
    assert.notEqual(third.json.result.__cacheHit, true, 'a changed page must not be served the stale read');
    assert.equal(third.json.result.call, 2);

    const fourth = await tabQuery('dom.query', { selector: '#x' });
    assert.equal(fourth.json.result.__cacheHit, true, 'the fresh read is cached against the new epoch');

    const report = (await api('GET', '/token-report')).json.result;
    assert.ok(report.savings.readCache.pageStaleMisses >= 1);
  } finally {
    tab.close();
  }
});

test('the read cache is per tab: the same query on another tab is not a hit', { skip: skipLive }, async () => {
  const { tab } = await connectEpochTab();
  try {
    await tabQuery('dom.query', { selector: '#per-tab' });
    const other = await command('dom.query', { selector: '#per-tab' }); // the default tab, different answer
    assert.notEqual(other.json.result.__cacheHit, true);
    assert.equal(other.json.result.found, undefined, 'must come from the default tab, not the epoch tab');
  } finally {
    tab.close();
  }
});

test('a scoped read is counted in the scopedReads ledger and the daily trend', { skip: skipLive }, async () => {
  const { tab } = await connectEpochTab();
  try {
    const before = (await api('GET', '/token-report')).json.result.savings;
    const beforeBytes = before.ledgers.find((l) => l.key === 'scopedReads').bytesSaved;
    tab.state.avoided = 4000;
    await tabQuery('idb.dump', { store: 'widgets', where: { id: 1 } });
    const after = (await api('GET', '/token-report')).json.result.savings;
    const ledger = after.ledgers.find((l) => l.key === 'scopedReads');
    assert.equal(ledger.kind, 'delivery');
    assert.equal(ledger.bytesSaved - beforeBytes, 4000);
    assert.ok(after.byKind.delivery.bytesSaved >= 4000);
    const today = after.trend.find((t) => t.day === new Date().toISOString().slice(0, 10));
    assert.ok(today && today.avoidedBytes >= 4000, 'the daily trend carries the avoided bytes');
    assert.ok(today.avoidedPct > 0);
  } finally {
    tab.close();
  }
});

test('session end returns a savings receipt for this session', { skip: skipLive }, async () => {
  const { json } = await api('POST', `/sessions/${sessionId}/end`);
  assert.ok(json.result.savingsReceipt.scopedCalls >= 1);
  assert.ok(json.result.savingsReceipt.avoidedBytes >= 4000);
  assert.ok(json.result.savingsReceipt.cacheHits >= 1);
});
