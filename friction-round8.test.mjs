// Round 8 - one capability, four surfaces, finished: notices you can act on (friction next), refusals that say what to do
// (error notices), better-or-worse over time (friction trend), macro health, a replay that says where it diverged,
// a known-issue lifecycle, MCP resource subscriptions, and describe in an MCP caller's own terms.
// Real relay + fake tab, no browser.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpDir } from './scratch.mjs';
import { startTestRelay, connectFakeAgent } from './test-relay.mjs';
import * as friction from './friction.mjs';
import { errorNotice, parseHttpStep, renderSteps } from './notices.mjs';
import { mcpForm } from './help.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const ORIGIN = 'http://localhost:4100';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRelay(fn, { handlers = {}, envOverride = {} } = {}) {
  const relay = await startTestRelay({ env: { WEBSCOUT_ANALYTICS_CACHE_MS: '0', WEBSCOUT_NO_AUTOSTART: '1', ...envOverride } });
  const tab = await connectFakeAgent(relay.port, handlers, { origin: ORIGIN });
  const apiRaw = async (method, route, body) => {
    const res = await fetch(`http://127.0.0.1:${relay.port}${route}`, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
    return { res, json: await res.json() };
  };
  const api = async (method, route, body) => {
    const { json } = await apiRaw(method, route, body);
    if (!json.ok) throw Object.assign(new Error(json.error || `request failed: ${route}`), { extra: json.extra });
    return json.result;
  };
  const start = (goal, extra = {}) => api('POST', '/sessions', { goal, context: 'friction-round8.test.mjs', briefing: false, ...extra });
  const run = (type, params = {}) => apiRaw('POST', '/command', { type, params });
  try { await fn({ api, apiRaw, start, run, relay, tab }); } finally { await tab.close(); await relay.stop(); }
}

async function withMcp(relay, fn) {
  const child = spawn(process.execPath, [path.join(dir, 'mcp-server.mjs')], { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, ...relay.env, WEBSCOUT_NO_AUTOSTART: '1' } });
  const rl = readline.createInterface({ input: child.stdout, terminal: false });
  const pending = new Map();
  const notifications = [];
  let seq = 0;
  rl.on('line', (line) => {
    try {
      const m = JSON.parse(line);
      if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } else if (m.method) notifications.push(m);
    } catch { /* not a reply */ }
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = (seq += 1);
    const timer = setTimeout(() => reject(new Error(`mcp ${method} timed out`)), 20000);
    pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  try {
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'round8', version: '0' } });
    await fn({ rpc, init: init.result, notifications, callTool: async (name, args) => { const m = await rpc('tools/call', { name, arguments: args }); return { isError: Boolean(m.result?.isError), texts: (m.result?.content ?? []).map((c) => c.text) }; } });
  } finally { child.stdin.end(); child.kill(); }
}

const failing = (...selectors) => ({ 'dom.click': (p) => { if (selectors.includes(p.selector)) throw new Error(`Element not found: ${p.selector}`); return { clicked: true, mutated: false, selector: p.selector }; } });

// ---------- pure pieces ----------

test('errorNotice recognises the refusals callers hit most and nothing else', () => {
  const none = errorNotice({ status: 409, message: 'no active session - context and goal must be defined before any action.' });
  assert.equal(none.kind, 'error');
  assert.equal(none.key, 'no-session');
  assert.match(renderSteps(none, 'cli'), /start a session: session start "<goal>"/);
  assert.match(renderSteps(none, 'mcp'), /webscout_session\.start/);
  assert.match(renderSteps(none, 'http'), /POST \/sessions/);
  assert.equal(errorNotice({ status: 502, message: "no web-scout agent named 'default' connected - open the target page" }).key, 'no-agent');
  assert.equal(errorNotice({ status: 404, message: 'no such session: 99' }).key, 'no-such-session');
  assert.equal(errorNotice({ status: 400, message: 'something unrelated' }), null);
});

test('a notice step is run from its http form: reads at once, anything else flagged as writing', () => {
  assert.deepEqual(parseHttpStep({ http: 'GET /friction/trend?type=dom.click' }), { method: 'GET', path: '/friction/trend?type=dom.click', body: {}, mutating: false });
  assert.deepEqual(parseHttpStep({ http: 'POST /friction/resolve', body: { type: 'dom.click', selector: '#a' } }), { method: 'POST', path: '/friction/resolve', body: { type: 'dom.click', selector: '#a' }, mutating: true });
  assert.equal(parseHttpStep({ cli: 'no http form' }), null);
  assert.equal(parseHttpStep({ http: 'PATCH /x' }), null, 'only the verbs the relay serves');
});

