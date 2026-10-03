// Host-resource view for the dashboard: what web-scout has left in the temp dir, what browsers it
// has running, and how much disk is left - so a slow leak (a profile per run, an orphan browser)
// becomes visible long before the disk fills.
//
// Everything here is read-only except cleanupScratch()/killOrphans(), which only ever act on what
// scratch.mjs itself would (our prefixes, stale owner, browsers naming a profile dir of ours).
// The relay polls this, so the expensive parts (dir sizes, process listing) are async and cached;
// analytics/preflight only ever PEEK at the cache and never wait on a scan.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PREFIXES, FOREIGN_PREFIXES, scratchRoot, readMarker, isRealDir, isPidAlive, isStale, killTree, norm,
  sweepStale, LEDGER_NAME,
} from './scratch.mjs';

export const SAMPLES_NAME = 'webscout-host-samples.jsonl';
export const FOOTPRINT_NAME = 'webscout-scratch-log.jsonl';
export const TESTRUN_NAME = 'webscout-testrun-last.json';
export const CONFIRM_ABOVE = 200; // same guard as "scratch cleanup": more dirs than this needs an explicit confirm
const MB = 1048576;
const GB = 1073741824;
const SAMPLE_EVERY_MS = 10 * 60 * 1000;
const CACHE_MS = 15 * 1000;
const PEEK_REFRESH_MS = 60 * 1000;

// Colour thresholds, one place. `warn` / `crit` compare against the raw number; for free disk lower is worse.
export const THRESHOLDS = {
  dirs: { warn: 20, crit: 100 },
  mb: { warn: 1024, crit: 5120 },
  reclaimable: { warn: 1, crit: 20 },
  browsers: { warn: 6, crit: 15 },
  orphans: { warn: 1, crit: 3 },
  freeGb: { warn: 10, crit: 2 },
};
export function level(metric, value) {
  const t = THRESHOLDS[metric];
  if (value === null || value === undefined || !t) return 'unknown';
  if (metric === 'freeGb') return value < t.crit ? 'crit' : value < t.warn ? 'warn' : 'ok';
  return value >= t.crit ? 'crit' : value >= t.warn ? 'warn' : 'ok';
}

const file = (name) => path.join(scratchRoot(), name);
const hostScanOff = () => process.env.WEBSCOUT_NO_HOST_SCAN === '1';

// ---- primitives ------------------------------------------------------------------------
async function dirSizeAsync(dir) {
  let bytes = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries = [];
    try { entries = await fs.promises.readdir(d, { withFileTypes: true }); } catch { continue; }
    await Promise.all(entries.map(async (e) => {
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) return;
      if (e.isDirectory()) { stack.push(p); return; }
      try { bytes += (await fs.promises.lstat(p)).size; } catch { /* vanished */ }
    }));
  }
  return bytes;
}

function run(cmd, args, timeout = 30000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => resolve(err && !stdout ? '' : stdout));
  });
}

