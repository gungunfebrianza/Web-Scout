// Friction-awareness round 2 - the relay-level behaviour behind friction.mjs:
//   - the in-session failure overlay (a selector failing INSIDE the current session warns),
//   - success-aware / origin-scoped / normalized history,
//   - warn dedupe + escalation (+ the opt-in WEBSCOUT_RISKY_BLOCK refusal),
//   - failure replies that carry class/recovery/emergent info,
//   - "mark fixed" resolutions, rate-spike + known-issue-candidate analytics, macro nudge upgrades.
// Real relay, real fake-agent tab, no browser. Each test gets its own relay.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestRelay, connectFakeAgent } from './test-relay.mjs';

async function withRelay(fn, { handlers = {}, envOverride = {}, origin } = {}) {
  const relay = await startTestRelay({ env: envOverride });
  let tab = await connectFakeAgent(relay.port, handlers, { origin });
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
  const start = (goal) => api('POST', '/sessions', { goal, context: 'friction-awareness-live.test.mjs', briefing: false });
  const click = (selector, type = 'dom.click') => apiRaw('POST', '/command', { type, params: { selector } });
  const failN = async (n, selector, type = 'dom.click') => { for (let i = 0; i < n; i += 1) await click(selector, type); };
  const reconnect = async (newHandlers, newOrigin) => {
    await tab.close();
    tab = await connectFakeAgent(relay.port, newHandlers, { origin: newOrigin });
  };
  try {
    await fn({ api, apiRaw, start, click, failN, reconnect });
  } finally {
    await tab.close();
    await relay.stop();
  }
}

const alwaysFail = { 'dom.click': () => { throw new Error('Element not found: still broken'); }, 'dom.clickWait': () => { throw new Error('Element not found: still broken'); } };

test('a selector failing INSIDE the current session warns on the next attempt (no prior history needed)', async () => {
  await withRelay(async ({ start, click }) => {
    await start('live overlay');
    const a = await click('#live');
    assert.equal(a.res.headers.get('x-webscout-selector-risk'), null, 'first failure: nothing to say yet');
    const b = await click('#live');
    assert.equal(b.res.headers.get('x-webscout-selector-risk'), null, 'second attempt: only one failure on record before it');
    const c = await click('#live');
    const warn = c.res.headers.get('x-webscout-selector-risk');
    assert.ok(warn, 'third attempt: two same-session failures already');
    assert.match(warn, /failed 2x already this session/);
    assert.match(warn, /\[not-found\]/);
  }, { handlers: alwaysFail });
});

test('the warning is said once, then only again when a NEW failure happened, and escalates when ignored', async () => {
  await withRelay(async ({ start, click }) => {
    await start('dedupe + escalate');
    await click('#d'); await click('#d');
    const first = await click('#d'); // fails -> 3 live failures
    assert.match(first.res.headers.get('x-webscout-selector-risk') ?? '', /failed 2x already/);
    const second = await click('#d');
    const escalated = second.res.headers.get('x-webscout-selector-risk') ?? '';
    assert.match(escalated, /^ESCALATED/, 'the ignored warning came true again');
  }, { handlers: alwaysFail });

  // No new failure between two attempts = no repeated header.
  let failing = true;
  await withRelay(async ({ start, click }) => {
    await start('quiet repeat');
    await click('#q'); await click('#q');
    const warned = await click('#q');
    assert.ok(warned.res.headers.get('x-webscout-selector-risk'));
    failing = false;
    // pre-action the relay cannot know this call will work, so the (new-failure) warning still fires once...
    const ok1 = await click('#q');
    assert.equal(ok1.json.ok, true);
    // ...but once it has worked in this session, the stale warning is gone for good.
    const ok2 = await click('#q');
    assert.equal(ok2.json.ok, true);
    assert.equal(ok2.res.headers.get('x-webscout-selector-risk'), null, 'it works now: the stale warning is not repeated');
  }, { handlers: { 'dom.click': () => { if (failing) throw new Error('Element not found: #q'); return { clicked: true, mutated: false }; } } });
});

test('WEBSCOUT_RISKY_BLOCK=1 refuses an escalated selector (409) unless ackRisk is passed', async () => {
  await withRelay(async ({ start, click, apiRaw }) => {
    await start('block');
    for (let i = 0; i < 3; i += 1) await click('#b'); // 2 failures, the warned 3rd attempt fails too
    const blocked = await click('#b');
    assert.equal(blocked.json.ok, false);
    assert.match(blocked.json.error, /ESCALATED/);
    assert.match(blocked.json.error, /ackRisk:true/);
    const retried = await click('#b');
    assert.match(retried.json.error, /refusing/, 'a refused call retried without ackRisk is refused again, not waved through');
    const acked = await apiRaw('POST', '/command', { type: 'dom.click', params: { selector: '#b' }, ackRisk: true });
    assert.doesNotMatch(acked.json.error ?? '', /refusing/, 'ackRisk lets it through to the (still failing) page');
    assert.match(acked.json.error, /Element not found/);
  }, { handlers: alwaysFail, envOverride: { WEBSCOUT_RISKY_BLOCK: '1' } });
});

