// GET /analytics's macroAdoption (relay.mjs computeAnalytics) - the mid-session nudge (see
// maybeMidSessionNudge) fires past the CLI's stderr but leaves no trace once a session ends;
// this reads the same underlying actions/macros rows to say whether the nudge is actually being
// acted on, and POST /sessions surfaces its `note` again at the one moment a NEW session could
// still do something about it. Real relay, real fake-agent tab, no browser.
//
// Each test gets its OWN relay (not a shared before/after): GET /analytics is served from a
// 5-second server-side cache (ANALYTICS_CACHE_MS) shared by every caller of that one relay
// process, so two tests sharing a relay within that window would read each other's cached
// snapshot instead of their own fresh state.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestRelay, connectFakeAgent } from './test-relay.mjs';

async function withRelay(fn) {
  const relay = await startTestRelay();
  const tab = await connectFakeAgent(relay.port, { 'dom.click': () => ({ clicked: true, mutated: false }) });
  const api = async (method, route, body) => {
    const res = await fetch(`http://127.0.0.1:${relay.port}${route}`, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || `request failed: ${route}`);
    return json.result;
  };
  const command = (type, params) => api('POST', '/command', { type, params });
  // >=5 ok dom.click calls in one session crosses maybeMidSessionNudge's own eligibility threshold.
  const runNudgeEligibleSession = async (goal) => {
    const id = (await api('POST', '/sessions', { goal, context: 'analytics-macro-adoption.test.mjs', briefing: false })).id;
    for (let i = 0; i < 5; i += 1) await command('dom.click', { selector: `#btn${i}` });
    await api('POST', `/sessions/${id}/end`);
    return id;
  };
  try {
    await fn({ api, command, runNudgeEligibleSession });
  } finally {
    await tab.close();
    await relay.stop();
  }
}

test('3+ nudge-eligible sessions with zero macros ever recorded produce a macroAdoption note naming them', async () => {
  await withRelay(async ({ api, runNudgeEligibleSession }) => {
    const ids = [await runNudgeEligibleSession('one'), await runNudgeEligibleSession('two'), await runNudgeEligibleSession('three')];

    const a = await api('GET', '/analytics');
    assert.equal(a.macroAdoption.macrosEverRecorded, 0);
    assert.ok(a.macroAdoption.nudgeEligibleSessionCount >= 3);
    assert.ok(a.macroAdoption.note, 'note should be present once the threshold is crossed with no macros recorded');
    assert.match(a.macroAdoption.note, /consider recording a macro/);
    const eligibleIds = a.macroAdoption.recentEligibleSessions.map((s) => s.sessionId);
    for (const id of ids) assert.ok(eligibleIds.includes(id), `session ${id} should be listed as nudge-eligible`);
  });
});

test('a session below the threshold never counts as nudge-eligible', async () => {
  await withRelay(async ({ api, command }) => {
    const id = (await api('POST', '/sessions', { goal: 'small', context: 'analytics-macro-adoption.test.mjs', briefing: false })).id;
    await api('POST', '/command', { type: 'dom.click', params: { selector: '#a' } });
    await api('POST', `/sessions/${id}/end`);

    const a = await api('GET', '/analytics');
    assert.equal(a.macroAdoption.nudgeEligibleSessionCount, 0);
    assert.equal(a.macroAdoption.note, undefined);
  });
});

test('recording a macro suppresses the note, including on the next session start', async () => {
  await withRelay(async ({ api, runNudgeEligibleSession }) => {
    await runNudgeEligibleSession('one');
    await runNudgeEligibleSession('two');
    const sourceId = await runNudgeEligibleSession('macro-source');

    const beforeMacro = await api('POST', '/sessions', { goal: 'before-macro-recorded', context: 'analytics-macro-adoption.test.mjs', briefing: false });
    await api('POST', `/sessions/${beforeMacro.id}/end`);
    assert.ok(beforeMacro.macroAdoptionNote, 'session start should carry the note once 3+ sessions are eligible with no macro recorded');

    await api('POST', '/macros', { name: `adoption-test-${Date.now()}`, sessionId: sourceId });

    const afterMacro = await api('POST', '/sessions', { goal: 'after-macro-recorded', context: 'analytics-macro-adoption.test.mjs', briefing: false });
    await api('POST', `/sessions/${afterMacro.id}/end`);
    assert.equal(afterMacro.macroAdoptionNote, undefined, 'session start must not carry the note once a macro exists');

    const a = await api('GET', '/analytics');
    assert.ok(a.macroAdoption.macrosEverRecorded >= 1);
    assert.equal(a.macroAdoption.note, undefined, 'once a macro exists, the "never recorded one" note must not fire');
  });
});
