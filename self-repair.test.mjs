// Self-repair loop (self-repair.mjs + relay.mjs's /repair/* routes + session-viz.mjs's recorded
// edges) - real relay process, real HTTP, a fake in-page agent (see test-relay.mjs), no browser.
// Config/scope are isolated to a throwaway temp dir per run so this never touches the real
// examples/self-repair-demo files.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestRelay, connectFakeAgent } from './test-relay.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webscout-repair-test-'));
const scopeDir = path.join(tempDir, 'scope');
fs.mkdirSync(scopeDir);
const fixturePath = path.join(scopeDir, 'fixture.js');
const FIXTURE_ORIGINAL = "const x = 1;\nfor (let i = 0; i < keys.length - 1; i++) {\n  store.delete(keys[i]);\n}\n";
fs.writeFileSync(fixturePath, FIXTURE_ORIGINAL, 'utf8');
const configPath = path.join(tempDir, 'self-repair-config.json');
fs.writeFileSync(configPath, JSON.stringify({ enabled: false, scopeDir, history: [] }, null, 2), 'utf8');

const relay = await startTestRelay({ env: { WEBSCOUT_REPAIR_CONFIG_PATH: configPath } });
const BASE = `http://127.0.0.1:${relay.port}`;
let agent;
let sessionId;
// Mutable stand-in for the demo app's `entries` store - the fake agent's
// handlers read/write this directly instead of running real IndexedDB.
let rows = [];
let clearAllFixed = false; // toggled per-test to simulate "before patch" vs "after patch" behavior

