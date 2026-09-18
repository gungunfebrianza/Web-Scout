// Docs drift: every CLI command and flag is documented where a user looks.
// The previous round shipped `net capture`, `idb put-many` and `--dry-run`
// with usage() updated but the README silent about all three - four places
// (usage text, README, roadmap, MCP descriptions) drift independently.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLI_SPEC } from './cli-spec.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const usage = fs.readFileSync(path.join(dir, 'usage.txt'), 'utf8');
const readme = fs.readFileSync(path.join(dir, 'README.md'), 'utf8');

test('usage.txt has no control characters (a template-literal escape once put a NUL in the help text)', () => {
  const bad = [...usage].filter((c) => c.charCodeAt(0) < 32 && c !== '\n' && c !== '\r' && c !== '\t');
  assert.deepEqual(bad, []);
});

test('every CLI command appears in usage.txt', () => {
  const missing = CLI_SPEC.map((r) => r.cmd).filter((cmd) => !new RegExp(`(^|\\s)${cmd.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}(\\s|$|\\|)`, 'm').test(usage));
  assert.deepEqual(missing, []);
});

test('every CLI flag appears in usage.txt', () => {
  const flags = new Set(CLI_SPEC.flatMap((r) => [...(r.bool ?? []), ...(r.val ?? [])]));
  const missing = [...flags].filter((f) => !usage.includes(f));
  assert.deepEqual(missing, []);
});

test('every CLI command appears in README.md', () => {
  const missing = CLI_SPEC.map((r) => r.cmd).filter((cmd) => !readme.includes(cmd));
  assert.deepEqual(missing, [], 'document these in README.md (a command reference or feature bullet)');
});

test('the README documents the flags a user is most likely to miss', () => {
  for (const flag of ['--dry-run', '--since', '--where', '--fields', '--limit', '--strict-crv', '--token-budget', '--off', '--summary']) {
    assert.ok(readme.includes(flag), `README.md never mentions ${flag}`);
  }
});