test('buildFrictionTrend: worse, better, and a fix that held', () => {
  const at = (n) => `2026-01-0${n}T00:00:00.000Z`;
  const rows = [];
  const add = (session, ok, n) => rows.push({ session_id: session, ok, type: 'dom.click', params: { selector: '#x' }, started_at: at(n), error: ok ? null : 'Element not found' });
  // session 1: 1 of 4 failed; session 2: 1 of 2; session 3: 3 of 3 -> worsening
  add(1, false, 1); add(1, true, 1); add(1, true, 1); add(1, true, 1);
  add(2, false, 2); add(2, true, 2);
  add(3, false, 3); add(3, false, 3); add(3, false, 3);
  const key = friction.frictionKeyFor('dom.click', { selector: '#x' });
  const worse = friction.buildFrictionTrend(rows, { key })[0];
  assert.equal(worse.direction, 'worsening');
  assert.deepEqual(worse.points.map((p) => p.rate), [0.25, 0.5, 1]);
  assert.equal(worse.sparkline.length, 3);

  const better = rows.map((r) => ({ ...r, ok: r.session_id === 3 ? true : r.ok }));
  const fixed = friction.buildFrictionTrend(better, { key, resolutions: new Map([[key, at(2)]]) })[0];
  assert.equal(fixed.direction, 'improving');
  assert.equal(fixed.points[2].afterFix, true, 'a session that began after the declared fix is marked');
  assert.equal(fixed.points[0].afterFix, undefined);

  const summary = friction.summarizeTrends(friction.buildFrictionTrend(rows));
  assert.equal(summary.worsening[0].selector, '#x');
  assert.deepEqual(summary.improving, []);
  assert.equal(friction.buildFrictionTrend([rows[0]], { key })[0].direction, 'new', 'one session is not a trend');
});

test('buildReplayDiff names the first step that stopped matching, and not the reproduction itself', () => {
  const diff = friction.buildReplayDiff([
    { index: 0, type: 'dom.click', original: { ok: true, durationMs: 40, result: { clicked: true, at: 1 } }, replay: { ok: true, durationMs: 45, result: { clicked: true, at: 2 } } },
    { index: 1, type: 'dom.fill', original: { ok: true, durationMs: 40, result: { value: 'a' } }, replay: { ok: true, durationMs: 40, result: { value: 'b' } } },
    { index: 2, type: 'dom.click', original: { ok: false, error: 'Element not found: #gone' }, replay: { ok: false, error: 'Element not found: #gone' } },
  ]);
  assert.equal(diff.compared, 3);
  assert.equal(diff.firstDivergence.index, 1);
  assert.equal(diff.firstDivergence.kind, 'result-changed');
  assert.deepEqual(diff.firstDivergence.changed, ['value'], 'volatile fields (at, durationMs) are ignored');
  assert.deepEqual(diff.steps.map((s) => s.kind), ['result-changed', 'same-failure']);
  const works = friction.buildReplayDiff([{ index: 0, type: 'dom.click', original: { ok: false, error: 'timed out' }, replay: { ok: true } }]);
  assert.equal(works.firstDivergence.kind, 'now-works');
  const slow = friction.buildReplayDiff([{ index: 0, type: 'dom.wait', original: { ok: true, durationMs: 100 }, replay: { ok: true, durationMs: 2000 } }]);
  assert.equal(slow.firstDivergence.kind, 'slower');
  assert.equal(friction.buildReplayDiff([{ index: 0, type: 'dom.click', original: { ok: false, error: 'timed out' }, replay: { ok: false, error: 'Element not found' } }]).firstDivergence.kind, 'different-failure');
});

test('buildMacroRuns groups bursts and summarizeMacroRuns reports the first failed step of the last run', () => {
  const row = (macroId, ok, n) => ({ params: { macroId }, ok, type: 'dom.click', started_at: `2026-01-01T00:00:0${n}.000Z`, session_id: 1, error: ok ? null : 'Element not found' });
  const runs = friction.buildMacroRuns([row(1, true, 1), row(1, true, 2), { params: {}, ok: true, type: 'x', started_at: '2026-01-01T00:00:03.000Z' }, row(1, true, 4), row(1, false, 5)]);
  const summary = friction.summarizeMacroRuns(runs.get(1));
  assert.equal(summary.runs, 2);
  assert.equal(summary.passRate, 0.5);
  assert.deepEqual(summary.strip, [true, false]);
  assert.equal(summary.lastRun.ok, false);
  assert.equal(summary.lastRun.failedStep.step, 2);
  assert.equal(friction.summarizeMacroRuns(undefined).lastRun, null);
});

