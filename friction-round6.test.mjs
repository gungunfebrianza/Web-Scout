// Friction awareness, round 6 - one thing, said the same way from CLI, MCP, HTTP and the dashboard:
//   - a notice (what an agent was told) is one shape with its next steps written for every surface,
//   - the ranked list is filtered / sorted / limited on the relay, whoever asks,
//   - "declared fixed, failing again" is reported, not just implied,
//   - the registry can be exported and merged between checkouts,
//   - a recorded session can be replayed to its first failure,
//   - a session report says what the agent was told and ignored.
// Real relay + fake tab, no browser (the dashboard half is in friction-dashboard.test.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpDir } from './scratch.mjs';
import { startTestRelay, connectFakeAgent, spawnAsync } from './test-relay.mjs';
import {
  viewFrictionTargets, buildRelapses, buildSelectorFriction, actionTokens, TARGET_SORTS, TOKENS_PER_POINT,
} from './friction.mjs';
import { makeNotice, whyCommand, fixedCommand, renderNotice, serializeNotices, parseNotices } from './notices.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const ORIGIN = 'http://localhost:4100';

async function withRelay(fn, { handlers = {}, envOverride = {}, origin = ORIGIN } = {}) {
  const relay = await startTestRelay({ env: { WEBSCOUT_ANALYTICS_CACHE_MS: '0', WEBSCOUT_NO_AUTOSTART: '1', ...envOverride } });
  const tab = await connectFakeAgent(relay.port, handlers, { origin });
  const apiRaw = async (method, route, body) => {
    const res = await fetch(`http://127.0.0.1:${relay.port}${route}`, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
    return { res, json: await res.json() };
  };
  const api = async (method, route, body) => {
    const { json } = await apiRaw(method, route, body);
    if (!json.ok) throw Object.assign(new Error(json.error || `request failed: ${route}`), { extra: json.extra });
    return json.result;
  };
  const start = (goal, extra = {}) => api('POST', '/sessions', { goal, context: 'friction-round6.test.mjs', briefing: false, ...extra });
  const run = (type, params = {}, extra = {}) => apiRaw('POST', '/command', { type, params, ...extra });
  const cli = (...args) => spawnAsync([path.join(dir, 'cli.mjs'), ...args], { env: { ...relay.env, WEBSCOUT_NO_AUTOSTART: '1' }, cwd: dir, timeoutMs: 30000 });
  try {
    await fn({ api, apiRaw, start, run, cli, relay, tab });
  } finally {
    await tab.close();
    await relay.stop();
  }
}

// One MCP server over stdio against the given relay port: callTool(name, args) -> { isError, texts }.
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
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'round6', version: '0' } });
    const callTool = async (name, args) => {
      const m = await rpc('tools/call', { name, arguments: args });
      return { isError: Boolean(m.result?.isError), texts: (m.result?.content ?? []).map((c) => c.text) };
    };
    await fn(callTool);
  } finally { child.stdin.end(); child.kill(); }
}

const failingClicks = { 'dom.click': (p) => { if (/^\.(a|b|c|d)1x$/.test(p.selector) || p.selector === '#primary') throw new Error(`Element not found: ${p.selector}`); return { clicked: true, mutated: false, selector: p.selector }; } };

// ---------- pure: notices ----------

test('a notice renders its next steps as a CLI line, an MCP call or an HTTP request', () => {
  const n = makeNotice({ kind: 'selector-risk', level: 'warn', message: 'selector ".x" has failed 3x', key: 'dom.click::.x', next: [whyCommand('dom.click', '.x'), fixedCommand('dom.click', '.x')] });
  assert.equal(renderNotice(n, 'cli'), 'selector ".x" has failed 3x [why: friction explain dom.click ".x"; mark fixed: friction resolve dom.click ".x"]');
  assert.match(renderNotice(n, 'mcp'), /why: webscout_meta\.friction \{"sub":"explain","type":"dom\.click","selector":"\.x"\}/);
  assert.match(renderNotice(n, 'http'), /why: GET \/friction\/explain\?type=dom\.click&selector=\.x; mark fixed: POST \/friction\/resolve/);
  assert.equal(renderNotice(makeNotice({ kind: 'nudge', message: 'plain' })), 'plain', 'a notice with no next steps is just its message');
});

