// "friction analytics awareness" round: analytics used to be something an agent had to
// separately go read ("analytics" / GET /analytics) - these five pieces put the SAME data
// (selectorFriction, macrosNeverRun, known-issues.json, topFrictionItems) in front of the
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
// #2 reads the indexed per-target history and #3 the macro candidates on demand (macroCandidates()),
// each through its own short-lived path, so neither poisons the shared analytics cache other
// callers (GET /analytics) rely on being fresh.
// Real relay, real fake-agent tab, no browser. Each test gets its own relay.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpDir } from './scratch.mjs';
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
  const dir = tmpDir('webscout-friction-awareness-');
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

test('the risky-selector warning also carries a stable x-webscout-selector-risk-key (type::selector, no counts) for the client\'s cross-process warn-cache', async () => {
  await withRelay(async ({ apiRaw, api }) => {
    const a = await api('POST', '/sessions', { goal: 'seed history', context: 'friction-awareness.test.mjs', briefing: false });
    for (let i = 0; i < 3; i += 1) {
      try { await api('POST', '/command', { type: 'dom.click', params: { selector: '#risky' } }); } catch { /* expected */ }
    }
    await api('POST', `/sessions/${a.id}/end`);
    await api('POST', '/sessions', { goal: 'consult history', context: 'friction-awareness.test.mjs', briefing: false });
    const { res } = await apiRaw('POST', '/command', { type: 'dom.click', params: { selector: '#risky' } });
    assert.equal(res.headers.get('x-webscout-selector-risk-key'), 'dom.click::#risky');
  }, { handlers: { 'dom.click': () => { throw new Error('still broken'); } } });
});

test('dom.drag\'s DROP TARGET ("to") gets the same risky-selector warning a "selector" param already gets, before it fails again', async () => {
  await withRelay(async ({ apiRaw, api }) => {
    // Seed history: dom.drag failing 3x with #bad-target as the drop target (source varies -
    // the fault is the target, not the source).
    const a = await api('POST', '/sessions', { goal: 'seed drag-target history', context: 'friction-awareness.test.mjs', briefing: false });
    for (let i = 0; i < 3; i += 1) {
      try { await api('POST', '/command', { type: 'dom.drag', params: { selector: `#src${i}`, to: '#bad-target' } }); } catch { /* expected */ }
    }
    await api('POST', `/sessions/${a.id}/end`);

    await api('POST', '/sessions', { goal: 'consult drag-target history', context: 'friction-awareness.test.mjs', briefing: false });
    const { res } = await apiRaw('POST', '/command', { type: 'dom.drag', params: { selector: '#fresh-src', to: '#bad-target' } });
    const warn = res.headers.get('x-webscout-selector-risk');
    assert.ok(warn, 'expected x-webscout-selector-risk header for a risky drop target');
    assert.match(warn, /drop target "#bad-target"/);
    assert.match(warn, /failed 3x before/);
    assert.equal(res.headers.get('x-webscout-selector-risk-key'), 'dom.drag::#bad-target');
  }, { handlers: { 'dom.drag': () => { throw new Error('drop rejected'); } } });
});

test('session end reports emergentFriction for dom.drag\'s "to" repeating, same as a "selector" repeating', async () => {
  await withRelay(async ({ api }) => {
    const s = await api('POST', '/sessions', { goal: 'drag-target emergent friction', context: 'friction-awareness.test.mjs', briefing: false });
    try { await api('POST', '/command', { type: 'dom.drag', params: { selector: '#a', to: '#locked' } }); } catch { /* expected */ }
    try { await api('POST', '/command', { type: 'dom.drag', params: { selector: '#b', to: '#locked' } }); } catch { /* expected */ }
    const ended = await api('POST', `/sessions/${s.id}/end`);
    assert.ok(ended.emergentFriction?.some((l) => l.includes('#locked') && l.includes('first session ever')), `expected #locked to trip emergentFriction, got: ${JSON.stringify(ended.emergentFriction)}`);
  }, { handlers: { 'dom.drag': () => { throw new Error('drop rejected'); } } });
});

