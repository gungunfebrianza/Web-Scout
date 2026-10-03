// Unit tests for friction.mjs - pure functions on plain arrays, no relay, no DB.
// The relay-level behaviour (headers, snapshot, dedupe across real requests) lives in
// friction-awareness.test.mjs and friction-awareness-live.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSelector, typeFamily, frictionKey, classifyError, buildSelectorFriction, historyForOrigin,
  createFrictionTracker, assessSelectorRisk, failureContext, findRateSpikes, buildKnownIssueCandidates,
  frictionTarget, frictionKeyFor, evaluateSelectorRisk, findResolveSuggestions, describeFailureContext, frictionConfig,
} from './friction.mjs';

let clock = 0;
let nextId = 0;
// Chronological action row as db.listAllActions() returns it (+ the origin/error_class columns).
function row({ session = 1, type = 'dom.click', selector, ok = false, error = 'boom', origin = null, ms = 10, params } = {}) {
  clock += 1000;
  return {
    id: (nextId += 1), session_id: session, type, ok, error: ok ? null : error, origin, duration_ms: ms,
    params: params ?? (selector ? { selector } : {}), started_at: new Date(Date.UTC(2026, 0, 1) + clock).toISOString(),
  };
}

test('normalizeSelector collapses noise but keeps distinct stable selectors apart', () => {
  assert.equal(normalizeSelector('  div   >  .a '), 'div>.a');
  assert.equal(normalizeSelector("a[data-id='42']"), 'a[data-id="*"]');
  assert.equal(normalizeSelector('#row-41'), '#row-*');
  assert.equal(normalizeSelector('li:nth-child(3)'), 'li:nth-child(*)');
  assert.equal(normalizeSelector('li:nth-of-type( 12 )'), 'li:nth-of-type(*)');
  // stable selectors are NOT merged
  assert.notEqual(normalizeSelector('.col-md-6'), normalizeSelector('.col-md-4'));
  assert.notEqual(normalizeSelector('[type="submit"]'), normalizeSelector('[type="reset"]'));
});

test('click and clickWait share one friction key; other types stay separate', () => {
  assert.equal(typeFamily('dom.clickWait'), 'dom.click');
  assert.equal(frictionKey('dom.click', '#a'), frictionKey('dom.clickWait', '#a'));
  assert.notEqual(frictionKey('dom.click', '#a'), frictionKey('dom.fill', '#a'));
  assert.equal(frictionKey('dom.click', '#row-41'), frictionKey('dom.click', '#row-97'));
});

test('classifyError names the failure shape', () => {
  assert.equal(classifyError('command timed out after 15000ms'), 'timeout');
  assert.equal(classifyError('Element not found: #x (detached from DOM)'), 'detached');
  assert.equal(classifyError('Element not found: #x'), 'not-found');
  assert.equal(classifyError('Execution context was destroyed, most likely because of a navigation'), 'navigation');
  assert.equal(classifyError('TypeError: x is not a function'), 'eval-throw');
  assert.equal(classifyError('something odd'), 'other');
  assert.equal(classifyError(''), 'other');
});

test('buildSelectorFriction: a success after the failures leaves nothing unresolved', () => {
  const rows = [row({ selector: '#a' }), row({ selector: '#a' }), row({ selector: '#a' }), row({ selector: '#a', ok: true })];
  const [entry] = buildSelectorFriction(rows);
  assert.equal(entry.failCount, 3);
  assert.equal(historyForOrigin(entry, null).unresolved, 0);
  assert.equal(historyForOrigin(entry, null).fails, 3);

  const still = buildSelectorFriction([...rows, row({ selector: '#a' }), row({ selector: '#a' })])[0];
  assert.equal(historyForOrigin(still, null).unresolved, 2);
});

test('buildSelectorFriction: history is scoped per origin, unknown-origin rows count everywhere', () => {
  const rows = [
    row({ selector: '#a', origin: 'http://a.test' }), row({ selector: '#a', origin: 'http://a.test' }), row({ selector: '#a', origin: 'http://a.test' }),
    row({ selector: '#a', origin: null }),
  ];
  const [entry] = buildSelectorFriction(rows);
  assert.equal(historyForOrigin(entry, 'http://a.test').fails, 4);
  assert.equal(historyForOrigin(entry, 'http://b.test').fails, 1, 'only the legacy unknown-origin row applies to another origin');
  assert.equal(historyForOrigin(entry, null).fails, 4, 'no live origin: everything counts');
});

