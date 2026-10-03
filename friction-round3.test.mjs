// Friction awareness, round 3 - making the round-2 pieces one coherent system:
//   - history is read on demand (indexed), so nothing is frozen at session start,
//   - stores are targets as well as selectors (idb writes fail by store),
//   - `friction explain` says why a target does / doesn't warn, from the same facts the warning uses,
//   - the "already said" state survives a relay restart under a live session,
//   - a macro replay is checked like a direct command,
//   - session end suggests "mark fixed?", and a known-issue candidate can be promoted.
// Real relay + fake tab, no browser; each test gets its own relay.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './scratch.mjs';
import { startTestRelay, connectFakeAgent } from './test-relay.mjs';

async function withRelay(fn, { handlers = {}, envOverride = {}, origin } = {}) {
  const relay = await startTestRelay({ env: { WEBSCOUT_ANALYTICS_CACHE_MS: '0', ...envOverride } });
  const tab = await connectFakeAgent(relay.port, handlers, { origin });
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
  const start = (goal) => api('POST', '/sessions', { goal, context: 'friction-round3.test.mjs', briefing: false });
  const run = (type, params) => apiRaw('POST', '/command', { type, params });
  const click = (selector, type = 'dom.click') => run(type, { selector });
  const failN = async (n, selector, type = 'dom.click') => { for (let i = 0; i < n; i += 1) await click(selector, type); };
  try {
    await fn({ api, apiRaw, start, run, click, failN, relay });
  } finally {
    await tab.close();
    await relay.stop();
  }
}

const alwaysFail = {
  'dom.click': () => { throw new Error('Element not found: still broken'); },
  'dom.clickWait': () => { throw new Error('Element not found: still broken'); },
  'idb.put': () => { throw new Error('ConstraintError: unique index violated'); },
  'idb.patch': () => { throw new Error('ConstraintError: unique index violated'); },
};

test('history is an exact lookup, not a frozen snapshot: a selector that failed ONCE before is not "emerging"', async () => {
  await withRelay(async ({ api, start, click }) => {
    const a = await start('seed');
    await click('#seen-once');
    await api('POST', `/sessions/${a.id}/end`);
    await start('consult');
    await click('#seen-once');
    const second = await click('#seen-once');
    const notes = second.json.extra.emergentFriction ?? [];
    assert.ok(!notes.some((l) => l.includes('#seen-once')), `it failed in an earlier session, so it is not new: ${JSON.stringify(notes)}`);
    assert.equal(second.json.extra.selectorFriction.priorFailures, 1, 'the single earlier failure is visible (the old frozen snapshot only held 2+)');
  }, { handlers: alwaysFail });
});

test('a store is a target: idb writes that keep failing warn by store, patch and put are one family', async () => {
  await withRelay(async ({ start, run }) => {
    await start('store friction');
    await run('idb.put', { store: 'orders', row: { id: 1 } });
    await run('idb.patch', { store: 'orders', key: 1, patch: {} });
    const third = await run('idb.put', { store: 'orders', row: { id: 2 } });
    const warn = third.res.headers.get('x-webscout-selector-risk') ?? '';
    assert.match(warn, /^store "orders" \(idb\.put\) has failed 2x already this session/);
    const other = await run('idb.put', { store: 'tags', row: { id: 1 } });
    assert.equal(other.res.headers.get('x-webscout-selector-risk'), null, 'a different store is a different target');
  }, { handlers: alwaysFail });
});

test('friction explain answers "why did / didn\'t it warn" from the same facts, without consuming the warning', async () => {
  await withRelay(async ({ api, start, click, failN }) => {
    await start('explain');
    const clean = await api('GET', `/friction/explain?type=dom.click&selector=${encodeURIComponent('#never')}`);
    assert.equal(clean.wouldWarn, false);
    assert.match(clean.decision, /^quiet/);
    assert.equal(clean.history, null);

    await failN(2, '#bad');
    const before = await api('GET', `/friction/explain?type=dom.click&selector=${encodeURIComponent('#bad')}`);
    assert.equal(before.wouldWarn, true, 'two same-session failures reach the live threshold');
    assert.equal(before.thisSession.fails, 2);
    assert.match(before.message, /failed 2x already this session/);
    // explain is read-only: asking twice still says the same, and the real warning is still unspent
    const again = await api('GET', `/friction/explain?type=dom.click&selector=${encodeURIComponent('#bad')}`);
    assert.equal(again.wouldWarn, true);
    const real = await click('#bad');
    assert.match(real.res.headers.get('x-webscout-selector-risk') ?? '', /failed 2x already this session/);
    // that warned call failed too: a NEW failure since the warning, so the next one escalates
    const after = await api('GET', `/friction/explain?type=dom.click&selector=${encodeURIComponent('#bad')}`);
    assert.equal(after.wouldWarn, true);
    assert.equal(after.level, 'escalated');
    assert.equal(after.numbers.warnedAtLive, 2, 'it knows the warning was already shown at 2 failures');
    assert.equal(after.config.liveFailThreshold, 2);
  }, { handlers: alwaysFail });
});

