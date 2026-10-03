// Round 9 - the notice loop closed: snooze (quiet, not fixed), the check gate, the known-issue review queue, shareable
// friction state, and every surface (HTTP, CLI exit status, MCP) saying the same thing. Real relay + fake tab, no browser.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpDir } from './scratch.mjs';
import { startTestRelay, connectFakeAgent } from './test-relay.mjs';
import * as friction from './friction.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const ORIGIN = 'http://localhost:4100';

async function withRelay(fn, { handlers = {}, envOverride = {} } = {}) {
  const relay = await startTestRelay({ env: { WEBSCOUT_ANALYTICS_CACHE_MS: '0', WEBSCOUT_NO_AUTOSTART: '1', ...envOverride } });
  const tab = await connectFakeAgent(relay.port, handlers, { origin: ORIGIN });
  const apiRaw = async (method, route, body) => {
    const res = await fetch(`http://127.0.0.1:${relay.port}${route}`, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
    return { res, json: await res.json() };
  };
  const api = async (method, route, body) => {
    const { json } = await apiRaw(method, route, body);
    if (!json.ok) throw new Error(json.error || `request failed: ${route}`);
    return json.result;
  };
  const start = (goal) => api('POST', '/sessions', { goal, context: 'friction-round9.test.mjs', briefing: false });
  const run = (type, params = {}) => apiRaw('POST', '/command', { type, params });
  const cli = (...args) => spawnSync(process.execPath, [path.join(dir, 'cli.mjs'), ...args], { encoding: 'utf8', env: { ...process.env, ...relay.env, WEBSCOUT_NO_AUTOSTART: '1' }, timeout: 30000 });
  try { await fn({ api, apiRaw, start, run, relay, tab, cli }); } finally { await tab.close(); await relay.stop(); }
}

async function withMcp(relay, fn) {
  const child = spawn(process.execPath, [path.join(dir, 'mcp-server.mjs')], { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, ...relay.env, WEBSCOUT_NO_AUTOSTART: '1' } });
  const rl = readline.createInterface({ input: child.stdout, terminal: false });
  const pending = new Map();
  let seq = 0;
  rl.on('line', (line) => { try { const m = JSON.parse(line); if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } catch { /* not a reply */ } });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = (seq += 1);
    const timer = setTimeout(() => reject(new Error(`mcp ${method} timed out`)), 20000);
    pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  try {
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'round9', version: '0' } });
    await fn({ meta: async (params) => JSON.parse(((await rpc('tools/call', { name: 'webscout_meta', arguments: { action: 'friction', params } })).result.content[0]).text) });
  } finally { child.stdin.end(); child.kill(); }
}

const failing = (...selectors) => ({ 'dom.click': (p) => { if (selectors.includes(p.selector)) throw new Error(`Element not found: ${p.selector}`); return { clicked: true, mutated: false, selector: p.selector }; } });

// ---------- pure pieces ----------

test('parseSnoozeUntil takes spans and dates, refuses the past, nonsense and a silent mute', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  assert.equal(friction.parseSnoozeUntil('30m', now), '2026-01-01T00:30:00.000Z');
  assert.equal(friction.parseSnoozeUntil('2d', now), '2026-01-03T00:00:00.000Z');
  assert.equal(friction.parseSnoozeUntil('1w', now), '2026-01-08T00:00:00.000Z');
  assert.equal(friction.parseSnoozeUntil('2026-02-01', now), '2026-02-01T00:00:00.000Z');
  assert.throws(() => friction.parseSnoozeUntil('soon', now), /30m, 12h, 2d, 1w/);
  assert.throws(() => friction.parseSnoozeUntil('2025-12-31', now), /already passed/);
  assert.throws(() => friction.parseSnoozeUntil('200d', now), /at most 90 days/);
});

test('a snoozed target evaluates quiet and says why', () => {
  const entry = { key: 'k', fails: 5, unresolved: 5, sessionCount: 2, errorClasses: { 'not-found': 5 }, origins: {}, lastFailedAt: '2026-01-01T00:00:00Z' };
  const base = { type: 'dom.click', selector: '#x', entry, live: { fails: 2, unresolved: 2 }, state: null, origin: null };
  const loud = friction.evaluateSelectorRisk(base);
  const quiet = friction.evaluateSelectorRisk({ ...base, snoozedUntil: '2999-01-01T00:00:00.000Z' });
  assert.ok(loud.assessment || /quiet/.test(loud.reason));
  assert.equal(quiet.assessment, null);
  assert.match(quiet.reason, /snoozed until 2999/);
});