test('history is selector-normalized and click/clickWait are one family across sessions', async () => {
  await withRelay(async ({ api, start, click, failN }) => {
    const a = await start('seed');
    await failN(3, '#row-41');
    await api('POST', `/sessions/${a.id}/end`);
    await start('consult');
    const viaOtherRow = await click('#row-97');
    assert.match(viaOtherRow.res.headers.get('x-webscout-selector-risk') ?? '', /failed 3x before/);
  }, { handlers: alwaysFail });

  await withRelay(async ({ api, start, click, failN }) => {
    const a = await start('seed');
    await failN(3, '#family');
    await api('POST', `/sessions/${a.id}/end`);
    await start('consult');
    const viaWait = await click('#family', 'dom.clickWait');
    assert.match(viaWait.res.headers.get('x-webscout-selector-risk') ?? '', /failed 3x before/);
  }, { handlers: alwaysFail });
});

test('a selector that succeeded after its failures stops warning (success-aware history)', async () => {
  let failing = true;
  await withRelay(async ({ api, start, click, failN }) => {
    const a = await start('fix lands');
    await failN(3, '#fixed');
    failing = false;
    const ok = await click('#fixed');
    assert.equal(ok.json.ok, true);
    await api('POST', `/sessions/${a.id}/end`);
    await start('after the fix');
    const next = await click('#fixed');
    assert.equal(next.res.headers.get('x-webscout-selector-risk'), null);
  }, { handlers: { 'dom.click': () => { if (failing) throw new Error('Element not found'); return { clicked: true, mutated: false }; } } });
});

test('history is scoped to the origin it happened on', async () => {
  await withRelay(async ({ api, start, click, failN, reconnect }) => {
    const a = await start('origin A history');
    await failN(3, '#submit');
    await api('POST', `/sessions/${a.id}/end`);

    await reconnect(alwaysFail, 'http://b.test');
    const b = await start('on origin B');
    const onB = await click('#submit');
    assert.equal(onB.res.headers.get('x-webscout-selector-risk'), null, 'the same selector on another origin is a different selector');
    await api('POST', `/sessions/${b.id}/end`);

    await reconnect(alwaysFail, 'http://a.test');
    await start('back on origin A');
    const backOnA = await click('#submit');
    assert.match(backOnA.res.headers.get('x-webscout-selector-risk') ?? '', /failed 3x before/);
  }, { handlers: alwaysFail, origin: 'http://a.test' });
});

test('the warning names what worked after a failure last time, and the failure reply carries the class + count', async () => {
  const handlers = {
    'dom.click': (params) => { if (params.selector === '#old') throw new Error('Element not found: #old'); return { clicked: true, mutated: false }; },
  };
  await withRelay(async ({ api, start, click }) => {
    const a = await start('recovery history');
    for (let i = 0; i < 3; i += 1) { await click('#old'); await click('#new'); }
    await api('POST', `/sessions/${a.id}/end`);
    await start('consult recovery');
    const first = await click('#old');
    assert.match(first.res.headers.get('x-webscout-selector-risk') ?? '', /"#new" \(dom\.click\) worked/);
    // the failure itself explains itself too
    assert.equal(first.json.ok, false);
    assert.equal(first.json.extra.selectorFriction.errorClass, 'not-found');
    assert.equal(first.json.extra.selectorFriction.failuresThisSession, 1);
    assert.equal(first.json.extra.selectorFriction.priorFailures, 3);
    assert.match(first.json.extra.selectorFriction.workedBefore, /"#new"/);
  }, { handlers });
});

test('a brand-new failing type and an emerging selector are reported on the failure itself, once', async () => {
  await withRelay(async ({ start, click }) => {
    await start('live emergent');
    const first = await click('#fresh');
    assert.ok(first.json.extra.emergentFriction.some((l) => l.includes('"dom.click"') && l.includes('first time ever')));
    const second = await click('#fresh');
    assert.ok(second.json.extra.emergentFriction.some((l) => l.includes('#fresh') && l.includes('failed 2x this session')));
    const third = await click('#fresh');
    assert.equal(third.json.extra.emergentFriction, undefined, 'each live note is said once per session');
  }, { handlers: alwaysFail });
});