test('buildSelectorFriction: merges normalized selectors and click/clickWait, sums wasted time and classes', () => {
  const rows = [
    row({ selector: '#row-41', ms: 15000, error: 'command timed out' }),
    row({ type: 'dom.clickWait', selector: '#row-97', ms: 5, error: 'Element not found: #row-97' }),
  ];
  const entries = buildSelectorFriction(rows);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].failCount, 2);
  assert.equal(entries[0].wastedMs, 15005);
  assert.deepEqual(entries[0].errorClasses, { timeout: 1, 'not-found': 1 });
});

test('buildSelectorFriction: remembers what worked right after a failure', () => {
  const rows = [
    row({ selector: '#old' }), row({ selector: '#new', ok: true }),
    row({ selector: '#old' }), row({ type: 'dom.wait', selector: '#old', ok: true }),
  ];
  const [entry] = buildSelectorFriction(rows);
  assert.equal(entry.recovery.kind, 'wait');
  assert.equal(entry.recovery.type, 'dom.wait');

  const alt = buildSelectorFriction([row({ selector: '#old' }), row({ selector: '#new', ok: true }), row({ selector: '#old' })])[0];
  assert.equal(alt.recovery.kind, 'alt-selector');
  assert.equal(alt.recovery.selector, '#new');
});

test('buildSelectorFriction: failures at or before a resolution instant are ignored', () => {
  const rows = [row({ selector: '#a' }), row({ selector: '#a' }), row({ selector: '#a' })];
  const resolvedAt = rows[1].started_at;
  const resolutions = new Map([[frictionKey('dom.click', '#a'), resolvedAt]]);
  assert.equal(buildSelectorFriction(rows, { resolutions }).length, 0, 'one post-fix failure is below the 2-failure floor');
  const relapse = [...rows, row({ selector: '#a' }), row({ selector: '#a' })];
  const [entry] = buildSelectorFriction(relapse, { resolutions });
  assert.equal(entry.failCount, 3, 'the post-fix failures, including the one right after the cutoff, count');
});

test('assessSelectorRisk: history alone needs the unresolved threshold, live failures warn sooner', () => {
  const histRows = [row({ selector: '#a' }), row({ selector: '#a' })];
  const [twoFail] = buildSelectorFriction(histRows);
  assert.equal(assessSelectorRisk({ type: 'dom.click', selector: '#a', entry: twoFail, live: null, state: null, origin: null }), null, '2 prior failures is below the threshold');

  const tracker = createFrictionTracker();
  tracker.note(1, { type: 'dom.click', params: { selector: '#fresh' }, ok: false, error: 'Element not found' });
  const key = frictionKey('dom.click', '#fresh');
  assert.equal(assessSelectorRisk({ type: 'dom.click', selector: '#fresh', entry: undefined, live: tracker.get(1, key), state: null, origin: null }), null, 'one live failure is not enough');
  tracker.note(1, { type: 'dom.click', params: { selector: '#fresh' }, ok: false, error: 'Element not found' });
  const verdict = assessSelectorRisk({ type: 'dom.click', selector: '#fresh', entry: undefined, live: tracker.get(1, key), state: null, origin: null });
  assert.equal(verdict.level, 'warn');
  assert.match(verdict.message, /failed 2x already this session/);
  assert.equal(verdict.errorClass, 'not-found');
});

test('assessSelectorRisk: dedupes until a NEW failure, then escalates once ignored', () => {
  const tracker = createFrictionTracker();
  const fail = () => tracker.note(7, { type: 'dom.click', params: { selector: '#x' }, ok: false, error: 'boom' });
  const key = frictionKey('dom.click', '#x');
  const assess = () => assessSelectorRisk({ type: 'dom.click', selector: '#x', entry: undefined, live: tracker.get(7, key), state: tracker.warnState(7, key), origin: null });
  fail(); fail();
  const first = assess();
  assert.equal(first.level, 'warn');
  tracker.recordWarn(7, key, first.liveUnresolved);
  assert.equal(assess(), null, 'same information: stay quiet');
  fail();
  const escalated = assess();
  assert.equal(escalated.level, 'escalated');
  assert.match(escalated.message, /^ESCALATED/);
});