// ---------- snooze ----------

test('snooze quiets the warning without claiming a fix; unsnooze brings it back; both are visible on every surface', async () => {
  await withRelay(async ({ api, apiRaw, start, run, cli, relay }) => {
    const first = await start('round9 snooze one');
    for (let n = 0; n < 3; n += 1) await run('dom.click', { selector: '.s9x' });
    await api('POST', `/sessions/${first.id}/end`);
    await start('round9 snooze two');
    const before = await api('GET', `/friction/explain?type=dom.click&selector=${encodeURIComponent('.s9x')}`);
    assert.equal(before.wouldWarn, true);
    assert.ok(before.next.some((s) => s.label.startsWith('snooze')), 'explain offers the snooze step');

    const dry = await apiRaw('POST', '/friction/snooze', { type: 'dom.click', selector: '.s9x', for: 'whenever' });
    assert.equal(dry.json.ok, false);
    assert.match(dry.json.error, /30m, 12h, 2d, 1w/);

    const snoozed = await api('POST', '/friction/snooze', { type: 'dom.click', selector: '.s9x', for: '2d', note: 'flaky until the redesign' });
    assert.ok(snoozed.until > new Date().toISOString());
    const after = await api('GET', `/friction/explain?type=dom.click&selector=${encodeURIComponent('.s9x')}`);
    assert.equal(after.wouldWarn, false);
    assert.match(after.decision, /snoozed until/);
    assert.equal(after.snoozedUntil, snoozed.until);
    assert.ok(after.next.some((s) => s.label === 'hear about it again'));
    assert.equal(after.resolution, null, 'a snooze is not a fix');

    const list = await api('GET', '/friction/snoozes');
    assert.equal(list.count, 1);
    assert.equal(list.snoozes[0].note, 'flaky until the redesign');
    const viaCli = JSON.parse(cli('friction', 'snoozes').stdout);
    assert.deepEqual(viaCli, list, 'CLI equals HTTP');

    await withMcp(relay, async ({ meta }) => {
      assert.deepEqual(await meta({ sub: 'snoozes' }), list, 'MCP equals HTTP');
      await meta({ sub: 'unsnooze', type: 'dom.click', selector: '.s9x' });
    });
    assert.equal((await api('GET', '/friction/snoozes')).count, 0);
    assert.equal((await api('GET', `/friction/explain?type=dom.click&selector=${encodeURIComponent('.s9x')}`)).wouldWarn, true);
    await assert.rejects(api('POST', '/friction/unsnooze', { type: 'dom.click', selector: '.s9x' }), /no such friction snooze/);
  }, { handlers: failing('.s9x') });
});

// ---------- known-issue review queue ----------

test('review lists what is past reviewBy with renew / retire; both write only on confirm', async () => {
  const d = tmpDir('webscout-round9-ki-');
  const local = path.join(d, 'local.json');
  fs.writeFileSync(local, JSON.stringify([
    { id: 'stale', signature: 'zzz-stale', remediation: 'wait first', description: 'old workaround', reviewBy: '2020-01-01' },
    { id: 'fresh', signature: 'zzz-fresh', remediation: 'n/a', reviewBy: '2999-01-01' },
    { id: 'undated', signature: 'zzz-undated', remediation: 'n/a' },
  ]));
  await withRelay(async ({ api, apiRaw, cli, relay }) => {
    const review = await api('GET', '/known-issues/review');
    assert.equal(review.count, 1);
    assert.deepEqual(review.due.map((e) => e.id), ['stale']);
    assert.deepEqual(review.due[0].next.map((s) => s.http), ['POST /known-issues/renew', 'POST /known-issues/retire']);
    assert.deepEqual(JSON.parse(cli('known-issues', 'review').stdout), review, 'CLI equals HTTP');
    await withMcp(relay, async ({ meta }) => assert.deepEqual(await meta({ sub: 'review' }), review, 'MCP equals HTTP'));

    const bad = await apiRaw('POST', '/known-issues/renew', { id: 'stale', reviewBy: '2020-02-02' });
    assert.match(bad.json.error, /in the future/);
    const dry = await api('POST', '/known-issues/renew', { id: 'stale', reviewBy: '2999-12-31' });
    assert.equal(dry.written, false);
    assert.equal(JSON.parse(fs.readFileSync(local, 'utf8'))[0].reviewBy, '2020-01-01', 'a dry run writes nothing');
    const done = await api('POST', '/known-issues/renew', { id: 'stale', reviewBy: '2999-12-31', confirm: true });
    assert.equal(done.written, true);
    assert.equal((await api('GET', '/known-issues/review')).count, 0);

    const dryRetire = await api('POST', '/known-issues/retire', { id: 'fresh' });
    assert.equal(dryRetire.written, false);
    assert.equal(JSON.parse(fs.readFileSync(local, 'utf8')).length, 3);
    await api('POST', '/known-issues/retire', { id: 'fresh', confirm: true });
    assert.deepEqual(JSON.parse(fs.readFileSync(local, 'utf8')).map((e) => e.id), ['stale', 'undated']);
    assert.equal((await apiRaw('POST', '/known-issues/retire', { id: 'nope', confirm: true })).json.ok, false);
  }, { envOverride: { WEBSCOUT_KNOWN_ISSUES: local } });
});

