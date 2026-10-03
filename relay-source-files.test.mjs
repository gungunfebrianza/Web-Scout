// Guard: the relay's stale-code watch list and the test copies must cover every module the relay
// transitively imports. A missing entry means (a) an edit to it never shows as stale and (b) a
// relay copied to a temp dir for a test crashes on import - which is how relay-control and
// auto-restart tests went red unnoticed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RELAY_SOURCE_FILES } from './relay-control.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));

test('RELAY_SOURCE_FILES lists every local module the relay transitively imports', () => {
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    for (const m of text.matchAll(/(?:from|import)\s*\(?\s*'\.\/([a-z0-9.-]+\.mjs)'/g)) walk(m[1]);
  };
  walk('relay.mjs');
  const missing = [...seen].filter((f) => !RELAY_SOURCE_FILES.includes(f));
  assert.deepEqual(missing, [], 'add these to RELAY_SOURCE_FILES in relay-control.mjs');
});
