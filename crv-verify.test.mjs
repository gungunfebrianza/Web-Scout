// idb verify: the expectation syntax and report shape (pure), then the whole call
// through a real relay and a stand-in tab.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { parseExpect, evaluateExpectations, buildVerifyReport, changedFields, sampleStoreDiff } from './crv-verify.mjs';
import { startTestRelay, connectFakeAgent } from './test-relay.mjs';

test('the expectation syntax parses to constraints, and rejects what it cannot read', () => {
  assert.deepEqual(parseExpect('notes:+1'), [{ store: 'notes', added: 1 }]);
  assert.deepEqual(parseExpect('notes:+1+'), [{ store: 'notes', addedGte: 1 }]);
  assert.deepEqual(parseExpect('notes:+1-0~2, tags:same'), [{ store: 'notes', added: 1, removed: 0, changed: 2 }, { store: 'tags', unchanged: true }]);
  assert.deepEqual(parseExpect('[{"store":"a","added":2}]'), [{ store: 'a', added: 2 }]);
  assert.deepEqual(parseExpect(undefined), []);
  assert.throws(() => parseExpect('notes'), /store:spec/);
  assert.throws(() => parseExpect('notes:+x'), /cannot read expectation/);
  assert.throws(() => parseExpect('notes:-1+'), /only supported for added/);
  assert.throws(() => parseExpect('[{"store":"a","adds":1}]'), /unknown key/);
  assert.throws(() => parseExpect('[{"store":"a"}]'), /constrains nothing/);
});

test('a store you did not name that changed fails the check unless allowExtra', () => {
  const summary = { notes: { added: 1, removed: 0, changed: 0 }, secret: { added: 0, removed: 0, changed: 2 } };
  const strict = evaluateExpectations(summary, parseExpect('notes:+1'));
  assert.equal(strict.passed, false);
  assert.deepEqual(strict.unexpected, [{ store: 'secret', added: 0, removed: 0, changed: 2 }]);
  assert.equal(evaluateExpectations(summary, parseExpect('notes:+1'), { allowExtra: true }).passed, true);
});

test('each constraint is checked against the real counts and names what differed', () => {
  const summary = { notes: { added: 2, removed: 0, changed: 1 } };
  const r = evaluateExpectations(summary, parseExpect('notes:+1'));
  assert.equal(r.results[0].pass, false);
  assert.match(r.results[0].problem, /added 2, expected 1/);
  assert.equal(evaluateExpectations(summary, parseExpect('notes:+2~1')).passed, true);
  assert.equal(evaluateExpectations(summary, parseExpect('notes:+1+')).passed, true);
  assert.equal(evaluateExpectations({}, parseExpect('notes:same')).passed, true, 'a store absent from the summary did not change');
});

test('a passing report is a few lines; a failing one carries rows for the failing stores only', () => {
  const diff = {
    notes: { added: [{ id: 1, body: 'x'.repeat(200) }], removed: [], changed: [] },
    tags: { added: [], removed: [], changed: [{ key: '7', before: { id: 7, label: 'a', big: 'z'.repeat(300) }, after: { id: 7, label: 'b', big: 'z'.repeat(300) } }] },
  };
  const summary = { notes: { added: 1, removed: 0, changed: 0 }, tags: { added: 0, removed: 0, changed: 1 } };
  const pass = buildVerifyReport({ baselineId: 1, afterId: 2, diffId: 3, summary, diff, expectations: parseExpect('notes:+1,tags:~1') });
  assert.equal(pass.passed, true);
  assert.equal(pass.samples, undefined, 'no rows when everything held');
  assert.ok(JSON.stringify(pass).length < 320, `a passing verify stays tiny: ${JSON.stringify(pass).length}`);

  const fail = buildVerifyReport({ baselineId: 1, afterId: 2, diffId: 3, summary, diff, expectations: parseExpect('notes:+2') });
  assert.equal(fail.passed, false);
  assert.equal(fail.failed[0].store, 'notes');
  assert.deepEqual(fail.unexpected.map((u) => u.store), ['tags']);
  assert.ok(fail.samples.notes.added.rows[0].body.length < 100, 'row values are clipped');
  assert.deepEqual(fail.samples.tags.changed.rows[0].fields, { label: ['a', 'b'] }, 'a changed row is its differing fields, not two whole rows');
  assert.match(fail.hint, /\/state\/diffs\/3/);
});

