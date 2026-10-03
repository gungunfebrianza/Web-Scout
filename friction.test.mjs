// Unit tests for friction.mjs - pure functions on plain arrays, no relay, no DB.
// The relay-level behaviour (headers, snapshot, dedupe across real requests) lives in
// friction-awareness.test.mjs and friction-awareness-live.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSelector, typeFamily, frictionKey, classifyError, buildSelectorFriction, historyForOrigin,
  createFrictionTracker, assessSelectorRisk, failureContext, findRateSpikes, buildKnownIssueCandidates,
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
