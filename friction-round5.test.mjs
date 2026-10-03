// Friction awareness, round 5 - the same facts, reached from more places and kept cheaper:
//   - a type's failure numbers have ONE tally (analytics, the live "first failure" line, the spike check),
//   - page targets are origin + route (the agent reports its path),
//   - session start briefs the goal; --auto-recover makes recovery the session default,
//   - one declaration resolves a whole one-cause cluster (and can be undone),
//   - retention drops bulk result bodies but never history or declarations,
//   - analytics is read incrementally and still equals a full read.
// Real relay + fake tab, no browser; each test gets its own relay.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startTestRelay, connectFakeAgent } from './test-relay.mjs';
import { createScratchDir, PREFIXES } from './scratch.mjs';
import {
  tallyTypeFailures, normalizePageScope, frictionTarget, frictionKeyFor, buildSessionBriefing, buildSelectorFriction, buildFrictionClusters,
} from './friction.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const ORIGIN = 'http://localhost:4100';

async function withRelay(fn, { handlers = {}, envOverride = {}, origin = ORIGIN, path: pagePath } = {}) {
  const relay = await startTestRelay({ env: { WEBSCOUT_ANALYTICS_CACHE_MS: '0', ...envOverride } });
  const tab = await connectFakeAgent(relay.port, handlers, { origin, path: pagePath });
  const apiRaw = async (method, route, body) => {
    const res = await fetch(`http://127.0.0.1:${relay.port}${route}`, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
    return { res, json: await res.json() };
  };
  const api = async (method, route, body) => {
    const { json } = await apiRaw(method, route, body);
    if (!json.ok) throw Object.assign(new Error(json.error || `request failed: ${route}`), { extra: json.extra });
    return json.result;
  };
  const start = (goal, extra = {}) => api('POST', '/sessions', { goal, context: 'friction-round5.test.mjs', briefing: false, ...extra });
  const run = (type, params = {}, extra = {}) => apiRaw('POST', '/command', { type, params, ...extra });
  try {
    await fn({ api, apiRaw, start, run, relay, tab });
  } finally {
    await tab.close();
    await relay.stop();
  }
}

const failingClicks = { 'dom.click': (p) => { if (/^\.(a|b|c)1x$/.test(p.selector) || p.selector === '#primary') throw new Error(`Element not found: ${p.selector}`); return { clicked: true, mutated: false, selector: p.selector }; } };

// ---------- one tally per command type ----------

test('tallyTypeFailures counts calls, failures and time once, and can drop declared-fixed ones', () => {
  const rows = [
    { type: 'dom.click', ok: 1, duration_ms: 5, started_at: '2026-01-01T00:00:00Z' },
    { type: 'dom.click', ok: 0, duration_ms: 1500, started_at: '2026-01-02T00:00:00Z' },
    { type: 'dom.click', ok: 0, duration_ms: 500, started_at: '2026-01-03T00:00:00Z' },
    { type: 'dom.fill', ok: 1, duration_ms: 3, started_at: '2026-01-03T00:00:00Z' },
  ];
  const all = tallyTypeFailures(rows);
  assert.deepEqual(all.get('dom.click'), { type: 'dom.click', total: 3, failed: 2, wastedMs: 2000 });
  assert.equal(all.get('dom.fill').failed, 0);
  const afterFix = tallyTypeFailures(rows, { counts: (a) => a.started_at > '2026-01-02T00:00:00Z' });
  assert.deepEqual(afterFix.get('dom.click'), { type: 'dom.click', total: 1, failed: 1, wastedMs: 500 });
});

test('the live first-failure line, the analytics rate and the spike check read one tally', async () => {
  await withRelay(async ({ api, start, run }) => {
    const s1 = await start('first');
    const first = await run('dom.click', { selector: '.a1x' });
    assert.match(first.json.extra.emergentFriction.join(' '), /just failed for the first time ever/, 'no earlier session failed this type');
    await run('dom.click', { selector: '#ok' });
    await api('POST', `/sessions/${s1.id}/end`);

    await start('second');
    const again = await run('dom.click', { selector: '.b1x' });
    assert.ok(!(again.json.extra.emergentFriction ?? []).some((l) => /first time ever/.test(l)), 'an earlier session failed this type, so it is no longer a first');

    const analytics = await api('GET', '/analytics');
    const entry = analytics.failureRateByType.find((t) => t.type === 'dom.click');
    assert.equal(entry.total, 3);
    assert.equal(entry.failed, 2);
    assert.equal(entry.failureRate, 2 / 3);
  }, { handlers: failingClicks });
});

// ---------- page targets: origin + route ----------

test('normalizePageScope keeps the route, drops what varies, and is idempotent', () => {
  assert.equal(normalizePageScope('http://localhost:4100'), 'http://localhost:4100');
  assert.equal(normalizePageScope('http://localhost:4100/'), 'http://localhost:4100');
  assert.equal(normalizePageScope('http://localhost:4100/orders/123/items?x=1#top'), 'http://localhost:4100/orders/:id/items');
  assert.equal(normalizePageScope('http://localhost:4100/u/0b9f5d3e-1c2a-4f6b-8d7e-9a0b1c2d3e4f'), 'http://localhost:4100/u/:id');
  assert.equal(normalizePageScope(normalizePageScope('http://localhost:4100/orders/123')), 'http://localhost:4100/orders/:id');
  assert.equal(normalizePageScope('not a url'), 'not a url');
  assert.notEqual(frictionKeyFor('page.reload', {}, `${ORIGIN}/checkout`), frictionKeyFor('page.reload', {}, `${ORIGIN}/settings`), 'two routes are two targets');
  assert.equal(frictionKeyFor('page.reload', {}, `${ORIGIN}/orders/1`), frictionKeyFor('page.reload', {}, `${ORIGIN}/orders/2`), 'two ids on one route are one target');
  assert.deepEqual(frictionTarget('page.reload', {}, ORIGIN), { kind: 'page', value: ORIGIN }, 'a tab that reports no route keeps working at origin granularity');
});

test('live: a reload failing on /checkout does not warn on /settings, and the route comes from the tab', async () => {
  const handlers = { 'page.reload': () => { throw new Error('command timed out after 15000ms'); } };
  await withRelay(async ({ api, start, run, tab }) => {
    await start('routes');
    tab.state.path = '/checkout';
    await run('page.reload'); await run('page.reload');
    const third = await run('page.reload');
    assert.match(third.res.headers.get('x-webscout-selector-risk') ?? '', /page "http:\/\/localhost:4100\/checkout" \(page\.reload\) has failed 2x already/);

    tab.state.path = '/settings';
    await run('page.reload'); // a reply reports the new route to the relay
    const onSettings = await run('page.reload');
    assert.equal(onSettings.res.headers.get('x-webscout-selector-risk'), null, 'one failure on /settings is not a pattern');

    const analytics = await api('GET', '/analytics');
    const pages = Object.fromEntries(analytics.selectorFriction.filter((f) => f.targetKind === 'page').map((f) => [f.selector, f.failCount]));
    assert.deepEqual(pages, { [`${ORIGIN}/checkout`]: 3, [`${ORIGIN}/settings`]: 2 }, 'two routes, two targets - the first /settings reload ran before the relay knew the tab had moved, and is still logged where it ran');

    const explain = await api('GET', `/friction/explain?type=page.reload&selector=${encodeURIComponent(`${ORIGIN}/checkout`)}`);
    assert.equal(explain.thisSession.fails, 3);
    await api('POST', '/friction/resolve', { type: 'page.reload', selector: `${ORIGIN}/checkout` });
    assert.ok(!(await api('GET', '/analytics')).selectorFriction.some((f) => f.selector.endsWith('/checkout')), 'a resolved route stops ranking');
  }, { handlers, path: '/checkout' });
});

// ---------- session briefing ----------

test('buildSessionBriefing ranks by origin and goal, leaves out fixed targets, and always returns the worst walls', () => {
  const entry = (selector, origin, unresolved, score, extra = {}) => ({
    key: `dom.click::${selector}`, type: 'dom.click', targetKind: 'selector', selector, failCount: 3, score, lastError: `Element not found: ${selector}`, errorClasses: { 'not-found': 3 },
    origins: { [origin]: { fails: 3, unresolved } }, recovery: null, ...extra,
  });
  const list = [
    entry('#unrelated', 'http://other.test', 3, 50),
    entry('#checkout-pay', ORIGIN, 3, 5, { recovery: { kind: 'alt-selector', type: 'dom.click', selector: '#pay-now', worked: 3, of: 3 } }),
    entry('#fixed', ORIGIN, 0, 99),
    entry('.invoice-total', 'http://other.test', 2, 4),
  ];
  const brief = buildSessionBriefing(list, { goal: 'verify the invoice flow', origin: ORIGIN });
  assert.deepEqual(brief.map((b) => b.target), ['#checkout-pay', '.invoice-total', '#unrelated'], 'origin match first, then goal words, then cost; the fixed one is gone');
  assert.equal(brief[0].relevant, true);
  assert.match(brief[0].worked, /use "#pay-now" instead \(worked 3\/3\)/);
  assert.equal(brief[2].relevant, false, 'still shown, but not claimed relevant');
  assert.deepEqual(buildSessionBriefing([], { goal: 'x' }), []);
});

test('live: session start returns a frictionBriefing for the goal', async () => {
  await withRelay(async ({ api, start, run }) => {
    for (let n = 0; n < 2; n += 1) {
      const s = await start(`seed ${n}`);
      await run('dom.click', { selector: '#primary' });
      await run('dom.click', { selector: '#primary' });
      await api('POST', `/sessions/${s.id}/end`);
    }
    const next = await start('fix the primary button');
    assert.ok(Array.isArray(next.frictionBriefing), JSON.stringify(Object.keys(next)));
    assert.equal(next.frictionBriefing[0].target, '#primary');
    assert.equal(next.frictionBriefing[0].relevant, true);
    assert.equal(next.frictionBriefing[0].unresolved, 4);
  }, { handlers: failingClicks });
});

// ---------- auto-recover ----------

test('session start --auto-recover makes tryRecovery the default; a call can still opt out', async () => {
  const seen = [];
  const handlers = { 'dom.click': (p) => { seen.push(p.selector); if (p.selector === '#primary') throw new Error('Element not found: #primary'); return { clicked: true, selector: p.selector }; } };
  await withRelay(async ({ api, apiRaw, start, run }) => {
    for (let n = 0; n < 4; n += 1) {
      const s = await start(`seed ${n}`);
      await run('dom.click', { selector: '#primary' });
      await run('dom.click', { selector: '#fallback' });
      await api('POST', `/sessions/${s.id}/end`);
    }
    const plain = await start('plain');
    assert.equal(plain.auto_recover, false);
    seen.length = 0;
    assert.equal((await run('dom.click', { selector: '#primary' })).json.ok, false, 'without the flag a failure is just a failure');
    await run('dom.click', { selector: '#fallback' }); // the caller recovers by hand: one more trial that worked
    await api('POST', `/sessions/${plain.id}/end`);

    const auto = await start('auto', { auto_recover: true });
    assert.equal(auto.auto_recover, true);
    seen.length = 0;
    const r = await run('dom.click', { selector: '#primary' });
    assert.equal(r.json.ok, true, JSON.stringify(r.json));
    assert.deepEqual(seen, ['#primary', '#fallback']);
    assert.match(r.res.headers.get('x-webscout-recovered') ?? '', /ran "#fallback" instead/);

    seen.length = 0;
    const optOut = await apiRaw('POST', '/command', { type: 'dom.click', params: { selector: '#primary' }, tryRecovery: false });
    assert.equal(optOut.json.ok, false, 'an explicit tryRecovery:false still wins');
    assert.deepEqual(seen, ['#primary']);
  }, { handlers });
});

// ---------- cluster-level resolve ----------

test('one id resolves every target of a one-cause cluster, and the reply is the undo list', async () => {
  await withRelay(async ({ api, start, run }) => {
    for (let n = 0; n < 2; n += 1) {
      const s = await start(`seed ${n}`);
      for (const sel of ['.a1x', '.b1x', '.c1x']) await run('dom.click', { selector: sel });
      await api('POST', `/sessions/${s.id}/end`);
    }
    const before = await api('GET', '/analytics');
    assert.equal(before.frictionClusters.length, 1);
    const cluster = before.frictionClusters[0];
    assert.match(cluster.id, /^[0-9a-f]{8}$/);
    assert.match(cluster.summary, new RegExp(`friction resolve cluster ${cluster.id}`));

    const done = await api('POST', '/friction/resolve', { type: 'cluster', selector: cluster.id });
    assert.equal(done.count, 3);
    assert.deepEqual(done.resolved.map((t) => t.selector).sort(), ['.a1x', '.b1x', '.c1x']);
    const after = await api('GET', '/analytics');
    assert.equal(after.selectorFriction.length, 0, 'every target of the cluster stopped ranking');
    assert.equal(after.frictionClusters.length, 0);

    const undone = await api('POST', '/friction/unresolve', { type: 'cluster', targets: done.resolved });
    assert.equal(undone.count, 3);
    assert.equal((await api('GET', '/analytics')).frictionClusters.length, 1, 'undo brings the cluster back');
  }, { handlers: failingClicks });
});

test('resolving a cluster that does not exist is a clear 404, not a silent no-op', async () => {
  await withRelay(async ({ apiRaw }) => {
    const bad = await apiRaw('POST', '/friction/resolve', { type: 'cluster', selector: 'deadbeef' });
    assert.equal(bad.json.ok, false);
    assert.match(bad.json.error, /no cluster "deadbeef"/);
    const none = await apiRaw('POST', '/friction/resolve', { type: 'cluster' });
    assert.match(none.json.error, /cluster id is required/);
  });
});

test('buildFrictionClusters gives every cluster a stable id and, on request, every target', () => {
  const rows = [];
  for (const sel of ['.a1x', '.b1x', '.c1x', '.d1x']) {
    for (let n = 1; n <= 2; n += 1) rows.push({ session_id: n, type: 'dom.click', params: { selector: sel }, origin: ORIGIN, ok: 0, error: `Element not found: ${sel}`, started_at: `2026-01-0${n}T00:00:00Z`, duration_ms: 10 });
  }
  const entries = buildSelectorFriction(rows);
  const [a] = buildFrictionClusters(entries, { targetLimit: 2 });
  const [b] = buildFrictionClusters(entries, { targetLimit: Infinity });
  assert.equal(a.id, b.id);
  assert.equal(a.targets.length, 2);
  assert.equal(b.targets.length, 4);
  assert.ok(b.targets.every((t) => t.type === 'dom.click' && t.key));
});

// ---------- retention ----------

test('friction prune: dry run changes nothing; confirm drops old result bodies and keeps history and declarations', async () => {
  await withRelay(async ({ api, apiRaw, start, run, relay }) => {
    const s = await start('old work');
    for (let n = 0; n < 3; n += 1) await run('dom.click', { selector: `#ok-${n}` });
    await run('dom.click', { selector: '#primary' });
    await run('dom.click', { selector: '#primary' });
    await api('POST', `/sessions/${s.id}/end`);
    await api('POST', '/friction/resolve', { type: 'dom.click', selector: '#other' });
    await start('current'); // the active session is never touched

    // age the ended session's rows by editing the relay's own database file
    const { DatabaseSync } = await import('node:sqlite');
    const aged = () => {
      const db = new DatabaseSync(relay.env.WEBSCOUT_DB_PATH);
      try { db.prepare('UPDATE actions SET started_at = ? WHERE session_id = ?').run('2020-01-01T00:00:00.000Z', s.id); } finally { db.close(); }
    };
    aged();

    const tooShort = await apiRaw('POST', '/friction/prune', { days: 2 });
    assert.equal(tooShort.json.ok, false);
    assert.match(tooShort.json.error, />= 7/);

    const dry = await api('POST', '/friction/prune', { days: 30 });
    assert.equal(dry.dryRun, true);
    assert.ok(dry.oldResults.actions >= 5, JSON.stringify(dry));
    const readBodies = () => {
      const db = new DatabaseSync(relay.env.WEBSCOUT_DB_PATH, { readOnly: true });
      try { return db.prepare('SELECT COUNT(*) AS n FROM actions WHERE session_id = ? AND (result_json IS NOT NULL OR result_hash IS NOT NULL)').get(s.id).n; } finally { db.close(); }
    };
    const bodiesBefore = readBodies();
    assert.ok(bodiesBefore >= 3, 'the seeded successes carry result bodies');

    const totalBefore = (await api('GET', '/analytics')).totals.actions;
    const real = await api('POST', '/friction/prune', { days: 30, confirm: true });
    assert.equal(real.dryRun, false);
    assert.equal(readBodies(), 0, 'old bodies are gone');

    const analytics = await api('GET', '/analytics');
    assert.equal(analytics.totals.actions, totalBefore, 'no action row was deleted');
    assert.equal(analytics.failureRateByType.find((t) => t.type === 'dom.click').failed, 2, 'failure history is intact');
    assert.equal((await api('GET', '/friction/resolutions')).length, 1, 'declarations are intact');
  }, { handlers: failingClicks });
});

// ---------- incremental analytics ----------

test('analytics read incrementally equals a fresh read as actions keep arriving', async () => {
  await withRelay(async ({ api, start, run, relay }) => {
    const s = await start('growing');
    const snapshots = [];
    for (let round = 0; round < 3; round += 1) {
      for (let n = 0; n < 4; n += 1) await run('dom.click', { selector: n % 2 ? '.a1x' : `#ok-${round}-${n}` });
      snapshots.push(await api('GET', '/analytics'));
    }
    const totals = snapshots.map((a) => a.totals.actions);
    assert.ok(totals[0] >= 4 && totals[1] - totals[0] === totals[2] - totals[1] && totals[1] > totals[0], `every round adds the same number of rows: ${totals}`);
    assert.deepEqual(snapshots.map((a) => a.failureRateByType[0].failed), [2, 4, 6]);

    // a second relay process reading the same database from scratch must produce the same numbers
    await api('POST', `/sessions/${s.id}/end`);
    const warm = await api('GET', '/analytics');
    const cold = await startTestRelay({ env: { WEBSCOUT_ANALYTICS_CACHE_MS: '0', WEBSCOUT_DB_PATH: relay.env.WEBSCOUT_DB_PATH, WEBSCOUT_PID_PATH: `${relay.env.WEBSCOUT_PID_PATH}.cold` } });
    try {
      const coldAnalytics = (await (await fetch(`http://127.0.0.1:${cold.port}/analytics`)).json()).result;
      const pick = (a) => JSON.stringify({ totals: a.totals, rates: a.failureRateByType.map((t) => [t.type, t.total, t.failed]), selectors: a.selectorFriction.map((f) => [f.key, f.failCount, f.score]) });
      assert.equal(pick(warm), pick(coldAnalytics));
    } finally { await cold.stop(); }
  }, { handlers: failingClicks });
});

// ---------- scratch: a locked dir is retried in the background ----------

test('scratch-guard --reap removes a dir, refuses anything that is not a scratch dir', async () => {
  const dirPath = createScratchDir(PREFIXES[0]);
  fs.writeFileSync(path.join(dirPath, 'f.txt'), 'x');
  const guard = path.join(dir, 'scratch-guard.mjs');
  const ok = spawnSync(process.execPath, [guard, '--reap', dirPath], { encoding: 'utf8', timeout: 30000 });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(fs.existsSync(dirPath), false, 'the dir is gone');

  const stranger = fs.mkdtempSync(path.join(dir, 'not-a-scratch-dir-'));
  try {
    const refused = spawnSync(process.execPath, [guard, '--reap', stranger], { encoding: 'utf8', timeout: 30000 });
    assert.equal(refused.status, 2);
    assert.equal(fs.existsSync(stranger), true, 'a dir without a scratch prefix is never touched');
  } finally { fs.rmSync(stranger, { recursive: true, force: true }); }
});

// ---------- the warning and analytics describe a target's recoveries identically ----------

test('a target with more failing sessions than the recovery window reports the same "worked N of M" live and in analytics', async () => {
  await withRelay(async ({ api, start, run }) => {
    for (let n = 0; n < 8; n += 1) {
      const s = await start(`seed ${n}`);
      await run('dom.click', { selector: '#primary' });
      if (n !== 3) await run('dom.click', { selector: '#fallback' }); // one session where nothing recovered it
      await api('POST', `/sessions/${s.id}/end`);
    }
    await start('now');
    const live = await api('GET', `/friction/explain?type=dom.click&selector=${encodeURIComponent('#primary')}`);
    const fromAnalytics = (await api('GET', '/analytics')).selectorFriction.find((f) => f.selector === '#primary');
    assert.ok(live.history.recoveries[0], 'the live view found a recovery');
    assert.deepEqual(
      { worked: live.history.recoveries[0].worked, of: live.history.recoveries[0].of, retries: live.history.retries },
      { worked: fromAnalytics.recovery.worked, of: fromAnalytics.recovery.of, retries: fromAnalytics.retries },
    );
    assert.equal(fromAnalytics.recovery.of, 5, 'judged over the 5 most recent failing sessions, not all 8');
  }, { handlers: failingClicks });
});
