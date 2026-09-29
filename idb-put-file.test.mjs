// "idb put"/"idb put-many" --file <path> - reads the row/rows JSON from disk instead of a raw
// CLI arg, same fix as "eval --file": a row with a nested quote/apostrophe in a string field was
// confirmed real shell-quoting friction bulk-seeding fixture rows by hand. Uses async spawn (not
// spawnSync) so this process's event loop stays free to service the fake agent's WebSocket while
// the CLI subprocess is running - spawnSync would deadlock the round trip (see cli.test.mjs's
// "macro update" test, which hit and documented the same issue).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestRelay, connectFakeAgent } from './test-relay.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, 'cli.mjs');

let relay;
let tab;
let sessionId;

function run(...args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, ...relay.env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

before(async () => {
  relay = await startTestRelay();
  tab = await connectFakeAgent(relay.port, {
    'idb.put': (p) => ({ store: p.store, key: p.row?.id, row: p.row }),
    'idb.putMany': (p) => ({ store: p.store, rows: p.rows, failed: [] }),
  });
  const started = await run('session', 'start', 'idb-put-file.test.mjs', 'automated');
  sessionId = JSON.parse(started.stdout).id;
});
after(async () => {
  if (sessionId) await run('session', 'end', String(sessionId));
  await tab?.close();
  await relay.stop();
});

test('idb put --file reads the row JSON from disk, preserving a nested quote/apostrophe intact', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'webscout-idb-put-')), 'row.json');
  fs.writeFileSync(file, JSON.stringify({ id: 2, body: 'quote " and apostrophe \'' }));
  const viaFile = await run('idb', 'put', 'notes', '--file', file);
  assert.equal(viaFile.status, 0, viaFile.stderr);
  assert.equal(JSON.parse(viaFile.stdout).row.body, 'quote " and apostrophe \'');
});

test('idb put-many --file reads the rows-array JSON from disk', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'webscout-idb-putmany-')), 'rows.json');
  fs.writeFileSync(file, JSON.stringify([{ id: 1 }, { id: 2 }]));
  const result = await run('idb', 'put-many', 'notes', '--file', file);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).rows.length, 2);
});

test('idb put with neither a JSON arg nor --file exits 1 with a clear message', async () => {
  const result = await run('idb', 'put', 'notes');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires either a JSON arg or --file/);
});

test('idb put --file pointing at an empty file exits 1, does not silently attempt a no-op write', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'webscout-idb-put-empty-')), 'row.json');
  fs.writeFileSync(file, '   ');
  const result = await run('idb', 'put', 'notes', '--file', file);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /empty\/whitespace-only/);
});

test('idb put with malformed JSON exits 1 naming the command, not a stack trace', async () => {
  const result = await run('idb', 'put', 'notes', 'not-json');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /idb put.*did not parse as JSON/);
});