test('notices survive the header: non-ASCII is escaped, and an oversized list is cut between notices, never inside one', () => {
  const list = [makeNotice({ kind: 'nudge', message: 'café — done' })];
  const wire = serializeNotices(list);
  assert.ok(/^[\x20-\x7e]*$/.test(wire), 'printable ASCII only');
  assert.deepEqual(parseNotices(wire), list);
  const many = Array.from({ length: 200 }, (_, i) => makeNotice({ kind: 'nudge', message: `notice number ${i} ${'x'.repeat(80)}` }));
  const cut = serializeNotices(many);
  assert.ok(cut.length <= 6000);
  const back = parseNotices(cut);
  assert.ok(back.length > 0 && back.length < 200);
  assert.deepEqual(back, many.slice(0, back.length), 'the kept prefix is intact');
  assert.deepEqual(parseNotices('not json'), []);
  assert.deepEqual(parseNotices(JSON.stringify([{ nope: 1 }, { kind: 'nudge', message: 'ok' }])).map((n) => n.message), ['ok']);
});

// ---------- pure: the ranked view, tokens, relapses ----------

const failRow = (n, selector, extra = {}) => ({ session_id: n, type: 'dom.click', params: { selector }, origin: ORIGIN, ok: 0, error: extra.error ?? `Element not found: ${selector}`, started_at: `2026-02-0${n}T00:00:00Z`, duration_ms: extra.ms ?? 10 });

test('viewFrictionTargets filters across target, type, origin, class and message, sorts, and caps', () => {
  const rows = [failRow(1, '#alpha'), failRow(2, '#alpha'), failRow(1, '#beta', { error: 'timed out waiting', ms: 5000 }), failRow(2, '#beta', { error: 'timed out waiting', ms: 5000 }), failRow(3, '#beta', { error: 'timed out waiting', ms: 5000 })];
  const all = buildSelectorFriction(rows);
  assert.deepEqual(viewFrictionTargets(all, { q: 'ALPHA' }).map((e) => e.selector), ['#alpha'], 'case-insensitive text');
  assert.deepEqual(viewFrictionTargets(all, { q: 'timeout' }).map((e) => e.selector), ['#beta'], 'an error class matches');
  assert.deepEqual(viewFrictionTargets(all, { q: 'localhost:4100' }).length, 2, 'an origin matches');
  assert.deepEqual(viewFrictionTargets(all, { sort: 'fails' }).map((e) => e.selector), ['#beta', '#alpha']);
  assert.deepEqual(viewFrictionTargets(all, { sort: 'wasted' }).map((e) => e.selector), ['#beta', '#alpha']);
  assert.deepEqual(viewFrictionTargets(all, { sort: 'oldest' }).map((e) => e.selector), ['#alpha', '#beta'], 'oldest failure first');
  assert.equal(viewFrictionTargets(all, { limit: 1 }).length, 1);
  assert.deepEqual(viewFrictionTargets(all, { sort: 'nonsense' }).map((e) => e.selector), viewFrictionTargets(all, { sort: 'cost' }).map((e) => e.selector), 'an unknown sort falls back to cost');
  assert.deepEqual(Object.keys(TARGET_SORTS).sort(), ['cost', 'fails', 'oldest', 'recent', 'tokens', 'wasted']);
});

test('a failed call has a token cost, retries add to it, and it moves the score by TOKENS_PER_POINT', () => {
  const a = { type: 'dom.click', params: { selector: '#x' }, error: 'Element not found: #x' };
  assert.equal(actionTokens(a), Math.round(('dom.click'.length + JSON.stringify(a.params).length + a.error.length + 40) / 4));
  const rows = [failRow(1, '#x'), failRow(1, '#x'), failRow(2, '#x')];
  const [e] = buildSelectorFriction(rows);
  assert.ok(e.wastedTokens > 0);
  assert.ok(e.wastedTokens >= 3 * actionTokens(a) - 3, 'at least one token cost per failure');
  const timePoints = (3 * 1 + 3 * 10 / 1000);
  assert.ok(e.score >= timePoints, 'tokens only add to the score');
  assert.ok(TOKENS_PER_POINT > 0);
});

