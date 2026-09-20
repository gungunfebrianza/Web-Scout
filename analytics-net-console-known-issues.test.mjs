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