// ---------- the gate ----------

test('friction check: ok when quiet, not ok for a review overdue or a relapse; failOn narrows; the CLI exits 1 when not ok', async () => {
  const d = tmpDir('webscout-round9-check-');
  const local = path.join(d, 'local.json');
  fs.writeFileSync(local, '[]');
  await withRelay(async ({ api, apiRaw, start, run, cli, relay }) => {
    const clean = await api('GET', '/friction/check');
    assert.equal(clean.ok, true);
    assert.deepEqual(clean.counts, { worsening: 0, review: 0, relapse: 0 });
    assert.equal(cli('friction', 'check').status, 0);

    const badKind = await apiRaw('GET', '/friction/check?failOn=nonsense');
    assert.equal(badKind.json.ok, false);

    fs.writeFileSync(local, JSON.stringify([{ id: 'due', signature: 'zzz', remediation: 'x', reviewBy: '2020-01-01' }]));
    const review = await api('GET', '/friction/check');
    assert.equal(review.ok, false);
    assert.equal(review.counts.review, 1);
    assert.equal(review.problems[0].next[0].cli, 'known-issues review');
    assert.equal((await api('GET', '/friction/check?failOn=worsening,relapse')).ok, true, 'failOn leaves the review out');
    const failed = cli('friction', 'check');
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /REVIEW: known issue "due"/);
    assert.equal(cli('friction', 'check', '--fail-on', 'relapse').status, 0);
    await withMcp(relay, async ({ meta }) => assert.deepEqual(await meta({ sub: 'check', failOn: 'review' }), await api('GET', '/friction/check?failOn=review'), 'MCP equals HTTP'));

    fs.writeFileSync(local, '[]');
    const one = await start('round9 relapse one');
    for (let n = 0; n < 2; n += 1) await run('dom.click', { selector: '.c9x' });
    await api('POST', `/sessions/${one.id}/end`);
    await api('POST', '/friction/resolve', { type: 'dom.click', selector: '.c9x' });
    await new Promise((r) => setTimeout(r, 1100)); // dates are second-granular
    await start('round9 relapse two');
    await run('dom.click', { selector: '.c9x' });
    const relapse = await api('GET', '/friction/check');
    assert.equal(relapse.ok, false);
    assert.equal(relapse.counts.relapse, 1);
    // snoozing the target takes it out of the gate
    await api('POST', '/friction/snooze', { type: 'dom.click', selector: '.c9x', for: '1d' });
    assert.equal((await api('GET', '/friction/check')).ok, true);
  }, { handlers: { 'dom.click': (p) => { if (p.selector === '.c9x') throw new Error('Element not found: .c9x'); return { clicked: true }; } }, envOverride: { WEBSCOUT_KNOWN_ISSUES: local } });
});

// ---------- friction state ----------

