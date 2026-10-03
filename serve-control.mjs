// Start/stop a throwaway static-server.mjs process by port, without hunting for its PID by
// hand - the `crv serve`/`crv stop` half of the same "pkill silently does nothing on Windows"
// problem relay-control.mjs already solved for the relay itself. One pidfile per port (not one
// shared file) so multiple worktrees can be served on different ports at once without
// clobbering each other's tracking.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pidAlive } from './relay-control.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function servePidfilePath(port) {
  return path.join(os.tmpdir(), `webscout-serve-${port}.json`);
}

export function readServePidfile(port) {
  try { return JSON.parse(fs.readFileSync(servePidfilePath(port), 'utf8')); } catch { return null; }
}

function removeServePidfile(port) {
  try { fs.unlinkSync(servePidfilePath(port)); } catch { /* already gone */ }
}

async function waitForUp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (res.status < 500) return true; // any real HTTP reply (200 or a 404 for "/") means it's up
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

// Detached so the server outlives the CLI process that started it (same reasoning as
// startRelay in relay-control.mjs) - output goes to a log file, never a piped-but-unread
// stdio that would eventually block the child.
export async function startStaticServer({ dir, port }) {
  if (!fs.existsSync(dir)) return { started: false, reason: `no such directory: ${dir}` };
  const existing = readServePidfile(port);
  if (existing && pidAlive(existing.pid)) {
    return { started: false, reason: `port ${port} is already tracked as serving ${existing.dir} (pid ${existing.pid}) - "crv stop --port ${port}" first`, existing };
  }
  const log = path.join(os.tmpdir(), `webscout-serve-${port}.log`);
  const fd = fs.openSync(log, 'a');
  const child = spawn(process.execPath, [path.join(__dirname, 'static-server.mjs'), '--dir', dir, '--port', String(port)], {
    detached: true,
    stdio: ['ignore', fd, fd],
    windowsHide: true,
  });
  child.unref();
  const url = `http://127.0.0.1:${port}/`;
  const up = await waitForUp(url, 8000);
  if (!up) return { started: false, pid: child.pid, reason: `spawned pid ${child.pid} but ${url} never answered - see ${log}` };
  const info = { pid: child.pid, port, dir: path.resolve(dir), startedAt: new Date().toISOString(), log };
  fs.writeFileSync(servePidfilePath(port), JSON.stringify(info), 'utf8');
  return { started: true, ...info, url };
}

export async function stopStaticServer({ port }) {
  const info = readServePidfile(port);
  if (!info) return { stopped: false, reason: `nothing tracked as serving on port ${port} ("crv serve" tracks it; a server started some other way is not visible here)` };
  if (!pidAlive(info.pid)) { removeServePidfile(port); return { stopped: false, reason: `pid ${info.pid} (tracked for port ${port}) is already gone - cleared the stale tracking` }; }
  try {
    process.kill(info.pid); // SIGTERM on POSIX; TerminateProcess on Windows - same call relay-control.mjs's stopRelay uses, which is exactly what a manual netstat+taskkill was standing in for
  } catch (err) {
    return { stopped: false, pid: info.pid, reason: `could not signal pid ${info.pid}: ${err.message}` };
  }
  removeServePidfile(port);
  // A clean stop has nothing left worth reading in the log (a server that died on its own keeps it).
  if (info.log) { try { fs.unlinkSync(info.log); } catch { /* server may still hold it for a moment, or it is gone */ } }
  return { stopped: true, pid: info.pid, port, dir: info.dir };
}
