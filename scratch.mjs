// Scratch dirs (headless-browser profiles, test fixtures) with a guaranteed lifecycle.
//
// Before this, browser-harness.mjs mkdtemp'd a profile under %TEMP% and relied on one
// `child.kill()` + a best-effort rmSync: a crash, Ctrl+C or a browser that outlived its
// parent left ~460 MB profiles and orphan msedge.exe trees behind. Now:
//   - every scratch dir carries an owner marker (pid + start time),
//   - the process tree is killed BEFORE the dir is deleted (Edge locks the profile),
//   - exit / SIGINT / SIGTERM / SIGBREAK run the same cleanup,
//   - sweepStale() reclaims dirs whose owner died without cleaning up (SIGKILL, power loss),
//     and kills orphan browsers whose --user-data-dir is one of those dirs.
// The sweep only ever touches directories whose name starts with one of PREFIXES, never
// follows symlinks/junctions, and only kills a browser whose command line names a dir it
// is about to delete.
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Where scratch dirs live. WEBSCOUT_TMPDIR (set by run-tests.mjs) isolates a whole run under
// one private root so a single delete reclaims everything.
export const scratchRoot = () => process.env.WEBSCOUT_TMPDIR || os.tmpdir();
export const MARKER = '.webscout-owner.json';
export const PREFIXES = [
  'webscout-browser-profile-',
  'webscout-crv-tab-profile-',
  'webscout-net-console-known-issues-',
];
// Not created by this repo (no hits in it); swept only on request.
export const FOREIGN_PREFIXES = ['wl-browser-', 'wl-story-', 'wl-anchor-'];
export const STALE_UNOWNED_MS = 24 * 60 * 60 * 1000;
const BROWSER_NAMES = ['msedge.exe', 'chrome.exe', 'msedge', 'chrome', 'google-chrome', 'chromium', 'microsoft-edge'];

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const warn = (msg) => { try { process.stderr.write(`webscout scratch: ${msg}\n`); } catch { /* stderr closed */ } };

export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

// Wall-clock start of a live pid (ms epoch), or null when it cannot be read. Only used to
// catch PID reuse for markers old enough that reuse is plausible.
function pidStartTime(pid) {
  try {
    if (process.platform === 'win32') {
      const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${Number(pid)} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
      const t = Date.parse(r.stdout.trim());
      return Number.isFinite(t) ? t : null;
    }
    const r = spawnSync('ps', ['-o', 'etimes=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000 });
    const s = Number(r.stdout.trim());
    return Number.isFinite(s) ? Date.now() - s * 1000 : null;
  } catch { return null; }
}

// Kills `pid` and all descendants. Windows: taskkill /T /F. POSIX: the process group when
// the child was spawned detached, else the pid alone.
export function killTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true, timeout: 15000 });
    else { try { process.kill(-pid, 'SIGKILL'); } catch { process.kill(pid, 'SIGKILL'); } }
  } catch { /* already gone */ }
}

function isRealDir(p) {
  try { const s = fs.lstatSync(p); return s.isDirectory() && !s.isSymbolicLink(); } catch { return false; }
}

// Delete with backoff (Windows holds locks briefly after a browser dies). Never throws:
// a leftover dir is logged and left for the next sweep. Refuses symlinks/junctions.
export function removeDirSync(dir, { attempts = 12, quiet = false } = {}) {
  if (!isRealDir(dir)) return !fs.existsSync(dir) && !isSymlink(dir);
  let delay = 100;
  for (let i = 0; i < attempts; i += 1) {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 }); } catch { /* retry below */ }
    if (!fs.existsSync(dir)) return true;
    sleepSync(delay);
    delay = Math.min(delay * 1.6, 800);
  }
  if (!quiet) warn(`could not fully remove ${dir} (files still locked); the next sweep will retry`);
  return false;
}
function isSymlink(p) { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } }

function writeMarker(dir, pid) {
  fs.writeFileSync(path.join(dir, MARKER), JSON.stringify({ pid, createdAt: Date.now(), creator: process.pid }));
}
function readMarker(dir) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, MARKER), 'utf8'));
    return Number.isInteger(m.pid) && Number.isFinite(m.createdAt) ? m : null;
  } catch { return null; }
}

