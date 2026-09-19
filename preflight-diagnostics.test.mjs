// V39: three things a real CRV pass needed answered without a chain of manual round trips.
//   - "crv preflight" names a console error the operator has already diagnosed once
//     (knownIssueMatches, from an optional per-checkout registry file - see CONTRIBUTING.md).
//   - "crv preflight" reports every connected agent, and flags two tabs fighting over one agent
//     name (agents[].tabCollision) - which otherwise looks like the origin flip-flopping.
//   - "session start --if-stale-min N" ends a conflicting session at least N minutes old, and
//     still refuses a younger one.
// See CONTRIBUTING.md: the top-level await must stay above every test() call.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestRelay, connectFakeAgent, spawnAsync } from './test-relay.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
// The relay reads this path on every preflight - a temp file, never the real per-checkout registry.
const registryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webscout-known-issues-'));
const registryPath = path.join(registryDir, 'known-issues.json');
const relay = await startTestRelay({ env: { WEBSCOUT_KNOWN_ISSUES: registryPath } });
const BASE = `http://127.0.0.1:${relay.port}`;
const skipLive = relay.live ? 'skipped under WEBSCOUT_TEST_LIVE=1 (the live relay reads its own registry path)' : false;

async function api(method, route, body) {
  const res = await fetch(`${BASE}${route}`, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json();
  return json.ok ? json.result : Object.assign(new Error(json.error), { status: res.status });
}

const consoleEntries = [];
const handlers = {
  'idb.list': () => ({ stores: [], counts: {} }),
  'console.log': () => ({ count: consoleEntries.length, entries: consoleEntries }),
};
const tabs = [];
const connect = async (name, opts = {}) => { const t = await connectFakeAgent(relay.port, handlers, { name, epoch: 0, ...opts }); tabs.push(t); return t; };

before(() => { fs.rmSync(registryPath, { force: true }); });
after(async () => {
  for (const t of tabs) t.close();
  await relay.stop();
  fs.rmSync(registryDir, { recursive: true, force: true });
});

test('knownIssueMatches: no registry file is inert - an empty array, never null or an error', { skip: skipLive }, async () => {
  fs.rmSync(registryPath, { force: true });
  await connect('ki-tab', { origin: 'http://127.0.0.1:9000' });
  consoleEntries.length = 0;
  consoleEntries.push({ level: 'error', message: 'TypeError: boom', stack: null, at: new Date().toISOString() });
  const report = await api('POST', '/crv/preflight', { agent: 'ki-tab' });
  assert.deepEqual(report.knownIssueMatches, []);
  assert.equal(report.knownIssuesCheckError, undefined);
  assert.equal(report.bootErrors.length, 1, 'the boot error itself is still reported');
});

test('knownIssueMatches: a registry entry whose signature matches a console error is named with its remediation', { skip: skipLive }, async () => {
  fs.writeFileSync(registryPath, JSON.stringify([
    { id: 'plain-substring', signature: "reading 'exampleSetting'", description: 'a settings row is missing on a fresh store', remediation: 'seed the default row, then reload' },
    { id: 'regex-form', signature: '/widget (\\w+) failed/i', description: 'regex signature', remediation: 'restart the widget' },
    { id: 'never-fires', signature: 'a message nothing logs', description: 'unrelated', remediation: 'n/a' },
  ]));
  consoleEntries.length = 0;
  consoleEntries.push(
    { level: 'error', message: "Uncaught TypeError: Cannot read properties of undefined (reading 'exampleSetting')", stack: null, at: new Date().toISOString() },
    { level: 'error', message: 'Widget Alpha FAILED to mount', stack: null, at: new Date().toISOString() },
  );
  const report = await api('POST', '/crv/preflight', { agent: 'ki-tab' });
  assert.deepEqual(report.knownIssueMatches.map((m) => m.id).sort(), ['plain-substring', 'regex-form']);
  const plain = report.knownIssueMatches.find((m) => m.id === 'plain-substring');
  assert.deepEqual(plain, { id: 'plain-substring', description: 'a settings row is missing on a fresh store', remediation: 'seed the default row, then reload' });
  assert.equal(report.ok, false, 'console errors still fail the preflight - a known issue is named, not excused');
  assert.equal(report.knownIssuesWarnings, undefined);

  // Registry present but nothing matches: "checked, none matched" is [] (not null).
  consoleEntries.length = 0;
  consoleEntries.push({ level: 'error', message: 'some other failure', stack: null, at: new Date().toISOString() });
  const none = await api('POST', '/crv/preflight', { agent: 'ki-tab' });
  assert.deepEqual(none.knownIssueMatches, []);

  // A clean page against a populated registry is also [].
  consoleEntries.length = 0;
  assert.deepEqual((await api('POST', '/crv/preflight', { agent: 'ki-tab' })).knownIssueMatches, []);
});

test('knownIssueMatches: a broken registry is "could not check" (null + reason), and a bad entry is skipped with a warning', { skip: skipLive }, async () => {
  consoleEntries.length = 0;
  consoleEntries.push({ level: 'error', message: 'boom in the page', stack: null, at: new Date().toISOString() });

  fs.writeFileSync(registryPath, '{ not json');
  const broken = await api('POST', '/crv/preflight', { agent: 'ki-tab' });
  assert.equal(broken.knownIssueMatches, null);
  assert.match(broken.knownIssuesCheckError, /not valid JSON/);
  assert.equal(broken.connected, true, 'a broken registry never fails the preflight itself');

  fs.writeFileSync(registryPath, JSON.stringify([{ id: 'good', signature: 'boom in the page', description: 'd', remediation: 'r' }, { id: 'bad-regex', signature: '/(unclosed/' }, { nope: true }]));
  const partial = await api('POST', '/crv/preflight', { agent: 'ki-tab' });
  assert.deepEqual(partial.knownIssueMatches.map((m) => m.id), ['good']);
  assert.equal(partial.knownIssuesWarnings.length, 2);
  fs.rmSync(registryPath, { force: true });
});

test('the checked-in example registry is valid, loadable and clearly a placeholder', () => {
  const example = JSON.parse(fs.readFileSync(path.join(dir, 'known-issues.example.json'), 'utf8'));
  assert.ok(Array.isArray(example) && example.length >= 1);
  for (const entry of example) {
    for (const key of ['id', 'signature', 'description', 'remediation']) assert.equal(typeof entry[key], 'string', `${entry.id}.${key}`);
    assert.match(entry.description, /PLACEHOLDER/);
  }
});

test('crv preflight agents[]: two tabs taking one agent name from each other are flagged as a collision', { skip: skipLive }, async () => {
  await connect('collide-tab', { origin: 'http://127.0.0.1:9000' });
  await connect('quiet-tab', { origin: 'http://127.0.0.1:9001' });
  const before = await api('POST', '/crv/preflight', { agent: 'collide-tab' });
  const beforeRow = before.agents.find((a) => a.name === 'collide-tab');
  assert.equal(beforeRow.replacedCount, 0);
  assert.equal(beforeRow.tabCollision, false);
  assert.equal(beforeRow.msSinceLastReplace, null);

  // A second real tab connects under the SAME name, from a different origin, in quick succession.
  await connect('collide-tab', { origin: 'http://localhost:9000' });
  const report = await api('POST', '/crv/preflight', { agent: 'quiet-tab' });
  const row = report.agents.find((a) => a.name === 'collide-tab');
  assert.equal(row.tabCollision, true);
  assert.ok(row.replacedCount >= 1, JSON.stringify(row));
  assert.equal(row.origin, 'http://localhost:9000', 'the surviving connection is the later one');
  assert.ok(Number.isFinite(row.msSinceLastReplace) && row.msSinceLastReplace >= 0 && row.msSinceLastReplace < 60000);
  assert.ok(Number.isFinite(row.connectedAt));

  // The request asked about a DIFFERENT agent: the collision still shows, that agent's own row is clean.
  const quiet = report.agents.find((a) => a.name === 'quiet-tab');
  assert.equal(quiet.tabCollision, false);
  assert.equal(quiet.replacedCount, 0);

  // A second replacement accumulates rather than resetting.
  await connect('collide-tab', { origin: 'http://127.0.0.1:9000' });
  const again = (await api('POST', '/crv/preflight', { agent: 'collide-tab' })).agents.find((a) => a.name === 'collide-tab');
  assert.ok(again.replacedCount >= 2, JSON.stringify(again));
});

test('crv preflight carries agents[] even when the requested agent is not connected', { skip: skipLive }, async () => {
  const report = await api('POST', '/crv/preflight', { agent: 'nobody-connected' });
  assert.equal(report.connected, false);
  assert.ok(Array.isArray(report.agents));
  assert.ok(report.agents.some((a) => a.name === 'quiet-tab'));
});

test('session start --if-stale-min over HTTP: a young session is refused, threshold 0 ends it and starts fresh', { skip: skipLive }, async () => {
  const first = await api('POST', '/sessions', { goal: 'stale-flag first', agent: 'quiet-tab', briefing: false });
  const refused = await api('POST', '/sessions', { goal: 'stale-flag too young', agent: 'quiet-tab', briefing: false, if_stale_min: 60 });
  assert.ok(refused instanceof Error);
  assert.match(refused.message, /already active/);
  assert.match(refused.message, /younger than --if-stale-min 60/);
  assert.equal((await api('GET', `/sessions/${first.id}`)).status, 'active', 'a refused start ends nothing');

  const invalid = await api('POST', '/sessions', { goal: 'bad value', briefing: false, if_stale_min: 'soon' });
  assert.equal(invalid.status, 400);

  const fresh = await api('POST', '/sessions', { goal: 'stale-flag fresh', agent: 'quiet-tab', briefing: false, if_stale_min: 0 });
  assert.equal(fresh.autoEndedSession.id, first.id);
  assert.match(fresh.autoEndedSession.reason, /if-stale-min 0/);
  assert.equal((await api('GET', `/sessions/${first.id}`)).status, 'ended');
  assert.equal((await api('GET', '/health')).active_session.id, fresh.id);

  // Omitting the flag preserves today's behavior: always refuse.
  const plain = await api('POST', '/sessions', { goal: 'no flag', agent: 'quiet-tab', briefing: false });
  assert.ok(plain instanceof Error);
  assert.match(plain.message, /already active/);
  await api('POST', `/sessions/${fresh.id}/end`, {});
});

test('CLI: "session start --if-stale-min" refuses a young session and, at 0, ends it and says so', { skip: skipLive }, async () => {
  const first = await api('POST', '/sessions', { goal: 'cli stale first', agent: 'quiet-tab', briefing: false });
  const cli = path.join(dir, 'cli.mjs');
  const refused = await spawnAsync([cli, 'session', 'start', 'cli stale second', '--no-briefing', '--if-stale-min', '60', '--agent', 'quiet-tab'], { env: relay.env, cwd: dir });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /younger than --if-stale-min 60/);

  const bad = await spawnAsync([cli, 'session', 'start', 'cli bad', '--no-briefing', '--if-stale-min', 'abc'], { env: relay.env, cwd: dir });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /--if-stale-min needs a number/);

  const ok = await spawnAsync([cli, 'session', 'start', 'cli stale second', '--no-briefing', '--if-stale-min', '0', '--agent', 'quiet-tab'], { env: relay.env, cwd: dir });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stderr, /auto-ended by "session start --if-stale-min 0"/);
  const started = JSON.parse(ok.stdout);
  assert.equal(started.autoEndedSession.id, first.id);
  await api('POST', `/sessions/${started.id}/end`, {});
});
