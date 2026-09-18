// Argument validation: an unknown flag or an extra positional must stop the
// command before anything is dispatched. No relay is needed - validation runs
// first, so these spawn the CLI pointed at a port nothing listens on and
// still expect the validation error, not a connection error.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLI_SPEC, validateArgs, findSpec, findMsysMangledArgs } from './cli-spec.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cli.mjs');
const run = (...args) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 15000, env: { ...process.env, WEBSCOUT_PORT: '1' } });
  return { status: r.status, stderr: r.stderr ?? '', stdout: r.stdout ?? '' };
};

test('valid invocations pass', () => {
  assert.equal(validateArgs('token-report', ['--session', '206']), null);
  assert.equal(validateArgs('dom', ['fill', '#x', 'hello', '--nth', '2']), null);
  assert.equal(validateArgs('idb', ['put', 'store', '{"a":1}', '--dry-run']), null);
  assert.equal(validateArgs('session', ['start', 'goal', 'ctx', '--strict-crv', '--stores', 'a,b', '--tags', 'x,y']), null);
  assert.equal(validateArgs('net', ['log', '--limit', '3', '--url', '/api']), null);
  assert.equal(validateArgs('macro', ['run', '5', '--confirm', '--from-step', '2']), null);
});

test('a flag value is not counted as a positional', () => {
  assert.equal(validateArgs('idb', ['dump', 'store', '--where', '{"a":1}', '--limit', '5']), null);
  assert.equal(validateArgs('dom', ['wait', '#x', '--text', 'hello world']), null);
});

test('an unknown flag is rejected and the valid flags are listed', () => {
  const err = validateArgs('idb', ['put', 's', '{}', '--dryrun']);
  assert.match(err, /does not take --dryrun/);
  assert.match(err, /--dry-run/);
});

test('token-report --session is a real flag; a misspelling is rejected (the original silent-drop bug)', () => {
  assert.match(validateArgs('token-report', ['--sesion', '206']), /does not take --sesion/);
  assert.match(validateArgs('token-report', ['206']), /got 1 positional/);
});

test('an extra positional is rejected (an unquoted multi-word value used to be silently truncated)', () => {
  assert.match(validateArgs('dom', ['fill', '#x', 'hello', 'world']), /extra: "world"/);
});

test('a fill value that merely starts with dashes is data, not a flag', () => {
  assert.equal(validateArgs('dom', ['fill', '#select', '-- Choose --']), null);
});

test('eval is lenient: its expression may start with --', () => {
  assert.equal(validateArgs('eval', ['--i']), null);
  assert.equal(validateArgs('eval', ['1', '+', '1']), null);
});

test('an unknown command is left to the dispatcher', () => {
  assert.equal(validateArgs('not-a-command', ['--whatever']), null);
  assert.equal(findSpec('not-a-command', []), null);
});

test('the CLI itself exits 1 with the validation message, before touching the relay', () => {
  const a = run('token-report', '--sesion', '5');
  assert.equal(a.status, 1);
  assert.match(a.stderr, /does not take --sesion/);
  assert.doesNotMatch(a.stderr, /cannot reach/);
  const b = run('idb', 'put', 's', '{"a":1}', '--dryrun');
  assert.equal(b.status, 1);
  assert.match(b.stderr, /nothing was run/);
});

test('every spec row is well-formed', () => {
  const seen = new Set();
  for (const row of CLI_SPEC) {
    assert.ok(!seen.has(row.cmd), `duplicate spec row ${row.cmd}`);
    seen.add(row.cmd);
    assert.ok(Array.isArray(row.pos) && row.pos.length === 2 && row.pos[0] <= row.pos[1], `${row.cmd}: bad pos`);
    for (const f of [...(row.bool ?? []), ...(row.val ?? [])]) assert.match(f, /^--[a-z][a-z0-9-]*$/, `${row.cmd}: bad flag ${f}`);
  }
});

test('a leading-slash argument that Git Bash rewrote into a Windows path is detected', () => {
  assert.deepEqual(findMsysMangledArgs(['C:/Program Files/Git/api/save', '--timeout', '5']), ['C:/Program Files/Git/api/save']);
  assert.deepEqual(findMsysMangledArgs(['/api/save', 'D:/my/project/file.js']), []);
});

test('the CLI warns about a Git-Bash-mangled argument before running', () => {
  const r = run('net', 'wait', 'C:/Program Files/Git/api/save');
  assert.match(r.stderr, /Git Bash rewrote a leading-slash argument/);
  assert.match(r.stderr, /MSYS_NO_PATHCONV=1/);
});