const BROWSER_EXE = ['msedge.exe', 'chrome.exe'];
// Async twin of scratch.listBrowserProcesses: [{pid, ppid, commandLine}] for every browser process.
export async function listBrowserProcessesAsync() {
  try {
    if (process.platform === 'win32') {
      const filter = BROWSER_EXE.map((n) => `Name='${n}'`).join(' OR ');
      const raw = (await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance Win32_Process -Filter "${filter}" | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress`])).trim();
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return (Array.isArray(parsed) ? parsed : [parsed]).filter((x) => x.CommandLine).map((x) => ({ pid: x.ProcessId, ppid: x.ParentProcessId, commandLine: x.CommandLine }));
    }
    const out = await run('ps', ['-eo', 'pid=,ppid=,args=']);
    return out.split('\n').map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l)).filter(Boolean)
      .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), commandLine: m[3] }))
      .filter((p) => /(chrome|chromium|msedge|microsoft-edge)/i.test(p.commandLine.split(' ')[0]));
  } catch { return []; }
}

const userDataDir = (commandLine) => { const m = /--user-data-dir=(?:"([^"]+)"|(\S+))/.exec(commandLine); return m ? (m[1] ?? m[2]) : null; };
const sourceOf = (name) => [...PREFIXES, ...FOREIGN_PREFIXES].find((p) => name.startsWith(p)) ?? null;

export function freeDisk(dir = scratchRoot()) {
  try {
    const s = fs.statfsSync(dir);
    return { freeBytes: Number(s.bavail) * Number(s.bsize), totalBytes: Number(s.blocks) * Number(s.bsize) };
  } catch { return null; }
}

// Returns a human warning when the disk that holds the scratch root is low, else null. Used before a browser
// launch (a fresh profile is ~8 MB slim, hundreds of MB on a bad day) and by "crv preflight".
export function lowDiskWarning({ dir = scratchRoot(), minFreeGb = Number(process.env.WEBSCOUT_MIN_FREE_GB) || THRESHOLDS.freeGb.warn } = {}) {
  const d = freeDisk(dir);
  if (!d) return null;
  const gb = d.freeBytes / GB;
  return gb < minFreeGb ? `only ${gb.toFixed(1)} GB free on the drive holding ${dir} (warn below ${minFreeGb} GB) - a browser launch needs a scratch profile there; run "scratch status" / "scratch cleanup --dry-run"` : null;
}

// ---- snapshot --------------------------------------------------------------------------
// One row per scratch dir: size, source (prefix), owner pid + alive/dead, age, reclaimable.
export async function scanScratchDirs({ baseDir = scratchRoot(), includeForeign = true, now = Date.now() } = {}) {
  const active = includeForeign ? [...PREFIXES, ...FOREIGN_PREFIXES] : PREFIXES;
  let names = [];
  try { names = await fs.promises.readdir(baseDir); } catch { return []; }
  const rows = [];
  for (const name of names.filter((n) => active.some((p) => n.startsWith(p)))) {
    const full = path.join(baseDir, name);
    if (!isRealDir(full)) continue;
    const marker = readMarker(full);
    let mtime = now;
    try { mtime = (await fs.promises.lstat(full)).mtimeMs; } catch { /* vanished */ }
    const createdAt = marker?.createdAt ?? mtime;
    rows.push({
      name, source: sourceOf(name), foreign: FOREIGN_PREFIXES.some((p) => name.startsWith(p)),
      ownerPid: marker?.pid ?? null, ownerAlive: marker ? isPidAlive(marker.pid) : null, // null = legacy dir, no marker
      createdAt: new Date(createdAt).toISOString(), ageMs: Math.max(0, now - createdAt),
      stale: isStale(full, { now }), bytes: await dirSizeAsync(full),
    });
  }
  return rows.sort((a, b) => b.bytes - a.bytes);
}

// Browsers whose --user-data-dir is one of OUR scratch profile dirs and that are orphaned: either their parent is
// gone, or the dir's marker owner is dead. A browser the user opened (no such dir) is never listed.
export function findOrphanBrowsers(procs, { baseDir = scratchRoot() } = {}) {
  const base = norm(baseDir);
  const out = [];
  for (const p of procs) {
    if (/--type=/.test(p.commandLine)) continue; // child process; the root carries the profile name
    const udd = userDataDir(p.commandLine);
    if (!udd) continue;
    const name = path.basename(udd);
    if (norm(path.dirname(udd)) !== base || !PREFIXES.some((x) => name.startsWith(x))) continue;
    const marker = readMarker(udd);
    const parentDead = !isPidAlive(p.ppid);
    const ownerDead = marker ? !isPidAlive(marker.pid) : false;
    if (parentDead || ownerDead) out.push({ pid: p.pid, ppid: p.ppid, dir: name, reason: ownerDead ? 'owner dead' : 'parent dead' });
  }
  return out;
}
const isOurBrowser = (p, baseDir) => {
  const udd = userDataDir(p.commandLine);
  return !/--type=/.test(p.commandLine) && !!udd && norm(path.dirname(udd)) === norm(baseDir) && PREFIXES.some((x) => path.basename(udd).startsWith(x));
};

function groupBySource(dirs) {
  const bySource = {};
  for (const d of dirs) {
    const k = d.source ?? 'other';
    const s = (bySource[k] ??= { dirs: 0, bytes: 0, stale: 0 });
    s.dirs += 1; s.bytes += d.bytes; if (d.stale) s.stale += 1;
  }
  return bySource;
}

let cache = null; // { at, data }
let inflight = null;
let lastPeekKick = 0;

export async function computeHostHealth() {
  const at = Date.now();
  const dirs = await scanScratchDirs({ now: at });
  const ours = dirs.filter((d) => !d.foreign);
  const procs = await listBrowserProcessesAsync();
  const orphans = findOrphanBrowsers(procs);
  const disk = freeDisk();
  const totalBytes = ours.reduce((s, d) => s + d.bytes, 0);
  const stale = ours.filter((d) => d.stale);
  const staleBytes = stale.reduce((s, d) => s + d.bytes, 0);
  const liveBrowsers = procs.filter((p) => isOurBrowser(p, scratchRoot())).length;
  const freeGb = disk ? disk.freeBytes / GB : null;
  const metrics = {
    dirs: ours.length, mb: Math.round(totalBytes / MB), reclaimable: stale.length, browsers: liveBrowsers, orphans: orphans.length,
    freeGb: freeGb === null ? null : Math.round(freeGb * 10) / 10,
  };
  return {
    at: new Date(at).toISOString(), root: scratchRoot(), metrics,
    levels: Object.fromEntries(Object.entries(metrics).map(([k, v]) => [k, level(k, v)])),
    thresholds: THRESHOLDS,
    scratchBytes: totalBytes, staleBytes, staleDirs: stale.length,
    bySource: groupBySource(ours),
    dirs, // includes wl-* (foreign) rows, flagged; cleanup of those needs includeForeign and is left to the CLI
    orphanBrowsers: orphans,
    disk,
    confirmAbove: CONFIRM_ABOVE,
  };
}

export async function getHostHealth({ force = false } = {}) {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.data;
  // A forced read means "look NOW": a scan already in flight may have listed the directory before the caller's
  // change, so let it finish and scan again instead of handing back its stale picture.
  if (force && inflight) { try { await inflight; } catch { /* the scan below reports its own failure */ } }
  if (!inflight) {
    inflight = computeHostHealth().then((data) => { cache = { at: Date.now(), data }; recordSample(data); return data; }).finally(() => { inflight = null; });
  }
  return inflight;
}

// Cached value or null. Never blocks; kicks a background refresh (at most once a minute) so analytics/preflight
// fill in on the next call. Off entirely when WEBSCOUT_NO_HOST_SCAN=1 (test relays).
export function peekHostHealth() {
  if (hostScanOff()) return null;
  if (!cache || Date.now() - cache.at > PEEK_REFRESH_MS) {
    if (Date.now() - lastPeekKick > PEEK_REFRESH_MS) { lastPeekKick = Date.now(); getHostHealth().catch(() => {}); }
  }
  return cache?.data ?? null;
}
export function resetHostHealthCache() { cache = null; inflight = null; lastPeekKick = 0; }

// ---- trend samples ---------------------------------------------------------------------
let lastSampleAt = 0;
export function recordSample(h, { force = false } = {}) {
  try {
    if (!force && Date.now() - lastSampleAt < SAMPLE_EVERY_MS) return false;
    const f = file(SAMPLES_NAME);
    if (!force && lastSampleAt === 0) { // first sample of this process: honour a recent one from another process
      try { if (Date.now() - fs.statSync(f).mtimeMs < SAMPLE_EVERY_MS) { lastSampleAt = Date.now(); return false; } } catch { /* none yet */ }
    }
    lastSampleAt = Date.now();
    try { if (fs.statSync(f).size > 1024 * 1024) fs.renameSync(f, `${f}.old`); } catch { /* none yet */ }
    fs.appendFileSync(f, `${JSON.stringify({ at: h.at, dirs: h.metrics.dirs, mb: h.metrics.mb, stale: h.metrics.reclaimable, browsers: h.metrics.browsers, orphans: h.metrics.orphans, freeGb: h.metrics.freeGb, bySource: h.bySource })}\n`);
    return true;
  } catch { return false; }
}
export function resetSampleClock() { lastSampleAt = 0; }

function readJsonl(name, { includeOld = false } = {}) {
  const rows = [];
  for (const f of includeOld ? [`${file(name)}.old`, file(name)] : [file(name)]) {
    let text = '';
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) { if (!line) continue; try { rows.push(JSON.parse(line)); } catch { /* torn line */ } }
  }
  return rows;
}

// Trend: dirs/MB over time from the samples, plus per-source daily creation counts from the ledger.
export function readTrend({ days = 14, now = Date.now() } = {}) {
  const since = now - days * 86400000;
  const samples = readJsonl(SAMPLES_NAME, { includeOld: true }).filter((s) => Date.parse(s.at) >= since);
  const created = {}; // day -> source -> n
  const disposed = {}; // day -> n (released)
  for (const e of readJsonl(LEDGER_NAME, { includeOld: true })) {
    const t = Date.parse(e.at);
    if (!(t >= since)) continue;
    const day = e.at.slice(0, 10);
    if (e.ev === 'create') { const d = (created[day] ??= {}); d[e.source ?? 'other'] = (d[e.source ?? 'other'] ?? 0) + 1; }
    else if (e.ev === 'dispose' && e.released) disposed[day] = (disposed[day] ?? 0) + 1;
  }
  const daily = Object.keys({ ...created, ...disposed }).sort().map((day) => ({
    day, bySource: created[day] ?? {}, created: Object.values(created[day] ?? {}).reduce((a, b) => a + b, 0), released: disposed[day] ?? 0,
  }));
  return { days, samples, daily };
}

// ---- per-session cost ------------------------------------------------------------------
// Attributes ledger events to sessions by time window (the CLI/browser process does not know the relay's
// session id): a session "spawned" every scratch dir created between its start and end, and "released" those
// disposed cleanly. `leaked` = spawned and never released (still on disk or removed by a later sweep).
export function sessionScratchCost(sessions, { now = Date.now() } = {}) {
  const events = readJsonl(LEDGER_NAME, { includeOld: true });
  const byDir = new Map(); // dir -> { at, source, pids:Set, released }
  for (const e of events) {
    if (e.ev === 'create') byDir.set(e.dir, { at: Date.parse(e.at), source: e.source, pids: new Set(), released: false });
    else if (e.ev === 'track') byDir.get(e.dir)?.pids.add(e.pid);
    else if (e.ev === 'dispose') { const d = byDir.get(e.dir); if (d && e.released) d.released = true; }
  }
  const foot = new Map(readJsonl(FOOTPRINT_NAME).map((r) => [r.dir, r.bytes]));
  const rows = [];
  for (const s of sessions) {
    const from = Date.parse(s.started_at);
    const to = s.ended_at ? Date.parse(s.ended_at) : now;
    let spawned = 0; let released = 0; let processes = 0; let bytes = 0;
    for (const [dir, d] of byDir) {
      if (d.at < from || d.at > to) continue;
      spawned += 1; processes += d.pids.size; if (d.released) released += 1; bytes += foot.get(dir) ?? 0;
    }
    if (spawned) rows.push({ sessionId: s.id, goal: s.goal ?? null, startedAt: s.started_at, spawned, released, leaked: spawned - released, processes, bytes: bytes || null });
  }
  return rows;
}

// ---- footprint log + last test run -----------------------------------------------------
// Profile sizes recorded at dispose (WEBSCOUT_SCRATCH_LOG=1). `jump` marks a row at least 1.5x the median of
// the rows before it: a dropped slim flag shows up as a step, not as slow growth.
export function readFootprint({ limit = 400 } = {}) {
  const rows = readJsonl(FOOTPRINT_NAME).filter((r) => Number.isFinite(r.bytes)).slice(-limit);
  const median = (xs) => { const a = [...xs].sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : 0; };
  return rows.map((r, i) => {
    const prior = rows.slice(Math.max(0, i - 10), i).map((x) => x.bytes);
    const base = prior.length >= 3 ? median(prior) : null;
    return { at: r.at, dir: r.dir, bytes: r.bytes, baseline: base, jump: base !== null && base > 0 && r.bytes >= base * 1.5 };
  });
}

export const testRunFile = () => process.env.WEBSCOUT_TESTRUN_FILE || path.join(os.tmpdir(), TESTRUN_NAME);
export function readLastTestRun() {
  try { return JSON.parse(fs.readFileSync(testRunFile(), 'utf8')); } catch { return null; }
}

// ---- actions ---------------------------------------------------------------------------
// Dry-run by default. `dirs` narrows to named rows; a real delete of more than CONFIRM_ABOVE dirs needs confirm.
export function cleanupScratch({ dryRun = true, confirm = false, dirs = null, baseDir = scratchRoot() } = {}) {
  const only = Array.isArray(dirs) && dirs.length ? new Set(dirs.map(String)) : null;
  const opts = { baseDir, ...(only ? { only } : {}) };
  let note;
  if (!dryRun && !confirm) {
    const preview = sweepStale({ ...opts, dryRun: true });
    if (preview.removed.length > CONFIRM_ABOVE) { dryRun = true; note = `${preview.removed.length} dirs exceeds ${CONFIRM_ABOVE}: nothing deleted. Review this preview, then confirm.`; }
  }
  const r = sweepStale({ ...opts, dryRun });
  if (!dryRun) resetHostHealthCache();
  return { ...r, removed: r.removed.map((x) => ({ name: path.basename(x.dir), bytes: x.bytes })), needsConfirm: !!note, ...(note ? { note } : {}) };
}

// Kills only root browsers findOrphanBrowsers() lists (re-derived here: the caller's pid list is never trusted).
export async function killOrphans({ pids = null, baseDir = scratchRoot() } = {}) {
  const orphans = findOrphanBrowsers(await listBrowserProcessesAsync(), { baseDir });
  const want = Array.isArray(pids) && pids.length ? new Set(pids.map(Number)) : null;
  const killed = [];
  for (const o of orphans) { if (want && !want.has(o.pid)) continue; killTree(o.pid); killed.push(o.pid); }
  resetHostHealthCache();
  return { killed, requested: want ? [...want] : 'all', skipped: want ? [...want].filter((p) => !killed.includes(p)) : [] };
}

// Friction rows for analytics.topFrictionItems, from a cached snapshot (null-safe).
export function hostFrictionItems(h) {
  if (!h) return [];
  const items = [];
  const mb = Math.round(h.scratchBytes / MB);
  if (h.orphanBrowsers.length) items.push({ kind: 'orphanBrowsers', severity: 60 + h.orphanBrowsers.length, summary: `${h.orphanBrowsers.length} orphan browser process(es) still hold web-scout scratch profiles (pids ${h.orphanBrowsers.slice(0, 5).map((o) => o.pid).join(', ')}) - kill them from the dashboard Host health panel or run "scratch cleanup"` });
  if (h.levels.dirs !== 'ok' || h.levels.mb !== 'ok' || h.levels.reclaimable === 'crit') items.push({ kind: 'scratchLeak', severity: 20 + h.metrics.dirs, summary: `${h.metrics.dirs} web-scout scratch dir(s) using ${mb} MB in ${h.root}, ${h.staleDirs} reclaimable - run "scratch cleanup --dry-run"` });
  if (h.levels.freeGb !== 'ok' && h.levels.freeGb !== 'unknown') items.push({ kind: 'lowDisk', severity: 70, summary: `only ${h.metrics.freeGb} GB free on the drive holding ${h.root} - a browser launch may fail or fill it` });
  return items;
}

// Compact block for "crv preflight": cached scratch numbers + a FRESH free-disk read (cheap, and the
// number a launch decision depends on).
export function preflightHostReport() {
  const h = peekHostHealth();
  const d = freeDisk();
  const warnings = [];
  const low = lowDiskWarning();
  if (low) warnings.push(low);
  if (h?.orphanBrowsers.length) warnings.push(`${h.orphanBrowsers.length} orphan web-scout browser process(es) running`);
  if (h && h.levels.dirs !== 'ok') warnings.push(`${h.metrics.dirs} scratch dir(s), ${h.staleDirs} reclaimable (${Math.round(h.scratchBytes / MB)} MB)`);
  return {
    freeDiskGb: d ? Math.round((d.freeBytes / GB) * 10) / 10 : null,
    scratchDirs: h?.metrics.dirs ?? null, scratchBytes: h?.scratchBytes ?? null, orphanBrowsers: h?.orphanBrowsers.length ?? null,
    warnings,
  };
}
