// "friction analytics awareness" round: analytics used to be something an agent had to
// separately go read ("analytics" / GET /analytics) - these five pieces put the SAME data
// (topFailedSelectors, macrosNeverRun, known-issues.json, topFrictionItems) in front of the
// agent at the moment it matters, instead of only on request:
//   1. A failed /command's OWN error carries a matched known-issues.json remediation inline
//      (relay.mjs's matchKnownIssueForError, wired into dispatchTracked's catch).
//   2. A /command about to hit a selector that has repeatedly failed before gets a
//      x-webscout-selector-risk warning header BEFORE the risk repeats (maybeRiskySelectorWarn).
//   3. A session whose own recent action TYPES match a recorded-but-never-run macro gets a
//      x-webscout-macro-match nudge (maybeMacroMatchNudge).
//   4. Session end reports emergentFriction: a type/selector failing for the first time ever,
//      before it has accumulated enough history to rank in the global digest.
//   5. "crv preflight" carries knownFriction (the same topFrictionItems digest) so a pass can
//      front-load the riskiest known-bad selectors/types before starting.
// #2 and #3 are read from a per-session snapshot frozen at session start (see
// buildSessionFrictionSnapshot's own comment) specifically so they never touch - and never
// poison - the shared 5s analytics cache other callers (GET /analytics) rely on being fresh.
// Real relay, real fake-agent tab, no browser. Each test gets its own relay.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startTestRelay, connectFakeAgent } from './test-relay.mjs';

async function withRelay(fn, { handlers = {}, envOverride = {} } = {}) {
  const relay = await startTestRelay({ env: envOverride });
  const tab = await connectFakeAgent(relay.port, handlers);
  const apiRaw = async (method, route, body) => {
    const res = await fetch(`http://127.0.0.1:${relay.port}${route}`, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
    const json = await res.json();
    return { res, json };
  };
  const api = async (method, route, body) => {
    const { json } = await apiRaw(method, route, body);
    if (!json.ok) throw Object.assign(new Error(json.error || `request failed: ${route}`), { extra: json.extra });
    return json.result;
  };
  try {
    await fn({ api, apiRaw });
  } finally {
    await tab.close();
    await relay.stop();
  }
}

test('a failed /command carries a matched known-issues.json remediation inline (no separate analytics call needed)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webscout-friction-awareness-'));
  const registryPath = path.join(dir, 'known-issues.json');
  fs.writeFileSync(registryPath, JSON.stringify([{ id: 'flaky-broken-el', signature: 'detached from DOM', description: 'stale DOM reference after a rerender', remediation: 'use dom.click-wait instead of a bare click' }]));
  await withRelay(async ({ apiRaw }) => {
    await apiRaw('POST', '/sessions', { goal: 'inline known-issue test', context: 'friction-awareness.test.mjs', briefing: false });
    const { json } = await apiRaw('POST', '/command', { type: 'dom.click', params: { selector: '#broken' } });
    assert.equal(json.ok, false);
    assert.equal(json.extra?.knownIssue?.id, 'flaky-broken-el');
    assert.equal(json.extra.knownIssue.remediation, 'use dom.click-wait instead of a bare click');
  }, {
    handlers: { 'dom.click': (params) => { if (params.selector === '#broken') throw new Error('Element not found: #broken (detached from DOM)'); return { clicked: true }; } },
    envOverride: { WEBSCOUT_KNOWN_ISSUES: registryPath },
  });
});

