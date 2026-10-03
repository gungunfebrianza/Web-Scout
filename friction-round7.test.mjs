// Round 7 - reach and cost: a terse MCP tool list with the long form one call away, resources, an exact change
// feed under the analytics cache, retention beyond result bodies, relapse hints from git, a shared read-only
// registry, and stable-selector suggestions at plan / preflight / macro-record time.
// Real relay + fake tab (and a real git repo for the relapse hint), no browser.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { tmpDir } from './scratch.mjs';
import { startTestRelay, connectFakeAgent } from './test-relay.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const ORIGIN = 'http://localhost:4100';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  const start = (goal, extra = {}) => api('POST', '/sessions', { goal, context: 'friction-round7.test.mjs', briefing: false, ...extra });
  const run = (type, params = {}) => apiRaw('POST', '/command', { type, params });
  try { await fn({ api, apiRaw, start, run, relay, tab }); } finally { await tab.close(); await relay.stop(); }
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
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'round7', version: '0' } });
    await fn({ rpc, init: init.result, callTool: async (name, args) => { const m = await rpc('tools/call', { name, arguments: args }); return { isError: Boolean(m.result?.isError), texts: (m.result?.content ?? []).map((c) => c.text) }; } });
  } finally { child.stdin.end(); child.kill(); }
}

const failing = (...selectors) => ({ 'dom.click': (p) => { if (selectors.includes(p.selector)) throw new Error(`Element not found: ${p.selector}`); return { clicked: true, mutated: false, selector: p.selector }; } });

// ---------- the MCP surface: terse list, describe, resources ----------

test('the MCP tool list is terse and the long form is one describe call away', async () => {
  const relay = await startTestRelay({ env: { WEBSCOUT_NO_AUTOSTART: '1' } });
  try {
    await withMcp(relay, async ({ rpc, callTool }) => {
      const list = (await rpc('tools/list', {})).result.tools;
      const total = list.reduce((s, t) => s + JSON.stringify(t).length, 0);
      assert.ok(total < 17000, `the list is ${total} bytes - the terse form exists to keep it small`);
      const idb = list.find((t) => t.name === 'webscout_idb').description;
      assert.match(idb, /^ {2}dump \{store, where\?, fields\?, limit\?, countOnly\?, \+shape\} - /m, 'the signature survives');
      assert.ok(!/in the page - use/.test(idb) || idb.split('\n').find((l) => /^ {2}dump/.test(l)).length < 160, 'the explanation is cut to a clause');

      const one = JSON.parse((await callTool('webscout_meta', { action: 'describe', params: { tool: 'idb', action: 'dump' } })).texts[0]);
      assert.equal(one.tool, 'webscout_idb');
      assert.equal(one.commands[0].cli, 'idb dump');
      assert.match(one.commands[0].help, /idb dump/, 'the CLI usage text for that command');
      assert.equal(one.commands[0].flagToParam['--where'], 'where', 'flags map to the param names the tool list shows');

      const whole = JSON.parse((await callTool('webscout_meta', { action: 'describe', params: { tool: 'webscout_dom' } })).texts[0]);
      assert.ok(whole.description.length > list.find((t) => t.name === 'webscout_dom').description.length, 'a whole tool comes back in full');
      const index = JSON.parse((await callTool('webscout_meta', { action: 'describe', params: {} })).texts[0]);
      assert.ok(index.tools.some((t) => t.tool === 'webscout_macro' && t.actions.includes('run')));
      const bad = await callTool('webscout_meta', { action: 'describe', params: { tool: 'nope' } });
      assert.equal(bad.isError, true);
    });
  } finally { await relay.stop(); }
});

