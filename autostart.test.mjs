// A dead relay is restarted by the first call that finds it refusing
// connections (another session's blanket kill took it down twice), except for
// `relay status`, `status`, and WEBSCOUT_NO_AUTOSTART=1.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort } from './test-relay.mjs';
import { stopRelay } from './relay-control.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'webscout-autostart-'));
const port = await freePort();
const env = {
  ...process.env,
  WEBSCOUT_PORT: String(port),
  WEBSCOUT_DB_PATH: path.join(tmp, 'test.db'),
  WEBSCOUT_PID_PATH: path.join(tmp, 'relay.pid'),
  WEBSCOUT_NO_AUTOOPEN: '1',
};
const cli = (extraEnv, ...args) => spawnSync(process.execPath, [path.join(__dirname, 'cli.mjs'), ...args], { encoding: 'utf8', env: { ...env, ...extraEnv }, timeout: 60000 });
// a raw socket, not fetch: a fetch left pending when --test-force-exit fires trips a libuv assertion on Windows
const alive = () => new Promise((resolve) => {
  const socket = net.connect(port, '127.0.0.1');
  socket.once('connect', () => { socket.destroy(); resolve(true); });
  socket.once('error', () => resolve(false));
});

after(async () => {
  await stopRelay({ port }).catch(() => {});
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* temp dir */ }
});

test('WEBSCOUT_NO_AUTOSTART=1 keeps the old behaviour: a clear error, nothing started', async () => {
  const r = cli({ WEBSCOUT_NO_AUTOSTART: '1' }, 'agents');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /cannot reach the web-scout relay/);
  assert.equal(await alive(), false);
});

test('`relay status` and `status` report a dead relay without starting one', async () => {
  const s = cli({}, 'relay', 'status');
  assert.match(s.stdout, /"running": false/);
  assert.equal(await alive(), false);
  const h = cli({}, 'status');
  assert.equal(h.status, 1);
  assert.equal(await alive(), false);
});

test('a call against a dead relay starts one, says so, and completes', async () => {
  const r = cli({}, 'agents');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /the relay was not running - started a fresh one/);
  assert.equal(await alive(), true);
  const second = cli({}, 'agents');
  assert.equal(second.status, 0);
  assert.doesNotMatch(second.stderr, /not running/, 'no note once the relay is up');
});
