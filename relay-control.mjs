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
export const RELAY_SOURCE_FILES = ['relay.mjs', 'db.mjs', 'ai.mjs', 'report.mjs', 'command-registry.mjs', 'build-id.mjs', 'relay-control.mjs', 'read-pipeline.mjs', 'read-shape.mjs', 'token-estimate.mjs', 'crv-verify.mjs', 'session-viz.mjs', 'intent-import.mjs', 'trace.mjs', 'transcript-tokens.mjs'];

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

export function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

// A small append-only log of relay lifecycle events, next to the pidfile. It
// exists because the client's autostart recovers from a kill so quietly that a
// process blanket-killing `relay.mjs` (another session did, twice) went unnoticed.
//   autostart    - a CLI/MCP call found the relay down and started one
//   auto-restart - `session start` found the relay running older code than disk and restarted it
//   unclean-exit - a relay booted and found the previous one's pidfile still there
//                  with a dead pid: it never ran its clean shutdown, i.e. it was
//                  killed (`relay stop` removes the pidfile, so it never counts)
const EVENT_LOG_MAX_LINES = 200;
const NL = String.fromCharCode(10);
export const eventsPath = (port) => `${pidfilePath(port)}.events.jsonl`;

export function recordRelayEvent(port, event) {
  try {
    const file = eventsPath(port);
    let lines = [];
    try { lines = fs.readFileSync(file, 'utf8').split(NL).filter(Boolean); } catch { /* first event */ }
    lines.push(JSON.stringify({ at: new Date().toISOString(), ...event }));
    fs.writeFileSync(file, lines.slice(-EVENT_LOG_MAX_LINES).join(NL) + NL, 'utf8');
  } catch { /* best effort - never blocks a start */ }
}

export function readRelayEvents(port, sinceMs = 24 * 3600 * 1000) {
  let raw = '';
  try { raw = fs.readFileSync(eventsPath(port), 'utf8'); } catch { return []; }
  const cutoff = Date.now() - sinceMs;
  const out = [];
  for (const line of raw.split(NL)) {
    try { const e = JSON.parse(line); if (Date.parse(e.at) >= cutoff) out.push(e); } catch { /* skip a torn line */ }
  }
  return out;
}

export function summarizeRelayEvents(events) {
  return {
    autostarts: events.filter((e) => e.kind === 'autostart').length,
    autoRestarts: events.filter((e) => e.kind === 'auto-restart').length,
    uncleanExits: events.filter((e) => e.kind === 'unclean-exit').length,
    recent: events.slice(-5),
  };
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

// ---------- leaked-relay registry + reaper ----------
//
// Any relay process - the real one, or an ephemeral one the test harness spawned - registers
// itself here on startup and removes itself on a clean shutdown. A hard kill (Ctrl-C twice, a
// crashed CI runner, a `node relay.mjs` someone forgot about) skips the clean-shutdown path
// entirely, orphaning the process (and, for a test relay, its temp dir too). Confirmed real
// twice: 15 orphaned test relays/48 temp dirs in one session, then another 10 orphaned relays/
// ~200 temp dirs predating this mechanism in a later one - and a real relay accidentally started
// by `node -e "import('./relay.mjs')"` (a plain syntax-check attempt that actually ran the whole
// module) went unnoticed because nothing was tracking relays outside the test harness at all.
//
// reapLeakedRelays runs automatically once per process: the test harness runs it from the first
// startTestRelay() call in a run (test-relay.mjs), and a real relay runs it once from its own
// startup (relay.mjs's isMainModule block) - so a stray relay on some other port gets found and
// cleaned up the next time ANYONE starts a relay, not only the next `node --test` run. It NEVER
// touches port 8973 (the real, expected-to-be-always-on relay) even if a stale entry somehow
// named it, and only reaps an entry older than REAP_AGE_MS - a relay genuinely still starting up
// must never be mistaken for a leak.
// A function, not a frozen constant, so WEBSCOUT_RELAY_REGISTRY (read fresh on every call, same
// convention as pidfilePath() above) lets a test isolate the registry entirely - relay.mjs's own
// registerRelay/reapLeakedRelays calls take no explicit registryPath, so this is the only way a
// test spawning a REAL relay.mjs process can verify self-registration without ever touching the
// real, shared default (every OTHER relay, test or real, that might be starting up concurrently).
function defaultRegistryPath() { return process.env.WEBSCOUT_RELAY_REGISTRY || path.join(os.tmpdir(), 'webscout-relays.jsonl'); }
const REAP_AGE_MS = 30 * 60 * 1000; // longer than any real test run, or a relay's own startup, should ever take
export const REAL_RELAY_PORT = 8973;

function readRegistry(registryPath) {
  try {
    return fs.readFileSync(registryPath, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch {
    return [];
  }
}

function writeRegistry(entries, registryPath) {
  try { fs.writeFileSync(registryPath, entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : '')); } catch { /* best-effort ledger */ }
}

// `dir` is the relay's own throwaway temp dir (test relays only) - null for the real relay, which
// has nothing of its own to remove on reap, only itself to never touch (see REAL_RELAY_PORT above).
export function registerRelay(entry, registryPath = defaultRegistryPath()) {
  try { fs.appendFileSync(registryPath, `${JSON.stringify(entry)}\n`); } catch { /* best-effort ledger */ }
}

export function unregisterRelay(pid, dir, registryPath = defaultRegistryPath()) {
  writeRegistry(readRegistry(registryPath).filter((e) => !(e.pid === pid && e.dir === dir)), registryPath);
}

function pidAliveLocal(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// Exported so a developer can run it on demand (`node tools/web-scout/reap-test-relays.mjs`)
// without waiting for the next automatic pass, and so test-relay-reaper.test.mjs can drive it
// against an ISOLATED registryPath - the real, default one is shared with every OTHER relay
// (test or real) that might be starting up concurrently in the same run, and a test exercising an
// aggressive ageMs must never risk treating one of those as a leak.
export function reapLeakedRelays({ ageMs = REAP_AGE_MS, verbose = false, registryPath = defaultRegistryPath() } = {}) {
  const entries = readRegistry(registryPath);
  const kept = [];
  let killedRelays = 0;
  let removedDirs = 0;
  for (const e of entries) {
    const age = Date.now() - Date.parse(e.startedAt ?? 0);
    const stale = Number.isFinite(age) && age > ageMs;
    if (e.port === REAL_RELAY_PORT || !stale || !pidAliveLocal(e.pid)) {
      if (stale && !pidAliveLocal(e.pid) && e.dir) { try { fs.rmSync(e.dir, { recursive: true, force: true }); removedDirs += 1; } catch { /* already gone, or in use */ } }
      if (!stale || e.port === REAL_RELAY_PORT) kept.push(e);
      continue;
    }
    try { process.kill(e.pid); killedRelays += 1; if (verbose) console.error(`reapLeakedRelays: killed orphaned relay pid ${e.pid} on port ${e.port} (${Math.round(age / 60000)}min old)`); } catch { /* already gone */ }
    if (e.dir) { try { fs.rmSync(e.dir, { recursive: true, force: true }); removedDirs += 1; } catch { /* Windows may still hold it briefly - next reap gets it */ } }
  }
  writeRegistry(kept, registryPath);
  return { killedRelays, removedDirs, remaining: kept.length };
}