test('mcpForm rewrites a command\'s help into the params an MCP caller passes', () => {
  const form = mcpForm('  friction prune [--days N] [--notice-days N] [--confirm]\n  also --out file and --agent x', {
    bool: ['--confirm'], val: ['--days', '--notice-days', '--out'],
    params: { '--days': 'days', '--notice-days': 'noticeDays', '--confirm': 'confirm' }, cliOnly: { '--out': 'writes a local file' },
  });
  assert.match(form.help, /\[noticeDays N\]/);
  assert.doesNotMatch(form.help, /--notice-days/);
  assert.match(form.help, /--out \(CLI only\)/, 'a flag with no param is marked');
  assert.deepEqual(form.params.find((p) => p.name === 'confirm'), { name: 'confirm', type: 'boolean', from: '--confirm' });
  assert.deepEqual(form.cliOnly, ['--out']);
});

// ---------- the relay ----------

test('a refusal carries a notice with the way out, and the client appends it in its own style', async () => {
  await withRelay(async ({ apiRaw, relay }) => {
    const { res, json } = await apiRaw('POST', '/command', { type: 'dom.click', params: { selector: '#a' } });
    assert.equal(res.status, 409);
    assert.equal(json.notice.key, 'no-session');
    assert.equal(json.notice.next[0].http, 'POST /sessions');

    const plain = await apiRaw('GET', '/sessions/9999');
    assert.equal(plain.json.notice.key, 'no-such-session');
    const other = await apiRaw('POST', '/macros', {});
    assert.equal(other.json.notice, undefined, 'an unrecognised error gets no notice, only its message');

    await withMcp(relay, async ({ callTool }) => {
      const out = await callTool('webscout_dom', { action: 'click', params: { selector: '#a' } });
      assert.equal(out.isError, true);
      assert.match(out.texts[0], /no active session/);
      assert.match(out.texts[0], /Next: start a session: webscout_session\.start \{"goal":"<goal>"\}/, 'an MCP caller is told what to CALL');
    });
  });
});

test('friction next lists a notice\'s steps, runs a read at once and holds a write for confirm - over HTTP and MCP alike', async () => {
  await withRelay(async ({ api, start, run, relay }) => {
    // History from an earlier session warns the next one at its first call; with nothing failing yet live, the notice
    // offers "mark fixed" as well as "why".
    const earlier = await start('next steps, earlier');
    for (let i = 0; i < 3; i += 1) await run('dom.click', { selector: '.n1x' });
    await api('POST', `/sessions/${earlier.id}/end`);
    await start('next steps');
    await run('dom.click', { selector: '.n1x' }); // warned from history
    const listed = await api('GET', '/friction/next');
    assert.equal(listed.notice.kind, 'selector-risk');
    assert.deepEqual(listed.steps.map((s) => s.label), ['why', 'mark fixed']);
    assert.deepEqual(listed.steps.map((s) => s.mutating), [false, true]);

    const why = await api('POST', '/friction/next', { step: 1 });
    assert.equal(why.ran, true, 'a read runs without asking');
    assert.equal(why.result.wouldWarn, true);

    const held = await api('POST', '/friction/next', { step: 2 });
    assert.equal(held.ran, false);
    assert.equal(held.wouldRun.path, '/friction/resolve');
    assert.equal((await api('GET', '/friction/resolutions')).length, 0, 'nothing was written');

    await withMcp(relay, async ({ callTool }) => {
      const viaMcp = JSON.parse((await callTool('webscout_meta', { action: 'friction', params: { sub: 'next', step: 2, confirm: true } })).texts[0]);
      assert.equal(viaMcp.ran, true);
      assert.equal(viaMcp.ok, true);
    });
    assert.equal((await api('GET', '/friction/resolutions')).length, 1, 'the confirmed step wrote');
    await assert.rejects(api('POST', '/friction/next', { step: 9 }), /step 9 does not exist/);
  }, { handlers: failing('.n1x') });
});