test('buildRelapses reports a target (or a whole type) that failed again after it was declared fixed', () => {
  const key = 'dom.click::#x';
  const resolutions = [{ key, type: 'dom.click', selector: '#x', resolved_at: '2026-02-02T00:00:00Z', note: 'rebuilt' }, { key: 'type::dom.fill', type: 'type', selector: 'dom.fill', resolved_at: '2026-02-02T00:00:00Z', note: null }];
  const actions = [
    failRow(1, '#x'), failRow(2, '#x'), // before the fix: not a relapse
    { ...failRow(3, '#x'), started_at: '2026-02-03T00:00:00Z' }, { ...failRow(4, '#x'), started_at: '2026-02-04T00:00:00Z' },
    { session_id: 5, type: 'dom.fill', params: { selector: '#f' }, origin: ORIGIN, ok: 0, error: 'boom', started_at: '2026-02-05T00:00:00Z', duration_ms: 1 },
    { session_id: 5, type: 'dom.click', params: { selector: '#fine' }, origin: ORIGIN, ok: 1, error: null, started_at: '2026-02-05T00:00:01Z', duration_ms: 1 },
  ];
  const r = buildRelapses(resolutions, actions);
  assert.equal(r.length, 2);
  assert.deepEqual(r.map((x) => [x.selector, x.failuresSince]).sort(), [['#x', 2], ['dom.fill', 1]]);
  assert.match(r.find((x) => x.selector === '#x').summary, /declared fixed at 2026-02-02T00:00:00Z and has failed 2x since/);
  assert.deepEqual(buildRelapses([], actions), []);
  assert.deepEqual(buildRelapses(resolutions, [failRow(1, '#x')]), [], 'failures before the declaration are not relapses');
});

// ---------- live: notices ----------

test('a warning is a stored notice: header, GET /friction/notices with a cursor, and an SSE push', async () => {
  await withRelay(async ({ api, apiRaw, start, run, relay }) => {
    // open the dashboard's event stream first
    const frames = [];
    const ac = new AbortController();
    const stream = (async () => {
      const res = await fetch(`http://127.0.0.1:${relay.port}/events`, { signal: ac.signal });
      const decoder = new TextDecoder();
      let buf = '';
      for await (const chunk of res.body) {
        buf += decoder.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) !== -1) { frames.push(buf.slice(0, i)); buf = buf.slice(i + 2); }
      }
    })().catch(() => {});

    const s = await start('notice storage');
    await run('dom.click', { selector: '.a1x' });
    await run('dom.click', { selector: '.a1x' });
    const third = await run('dom.click', { selector: '.a1x' });
    const wire = third.res.headers.get('x-webscout-notices');
    assert.ok(wire, 'the reply carries x-webscout-notices');
    const [risk] = parseNotices(wire);
    assert.equal(risk.kind, 'selector-risk');
    assert.equal(risk.key, 'dom.click::.a1x');
    assert.equal(risk.message, third.res.headers.get('x-webscout-selector-risk'), 'the legacy header says the same thing');
    assert.deepEqual(risk.next.map((c) => c.label), ['why', 'snooze 1d'], 'a target still failing is not offered "mark fixed"');
    assert.equal(risk.next[0].http, 'GET /friction/explain?type=dom.click&selector=.a1x');

    const stored = await api('GET', '/friction/notices');
    assert.equal(stored.sessionId, s.id);
    assert.equal(stored.notices.length, 1);
    assert.equal(stored.notices[0].message, risk.message);
    assert.equal((await api('GET', `/friction/notices?since=${stored.next}`)).notices.length, 0, 'a cursor returns only what is new');
    assert.equal((await api('GET', '/friction/notices?session=all')).notices.length, 1);

    for (let n = 0; n < 40 && !frames.some((f) => /"kind":"notice"/.test(f)); n += 1) await new Promise((r) => setTimeout(r, 50));
    const frame = frames.find((f) => /"kind":"notice"/.test(f));
    assert.ok(frame, 'the notice was pushed to the event stream');
    const pushed = JSON.parse(frame.split('\n').find((l) => l.startsWith('data: ')).slice(6));
    assert.equal(pushed.sessionId, s.id);
    assert.equal(pushed.notice.key, 'dom.click::.a1x');
    ac.abort();
    await stream;
    void apiRaw;
  }, { handlers: failingClicks });
});

