// A relay killed from outside leaves its pidfile behind; the next relay to boot
// records that as an unclean exit, so a blanket `relay.mjs` kill by another
// session shows up in `relay status` instead of being silently papered over by
// the client's autostart. `relay stop` is intentional and never counts.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort, isUp } from './test-relay.mjs';
import { stopRelay, recordRelayEvent, readRelayEvents, summarizeRelayEvents, eventsPath } from './relay-control.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'webscout-events-'));
const port = await freePort();
process.env.WEBSCOUT_PID_PATH = path.join(tmp, 'relay.pid'); // this process reads the same event log the relay writes
const env = { ...process.env, WEBSCOUT_PORT: String(port), WEBSCOUT_DB_PATH: path.join(tmp, 'test.db'), WEBSCOUT_NO_AUTOOPEN: '1', WEBSCOUT_TOKEN_CALIBRATION: path.join(tmp, 'token-calibration.json') };
delete env.NODE_TEST_CONTEXT;
const children = [];

const boot = async () => {
  const child = spawn(process.execPath, [path.join(__dirname, 'relay.mjs')], { cwd: __dirname, env, stdio: 'ignore', windowsHide: true });
  children.push(child);
  for (let i = 0; i < 150 && !(await isUp(port)); i += 1) await new Promise((r) => setTimeout(r, 100));
  return child;
};
const health = async () => (await (await fetch(`http://127.0.0.1:${port}/health`)).json()).result;
const exited = (child) => new Promise((resolve) => (child.exitCode !== null ? resolve() : child.once('exit', resolve)));

after(async () => {
  for (const c of children) { try { c.kill(); } catch { /* gone */ } }
  await Promise.all(children.map(exited));
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('the event log records, filters by age, and summarizes', () => {
  const other = path.join(tmp, 'other.pid');
  const saved = process.env.WEBSCOUT_PID_PATH;
  process.env.WEBSCOUT_PID_PATH = other;
  try {
    recordRelayEvent(1, { kind: 'autostart', pid: 1 });
    recordRelayEvent(1, { kind: 'unclean-exit', pid: 2 });
    fs.appendFileSync(eventsPath(1), `${JSON.stringify({ at: '2000-01-01T00:00:00.000Z', kind: 'unclean-exit' })}${String.fromCharCode(10)}not json${String.fromCharCode(10)}`);
    const recent = readRelayEvents(1);
    assert.deepEqual(summarizeRelayEvents(recent), { autostarts: 1, autoRestarts: 0, uncleanExits: 1, recent: recent });
    recordRelayEvent(1, { kind: 'auto-restart', files: ['report.mjs'] });
    assert.equal(summarizeRelayEvents(readRelayEvents(1)).autoRestarts, 1, 'a session-start restart is counted on its own');
    assert.equal(readRelayEvents(1, 100 * 365 * 24 * 3600 * 1000).length, 4, 'a wider window includes the old event and skips the torn line');
  } finally {
    process.env.WEBSCOUT_PID_PATH = saved;
  }
});

test('a relay killed without a clean shutdown is reported by the next relay to boot; a clean stop is not', async () => {
  const first = await boot();
  assert.deepEqual((await health()).relay.events_24h.uncleanExits, 0);
  first.kill('SIGKILL'); // no shutdown handler runs: the pidfile stays behind
  await exited(first);

  const second = await boot();
  const afterKill = (await health()).relay.events_24h;
  assert.equal(afterKill.uncleanExits, 1);
  assert.equal(afterKill.recent.at(-1).kind, 'unclean-exit');

  const stopped = await stopRelay({ port });
  assert.equal(stopped.stopped, true);
  await exited(second);
  await boot();
  assert.equal((await health()).relay.events_24h.uncleanExits, 1, 'an intentional stop removes the pidfile, so it adds nothing');
});
