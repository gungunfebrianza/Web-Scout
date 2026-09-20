// Round-8 gap: matchKnownIssuesFor (relay.mjs computeAnalytics) previously only ever ran
// against actions.error (a dom/idb/eval dispatch failure logged through dispatchTracked).
// net_entries/console_entries are captured passively - batched straight from the page over the
// agent WebSocket (see inject.js's flushQueue, relay.mjs's `kind: 'event'` handler) - and never
// contributed to a failure ranking or the known-issues cross-reference, so a repeating HTTP 500
// or console.error was invisible in analytics even though "net log --failed" already tags each
// request pass/fail. This checks computeAnalytics's new topFailedNetUrls/topFailedConsoleMessages
// (see analytics-known-issues.test.mjs, the same pattern for actions). Real relay, a raw
// WebSocket standing in for a page's event batch (no browser needed - the wire shape is just
// {kind:'event', type:'net'|'console', entries:[...]}, the same envelope inject.js sends).
//
// Round 9 (below) closes two more: per-entry knownIssue decoration on the "net history"/
// "console history" routes (previously only the cross-session aggregate carried a match), and
// emergentFrictionForSession reaching net_entries/console_entries the same way it already
// reached dom/idb/eval action failures.
//
// Round 10 closes a gap round 9 itself introduced: decorateEntriesWithKnownIssue was applied
// to the live "net history"/"console history" routes above but not to gatherReportBundle
// (relay.mjs, backing "session report") - the ONE other place a session's raw net/console rows
// are read back, so a saved/exported report still showed a bare failed request/console error
// with no known-issue trace.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startTestRelay } from './test-relay.mjs';

async function withRelay(issues, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webscout-net-console-known-issues-'));
  const registryPath = path.join(dir, 'known-issues.json');
  fs.writeFileSync(registryPath, JSON.stringify(issues));
  const relay = await startTestRelay({ env: { WEBSCOUT_KNOWN_ISSUES: registryPath } });
  const api = async (method, route, body) => {
    const res = await fetch(`http://127.0.0.1:${relay.port}${route}`, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || `request failed: ${route}`);
    return json.result;
  };
  // A bare event-source connection: never receives a command, only pushes net/console batches -
  // the relay persists them off session.id + the socket's own agent name, nothing else.
  const ws = new WebSocket(`ws://127.0.0.1:${relay.port}/agent?name=events`);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('event socket could not connect')); });
  const sendEvent = (type, entries) => ws.send(JSON.stringify({ kind: 'event', type, entries }));
  try {
    await fn({ api, sendEvent });
  } finally {
    ws.close();
    await relay.stop();
  }
}