test('friction trend: one target over sessions, the project-wide movers, explain carrying both - HTTP equals MCP', async () => {
  let breakIt = true;
  await withRelay(async ({ api, start, run, relay }) => {
    const first = await start('trend one');
    await run('dom.click', { selector: '#t1x' }); await run('dom.click', { selector: '#t1x' });
    await api('POST', `/sessions/${first.id}/end`);
    breakIt = false;
    await start('trend two');
    await run('dom.click', { selector: '#t1x' }); await run('dom.click', { selector: '#t1x' }); await run('dom.click', { selector: '#t1x' });

    const one = await api('GET', `/friction/trend?type=dom.click&selector=${encodeURIComponent('#t1x')}`);
    assert.equal(one.direction, 'improving');
    assert.deepEqual(one.points.map((p) => [p.fails, p.oks]), [[2, 0], [0, 3]]);
    const overview = await api('GET', '/friction/trend');
    assert.equal(overview.improving[0].selector, '#t1x');

    const why = await api('GET', `/friction/explain?type=dom.click&selector=${encodeURIComponent('#t1x')}`);
    assert.equal(why.trend.direction, 'improving');
    assert.deepEqual(why.next.map((c) => c.label), ['mark fixed', 'trend'], 'explain offers its own next steps');
    assert.equal(why.next[1].http, `GET /friction/trend?type=dom.click&selector=${encodeURIComponent('#t1x')}`);

    await withMcp(relay, async ({ callTool }) => {
      const viaMcp = JSON.parse((await callTool('webscout_meta', { action: 'friction', params: { sub: 'trend', type: 'dom.click', selector: '#t1x' } })).texts[0]);
      assert.deepEqual(viaMcp, one, 'the MCP answer is the HTTP answer');
    });
    await assert.rejects(api('GET', `/friction/trend?type=dom.click&selector=${encodeURIComponent('#never')}`), /nothing to trend/);
  }, { handlers: { 'dom.click': (p) => { if (breakIt) throw new Error(`Element not found: ${p.selector}`); return { clicked: true, mutated: false, selector: p.selector }; } } });
});

test('GET /macros?health=1 reports how replays went, including the first step that failed', async () => {
  let breakIt = false;
  await withRelay(async ({ api, apiRaw, start, run }) => {
    const s = await start('macro health');
    await run('dom.click', { selector: '#m1' });
    await run('dom.click', { selector: '#m2' });
    const macro = await api('POST', '/macros', { name: 'two clicks', sessionId: s.id });
    assert.equal((await api('GET', '/macros?health=1'))[0].health.runs, 0, 'never run: no health yet');

    await apiRaw('POST', `/macros/${macro.id}/run`, {});
    breakIt = true;
    await apiRaw('POST', `/macros/${macro.id}/run`, {});
    const listed = (await api('GET', '/macros?health=1'))[0];
    assert.equal(listed.health.runs, 2);
    assert.equal(listed.health.lastRun.ok, false);
    assert.equal(listed.health.lastRun.failedStep.step, 1);
    assert.equal(listed.health.lastRun.failedStep.target, '#m1');
    assert.deepEqual(listed.health.strip, [true, false]);
    assert.equal((await api('GET', '/macros'))[0].health, undefined, 'asked for only when wanted');
  }, { handlers: { 'dom.click': (p) => { if (breakIt) throw new Error(`Element not found: ${p.selector}`); return { clicked: true, mutated: false, selector: p.selector }; } } });
});

test('session replay says where it diverged from the original, not only whether it reproduced', async () => {
  let fixedNow = false;
  await withRelay(async ({ api, start, run }) => {
    const first = await start('replay original');
    await run('dom.click', { selector: '#r1' });
    await run('dom.click', { selector: '#r2' }); // fails in the original
    await api('POST', `/sessions/${first.id}/end`);
    fixedNow = true;
    await start('replay now');
    const out = await api('POST', `/sessions/${first.id}/replay`, { confirm: true });
    assert.equal(out.reproduced, false);
    assert.match(out.verdict, /does NOT reproduce/);
    assert.equal(out.diff.firstDivergence.kind, 'now-works');
    assert.equal(out.diff.firstDivergence.type, 'dom.click');
    assert.equal(out.diff.compared, 2);
  }, { handlers: { 'dom.click': (p) => { if (!fixedNow && p.selector === '#r2') throw new Error('Element not found: #r2'); return { clicked: true, mutated: false, selector: p.selector }; } } });
});

