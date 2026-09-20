// Smoke tests for tools/web-scout/cli.mjs, spawned as a REAL child process
// against a REAL relay - an ephemeral one on a free port with a throwaway
// database (see test-relay.mjs), so the result always reflects the code on
// disk. Set WEBSCOUT_TEST_LIVE=1 to run against the already-running relay
// instead (the only way to exercise a connected browser tab). Session-scoped
// tests that need a connected tab are skipped (not failed) when none is
// connected. Run with: node --test tools/web-scout/cli.test.mjs

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestRelay, connectFakeAgent } from './test-relay.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, 'cli.mjs');

const relay = await startTestRelay();
after(() => relay.stop());

function run(...args) {
  const res = spawnSync('node', [CLI, ...args], { encoding: 'utf8', timeout: 20000, env: { ...process.env, ...relay.env } });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

// Each test file now owns its own relay, so files can run in parallel. The
// best-effort `session end` only matters under WEBSCOUT_TEST_LIVE=1, where a
// previous crashed run may have left a dangling active session.
before(() => { run('session', 'end'); });

test('status exits 0 and prints real relay health as JSON', () => {
  const { status, stdout } = run('status');
  assert.equal(status, 0);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.status, 'ok');
  assert.ok(Array.isArray(parsed.agents_connected));
});

test('an unknown top-level command exits 1 with a helpful stderr message', () => {
  const { status, stderr } = run('not-a-real-command');
  assert.equal(status, 1);
  assert.match(stderr, /Unknown command/);
});

test('an unknown dom/idb subcommand exits 1', () => {
  const { status, stderr } = run('dom', 'not-a-real-action');
  assert.equal(status, 1);
  assert.match(stderr, /Unknown/);
});

test('session start with no goal exits 1 with the relay\'s real validation error', () => {
  const { status, stderr } = run('session', 'start');
  assert.equal(status, 1);
  assert.match(stderr, /non-empty goal/);
});

test('session show on a nonexistent id exits 1 with "no such session"', () => {
  const { status, stderr } = run('session', 'show', '999999999');
  assert.equal(status, 1);
  assert.match(stderr, /no such session/);
});

test('full round trip: session start -> current -> list -> end, exit 0 throughout', () => {
  const started = run('session', 'start', 'cli.test.mjs round trip', 'automated');
  assert.equal(started.status, 0, started.stderr);
  const session = JSON.parse(started.stdout);
  assert.equal(session.status, 'active');

  const current = run('session', 'current');
  assert.equal(current.status, 0);
  assert.equal(JSON.parse(current.stdout).id, session.id);

  const list = run('session', 'list');
  assert.equal(list.status, 0);
  assert.ok(JSON.parse(list.stdout).some((s) => s.id === session.id));

  const ended = run('session', 'end', String(session.id));
  assert.equal(ended.status, 0, ended.stderr);
  assert.equal(JSON.parse(ended.stdout).status, 'ended');
});

test('session viz returns the full derived-views payload, and --section slices it to just one', () => {
  const started = run('session', 'start', 'cli.test.mjs viz', 'automated');
  assert.equal(started.status, 0, started.stderr);
  const session = JSON.parse(started.stdout);

  const full = run('session', 'viz', String(session.id));
  assert.equal(full.status, 0, full.stderr);
  const viz = JSON.parse(full.stdout);
  for (const key of ['swimlane', 'episodes', 'stateMachine', 'sequence', 'waste', 'costTree', 'failureHeatmap', 'causality', 'routeMachine']) {
    assert.ok(key in viz, `viz is missing ${key}`);
  }

  const sliced = run('session', 'viz', String(session.id), '--section', 'waste');
  assert.equal(sliced.status, 0, sliced.stderr);
  assert.deepEqual(JSON.parse(sliced.stdout), viz.waste);

  const bad = run('session', 'viz', String(session.id), '--section', 'not-a-real-section');
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /--section must be one of/);

  run('session', 'end', String(session.id));
});

test('dom/idb/eval against a real connected tab (skipped if none connected in this environment)', (t) => {
  const { stdout: statusOut } = run('status');
  const { agents_connected } = JSON.parse(statusOut);
  if (!agents_connected.length) return t.skip('no browser tab connected to this relay - run with WEBSCOUT_TEST_LIVE=1 against a relay that has one');

  const started = run('session', 'start', 'cli.test.mjs dom/idb/eval', 'automated');
  assert.equal(started.status, 0, started.stderr);
  const session = JSON.parse(started.stdout);

  const evalRes = run('eval', '1+1');
  assert.equal(evalRes.status, 0, evalRes.stderr);
  assert.equal(JSON.parse(evalRes.stdout), 2);

  const idbList = run('idb', 'list');
  assert.equal(idbList.status, 0, idbList.stderr);
  const idbListParsed = JSON.parse(idbList.stdout);
  assert.ok(Array.isArray(idbListParsed.stores));
  // `counts` requires the CONNECTED TAB's own already-loaded inject.js to
  // include the idb.list row-count addition - a tab connected from before
  // that edit (stale in-page script, needs a page reload to pick up) won't
  // have it yet, so this is soft-checked (shape-if-present), not required,
  // to avoid coupling this test's pass/fail to unrelated live browser state.
  if (idbListParsed.counts !== undefined) {
    assert.equal(typeof idbListParsed.counts, 'object');
    for (const name of idbListParsed.stores) assert.ok(Number.isInteger(idbListParsed.counts[name]), `counts.${name} should be an integer`);
  }

  const domQuery = run('dom', 'query', 'body');
  assert.equal(domQuery.status, 0, domQuery.stderr);
  assert.equal(JSON.parse(domQuery.stdout).found, true);

  // `mutated`/`hrefChanged` have the same stale-connected-tab caveat as
  // `counts` above - soft-checked for the same reason.
  const domClick = run('dom', 'click', 'body');
  assert.equal(domClick.status, 0, domClick.stderr);
  const domClickParsed = JSON.parse(domClick.stdout);
  assert.equal(domClickParsed.clicked, true);
  if (domClickParsed.mutated !== undefined) assert.equal(typeof domClickParsed.mutated, 'boolean');
  if (domClickParsed.hrefChanged !== undefined) assert.equal(typeof domClickParsed.hrefChanged, 'boolean');

  run('session', 'end', String(session.id));
});

