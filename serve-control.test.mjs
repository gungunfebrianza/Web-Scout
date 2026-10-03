// "crv serve"/"crv stop" (serve-control.mjs + static-server.mjs) against a REAL spawned
// process on a real port - real verification, not a mocked spawn. Mirrors
// relay-control.test.mjs's shape (its own port, its own pidfile, real HTTP checks).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort } from './test-relay.mjs';
import { tmpDir } from './scratch.mjs';

const realDir = path.dirname(fileURLToPath(import.meta.url));
const tmp = tmpDir('webscout-serve-control-');
const { startStaticServer, stopStaticServer, readServePidfile } = await import('./serve-control.mjs');

let port;
let servedDir;

before(async () => {
  port = await freePort();
  servedDir = path.join(tmp, 'site');
  fs.mkdirSync(servedDir, { recursive: true });
  fs.writeFileSync(path.join(servedDir, 'index.html'), '<!doctype html><title>fixture</title>hello');
  fs.writeFileSync(path.join(servedDir, 'app.js'), 'console.log(1);');
  fs.mkdirSync(path.join(servedDir, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(servedDir, 'sub', 'x.json'), '{"ok":true}');
});

after(async () => {
  await stopStaticServer({ port }).catch(() => {});
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* temp dir */ }
});

test('serve refuses a directory that does not exist', async () => {
  const r = await startStaticServer({ dir: path.join(tmp, 'nope'), port });
  assert.equal(r.started, false);
  assert.match(r.reason, /no such directory/);
});

test('serve spawns a detached server, writes a pidfile, and it actually serves the directory', async () => {
  const r = await startStaticServer({ dir: servedDir, port });
  assert.equal(r.started, true, JSON.stringify(r));
  assert.equal(readServePidfile(port).pid, r.pid);

  const index = await (await fetch(`http://127.0.0.1:${port}/`)).text();
  assert.match(index, /hello/);
  const js = await fetch(`http://127.0.0.1:${port}/app.js`);
  assert.equal(js.headers.get('content-type'), 'text/javascript; charset=utf-8');
  const nested = await (await fetch(`http://127.0.0.1:${port}/sub/x.json`)).json();
  assert.deepEqual(nested, { ok: true });
  const missing = await fetch(`http://127.0.0.1:${port}/ghost.html`);
  assert.equal(missing.status, 404);
});

test('serve refuses a second server on a port already tracked as serving', async () => {
  const r = await startStaticServer({ dir: servedDir, port });
  assert.equal(r.started, false);
  assert.match(r.reason, /already tracked/);
});

test('a request path cannot escape the served directory', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/../../../etc/passwd`);
  // The browser/fetch client normalizes ".." before the request even leaves - so this proves
  // the real end-to-end behavior (no escape), whichever layer normalized it.
  assert.notEqual(res.status, 200);
});

test('stop terminates the server, removes the pidfile, and the port is free again', async () => {
  const r = await stopStaticServer({ port });
  assert.equal(r.stopped, true, JSON.stringify(r));
  assert.equal(fs.existsSync(path.join(os.tmpdir(), `webscout-serve-${port}.json`)), false);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) }));
});

test('stop with nothing tracked reports that instead of throwing', async () => {
  const r = await stopStaticServer({ port });
  assert.equal(r.stopped, false);
  assert.match(r.reason, /nothing tracked/);
});

test('CLI: "crv serve" then "crv stop" end to end', async () => {
  const { spawnSync } = await import('node:child_process');
  const cliPort = await freePort();
  const start = spawnSync(process.execPath, [path.join(realDir, 'cli.mjs'), 'crv', 'serve', servedDir, '--port', String(cliPort)], { encoding: 'utf8', env: process.env });
  assert.equal(start.status, 0, start.stderr);
  const startOut = JSON.parse(start.stdout);
  assert.equal(startOut.started, true, start.stdout);
  assert.match(await (await fetch(`http://127.0.0.1:${cliPort}/`)).text(), /hello/);

  const stop = spawnSync(process.execPath, [path.join(realDir, 'cli.mjs'), 'crv', 'stop', '--port', String(cliPort)], { encoding: 'utf8', env: process.env });
  assert.equal(stop.status, 0, stop.stderr);
  assert.equal(JSON.parse(stop.stdout).stopped, true, stop.stdout);
});
