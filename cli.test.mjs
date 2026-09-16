// Smoke tests for tools/web-scout/cli.mjs, spawned as a REAL child process
// against the real, already-running relay (node tools/web-scout/relay.mjs)
// - same "real, not simulated" discipline as mcp-server.test.mjs. Session-
// scoped tests that need a connected browser tab are skipped (not failed)
// when none is connected, so this still runs meaningfully in a headless CI
// environment. Run with: node --test tools/web-scout/cli.test.mjs

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, 'cli.mjs');

function run(...args) {
  const res = spawnSync('node', [CLI, ...args], { encoding: 'utf8', timeout: 20000 });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

// This file's tests share one mutable real resource with the relay (its
// single server-side "active session", and mcp-server.test.mjs's tests
// share the same one) - MUST run with `node --test --test-concurrency=1`
// across both files (see README "Testing"), never in parallel, or two
// files' session start/end calls race the relay's one-active-session
// constraint. Defensive best-effort cleanup here too: a previous run that
// crashed mid-test (an assertion failure before its own `session end`
// call) leaves a dangling active session that would otherwise fail every
// `session start` in this run with a confusing "already active" error
// pointing at a session this run never created.
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

test('dom/idb/eval against a real connected tab (skipped if none connected in this environment)', () => {
  const { stdout: statusOut } = run('status');
  const { agents_connected } = JSON.parse(statusOut);
  if (!agents_connected.length) return; // environment gap, not a cli.mjs bug - see mcp-server.test.mjs for the same pattern

  const started = run('session', 'start', 'cli.test.mjs dom/idb/eval', 'automated');
  assert.equal(started.status, 0, started.stderr);
  const session = JSON.parse(started.stdout);

  const evalRes = run('eval', '1+1');
  assert.equal(evalRes.status, 0, evalRes.stderr);
  assert.equal(JSON.parse(evalRes.stdout), 2);

  const idbList = run('idb', 'list');
  assert.equal(idbList.status, 0, idbList.stderr);
  assert.ok(Array.isArray(JSON.parse(idbList.stdout).stores));

  const domQuery = run('dom', 'query', 'body');
  assert.equal(domQuery.status, 0, domQuery.stderr);
  assert.equal(JSON.parse(domQuery.stdout).found, true);

  run('session', 'end', String(session.id));
});