// --- live registry + exit hooks -------------------------------------------------------
const GUARD = fileURLToPath(new URL('./scratch-guard.mjs', import.meta.url));
// WEBSCOUT_SCRATCH_LOG=1 appends {dir, bytes, files} at dispose to <root>/webscout-scratch-log.jsonl:
// how big a profile got, to decide whether slimmer flags / a seeded template are worth it.
function logFootprint(dir) {
  if (process.env.WEBSCOUT_SCRATCH_LOG !== '1' || !fs.existsSync(dir)) return;
  try { fs.appendFileSync(path.join(scratchRoot(), 'webscout-scratch-log.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), dir: path.basename(dir), bytes: dirSize(dir) })}
`); } catch { /* logging only */ }
}
const live = new Map(); // dir -> { pids:Set<number> }
let hooked = false;

export function cleanupAllSync() {
  for (const [dir, entry] of [...live]) {
    for (const pid of entry.pids) killTree(pid); // children first: the browser locks the profile
    removeDirSync(dir);
    live.delete(dir);
  }
}

function installHooks() {
  if (hooked) return;
  hooked = true;
  process.on('exit', () => { try { cleanupAllSync(); } catch { /* never throw from exit */ } });
  for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGBREAK', 149]]) {
    try {
      process.on(sig, () => { try { cleanupAllSync(); } catch { /* best effort */ } process.exit(code); });
    } catch { /* signal not supported on this platform */ }
  }
}

// Creates `<tmp>/<prefix><random>` with an owner marker (owner defaults to this process).
// `dir` pins an exact path instead (used for the per-port CRV tab profile).
export function createScratchDir(prefix, { dir, ownerPid = process.pid, baseDir = scratchRoot(), marker = true } = {}) {
  let target = dir;
  if (target) fs.mkdirSync(target, { recursive: true });
  else target = fs.mkdtempSync(path.join(baseDir, prefix));
  if (marker) writeMarker(target, ownerPid);
  return target;
}

// Re-points the marker at another owner - for a browser meant to outlive this process (crv launch).
export function setOwner(dir, pid) { writeMarker(dir, pid); }

// Registers a dir (and optional child pids) for cleanup on exit/signals. Returns
// { dir, track(pid), dispose() }. dispose() is idempotent: tree-kill, then delete.
export function ownScratchDir(dir) {
  installHooks();
  const entry = { pids: new Set() };
  live.set(dir, entry);
  return {
    dir,
    track(pid) { if (pid) entry.pids.add(pid); },
    // Detached watchdog: kills `pid`'s tree and removes the dir if this process dies uncleanly.
    guard(pid) { try { spawn(process.execPath, [GUARD, String(process.pid), String(pid), dir], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); } catch { /* sweep is the backstop */ } }, // marker owner stays this process: if we die, the sweep kills the browser
    dispose() {
      for (const pid of entry.pids) killTree(pid);
      if (entry.pids.size) sleepSync(150);
      logFootprint(dir);
      removeDirSync(dir);
      live.delete(dir);
    },
  };
}

// try/finally wrapper: fn(dir, handle) - dir is removed on return, throw, or timeout.
export async function withScratchDir(prefix, fn, opts = {}) {
  const handle = ownScratchDir(createScratchDir(prefix, opts));
  try { return await fn(handle.dir, handle); } finally { handle.dispose(); }
}

// --- sweep ----------------------------------------------------------------------------
function dirSize(dir) {
  let bytes = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let names = [];
    try { names = fs.readdirSync(d); } catch { continue; }
    for (const n of names) {
      const p = path.join(d, n);
      try {
        const s = fs.lstatSync(p);
        if (s.isSymbolicLink()) continue;
        if (s.isDirectory()) stack.push(p); else bytes += s.size;
      } catch { /* vanished */ }
    }
  }
  return bytes;
}

const norm = (p) => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();

// Root browser processes (and their command lines) as [{pid, commandLine}].
export function listBrowserProcesses(names = BROWSER_NAMES) {
  try {
    if (process.platform === 'win32') {
      const filter = names.filter((n) => n.endsWith('.exe')).map((n) => `Name='${n}'`).join(' OR ');
      const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance Win32_Process -Filter "${filter}" | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress`], { encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 64 * 1024 * 1024 });
      const raw = r.stdout.trim();
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return (Array.isArray(parsed) ? parsed : [parsed]).filter((x) => x.CommandLine).map((x) => ({ pid: x.ProcessId, ppid: x.ParentProcessId, commandLine: x.CommandLine }));
    }
    const r = spawnSync('ps', ['-eo', 'pid=,ppid=,args='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return r.stdout.split('\n').map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l)).filter(Boolean).map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), commandLine: m[3] }));
  } catch { return []; }
}

// A dir is stale when its marker's owner is dead (or the pid was reused), or - with no
// marker - when it is older than STALE_UNOWNED_MS.
export function isStale(dir, { now = Date.now(), staleUnownedMs = STALE_UNOWNED_MS } = {}) {
  const marker = readMarker(dir);
  if (!marker) {
    try { return now - fs.lstatSync(dir).mtimeMs > staleUnownedMs; } catch { return false; }
  }
  if (!isPidAlive(marker.pid)) return true;
  if (now - marker.createdAt > staleUnownedMs) {
    const started = pidStartTime(marker.pid);
    if (started !== null && started > marker.createdAt + 5000) return true; // pid reused by someone else
  }
  return false;
}