test('a risky selector (3+ prior failures) gets an x-webscout-selector-risk warning BEFORE it fails again', async () => {
  await withRelay(async ({ apiRaw, api }) => {
    // Session A: fail the same selector 3x, then end - this is the history the snapshot below reads.
    const a = await api('POST', '/sessions', { goal: 'seed history', context: 'friction-awareness.test.mjs', briefing: false });
    for (let i = 0; i < 3; i += 1) {
      try { await api('POST', '/command', { type: 'dom.click', params: { selector: '#risky' } }); } catch { /* expected */ }
    }
    await api('POST', `/sessions/${a.id}/end`);

    // Session B: a FRESH session - its friction snapshot is built at session start, so it
    // should already know #risky is dangerous before this session ever touches it.
    await api('POST', '/sessions', { goal: 'consult history', context: 'friction-awareness.test.mjs', briefing: false });
    const { res } = await apiRaw('POST', '/command', { type: 'dom.click', params: { selector: '#risky' } });
    const warn = res.headers.get('x-webscout-selector-risk');
    assert.ok(warn, 'expected x-webscout-selector-risk header');
    assert.match(warn, /#risky/);
    assert.match(warn, /failed 3x before/);
  }, { handlers: { 'dom.click': () => { throw new Error('still broken'); } } });
});

test('a selector NOT yet at the risk threshold gets no warning header', async () => {
  await withRelay(async ({ apiRaw, api }) => {
    const a = await api('POST', '/sessions', { goal: 'seed history', context: 'friction-awareness.test.mjs', briefing: false });
    // Only 2 failures - below RISKY_SELECTOR_FAIL_THRESHOLD (3).
    for (let i = 0; i < 2; i += 1) {
      try { await api('POST', '/command', { type: 'dom.click', params: { selector: '#almost-risky' } }); } catch { /* expected */ }
    }
    await api('POST', `/sessions/${a.id}/end`);
    await api('POST', '/sessions', { goal: 'consult history', context: 'friction-awareness.test.mjs', briefing: false });
    const { res } = await apiRaw('POST', '/command', { type: 'dom.click', params: { selector: '#almost-risky' } });
    assert.equal(res.headers.get('x-webscout-selector-risk'), null);
  }, { handlers: { 'dom.click': () => { throw new Error('still broken'); } } });
});

test('a session whose own action types match a recorded-but-never-run macro gets an x-webscout-macro-match nudge', async () => {
  await withRelay(async ({ apiRaw, api }) => {
    // Session A: two dom.click actions, recorded as a macro, never replayed.
    const a = await api('POST', '/sessions', { goal: 'record macro', context: 'friction-awareness.test.mjs', briefing: false });
    await api('POST', '/command', { type: 'dom.click', params: { selector: '#one' } });
    await api('POST', '/command', { type: 'dom.click', params: { selector: '#two' } });
    await api('POST', `/sessions/${a.id}/end`);
    const macro = await api('POST', '/macros', { name: 'friction-awareness-macro', sessionId: a.id });
    assert.equal(macro.steps.length, 2);

    // Session B: a FRESH session repeats the same TYPE sequence (different selectors -
    // the match is on type only) - should get nudged once the sequence matches.
    await api('POST', '/sessions', { goal: 'repeat the shape', context: 'friction-awareness.test.mjs', briefing: false });
    const first = await apiRaw('POST', '/command', { type: 'dom.click', params: { selector: '#three' } });
    assert.equal(first.res.headers.get('x-webscout-macro-match'), null, 'not enough of the sequence yet');
    const second = await apiRaw('POST', '/command', { type: 'dom.click', params: { selector: '#four' } });
    const nudge = second.res.headers.get('x-webscout-macro-match');
    assert.ok(nudge, 'expected x-webscout-macro-match header once the type sequence matches');
    assert.match(nudge, /friction-awareness-macro/);
    assert.match(nudge, new RegExp(`macro run ${macro.id}`));
  }, { handlers: { 'dom.click': () => ({ clicked: true, mutated: false }) } });
});

test('session end reports emergentFriction for a type/selector failing for the first time ever', async () => {
  await withRelay(async ({ api }) => {
    const s = await api('POST', '/sessions', { goal: 'first ever failure', context: 'friction-awareness.test.mjs', briefing: false });
    try { await api('POST', '/command', { type: 'dom.fill', params: { selector: '#x', value: 'y' } }); } catch { /* expected */ }
    try { await api('POST', '/command', { type: 'dom.click', params: { selector: '#repeat-offender' } }); } catch { /* expected */ }
    try { await api('POST', '/command', { type: 'dom.click', params: { selector: '#repeat-offender' } }); } catch { /* expected */ }
    const ended = await api('POST', `/sessions/${s.id}/end`);
    assert.ok(ended.emergentFriction?.length >= 2, `expected at least 2 emergent friction lines, got: ${JSON.stringify(ended.emergentFriction)}`);
    assert.ok(ended.emergentFriction.some((l) => l.includes('"dom.fill"') && l.includes('first session ever')));
    assert.ok(ended.emergentFriction.some((l) => l.includes('#repeat-offender') && l.includes('first session ever')));
  }, { handlers: {
    'dom.fill': () => { throw new Error('fill boom'); },
    'dom.click': () => { throw new Error('click boom'); },
  } });
});

test('session end reports no emergentFriction for a clean session', async () => {
  await withRelay(async ({ api }) => {
    const s = await api('POST', '/sessions', { goal: 'clean session', context: 'friction-awareness.test.mjs', briefing: false });
    await api('POST', '/command', { type: 'dom.click', params: { selector: '#fine' } });
    const ended = await api('POST', `/sessions/${s.id}/end`);
    assert.equal(ended.emergentFriction, undefined);
  }, { handlers: { 'dom.click': () => ({ clicked: true, mutated: false }) } });
});

test('a session report carries the same known-issues.json match a live failure already showed, not just a bare error string', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webscout-friction-awareness-report-'));
  const registryPath = path.join(dir, 'known-issues.json');
  fs.writeFileSync(registryPath, JSON.stringify([{ id: 'report-flaky-el', signature: 'detached from DOM', description: 'stale DOM reference', remediation: 'use dom.click-wait instead' }]));
  await withRelay(async ({ apiRaw, api }) => {
    const s = await api('POST', '/sessions', { goal: 'report known-issue test', context: 'friction-awareness.test.mjs', briefing: false });
    try { await api('POST', '/command', { type: 'dom.click', params: { selector: '#broken' } }); } catch { /* expected */ }
    await api('POST', `/sessions/${s.id}/end`);
    const { json } = await apiRaw('GET', `/sessions/${s.id}/report?format=json`);
    const bundle = JSON.parse(json.result.content);
    assert.equal(bundle.knownIssues.length, 1);
    assert.equal(bundle.knownIssues[0].knownIssue.id, 'report-flaky-el');
    assert.equal(bundle.knownIssues[0].type, 'dom.click');

    const { json: mdJson } = await apiRaw('GET', `/sessions/${s.id}/report?format=md`);
    assert.match(mdJson.result.content, /## Known issues matched/);
    assert.match(mdJson.result.content, /report-flaky-el/);
  }, {
    handlers: { 'dom.click': (params) => { if (params.selector === '#broken') throw new Error('Element not found: #broken (detached from DOM)'); return { clicked: true }; } },
    envOverride: { WEBSCOUT_KNOWN_ISSUES: registryPath },
  });
});

test('a macro recorded mid-session is immediately nudge-eligible for that same session, not just future ones', async () => {
  await withRelay(async ({ apiRaw, api }) => {
    const s = await api('POST', '/sessions', { goal: 'mid-session macro record', context: 'friction-awareness.test.mjs', briefing: false });
    await api('POST', '/command', { type: 'dom.click', params: { selector: '#one' } });
    await api('POST', '/command', { type: 'dom.click', params: { selector: '#two' } });
    const macro = await api('POST', '/macros', { name: 'mid-session-macro', sessionId: s.id });
    assert.equal(macro.steps.length, 2);

    // SAME still-active session, one more action of the matching type - previously impossible
    // to nudge for at all (sessionFrictionSnapshot froze before this macro existed), so this
    // session would never have been nudged for its own just-recorded macro. The macro's own
    // two recording actions already count as the tail of the match (maybeMacroMatchNudge reads
    // the session's whole action history, not only actions after the macro existed), so the
    // very next action of a matching type fires it.
    const res = await apiRaw('POST', '/command', { type: 'dom.click', params: { selector: '#three' } });
    const nudge = res.res.headers.get('x-webscout-macro-match');
    assert.ok(nudge, 'expected x-webscout-macro-match within the SAME session that just recorded the macro');
    assert.match(nudge, /mid-session-macro/);
  }, { handlers: { 'dom.click': () => ({ clicked: true, mutated: false }) } });
});

test('a malformed known-issues.json is reported as a check error, not silently treated as "no match"', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webscout-friction-awareness-badregistry-'));
  const registryPath = path.join(dir, 'known-issues.json');
  fs.writeFileSync(registryPath, '{ not valid json');
  await withRelay(async ({ apiRaw }) => {
    await apiRaw('POST', '/sessions', { goal: 'bad registry test', context: 'friction-awareness.test.mjs', briefing: false });
    const { json } = await apiRaw('POST', '/command', { type: 'dom.click', params: { selector: '#broken' } });
    assert.equal(json.ok, false);
    assert.equal(json.extra?.knownIssue, undefined);
    assert.match(json.extra?.knownIssuesCheckError ?? '', /not valid JSON/);
  }, {
    handlers: { 'dom.click': () => { throw new Error('boom'); } },
    envOverride: { WEBSCOUT_KNOWN_ISSUES: registryPath },
  });
});

test('crv preflight carries knownFriction, the same ranked topFrictionItems digest as GET /analytics', async () => {
  await withRelay(async ({ api }) => {
    const s = await api('POST', '/sessions', { goal: 'seed friction', context: 'friction-awareness.test.mjs', briefing: false });
    for (let i = 0; i < 3; i += 1) {
      try { await api('POST', '/command', { type: 'dom.click', params: { selector: '#preflight-risk' } }); } catch { /* expected */ }
    }
    await api('POST', `/sessions/${s.id}/end`);

    const analytics = await api('GET', '/analytics');
    const preflight = await api('POST', '/crv/preflight', {});
    assert.ok(Array.isArray(preflight.knownFriction));
    assert.ok(preflight.knownFriction.length > 0);
    assert.deepEqual(preflight.knownFriction, analytics.topFrictionItems);
  }, { handlers: { 'dom.click': () => { throw new Error('still broken'); } } });
});
