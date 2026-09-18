// One report of every surface a page command still needs. Adding a command
// touches the in-page handler, the registry, the CLI, the MCP tool and the
// docs; each of those already has a test, but they fail separately and one at
// a time. This lists every command with everything it is missing, in a single
// failure, and refuses a scaffold stub (scaffold-command.mjs) left unfinished.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMAND_TYPES } from './command-registry.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
const cli = read('cli.mjs');
const mcp = read('mcp-server.mjs');
const relay = read('relay.mjs');
const client = read('client.mjs'); // helpers shared by the CLI and MCP (dbVersionCheck, pageFresh, ...)
const inject = read('inject.js');

// A type a caller never asks for by name: each needs a reason to skip a surface.
const NOT_USER_FACING = {
  'page.epoch': 'internal probe the relay sends before serving a cached read',
  'idb.snapshot': 'persisted through POST /state/snapshot, dispatched by its own routes',
};

const quoted = (source, type) => source.includes(`'${type}'`) || source.includes(`"${type}"`);

test('every page command is reachable from the CLI and MCP (or is explicitly not user-facing)', () => {
  const problems = [];
  for (const type of Object.keys(COMMAND_TYPES)) {
    if (NOT_USER_FACING[type]) continue;
    const missing = [];
    if (!quoted(cli, type) && !quoted(client, type) && !quoted(relay, type)) missing.push('cli.mjs (no send call), client.mjs or a relay route');
    if (!quoted(mcp, type) && !quoted(client, type) && !quoted(relay, type)) missing.push('mcp-server.mjs (no sendCmd call), client.mjs or a relay route');
    if (missing.length) problems.push(`${type}: missing from ${missing.join(', ')}`);
  }
  assert.deepEqual(problems, [], `finish these commands (see "Adding a new command" in CONTRIBUTING.md):\n${problems.join('\n')}`);
});

test('NOT_USER_FACING only lists registry types', () => {
  assert.deepEqual(Object.keys(NOT_USER_FACING).filter((t) => !(t in COMMAND_TYPES)), []);
});

test('no scaffold stub is left unfinished', () => {
  const left = [];
  for (const [file, source] of [['inject.js', inject], ['command-registry.mjs', read('command-registry.mjs')], ['cli.mjs', cli], ['mcp-server.mjs', mcp], ['cli-spec.mjs', read('cli-spec.mjs')], ['usage.txt', read('usage.txt')]]) {
    for (const m of source.matchAll(/SCAFFOLD\(([\w.]+)\)/g)) left.push(`${m[1]} in ${file}`);
  }
  assert.deepEqual(left, [], `replace every SCAFFOLD(...) marker with the real thing:\n${left.join('\n')}`);
});
