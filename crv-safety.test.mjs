// V38 CRV-tooling safety checks, all found by this round's own real-browser CRV incident:
// an agent name silently served two different origins/IndexedDBs across one session with
// nothing detecting it for dozens of calls, and a mutating command was one accidental
// argument away from landing on a real/production tab. Covers relay.mjs's guardDispatchOrigin
// (origin-pin + non-local write guard), POST /crv/preflight, the "crv seed"/"crv cleanup"
// manifest convenience, and the "session already active" conflict message now naming who
// started it. See CONTRIBUTING.md: the top-level await must stay above every test() call.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestRelay, connectFakeAgent, spawnAsync } from './test-relay.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const relay = await startTestRelay();
const BASE = `http://127.0.0.1:${relay.port}`;
const skipLive = relay.live ? 'skipped under WEBSCOUT_TEST_LIVE=1' : false;

async function api(method, route, body) {
  const res = await fetch(`${BASE}${route}`, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json();
  return json.ok ? json.result : Object.assign(new Error(json.error), { status: res.status });
}

let tab;
const db = { widgets: [] };
const handlers = {
  'idb.list': () => ({ stores: Object.keys(db), counts: Object.fromEntries(Object.entries(db).map(([k, v]) => [k, v.length])) }),
  'idb.snapshot': (p) => ({ stores: Object.fromEntries((p.stores ?? Object.keys(db)).map((s) => [s, { keyPath: 'id', rows: structuredClone(db[s] ?? []) }])) }),
  'dom.query': ({ selector }) => (selector === '#present' ? { found: true } : { found: false }),
  'console.log': () => ({ count: 0, entries: [] }),
  'idb.put': (p) => { db[p.store] = [...(db[p.store] ?? []).filter((r) => r.id !== p.row.id), p.row]; return { stored: p.row }; },
  'idb.putMany': (p) => {
    const stored = p.rows.map((row, i) => { const r = { ...row, id: row.id ?? Date.now() + i }; db[p.store] = [...(db[p.store] ?? []), r]; return r; });
    return { store: p.store, keyPath: 'id', putCount: stored.length, failedCount: 0, rows: stored, failed: [] };
  },
  'idb.deleteMany': (p) => { db[p.store] = (db[p.store] ?? []).filter((r) => !p.keys.includes(r.id)); return { store: p.store, deletedKeys: p.keys, failedKeys: [] }; },
};

before(async () => {
  if (relay.live) return;
  tab = await connectFakeAgent(relay.port, handlers, { name: 'crv-safety-tab', epoch: 0, origin: 'http://127.0.0.1:9000' });
});
after(async () => { tab?.close(); await relay.stop(); });

test('a session pinned to one origin refuses a command once its agent reconnects from a different one', { skip: skipLive }, async () => {
  const session = await api('POST', '/sessions', { goal: 'origin-pin test', context: 'automated', agent: 'crv-safety-tab', briefing: false });
  assert.equal(session.pinned_origin, 'http://127.0.0.1:9000');
  // same command through the SAME origin still works
  const ok = await api('POST', '/command', { type: 'idb.list', params: {}, agent: 'crv-safety-tab' });
  assert.ok(ok.stores);
  // the tab "navigates" to a different origin - same agent name, new connection
  tab.close();
  tab = await connectFakeAgent(relay.port, handlers, { name: 'crv-safety-tab', epoch: 0, origin: 'http://localhost:9000' });
  const blocked = await api('POST', '/command', { type: 'idb.list', params: {}, agent: 'crv-safety-tab' });
  assert.equal(blocked.status, 409, JSON.stringify(blocked));
  assert.match(blocked.message, /pinned to http:\/\/127\.0\.0\.1:9000/);
  assert.match(blocked.message, /currently connected from http:\/\/localhost:9000/);
  await api('POST', `/sessions/${session.id}/end`, {});
});

test('a mutating command against a non-local origin is refused unless allow_remote', { skip: skipLive }, async () => {
  tab.close();
  tab = await connectFakeAgent(relay.port, handlers, { name: 'crv-safety-tab', epoch: 0, origin: 'https://example.com' });
  const session = await api('POST', '/sessions', { goal: 'remote-guard test', context: 'automated', agent: 'crv-safety-tab', briefing: false });
  assert.equal(session.pinned_origin, 'https://example.com');
  const read = await api('POST', '/command', { type: 'idb.list', params: {}, agent: 'crv-safety-tab' });
  assert.ok(read.stores, 'reads are never blocked by the non-local guard');
  const blocked = await api('POST', '/command', { type: 'idb.put', params: { store: 'widgets', row: { id: 1 } }, agent: 'crv-safety-tab' });
  assert.equal(blocked.status, 403, JSON.stringify(blocked));
  assert.match(blocked.message, /non-local origin/);
  await api('POST', `/sessions/${session.id}/end`, {});

  const allowed = await api('POST', '/sessions', { goal: 'remote-guard allowed', context: 'automated', agent: 'crv-safety-tab', briefing: false, allow_remote: true });
  const write = await api('POST', '/command', { type: 'idb.put', params: { store: 'widgets', row: { id: 2 } }, agent: 'crv-safety-tab' });
  assert.deepEqual(write.stored, { id: 2 });
  await api('POST', `/sessions/${allowed.id}/end`, {});
  tab.close();
  tab = await connectFakeAgent(relay.port, handlers, { name: 'crv-safety-tab', epoch: 0, origin: 'http://127.0.0.1:9000' });
});

test('crv preflight reports connectivity/origin/stores/selector without requiring a session', { skip: skipLive }, async () => {
  const report = await api('POST', '/crv/preflight', { agent: 'crv-safety-tab', stores: ['widgets', 'missing_store'], selector: '#present' });
  assert.equal(report.connected, true);
  assert.equal(report.origin, 'http://127.0.0.1:9000');
  assert.deepEqual(report.storesExist, { widgets: true, missing_store: false });
  assert.deepEqual(report.missingStores, ['missing_store']);
  assert.equal(report.selectorPresent, true);
  assert.equal(report.ok, false, 'a missing store keeps ok:false even though the rest is healthy');

  const noAgent = await api('POST', '/crv/preflight', { agent: 'nobody-connected' });
  assert.equal(noAgent.connected, false);
  assert.match(noAgent.reason, /no web-scout agent named/);
});

test('the "session already active" conflict names the blocking session\'s agent and age', { skip: skipLive }, async () => {
  const first = await api('POST', '/sessions', { goal: 'conflict test', context: 'automated', agent: 'crv-safety-tab', briefing: false });
  const blocked = await api('POST', '/sessions', { goal: 'second one', context: 'automated', agent: 'crv-safety-tab', briefing: false });
  assert.ok(blocked instanceof Error);
  assert.match(blocked.message, /agent 'crv-safety-tab'/);
  assert.match(blocked.message, /ago\)/);
  await api('POST', `/sessions/${first.id}/end`, {});
});

