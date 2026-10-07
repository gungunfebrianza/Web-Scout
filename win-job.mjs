// Windows Job Object launcher for headless browsers.
//
// Killing the browser's own pid (or its tree with taskkill /T) left headless Edge's helper
// processes running on Windows: about 10 per launch, holding the profile dir and burning CPU
// until 68 of them pinned the machine for hours (2026-10-08). Node cannot create a Job Object
// without a native addon, so this compiles a tiny C# host once (csc.exe ships with .NET
// Framework 4 on every Windows 10/11) and caches the exe under the OS temp dir.
//
// The host puts ITSELF in a fresh job, then starts the browser, so the browser and every helper
// it ever spawns are in that job. The job is created with:
//   - KILL_ON_JOB_CLOSE: when the host exits for any reason (browser quit, owner died, killed,
//     crashed), Windows kills everything still in the job. Nothing can outlive it.
//   - BELOW_NORMAL priority for every process in the job, so a busy browser yields to the desktop.
//   - an optional hard CPU cap (percent of the whole machine).
// Why a plain kill never worked: the msedge.exe we spawn is a trampoline that exits within a second
// after starting the real browser as a separate tree, so child.kill() and taskkill /T /PID <child>
// aimed at a pid that was already gone, and the real browser kept running with no parent.
// The host exits when the job holds no browser process any more, when the owner pid dies, when a maximum
// lifetime passes, or (shared mode) when the browser has had no real page open for a while.
// On a clean exit it writes a JSON report: why it exited, how many processes were still alive
// in the job (stragglers the job then killed), and the job's total CPU seconds.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// C# 5 only (csc.exe from .NET Framework 4): no string interpolation, no ?. or out var.
export const JOBHOST_SOURCE = String.raw`using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;

static class WebscoutJobHost {
  [StructLayout(LayoutKind.Sequential)]
  struct BasicLimit { public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass; }
  [StructLayout(LayoutKind.Sequential)]
  struct IoCounters { public ulong R, W, O, RB, WB, OB; }
  [StructLayout(LayoutKind.Sequential)]
  struct ExtendedLimit { public BasicLimit Basic; public IoCounters Io; public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed; }
  [StructLayout(LayoutKind.Sequential)]
  struct CpuRate { public uint ControlFlags; public uint Rate; }
  [StructLayout(LayoutKind.Sequential)]
  struct Accounting { public long TotalUserTime; public long TotalKernelTime; public long ThisPeriodTotalUserTime; public long ThisPeriodTotalKernelTime; public uint TotalPageFaultCount; public uint TotalProcesses; public uint ActiveProcesses; public uint TotalTerminatedProcesses; }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimit info, int length);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref CpuRate info, int length);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out Accounting info, int length, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();

  const uint KILL_ON_JOB_CLOSE = 0x2000, DIE_ON_UNHANDLED_EXCEPTION = 0x400, LIMIT_PRIORITY_CLASS = 0x20, BELOW_NORMAL = 0x4000;

  static string Arg(string[] a, string name) { for (int i = 0; i + 1 < a.Length; i++) if (a[i] == name) return a[i + 1]; return null; }
  static long Num(string[] a, string name) { string v = Arg(a, name); long n; return v != null && long.TryParse(v, out n) ? n : 0; }
  static string B64(string v) { return v == null ? null : Encoding.UTF8.GetString(Convert.FromBase64String(v)); }
  static string Esc(string s) { return (s ?? "").Replace("\\", "\\\\").Replace("\"", "\\\""); }
  static void WriteFile(string file, string text) { if (file == null) return; try { File.WriteAllText(file + ".tmp", text); if (File.Exists(file)) File.Delete(file); File.Move(file + ".tmp", file); } catch { } }

  // A real page is open when any target's url is http(s) or file; an idle shared browser has only about:blank.
  static readonly Regex RealPage = new Regex("\"url\"\\s*:\\s*\"(https?|file):", RegexOptions.Compiled);
  static bool Busy(long port) {
    try {
      var req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + "/json/list");
      req.Timeout = 3000; req.Proxy = null;
      using (var res = req.GetResponse()) using (var r = new StreamReader(res.GetResponseStream())) return RealPage.IsMatch(r.ReadToEnd());
    } catch { return false; }
  }

  static int Main(string[] argv) {
    string exe = B64(Arg(argv, "--exe")), args = B64(Arg(argv, "--args")) ?? "";
    string pidFile = Arg(argv, "--pid-file"), reportFile = Arg(argv, "--report");
    long owner = Num(argv, "--owner"), cpu = Num(argv, "--cpu"), maxMs = Num(argv, "--max-ms"), idlePort = Num(argv, "--idle-port"), idleMs = Num(argv, "--idle-ms");
    if (exe == null) { WriteFile(pidFile, "{\"error\":\"missing --exe\"}"); return 2; }

    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) { WriteFile(pidFile, "{\"error\":\"CreateJobObject failed: " + Marshal.GetLastWin32Error() + "\"}"); return 3; }
    var ext = new ExtendedLimit();
    ext.Basic.LimitFlags = KILL_ON_JOB_CLOSE | DIE_ON_UNHANDLED_EXCEPTION | LIMIT_PRIORITY_CLASS;
    ext.Basic.PriorityClass = BELOW_NORMAL;
    if (!SetInformationJobObject(job, 9, ref ext, Marshal.SizeOf(typeof(ExtendedLimit)))) { WriteFile(pidFile, "{\"error\":\"SetInformationJobObject failed: " + Marshal.GetLastWin32Error() + "\"}"); return 3; }
    bool capped = false;
    if (cpu > 0 && cpu < 100) {
      var rate = new CpuRate(); rate.ControlFlags = 0x1 | 0x4; rate.Rate = (uint)(cpu * 100); // ENABLE | HARD_CAP, in 1/100 percent
      capped = SetInformationJobObject(job, 15, ref rate, Marshal.SizeOf(typeof(CpuRate)));
    }
    if (!AssignProcessToJobObject(job, GetCurrentProcess())) { WriteFile(pidFile, "{\"error\":\"AssignProcessToJobObject failed: " + Marshal.GetLastWin32Error() + "\"}"); return 4; }

    Process owned = null;
    if (owner > 0) { try { owned = Process.GetProcessById((int)owner); } catch { WriteFile(pidFile, "{\"error\":\"owner already exited\"}"); return 5; } }

    Process browser;
    try {
      var psi = new ProcessStartInfo(exe, args);
      psi.UseShellExecute = false; psi.CreateNoWindow = true;
      browser = Process.Start(psi);
    } catch (Exception e) { WriteFile(pidFile, "{\"error\":\"start failed: " + Esc(e.Message) + "\"}"); return 6; }
    WriteFile(pidFile, "{\"pid\":" + browser.Id + ",\"host\":" + Process.GetCurrentProcess().Id + ",\"cpuCapped\":" + (capped ? "true" : "false") + "}");

    // The launched msedge.exe is a trampoline: it exits within a second and the real browser runs as
    // a separate process tree whose parent is gone. So "the browser is gone" means the job holds no
    // process but this host - never "the launched pid exited".
    var started = DateTime.UtcNow; var lastBusy = started; var lastPoll = started;
    string reason = null;
    while (reason == null) {
      System.Threading.Thread.Sleep(500);
      Accounting live;
      if (QueryInformationJobObject(job, 1, out live, Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero) && live.ActiveProcesses <= 1) { reason = "browser-exited"; break; }
      var now = DateTime.UtcNow;
      if (owned != null && owned.HasExited) reason = "owner-exited";
      else if (maxMs > 0 && (now - started).TotalMilliseconds > maxMs) reason = "max-lifetime";
      else if (idlePort > 0 && (now - lastPoll).TotalMilliseconds >= 10000) {
        lastPoll = now;
        if (Busy(idlePort)) lastBusy = now;
        else if ((now - lastBusy).TotalMilliseconds > idleMs) reason = "idle";
      }
    }
    Accounting acc;
    uint alive = 0; double cpuSeconds = 0; uint total = 0;
    if (QueryInformationJobObject(job, 1, out acc, Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero)) {
      alive = acc.ActiveProcesses > 0 ? acc.ActiveProcesses - 1 : 0; // minus this host
      cpuSeconds = (acc.TotalUserTime + acc.TotalKernelTime) / 1e7;
      total = acc.TotalProcesses;
    }
    WriteFile(reportFile, "{\"reason\":\"" + reason + "\",\"stragglers\":" + alive + ",\"totalProcesses\":" + total + ",\"cpuSeconds\":" + cpuSeconds.ToString("0.###", System.Globalization.CultureInfo.InvariantCulture) + ",\"ms\":" + (long)(DateTime.UtcNow - started).TotalMilliseconds + "}");
    return 0; // the job handle closes with this process: KILL_ON_JOB_CLOSE takes every straggler with it
  }
}
`;