test('the warned-already state survives a relay restart under a live session', async () => {
  const dir = tmpDir('webscout-round3-restart-');
  const env = { WEBSCOUT_DB_PATH: path.join(dir, 'shared.db'), WEBSCOUT_ANALYTICS_CACHE_MS: '0' };
  const post = (port, route, body) => fetch(`http://127.0.0.1:${port}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ res: r, json: await r.json() }));
  try {
    let relay = await startTestRelay({ env });
    let tab = await connectFakeAgent(relay.port, alwaysFail);
    await post(relay.port, '/sessions', { goal: 'restart', context: 'friction-round3.test.mjs', briefing: false });
    const click = (port) => post(port, '/command', { type: 'dom.click', params: { selector: '#r' } });
    await click(relay.port); await click(relay.port);
    const warned = await click(relay.port);
    assert.ok(warned.res.headers.get('x-webscout-selector-risk'), 'warned before the restart');
    await tab.close();
    await relay.stop();

    relay = await startTestRelay({ env });
    tab = await connectFakeAgent(relay.port, alwaysFail);
    try {
      const fourth = await click(relay.port); // fails again: a NEW live failure, so it may speak, but it must know about the 3 earlier ones
      const body = fourth.json.extra.selectorFriction;
      assert.equal(body.failuresThisSession, 4, 'the restarted relay rebuilt this session\'s counters from the action log');
      const fifth = await click(relay.port);
      assert.match(fifth.res.headers.get('x-webscout-selector-risk') ?? '', /^ESCALATED/, 'and the escalation did not start over');
    } finally {
      await tab.close();
      await relay.stop();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a macro replay is checked like a direct command: warnings ride the reply, a failed step carries its friction', async () => {
  let broken = false;
  const handlers = { 'dom.click': (p) => { if (broken && p.selector === '#m2') throw new Error('Element not found: #m2'); return { clicked: true, mutated: false }; } };
  await withRelay(async ({ api, start, click, failN }) => {
    const a = await start('record');
    await click('#m1'); await click('#m2');
    await api('POST', `/sessions/${a.id}/end`);
    const macro = await api('POST', '/macros', { name: 'two-step', sessionId: a.id });
    await start('break it');
    broken = true;
    await failN(2, '#m2');
    const replay = await api('POST', `/macros/${macro.id}/run`, { confirm: true });
    assert.ok(replay.frictionWarnings?.some((w) => w.message.includes('#m2')), JSON.stringify(replay.frictionWarnings));
    const failed = replay.results.find((r) => !r.ok);
    assert.ok(failed, 'the broken step fails');
    assert.ok(failed.selectorFriction.failuresThisSession >= 2, 'and says what friction awareness knew about it');
  }, { handlers });
});

test('recoveries are aggregated: the warning says how often the alternative worked', async () => {
  const handlers = { 'dom.click': (p) => { if (p.selector === '#primary') throw new Error('Element not found: #primary'); return { clicked: true, mutated: false }; } };
  await withRelay(async ({ api, start, click }) => {
    for (let i = 0; i < 3; i += 1) {
      const s = await start(`recover ${i}`);
      await click('#primary');
      await click('#fallback');
      await api('POST', `/sessions/${s.id}/end`);
    }
    await start('consult');
    const explain = await api('GET', `/friction/explain?type=dom.click&selector=${encodeURIComponent('#primary')}`);
    assert.equal(explain.history.recoveries[0].selector, '#fallback');
    assert.equal(explain.history.recoveries[0].worked, 3);
    assert.equal(explain.history.recoveries[0].of, 3);
    const warned = await click('#primary');
    assert.match(warned.res.headers.get('x-webscout-selector-risk') ?? '', /"#fallback" \(dom\.click\) worked \(3 of 3 times\)/);
  }, { handlers });
});

test('session end suggests "mark fixed?" for a target that failed, then worked repeatedly across sessions', async () => {
  let broken = true;
  const handlers = { 'dom.click': () => { if (broken) throw new Error('Element not found: #flaky'); return { clicked: true, mutated: false }; } };
  await withRelay(async ({ api, start, click, failN }) => {
    const a = await start('breaking');
    await failN(3, '#flaky');
    await api('POST', `/sessions/${a.id}/end`);
    broken = false;
    const b = await start('works one');
    await click('#flaky'); await click('#flaky');
    await api('POST', `/sessions/${b.id}/end`);
    const c = await start('works two');
    await click('#flaky'); await click('#flaky');
    const ended = await api('POST', `/sessions/${c.id}/end`);
    const hint = ended.resolveSuggestions?.[0]?.hint ?? '';
    assert.match(hint, /failed 3x, then succeeded 4x in a row across 2 session\(s\)/);
    assert.match(hint, /friction resolve dom\.click "#flaky"/);
    assert.ok((await api('GET', '/analytics')).resolveSuggestions.some((s) => s.selector === '#flaky'));
    // declaring it fixed silences the suggestion
    await api('POST', '/friction/resolve', { type: 'dom.click', selector: '#flaky' });
    assert.equal((await api('GET', '/analytics')).resolveSuggestions.length, 0);
  }, { handlers });
});

test('known-issues promote: dry run by default, needs a remediation, never duplicates, then writes the registry', async () => {
  const dir = tmpDir('webscout-round3-promote-');
  const registry = path.join(dir, 'known-issues.json');
  try {
    await withRelay(async ({ api, apiRaw, start, click }) => {
      await start('candidates');
      await click('#one'); await click('#two'); await click('#three');
      const [candidate] = (await api('GET', '/analytics')).knownIssueCandidates;
      const id = candidate.draft.id;

      const noFix = await apiRaw('POST', '/known-issues/promote', { id });
      assert.equal(noFix.json.ok, false);
      assert.match(noFix.json.error, /remediation is required/);

      const todo = await apiRaw('POST', '/known-issues/promote', { id, remediation: 'rebuild the widget', confirm: true });
      assert.equal(todo.json.ok, false, 'the draft description still says TODO');
      assert.match(todo.json.error, /TODO/);

      const dry = await api('POST', '/known-issues/promote', { id, remediation: 'rebuild the widget', description: 'widget explodes on init' });
      assert.equal(dry.written, false);
      assert.equal(fs.existsSync(registry), false, 'a dry run touches nothing');

      const done = await api('POST', '/known-issues/promote', { id, remediation: 'rebuild the widget', description: 'widget explodes on init', confirm: true });
      assert.equal(done.written, true);
      const onDisk = JSON.parse(fs.readFileSync(registry, 'utf8'));
      assert.equal(onDisk.length, 1);
      assert.equal(onDisk[0].remediation, 'rebuild the widget');

      // it is a registered issue now, so it stops being a candidate and starts annotating failures
      assert.equal((await api('GET', '/analytics')).knownIssueCandidates.length, 0);
      const again = await apiRaw('POST', '/known-issues/promote', { id, remediation: 'x', description: 'y', confirm: true });
      assert.equal(again.json.ok, false);
    }, { handlers: { 'dom.click': (p) => { throw new Error(`Widget exploded in ${p.selector} (code ${p.selector.length}7)`); } }, envOverride: { WEBSCOUT_KNOWN_ISSUES: registry } });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cost ranking counts retries: a selector retried after each failure outranks one failing as often without retries', async () => {
  await withRelay(async ({ api, start, click }) => {
    await start('cost');
    await click('#retried'); await click('#retried'); // failure, then a retry of it
    await click('#other-a'); await click('#x-1'); await click('#other-b'); await click('#x-2'); // failures, never re-attempted
    const { selectorFriction } = await api('GET', '/analytics');
    const retried = selectorFriction.find((f) => f.selector === '#retried');
    assert.equal(retried.failCount, 2);
    assert.equal(retried.retries, 1);
    assert.ok(retried.score > retried.failCount, 'the retry adds to the score');
    assert.equal(selectorFriction[0].selector, '#retried');
  }, { handlers: alwaysFail });
});
