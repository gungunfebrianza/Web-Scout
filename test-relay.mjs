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

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
export async function startTestRelay({ script = path.join(__dirname, 'relay.mjs') } = {}) {
  if (process.env.WEBSCOUT_TEST_LIVE === '1') {
    const port = Number(process.env.WEBSCOUT_PORT || 8973);
    return { port, env: { WEBSCOUT_PORT: String(port) }, stop: async () => {}, live: true };
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webscout-test-'));
  const port = await freePort();
  const env = {
    WEBSCOUT_PORT: String(port),
    WEBSCOUT_DB_PATH: path.join(dir, 'test.db'),
    WEBSCOUT_PID_PATH: path.join(dir, 'relay.pid'),
    WEBSCOUT_NO_AUTOOPEN: '1',
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
  async function stop() {
    process.off('exit', killNow);
    if (child.exitCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      killNow();
      await exited;
    }
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
export function spawnClean(args, { env = {}, cwd, timeout = 60000 } = {}) {
  const { NODE_TEST_CONTEXT, ...clean } = process.env;
  return spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout, env: { ...clean, ...env } });
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