test('output is compact JSON when piped (indentation is tokens the caller pays for), indented with --pretty', () => {
  const compact = run('status');
  assert.equal(compact.status, 0);
  assert.equal(compact.stdout.trim().split('\n').length, 1, 'one line when piped');
  assert.doesNotMatch(compact.stdout, /\n\s+"/);
  const pretty = run('status', '--pretty');
  assert.equal(pretty.status, 0);
  assert.ok(pretty.stdout.trim().split('\n').length > 5, 'indented with --pretty');
  assert.deepEqual(JSON.parse(pretty.stdout).status, JSON.parse(compact.stdout).status);
  assert.ok(run('--pretty', 'status').stdout.trim().split('\n').length > 5, '--pretty may come first');
});

test('the read-shaping flags are accepted by the argument check, and rejected where they do not apply', () => {
  // no active session: the relay says so - which proves the flags got past validation
  for (const args of [['idb', 'dump', 'orders', '--peek'], ['idb', 'dump', 'orders', '--table', '--delta'], ['net', 'log', '--if-changed'], ['dom', 'query', 'body', '--peek', '--no-guard']]) {
    const r = run(...args);
    assert.equal(r.status, 1);
    assert.doesNotMatch(r.stderr, /does not take/, `${args.join(' ')} should be a valid invocation: ${r.stderr}`);
  }
  const bad = run('idb', 'put', 's', '{}', '--peek');
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /does not take --peek/);
});

test('session start takes --no-briefing and the reply carries no briefing then', () => {
  const started = run('session', 'start', 'cli.test.mjs briefing', 'automated', '--no-briefing');
  assert.equal(started.status, 0, started.stderr);
  const session = JSON.parse(started.stdout);
  assert.equal(session.briefing, undefined);
  run('session', 'end', String(session.id));
  const withBriefing = run('session', 'start', 'cli.test.mjs briefing', 'automated');
  const parsed = JSON.parse(withBriefing.stdout);
  assert.equal(parsed.briefing.available, false, 'no tab is connected to this relay');
  assert.match(parsed.briefing.reason, /no tab connected/);
  run('session', 'end', String(parsed.id));
});

// "macro update" (PUT /macros/:id/steps) already backed the dashboard's step inspector - the CLI
// had no way to fix a stale macro step short of delete + re-record from scratch.
test('"macro update" replaces a macro\'s whole step array, round trip through the real endpoint', async () => {
  const started = run('session', 'start', 'cli.test.mjs macro update', 'automated');
  const session = JSON.parse(started.stdout);
  const tab = await connectFakeAgent(relay.port, {});
  try {
    // dispatched over plain fetch, not the spawnSync CLI: the fake agent tab lives in THIS
    // process, and a synchronous spawnSync call would freeze this process's event loop, so the
    // relay's WS round trip to the tab could never get a reply (a real deadlock, reproduced while
    // writing this test). "macro record"/"update"/"show" below never talk to the tab, so the
    // spawnSync CLI is safe for those.
    const dispatch = (selector) => fetch(`http://127.0.0.1:${relay.port}/command`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'dom.click', params: { selector } }),
    }).then((r) => r.json());
    assert.equal((await dispatch('#a')).ok, true);
    assert.equal((await dispatch('#b')).ok, true);
    const recorded = run('macro', 'record', 'cli-update-test', String(session.id));
    assert.equal(recorded.status, 0, recorded.stderr);
    const macro = JSON.parse(recorded.stdout);
    assert.equal(macro.steps.length, 2);

    const updated = run('macro', 'update', String(macro.id), JSON.stringify([{ type: 'dom.click', params: { selector: '#c' } }]));
    assert.equal(updated.status, 0, updated.stderr);
    const parsed = JSON.parse(updated.stdout);
    assert.equal(parsed.steps.length, 1);
    assert.equal(parsed.steps[0].params.selector, '#c');

    const shown = run('macro', 'show', String(macro.id));
    assert.deepEqual(JSON.parse(shown.stdout).steps, parsed.steps);
  } finally {
    await tab.close();
    run('session', 'end', String(session.id));
  }
});

test('"macro update" rejects malformed JSON and a non-array before touching the relay', () => {
  const badJson = run('macro', 'update', '1', 'not-json');
  assert.equal(badJson.status, 1);
  assert.match(badJson.stderr, /not valid JSON/);

  const notArray = run('macro', 'update', '1', '{"type":"dom.click"}');
  assert.equal(notArray.status, 1);
  assert.match(notArray.stderr, /must be a JSON array/);
});
