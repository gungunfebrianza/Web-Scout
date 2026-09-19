// A dead relay is restarted by the first call that finds it refusing
// connections (another session's blanket kill took it down twice), except for
// `relay status`, `status`, and WEBSCOUT_NO_AUTOSTART=1.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort, isUp, spawnClean } from './test-relay.mjs';
import { stopRelay } from './relay-control.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'webscout-autostart-'));
const port = await freePort();
// This test exercises the REAL client.mjs autostartRelay() path, the other call site that
// unconditionally sets WEBSCOUT_AUTO_CALIBRATE=1 on the relay it spawns - isolated the same way
// auto-restart.test.mjs is (see its own comment on why this is load-bearing, not just tidy).
const env = {
  WEBSCOUT_PORT: String(port),
  WEBSCOUT_DB_PATH: path.join(tmp, 'test.db'),
  WEBSCOUT_PID_PATH: path.join(tmp, 'relay.pid'),
  WEBSCOUT_NO_AUTOOPEN: '1',
  WEBSCOUT_TOKEN_CALIBRATION: path.join(tmp, 'token-calibration.json'),
  WEBSCOUT_TRANSCRIPT_HOME: tmp,
};
const cli = (extraEnv, ...args) => spawnClean([path.join(__dirname, 'cli.mjs'), ...args], { env: { ...env, ...extraEnv } });
const alive = () => isUp(port);

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
  assert.equal(JSON.parse(s.stdout).running, false);
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
  const status = JSON.parse(cli({}, 'relay', 'status').stdout);
  assert.equal(status.events24h.autostarts, 1, 'the autostart is on record, so a kill loop is visible');
  assert.equal(status.events24h.uncleanExits, 0);
});