test('no expectations means nothing may have changed', () => {
  const clean = buildVerifyReport({ baselineId: 1, afterId: 2, diffId: 3, summary: {}, diff: {}, expectations: [] });
  assert.equal(clean.passed, true);
  const dirty = buildVerifyReport({ baselineId: 1, afterId: 2, diffId: 3, summary: { a: { added: 1, removed: 0, changed: 0 } }, diff: { a: { added: [{ id: 1 }], removed: [], changed: [] } }, expectations: [] });
  assert.equal(dirty.passed, false);
  assert.deepEqual(dirty.unexpected, [{ store: 'a', added: 1, removed: 0, changed: 0 }]);
});

test('sampling cuts each bucket to the limit and says how many more there are', () => {
  const s = sampleStoreDiff({ added: [1, 2, 3, 4, 5].map((id) => ({ id })), removed: [], changed: [] }, 2);
  assert.equal(s.added.rows.length, 2);
  assert.equal(s.added.more, 3);
  assert.deepEqual(changedFields({ a: 1, b: 2 }, { a: 1, b: 3 }), { b: [2, 3] });
});

// ---------- through a real relay ----------

const relay = await startTestRelay();
const BASE = `http://127.0.0.1:${relay.port}`;
const skipLive = relay.live ? 'skipped under WEBSCOUT_TEST_LIVE=1' : false;
let tab;
const db = { notes: [{ id: 1, body: 'one' }], tags: [{ id: 1, label: 'a' }] };

async function api(method, route, body) {
  const res = await fetch(`${BASE}${route}`, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json();
  return json.ok ? json.result : Object.assign(new Error(json.error), { status: res.status });
}
const verify = (body) => api('POST', '/state/verify', { agent: 'verify-tab', ...body });

before(async () => {
  if (relay.live) return;
  tab = await connectFakeAgent(relay.port, {
    'idb.snapshot': (p) => ({ stores: Object.fromEntries((p.stores ?? Object.keys(db)).map((s) => [s, { keyPath: 'id', rows: structuredClone(db[s]) }])) }),
  }, { name: 'verify-tab', epoch: 0 });
  await api('POST', '/sessions', { goal: 'crv-verify.test.mjs', context: 'automated', agent: 'verify-tab', briefing: false });
});
after(async () => { tab?.close(); await relay.stop(); });

test('verify without any snapshot to compare against says so', { skip: skipLive }, async () => {
  const err = await verify({ expect: 'notes:+1' });
  assert.equal(err.status, 409);
  assert.match(err.message, /no baseline/);
});

test('baseline -> action -> verify: pass, then fail with only the failing rows', { skip: skipLive }, async () => {
  const baseline = await api('POST', '/state/snapshot', { agent: 'verify-tab', stores: ['notes', 'tags'] });
  db.notes.push({ id: 2, body: 'two' });
  const ok = await verify({ expect: 'notes:+1,tags:same' });
  assert.equal(ok.passed, true, JSON.stringify(ok));
  assert.equal(ok.baselineSnapshotId, baseline.id);
  assert.deepEqual(ok.changedStores, { notes: '+1-0~0' });
  assert.ok(Number.isInteger(ok.diffId));

  // the default baseline is now the verify's own fresh snapshot: the next step is measured from it
  db.tags[0].label = 'changed';
  const step2 = await verify({ expect: 'notes:same' });
  assert.equal(step2.baselineSnapshotId, ok.afterSnapshotId);
  assert.equal(step2.passed, false, 'tags moved and was not named');
  assert.deepEqual(step2.unexpected, [{ store: 'tags', added: 0, removed: 0, changed: 1 }]);
  assert.deepEqual(step2.samples.tags.changed.rows[0].fields, { label: ['a', 'changed'] });

  // pinned to the original baseline, both changes show
  const pinned = await verify({ baseline: String(baseline.id), expect: 'notes:+1,tags:~1' });
  assert.equal(pinned.passed, true);
});

test('a bad expectation is a 400 before anything is snapshotted', { skip: skipLive }, async () => {
  const before = tab.seen.filter((m) => m.type === 'idb.snapshot').length;
  const err = await verify({ expect: 'notes:+x' });
  assert.equal(err.status, 400);
  assert.equal(tab.seen.filter((m) => m.type === 'idb.snapshot').length, before);
});

test('a golden name works as the baseline, and the verify is logged as its own action', { skip: skipLive }, async () => {
  await api('POST', '/state/snapshot', { agent: 'verify-tab', stores: ['notes'], golden: 'verify-golden' });
  db.notes.push({ id: 3, body: 'three' });
  const r = await verify({ baseline: 'verify-golden', expect: 'notes:+1' });
  assert.equal(r.passed, true);
  const session = (await api('GET', '/health')).active_session;
  const actions = await api('GET', `/sessions/${session.id}/actions`);
  assert.ok(actions.some((a) => a.type === 'idb.verify'), 'the pass/fail is part of the evidence trail');
});
