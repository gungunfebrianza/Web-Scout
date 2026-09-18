// relay start/stop/restart and stale-code detection, against a COPY of the
// relay source in a temp directory - so "edit a source file" can be simulated
// (bump a copy's mtime) without touching the real files or any relay a
// developer has running.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { freePort } from './test-relay.mjs';

const realDir = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'webscout-relay-control-'));
const pidPath = path.join(tmp, 'relay.pid');
// pidfilePath() reads this from process.env, and the relay child inherits it
process.env.WEBSCOUT_PID_PATH = pidPath;
const { startRelay, stopRelay, restartRelay, resolveRelayPid, readPidfile, RELAY_SOURCE_FILES } = await import('./relay-control.mjs');

const COPIED = [...RELAY_SOURCE_FILES, 'relay-control.mjs', 'dashboard.html'];
let port;
let script;
let opts;

before(async () => {
  for (const f of COPIED) fs.copyFileSync(path.join(realDir, f), path.join(tmp, f));
  script = path.join(tmp, 'relay.mjs');
  port = await freePort();
  opts = {
    port, script, logPath: path.join(tmp, 'relay.log'),
    env: { WEBSCOUT_DB_PATH: path.join(tmp, 'test.db'), WEBSCOUT_NO_AUTOOPEN: '1', WEBSCOUT_PID_PATH: pidPath },
  };
});

after(async () => {
  await stopRelay({ port }).catch(() => {});
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* temp dir */ }
});

const health = async () => (await (await fetch(`http://127.0.0.1:${port}/health`)).json()).result;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('start launches a detached relay and writes a pidfile', async () => {
  const r = await startRelay(opts);
  assert.equal(r.started, true, JSON.stringify(r));
  const h = await health();
  assert.equal(h.relay.pid, r.pid);
  assert.equal(readPidfile(port).pid, r.pid);
  assert.equal(resolveRelayPid(port).via, 'pidfile');
});

test('start refuses when a relay is already answering', async () => {
  const r = await startRelay(opts);
  assert.equal(r.started, false);
  assert.match(r.reason, /already answering/);
});

test('an edit to a source file the relay loaded shows up as stale, on /health and as a header', async () => {
  assert.deepEqual((await health()).relay.stale_source_files, []);
  const future = new Date(Date.now() + 60_000);
  fs.utimesSync(path.join(tmp, 'report.mjs'), future, future);
  await sleep(2300); // the relay caches the mtime check for ~2s
  assert.deepEqual((await health()).relay.stale_source_files, ['report.mjs']);
  const res = await fetch(`http://127.0.0.1:${port}/agents`);
  assert.equal(res.headers.get('x-webscout-relay-stale'), 'report.mjs');
});

test('the CLI warns once on stderr when the relay is running stale code', () => {
  const r = spawnSync(process.execPath, [path.join(realDir, 'cli.mjs'), 'agents'], { encoding: 'utf8', env: { ...process.env, WEBSCOUT_PORT: String(port) } });
  assert.equal(r.status, 0);
  assert.match(r.stderr, /relay is running code older than what is on disk \(report\.mjs changed/);
  assert.match(r.stderr, /relay restart/);
});

test('restart replaces the process, and the new one is no longer stale', async () => {
  const oldPid = (await health()).relay.pid;
  const r = await restartRelay(opts);
  assert.equal(r.restarted, true, JSON.stringify(r));
  assert.equal(r.stop.pid, oldPid);
  const h = await health();
  assert.notEqual(h.relay.pid, oldPid);
  assert.deepEqual(h.relay.stale_source_files, []);
});

test('stop terminates the relay and removes the pidfile', async () => {
  const r = await stopRelay({ port });
  assert.equal(r.stopped, true, JSON.stringify(r));
  await assert.rejects(fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) }));
  assert.equal(fs.existsSync(pidPath), false);
});

test('stop with nothing listening reports that instead of throwing', async () => {
  const r = await stopRelay({ port });
  assert.equal(r.stopped, false);
  assert.match(r.reason, /nothing is listening/);
});

test('restart with nothing running just starts one', async () => {
  const r = await restartRelay(opts);
  assert.equal(r.restarted, true, JSON.stringify(r));
  await stopRelay({ port });
});

test('stop refuses to kill a process that owns the port but is not a web-scout relay', async () => {
  const otherPort = await freePort();
  const server = http.createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end('{"hello":"world"}'); });
  await new Promise((resolve) => server.listen(otherPort, '127.0.0.1', resolve));
  try {
    const r = await stopRelay({ port: otherPort });
    assert.equal(r.stopped, false);
    assert.match(r.reason, /refusing to kill/);
    // and the imposter is still alive
    assert.equal((await (await fetch(`http://127.0.0.1:${otherPort}/`)).json()).hello, 'world');
  } finally {
    server.close();
  }
});
