// Is scoping actually working for the caller? A scoped read followed by the same
// read unscoped means the "saved" bytes were spent after all; an outline followed
// by --full means the outline was not enough. Also: the storage-dedup total is
// sampled so the trend can show it day by day.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestRelay, connectFakeAgent } from './test-relay.mjs';

const relay = await startTestRelay();
const BASE = `http://127.0.0.1:${relay.port}`;
const skipLive = relay.live ? 'skipped under WEBSCOUT_TEST_LIVE=1' : false;
let tab;

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  return (await res.json()).result;
}
const query = (type, params) => api('POST', '/command', { type, params, agent: 'strategy-tab' });
const stats = async () => (await api('GET', '/token-report')).savings.readStrategy;

before(async () => {
  if (relay.live) return;
  tab = await connectFakeAgent(relay.port, {
    'idb.dump': (p) => ({ store: p.store, rows: p.where ? [{ id: 1 }] : [{ id: 1 }, { id: 2 }, { id: 3 }] }),
    'dom.query': (p) => (p.full || p.selector !== 'body' ? { found: true, outerHTML: '<x/>' } : { found: true, outline: ['body [2 children]', '  div#app'] }),
  }, { name: 'strategy-tab', epoch: 0 });
  await api('POST', '/sessions', { goal: 'read-strategy.test.mjs', context: 'automated' });
});

after(async () => {
  tab?.close();
  await relay.stop();
});

test('a scoped read followed by the same read unscoped counts as a re-read', { skip: skipLive }, async () => {
  const before = await stats();
  tab.state.avoided = 3000;
  await query('idb.dump', { store: 'a', where: { id: 1 } });
  await query('idb.dump', { store: 'a' }); // same store, no scoping: the caller wanted the rest after all
  const after = await stats();
  assert.equal(after.reRead.reReads - before.reRead.reReads, 1);
  assert.equal(after.reRead.scopedCalls - before.reRead.scopedCalls, 1);
  assert.ok(after.reRead.ratePct > 0);
});

test('a different target, or a scoped follow-up, is not a re-read', { skip: skipLive }, async () => {
  const before = await stats();
  tab.state.avoided = 3000;
  await query('idb.dump', { store: 'b', where: { id: 1 } });
  await query('idb.dump', { store: 'c' }); // another store entirely
  tab.state.avoided = 3000;
  await query('idb.dump', { store: 'b', where: { id: 2 } }); // still scoped
  const after = await stats();
  assert.equal(after.reRead.reReads, before.reRead.reReads);
});

test('an outline is measured against the reply it replaced, and a drill-in is classified as it working', { skip: skipLive }, async () => {
  const before = await stats();
  tab.state.outlineOld = 3000;
  await query('dom.query', { selector: 'body' });
  await query('dom.query', { selector: '#app' }); // drilled into a child: the outline worked as a map
  const after = await stats();
  assert.equal(after.outline.calls - before.outline.calls, 1);
  assert.equal(after.outline.oldDefaultBytes - before.outline.oldDefaultBytes, 3000);
  assert.ok(after.outline.deliveredBytes > before.outline.deliveredBytes);
  assert.equal(after.outline.followedByDrillIn - before.outline.followedByDrillIn, 1);
  assert.equal(after.outline.followedByFull, before.outline.followedByFull);
});

test('an outline followed by --full on the same selector counts against the outline', { skip: skipLive }, async () => {
  const other = await connectFakeAgent(relay.port, {
    'dom.query': (p) => (p.full ? { found: true, outerHTML: '<big/>' } : { found: true, outline: ['html [1 children]'] }),
  }, { name: 'outline-tab' });
  try {
    const ask = (params) => api('POST', '/command', { type: 'dom.query', params, agent: 'outline-tab' });
    const before = await stats();
    other.state.outlineOld = 2500;
    await ask({ selector: 'body' });
    await ask({ selector: 'body', full: true });
    const after = await stats();
    assert.equal(after.outline.followedByFull - before.outline.followedByFull, 1);
    assert.ok(after.outline.fullRatePct > 0);
  } finally {
    other.close();
  }
});

test('the storage-dedup total is sampled into the trend', { skip: skipLive }, async () => {
  const report = await api('GET', '/token-report');
  const today = report.savings.trend.find((t) => t.day === new Date().toISOString().slice(0, 10));
  assert.ok(today, 'today has a trend row');
  assert.equal(typeof today.storageBytesSaved, 'number');
  assert.ok(today.storageBytesSaved >= 0);
});
