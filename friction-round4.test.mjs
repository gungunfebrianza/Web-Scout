// Friction awareness, round 4 - one more coherence pass over the same facts:
//   - page-level commands (reload, settle, screenshot, ...) are friction targets keyed by origin,
//   - `crv preflight --plan` and `crv run` consult the same facts as a bare command,
//   - session end can apply its "mark fixed?" suggestions,
//   - a known-issue candidate arrives with a remediation drawn from what worked,
//   - the other warnings (type failure rate, macro health) ride on the same facts.
// Real relay + fake tab, no browser; each test gets its own relay.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestRelay, connectFakeAgent } from './test-relay.mjs';
import { frictionTarget, frictionKeyFor, buildSelectorFriction, PAGE_TYPES } from './friction.mjs';

const ORIGIN = 'http://localhost:4100';

async function withRelay(fn, { handlers = {}, envOverride = {}, origin = ORIGIN } = {}) {
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
  const start = (goal) => api('POST', '/sessions', { goal, context: 'friction-round4.test.mjs', briefing: false });
  const run = (type, params = {}) => apiRaw('POST', '/command', { type, params });
  try {
    await fn({ api, apiRaw, start, run, relay });
  } finally {
    await tab.close();
    await relay.stop();
  }
}

// ---------- page-level targets ----------

test('a page-level command is a friction target keyed by origin; a targeted one still is not', () => {
  assert.deepEqual(frictionTarget('page.reload', {}, ORIGIN), { kind: 'page', value: ORIGIN });
  assert.equal(frictionTarget('page.reload', {}, null), null, 'no origin, no page target');
  assert.equal(frictionTarget('dom.click', {}, ORIGIN), null, 'a click with no selector is not a page-level command');
  assert.deepEqual(frictionTarget('dom.settle', { selector: '#x' }, ORIGIN), { kind: 'selector', value: '#x' }, 'an explicit selector wins');
  assert.notEqual(frictionKeyFor('page.reload', {}, ORIGIN), frictionKeyFor('page.reload', {}, 'http://localhost:4200'), 'two origins are two targets');
  assert.notEqual(frictionKeyFor('page.reload', {}, ORIGIN), frictionKeyFor('dom.settle', {}, ORIGIN), 'two commands are two targets');
  assert.ok(PAGE_TYPES.has('dom.screenshot'));
});

test('buildSelectorFriction accumulates page-level timeouts per origin', () => {
  const rows = [1, 2, 3].map((n) => ({ session_id: n, type: 'page.reload', params: {}, origin: ORIGIN, ok: 0, error: 'command timed out after 15000ms', started_at: `2026-01-0${n}T00:00:00Z`, duration_ms: 15000 }));
  const [entry] = buildSelectorFriction(rows);
  assert.equal(entry.targetKind, 'page');
  assert.equal(entry.selector, ORIGIN);
  assert.equal(entry.failCount, 3);
  assert.deepEqual(entry.errorClasses, { timeout: 3 });
});

test('live: page.reload timing out warns on the third attempt, and explain/resolve accept the origin', async () => {
  await withRelay(async ({ api, apiRaw, start, run }) => {
    await start('page timeouts');
    const first = await run('page.reload');
    await run('page.reload');
    const third = await run('page.reload');
    assert.equal(first.res.headers.get('x-webscout-selector-risk'), null);
    const header = third.res.headers.get('x-webscout-selector-risk');
    assert.match(header, /^page "http:\/\/localhost:4100" \(page\.reload\) has failed 2x already this session/);
    assert.equal(third.json.extra.selectorFriction.errorClass, 'timeout');

    const explain = await api('GET', `/friction/explain?type=page.reload&selector=${encodeURIComponent(ORIGIN)}`);
    assert.equal(explain.target.kind, 'page');
    assert.equal(explain.thisSession.fails, 3);

    const analytics = await api('GET', '/analytics');
    assert.ok(analytics.selectorFriction.some((f) => f.targetKind === 'page' && f.selector === ORIGIN && f.failCount === 3));

    await api('POST', '/friction/resolve', { type: 'page.reload', selector: ORIGIN, note: 'new proxy' });
    assert.ok(!(await api('GET', '/analytics')).selectorFriction.some((f) => f.selector === ORIGIN), 'a resolved page target stops ranking');
    const bad = await apiRaw('POST', '/friction/resolve', { type: 'page.reload' });
    assert.equal(bad.res.status, 400);
    assert.match(bad.json.error, /an origin is required/);
  }, { handlers: { 'page.reload': () => { throw new Error('command timed out after 15000ms'); } } });
});

