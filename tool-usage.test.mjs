// GET /token-report's neverCalled: a real usage count (not a guess) for which dispatchable
// actions this relay has NEVER logged a call for - the evidence a future round would need before
// trimming the MCP tool list (see docs/web-scout-roadmap.md, V33's lesson list, item 6).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestRelay, connectFakeAgent } from './test-relay.mjs';
import { COMMAND_TYPES } from './command-registry.mjs';

const relay = await startTestRelay();
const BASE = `http://127.0.0.1:${relay.port}`;
const skip = relay.live ? 'skipped under WEBSCOUT_TEST_LIVE=1' : false;
let tab;

async function api(method, route, body) {
  const res = await fetch(`${BASE}${route}`, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  return (await res.json()).result;
}

before(async () => {
  if (relay.live) return;
  tab = await connectFakeAgent(relay.port, { 'idb.dump': (p) => ({ store: p.store, rows: [] }) }, { name: 'usage-tab', epoch: 0 });
  await api('POST', '/sessions', { goal: 'tool-usage.test.mjs', context: 'automated', briefing: false, agent: 'usage-tab' });
});
after(async () => { tab?.close(); await relay.stop(); });

test('ping and page.epoch are never flagged - they are internal, not a real MCP action', { skip }, async () => {
  const report = await api('GET', '/token-report');
  assert.ok(!report.neverCalled.types.includes('ping'));
  assert.ok(!report.neverCalled.types.includes('page.epoch'));
});

test('a small sample says so, so "never" is not trusted too early', { skip }, async () => {
  const report = await api('GET', '/token-report');
  if (report.totalCalls < 50) assert.match(report.neverCalled.note, /too small a sample/);
});

test('a type just called drops off the never-called list', { skip }, async () => {
  const before = await api('GET', '/token-report');
  assert.ok(before.neverCalled.types.includes('idb.dump'), 'not called yet in this fresh relay');
  await api('POST', '/command', { type: 'idb.dump', params: { store: 'x' }, agent: 'usage-tab' });
  const after = await api('GET', '/token-report');
  assert.ok(!after.neverCalled.types.includes('idb.dump'));
  assert.equal(after.neverCalled.sampleSizeCalls, before.neverCalled.sampleSizeCalls + 1);
});

test('every listed type is real (from command-registry.mjs) and never ping/page.epoch', { skip }, async () => {
  const report = await api('GET', '/token-report');
  for (const t of report.neverCalled.types) assert.ok(COMMAND_TYPES[t], `${t} is not a real registered type`);
  assert.deepEqual(report.neverCalled.types, [...report.neverCalled.types].sort(), 'sorted, so a diff between two reports is readable');
});
