// Live view of every headless browser web-scout started, plus the leak ledger.
//
//   listBrowserGroups()   one row per --user-data-dir: process count, CPU seconds, age, owner
//                         pid and whether it is still alive, and whether the group is an orphan
//   reapBrowsers()        kills orphan groups (or every web-scout group with all:true)
//   browserLedger(ev)     append-only JSONL of launches/closes/leaks, read by GET /analytics
//
// Run directly it is the Claude Code hook / status-line feeder:
//   node tools/web-scout/browser-reaper.mjs [--kill] [--quiet]
// prints nothing unless it found (and with --kill, killed) orphans, and always refreshes the
// status cache a status line can read without spawning PowerShell itself.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readMarker, isPidAlive, scratchRoot, sweepStale } from './scratch.mjs';

export const PROFILE_PREFIXES = ['webscout-browser-profile-', 'webscout-crv-tab-profile-'];
export const STATUS_FILE = () => path.join(os.tmpdir(), 'webscout-browsers-status.json');
// WEBSCOUT_BROWSER_LEDGER: test relays point this at their own temp dir, so a host's real leaks never
// leak into a test's GET /analytics (it is machine-wide otherwise, by design).
export const LEDGER_FILE = () => process.env.WEBSCOUT_BROWSER_LEDGER || path.join(scratchRoot(), 'webscout-browser-ledger.jsonl');
const LEDGER_MAX_BYTES = 512 * 1024;
const UNMARKED_GRACE_MS = 10 * 60 * 1000;

const USER_DATA_DIR = /--user-data-dir=(?:"([^"]+)"|(\S+))/;
export function profileOf(commandLine) {
  const m = USER_DATA_DIR.exec(commandLine ?? '');
  const dir = m ? (m[1] ?? m[2]) : null;
  return dir && PROFILE_PREFIXES.some((p) => path.basename(dir).startsWith(p)) ? dir : null;
}

// Every browser process whose command line names a web-scout profile:
// [{ pid, ppid, name, commandLine, cpuSeconds, createdAt }]
export function listProfileProcesses() {
  try {
    if (process.platform === 'win32') {
      const ps = "Get-CimInstance Win32_Process -Filter \"CommandLine LIKE '%webscout-%-profile-%'\" | Where-Object { $_.Name -ne 'powershell.exe' } | ForEach-Object { [pscustomobject]@{ pid=$_.ProcessId; ppid=$_.ParentProcessId; name=$_.Name; cmd=$_.CommandLine; cpu=[math]::Round(($_.KernelModeTime + $_.UserModeTime) / 1e7, 2); created=$(if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { $null }) } } | ConvertTo-Json -Compress";
      const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 64 * 1024 * 1024 });
      const raw = (r.stdout ?? '').trim();
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return (Array.isArray(parsed) ? parsed : [parsed]).map((p) => ({ pid: p.pid, ppid: p.ppid, name: p.name, commandLine: p.cmd, cpuSeconds: Number(p.cpu) || 0, createdAt: p.created }));
    }
    const r = spawnSync('ps', ['-eo', 'pid=,ppid=,etimes=,time=,comm=,args='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return r.stdout.split('\n').map((l) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/.exec(l)).filter(Boolean)
      .filter((m) => /webscout-[a-z]+-profile-/.test(m[6]) && !/(^|\/)ps$/.test(m[5]))
      .map((m) => {
        const [h, mi, s] = m[4].replace(/^\d+-/, '').split(':').map(Number);
        return { pid: Number(m[1]), ppid: Number(m[2]), name: m[5], commandLine: m[6], cpuSeconds: (h * 3600) + (mi * 60) + s, createdAt: new Date(Date.now() - Number(m[3]) * 1000).toISOString() };
      });
  } catch { return []; }
}