// ---------- plan check (crv preflight --plan) and crv run ----------

const snapshotHandler = (p) => ({ stores: Object.fromEntries((p.stores ?? ['notes']).map((s) => [s, { keyPath: 'id', rows: [] }])) });
const brokenClick = () => { throw new Error('Element not found: #flaky'); };

test('preflight --plan lists the risky steps from the same facts the warning uses, and checks without consuming the warning', async () => {
  await withRelay(async ({ api, start, run }) => {
    await start('plan');
    await run('dom.click', { selector: '#flaky' });
    await run('dom.click', { selector: '#flaky' });
    const plan = [{ type: 'dom.click', params: { selector: '#fine' } }, { type: 'dom.click', params: { selector: '#flaky' } }, { type: 'ping' }, { type: 'dom.fill', params: { selector: '#flaky', value: 'x' } }];
    const report = await api('POST', '/crv/preflight', { agent: 'default', plan });
    assert.equal(report.planRisk.checked, 3, 'ping has no friction target');
    assert.deepEqual(report.planRisk.risky.map((r) => [r.step, r.type]), [[2, 'dom.click']]);
    assert.match(report.planRisk.risky[0].message, /failed 2x already this session/);
    // the check is read-only: the live warning still fires on the real attempt
    const real = await run('dom.click', { selector: '#flaky' });
    assert.match(real.res.headers.get('x-webscout-selector-risk') ?? '', /#flaky/);
    // and a second check still lists it (no once-per-session dedupe for a plan)
    assert.equal((await api('POST', '/crv/preflight', { agent: 'default', plan })).planRisk.risky.length, 1);
    assert.equal((await api('POST', '/crv/preflight', { agent: 'default' })).planRisk, undefined, 'no plan, no planRisk');
  }, { handlers: { 'dom.click': brokenClick, 'idb.list': () => ({ stores: ['notes'] }), 'dom.query': () => ({ found: true }), 'console.log': () => ({ entries: [] }) } });
});

test('crv run carries the same pre-action header as a bare command; a blocked one is refused before any baseline is taken', async () => {
  await withRelay(async ({ api, apiRaw, start, run }) => {
    const session = await start('crv run risk');
    await run('dom.click', { selector: '#flaky' });
    await run('dom.click', { selector: '#flaky' });
    const snapshots = async () => (await api('GET', `/sessions/${session.id}/snapshots`)).length;
    const first = await apiRaw('POST', '/crv/run', { stores: ['notes'], type: 'dom.click', params: { selector: '#flaky' } });
    assert.match(first.res.headers.get('x-webscout-selector-risk') ?? '', /#flaky/);
    assert.equal(first.json.ok, false, 'the click itself still fails - the header is a warning, not a block');
    const afterFirst = await snapshots();
    assert.ok(afterFirst >= 1, 'unblocked, it took its baseline as before');

    const blocked = await apiRaw('POST', '/crv/run', { stores: ['notes'], type: 'dom.click', params: { selector: '#flaky' } });
    assert.equal(blocked.res.status, 409, 'escalated, and WEBSCOUT_RISKY_BLOCK=1');
    assert.equal(await snapshots(), afterFirst, 'refused before the baseline snapshot - nothing left behind');

    const ack = await apiRaw('POST', '/crv/run', { stores: ['notes'], type: 'dom.click', params: { selector: '#flaky' }, ackRisk: true });
    assert.notEqual(ack.res.status, 409);
    assert.ok(await snapshots() > afterFirst, 'with ackRisk it runs');
  }, { handlers: { 'dom.click': brokenClick, 'idb.snapshot': snapshotHandler }, envOverride: { WEBSCOUT_RISKY_BLOCK: '1', WEBSCOUT_RISKY_ESCALATE_FAILS: '3' } });
});

// ---------- session end: apply the suggestions ----------

async function seedFixedTarget(ctx, setBroken) {
  const a = await ctx.start('breaking');
  for (let i = 0; i < 3; i += 1) await ctx.run('dom.click', { selector: '#flaky' });
  await ctx.api('POST', `/sessions/${a.id}/end`);
  setBroken(false);
  const b = await ctx.start('works one');
  await ctx.run('dom.click', { selector: '#flaky' }); await ctx.run('dom.click', { selector: '#flaky' });
  await ctx.api('POST', `/sessions/${b.id}/end`);
  const c = await ctx.start('works two');
  await ctx.run('dom.click', { selector: '#flaky' }); await ctx.run('dom.click', { selector: '#flaky' });
  return c;
}

test('session end only suggests by default, and --apply-suggestions resolves what it would have suggested', async () => {
  for (const apply of [false, true]) {
    let broken = true;
    const handlers = { 'dom.click': () => { if (broken) throw new Error('Element not found: #flaky'); return { clicked: true, mutated: false }; } };
    await withRelay(async (ctx) => {
      const c = await seedFixedTarget(ctx, (v) => { broken = v; });
      const ended = await ctx.api('POST', `/sessions/${c.id}/end`, apply ? { applySuggestions: true } : undefined);
      const stored = await ctx.api('GET', '/friction/resolutions');
      if (!apply) {
        assert.equal(ended.resolveSuggestions.length, 1);
        assert.equal(ended.appliedResolutions, undefined);
        assert.equal(stored.length, 0);
      } else {
        assert.equal(ended.resolveSuggestions, undefined, 'nothing left to suggest');
        assert.equal(ended.appliedResolutions.length, 1);
        assert.equal(ended.appliedResolutions[0].selector, '#flaky');
        assert.match(stored[0].note, /--apply-suggestions/);
        assert.equal((await ctx.api('GET', '/analytics')).resolveSuggestions.length, 0);
      }
    }, { handlers });
  }
});

// ---------- known-issue candidate: a remediation drawn from what worked ----------

test('a known-issue candidate arrives with a suggested remediation; promote previews it but never writes it unconfirmed', async () => {
  const handlers = { 'dom.click': (p) => { if (p.selector.startsWith('#primary')) throw new Error(`Element not found: ${p.selector}`); return { clicked: true, mutated: false }; } };
  await withRelay(async ({ api, apiRaw, start, run }) => {
    for (let n = 1; n <= 3; n += 1) {
      const s = await start(`seed ${n}`);
      await run('dom.click', { selector: `#primary${n}0` }); // normalizes to one selector
      await run('dom.click', { selector: '#fallback' });
      await api('POST', `/sessions/${s.id}/end`);
    }
    const [candidate] = (await api('GET', '/analytics')).knownIssueCandidates;
    assert.equal(candidate.suggestedFrom, 'recovery');
    assert.match(candidate.suggestedRemediation, /use "#fallback" \(dom\.click\) instead - it worked 3 of 3 times after this failure/);
    assert.equal(candidate.draft.remediation, 'TODO', 'the draft itself still has no invented fix');

    const dry = await api('POST', '/known-issues/promote', { id: candidate.draft.id, description: 'primary renders late' });
    assert.equal(dry.written, false);
    assert.equal(dry.needsRemediation, true);
    assert.equal(dry.wouldWrite.remediation, candidate.suggestedRemediation);

    const confirmed = await apiRaw('POST', '/known-issues/promote', { id: candidate.draft.id, description: 'primary renders late', confirm: true });
    assert.equal(confirmed.res.status, 400, 'a suggestion is never written on its own');
    assert.match(confirmed.json.error, /suggested:/);
  }, { handlers });
});

test('with nothing that worked, the suggestion falls back to the advice for the error class', async () => {
  await withRelay(async ({ api, start, run }) => {
    await start('no recovery');
    for (let n = 0; n < 3; n += 1) await run('dom.click', { selector: `#gone${n}0` });
    const [candidate] = (await api('GET', '/analytics')).knownIssueCandidates;
    assert.equal(candidate.suggestedFrom, 'advice');
    assert.match(candidate.suggestedRemediation, /confirm the selector with dom\.query/);
  }, { handlers: { 'dom.click': (p) => { throw new Error(`Element not found: ${p.selector}`); } } });
});

// ---------- the CLI and MCP front ends ----------

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnClean } from './test-relay.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const cliFor = (relay) => (...args) => spawnClean([path.join(here, 'cli.mjs'), ...args], { env: { WEBSCOUT_PORT: String(relay.port), WEBSCOUT_NO_AUTORESTART: '1' }, cwd: here, timeout: 60000 });

test('CLI: crv preflight --plan prints planRisk; session end --apply-suggestions says what it marked fixed', async () => {
  let broken = true;
  const handlers = {
    'dom.click': () => { if (broken) throw new Error('Element not found: #flaky'); return { clicked: true, mutated: false }; },
    'idb.list': () => ({ stores: ['notes'] }), 'console.log': () => ({ entries: [] }),
  };
  await withRelay(async (ctx) => {
    const cli = cliFor(ctx.relay);
    const c = await seedFixedTarget(ctx, (v) => { broken = v; });
    const plan = JSON.stringify([{ type: 'dom.click', params: { selector: '#flaky' } }]);
    // the target worked in the last two sessions, so it is quiet in the plan check
    const quiet = cli('crv', 'preflight', '--plan', plan);
    assert.equal(quiet.status, 0, quiet.stderr);
    assert.equal(JSON.parse(quiet.stdout).planRisk.risky.length, 0);

    const ended = cli('session', 'end', '--apply-suggestions');
    assert.equal(ended.status, 0, ended.stderr);
    assert.match(ended.stderr, /NOTE: marked fixed: dom\.click "#flaky" \(undo: friction unresolve dom\.click "#flaky"\)/);
    assert.doesNotMatch(ended.stderr, /mark fixed\?/);
    assert.equal(c.id > 0, true);
  }, { handlers });
});

test('CLI: friction explain / resolve take an origin for a page-level command', async () => {
  await withRelay(async (ctx) => {
    const cli = cliFor(ctx.relay);
    await ctx.start('page cli');
    for (let i = 0; i < 2; i += 1) await ctx.run('dom.settle', {});
    const explain = cli('friction', 'explain', 'dom.settle', ORIGIN);
    assert.equal(explain.status, 0, explain.stderr);
    assert.equal(JSON.parse(explain.stdout).target.kind, 'page');
    const resolved = cli('friction', 'resolve', 'dom.settle', ORIGIN, '--note', 'proxy fixed');
    assert.equal(resolved.status, 0, resolved.stderr);
    assert.match(resolved.stdout, /proxy fixed/);
  }, { handlers: { 'dom.settle': () => { throw new Error('command timed out after 15000ms'); } } });
});

test('MCP and CLI documents the new params (plan, applySuggestions) and the page-level origin', () => {
  const mcp = fs.readFileSync(path.join(here, 'mcp-server.mjs'), 'utf8');
  assert.match(mcp, /crv_preflight \{stores\?, selector\?, plan\?\}/);
  assert.match(mcp, /end \{id\?, trace\?, applySuggestions\?\}/);
  assert.match(mcp, /pass the origin as selector/);
  assert.match(mcp, /ackRisk: p\?\.ackRisk === true/, 'crv_run forwards ackRisk like any other command');
});