test('known issues carry a review date: refused when malformed, kept through import, marked due once it passes; a relapse offers the capture step', async () => {
  const d = tmpDir('webscout-round8-ki-');
  const local = path.join(d, 'local.json');
  fs.writeFileSync(local, '[]');
  await withRelay(async ({ api, start, run }) => {
    await assert.rejects(api('POST', '/known-issues/import', { entries: [{ id: 'bad', signature: 'x', remediation: 'y', reviewBy: 'next week' }], confirm: true }).then((r) => { if (r.skipped?.length) throw new Error(r.skipped[0].reason); return r; }), /reviewBy must be a date/);
    const imported = await api('POST', '/known-issues/import', { entries: [{ id: 'old', signature: 'Element not found', remediation: 'wait first', reviewBy: '2020-01-01' }, { id: 'later', signature: 'zzz', remediation: 'n/a', reviewBy: '2999-01-01' }], confirm: true });
    assert.deepEqual(imported.added.map((e) => e.id), ['old', 'later']);
    const reg = await api('GET', '/known-issues');
    assert.deepEqual(reg.reviewDue, ['old']);
    assert.equal(reg.entries.find((e) => e.id === 'later').reviewDue, false);
    assert.deepEqual(JSON.parse(fs.readFileSync(local, 'utf8')).map((e) => e.reviewBy), ['2020-01-01', '2999-01-01'], 'the date is stored in the registry');

    // a target declared fixed that keeps relapsing, with an error that a candidate's signature matches
    await start('relapse');
    for (let i = 0; i < 3; i += 1) await run('dom.click', { selector: '.k1x' });
    await api('POST', '/friction/resolve', { type: 'dom.click', selector: '.k1x' });
    await sleep(1100); // git/db dates are second-granular: the failures below must be strictly after the fix
    for (let i = 0; i < 3; i += 1) await run('dom.click', { selector: '.k1x' });
    const relapse = (await api('GET', '/friction/regressions')).relapses[0];
    assert.equal(relapse.failuresSince, 3);
    if (relapse.next) assert.equal(relapse.next[0].http, 'POST /known-issues/promote', 'when a candidate matches, the capture step is offered');
    await assert.rejects(api('POST', '/known-issues/promote', { id: 'whatever', remediation: 'x', reviewBy: 'soon' }), /reviewBy must be a date/);
  }, { handlers: failing('.k1x'), envOverride: { WEBSCOUT_KNOWN_ISSUES: local } });
});

// ---------- the MCP surface ----------

test('describe answers in params, and the friction subs of this round are named in the tool list', async () => {
  const relay = await startTestRelay({ env: { WEBSCOUT_NO_AUTOSTART: '1' } });
  try {
    await withMcp(relay, async ({ callTool, rpc }) => {
      const one = JSON.parse((await callTool('webscout_meta', { action: 'describe', params: { tool: 'meta', action: 'friction' } })).texts[0]);
      const prune = one.commands.find((c) => c.cli === 'friction prune');
      assert.match(prune.help, /noticeDays/);
      assert.doesNotMatch(prune.help, /--notice-days/, 'no shell flags in an MCP caller\'s help');
      assert.ok(prune.params.some((p) => p.name === 'confirm' && p.type === 'boolean'));
      const next = one.commands.find((c) => c.cli === 'friction next');
      assert.deepEqual(next.params.map((p) => p.name).sort(), ['confirm', 'notice', 'step']);
      const list = (await rpc('tools/list', {})).result.tools;
      assert.match(list.find((t) => t.name === 'webscout_meta').description, /next \(steps a notice offered/);
    });
  } finally { await relay.stop(); }
});

test('resources/subscribe: the relay\'s event stream becomes notifications/resources/updated', async () => {
  await withRelay(async ({ start, run, relay }) => {
    await start('subscribe');
    await withMcp(relay, async ({ rpc, init, notifications }) => {
      assert.equal(init.capabilities.resources.subscribe, true);
      const bad = await rpc('resources/subscribe', { uri: 'webscout://nope' });
      assert.equal(bad.error.code, -32602);
      assert.deepEqual((await rpc('resources/subscribe', { uri: 'webscout://notices' })).result, {});
      await sleep(500); // the event stream is opened by the subscription
      await run('dom.click', { selector: '.s1x' });
      await run('dom.click', { selector: '.s1x' });
      await run('dom.click', { selector: '.s1x' }); // the warning is a notice
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline && !notifications.some((n) => n.method === 'notifications/resources/updated' && n.params.uri === 'webscout://notices')) await sleep(100);
      assert.ok(notifications.some((n) => n.method === 'notifications/resources/updated' && n.params.uri === 'webscout://notices'), 'the subscriber was told, without polling');
      assert.ok(!notifications.some((n) => n.params?.uri === 'webscout://targets'), 'only what was subscribed to');
      assert.deepEqual((await rpc('resources/unsubscribe', { uri: 'webscout://notices' })).result, {});
    });
  }, { handlers: failing('.s1x') });
});