const CSC_CANDIDATES = [
  'C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe',
  'C:/Windows/Microsoft.NET/Framework/v4.0.30319/csc.exe',
];

let cachedHost; // undefined = not tried yet, null = unavailable
let lastError = null;
export const jobHostError = () => lastError;

// Path to the compiled host, compiling it on first use. null when unavailable (not Windows,
// WEBSCOUT_NO_JOB=1, no csc.exe, or the compile failed) - callers fall back to a plain spawn.
export function jobHostPath() {
  if (cachedHost !== undefined) return cachedHost;
  cachedHost = null;
  if (process.platform !== 'win32' || process.env.WEBSCOUT_NO_JOB === '1') return null;
  const hash = crypto.createHash('sha256').update(JOBHOST_SOURCE).digest('hex').slice(0, 12);
  const dir = path.join(os.tmpdir(), 'webscout-jobhost');
  const exe = path.join(dir, `webscout-jobhost-${hash}.exe`);
  if (fs.existsSync(exe)) { cachedHost = exe; return exe; }
  const csc = CSC_CANDIDATES.find((c) => fs.existsSync(c));
  if (!csc) { lastError = 'csc.exe (.NET Framework 4) not found'; return null; }
  try {
    fs.mkdirSync(dir, { recursive: true });
    const tag = `${process.pid}-${Date.now()}`;
    const src = path.join(dir, `jobhost-${tag}.cs`);
    const tmpExe = path.join(dir, `jobhost-${tag}.exe`);
    fs.writeFileSync(src, JOBHOST_SOURCE);
    const r = spawnSync(csc, ['/nologo', '/optimize+', '/target:exe', `/out:${tmpExe}`, src], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
    try { fs.rmSync(src, { force: true }); } catch { /* temp source */ }
    if (r.status !== 0 || !fs.existsSync(tmpExe)) { lastError = `csc failed: ${(r.stdout || r.stderr || r.error?.message || '').trim().slice(0, 400)}`; return null; }
    try { fs.renameSync(tmpExe, exe); } catch { /* another process won the race */ try { fs.rmSync(tmpExe, { force: true }); } catch { /* in use */ } }
    if (!fs.existsSync(exe)) { lastError = 'compiled host vanished'; return null; }
    cachedHost = exe;
    return exe;
  } catch (err) {
    lastError = err.message;
    return null;
  }
}

// One argv element quoted for a Windows command line (the MSVCRT / CommandLineToArgvW rules).
export function quoteWinArg(arg) {
  const s = String(arg);
  if (s && !/[\s"]/.test(s)) return s;
  let out = '"';
  let slashes = 0;
  for (const ch of s) {
    if (ch === '\\') { slashes += 1; continue; }
    if (ch === '"') { out += `${'\\'.repeat(slashes * 2 + 1)}"`; slashes = 0; continue; }
    out += '\\'.repeat(slashes) + ch;
    slashes = 0;
  }
  return `${out}${'\\'.repeat(slashes * 2)}"`;
}

// Reports nobody read (the owner was killed, or a shared host) and superseded host builds.
function pruneHostDir(dir, currentExe) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  const now = Date.now();
  for (const name of names) {
    const full = path.join(dir, name);
    const stale = /^run-.*\.json$/.test(name) ? 60 * 60 * 1000 : (/^webscout-jobhost-.*\.exe$/.test(name) && full !== currentExe) ? 24 * 60 * 60 * 1000 : 0;
    if (!stale) continue;
    try { if (now - fs.statSync(full).mtimeMs > stale) fs.rmSync(full, { force: true }); } catch { /* in use or gone */ }
  }
}

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

// Starts `exe args` inside a new job. Resolves { host, pid, hostPid, cpuCapped, report() } once the
// browser is running; rejects when the host could not set the job up (callers fall back).
//   ownerPid: the host exits (and the job kills the browser) when this pid exits. 0 = no owner.
//   cpuPct:   hard CPU cap for the whole job, percent of the machine (0 = none).
//   maxMs:    hard lifetime limit (0 = none).
//   idlePort / idleMs: shared mode - exit after idleMs with no http(s)/file page open on that CDP port.
export async function spawnInJob(exe, args, { ownerPid = process.pid, cpuPct = 0, maxMs = 0, idlePort = 0, idleMs = 0, stateDir, detachHost = false } = {}) {
  const hostExe = jobHostPath();
  if (!hostExe) throw new Error(`job host unavailable: ${lastError ?? 'not Windows'}`);
  const dir = stateDir ?? path.join(os.tmpdir(), 'webscout-jobhost');
  fs.mkdirSync(dir, { recursive: true });
  pruneHostDir(dir, hostExe);
  const tag = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const pidFile = path.join(dir, `run-${tag}.pid.json`);
  const reportFile = path.join(dir, `run-${tag}.report.json`);
  const hostArgs = ['--exe', b64(exe), '--args', b64(args.map(quoteWinArg).join(' ')), '--pid-file', pidFile, '--report', reportFile,
    '--owner', String(ownerPid || 0), '--cpu', String(cpuPct || 0), '--max-ms', String(maxMs || 0), '--idle-port', String(idlePort || 0), '--idle-ms', String(idleMs || 0)];
  // detached: libuv puts non-detached children in its own job with silent breakaway; the host must
  // start outside it so its own job is the one that holds the browser.
  const host = spawn(hostExe, hostArgs, { stdio: 'ignore', windowsHide: true, detached: true });
  let hostExited = false;
  host.once('exit', () => { hostExited = true; });
  host.once('error', () => { hostExited = true; });
  if (detachHost) host.unref();
  for (let i = 0; i < 150; i += 1) { // up to 15s (first run of a fresh exe can be slowed by AV)
    const info = readJson(pidFile);
    if (info) {
      try { fs.rmSync(pidFile, { force: true }); } catch { /* temp */ }
      if (info.error) throw new Error(`job host: ${info.error}`);
      return {
        host, pid: info.pid, hostPid: info.host, cpuCapped: !!info.cpuCapped,
        exited: () => hostExited,
        report: () => { const r = readJson(reportFile); if (r) { try { fs.rmSync(reportFile, { force: true }); } catch { /* temp */ } } return r; },
      };
    }
    if (hostExited) break;
    await sleep(100);
  }
  try { host.kill(); } catch { /* gone */ }
  throw new Error('job host never reported the browser pid');
}
