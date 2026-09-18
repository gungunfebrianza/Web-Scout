// Pure static checks - no relay, no browser. Fails when a command type is
// added to inject.js without being classified in command-registry.mjs, or a
// registry row is half-classified (e.g. a write that cleanup cannot see).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMAND_TYPES, MUTATING_TYPES, STRICT_CRV_TYPES, READ_CACHEABLE_TYPES, findRegistryProblems } from './command-registry.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function injectHandlerTypes() {
  const src = fs.readFileSync(path.join(__dirname, 'inject.js'), 'utf8');
  const start = src.indexOf('const handlers = {');
  assert.ok(start !== -1, 'could not find `const handlers = {` in inject.js - update this test if the handler table moved');
  const end = src.indexOf('\n  };\n', start);
  const body = src.slice(start, end);
  const types = new Set();
  for (const m of body.matchAll(/^    (?:'([\w.]+)'|(\w+)):/gm)) types.add(m[1] ?? m[2]);
  return types;
}

test('every inject.js handler is classified in command-registry.mjs', () => {
  const missing = [...injectHandlerTypes()].filter((t) => !(t in COMMAND_TYPES));
  assert.deepEqual(missing, [], `inject.js handles these types but command-registry.mjs does not classify them: ${missing.join(', ')}`);
});

test('every registry type is actually handled by inject.js', () => {
  const handled = injectHandlerTypes();
  const orphaned = Object.keys(COMMAND_TYPES).filter((t) => !handled.has(t));
  assert.deepEqual(orphaned, [], `registry lists types inject.js does not handle: ${orphaned.join(', ')}`);
});

test('no registry row is half-classified', () => {
  assert.deepEqual(findRegistryProblems(), []);
});

test('the derived sets keep the invariants the relay depends on', () => {
  for (const t of STRICT_CRV_TYPES) assert.ok(MUTATING_TYPES.has(t), `${t} is strict-CRV but does not invalidate the read cache`);
  for (const t of READ_CACHEABLE_TYPES) assert.ok(!MUTATING_TYPES.has(t), `${t} is both cacheable and mutating`);
});

test('a net/console log clear invalidates the cached log it empties', () => {
  assert.ok(MUTATING_TYPES.has('net.clear'));
  assert.ok(MUTATING_TYPES.has('console.clear'));
});

test('relay.mjs derives its sets from the registry instead of redeclaring them', () => {
  const relay = fs.readFileSync(path.join(__dirname, 'relay.mjs'), 'utf8');
  for (const name of ['STRICT_CRV_TYPES', 'LONG_POLL_TYPES', 'DEFAULT_MACRO_TYPES', 'TIMEOUT_VERIFIABLE_TYPES', 'AUTO_SCREENSHOT_ON_FAILURE_TYPES', 'READ_CACHEABLE_TYPES', 'MUTATING_TYPES']) {
    assert.doesNotMatch(relay, new RegExp(`const ${name} = new Set`), `relay.mjs redeclares ${name} - edit command-registry.mjs instead`);
  }
});

test('every cleanup kind in the registry has a branch in relay.mjs cleanup tracking', () => {
  const relay = fs.readFileSync(path.join(__dirname, 'relay.mjs'), 'utf8');
  for (const kind of new Set(Object.values(COMMAND_TYPES).map((m) => m.cleanup).filter(Boolean))) {
    assert.match(relay, new RegExp(`kind === '${kind}'`), `cleanup kind '${kind}' has no branch in relay.mjs`);
  }
});