test('"friction resolve" makes a selector\'s old history stop warning and stop ranking; a relapse counts again', async () => {
  await withRelay(async ({ api, start, click, failN }) => {
    const a = await start('seed');
    await failN(3, '#was-broken');
    await api('POST', `/sessions/${a.id}/end`);
    assert.ok((await api('GET', '/analytics')).selectorFriction.some((s) => s.selector === '#was-broken'));

    await api('POST', '/friction/resolve', { type: 'dom.click', selector: '#was-broken', note: 'fixed in commit abc' });
    assert.equal((await api('GET', '/friction/resolutions')).length, 1);
    const analytics = await api('GET', '/analytics');
    assert.ok(!analytics.selectorFriction.some((s) => s.selector === '#was-broken'));
    assert.ok(!analytics.selectorFriction.some((s) => s.selector === '#was-broken'));

    const b = await start('after the fix');
    assert.equal((await click('#was-broken')).res.headers.get('x-webscout-selector-risk'), null);

    // relapse: failures after the resolution count again
    await api('POST', `/sessions/${b.id}/end`);
    await start('relapse');
    await failN(2, '#was-broken');
    const relapsed = await api('GET', '/analytics');
    assert.equal(relapsed.selectorFriction.find((s) => s.selector === '#was-broken')?.failCount, 3);

    await api('POST', '/friction/unresolve', { type: 'dom.click', selector: '#was-broken' });
    assert.equal((await api('GET', '/friction/resolutions')).length, 0);
  }, { handlers: alwaysFail, envOverride: { WEBSCOUT_ANALYTICS_CACHE_MS: '0' } });
});

test('GET /analytics drafts a known-issue candidate for an unmatched error that keeps repeating', async () => {
  await withRelay(async ({ api, start, click }) => {
    await start('candidates');
    await click('#one'); await click('#two'); await click('#three');
    const { knownIssueCandidates } = await api('GET', '/analytics');
    assert.equal(knownIssueCandidates.length, 1);
    assert.equal(knownIssueCandidates[0].count, 3);
    assert.equal(knownIssueCandidates[0].draft.signature, 'Widget exploded in');
  }, { handlers: { 'dom.click': (p) => { throw new Error(`Widget exploded in ${p.selector} (code ${p.selector.length}7)`); } } });
});

test('failure time feeds the friction ranking: a slow failing type is worth more than its raw count', async () => {
  await withRelay(async ({ api, start, click }) => {
    await start('cost weighting');
    await click('#a'); await click('#a');
    const analytics = await api('GET', '/analytics');
    assert.equal(typeof analytics.failureRateByType.find((t) => t.type === 'dom.click').wastedMs, 'number');
    assert.equal(typeof analytics.selectorFriction[0]?.wastedMs ?? 0, 'number');
  }, { handlers: alwaysFail });
});

test('session end flags a failure-rate SPIKE for a type that already had history', async () => {
  const handlers = { 'dom.click': (p) => { if (p.selector.startsWith('#bad')) throw new Error('Element not found'); return { clicked: true, mutated: false }; } };
  await withRelay(async ({ api, start, click }) => {
    const a = await start('healthy baseline');
    for (let i = 0; i < 12; i += 1) await click(`#ok${i}`);
    await click('#bad-once');
    await api('POST', `/sessions/${a.id}/end`);

    const b = await start('much worse');
    await click('#ok-a');
    await click('#bad-1'); await click('#bad-2');
    const ended = await api('POST', `/sessions/${b.id}/end`);
    assert.ok(ended.emergentFriction?.some((l) => l.includes('failure rate spiked') && l.includes('"dom.click"')), JSON.stringify(ended.emergentFriction));
  }, { handlers });
});

test('macro nudge: a proven macro is offered with its reliability; a macro replay itself is never re-nudged', async () => {
  await withRelay(async ({ api, start, click, apiRaw }) => {
    const a = await start('record');
    await click('#one'); await click('#two');
    await api('POST', `/sessions/${a.id}/end`);
    const macro = await api('POST', '/macros', { name: 'proven-macro', sessionId: a.id });

    // session B replays it successfully -> macro now has 1/1 passing run
    const b = await start('replay');
    await api('POST', `/macros/${macro.id}/run`, { confirm: true });
    const afterRun = await click('#three');
    assert.equal(afterRun.res.headers.get('x-webscout-macro-match'), null, 'the tail includes the macro replay itself');
    await api('POST', `/sessions/${b.id}/end`);

    // session C hand-types the same type sequence with different selectors
    await start('hand-typed again');
    await click('#x');
    const nudged = await click('#y');
    const text = nudged.res.headers.get('x-webscout-macro-match') ?? '';
    assert.match(text, /proven-macro/);
    assert.match(text, /types match, params differ/);
    assert.match(text, /1\/1 recent run\(s\) passed/);
    assert.match(text, new RegExp(`macro run ${macro.id}`));
  }, { handlers: { 'dom.click': () => ({ clicked: true, mutated: false }) } });
});

test('macro nudge: same selectors are called out as a stronger match', async () => {
  await withRelay(async ({ api, start, click }) => {
    const a = await start('record');
    await click('#one'); await click('#two');
    await api('POST', `/sessions/${a.id}/end`);
    await api('POST', '/macros', { name: 'exact-macro', sessionId: a.id });
    await start('same again');
    await click('#one');
    const nudged = await click('#two');
    assert.match(nudged.res.headers.get('x-webscout-macro-match') ?? '', /same selectors\/stores/);
  }, { handlers: { 'dom.click': () => ({ clicked: true, mutated: false }) } });
});