test('one notice, three dialects: the same warning reaches HTTP, the CLI and MCP with steps each can act on', async () => {
  await withRelay(async ({ api, start, run, cli, relay }) => {
    await start('transport contract');
    // each surface needs its own selector (a warning is said once per target per session), brought to the same state
    for (const sel of ['.a1x', '.b1x', '.c1x']) { await run('dom.click', { selector: sel }); await run('dom.click', { selector: sel }); }

    const http = await run('dom.click', { selector: '.a1x' });
    const httpNotice = parseNotices(http.res.headers.get('x-webscout-notices'))[0];
    assert.equal(httpNotice.kind, 'selector-risk');

    const viaCli = await cli('dom', 'click', '.b1x');
    assert.notEqual(viaCli.status, 0, 'the click itself still fails');
    assert.match(viaCli.stderr, /selector ".b1x" \(dom\.click\) has failed 2x already this session/);
    assert.match(viaCli.stderr, /\[why: friction explain dom\.click ".b1x"; snooze 1d: friction snooze dom\.click ".b1x" --for 1d\]/, 'the CLI line is a command you can paste');

    await withMcp(relay, async (callTool) => {
      const viaMcp = await callTool('webscout_dom', { action: 'click', params: { selector: '.c1x' } });
      assert.equal(viaMcp.isError, true);
      const text = viaMcp.texts.join('\n');
      assert.match(text, /selector ".c1x" \(dom\.click\) has failed 2x already this session/);
      assert.match(text, /why: webscout_meta\.friction \{"sub":"explain","type":"dom\.click","selector":".c1x"\}/, 'the MCP line is a tool call you can make');
    });

    // the same message, modulo the selector, on all three
    const shape = (m) => m.replace(/\.[abc]1x/g, '<sel>').replace(/last at \S+/, 'last at <t>');
    const storedMessages = (await api('GET', '/friction/notices')).notices.filter((n) => n.kind === 'selector-risk').map((n) => shape(n.message));
    assert.equal(storedMessages.length, 3);
    assert.equal(new Set(storedMessages).size, 1, 'one wording, whoever asked');
  }, { handlers: failingClicks });
});

// ---------- live: the ranked list from every surface ----------

test('friction targets returns the same rows from HTTP, the CLI and MCP, filtered and sorted on the relay', async () => {
  await withRelay(async ({ api, apiRaw, start, run, cli, relay }) => {
    for (let n = 0; n < 2; n += 1) {
      const s = await start(`seed ${n}`);
      for (const sel of ['.a1x', '.b1x', '.c1x']) await run('dom.click', { selector: sel });
      await run('dom.click', { selector: '.d1x' });
      await api('POST', `/sessions/${s.id}/end`);
    }
    const http = await api('GET', '/friction/targets?q=b1x&sort=fails');
    assert.equal(http.total, 4);
    assert.deepEqual(http.targets.map((t) => t.selector), ['.b1x']);
    assert.equal((await api('GET', '/friction/targets?limit=2')).shown, 2);
    const bad = await apiRaw('GET', '/friction/targets?sort=sideways');
    assert.equal(bad.json.ok, false);
    assert.match(bad.json.error, /sort must be one of/);

    const viaCli = JSON.parse((await cli('friction', 'targets', '--filter', 'a1x', '--sort', 'fails')).stdout);
    assert.deepEqual(viaCli.targets.map((t) => t.key), (await api('GET', '/friction/targets?q=a1x&sort=fails')).targets.map((t) => t.key));

    await withMcp(relay, async (callTool) => {
      const out = await callTool('webscout_meta', { action: 'friction', params: { sub: 'targets', filter: 'a1x', sort: 'fails' } });
      assert.equal(out.isError, false);
      assert.deepEqual(JSON.parse(out.texts[0]).targets.map((t) => t.key), viaCli.targets.map((t) => t.key));
    });
  }, { handlers: failingClicks });
});

