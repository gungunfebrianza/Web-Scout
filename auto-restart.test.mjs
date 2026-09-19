// `session start` restarts a relay that is running older code than what is on disk, because that
// is the one moment nothing is in flight. Mid-session it only warns, and it can be turned off.
// Run against a COPY of the relay source in a temp directory, so "edit a source file" is a bump
// of the copy's mtime and no relay a developer has running is touched.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort, spawnClean } from './test-relay.mjs';

const realDir = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'webscout-auto-restart-'));
const pidPath = path.join(tmp, 'relay.pid');
process.env.WEBSCOUT_PID_PATH = pidPath;
const { startRelay, stopRelay, readRelayEvents, RELAY_SOURCE_FILES } = await import('./relay-control.mjs');

let port;
let env;
const cli = (...args) => spawnClean([path.join(realDir, 'cli.mjs'), ...args], { env, cwd: realDir, timeout: 90000 });
// A pooled keep-alive connection to a relay that has since been restarted resets once; retry.
async function health() {
  for (let attempt = 0; ; attempt += 1) {
    try { return (await (await fetch(`http://127.0.0.1:${port}/health`)).json()).result; } catch (err) { if (attempt >= 3) throw err; await sleep(200); }
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function makeStale() {
  const future = new Date(Date.now() + 60_000);
  fs.utimesSync(path.join(tmp, 'report.mjs'), future, future);
  await sleep(2300); // the relay caches its mtime check for ~2s
  assert.deepEqual((await health()).relay.stale_source_files, ['report.mjs']);
}

before(async () => {
  for (const f of [...RELAY_SOURCE_FILES, 'dashboard.html']) fs.copyFileSync(path.join(realDir, f), path.join(tmp, f));
  port = await freePort();
  // This test exercises the REAL `ensureFreshRelayForNewSession` restart path (client.mjs), the
  // one call site that unconditionally sets WEBSCOUT_AUTO_CALIBRATE=1 on the relay it spawns - so
  // this env must isolate calibration itself, the same as the db/pid/trace paths already are:
  // WEBSCOUT_TOKEN_CALIBRATION keeps any write inside `tmp`, WEBSCOUT_TRANSCRIPT_HOME points
  // discoverTranscripts at an empty dir so it finds nothing and returns immediately instead of
  // scanning this machine's real Claude Code history.
  env = { WEBSCOUT_PORT: String(port), WEBSCOUT_DB_PATH: path.join(tmp, 'test.db'), WEBSCOUT_PID_PATH: pidPath, WEBSCOUT_NO_AUTOOPEN: '1', WEBSCOUT_TOKEN_CALIBRATION: path.join(tmp, 'token-calibration.json'), WEBSCOUT_TRANSCRIPT_HOME: tmp };
  const started = await startRelay({ port, script: path.join(tmp, 'relay.mjs'), logPath: path.join(tmp, 'relay.log'), env });
  assert.equal(started.started, true, JSON.stringify(started));
});

after(async () => {
  await stopRelay({ port }).catch(() => {});
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* temp dir */ }
});

test('with a session active, a stale relay is only warned about, never restarted', async () => {
  // start the session with restarts off, so the relay stays as it is
  const first = cli('session', 'start', 'auto-restart.test.mjs mid-session', 'automated', '--no-briefing');
  assert.equal(first.status, 0, first.stderr);
  await makeStale();
  const pidBefore = (await health()).relay.pid;
  const second = cli('agents');
  assert.equal(second.status, 0);
  assert.match(second.stderr, /relay is running code older than what is on disk/);
  assert.equal((await health()).relay.pid, pidBefore, 'the relay was not restarted mid-session');
  cli('session', 'end');
});

test('WEBSCOUT_NO_AUTORESTART=1 leaves a stale relay alone at session start', async () => {
  const pidBefore = (await health()).relay.pid;
  const r = spawnClean([path.join(realDir, 'cli.mjs'), 'session', 'start', 'auto-restart.test.mjs opted out', 'automated', '--no-briefing'], { env: { ...env, WEBSCOUT_NO_AUTORESTART: '1' }, cwd: realDir, timeout: 90000 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal((await health()).relay.pid, pidBefore);
  assert.deepEqual((await health()).relay.stale_source_files, ['report.mjs']);
  cli('session', 'end');
});

test('session start restarts a relay running older code, keeps going, and records the event', async () => {
  const stale = (await health()).relay;
  assert.deepEqual(stale.stale_source_files, ['report.mjs']);
  const r = cli('session', 'start', 'auto-restart.test.mjs restart', 'automated', '--no-briefing');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /restarted it before this session/);
  const after = await health();
  assert.notEqual(after.relay.pid, stale.pid, 'a new relay process');
  assert.deepEqual(after.relay.stale_source_files, [], 'running the current code');
  assert.equal(after.active_session.goal, 'auto-restart.test.mjs restart', 'and the session was created on it');
  assert.ok(readRelayEvents(port).some((e) => e.kind === 'auto-restart' && e.files.includes('report.mjs')), 'recorded in the relay event log');
  assert.equal(after.relay.events_24h.autoRestarts, 1);
  cli('session', 'end');
});

test('an up-to-date relay is not restarted', async () => {
  const pidBefore = (await health()).relay.pid;
  const r = cli('session', 'start', 'auto-restart.test.mjs fresh', 'automated', '--no-briefing');
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /restarted it/);
  assert.equal((await health()).relay.pid, pidBefore);
  cli('session', 'end');
});

test('a relay too old to report stale files is itself treated as stale', async () => {
  const { staleFilesFromHealth } = await import('./client.mjs');
  assert.deepEqual(staleFilesFromHealth({ status: 'ok', agents_connected: [] }), ['(this relay predates stale-code reporting)']);
  assert.deepEqual(staleFilesFromHealth({ relay: { stale_source_files: ['db.mjs'] } }), ['db.mjs']);
  assert.deepEqual(staleFilesFromHealth({ relay: { stale_source_files: [] } }), []);
  assert.deepEqual(staleFilesFromHealth(null), []);
});
