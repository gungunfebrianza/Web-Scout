// Sliced help: every command reachable, slices small, nothing lost, and the CLI wired to it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLI_SPEC } from './cli-spec.mjs';
import { parseUsage, helpIndex, helpTopic } from './help.mjs';
import { spawnClean } from './test-relay.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const text = fs.readFileSync(path.join(dir, 'usage.txt'), 'utf8');
const parsed = parseUsage(text);
const cli = (...args) => spawnClean([path.join(dir, 'cli.mjs'), ...args], { cwd: dir });

test('every CLI command has its own entry in the sliced help', () => {
  const missing = [];
  for (const { cmd } of CLI_SPEC) {
    const [topic, sub] = cmd.split(' ');
    const out = helpTopic(parsed, topic, sub);
    const escaped = cmd.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
    if (!out || !new RegExp(String.raw`(^|\n) {2}${escaped}(\s|$)`).test(out)) missing.push(cmd);
  }
  assert.deepEqual(missing, [], 'these commands do not slice out of usage.txt - check their entry starts with two spaces and the command');
});

test('slicing loses nothing: the index, groups and prose blocks together are the whole file', () => {
  const nonBlank = (t) => t.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim());
  assert.deepEqual([parsed.header, ...parsed.blocks.map((b) => b.text)].flatMap(nonBlank), nonBlank(text));
});

test('the index is a few hundred tokens and a group is a fraction of the file', () => {
  const index = helpIndex(parsed);
  assert.ok(index.length < 2200, `index is ${index.length} chars`);
  assert.ok(index.includes('idb') && index.includes('dump') && index.includes('tokens'));
  for (const topic of ['idb', 'session', 'dom']) assert.ok(helpTopic(parsed, topic).length < text.length * 0.25, `${topic} slice`);
  const one = helpTopic(parsed, 'idb', 'dump');
  assert.match(one, /idb dump <store>/);
  assert.doesNotMatch(one, /idb snapshot/);
  assert.ok(one.length < 3500);
});

test('a topic that does not exist is null, not the whole file', () => {
  assert.equal(helpTopic(parsed, 'nonsense'), null);
  assert.equal(helpTopic(parsed, 'idb', 'nonsense'), null);
});

test('the prose sections are reachable by name', () => {
  assert.match(helpTopic(parsed, 'tokens'), /Reading with fewer tokens/);
  assert.match(helpTopic(parsed, 'notes'), /Argument checking/);
  assert.match(helpTopic(parsed, 'global'), /Global flag/);
});

test('cli.mjs: bare and unknown commands print the index, help <topic> a slice, help all the file', () => {
  const bare = cli();
  assert.equal(bare.status, 1);
  assert.ok(bare.stdout.length < 2200 && /help <topic>/.test(bare.stdout));
  const slice = cli('help', 'idb', 'dump');
  assert.equal(slice.status, 0);
  assert.match(slice.stdout, /idb dump <store>/);
  assert.doesNotMatch(slice.stdout, /session start/);
  const viaFlag = cli('dom', 'query', '--help');
  assert.equal(viaFlag.status, 0);
  assert.match(viaFlag.stdout, /dom query <selector>/);
  assert.doesNotMatch(viaFlag.stdout, /idb dump/);
  const all = cli('help', 'all');
  assert.ok(all.stdout.length > 50000);
  const unknown = cli('help', 'nonsense');
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /no help for "nonsense"/);
});
