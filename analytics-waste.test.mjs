// GET /analytics's wasteBySession (relay.mjs computeAnalytics, round-2 addition) - reuses
// buildWaste (session-viz.mjs) grouped from the SAME listAllActions() rows every other Friction
// Analytics metric already scans, no extra query. Real relay, real fake-agent tab, no browser.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestRelay, connectFakeAgent } from './test-relay.mjs';

let relay;
let tab;
const api = async (method, route, body) => {
  const res = await fetch(`http://127.0.0.1:${relay.port}${route}`, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json();
  if (!json.ok) throw new Error(json.error || `request failed: ${route}`);
  return json.result;
};
const command = (type, params) => api('POST', '/command', { type, params });

before(async () => {
  relay = await startTestRelay();
  tab = await connectFakeAgent(relay.port, {
    // idb.dump (unlike dom.click/fill/wait) has no autoScreenshot-on-failure (see command-registry.mjs) -
    // a failure here logs exactly one action, so the wasted-call arithmetic below is exact.
    'idb.dump': (p) => { if (p.store === 'missing') throw new Error('no such store: missing'); return { rows: [{ id: 1 }] }; },
  });
});
after(async () => { tab?.close(); await relay.stop(); });

test('a session with several never-retried failures ranks above a mostly-clean one, and a tiny session is excluded', async () => {
  const wasteful = (await api('POST', '/sessions', { goal: 'wasteful', context: 'analytics-waste.test.mjs' })).id;
  for (let i = 0; i < 6; i += 1) await command('idb.dump', { store: 'missing' }).catch(() => {}); // 6 calls, all fail, none retried -> 100% wasted
  await api('POST', `/sessions/${wasteful}/end`);

  const clean = (await api('POST', '/sessions', { goal: 'clean', context: 'analytics-waste.test.mjs' })).id;
  for (let i = 0; i < 6; i += 1) await command('idb.dump', { store: `s${i}` }); // 6 distinct reads, nothing wasted
  await api('POST', `/sessions/${clean}/end`);

  const tiny = (await api('POST', '/sessions', { goal: 'tiny', context: 'analytics-waste.test.mjs' })).id;
  await command('idb.dump', { store: 'missing' }).catch(() => {}); // 1 call, under the min-calls floor
  await api('POST', `/sessions/${tiny}/end`);

  const a = await api('GET', '/analytics');
  const byId = new Map(a.wasteBySession.map((r) => [r.sessionId, r]));
  assert.equal(byId.get(wasteful).wastePct, 1);
  assert.equal(byId.get(wasteful).wastedCalls, 6);
  assert.equal(byId.get(clean).wastePct, 0);
  assert.ok(!byId.has(tiny), 'a session under the 5-call floor should not appear');
  // Ranked worst-first.
  const idx = a.wasteBySession.map((r) => r.sessionId);
  assert.ok(idx.indexOf(wasteful) < idx.indexOf(clean));
});