// Pure: groups processes by profile and decides which groups are orphans.
//   deps.readMarker(dir) -> { pid } | null     deps.isAlive(pid) -> bool     deps.exists(dir) -> bool
// A group is an orphan when it is headless and its owner is gone: the marker's owner pid is dead,
// or (no marker) none of its processes has a living parent outside the group. CRV tabs
// (webscout-crv-tab-profile-*) are operator windows and are never orphans. deps.sharedProfile names
// the shared browser's profile (kind 'shared'; its marker owner is the job host).
export function groupBrowsers(procs, deps, { now = Date.now() } = {}) {
  const groups = new Map();
  for (const p of procs) {
    const dir = profileOf(p.commandLine);
    if (!dir) continue;
    const key = path.resolve(dir).toLowerCase();
    const g = groups.get(key) ?? { profile: dir, processes: [] };
    g.processes.push(p);
    groups.set(key, g);
  }
  return [...groups.values()].map((g) => {
    const pids = new Set(g.processes.map((p) => p.pid));
    const headless = g.processes.some((p) => /--headless/.test(p.commandLine));
    const kind = path.basename(g.profile).startsWith('webscout-crv-tab-profile-') ? 'crv-tab'
      : deps.sharedProfile && path.resolve(deps.sharedProfile).toLowerCase() === path.resolve(g.profile).toLowerCase() ? 'shared' : 'run';
    const marker = deps.readMarker(g.profile);
    const ownerPid = marker?.pid ?? null;
    const ownerAlive = ownerPid ? deps.isAlive(ownerPid) : null;
    const externalParentAlive = g.processes.some((p) => !pids.has(p.ppid) && deps.isAlive(p.ppid));
    const started = g.processes.map((p) => Date.parse(p.createdAt)).filter(Number.isFinite);
    // No marker: Edge's real browser always has a dead parent (the launched msedge.exe is a trampoline),
    // so a young unmarked group may still be someone's live run. Only call it an orphan after 10 minutes.
    const oldEnough = started.length ? now - Math.min(...started) > UNMARKED_GRACE_MS : true;
    const orphan = kind !== 'crv-tab' && headless && (ownerPid ? !ownerAlive : (!externalParentAlive && oldEnough));
    return {
      profile: g.profile,
      kind,
      headless,
      processes: g.processes.length,
      pids: [...pids],
      cpuSeconds: Math.round(g.processes.reduce((s, p) => s + (p.cpuSeconds || 0), 0) * 10) / 10,
      ageSeconds: started.length ? Math.round((now - Math.min(...started)) / 1000) : null,
      ownerPid,
      ownerAlive,
      orphan,
      dirExists: deps.exists(g.profile),
    };
  }).sort((a, b) => b.cpuSeconds - a.cpuSeconds);
}

export function listBrowserGroups({ procs = listProfileProcesses() } = {}) {
  let sharedProfile = null;
  try { sharedProfile = JSON.parse(fs.readFileSync(path.join(os.tmpdir(), 'webscout-shared-browser.json'), 'utf8')).profile ?? null; } catch { /* no shared browser */ }
  return groupBrowsers(procs, { readMarker, isAlive: isPidAlive, exists: (d) => fs.existsSync(d), sharedProfile });
}

export function killPids(pids) {
  const list = pids.filter((p) => Number.isInteger(p) && p > 0);
  if (!list.length) return;
  if (process.platform === 'win32') {
    for (let i = 0; i < list.length; i += 40) {
      spawnSync('taskkill', ['/F', ...list.slice(i, i + 40).flatMap((p) => ['/PID', String(p)])], { stdio: 'ignore', windowsHide: true, timeout: 20000 });
    }
  } else {
    for (const p of list) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } }
  }
}

// Kills orphan groups (all:true = every web-scout browser group, CRV tabs included), then sweeps
// their profile dirs. Returns { groups, killed:[{profile, processes, cpuSeconds}], status }.
export function reapBrowsers({ kill = false, all = false, procs } = {}) {
  const groups = listBrowserGroups(procs ? { procs } : {});
  const victims = groups.filter((g) => (all ? true : g.orphan));
  if (kill && victims.length) {
    killPids(victims.flatMap((g) => g.pids));
    browserLedger({ ev: 'reap', groups: victims.length, processes: victims.reduce((s, g) => s + g.processes, 0), cpuSeconds: victims.reduce((s, g) => s + g.cpuSeconds, 0), all });
    try { sweepStale({ markerOnly: false, prefixes: ['webscout-browser-profile-'] }); } catch { /* dirs are the sweep's job anyway */ }
  }
  const remaining = kill ? groups.filter((g) => !victims.includes(g)) : groups;
  const status = writeStatus(remaining, kill ? victims : []);
  return { groups, killed: kill ? victims.map((g) => ({ profile: g.profile, processes: g.processes, cpuSeconds: g.cpuSeconds })) : [], status };
}