test('MCP resources: notices, regressions and targets are readable without a tool call', async () => {
  await withRelay(async ({ start, run, relay }) => {
    await start('resource notices');
    await run('dom.click', { selector: '.a1x' });
    await run('dom.click', { selector: '.a1x' });
    await run('dom.click', { selector: '.a1x' }); // warned
    await withMcp(relay, async ({ rpc, init }) => {
      assert.ok(init.capabilities.resources, 'the server advertises resources');
      const listed = (await rpc('resources/list', {})).result.resources;
      assert.deepEqual(listed.map((r) => r.uri).sort(), ['webscout://notices', 'webscout://regressions', 'webscout://targets']);
      const notices = JSON.parse((await rpc('resources/read', { uri: 'webscout://notices' })).result.contents[0].text);
      assert.equal(notices.notices[0].kind, 'selector-risk');
      assert.equal(JSON.parse((await rpc('resources/read', { uri: 'webscout://regressions' })).result.contents[0].text).count, 0);
      const missing = await rpc('resources/read', { uri: 'webscout://nope' });
      assert.equal(missing.error.code, -32602);
    });
  }, { handlers: failing('.a1x') });
});

// ---------- the db change feed ----------

test('the analytics cache is exact: a row updated after it was logged is re-read, and nothing else is guessed', async () => {
  await withRelay(async ({ api, start, run, relay }) => {
    const s = await start('change feed');
    await run('dom.click', { selector: '#ok' });
    await run('dom.click', { selector: '.a1x' });
    const first = await api('GET', '/analytics');
    const baseline = first.totals.actions;
    assert.ok(baseline >= 2);
    // change a cached row behind the relay's back through the same column the relay itself updates (delivered_bytes)
    // and report it the way db.mjs does - by id, in the change feed - via a read the relay shapes.
    await api('POST', `/sessions/${s.id}/end`);
    await start('change feed again');
    for (let n = 0; n < 5; n += 1) await run('dom.click', { selector: `#more-${n}` });
    const again = await api('GET', '/analytics');
    assert.equal(again.totals.actions - baseline, 5, 'rows logged since the last call are added');
    const cold = await startTestRelay({ env: { WEBSCOUT_ANALYTICS_CACHE_MS: '0', WEBSCOUT_DB_PATH: relay.env.WEBSCOUT_DB_PATH, WEBSCOUT_PID_PATH: `${relay.env.WEBSCOUT_PID_PATH}.cold` } });
    try {
      const fresh = (await (await fetch(`http://127.0.0.1:${cold.port}/analytics`)).json()).result;
      const pick = (a) => JSON.stringify({ t: a.totals, r: a.failureRateByType.map((x) => [x.type, x.total, x.failed]), s: a.selectorFriction.map((x) => [x.key, x.failCount]) });
      assert.equal(pick(again), pick(fresh), 'a cold read and the cached one agree');
    } finally { await cold.stop(); }
  }, { handlers: failing('.a1x') });
});

// ---------- retention beyond result bodies ----------

