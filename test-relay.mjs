// Test harness: an EPHEMERAL relay on a free port with a throwaway database,
// so a green test run always validates the code on disk. The old tests hit
// whatever relay was already running on 8973 - one that could be executing
// stale code from before an edit, or that a developer had a real session
// open on.
//
// WEBSCOUT_TEST_LIVE=1 opts back into the already-running relay (needed only
// for tests that require a connected browser tab, which an ephemeral relay
// never has - those tests skip themselves when no agent is connected).

import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentInjectBuild } from './build-id.mjs';
import { REAL_RELAY_PORT, registerRelay, unregisterRelay, reapLeakedRelays } from './relay-control.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The registry + reaper themselves now live in relay-control.mjs (relay.mjs registers itself
// there too on real startup, not just test relays - see its own comment on why). Re-exported here
// so existing callers (reap-test-relays.mjs, test-relay-reaper.test.mjs) keep importing them from
// this file without a change.
export { REAL_RELAY_PORT, reapLeakedRelays };
let reaped = false;

export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitForHealth(base, child, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`test relay exited early with code ${child.exitCode}`);
    try {
      const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`test relay at ${base} never answered /health`);
}

// Returns { port, env, stop, live }. `env` is what a spawned CLI / MCP child
// needs so it talks to THIS relay: pass it as `env: { ...process.env, ...relay.env }`.
// `env` (the option, not the return field) overrides/extends the defaults below - used by tests
// that need a real relay startup path exercised on purpose (auto-calibrate.test.mjs points
// WEBSCOUT_TRANSCRIPT_HOME at a fixture dir and turns WEBSCOUT_NO_AUTO_CALIBRATE back off).
export async function startTestRelay({ script = path.join(__dirname, 'relay.mjs'), env: envOverride = {} } = {}) {
  if (process.env.WEBSCOUT_TEST_LIVE === '1') {
    const port = Number(process.env.WEBSCOUT_PORT || 8973);
    return { port, env: { WEBSCOUT_PORT: String(port) }, stop: async () => {}, live: true };
  }
  if (!reaped) { reaped = true; reapLeakedRelays(); }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webscout-test-'));
  const port = await freePort();
  const env = {
    WEBSCOUT_PORT: String(port),
    WEBSCOUT_DB_PATH: path.join(dir, 'test.db'),
    WEBSCOUT_PID_PATH: path.join(dir, 'relay.pid'),
    WEBSCOUT_NO_AUTOOPEN: '1',
    // "session end --trace" (relay.mjs's POST /sessions/:id/trace) defaults to writing under the
    // relay script's OWN directory (tools/web-scout/traces/auto/) - redirected into this test's
    // own throwaway dir so a test run never leaves real files behind in the real project tree.
    WEBSCOUT_TRACE_DIR: path.join(dir, 'traces'),
    // Same isolation for calibration: a test relay must never read the real project's
    // token-calibration.json. WEBSCOUT_AUTO_CALIBRATE is opt-in (relay.mjs's own default is OFF,
    // precisely so a relay a test file spawns never does this on its own) - forced empty here
    // anyway, defense in depth against whatever this test process's OWN env happens to carry.
    WEBSCOUT_TOKEN_CALIBRATION: path.join(dir, 'token-calibration.json'),
    WEBSCOUT_AUTO_CALIBRATE: '',
    ...envOverride,
  };
  const child = spawn(process.execPath, [script], { cwd: path.dirname(script), env: { ...process.env, ...env }, stdio: 'ignore', windowsHide: true });
  const killNow = () => { try { child.kill(); } catch { /* already gone */ } };
  process.on('exit', killNow);
  try {
    await waitForHealth(`http://127.0.0.1:${port}`, child);
  } catch (err) {
    killNow();
    throw err;
  }
  // Registered only once the relay is actually up (a real pid, a real port) - see relay-control.mjs's
  // registry comment. A clean stop() removes this entry; a hard kill leaves it for the next run's
  // automatic reapLeakedRelays() (or a hand-run one) to find and clean up.
  registerRelay({ pid: child.pid, port, dir, startedAt: new Date().toISOString() });
  async function stop() {
    process.off('exit', killNow);
    if (child.exitCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      killNow();
      await exited;
    }
    unregisterRelay(child.pid, dir);
    // sqlite holds the file open until the process is gone (Windows refuses to delete it earlier)
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* temp dir - leftover is harmless */ }
  }
  return { port, env, stop, live: false };
}