// ---------- live: relapses ----------

test('declared fixed, failing again: listed by HTTP / CLI / MCP, ranked in the digest, and --fail sets the exit status', async () => {
  await withRelay(async ({ api, start, run, cli, relay }) => {
    const s1 = await start('first');
    await run('dom.click', { selector: '#primary' });
    await run('dom.click', { selector: '#primary' });
    await api('POST', `/sessions/${s1.id}/end`);
    assert.equal((await api('GET', '/friction/regressions')).count, 0, 'nothing declared fixed yet');
    const clean = await cli('friction', 'regressions', '--fail');
    assert.equal(clean.status, 0, 'no relapses, exit 0');

    await api('POST', '/friction/resolve', { type: 'dom.click', selector: '#primary', note: 'rebuilt the button' });
    await new Promise((r) => setTimeout(r, 30));
    const s2 = await start('second');
    await run('dom.click', { selector: '#primary' });
    await api('POST', `/sessions/${s2.id}/end`);

    const out = await api('GET', '/friction/regressions');
    assert.equal(out.count, 1);
    assert.equal(out.relapses[0].selector, '#primary');
    assert.equal(out.relapses[0].failuresSince, 1);
    assert.equal(out.relapses[0].note, 'rebuilt the button');
    const analytics = await api('GET', '/analytics');
    assert.equal(analytics.relapsedFriction.length, 1);
    assert.ok(analytics.topFrictionItems.some((i) => i.kind === 'regression' && /friction regressions/.test(i.summary)), 'the digest leads with it');

    const failed = await cli('friction', 'regressions', '--fail');
    assert.equal(failed.status, 1, '--fail exits non-zero when there is a relapse');
    assert.match(failed.stderr, /REGRESSION: dom\.click #primary was declared fixed/);
    await withMcp(relay, async (callTool) => {
      const viaMcp = JSON.parse((await callTool('webscout_meta', { action: 'friction', params: { sub: 'regressions' } })).texts[0]);
      assert.equal(viaMcp.count, 1);
    });
  }, { handlers: failingClicks });
});

// ---------- live: known-issues export / import ----------

test('known-issues export and import merge by id, refuse bad entries with a reason, and write only on confirm', async () => {
  const registry = path.join(tmpDir('webscout-round6-known-issues-'), 'known-issues.json');
  fs.writeFileSync(registry, JSON.stringify([{ id: 'have', signature: 'detached', description: 'd', remediation: 'use click-wait' }]));
  await withRelay(async ({ api, cli, relay }) => {
    const exported = await api('GET', '/known-issues');
    assert.deepEqual(exported.entries.map((e) => e.id), ['have']);

    const incoming = [
      { id: 'have', signature: 'other', remediation: 'x' },
      { id: 'new-one', signature: '/timed? out/i', description: 'slow page', remediation: 'settle first' },
      { id: 'no-fix', signature: 'whatever' },
      { id: 'bad-regex', signature: '/(unclosed/', remediation: 'r' },
      { signature: 'no id', remediation: 'r' },
    ];
    const dry = await api('POST', '/known-issues/import', { entries: incoming });
    assert.equal(dry.written, false);
    assert.deepEqual(dry.wouldAdd.map((e) => e.id), ['new-one']);
    assert.equal(dry.skipped.length, 4);
    assert.match(dry.skipped.find((s) => s.id === 'have').reason, /already exists/);
    assert.match(dry.skipped.find((s) => s.id === 'no-fix').reason, /remediation is required/);
    assert.match(dry.skipped.find((s) => s.id === 'bad-regex').reason, /does not compile/);
    assert.equal(JSON.parse(fs.readFileSync(registry, 'utf8')).length, 1, 'a dry run writes nothing');

    const real = await api('POST', '/known-issues/import', { entries: incoming, confirm: true });
    assert.equal(real.written, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(registry, 'utf8')).map((e) => e.id), ['have', 'new-one']);
    assert.equal((await api('POST', '/known-issues/import', { entries: incoming, confirm: true })).written, false, 'a second import adds nothing');

    // CLI round trip: export to a file, import it into a fresh registry
    const out = path.join(path.dirname(registry), 'shared.json');
    const exp = await cli('known-issues', 'export', '--out', out);
    assert.equal(exp.status, 0, exp.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')).map((e) => e.id), ['have', 'new-one']);
    fs.writeFileSync(registry, '[]');
    const imp = JSON.parse((await cli('known-issues', 'import', out, '--confirm')).stdout);
    assert.deepEqual(imp.added.map((e) => e.id), ['have', 'new-one']);

    await withMcp(relay, async (callTool) => {
      const listed = JSON.parse((await callTool('webscout_meta', { action: 'friction', params: { sub: 'issues' } })).texts[0]);
      assert.equal(listed.entries.length, 2);
      const dryMcp = JSON.parse((await callTool('webscout_meta', { action: 'friction', params: { sub: 'issues', entries: [{ id: 'mcp-new', signature: 'x', remediation: 'y' }] } })).texts[0]);
      assert.deepEqual(dryMcp.wouldAdd.map((e) => e.id), ['mcp-new']);
    });
  }, { envOverride: { WEBSCOUT_KNOWN_ISSUES: registry } });
});

// ---------- live: session replay ----------

test('session replay: a dry run shows the plan, a confirmed run says whether the failure still reproduces', async () => {
  let broken = true;
  const seen = [];
  const handlers = {
    'dom.click': (p) => { seen.push(p.selector); if (broken && p.selector === '#flaky') throw new Error('Element not found: #flaky'); return { clicked: true, mutated: false }; },
    'dom.fill': () => ({ filled: true }),
  };
  await withRelay(async ({ api, apiRaw, start, run, cli }) => {
    const source = await start('checkout flow');
    await run('dom.click', { selector: '#open' });
    await run('dom.fill', { selector: '#email', value: 'a@b.test' });
    await run('dom.click', { selector: '#flaky' }); // fails
    await run('dom.click', { selector: '#after' }); // never reached by the replay
    await api('POST', `/sessions/${source.id}/end`);

    await start('checkout flow replay');
    seen.length = 0;
    const plan = await api('POST', `/sessions/${source.id}/replay`, {});
    assert.equal(plan.dryRun, true);
    assert.deepEqual(plan.plan.map((p) => [p.type, p.params.selector, p.isTheFailure]), [['dom.click', '#open', false], ['dom.fill', '#email', false], ['dom.click', '#flaky', true]]);
    assert.equal(plan.expected.errorClass, 'not-found');
    assert.deepEqual(seen, [], 'a dry run touches nothing');

    const still = await api('POST', `/sessions/${source.id}/replay`, { confirm: true });
    assert.equal(still.reproduced, true, JSON.stringify(still));
    assert.match(still.verdict, /still reproduces/);
    assert.deepEqual(seen, ['#open', '#flaky'], 'the steps ran in order and stopped at the failure');
    assert.ok(!seen.includes('#after'));

    broken = false;
    seen.length = 0;
    const fixed = await api('POST', `/sessions/${source.id}/replay`, { confirm: true });
    assert.equal(fixed.reproduced, false);
    assert.match(fixed.verdict, /does NOT reproduce/);

    const none = await apiRaw('POST', `/sessions/${(await api('GET', '/sessions')).find((s) => s.goal === 'checkout flow replay').id}/replay`, {});
    assert.equal(none.json.ok, false);
    assert.match(none.json.error, /no failed action to reproduce/);

    // CLI: dry run prints the plan; the verdict line only appears for a real run
    const dry = await cli('session', 'replay', String(source.id));
    assert.equal(dry.status, 0, dry.stderr);
    assert.equal(JSON.parse(dry.stdout).dryRun, true);
  }, { handlers });
});

// ---------- live: the report ----------

test('a session report says what the agent was told, what it ignored and what was declared fixed', async () => {
  await withRelay(async ({ api, start, run }) => {
    const s = await start('report content');
    for (let n = 0; n < 4; n += 1) await run('dom.click', { selector: '.a1x' }); // warned at the 3rd, still failing at the 4th
    await api('POST', '/friction/resolve', { type: 'dom.click', selector: '.zzz', note: 'unrelated fix' });
    await api('POST', `/sessions/${s.id}/end`);

    const json = JSON.parse((await api('GET', `/sessions/${s.id}/report?format=json`)).content);
    assert.ok(json.friction.noticeCount >= 1);
    assert.equal(json.friction.told['selector-risk'] >= 1, true);
    assert.equal(json.friction.ignored.length, 1);
    assert.equal(json.friction.ignored[0].key, 'dom.click::.a1x');
    assert.ok(json.friction.ignored[0].failuresAfter >= 1);
    assert.equal(json.friction.resolved.length, 1);
    const md = (await api('GET', `/sessions/${s.id}/report`)).content;
    assert.match(md, /## Friction awareness/);
    assert.match(md, /Warned, then failed again anyway/);
    assert.match(md, /Declared fixed during this session/);
  }, { handlers: failingClicks });
});

// ---------- live: macros, preflight, vocabulary ----------

test('macro list --risk says how many steps would draw a warning now; preflight carries the goal\'s briefing', async () => {
  const broken = new Set();
  await withRelay(async ({ api, start, run, cli }) => {
    const rec = await start('record checkout macro');
    await run('dom.click', { selector: '#clean' });
    await run('dom.click', { selector: '#risky' });
    const macro = await api('POST', '/macros', { name: 'checkout', sessionId: rec.id });
    await api('POST', `/sessions/${rec.id}/end`);
    broken.add('#risky');
    const bad = await start('seed failures');
    for (let n = 0; n < 3; n += 1) await run('dom.click', { selector: '#risky' });
    await api('POST', `/sessions/${bad.id}/end`);
    broken.clear();
    await start('record checkout macro again');

    const plain = await api('GET', '/macros');
    assert.equal(plain[0].risk, undefined, 'the default shape is unchanged');
    const withRisk = await api('GET', '/macros?risk=1');
    assert.equal(withRisk[0].risk.riskySteps, 1);
    assert.equal(withRisk[0].risk.worst.selector, '#risky');
    assert.equal(withRisk[0].id, macro.id);

    const listed = await cli('macro', 'list', '--risk');
    assert.match(listed.stderr, /NOTE: macro #\d+ "checkout" has 1 step\(s\) that would draw a friction warning right now \(worst: step 1 "#risky"/);

    const pre = await api('POST', '/crv/preflight', {});
    assert.ok(Array.isArray(pre.frictionBriefing), 'preflight carries a briefing');
    assert.equal(pre.frictionBriefing[0].target, '#risky');
  }, { handlers: { 'dom.click': (p) => { if (broken.has(p.selector)) throw new Error('still broken'); return { clicked: true }; } } });
});

test('the wire speaks camelCase and still accepts the snake_case spellings older callers send', async () => {
  await withRelay(async ({ api, start }) => {
    const camel = await start('camel session', { strictCrv: true, tokenBudget: 1234, autoRecover: true, tags: ['x'] });
    assert.equal(camel.strict_crv, true);
    assert.equal(camel.token_budget, 1234);
    assert.equal(camel.auto_recover, true);
    await api('POST', `/sessions/${camel.id}/end`);
    const snake = await start('snake session', { strict_crv: true, token_budget: 4321, auto_recover: true, if_stale_min: 0 });
    assert.equal(snake.strict_crv, true);
    assert.equal(snake.token_budget, 4321);
    assert.equal(snake.auto_recover, true);
  });
});