// Reclaims stale scratch dirs under `baseDir`. dryRun lists without touching anything.
// Options: prefixes, includeForeign (wl-*), browserNames (tests inject 'node.exe').
export function sweepStale({ dryRun = false, markerOnly = false, baseDir = scratchRoot(), prefixes = PREFIXES, includeForeign = false, browserNames = BROWSER_NAMES, now = Date.now(), staleUnownedMs = STALE_UNOWNED_MS } = {}) {
  const active = includeForeign ? [...prefixes, ...FOREIGN_PREFIXES] : prefixes;
  const result = { dryRun, scanned: 0, removed: [], skippedLive: 0, failed: [], killedProcesses: [], freedBytes: 0 };
  let names = [];
  try { names = fs.readdirSync(baseDir); } catch { return result; }
  const stale = [];
  const unmarked = []; // legacy dirs (pre-marker) not yet old enough to age out
  for (const name of names) {
    if (!active.some((p) => name.startsWith(p))) continue;
    const full = path.join(baseDir, name);
    if (!isRealDir(full)) continue; // files, symlinks, junctions: never touched
    if (markerOnly && !readMarker(full)) continue; // implicit sweeps only reclaim dirs that prove they are ours
    result.scanned += 1;
    if (isStale(full, { now, staleUnownedMs })) stale.push(full);
    else if (!readMarker(full)) unmarked.push(full);
    else result.skippedLive += 1;
  }
  let procs = null;
  if (unmarked.length) {
    // A legacy dir whose browser ROOT process has a dead parent is an orphan, whatever its age.
    procs = listBrowserProcesses(browserNames);
    const named = (c) => { const m = /--user-data-dir=(?:"([^"]+)"|(\S+))/.exec(c); return m ? norm(m[1] ?? m[2]) : null; };
    const orphaned = new Set(procs.filter((v) => !/--type=/.test(v.commandLine) && /--headless/.test(v.commandLine) && !isPidAlive(v.ppid)).map((v) => named(v.commandLine)).filter(Boolean));
    for (const d of unmarked) { if (orphaned.has(norm(d))) stale.push(d); else result.skippedLive += 1; }
  }
  if (!stale.length) return result;
  const staleSet = new Set(stale.map(norm));
  // Orphan browsers: only those whose command line names one of the stale dirs exactly.
  const victims = (procs ?? listBrowserProcesses(browserNames)).filter(({ commandLine }) => {
    const m = /--user-data-dir=(?:"([^"]+)"|(\S+))/.exec(commandLine);
    return m && staleSet.has(norm(m[1] ?? m[2]));
  });
  for (const v of victims) {
    result.killedProcesses.push(v.pid);
    if (!dryRun) killTree(v.pid);
  }
  if (victims.length && !dryRun) sleepSync(300);
  for (const dir of stale) {
    const bytes = dirSize(dir);
    if (dryRun) { result.removed.push({ dir, bytes }); result.freedBytes += bytes; continue; }
    if (removeDirSync(dir, { quiet: true })) { result.removed.push({ dir, bytes }); result.freedBytes += bytes; }
    else result.failed.push(dir);
  }
  return result;
}

export function formatSweep(r) {
  const mb = (r.freedBytes / 1048576).toFixed(1);
  const verb = r.dryRun ? 'would remove' : 'removed';
  return `${verb} ${r.removed.length} dir(s), ${mb} MB; ${r.killedProcesses.length} orphan browser process(es) ${r.dryRun ? 'would be killed' : 'killed'}; ${r.skippedLive} dir(s) kept (owner alive / too new); ${r.failed.length} failed (locked)`;
}

// Cheap health check for warnings: counts our dirs and how many are reclaimable. sizes:true
// also walks them (slow with thousands of dirs - `scratch status` only).
export function scratchStats({ baseDir = scratchRoot(), includeForeign = false, sizes = false, now = Date.now() } = {}) {
  const active = includeForeign ? [...PREFIXES, ...FOREIGN_PREFIXES] : PREFIXES;
  const out = { dirs: 0, stale: 0, staleBytes: sizes ? 0 : undefined };
  let names = [];
  try { names = fs.readdirSync(baseDir); } catch { return out; }
  for (const name of names) {
    if (!active.some((p) => name.startsWith(p))) continue;
    const full = path.join(baseDir, name);
    if (!isRealDir(full)) continue;
    out.dirs += 1;
    if (isStale(full, { now })) { out.stale += 1; if (sizes) out.staleBytes += dirSize(full); }
  }
  return out;
}

// One-liner for tests and tools: a marked scratch dir under scratchRoot() that is removed on
// process exit / signals even if the caller never cleans up. Returns the path.
// No marker: fixtures are scanned by code under test, which must not see extra files.
export function tmpDir(prefix) { return ownScratchDir(createScratchDir(prefix, { marker: false })).dir; }