test('export / import carries fixed and snoozed state: a dry run first, existing entries left alone', async () => {
  let exported;
  await withRelay(async ({ api, start, run }) => {
    const s = await start('round9 state');
    await run('dom.click', { selector: '.e9x' });
    await api('POST', `/sessions/${s.id}/end`);
    await api('POST', '/friction/resolve', { type: 'dom.click', selector: '.e9x', note: 'shipped' });
    await api('POST', '/friction/snooze', { type: 'dom.click', selector: '.e9y', for: '1w' });
    exported = await api('GET', '/friction/export');
    assert.equal(exported.version, 1);
    assert.equal(exported.resolutions.length, 1);
    assert.equal(exported.snoozes.length, 1);
    const same = await api('POST', '/friction/import', { state: exported, confirm: true });
    assert.equal(same.written, false, 'importing into the same relay adds nothing');
    assert.equal(same.skipped.length, 2);
  }, { handlers: failing('.e9x') });
  await withRelay(async ({ api, apiRaw, cli }) => {
    assert.equal((await apiRaw('POST', '/friction/import', { state: 'nope' })).json.ok, false);
    const dry = await api('POST', '/friction/import', { state: exported });
    assert.equal(dry.written, false);
    assert.deepEqual(dry.wouldAdd, { resolutions: 1, snoozes: 1 });
    assert.equal((await api('GET', '/friction/resolutions')).length, 0, 'a dry run adds nothing');
    const file = path.join(tmpDir('webscout-round9-state-'), 'state.json');
    fs.writeFileSync(file, JSON.stringify(exported));
    const viaCli = cli('friction', 'import', file, '--confirm');
    assert.equal(viaCli.status, 0, viaCli.stderr);
    assert.deepEqual(JSON.parse(viaCli.stdout).added, { resolutions: 1, snoozes: 1 });
    assert.equal((await api('GET', '/friction/resolutions'))[0].note, 'shipped');
    assert.equal((await api('GET', '/friction/snoozes')).count, 1);
  });
});

// ---------- the ends of the loop ----------

test('session end hands back next steps; session start mentions known issues past their review date', async () => {
  const d = tmpDir('webscout-round9-ends-');
  const local = path.join(d, 'local.json');
  fs.writeFileSync(local, JSON.stringify([{ id: 'late', signature: 'zzz', remediation: 'x', reviewBy: '2020-01-01' }]));
  await withRelay(async ({ api, start, run, cli }) => {
    const s = await api('POST', '/sessions', { goal: 'round9 ends', context: 'friction-round9.test.mjs', briefing: false });
    assert.equal(s.reviewNotice.kind, 'review-due');
    assert.match(s.reviewNotice.message, /late/);
    assert.equal(s.reviewNotice.next[0].cli, 'known-issues review');
    await run('dom.click', { selector: '.ok9' });
    const ended = await api('POST', `/sessions/${s.id}/end`);
    assert.deepEqual(ended.next.map((c) => c.label), ['read the report', 'run the gate']);
    assert.equal(ended.next[0].http, `GET /sessions/${s.id}/report`);

    // the CLI prints the same steps
    const second = await start('round9 ends cli');
    const viaCli = cli('session', 'end', String(second.id));
    assert.match(viaCli.stderr, /Next: read the report: session report \d+; run the gate: friction check/);
  }, { envOverride: { WEBSCOUT_KNOWN_ISSUES: local } });
});

test('a macro step that fails says why, offers the resume, and the steps are runnable', async () => {
  let broken = false;
  await withRelay(async ({ api, start, run }) => {
    const rec = await start('round9 heal flow');
    await run('dom.click', { selector: '.h9a' });
    await run('dom.click', { selector: '.h9b' });
    await api('POST', `/sessions/${rec.id}/end`);
    const macro = await api('POST', '/macros', { name: 'heal-flow', sessionId: rec.id });
    await start('round9 heal flow');
    broken = true;
    const out = await api('POST', `/macros/${macro.id}/run`, { confirm: true });
    assert.equal(out.heal.step, 2);
    assert.equal(out.heal.errorClass, 'not-found');
    assert.deepEqual(out.heal.next.map((c) => c.label), ['why', 'resume from step 2']);
    assert.equal(out.heal.next[1].body.fromStep, 1);
    assert.equal(out.results.length, 2);
    // a resume is a step the relay can run (POST, so it needs confirm; the dry-run rule applies like any write)
    broken = false;
    const resumed = await api('POST', `/macros/${macro.id}/run`, out.heal.next[1].body);
    assert.equal(resumed.heal, undefined);
    assert.equal(resumed.ranSteps, 1);
  }, { handlers: { 'dom.click': (p) => { if (broken && p.selector === '.h9b') throw new Error('Element not found: .h9b'); return { clicked: true, mutated: false }; } } });
});

test('macroSwapCommand rewrites one step and nothing else', async () => {
  const { macroSwapCommand } = await import('./notices.mjs');
  const steps = [{ type: 'dom.click', params: { selector: '#a' } }, { type: 'dom.click', params: { selector: '#b', x: 1 } }];
  const swap = macroSwapCommand(7, steps, 1, '#b', '#c');
  assert.equal(swap.http, 'PUT /macros/7/steps');
  assert.deepEqual(swap.body.steps, [{ type: 'dom.click', params: { selector: '#a' } }, { type: 'dom.click', params: { selector: '#c', x: 1 } }]);
  assert.deepEqual(steps[1].params, { selector: '#b', x: 1 }, 'the original is untouched');
});