test('friction prune also drops old notices and old successful reads - and only the ones nothing depends on', async () => {
  await withRelay(async ({ api, apiRaw, start, run, relay }) => {
    const s = await start('retention');
    await run('net.log', {});            // successful read, no friction target -> prunable
    await run('console.log', {});        // same
    await run('dom.query', { selector: '#kept' }); // successful read ON a target -> kept (a success changes what old failures mean)
    await run('dom.click', { selector: '.a1x' }); // a failure -> kept
    await run('dom.click', { selector: '.a1x' });
    await run('dom.click', { selector: '.a1x' }); // warned: one notice
    const snap = await api('POST', '/state/snapshot', {});
    await api('POST', `/sessions/${s.id}/end`);
    await start('retention current');

    const db = () => new DatabaseSync(relay.env.WEBSCOUT_DB_PATH);
    {
      const h = db();
      try {
        h.prepare('UPDATE actions SET started_at = ? WHERE session_id = ?').run('2020-01-01T00:00:00.000Z', s.id);
        h.prepare('UPDATE session_notices SET at = ? WHERE session_id = ?').run('2020-01-01T00:00:00.000Z', s.id);
      } finally { h.close(); }
    }
    const counts = () => {
      const h = db();
      try {
        return {
          reads: h.prepare("SELECT COUNT(*) AS n FROM actions WHERE session_id = ? AND type IN ('net.log','console.log')").get(s.id).n,
          kept: h.prepare("SELECT COUNT(*) AS n FROM actions WHERE session_id = ? AND (type = 'dom.query' OR ok = 0)").get(s.id).n,
          notices: h.prepare('SELECT COUNT(*) AS n FROM session_notices WHERE session_id = ?').get(s.id).n,
        };
      } finally { h.close(); }
    };
    const before = counts();
    assert.equal(before.reads, 2);
    assert.ok(before.notices >= 1);

    assert.equal((await apiRaw('POST', '/friction/prune', { readDays: 30 })).json.ok, false, 'readDays below 90 is refused');
    assert.equal((await apiRaw('POST', '/friction/prune', { noticeDays: 2 })).json.ok, false, 'noticeDays below 7 is refused');

    const dry = await api('POST', '/friction/prune', { noticeDays: 30, readDays: 120 });
    assert.equal(dry.dryRun, true);
    assert.equal(dry.oldReads.rows, 2);
    assert.equal(dry.oldNotices.notices, before.notices);
    assert.deepEqual(counts(), before, 'a dry run deletes nothing');

    const real = await api('POST', '/friction/prune', { noticeDays: 30, readDays: 120, confirm: true });
    assert.equal(real.oldReads.rows, 2);
    const after = counts();
    assert.equal(after.reads, 0);
    assert.equal(after.notices, 0);
    assert.equal(after.kept, before.kept, 'failures and target reads are untouched');
    assert.equal((await api('GET', '/analytics')).failureRateByType.find((t) => t.type === 'dom.click').failed, 3, 'history intact');
    void snap;
  }, { handlers: { ...failing('.a1x'), 'net.log': () => ({ entries: [] }), 'console.log': () => ({ entries: [] }), 'dom.query': () => ({ found: true }), 'idb.snapshot': () => ({ stores: { notes: { keyPath: 'id', rows: [{ id: 1 }] } } }) } });
});

test('a read that a snapshot was taken at is not pruned even when old', async () => {
  await withRelay(async ({ api, start, run, relay }) => {
    const s = await start('referenced read');
    await run('net.log', {});
    const h0 = new DatabaseSync(relay.env.WEBSCOUT_DB_PATH);
    const actionId = h0.prepare("SELECT id FROM actions WHERE type = 'net.log'").get().id;
    h0.close();
    await api('POST', '/state/snapshot', {});
    const h = new DatabaseSync(relay.env.WEBSCOUT_DB_PATH);
    try {
      h.prepare('UPDATE state_snapshots SET action_id = ? WHERE session_id = ?').run(actionId, s.id);
      h.prepare('UPDATE actions SET started_at = ? WHERE id = ?').run('2020-01-01T00:00:00.000Z', actionId);
    } finally { h.close(); }
    await api('POST', `/sessions/${s.id}/end`);
    await start('referenced read current');
    assert.equal((await api('POST', '/friction/prune', { readDays: 120 })).oldReads.rows, 0, 'a snapshot points at it, so it stays');
  }, { handlers: { 'net.log': () => ({ entries: [] }), 'idb.snapshot': () => ({ stores: { notes: { keyPath: 'id', rows: [{ id: 1 }] } } }) } });
});

// ---------- relapse hint from git ----------

