// GET /analytics's known-issues cross-reference (relay.mjs computeAnalytics) - the
// operator-maintained known-issues.json registry (see relay.mjs's "Known-issues registry"
// section) previously only matched against live boot-console-errors during "crv preflight";
// this checks it now also matches against failed actions' own error text, annotating
// failureRateByType/topFailedSelectors/topFrictionItems with the already-diagnosed remediation
// instead of a known bug looking identical to a brand-new mystery. Real relay, real fake-agent
// tab, no browser. Each test gets its own relay + its own known-issues.json (a temp file, never
// the real per-checkout registry) so tests never share state.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startTestRelay, connectFakeAgent } from './test-relay.mjs';

async function withRelay(issues, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webscout-known-issues-analytics-'));
  const registryPath = path.join(dir, 'known-issues.json');
  fs.writeFileSync(registryPath, JSON.stringify(issues));
  const relay = await startTestRelay({ env: { WEBSCOUT_KNOWN_ISSUES: registryPath } });
  const tab = await connectFakeAgent(relay.port, {
    'dom.click': (params) => {
      if (params.selector === '#broken') throw new Error('Element not found: #broken (detached from DOM)');
      return { clicked: true, mutated: false };
    },
  });
  const api = async (method, route, body) => {
    const res = await fetch(`http://127.0.0.1:${relay.port}${route}`, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || `request failed: ${route}`);
    return json.result;
  };
  try {
    await fn({ api });
  } finally {
    await tab.close();
    await relay.stop();
  }
}

test('a failed action matching a known-issues signature carries knownIssues in failureRateByType, topFailedSelectors and topFrictionItems', async () => {
  await withRelay([{ id: 'flaky-broken-el', signature: 'detached from DOM', description: 'stale DOM reference after a rerender', remediation: 'use dom.click-wait instead of a bare click' }], async ({ api }) => {
    const id = (await api('POST', '/sessions', { goal: 'known-issue test', context: 'analytics-known-issues.test.mjs', briefing: false })).id;
    for (let i = 0; i < 2; i += 1) {
      try { await api('POST', '/command', { type: 'dom.click', params: { selector: '#broken' } }); } catch { /* expected failure */ }
    }
    await api('POST', `/sessions/${id}/end`);

    const a = await api('GET', '/analytics');
    const t = a.failureRateByType.find((x) => x.type === 'dom.click');
    assert.ok(t, 'dom.click should appear in failureRateByType');
    assert.equal(t.knownIssues?.[0]?.id, 'flaky-broken-el');
    assert.equal(t.knownIssues[0].remediation, 'use dom.click-wait instead of a bare click');

    const s = a.topFailedSelectors.find((x) => x.selector === '#broken');
    assert.ok(s, '#broken should appear in topFailedSelectors');
    assert.equal(s.knownIssues?.[0]?.id, 'flaky-broken-el');

    assert.match(a.topFrictionItems[0].summary, /known issue: flaky-broken-el/);
    assert.match(a.topFrictionItems[0].summary, /use dom.click-wait instead of a bare click/);
  });
});

test('a failure that matches no known-issue signature carries no knownIssues field', async () => {
  await withRelay([{ id: 'unrelated', signature: 'totally different error text', description: 'x', remediation: 'y' }], async ({ api }) => {
    const id = (await api('POST', '/sessions', { goal: 'no-match test', context: 'analytics-known-issues.test.mjs', briefing: false })).id;
    for (let i = 0; i < 2; i += 1) {
      try { await api('POST', '/command', { type: 'dom.click', params: { selector: '#broken' } }); } catch { /* expected failure */ }
    }
    await api('POST', `/sessions/${id}/end`);

    const a = await api('GET', '/analytics');
    const t = a.failureRateByType.find((x) => x.type === 'dom.click');
    assert.equal(t.knownIssues, undefined);
    const s = a.topFailedSelectors.find((x) => x.selector === '#broken');
    assert.equal(s.knownIssues, undefined);
  });
});

test('a missing known-issues.json (no file at all) leaves analytics working with no cross-refs', async () => {
  const relay = await startTestRelay({ env: { WEBSCOUT_KNOWN_ISSUES: path.join(os.tmpdir(), `webscout-nope-${Date.now()}.json`) } });
  const tab = await connectFakeAgent(relay.port, {
    'dom.click': (params) => { if (params.selector === '#broken') throw new Error('boom'); return { clicked: true, mutated: false }; },
  });
  const api = async (method, route, body) => {
    const res = await fetch(`http://127.0.0.1:${relay.port}${route}`, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || `request failed: ${route}`);
    return json.result;
  };
  try {
    const id = (await api('POST', '/sessions', { goal: 'missing registry test', context: 'analytics-known-issues.test.mjs', briefing: false })).id;
    for (let i = 0; i < 2; i += 1) {
      try { await api('POST', '/command', { type: 'dom.click', params: { selector: '#broken' } }); } catch { /* expected failure */ }
    }
    await api('POST', `/sessions/${id}/end`);
    const a = await api('GET', '/analytics');
    const t = a.failureRateByType.find((x) => x.type === 'dom.click');
    assert.ok(t);
    assert.equal(t.knownIssues, undefined);
  } finally {
    await tab.close();
    await relay.stop();
  }
});