async function api(method, urlPath, body) {
  const res = await fetch(`${BASE}${urlPath}`, {
    method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  return { json, status: res.status };
}

before(async () => {
  if (relay.live) return;
  agent = await connectFakeAgent(relay.port, {
    'idb.snapshot': () => ({ stores: { entries: { keyPath: 'id', rows: [...rows] } } }),
    'dom.click': () => {
      // Simulates the demo's planted off-by-one bug: leaves one row behind
      // unless clearAllFixed is set (the test's stand-in for "the patch
      // landed and the page was reloaded").
      rows = clearAllFixed ? [] : rows.slice(-1);
      return {};
    },
  });
  const started = await api('POST', '/sessions', { goal: 'self-repair.test.mjs', context: 'automated', tags: ['self-repair'] });
  sessionId = started.json.result.id;
});

after(async () => {
  agent?.close();
  await relay.stop();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const skipLive = relay.live ? 'skipped under WEBSCOUT_TEST_LIVE=1 (a fake agent would replace the real tab)' : false;

test('repair status: disabled by default, fail-closed', { skip: skipLive }, async () => {
  const { json } = await api('GET', '/repair/config');
  assert.equal(json.result.enabled, false);
  assert.equal(json.result.scopeDir, scopeDir);
});

// self-repair.mjs resolves `file` against tools/web-scout (self-repair.mjs's own directory) - the
// real-world default scopeDir ("examples/self-repair-demo") is itself a relative subpath of that,
// so a caller passes a repo-relative path in real usage. This test's scopeDir is an isolated
// ABSOLUTE temp dir instead (never touches the real examples/ files), so `file` here is the
// fixture's own absolute path - path.resolve(anyBase, anAbsolutePath) returns it unchanged either way.

test('repair patch refuses while disabled', { skip: skipLive }, async () => {
  const { json, status } = await api('POST', '/repair/patch', { file: fixturePath, find: 'const x = 1;', replace: 'const x = 2;' });
  assert.equal(status, 400);
  assert.match(json.error, /disabled/);
  assert.equal(fs.readFileSync(fixturePath, 'utf8'), FIXTURE_ORIGINAL, 'file must be untouched');
});

test('repair enable flips the server-side flag and is logged', { skip: skipLive }, async () => {
  const { json } = await api('PUT', '/repair/config', { enabled: true, by: 'test-suite' });
  assert.equal(json.result.enabled, true);
  const status = await api('GET', '/repair/config');
  assert.equal(status.json.result.enabled, true);
  assert.ok(status.json.result.history.length >= 1);
  assert.equal(status.json.result.history[0].by, 'test-suite');
});

test('repair patch refuses a path outside the configured scope', { skip: skipLive }, async () => {
  const outside = path.join(__dirname, 'relay.mjs'); // a real file, but outside scopeDir
  const { json, status } = await api('POST', '/repair/patch', { file: outside, find: 'x', replace: 'y' });
  assert.equal(status, 400);
  assert.match(json.error, /outside the configured scope/);
});

test('repair patch refuses a missing match', { skip: skipLive }, async () => {
  const { json, status } = await api('POST', '/repair/patch', { file: fixturePath, find: 'nope not here', replace: 'y' });
  assert.equal(status, 400);
  assert.match(json.error, /not found/);
});

test('repair patch refuses an ambiguous (2+) match', { skip: skipLive }, async () => {
  // "keys" appears twice in the fixture (keys.length, keys[i]) - both real occurrences, not
  // overlapping with the exactly-one-match test below (which patches "const x = 1;" instead).
  const { json, status } = await api('POST', '/repair/patch', { file: fixturePath, find: 'keys', replace: 'KEYS' });
  assert.equal(status, 400);
  assert.match(json.error, /matches 2 places/);
});

let patchActionId;
test('repair patch succeeds on exactly-one match, logs a real action, writes the file', { skip: skipLive }, async () => {
  const before = await api('POST', '/repair/patch', { file: fixturePath, find: 'const x = 1;', replace: 'const x = 999;' });
  assert.equal(before.status, 200);
  assert.equal(typeof before.json.result.actionId, 'number');
  assert.notEqual(before.json.result.beforeHash, before.json.result.afterHash);
  assert.match(fs.readFileSync(fixturePath, 'utf8'), /const x = 999;/);
  patchActionId = before.json.result.actionId;
});

test('repair verify: a failing confirm is a normal result (pass:false), not a thrown error', { skip: skipLive }, async () => {
  rows = [{ id: 1 }, { id: 2 }, { id: 3 }];
  clearAllFixed = false; // still buggy
  const { json, status } = await api('POST', '/repair/verify', {
    stores: ['entries'], type: 'dom.click', params: { selector: '#clearAllBtn' }, expect: 'entries:-3', patchActionId,
  });
  assert.equal(status, 200);
  assert.equal(json.result.pass, false);
});

test('repair verify: a passing confirm returns pass:true and RECORDS a confirmed_by edge', { skip: skipLive }, async () => {
  rows = [{ id: 1 }, { id: 2 }, { id: 3 }];
  clearAllFixed = true; // "patch landed"
  const { json, status } = await api('POST', '/repair/verify', {
    stores: ['entries'], type: 'dom.click', params: { selector: '#clearAllBtn' }, expect: 'entries:-3', patchActionId,
  });
  assert.equal(status, 200);
  assert.equal(json.result.pass, true);
  assert.equal(typeof json.result.verifyActionId, 'number');

  await api('POST', `/sessions/${sessionId}/end`);
  const diff = await api('GET', `/repair/causal-diff?a=${sessionId}&b=${sessionId}`);
  assert.equal(diff.status, 200);
  const confirmed = diff.json.result.recorded.a.find((e) => e.kind === 'confirmed_by');
  assert.ok(confirmed, 'expected a confirmed_by recorded edge');
  assert.equal(confirmed.from, patchActionId);
});

test('repair verify refuses while disabled', { skip: skipLive }, async () => {
  await api('PUT', '/repair/config', { enabled: false, by: 'test-suite' });
  const { json, status } = await api('POST', '/repair/verify', { stores: ['entries'], type: 'dom.click', params: {}, expect: 'entries:-1' });
  assert.equal(status, 403);
  assert.match(json.error, /disabled/);
});

test('token-report (all-time) bySession includes this session, with its tags', { skip: skipLive }, async () => {
  const { json } = await api('GET', '/token-report');
  const row = json.result.bySession.find((r) => r.sessionId === sessionId);
  assert.ok(row, 'expected the test session in bySession');
  assert.deepEqual(row.tags, ['self-repair']);
});