test('macro run\'s riskPreview flags a risky "to" drop target too, tagged with role "to"', async () => {
  let broken = false;
  await withRelay(async ({ api }) => {
    // Record the macro first (a macro only records successful steps), THEN let the drop target fail
    // repeatedly in a later session: a success after the failures would rightly silence the warning.
    const b = await api('POST', '/sessions', { goal: 'record macro', context: 'friction-awareness.test.mjs', briefing: false });
    await api('POST', '/command', { type: 'dom.drag', params: { selector: '#src', to: '#bad-target' } });
    const macro = await api('POST', '/macros', { name: 'drag-risk-preview-macro', sessionId: b.id });
    assert.equal(macro.steps.length, 1);
    await api('POST', `/sessions/${b.id}/end`);

    broken = true;
    const a = await api('POST', '/sessions', { goal: 'seed drag-target history', context: 'friction-awareness.test.mjs', briefing: false });
    for (let i = 0; i < 3; i += 1) {
      try { await api('POST', '/command', { type: 'dom.drag', params: { selector: `#src${i}`, to: '#bad-target' } }); } catch { /* expected */ }
    }
    await api('POST', `/sessions/${a.id}/end`);
    broken = false;

    await api('POST', '/sessions', { goal: 'record macro replay', context: 'friction-awareness.test.mjs', briefing: false });
    const run = await api('POST', `/macros/${macro.id}/run`, {});
    const drop = run.riskPreview.filter((p) => p.role === 'to');
    assert.equal(drop.length, 1);
    assert.equal(drop[0].selector, '#bad-target');
  }, { handlers: { 'dom.drag': () => { if (broken) throw new Error('drop rejected'); return { dragged: true, dropAccepted: true, mutated: true, hrefChanged: false }; } } });
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
  const dir = tmpDir('webscout-friction-awareness-report-');
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
    // to nudge for at all (the old per-session snapshot froze before this macro existed), so this
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
  const dir = tmpDir('webscout-friction-awareness-badregistry-');
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

// ---- round 6: macro replay, "crv run", and computeAnalytics's own known-issues load error ----
// were the one dispatch surface (macro replay) and the one dispatch route ("crv run") the round-4/5
// live-friction system never reached, plus the one known-issues.json reader (computeAnalytics
// itself) that still degraded silently instead of reporting knownIssuesCheckError like its two
// siblings (matchKnownIssues, matchKnownIssueForError).

test('macro replay carries the same risky-selector warning and knownIssue match POST /command already gets, per step - not just the CLI/single-command path', async () => {
  const dir = tmpDir('webscout-friction-awareness-macro-run-');
  const registryPath = path.join(dir, 'known-issues.json');
  fs.writeFileSync(registryPath, JSON.stringify([{ id: 'macro-flaky-el', signature: 'detached from DOM', description: 'stale DOM reference', remediation: 'use dom.click-wait instead' }]));
  let riskyBroken = false;
  let flakyCalled = false;
  await withRelay(async ({ api }) => {
    // Session B records the macro (one SUCCESSFUL click per selector - a macro only records successes).
    const b = await api('POST', '/sessions', { goal: 'record macro', context: 'friction-awareness.test.mjs', briefing: false });
    await api('POST', '/command', { type: 'dom.click', params: { selector: '#risky' } });
    await api('POST', '/command', { type: 'dom.click', params: { selector: '#flaky' } });
    const macro = await api('POST', '/macros', { name: 'macro-run-friction-test', sessionId: b.id });
    assert.equal(macro.steps.length, 2);
    await api('POST', `/sessions/${b.id}/end`);

    // Session A: #risky then fails 3x (failures AFTER the recorded success, so they are unresolved history).
    riskyBroken = true;
    const a = await api('POST', '/sessions', { goal: 'seed risky-selector history', context: 'friction-awareness.test.mjs', briefing: false });
    for (let i = 0; i < 3; i += 1) {
      try { await api('POST', '/command', { type: 'dom.click', params: { selector: '#risky' } }); } catch { /* expected */ }
    }
    await api('POST', `/sessions/${a.id}/end`);
    riskyBroken = false;

    // Replay in a fresh session: #risky succeeds again but the run says it was warned off history (the
    // warning is about the past, not the result that follows); #flaky fails this time and carries its knownIssue.
    await api('POST', '/sessions', { goal: 'record macro replay', context: 'friction-awareness.test.mjs', briefing: false });
    const run = await api('POST', `/macros/${macro.id}/run`, { full: true });
    assert.equal(run.results.length, 2);
    const [riskyStep, flakyStep] = run.results;
    assert.equal(riskyStep.ok, true);
    assert.ok(run.frictionWarnings?.length, 'expected a frictionWarnings entry for the #risky replay step');
    assert.equal(run.frictionWarnings[0].step, 1);
    assert.match(run.frictionWarnings[0].message, /#risky/);
    assert.match(run.frictionWarnings[0].message, /failed 3x/);
    assert.equal(flakyStep.ok, false);
    assert.equal(flakyStep.knownIssue?.id, 'macro-flaky-el');
    assert.match(flakyStep.knownIssue.remediation, /dom.click-wait/);
    assert.ok(flakyStep.selectorFriction, 'a failed step carries what friction awareness knows');

    // Default (compact) reply: the failed step keeps its knownIssue, the successful one drops its body.
    const compact = await api('POST', `/macros/${macro.id}/run`, {});
    assert.equal(compact.results[0].result, undefined);
    assert.equal(compact.results[1].ok, false);
    assert.equal(compact.results[1].knownIssue?.id, 'macro-flaky-el');
  }, {
    handlers: {
      'dom.click': (params) => {
        if (params.selector === '#risky') { if (riskyBroken) throw new Error('still broken'); return { clicked: true }; }
        if (params.selector === '#flaky') { if (!flakyCalled) { flakyCalled = true; return { clicked: true }; } throw new Error('Element not found: #flaky (detached from DOM)'); }
        return { clicked: true };
      },
    },
    envOverride: { WEBSCOUT_KNOWN_ISSUES: registryPath },
  });
});

test('macro run carries a riskPreview of every risky step, worst offender first, computed BEFORE any step runs', async () => {
  const broken = new Set();
  await withRelay(async ({ api }) => {
    // Record a 3-step macro (clean, then the two selectors that will go bad, deliberately out of
    // severity order) while everything still works - a macro only records successful steps.
    const b = await api('POST', '/sessions', { goal: 'record macro', context: 'friction-awareness.test.mjs', briefing: false });
    await api('POST', '/command', { type: 'dom.click', params: { selector: '#clean' } });
    await api('POST', '/command', { type: 'dom.click', params: { selector: '#risky' } });
    await api('POST', '/command', { type: 'dom.click', params: { selector: '#verybad' } });
    const macro = await api('POST', '/macros', { name: 'risk-preview-macro', sessionId: b.id });
    assert.equal(macro.steps.length, 3);
    await api('POST', `/sessions/${b.id}/end`);

    // Later: #verybad fails 5x, #risky 3x (both cross the threshold); #clean never fails.
    broken.add('#verybad'); broken.add('#risky');
    const a = await api('POST', '/sessions', { goal: 'seed risky-selector history', context: 'friction-awareness.test.mjs', briefing: false });
    for (let i = 0; i < 5; i += 1) {
      try { await api('POST', '/command', { type: 'dom.click', params: { selector: '#verybad' } }); } catch { /* expected */ }
    }
    for (let i = 0; i < 3; i += 1) {
      try { await api('POST', '/command', { type: 'dom.click', params: { selector: '#risky' } }); } catch { /* expected */ }
    }
    await api('POST', `/sessions/${a.id}/end`);
    broken.clear();

    await api('POST', '/sessions', { goal: 'record macro replay', context: 'friction-awareness.test.mjs', briefing: false });
    const run = await api('POST', `/macros/${macro.id}/run`, {});
    assert.ok(run.riskPreview, 'expected a riskPreview field');
    assert.equal(run.riskPreview.length, 2, 'only the two selectors over the fail threshold appear');
    // Riskiest first: #verybad (5 fails, step 2) before #risky (3 fails, step 1), even though
    // #risky runs first in the macro - this is a preview computed up front, not a step-order echo.
    assert.equal(run.riskPreview[0].selector, '#verybad');
    assert.equal(run.riskPreview[0].failCount, 5);
    assert.equal(run.riskPreview[0].stepIndex, 2);
    assert.equal(run.riskPreview[1].selector, '#risky');
    assert.equal(run.riskPreview[1].failCount, 3);
    assert.equal(run.riskPreview[1].stepIndex, 1);
  }, { handlers: { 'dom.click': (params) => { if (broken.has(params.selector)) throw new Error('still broken'); return { clicked: true }; } } });
});

test('macro run omits riskPreview entirely for a macro with no risky steps', async () => {
  await withRelay(async ({ api }) => {
    const s = await api('POST', '/sessions', { goal: 'record clean macro', context: 'friction-awareness.test.mjs', briefing: false });
    await api('POST', '/command', { type: 'dom.click', params: { selector: '#clean' } });
    const macro = await api('POST', '/macros', { name: 'clean-macro', sessionId: s.id });
    const run = await api('POST', `/macros/${macro.id}/run`, {});
    assert.equal(run.riskPreview, undefined);
  }, { handlers: { 'dom.click': () => ({ clicked: true }) } });
});

test('macro record suggests a non-risky alternative selector that dom.query evidence shows reaches the SAME element, and never rewrites the recorded step', async () => {
  let clicks = 0;
  await withRelay(async ({ api }) => {
    const a = await api('POST', '/sessions', { goal: 'seed risky-selector history', context: 'friction-awareness.test.mjs', briefing: false });
    for (let i = 0; i < 3; i += 1) {
      try { await api('POST', '/command', { type: 'dom.click', params: { selector: '.btn.primary > span' } }); } catch { /* expected */ }
    }
    await api('POST', `/sessions/${a.id}/end`);

    const b = await api('POST', '/sessions', { goal: 'record macro', context: 'friction-awareness.test.mjs', briefing: false });
    await api('POST', '/command', { type: 'dom.query', params: { selector: '.btn.primary > span' } });
    await api('POST', '/command', { type: 'dom.query', params: { selector: '#save-btn' } });
    await api('POST', '/command', { type: 'dom.query', params: { selector: '#unrelated' } });
    await api('POST', '/command', { type: 'dom.click', params: { selector: '.btn.primary > span' } });
    const macro = await api('POST', '/macros', { name: 'suggest-macro', sessionId: b.id });

    assert.equal(macro.steps.length, 1);
    assert.equal(macro.steps[0].params.selector, '.btn.primary > span', 'the recorded step is never auto-swapped');
    assert.equal(macro.selectorSuggestions.length, 1);
    const s = macro.selectorSuggestions[0];
    assert.equal(s.stepIndex, 0);
    assert.equal(s.selector, '.btn.primary > span');
    assert.equal(s.alternative, '#save-btn');
    assert.equal(s.element, 'BUTTON#save');
    assert.equal(s.failCount, 3);
    assert.match(s.evidence, /both returned BUTTON#save/);
  }, {
    handlers: {
      'dom.click': () => { clicks += 1; if (clicks <= 3) throw new Error('still broken'); return { clicked: true }; },
      'dom.query': (params) => (params.selector === '#unrelated' ? { found: true, tag: 'DIV', id: 'other' } : { found: true, tag: 'BUTTON', id: 'save' }),
    },
  });
});

test('macro record makes no suggestion without same-element evidence (a query with no id, or no query at all), even for a risky selector', async () => {
  let clicks = 0;
  await withRelay(async ({ api }) => {
    const a = await api('POST', '/sessions', { goal: 'seed risky-selector history', context: 'friction-awareness.test.mjs', briefing: false });
    for (let i = 0; i < 3; i += 1) {
      try { await api('POST', '/command', { type: 'dom.click', params: { selector: '.fragile' } }); } catch { /* expected */ }
    }
    await api('POST', `/sessions/${a.id}/end`);

    const b = await api('POST', '/sessions', { goal: 'record macro', context: 'friction-awareness.test.mjs', briefing: false });
    await api('POST', '/command', { type: 'dom.query', params: { selector: '.fragile' } });
    await api('POST', '/command', { type: 'dom.query', params: { selector: '.other-way' } });
    await api('POST', '/command', { type: 'dom.click', params: { selector: '.fragile' } });
    const macro = await api('POST', '/macros', { name: 'no-evidence-macro', sessionId: b.id });
    assert.equal(macro.steps.length, 1);
    assert.equal(macro.selectorSuggestions, undefined, 'id-less query results identify nothing - similar-looking is a guess, not evidence');
  }, {
    handlers: {
      'dom.click': () => { clicks += 1; if (clicks <= 3) throw new Error('still broken'); return { clicked: true }; },
      'dom.query': () => ({ found: true, tag: 'BUTTON', id: null }),
    },
  });
});

async function withTwoAgents(fn, { envOverride = {}, alphaHandlers = {}, betaHandlers = {} } = {}) {
  const relay = await startTestRelay({ env: envOverride });
  const alpha = await connectFakeAgent(relay.port, alphaHandlers, { name: 'alpha' });
  const beta = await connectFakeAgent(relay.port, betaHandlers, { name: 'beta' });
  const apiRaw = async (method, route, body) => {
    const res = await fetch(`http://127.0.0.1:${relay.port}${route}`, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
    return { res, json: await res.json() };
  };
  try {
    await fn({ apiRaw });
  } finally {
    await alpha.close();
    await beta.close();
    await relay.stop();
  }
}

test('a known-issue failure on one agent reaches the OTHER connected agent as a live x-webscout-friction-broadcast header, once, and never the failing agent itself', async () => {
  const dir = tmpDir('webscout-friction-broadcast-');
  const registryPath = path.join(dir, 'known-issues.json');
  fs.writeFileSync(registryPath, JSON.stringify([{ id: 'shared-flaky-el', signature: 'detached from DOM', remediation: 'use dom.click-wait' }]));
  await withTwoAgents(async ({ apiRaw }) => {
    await apiRaw('POST', '/sessions', { goal: 'friction broadcast', context: 'friction-awareness.test.mjs', briefing: false });
    const failed = await apiRaw('POST', '/command', { type: 'dom.click', params: { selector: '#shared' }, agent: 'alpha' });
    assert.equal(failed.json.ok, false);
    assert.equal(failed.res.headers.get('x-webscout-friction-broadcast'), null, 'the failing agent already has the failure in its own reply');

    const betaNext = await apiRaw('POST', '/command', { type: 'dom.query', params: { selector: '#other' }, agent: 'beta' });
    assert.equal(betaNext.json.ok, true, 'informational only - beta\'s own command is unaffected');
    const notice = betaNext.res.headers.get('x-webscout-friction-broadcast');
    assert.ok(notice, 'expected the broadcast header on beta\'s next reply');
    assert.match(notice, /agent "alpha" just failed dom\.click on "#shared"/);
    assert.match(notice, /shared-flaky-el/);
    assert.match(notice, /use dom\.click-wait/);

    const betaAgain = await apiRaw('POST', '/command', { type: 'dom.query', params: { selector: '#other' }, agent: 'beta' });
    assert.equal(betaAgain.res.headers.get('x-webscout-friction-broadcast'), null, 'drained after one delivery');
    const alphaNext = await apiRaw('POST', '/command', { type: 'dom.query', params: { selector: '#other' }, agent: 'alpha' });
    assert.equal(alphaNext.res.headers.get('x-webscout-friction-broadcast'), null);
  }, {
    envOverride: { WEBSCOUT_KNOWN_ISSUES: registryPath },
    alphaHandlers: { 'dom.click': () => { throw new Error('Element not found: #shared (detached from DOM)'); }, 'dom.query': () => ({ matches: [] }) },
    betaHandlers: { 'dom.query': () => ({ matches: [] }) },
  });
});

test('a selector crossing the 3-failure threshold in one session is broadcast exactly at the crossing, not before and not on every failure after', async () => {
  await withTwoAgents(async ({ apiRaw }) => {
    await apiRaw('POST', '/sessions', { goal: 'threshold broadcast', context: 'friction-awareness.test.mjs', briefing: false });
    const betaPoll = () => apiRaw('POST', '/command', { type: 'dom.query', params: { selector: '#other' }, agent: 'beta' });
    for (let i = 0; i < 2; i += 1) await apiRaw('POST', '/command', { type: 'dom.click', params: { selector: '#flaky' }, agent: 'alpha' });
    assert.equal((await betaPoll()).res.headers.get('x-webscout-friction-broadcast'), null, '2 failures is below the threshold and no known issue matched');
    await apiRaw('POST', '/command', { type: 'dom.click', params: { selector: '#flaky' }, agent: 'alpha' });
    const notice = (await betaPoll()).res.headers.get('x-webscout-friction-broadcast');
    assert.ok(notice, 'the 3rd failure crosses the threshold');
    assert.match(notice, /dom\.click on "#flaky" \(3x this session\)/);
    await apiRaw('POST', '/command', { type: 'dom.click', params: { selector: '#flaky' }, agent: 'alpha' });
    assert.equal((await betaPoll()).res.headers.get('x-webscout-friction-broadcast'), null, 'the 4th failure is past the crossing, not a new one');
  }, {
    alphaHandlers: { 'dom.click': () => { throw new Error('still broken'); } },
    betaHandlers: { 'dom.query': () => ({ matches: [] }) },
  });
});

test('a failure with only ONE agent connected queues nothing and does not error', async () => {
  const dir = tmpDir('webscout-friction-broadcast-solo-');
  const registryPath = path.join(dir, 'known-issues.json');
  fs.writeFileSync(registryPath, JSON.stringify([{ id: 'solo', signature: 'detached from DOM', remediation: 'x' }]));
  await withRelay(async ({ apiRaw }) => {
    await apiRaw('POST', '/sessions', { goal: 'solo', context: 'friction-awareness.test.mjs', briefing: false });
    const failed = await apiRaw('POST', '/command', { type: 'dom.click', params: { selector: '#a' } });
    assert.equal(failed.json.extra.knownIssue.id, 'solo');
    const next = await apiRaw('POST', '/command', { type: 'dom.query', params: { selector: '#a' } });
    assert.equal(next.res.headers.get('x-webscout-friction-broadcast'), null);
  }, {
    handlers: { 'dom.click': () => { throw new Error('Element not found (detached from DOM)'); }, 'dom.query': () => ({ matches: [] }) },
    envOverride: { WEBSCOUT_KNOWN_ISSUES: registryPath },
  });
});

test('autoRemediate re-dispatches a matched known issue\'s structured retry ONCE and reports it beside the still-failed original', async () => {
  const dir = tmpDir('webscout-friction-awareness-remediate-');
  const registryPath = path.join(dir, 'known-issues.json');
  fs.writeFileSync(registryPath, JSON.stringify([{
    id: 'flaky-primary-btn', signature: 'detached from DOM', description: 'primary button re-renders',
    remediation: { text: 'click the stable alternate control', retry: { type: 'dom.click', params: { selector: '#alt-btn' } } },
  }]));
  const clicked = [];
  await withRelay(async ({ apiRaw }) => {
    await apiRaw('POST', '/sessions', { goal: 'auto-remediate test', context: 'friction-awareness.test.mjs', briefing: false });
    const { json } = await apiRaw('POST', '/command', { type: 'dom.click', params: { selector: '#primary' }, autoRemediate: true });
    assert.equal(json.ok, false, 'the original failure is never rewritten as a success');
    assert.equal(json.extra.knownIssue.id, 'flaky-primary-btn');
    assert.equal(json.extra.knownIssue.remediation, 'click the stable alternate control', 'text form stays what every surface shows');
    assert.deepEqual(json.extra.knownIssue.retry, { type: 'dom.click', params: { selector: '#alt-btn' } });
    assert.equal(json.extra.remediationAttempt.ok, true);
    assert.equal(json.extra.remediationAttempt.knownIssueId, 'flaky-primary-btn');
    assert.deepEqual(clicked, ['#primary', '#alt-btn'], 'retried exactly once, against the alternate selector');
  }, {
    handlers: { 'dom.click': (params) => { clicked.push(params.selector); if (params.selector === '#primary') throw new Error('Element not found: #primary (detached from DOM)'); return { clicked: true }; } },
    envOverride: { WEBSCOUT_KNOWN_ISSUES: registryPath },
  });
});

test('without autoRemediate a structured-retry entry only surfaces the hint - nothing is re-dispatched', async () => {
  const dir = tmpDir('webscout-friction-awareness-noremediate-');
  const registryPath = path.join(dir, 'known-issues.json');
  fs.writeFileSync(registryPath, JSON.stringify([{ id: 'flaky-primary-btn', signature: 'detached from DOM', remediation: { text: 'use alt', retry: { type: 'dom.click', params: { selector: '#alt-btn' } } } }]));
  const clicked = [];
  await withRelay(async ({ apiRaw }) => {
    await apiRaw('POST', '/sessions', { goal: 'no auto-remediate test', context: 'friction-awareness.test.mjs', briefing: false });
    const { json } = await apiRaw('POST', '/command', { type: 'dom.click', params: { selector: '#primary' } });
    assert.equal(json.extra.knownIssue.remediation, 'use alt');
    assert.equal(json.extra.remediationAttempt, undefined);
    assert.deepEqual(clicked, ['#primary']);
  }, {
    handlers: { 'dom.click': (params) => { clicked.push(params.selector); throw new Error('Element not found: #primary (detached from DOM)'); } },
    envOverride: { WEBSCOUT_KNOWN_ISSUES: registryPath },
  });
});

test('autoRemediate on a text-only known issue falls back to exactly today\'s behavior (hint only, no retry attempted)', async () => {
  const dir = tmpDir('webscout-friction-awareness-textonly-');
  const registryPath = path.join(dir, 'known-issues.json');
  fs.writeFileSync(registryPath, JSON.stringify([{ id: 'text-only', signature: 'detached from DOM', remediation: 'use dom.click-wait instead' }]));
  const clicked = [];
  await withRelay(async ({ apiRaw }) => {
    await apiRaw('POST', '/sessions', { goal: 'text-only remediation test', context: 'friction-awareness.test.mjs', briefing: false });
    const { json } = await apiRaw('POST', '/command', { type: 'dom.click', params: { selector: '#primary' }, autoRemediate: true });
    assert.equal(json.extra.knownIssue.remediation, 'use dom.click-wait instead');
    assert.equal(json.extra.knownIssue.retry, undefined);
    assert.equal(json.extra.remediationAttempt, undefined);
    assert.deepEqual(clicked, ['#primary']);
  }, {
    handlers: { 'dom.click': (params) => { clicked.push(params.selector); throw new Error('Element not found: #primary (detached from DOM)'); } },
    envOverride: { WEBSCOUT_KNOWN_ISSUES: registryPath },
  });
});

test('a failing structured retry is reported as ok:false, and a malformed retry is dropped with a warning while keeping the text hint', async () => {
  const dir = tmpDir('webscout-friction-awareness-badretry-');
  const registryPath = path.join(dir, 'known-issues.json');
  fs.writeFileSync(registryPath, JSON.stringify([
    { id: 'retry-also-fails', signature: 'detached from DOM', remediation: { text: 'try alt', retry: { type: 'dom.click', params: { selector: '#alt-btn' } } } },
    { id: 'bad-retry', signature: 'other failure', remediation: { text: 'kept hint', retry: { type: 'idb.snapshot' } } },
  ]));
  await withRelay(async ({ apiRaw }) => {
    await apiRaw('POST', '/sessions', { goal: 'failing retry test', context: 'friction-awareness.test.mjs', briefing: false });
    const first = await apiRaw('POST', '/command', { type: 'dom.click', params: { selector: '#primary' }, autoRemediate: true });
    assert.equal(first.json.extra.remediationAttempt.ok, false);
    assert.match(first.json.extra.remediationAttempt.error, /alt also broken/);
    const second = await apiRaw('POST', '/command', { type: 'dom.fill', params: { selector: '#x', value: 'v' }, autoRemediate: true });
    assert.equal(second.json.extra.knownIssue.id, 'bad-retry');
    assert.equal(second.json.extra.knownIssue.remediation, 'kept hint');
    assert.equal(second.json.extra.knownIssue.retry, undefined, 'an idb.snapshot retry is refused, not dispatched');
    assert.equal(second.json.extra.remediationAttempt, undefined);
  }, {
    handlers: {
      'dom.click': (params) => { throw new Error(params.selector === '#alt-btn' ? 'alt also broken' : 'Element not found: #primary (detached from DOM)'); },
      'dom.fill': () => { throw new Error('other failure'); },
    },
    envOverride: { WEBSCOUT_KNOWN_ISSUES: registryPath },
  });
});

test('"crv run" gets the same pre-dispatch risky-selector warning and post-dispatch macro-match nudge POST /command already gets', async () => {
  await withRelay(async ({ apiRaw, api }) => {
    // Seed #risky as a risky selector across sessions.
    const a = await api('POST', '/sessions', { goal: 'seed risky-selector history', context: 'friction-awareness.test.mjs', briefing: false });
    for (let i = 0; i < 3; i += 1) {
      try { await api('POST', '/command', { type: 'dom.click', params: { selector: '#risky' } }); } catch { /* expected */ }
    }
    await api('POST', `/sessions/${a.id}/end`);

    // Record a never-run macro (2 dom.click steps) from a THIRD session, unrelated to the one
    // that will call "crv run" below.
    const seedMacro = await api('POST', '/sessions', { goal: 'seed macro', context: 'friction-awareness.test.mjs', briefing: false });
    await api('POST', '/command', { type: 'dom.click', params: { selector: '#one' } });
    await api('POST', '/command', { type: 'dom.click', params: { selector: '#two' } });
    await api('POST', `/sessions/${seedMacro.id}/end`);
    await api('POST', '/macros', { name: 'crv-run-friction-test-macro', sessionId: seedMacro.id });

    // Fresh session: its frozen snapshot already knows both facts above.
    await api('POST', '/sessions', { goal: 'crv run friction test', context: 'friction-awareness.test.mjs', briefing: false });
    const risk = await apiRaw('POST', '/crv/run', { stores: ['x'], type: 'dom.click', params: { selector: '#risky' } });
    assert.match(risk.res.headers.get('x-webscout-selector-risk') ?? '', /#risky/);

    // Two more dom.click calls (types only) via "crv run" itself complete the never-run macro's
    // own step-type sequence - the nudge must fire from THIS route too, not only /command.
    await api('POST', '/crv/run', { stores: ['x'], type: 'dom.click', params: { selector: '#three' } });
    const nudge = await apiRaw('POST', '/crv/run', { stores: ['x'], type: 'dom.click', params: { selector: '#four' } });
    assert.match(nudge.res.headers.get('x-webscout-macro-match') ?? '', /crv-run-friction-test-macro/);
  }, {
    handlers: {
      'idb.snapshot': () => ({ stores: {} }),
      'dom.click': (params) => { if (params.selector === '#risky') throw new Error('still broken'); return { clicked: true }; },
    },
  });
});

test('GET /analytics and crv preflight report knownIssuesCheckError (not a silent "no known issues") when known-issues.json is malformed', async () => {
  const dir = tmpDir('webscout-friction-awareness-analytics-badregistry-');
  const registryPath = path.join(dir, 'known-issues.json');
  fs.writeFileSync(registryPath, '{ not valid json');
  await withRelay(async ({ api }) => {
    const s = await api('POST', '/sessions', { goal: 'bad registry analytics test', context: 'friction-awareness.test.mjs', briefing: false });
    try { await api('POST', '/command', { type: 'dom.click', params: {} }); } catch { /* not relevant here */ }
    await api('POST', `/sessions/${s.id}/end`);

    const analytics = await api('GET', '/analytics');
    assert.match(analytics.knownIssuesCheckError ?? '', /not valid JSON/);

    await api('POST', '/sessions', { goal: 'bad registry preflight test', context: 'friction-awareness.test.mjs', briefing: false });
    const preflight = await api('POST', '/crv/preflight', {});
    assert.match(preflight.knownIssuesCheckError ?? '', /not valid JSON/);
  }, {
    handlers: { 'dom.click': () => ({ clicked: true }) },
    envOverride: { WEBSCOUT_KNOWN_ISSUES: registryPath },
  });
});