test('assessSelectorRisk: a success earlier in this session silences stale history', () => {
  const rows = [row({ selector: '#a' }), row({ selector: '#a' }), row({ selector: '#a' })];
  const [entry] = buildSelectorFriction(rows);
  const tracker = createFrictionTracker();
  const key = frictionKey('dom.click', '#a');
  assert.ok(assessSelectorRisk({ type: 'dom.click', selector: '#a', entry, live: null, state: null, origin: null }));
  tracker.note(3, { type: 'dom.click', params: { selector: '#a' }, ok: true });
  assert.equal(assessSelectorRisk({ type: 'dom.click', selector: '#a', entry, live: tracker.get(3, key), state: null, origin: null }), null);
});

test('assessSelectorRisk: names the recovery that worked before, else class-specific advice', () => {
  const withRecovery = buildSelectorFriction([row({ selector: '#old' }), row({ selector: '#new', ok: true }), row({ selector: '#old' }), row({ selector: '#old' })])[0];
  const v = assessSelectorRisk({ type: 'dom.click', selector: '#old', entry: withRecovery, live: null, state: null, origin: null });
  assert.match(v.message, /"#new" \(dom\.click\) worked/);

  const timeouts = buildSelectorFriction([1, 2, 3].map(() => row({ selector: '#slow', error: 'command timed out' })))[0];
  const t = assessSelectorRisk({ type: 'dom.click', selector: '#slow', entry: timeouts, live: null, state: null, origin: null });
  assert.match(t.message, /\[timeout\]/);
  assert.match(t.message, /settle\/dom\.wait/);
});

test('failureContext reports class, session count and the recovery', () => {
  const tracker = createFrictionTracker();
  tracker.note(1, { type: 'dom.click', params: { selector: '#z' }, ok: false, error: 'Element not found: #z' });
  const ctx = failureContext({ type: 'dom.click', selector: '#z', entry: undefined, live: tracker.get(1, frictionKey('dom.click', '#z')), origin: null });
  assert.equal(ctx.errorClass, 'not-found');
  assert.equal(ctx.failuresThisSession, 1);
  assert.equal(failureContext({ type: 'idb.list', selector: undefined }), null);
});

test('findRateSpikes flags a type that got much worse this session, not one that is just always bad', () => {
  const session = [
    ...[1, 2].map(() => ({ type: 'dom.click', ok: false })), { type: 'dom.click', ok: true },
  ];
  // project-wide INCLUDING this session: 3 + 40 prior calls, 2 + 2 failures
  const spike = findRateSpikes(session, [{ type: 'dom.click', total: 43, failed: 4 }]);
  assert.equal(spike.length, 1);
  assert.match(spike[0], /"dom\.click" failure rate spiked: 67%/);

  const alwaysBad = findRateSpikes(session, [{ type: 'dom.click', total: 43, failed: 30 }]);
  assert.deepEqual(alwaysBad, []);
  const noBaseline = findRateSpikes(session, [{ type: 'dom.click', total: 5, failed: 3 }]);
  assert.deepEqual(noBaseline, [], 'too little prior history to call it a spike');
});

test('buildKnownIssueCandidates drafts an entry for a repeating unmatched error, skips matched ones', () => {
  const rows = [
    row({ session: 1, selector: '#a', error: 'Element not found: #a (stale 1234)' }),
    row({ session: 2, selector: '#b', error: 'Element not found: #b (stale 5678)' }),
    row({ session: 3, selector: '#c', error: 'Element not found: #c (stale 91011)' }),
    row({ session: 1, selector: '#z', error: 'one-off weirdness' }),
  ];
  const [candidate] = buildKnownIssueCandidates(rows);
  assert.equal(candidate.count, 3);
  assert.equal(candidate.sessionCount, 3);
  assert.equal(candidate.draft.signature, 'Element not found');
  assert.match(candidate.draft.id, /^candidate-element-not-found/);
  assert.equal(buildKnownIssueCandidates(rows, { matchKnownIssues: () => [{ id: 'known' }] }).length, 0);
});

// ---------- round 3 ----------

test('targets: a selector or (for idb.*) a store; put/patch share a key, a store never collides with a selector', () => {
  assert.deepEqual(frictionTarget('dom.click', { selector: '#a' }), { kind: 'selector', value: '#a' });
  assert.deepEqual(frictionTarget('idb.put', { store: 'orders' }), { kind: 'store', value: 'orders' });
  assert.equal(frictionTarget('dom.click', { store: 'orders' }), null, 'a store only aims idb.* commands');
  assert.equal(frictionTarget('dom.click', {}), null);
  assert.equal(frictionKeyFor('idb.put', { store: 'orders' }), frictionKeyFor('idb.patch', { store: 'orders' }));
  assert.notEqual(frictionKeyFor('idb.put', { store: 'orders' }), frictionKeyFor('idb.put', { store: 'tags' }));
  assert.notEqual(frictionKeyFor('idb.put', { store: 'x' }), frictionKey('idb.put', 'x'), 'store x is not selector x');
});