// Is anything accepting connections on this port? A raw socket, not fetch: a
// fetch left pending (its abort timer armed) when --test-force-exit fires trips a
// libuv assertion on Windows.
export function isUp(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = net.connect(port, host);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}

// Run node as a child from inside a test. NODE_TEST_CONTEXT would make a nested
// `node --test` behave as a child of this runner and always exit 0, so it is
// stripped; `env` is merged over the cleaned environment.
//
// spawnSync (this one) BLOCKS the calling process's entire event loop until the child exits -
// fine for a CLI command whose relay round trip needs nothing else from THIS process, but a real
// deadlock for one that does: a command the relay forwards to a connectFakeAgent() tab IN THIS
// SAME PROCESS can never get its reply, because the WebSocket's own onmessage callback can only
// run on an event loop this call has frozen. Confirmed live: "session start/end --no-briefing"
// (no page round trip) is fine here; "crv run" (dispatches to the page) hangs until spawnSync's
// own timeout. Use spawnAsync below for a CLI command that needs a same-process fake agent to
// answer anything.
export function spawnClean(args, { env = {}, cwd, timeout = 60000 } = {}) {
  const { NODE_TEST_CONTEXT, ...clean } = process.env;
  return spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout, env: { ...clean, ...env } });
}

// The non-blocking twin of spawnClean, for a CLI command that needs a same-process
// connectFakeAgent() tab to answer a page round trip (see the comment above) - this process's
// event loop keeps running while the child is up, so the fake agent's onmessage still fires.
export function spawnAsync(args, { env = {}, cwd, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const { NODE_TEST_CONTEXT, ...clean } = process.env;
    const child = spawn(process.execPath, args, { cwd, env: { ...clean, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`spawnAsync: ${args.join(' ')} did not exit within ${timeoutMs}ms - stdout so far: ${stdout.slice(0, 500)}`)); }, timeoutMs);
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('exit', (status, signal) => { clearTimeout(timer); resolve({ status, signal, stdout, stderr }); });
  });
}

// A stand-in for the in-page agent (inject.js): speaks the relay's real
// WebSocket protocol - the relay sends {kind:'command', id, type, params} and
// expects {kind:'reply', id, ok, result|error} - so relay behavior that needs
// a connected tab (dispatch, read-result cache, cleanup tracking, token
// headers) is testable without a browser. `handlers` maps a command type to
// (params) => result; an unhandled type replies {}. Opt in to the page-change
// counter with `epoch: 0`: replies then carry `epoch: state.epoch`, `page.epoch`
// answers it, and a test bumps `state.epoch` to simulate the page changing on
// its own. `state.avoided = n` stamps n avoided bytes on the next reply only (`state.outlineOld` likewise stamps the size of the reply an outline replaced).
export async function connectFakeAgent(port, handlers = {}, { name = 'default', epoch, build = currentInjectBuild() } = {}) {
  const state = { epoch, avoided: undefined, outlineOld: undefined };
  const ws = new WebSocket(`ws://127.0.0.1:${port}/agent?name=${encodeURIComponent(name)}&loadId=fake-agent${build ? `&build=${build}` : ''}`);
  const seen = [];
  ws.onmessage = async (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.kind !== 'command') return;
    seen.push(msg);
    try {
      const handler = handlers[msg.type] ?? (msg.type === 'page.epoch' && state.epoch !== undefined ? () => ({ epoch: state.epoch }) : undefined);
      const epochBefore = state.epoch;
      const result = handler ? await handler(msg.params ?? {}, msg) : {};
      const avoided = state.avoided;
      const outlineOld = state.outlineOld;
      state.avoided = undefined;
      state.outlineOld = undefined;
      ws.send(JSON.stringify({ kind: 'reply', id: msg.id, ok: true, result, ...(epochBefore !== undefined ? { epoch: epochBefore } : {}), ...(avoided ? { avoided } : {}), ...(outlineOld !== undefined ? { outlineOld } : {}) }));
    } catch (err) {
      ws.send(JSON.stringify({ kind: 'reply', id: msg.id, ok: false, error: err.message }));
    }
  };
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('fake agent could not connect')); });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i += 1) { // wait until the relay has registered the socket
    const h = await (await fetch(`${base}/health`)).json();
    if (h.result?.agents_connected?.includes(name)) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  return { seen, state, close: () => ws.close() };
}