test('CLI: "crv seed" then "crv cleanup" round-trips a manifest and removes exactly what it wrote', { skip: skipLive }, async () => {
  const session = await api('POST', '/sessions', { goal: 'seed-cleanup test', context: 'automated', agent: 'crv-safety-tab', briefing: false });
  const manifest = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'webscout-crv-manifest-')), 'manifest.json');
  const before = db.widgets.length;

  const seed = await spawnAsync([
    path.join(dir, 'cli.mjs'), 'crv', 'seed', 'widgets', JSON.stringify([{ id: 900, tag: 'synthetic' }, { id: 901, tag: 'synthetic' }]),
    '--manifest', manifest, '--agent', 'crv-safety-tab',
  ], { env: relay.env, cwd: dir });
  assert.equal(seed.status, 0, seed.stderr);
  const seedOut = JSON.parse(seed.stdout);
  assert.equal(seedOut.putCount, 2);
  assert.deepEqual(seedOut.manifestIds.sort(), [900, 901]);
  assert.equal(db.widgets.length, before + 2);
  assert.deepEqual(JSON.parse(fs.readFileSync(manifest, 'utf8')), { entries: [{ store: 'widgets', ids: [900, 901] }] });

  const cleanup = await spawnAsync([path.join(dir, 'cli.mjs'), 'crv', 'cleanup', '--manifest', manifest, '--agent', 'crv-safety-tab'], { env: relay.env, cwd: dir });
  assert.equal(cleanup.status, 0, cleanup.stderr);
  const cleanupOut = JSON.parse(cleanup.stdout);
  assert.deepEqual(cleanupOut.cleaned[0].deletedKeys.sort(), [900, 901]);
  assert.equal(db.widgets.length, before, 'exactly the seeded rows were removed, nothing else');
  assert.equal(fs.existsSync(manifest), false, 'the manifest is cleared after a successful cleanup');

  const secondCleanup = await spawnAsync([path.join(dir, 'cli.mjs'), 'crv', 'cleanup', '--manifest', manifest, '--agent', 'crv-safety-tab'], { env: relay.env, cwd: dir });
  assert.equal(secondCleanup.status, 0);
  assert.match(JSON.parse(secondCleanup.stdout).note, /nothing to clean up/);
  await api('POST', `/sessions/${session.id}/end`, {});
});

test('CLI: "session cleanup --since-snapshot --agent" threads the agent through - it used to silently default to \'default\', which is not the tab this test connects as', { skip: skipLive }, async () => {
  const session = await api('POST', '/sessions', { goal: 'cleanup-agent test', context: 'automated', agent: 'crv-safety-tab', briefing: false });
  const baseline = await api('POST', '/state/snapshot', { agent: 'crv-safety-tab', stores: ['widgets'] });
  // Only the fake tab named 'crv-safety-tab' is connected in this file - a real
  // dry-run cleanup succeeding proves --agent actually reached relay.mjs's
  // /sessions/:id/cleanup, not the DEFAULT_AGENT ('default') it used to fall
  // back to silently.
  const r = await spawnAsync([path.join(dir, 'cli.mjs'), 'session', 'cleanup', String(session.id), '--since-snapshot', String(baseline.id), '--agent', 'crv-safety-tab'], { env: relay.env, cwd: dir });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.dryRun, true);
  assert.equal(out.baselineSnapshotId, baseline.id);

  const wrongAgent = await spawnAsync([path.join(dir, 'cli.mjs'), 'session', 'cleanup', String(session.id), '--since-snapshot', String(baseline.id), '--agent', 'nobody-connected'], { env: relay.env, cwd: dir });
  assert.equal(wrongAgent.status, 1);
  assert.match(wrongAgent.stderr, /no web-scout agent named 'nobody-connected' connected/);
  await api('POST', `/sessions/${session.id}/end`, {});
});