async function waitUntil(check, { timeoutMs = 3000, stepMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('waitUntil timed out');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

test('a repeating HTTP failure matching a known-issues signature ranks in topFailedNetUrls and topFrictionItems', async () => {
  await withRelay([{ id: 'flaky-save-endpoint', signature: 'HTTP 500', description: 'save endpoint flakes under load', remediation: 'retry once after 500ms' }], async ({ api, sendEvent }) => {
    const id = (await api('POST', '/sessions', { goal: 'net known-issue test', context: 'analytics-net-console-known-issues.test.mjs', briefing: false })).id;
    const now = new Date().toISOString();
    sendEvent('net', [
      { via: 'fetch', method: 'POST', url: 'https://api.example.com/save', status: 500, error: null, startedAt: now, endedAt: now },
      { via: 'fetch', method: 'POST', url: 'https://api.example.com/save', status: 500, error: null, startedAt: now, endedAt: now },
    ]);
    await waitUntil(async () => (await api('GET', `/sessions/${id}/net`)).length >= 2);

    const a = await api('GET', '/analytics');
    const n = a.topFailedNetUrls.find((x) => x.url === 'https://api.example.com/save');
    assert.ok(n, 'the repeating failed URL should appear in topFailedNetUrls');
    assert.equal(n.failCount, 2);
    assert.equal(n.knownIssues?.[0]?.id, 'flaky-save-endpoint');
    assert.match(a.topFrictionItems.map((x) => x.summary).join('\n'), /flaky-save-endpoint/);
  });
});

test('a repeating console error matching a known-issues signature ranks in topFailedConsoleMessages and topFrictionItems', async () => {
  await withRelay([{ id: 'unhandled-null-deref', signature: 'Cannot read properties of undefined', description: 'a render races store hydration', remediation: 'guard with the loading flag' }], async ({ api, sendEvent }) => {
    const id = (await api('POST', '/sessions', { goal: 'console known-issue test', context: 'analytics-net-console-known-issues.test.mjs', briefing: false })).id;
    const now = new Date().toISOString();
    sendEvent('console', [
      { level: 'error', message: "TypeError: Cannot read properties of undefined (reading 'id')", stack: null, at: now },
      { level: 'error', message: "TypeError: Cannot read properties of undefined (reading 'id')", stack: null, at: now },
    ]);
    await waitUntil(async () => (await api('GET', `/sessions/${id}/console`)).length >= 2);

    const a = await api('GET', '/analytics');
    const c = a.topFailedConsoleMessages.find((x) => x.message.includes('Cannot read properties of undefined'));
    assert.ok(c, 'the repeating console error should appear in topFailedConsoleMessages');
    assert.equal(c.failCount, 2);
    assert.equal(c.knownIssues?.[0]?.id, 'unhandled-null-deref');
    assert.match(a.topFrictionItems.map((x) => x.summary).join('\n'), /unhandled-null-deref/);
  });
});

test('a one-off net failure and a warn-level console entry are not ranked (no repeat, or not an error level)', async () => {
  await withRelay([], async ({ api, sendEvent }) => {
    const id = (await api('POST', '/sessions', { goal: 'no-repeat test', context: 'analytics-net-console-known-issues.test.mjs', briefing: false })).id;
    const now = new Date().toISOString();
    sendEvent('net', [{ via: 'fetch', method: 'GET', url: 'https://api.example.com/once', status: 500, error: null, startedAt: now, endedAt: now }]);
    sendEvent('console', [{ level: 'warn', message: 'deprecation warning, not a failure', stack: null, at: now }]);
    await waitUntil(async () => (await api('GET', `/sessions/${id}/net`)).length >= 1);

    const a = await api('GET', '/analytics');
    assert.equal(a.topFailedNetUrls.find((x) => x.url === 'https://api.example.com/once'), undefined);
    assert.equal(a.topFailedConsoleMessages.find((x) => x.message.includes('deprecation warning')), undefined);
  });
});

// Round-9 gap: the aggregate (topFailedNetUrls/topFailedConsoleMessages above) carried
// knownIssues since round 8, but GET /sessions/:id/net and GET /sessions/:id/console - what
// "net history"/"console history" actually return - handed back raw entries with no match of
// their own, so reading a session's own net/console history required a separate /analytics
// round trip to learn a failure was already a known bug. Checks the new per-entry decoration
// (decorateEntriesWithKnownIssue, relay.mjs).
test('"net history" and "console history" carry a per-entry knownIssue when the registry matches', async () => {
  await withRelay([
    { id: 'flaky-save-endpoint', signature: 'HTTP 500', description: 'save endpoint flakes under load', remediation: 'retry once after 500ms' },
    { id: 'unhandled-null-deref', signature: 'Cannot read properties of undefined', description: 'a render races store hydration', remediation: 'guard with the loading flag' },
  ], async ({ api, sendEvent }) => {
    const id = (await api('POST', '/sessions', { goal: 'per-entry known-issue test', context: 'analytics-net-console-known-issues.test.mjs', briefing: false })).id;
    const now = new Date().toISOString();
    sendEvent('net', [{ via: 'fetch', method: 'POST', url: 'https://api.example.com/save', status: 500, error: null, startedAt: now, endedAt: now }]);
    sendEvent('console', [{ level: 'error', message: "TypeError: Cannot read properties of undefined (reading 'id')", stack: null, at: now }]);

    const netEntries = await waitUntil(async () => { const rows = await api('GET', `/sessions/${id}/net`); return rows.length >= 1 ? rows : null; });
    assert.equal(netEntries[0].knownIssue?.id, 'flaky-save-endpoint');

    const consoleEntries = await waitUntil(async () => { const rows = await api('GET', `/sessions/${id}/console`); return rows.length >= 1 ? rows : null; });
    assert.equal(consoleEntries[0].knownIssue?.id, 'unhandled-null-deref');
  });
});

test('a net/console entry with no matching signature carries no knownIssue field', async () => {
  await withRelay([{ id: 'flaky-save-endpoint', signature: 'HTTP 500', description: 'unrelated', remediation: 'n/a' }], async ({ api, sendEvent }) => {
    const id = (await api('POST', '/sessions', { goal: 'no-match test', context: 'analytics-net-console-known-issues.test.mjs', briefing: false })).id;
    const now = new Date().toISOString();
    sendEvent('net', [{ via: 'fetch', method: 'GET', url: 'https://api.example.com/ok', status: 200, error: null, startedAt: now, endedAt: now }]);
    // console_entries.level has a CHECK constraint (db.mjs) of error/warn/uncaught/
    // unhandledrejection only - 'warn' here, not 'log', which is not a legal value at all.
    sendEvent('console', [{ level: 'warn', message: 'ordinary warning, not a known failure', stack: null, at: now }]);

    const netEntries = await waitUntil(async () => { const rows = await api('GET', `/sessions/${id}/net`); return rows.length >= 1 ? rows : null; });
    assert.equal('knownIssue' in netEntries[0], false);

    const consoleEntries = await waitUntil(async () => { const rows = await api('GET', `/sessions/${id}/console`); return rows.length >= 1 ? rows : null; });
    assert.equal('knownIssue' in consoleEntries[0], false);
  });
});

// Round-9 gap: emergentFrictionForSession (relay.mjs) only ever scanned dbApi.listActions -
// the dom/idb/eval command-dispatch table - so a session's first-ever repeated network failure
// or console error never set the "session end" emergentFriction flag, even though it is exactly
// the "first session to see this fail" moment that flag exists to surface for every other type.
test('"session end" flags emergentFriction for a session\'s first-ever repeating net/console failure', async () => {
  await withRelay([], async ({ api, sendEvent }) => {
    const id = (await api('POST', '/sessions', { goal: 'emergent net/console test', context: 'analytics-net-console-known-issues.test.mjs', briefing: false })).id;
    const now = new Date().toISOString();
    sendEvent('net', [
      { via: 'fetch', method: 'POST', url: 'https://api.example.com/brand-new-endpoint', status: 502, error: null, startedAt: now, endedAt: now },
      { via: 'fetch', method: 'POST', url: 'https://api.example.com/brand-new-endpoint', status: 502, error: null, startedAt: now, endedAt: now },
    ]);
    sendEvent('console', [
      { level: 'error', message: 'ReferenceError: brandNewThing is not defined', stack: null, at: now },
      { level: 'error', message: 'ReferenceError: brandNewThing is not defined', stack: null, at: now },
    ]);
    await waitUntil(async () => (await api('GET', `/sessions/${id}/net`)).length >= 2);
    await waitUntil(async () => (await api('GET', `/sessions/${id}/console`)).length >= 2);

    const ended = await api('POST', `/sessions/${id}/end`, {});
    assert.ok(ended.emergentFriction?.some((line) => line.includes('brand-new-endpoint')), `expected an emergent net line, got: ${JSON.stringify(ended.emergentFriction)}`);
    assert.ok(ended.emergentFriction?.some((line) => line.includes('brandNewThing is not defined')), `expected an emergent console line, got: ${JSON.stringify(ended.emergentFriction)}`);
  });
});

test('"session report" (JSON) carries the same per-entry knownIssue on its console/net rows as "net history"/"console history"', async () => {
  await withRelay([
    { id: 'flaky-save-endpoint', signature: 'HTTP 500', description: 'save endpoint flakes under load', remediation: 'retry once after 500ms' },
    { id: 'unhandled-null-deref', signature: 'Cannot read properties of undefined', description: 'a render races store hydration', remediation: 'guard with the loading flag' },
  ], async ({ api, sendEvent }) => {
    const id = (await api('POST', '/sessions', { goal: 'report bundle known-issue test', context: 'analytics-net-console-known-issues.test.mjs', briefing: false })).id;
    const now = new Date().toISOString();
    sendEvent('net', [{ via: 'fetch', method: 'POST', url: 'https://api.example.com/save', status: 500, error: null, startedAt: now, endedAt: now }]);
    sendEvent('console', [{ level: 'error', message: "TypeError: Cannot read properties of undefined (reading 'id')", stack: null, at: now }]);
    await waitUntil(async () => (await api('GET', `/sessions/${id}/net`)).length >= 1);
    await waitUntil(async () => (await api('GET', `/sessions/${id}/console`)).length >= 1);

    const report = await api('GET', `/sessions/${id}/report?format=json`);
    const bundle = JSON.parse(report.content);
    assert.equal(bundle.net[0].knownIssue?.id, 'flaky-save-endpoint');
    assert.equal(bundle.console[0].knownIssue?.id, 'unhandled-null-deref');
  });
});