test('a relapse says what was committed between the fix and the failure, or that nothing was', async (t) => {
  if (spawnSync('git', ['--version']).status !== 0) { t.skip('git not available'); return; }
  const repo = tmpDir('webscout-round7-git-');
  const git = (...args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  git('init', '-q');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one');
  git('add', '.');
  git('commit', '-q', '-m', 'old work, before the fix');
  await withRelay(async ({ api, start, run }) => {
    const s1 = await start('first');
    await run('dom.click', { selector: '#primary' });
    await run('dom.click', { selector: '#primary' });
    await api('POST', `/sessions/${s1.id}/end`);
    await sleep(2200); // git dates are whole seconds: keep the old commit clearly before the fix
    await api('POST', '/friction/resolve', { type: 'dom.click', selector: '#primary', note: 'rebuilt' });
    await sleep(1200);
    fs.writeFileSync(path.join(repo, 'b.txt'), 'two');
    git('add', '.');
    git('commit', '-q', '-m', 'refactor the checkout button');
    await sleep(1200);
    await start('second');
    await run('dom.click', { selector: '#primary' });
    const out = await api('GET', '/friction/regressions');
    assert.equal(out.count, 1);
    assert.deepEqual(out.relapses[0].changedBetween.map((c) => c.subject), ['refactor the checkout button']);
    assert.match(out.relapses[0].changedBetween[0].hash, /^[0-9a-f]{7,}$/);
  }, { handlers: failing('#primary'), envOverride: { WEBSCOUT_GIT_DIR: repo } });

  // no commit in the window -> an empty list (a statement), no repository -> null (no claim)
  await withRelay(async ({ api, start, run }) => {
    const s1 = await start('first');
    await run('dom.click', { selector: '#primary' });
    await api('POST', `/sessions/${s1.id}/end`);
    await api('POST', '/friction/resolve', { type: 'dom.click', selector: '#primary' });
    await sleep(1200);
    await start('second');
    await run('dom.click', { selector: '#primary' });
    assert.deepEqual((await api('GET', '/friction/regressions')).relapses[0].changedBetween, []);
  }, { handlers: failing('#primary'), envOverride: { WEBSCOUT_GIT_DIR: repo } });
  await withRelay(async ({ api, start, run }) => {
    const s1 = await start('first');
    await run('dom.click', { selector: '#primary' });
    await api('POST', `/sessions/${s1.id}/end`);
    await api('POST', '/friction/resolve', { type: 'dom.click', selector: '#primary' });
    await sleep(50);
    await start('second');
    await run('dom.click', { selector: '#primary' });
    assert.equal((await api('GET', '/friction/regressions')).relapses[0].changedBetween, null);
  }, { handlers: failing('#primary'), envOverride: { WEBSCOUT_GIT_DIR: tmpDir('webscout-round7-nogit-') } });
});

// ---------- shared, read-only registry ----------

test('WEBSCOUT_KNOWN_ISSUES_SHARED is merged under the local registry, never written, and a bad file is reported not fatal', async () => {
  const d = tmpDir('webscout-round7-shared-');
  const local = path.join(d, 'local.json');
  const shared = path.join(d, 'shared.json');
  const broken = path.join(d, 'broken.json');
  fs.writeFileSync(local, JSON.stringify([{ id: 'same-id', signature: 'Element not found', description: 'local wins', remediation: 'local fix' }]));
  fs.writeFileSync(shared, JSON.stringify([
    { id: 'same-id', signature: 'Element not found', description: 'shared loses', remediation: 'shared fix' },
    { id: 'from-team', signature: 'never-matches-this', description: 'team knowledge', remediation: 'team fix' },
    { id: 'shared-only', signature: 'detached from DOM', description: 'stale node', remediation: 'use click-wait' },
  ]));
  fs.writeFileSync(broken, '{ not json');
  const sharedBytes = fs.readFileSync(shared, 'utf8');
  await withRelay(async ({ api, apiRaw, start, run }) => {
    await start('shared registry');
    const local1 = await apiRaw('POST', '/command', { type: 'dom.click', params: { selector: '#gone' } });
    assert.equal(local1.json.extra.knownIssue.remediation, 'local fix', 'a local id wins over a shared one');
    const viaShared = await apiRaw('POST', '/command', { type: 'dom.fill', params: { selector: '#stale', value: 'x' } });
    assert.equal(viaShared.json.extra.knownIssue.id, 'shared-only', 'an entry only the shared file has still matches');

    const reg = await api('GET', '/known-issues');
    assert.deepEqual(reg.entries.map((e) => e.id), ['same-id'], 'the local file is what export hands out');
    assert.equal(reg.shared.length, 2);
    assert.deepEqual(reg.shared.find((s) => s.file === shared).entries.map((e) => e.id), ['same-id', 'from-team', 'shared-only']);
    assert.match(reg.shared.find((s) => s.file === broken).error, /JSON/, 'the unreadable file is reported');

    const imported = await api('POST', '/known-issues/import', { entries: [{ id: 'from-team', signature: 'x', remediation: 'y' }], confirm: true });
    assert.equal(imported.written, true, 'importing writes the LOCAL file, whatever the shared one holds');
    assert.equal(fs.readFileSync(shared, 'utf8'), sharedBytes, 'the shared file is never written');
    void run;
  }, {
    handlers: { 'dom.click': () => { throw new Error('Element not found: #gone'); }, 'dom.fill': () => { throw new Error('node detached from DOM'); } },
    envOverride: { WEBSCOUT_KNOWN_ISSUES: local, WEBSCOUT_KNOWN_ISSUES_SHARED: [shared, broken].join(path.delimiter) },
  });
});

// ---------- stable-selector suggestions ----------

test('a plan check, preflight and macro record offer the selector that reliably worked after this one failed', async () => {
  const broken = new Set();
  await withRelay(async ({ api, start, run }) => {
    // a macro using #primary, recorded while it works
    const rec = await start('record checkout macro');
    await run('dom.click', { selector: '#primary' });
    const macroBefore = await api('POST', '/macros', { name: 'checkout', sessionId: rec.id });
    assert.equal(macroBefore.selectorSuggestions, undefined, 'nothing is wrong with it yet');
    await api('POST', `/sessions/${rec.id}/end`);

    // then #primary breaks four times, and each time #fallback is what works
    broken.add('#primary');
    for (let n = 0; n < 4; n += 1) {
      const s = await start(`break ${n}`);
      await run('dom.click', { selector: '#primary' });
      await run('dom.click', { selector: '#fallback' });
      await api('POST', `/sessions/${s.id}/end`);
    }
    broken.clear();

    const cur = await start('record checkout macro again');
    const plan = await api('POST', '/crv/preflight', { plan: [{ type: 'dom.click', params: { selector: '#primary' } }] });
    const risky = plan.planRisk.risky[0];
    assert.equal(risky.suggest.selector, '#fallback');
    assert.match(risky.suggest.evidence, /worked 4 of 4 times/);

    const pre = await api('POST', '/crv/preflight', { selector: '#primary' });
    assert.equal(pre.selectorSuggestion.alternative, '#fallback');
    assert.match(pre.selectorSuggestion.warning, /#primary/);

    await run('dom.click', { selector: '#primary' }); // works again in this session
    const macro = await api('POST', '/macros', { name: 'checkout again', sessionId: cur.id });
    assert.equal(macro.steps[0].params.selector, '#primary', 'the recorded step is never rewritten');
    assert.equal(macro.selectorSuggestions.length, 1);
    assert.equal(macro.selectorSuggestions[0].alternative, '#fallback');
    assert.equal(macro.selectorSuggestions[0].source, 'recovery');
    assert.equal(macro.selectorSuggestions[0].element, null);
  }, { handlers: { 'dom.click': (p) => { if (broken.has(p.selector)) throw new Error('Element not found'); return { clicked: true }; }, 'dom.query': () => ({ found: true, tag: 'BUTTON', id: null }) } });
});

// ---------- the host-health scan a forced read waits for ----------

test('a forced host-health read after a change sees the change even when a scan was already running', async () => {
  const root = tmpDir('webscout-round7-host-');
  const relay = await startTestRelay({ env: { WEBSCOUT_TMPDIR: root, WEBSCOUT_NO_HOST_SCAN: '' } });
  try {
    const get = async (fresh) => (await (await fetch(`http://127.0.0.1:${relay.port}/host/health${fresh ? '?fresh=1' : ''}`)).json()).result;
    const warm = get(false); // starts a scan
    const d = path.join(root, 'webscout-browser-profile-roundseven');
    fs.mkdirSync(d);
    fs.writeFileSync(path.join(d, '.webscout-owner.json'), JSON.stringify({ pid: 999999, createdAt: Date.now(), creator: 1 }));
    const forced = await get(true);
    await warm;
    assert.ok(forced.dirs.some((x) => x.name === 'webscout-browser-profile-roundseven'), 'the forced read listed the dir created after the first scan started');
  } finally { await relay.stop(); }
});
