// Start/stop/restart the relay process without hunting for its PID by hand.
// Two real failures motivated this: a relay left running on OLD code after
// editing relay.mjs/db.mjs (so a green test run validated stale behavior),
// and `pkill` silently doing nothing against a Windows-native node process,
// which forced a netstat + taskkill dance every time.
//
// The relay writes a pidfile on listen (see writePidfile below, called from
// relay.mjs) and removes it on a clean exit. A relay started BEFORE this file
// existed has no pidfile, so stopRelay falls back to asking the OS which
// process is LISTENING on the port.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Files the relay process loads once at boot. An edit to any of them is
// invisible to a running relay until it restarts.
export const RELAY_SOURCE_FILES = ['relay.mjs', 'db.mjs', 'ai.mjs', 'report.mjs', 'command-registry.mjs'];

export function pidfilePath(port) {
  return process.env.WEBSCOUT_PID_PATH || path.join(os.tmpdir(), `webscout-relay-${port}.pid`);
}

export function writePidfile(port, info = {}) {
  try {
    fs.writeFileSync(pidfilePath(port), JSON.stringify({ pid: process.pid, port, startedAt: new Date().toISOString(), ...info }), 'utf8');
  } catch { /* best-effort - a missing pidfile only costs the OS-lookup fallback */ }
}

export function removePidfile(port) {
  try {
    const p = pidfilePath(port);
    const cur = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (cur.pid === process.pid) fs.unlinkSync(p); // never delete a successor relay's pidfile
  } catch { /* already gone */ }
}

export function readPidfile(port) {
  try { return JSON.parse(fs.readFileSync(pidfilePath(port), 'utf8')); } catch { return null; }
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

// OS-level "who is listening on this port" - the fallback for a relay with no
// pidfile (started before this file existed, or its pidfile was cleaned up).
export function findListeningPid(port) {
  if (process.platform === 'win32') {
    const out = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8' }).stdout || '';
    for (const line of out.split(/\r?\n/)) {
      const cols = line.trim().split(/\s+/);
      if (cols[0] === 'TCP' && cols[3] === 'LISTENING' && cols[1].endsWith(`:${port}`)) return Number(cols[4]);
    }
    return null;
  }
  const out = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' }).stdout || '';
  const pid = Number(out.split(/\s+/).find(Boolean));
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

export function resolveRelayPid(port) {
  const fromFile = readPidfile(port);
  if (fromFile && Number(fromFile.port) === Number(port) && pidAlive(fromFile.pid)) return { pid: fromFile.pid, via: 'pidfile', startedAt: fromFile.startedAt };
  const fromOs = findListeningPid(port);
  return fromOs ? { pid: fromOs, via: 'port-lookup' } : null;
}

async function healthOk(base) {
  try {
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch { return false; }
}

async function waitFor(predicate, timeoutMs, stepMs = 150) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return predicate();
}

export async function stopRelay({ port, host = '127.0.0.1' }) {
  const base = `http://${host}:${port}`;
  const found = resolveRelayPid(port);
  if (!found) return { stopped: false, reason: `nothing is listening on port ${port}` };
  // A port-lookup PID is whatever owns the port - never kill it if it answers
  // /health as something that is not a web-scout relay.
  if (found.via === 'port-lookup') {
    try {
      const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1500) });
      const body = await res.json().catch(() => null);
      if (!body || body.status !== 'ok' || !('agents_connected' in body)) {
        return { stopped: false, pid: found.pid, reason: `pid ${found.pid} owns port ${port} but does not answer /health like a web-scout relay - refusing to kill it` };
      }
    } catch { /* not answering at all - a wedged relay is exactly when stop is needed */ }
  }
  try {
    process.kill(found.pid); // SIGTERM on POSIX; TerminateProcess on Windows
  } catch (err) {
    return { stopped: false, pid: found.pid, reason: `could not signal pid ${found.pid}: ${err.message}` };
  }
  const gone = await waitFor(async () => !(await healthOk(base)), 5000);
  if (!gone) return { stopped: false, pid: found.pid, reason: 'signalled the process but the relay still answers /health after 5s' };
  try { fs.unlinkSync(pidfilePath(port)); } catch { /* fine */ }
  return { stopped: true, pid: found.pid, via: found.via };
}

// Detached so the relay outlives the CLI process that started it; output goes
// to a log file (a piped-but-unread stdio would eventually block the relay).
export async function startRelay({ port, host = '127.0.0.1', env = {}, logPath, script = path.join(__dirname, 'relay.mjs') }) {
  const base = `http://${host}:${port}`;
  if (await healthOk(base)) return { started: false, reason: `a relay is already answering on ${base}`, pid: resolveRelayPid(port)?.pid };
  const log = logPath || path.join(os.tmpdir(), `webscout-relay-${port}.log`);
  const fd = fs.openSync(log, 'a');
  const child = spawn(process.execPath, [script], {
    cwd: path.dirname(script),
    env: { ...process.env, WEBSCOUT_PORT: String(port), ...env },
    detached: true,
    stdio: ['ignore', fd, fd],
    windowsHide: true,
  });
  child.unref();
  const up = await waitFor(() => healthOk(base), 15000);
  if (!up) return { started: false, pid: child.pid, reason: `spawned pid ${child.pid} but ${base}/health never answered - see ${log}` };
  return { started: true, pid: child.pid, log };
}

export async function restartRelay(opts) {
  const stopped = await stopRelay(opts);
  // "nothing is listening" is fine for a restart - it just becomes a start.
  if (!stopped.stopped && !/nothing is listening/.test(stopped.reason || '')) return { restarted: false, stop: stopped };
  const started = await startRelay(opts);
  return { restarted: !!started.started, stop: stopped, start: started };
}