// Small JSON a status line reads (no PowerShell per refresh): counts as of the last reap/list.
export function writeStatus(groups, killed = []) {
  const status = {
    at: new Date().toISOString(),
    browsers: groups.filter((g) => g.headless).length,
    processes: groups.reduce((s, g) => s + g.processes, 0),
    orphans: groups.filter((g) => g.orphan).length,
    cpuSeconds: Math.round(groups.reduce((s, g) => s + g.cpuSeconds, 0)),
    killedNow: killed.reduce((s, g) => s + g.processes, 0),
  };
  try { fs.writeFileSync(STATUS_FILE(), JSON.stringify(status)); } catch { /* status line just shows stale data */ }
  return status;
}

// --- leak ledger ------------------------------------------------------------------------
// One JSON line per event: launch {mode}, close {mode, ms, cpuSeconds, contained, leaked},
// leak {leaked, profile}, reap {processes}. Rotates itself so it cannot become the next leak.
export function browserLedger(event) {
  try {
    const file = LEDGER_FILE();
    try { if (fs.statSync(file).size > LEDGER_MAX_BYTES) fs.renameSync(file, `${file}.old`); } catch { /* no ledger yet */ }
    fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, script: path.basename(process.argv[1] ?? ''), ...event })}\n`);
  } catch { /* observability only */ }
}

export function readBrowserLedger({ file = LEDGER_FILE(), sinceMs = 0 } = {}) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { const e = JSON.parse(line); if (!sinceMs || Date.parse(e.at) >= sinceMs) out.push(e); } catch { /* torn line */ }
  }
  return out;
}

// Analytics block: browser runs, leaks and CPU over the last `windowMs`, plus recent leak rows.
export function summarizeBrowserLedger(events, { now = Date.now(), windowMs = 24 * 60 * 60 * 1000 } = {}) {
  const recent = events.filter((e) => now - Date.parse(e.at) <= windowMs);
  const closes = recent.filter((e) => e.ev === 'close');
  const leaks = recent.filter((e) => e.ev === 'leak');
  const reaps = recent.filter((e) => e.ev === 'reap');
  const byScript = new Map();
  for (const e of closes) {
    const s = byScript.get(e.script) ?? { script: e.script, runs: 0, cpuSeconds: 0, leakedProcesses: 0 };
    s.runs += 1;
    s.cpuSeconds += e.cpuSeconds || 0;
    s.leakedProcesses += e.leaked || 0;
    byScript.set(e.script, s);
  }
  return {
    windowHours: Math.round(windowMs / 3600000),
    launches: recent.filter((e) => e.ev === 'launch').length,
    closes: closes.length,
    jobContained: closes.filter((e) => e.mode === 'job').length,
    leaks: leaks.length,
    leakedProcesses: leaks.reduce((s, e) => s + (e.leaked || 0), 0),
    reapedProcesses: reaps.reduce((s, e) => s + (e.processes || 0), 0),
    cpuSeconds: Math.round(closes.reduce((s, e) => s + (e.cpuSeconds || 0), 0)),
    lastLeakAt: leaks.at(-1)?.at ?? null,
    recentLeaks: leaks.slice(-10).reverse().map((e) => ({ at: e.at, script: e.script, leaked: e.leaked, mode: e.mode, profile: e.profile })),
    byScript: [...byScript.values()].map((s) => ({ ...s, cpuSeconds: Math.round(s.cpuSeconds) })).sort((a, b) => b.cpuSeconds - a.cpuSeconds).slice(0, 10),
  };
}

// --- direct run: hook / status-line feeder -----------------------------------------------
const isMain = (() => { try { return path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url); } catch { return false; } })();
if (isMain) {
  const argv = process.argv.slice(2);
  const r = reapBrowsers({ kill: argv.includes('--kill') });
  const orphans = r.groups.filter((g) => g.orphan);
  if (r.killed.length) {
    const n = r.killed.reduce((s, g) => s + g.processes, 0);
    console.log(`webscout: killed ${n} orphan headless browser process(es) in ${r.killed.length} group(s), ${Math.round(r.killed.reduce((s, g) => s + g.cpuSeconds, 0))} CPU-seconds burned.`);
  } else if (orphans.length && !argv.includes('--quiet')) {
    console.log(`webscout: ${orphans.length} orphan headless browser group(s) running; rerun with --kill.`);
  }
}