test('buildSelectorFriction: stores accumulate like selectors', () => {
  const rows = [row({ type: 'idb.put', params: { store: 'orders' } }), row({ type: 'idb.patch', params: { store: 'orders' } })];
  const [entry] = buildSelectorFriction(rows);
  assert.equal(entry.targetKind, 'store');
  assert.equal(entry.selector, 'orders');
  assert.equal(entry.failCount, 2);
});

test('buildSelectorFriction: recoveries are aggregated across failures and carry worked/of', () => {
  const rows = [];
  for (let s = 1; s <= 3; s += 1) {
    rows.push(row({ session: s, selector: '#primary' }));
    rows.push(row({ session: s, selector: '#fallback', ok: true }));
  }
  rows.push(row({ session: 4, selector: '#primary' }));
  rows.push(row({ session: 4, type: 'dom.wait', selector: '#spinner', ok: true }));
  const [entry] = buildSelectorFriction(rows);
  assert.equal(entry.failCount, 4);
  assert.deepEqual(entry.recoveries.map((r) => [r.kind, r.worked, r.of]), [['alt-selector', 3, 4], ['wait', 1, 4]]);
  assert.equal(entry.recovery.selector, '#fallback', 'the top recovery is also exposed as `recovery`');
});

test('buildSelectorFriction: retries and time wasted raise the cost score; ranking follows it', () => {
  const rows = [
    row({ session: 1, selector: '#fast-miss' }), row({ session: 2, selector: '#fast-miss' }),
    row({ session: 3, selector: '#slow', ms: 12000 }), row({ session: 3, selector: '#slow', ms: 12000 }),
  ];
  const entries = buildSelectorFriction(rows);
  assert.equal(entries[0].selector, '#slow', 'time wasted outranks an equal count of instant misses');
  const slow = entries[0];
  assert.equal(slow.retries, 1, 'the second attempt in the same session is a retry');
  assert.ok(slow.score >= slow.failCount + 24);
  assert.equal(entries.find((e) => e.selector === '#fast-miss').retries, 0, 'a failure in a different session is not a retry');
});

test('buildSelectorFriction: minFails 1 returns a single prior failure too', () => {
  const rows = [row({ selector: '#once' })];
  assert.equal(buildSelectorFriction(rows).length, 0);
  assert.equal(buildSelectorFriction(rows, { minFails: 1 }).length, 1);
});

test('evaluateSelectorRisk explains a quiet decision and returns the numbers it used', () => {
  const entry = buildSelectorFriction([row({ selector: '#a' }), row({ selector: '#a' })])[0];
  const quiet = evaluateSelectorRisk({ type: 'dom.click', selector: '#a', entry, live: null, state: null, origin: null });
  assert.equal(quiet.assessment, null);
  assert.match(quiet.reason, /quiet: 2 unresolved earlier failure\(s\) \+ 0 this session/);
  assert.equal(quiet.facts.historyUnresolved, 2);

  const worked = evaluateSelectorRisk({ type: 'dom.click', selector: '#a', entry, live: { unresolved: 0, fails: 1, lastOkAt: 'x' }, state: null });
  assert.match(worked.reason, /succeeded earlier in this session/);

  const said = evaluateSelectorRisk({ type: 'dom.click', selector: '#a', entry, live: { unresolved: 2, fails: 2, errorClass: 'timeout' }, state: { atLive: 2, count: 1 } });
  assert.equal(said.assessment, null);
  assert.match(said.reason, /already warned/);

  const loud = evaluateSelectorRisk({ type: 'dom.click', selector: '#a', entry, live: { unresolved: 2, fails: 2, errorClass: 'timeout' }, state: null });
  assert.equal(loud.assessment.level, 'warn');
  assert.equal(assessSelectorRisk({ type: 'dom.click', selector: '#a', entry, live: { unresolved: 2, fails: 2, errorClass: 'timeout' }, state: null }).message, loud.assessment.message, 'assessSelectorRisk is the same decision');
});

