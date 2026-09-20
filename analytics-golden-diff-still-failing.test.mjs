// Round-8 gap: state_diffs (db.mjs) is durable, keyed by golden name via POST /state/diff's
// {golden, idB} form (cli.mjs's "idb diff-golden") - structurally the same gap
// verityLabelsStillFailing already closes for Verity imports (see analytics-known-issues.test.mjs
// for that pattern's own precedent). A golden whose most recent diff came back non-clean had zero
// cross-session visibility before this: you'd only notice by re-running that exact diff-golden
// call again. This checks computeAnalytics's new goldenDiffsStillFailing. Real relay, a fake
// agent tab answering idb.snapshot with scripted store content (no browser needed).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestRelay, connectFakeAgent } from './test-relay.mjs';

async function withRelay(fn) {
  const relay = await startTestRelay();
  let stores = { orders: { keyPath: 'id', rows: [{ id: 1, status: 'open' }] } };
  const tab = await connectFakeAgent(relay.port, { 'idb.snapshot': () => ({ stores }) });
  const api = async (method, route, body) => {
    const res = await fetch(`http://127.0.0.1:${relay.port}${route}`, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || `request failed: ${route}`);
    return json.result;
  };
  const setStores = (next) => { stores = next; };
  try {
    await fn({ api, setStores });
  } finally {
    await tab.close();
    await relay.stop();
  }
}

test('a golden diff that comes back dirty ranks in goldenDiffsStillFailing and topFrictionItems', async () => {
  await withRelay(async ({ api, setStores }) => {
    await api('POST', '/sessions', { goal: 'golden diff dirty test', context: 'analytics-golden-diff-still-failing.test.mjs', briefing: false });
    const baseline = await api('POST', '/state/snapshot', { golden: 'orders-golden' });
    setStores({ orders: { keyPath: 'id', rows: [{ id: 1, status: 'open' }, { id: 2, status: 'open' }] } });
    const dirty = await api('POST', '/state/snapshot', {});
    const diff = await api('POST', '/state/diff', { golden: 'orders-golden', idB: dirty.id });
    assert.ok(Object.keys(diff.summary).length > 0, 'the extra row should make this diff non-clean');

    const a = await api('GET', '/analytics');
    const g = a.goldenDiffsStillFailing.find((x) => x.golden === 'orders-golden');
    assert.ok(g, 'a dirty golden diff should appear in goldenDiffsStillFailing');
    assert.equal(g.diffCount, 1);
    assert.match(a.topFrictionItems.map((x) => x.summary).join('\n'), /golden "orders-golden" diffed 1x, still dirty/);
    void baseline;
  });
});

test('a later clean diff against the same golden clears it from goldenDiffsStillFailing', async () => {
  await withRelay(async ({ api, setStores }) => {
    await api('POST', '/sessions', { goal: 'golden diff recovers test', context: 'analytics-golden-diff-still-failing.test.mjs', briefing: false });
    const baseline = await api('POST', '/state/snapshot', { golden: 'orders-golden' });
    setStores({ orders: { keyPath: 'id', rows: [{ id: 1, status: 'open' }, { id: 2, status: 'open' }] } });
    const dirty = await api('POST', '/state/snapshot', {});
    await api('POST', '/state/diff', { golden: 'orders-golden', idB: dirty.id });

    // A second diff-golden call whose content matches the golden baseline exactly (idB = the
    // baseline's own id) - guaranteed clean, standing in for "the regression got fixed".
    await api('POST', '/state/diff', { golden: 'orders-golden', idB: baseline.id });

    const a = await api('GET', '/analytics');
    assert.equal(a.goldenDiffsStillFailing.find((x) => x.golden === 'orders-golden'), undefined, 'the most recent diff-golden run is clean, so it should no longer be flagged');
  });
});

test('a golden never diffed at all does not appear', async () => {
  await withRelay(async ({ api }) => {
    await api('POST', '/sessions', { goal: 'no golden diffs at all', context: 'analytics-golden-diff-still-failing.test.mjs', briefing: false });
    const a = await api('GET', '/analytics');
    assert.deepEqual(a.goldenDiffsStillFailing, []);
  });
});