test('evaluateSelectorRisk words a store target as a store, and the recovery with its odds', () => {
  const rows = [];
  for (let s = 1; s <= 2; s += 1) { rows.push(row({ session: s, selector: '#p' })); rows.push(row({ session: s, selector: '#alt', ok: true })); }
  const entry = buildSelectorFriction(rows, { minFails: 1 })[0];
  const msg = evaluateSelectorRisk({ type: 'dom.click', selector: '#p', entry, live: { unresolved: 1, fails: 1 }, state: null }).assessment.message;
  assert.match(msg, /"#alt" \(dom\.click\) worked \(2 of 2 times\)/);
  const store = evaluateSelectorRisk({ type: 'idb.put', selector: 'orders', targetKind: 'store', entry: undefined, live: { unresolved: 2, fails: 2 }, state: null }).assessment.message;
  assert.match(store, /^store "orders" \(idb\.put\)/);
});

test('tracker: persist hooks fire, and restore rebuilds counters + the already-said state', () => {
  const saved = [];
  const t = createFrictionTracker({ persist: { warn: (...a) => saved.push(['warn', ...a]), announce: (...a) => saved.push(['announce', ...a]) } });
  t.recordWarn(7, 'k', 2);
  assert.equal(t.announceOnce(7, 'type', 'dom.click'), true);
  assert.equal(t.announceOnce(7, 'type', 'dom.click'), false);
  assert.deepEqual(saved, [['warn', 7, 'k', 2, 1], ['announce', 7, 'type', 'dom.click']]);

  const fresh = createFrictionTracker();
  const key = frictionKey('dom.click', '#r');
  assert.equal(fresh.has(7), false);
  fresh.restore(7, [
    { type: 'dom.click', params: { selector: '#r' }, ok: 0, error: 'Element not found', duration_ms: 5, started_at: 't1' },
    { type: 'dom.click', params: { selector: '#r' }, ok: 0, error: 'Element not found', duration_ms: 5, started_at: 't2' },
  ], { warns: [{ key, at_live: 2, count: 1 }], announces: [{ kind: 'type', key: 'dom.click' }] });
  assert.equal(fresh.get(7, key).fails, 2);
  assert.equal(fresh.warnState(7, key).atLive, 2);
  assert.equal(fresh.announceOnce(7, 'type', 'dom.click'), false, 'a restored one-shot note is not repeated');
  assert.deepEqual(fresh.keys(7), [key]);
});

test('findResolveSuggestions: failed 3+, then 3+ consecutive successes across 2+ sessions - and nothing less', () => {
  const rows = [
    row({ session: 1, selector: '#f' }), row({ session: 1, selector: '#f' }), row({ session: 1, selector: '#f' }),
    row({ session: 2, selector: '#f', ok: true }), row({ session: 2, selector: '#f', ok: true }),
  ];
  assert.equal(findResolveSuggestions(rows).length, 0, 'only 2 successes, one session');
  rows.push(row({ session: 3, selector: '#f', ok: true }));
  const [s] = findResolveSuggestions(rows);
  assert.equal(s.failures, 3);
  assert.equal(s.okStreak, 3);
  assert.equal(s.sessions, 2);
  assert.match(s.hint, /friction resolve dom\.click "#f"/);

  assert.equal(findResolveSuggestions([...rows, row({ session: 3, selector: '#f' })]).length, 0, 'a fresh failure breaks the streak');
  const resolvedAt = rows[rows.length - 1].started_at;
  assert.equal(findResolveSuggestions(rows, { resolutions: new Map([[frictionKey('dom.click', '#f'), resolvedAt]]) }).length, 0, 'already declared fixed');
});

test('describeFailureContext is the one rendering used by the CLI and the MCP server', () => {
  const ctx = failureContext({ type: 'dom.click', selector: '#a', entry: undefined, live: { errorClass: 'timeout', fails: 2 }, origin: null });
  assert.equal(describeFailureContext(ctx), 'Friction: timeout failure, 2x this session, 0x in earlier sessions - the page was slow or never replied - add a settle/dom.wait first, or check "ping".');
  assert.equal(describeFailureContext(null), null);
});

test('frictionConfig reports the thresholds in effect', () => {
  const c = frictionConfig();
  assert.equal(typeof c.riskyFailThreshold, 'number');
  assert.equal(typeof c.resolveSuggest.minOks, 'number');
  assert.equal(typeof c.block, 'boolean');
});
