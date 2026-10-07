// Headless Chromium/Edge over CDP for the tests that need a real page. Tests
// skip themselves when findBrowser() returns null, like the connected-tab tests.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { freePort } from './test-relay.mjs';
import { createScratchDir, ownScratchDir, sweepStale, sweepFixtures, recordSweep, setOwner, isPidAlive, killTree } from './scratch.mjs';
import { jobHostPath, spawnInJob } from './win-job.mjs';
import { acquireSlot } from './browser-slots.mjs';
import { browserLedger, listProfileProcesses, listBrowserGroups, writeStatus, profileOf, killPids } from './browser-reaper.mjs';
// host-health.mjs only exists in a full checkout. This file is also vendored into other projects (see sync.mjs),
// where it must still load and clean up after itself, so the low-disk warning is optional.
let lowDiskWarning = () => null;
try { ({ lowDiskWarning } = await import('./host-health.mjs')); } catch { /* vendored copy without the dashboard modules */ }

// Cuts the profile's disk footprint (~460 MB of caches/component data per run before).
export const SLIM_FLAGS = [
  '--no-first-run', '--disk-cache-size=1', '--media-cache-size=1', '--disable-background-networking',
  '--disable-component-update', '--disable-extensions', '--disable-sync', '--disable-default-apps',
  '--no-default-browser-check', '--disable-breakpad',
];

// Reclaim profiles/browsers orphaned by earlier crashed runs. Never lets a sweep failure block a launch.
function sweepQuietly() {
  if (process.env.WEBSCOUT_NO_SWEEP === '1' || process.env.NODE_ENV === 'test') return; // opt-outs; tests get a private root instead
  try {
    const marked = sweepStale({ markerOnly: true });
    // Profiles left by older vendored copies of this harness carry no owner marker (and were never swept).
    // Reclaim the ones untouched for an hour whose browser is gone; a younger one may belong to a live run.
    const legacy = sweepStale({ prefixes: ['webscout-browser-profile-'], staleUnownedMs: 60 * 60 * 1000 });
    const fixtures = sweepFixtures();
    recordSweep(marked, 'launch');
    recordSweep(legacy, 'launch-legacy');
    const mb = ((marked.freedBytes + legacy.freedBytes + fixtures.freedBytes) / 1048576).toFixed(0);
    const n = marked.removed.length + legacy.removed.length + fixtures.removed;
    if (n) process.stderr.write(`webscout: reclaimed ${n} leftover scratch entr${n === 1 ? 'y' : 'ies'} (${mb} MB)${legacy.unmarked ? `; ${legacy.unmarked} had no owner marker - an older vendored copy of the harness leaked them, re-run "node cli.mjs harness sync <project>"` : ''}
`);
  } catch { /* best effort */ }
}


export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function findBrowser() {
  const candidates = [
    process.env.WEBSCOUT_BROWSER,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  if (process.platform !== 'win32') {
    for (const name of ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'microsoft-edge']) {
      const r = spawnSync('which', [name], { encoding: 'utf8' });
      if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
    }
  }
  return null;
}

// false = run the browser tests; a string = the skip reason. With
// WEBSCOUT_REQUIRE_BROWSER=1 (CI) a missing browser is an error, not a skip: a
// skipped test proves nothing, and a runner that silently lost its browser would
// keep reporting green.
export function browserSkip() {
  if (findBrowser()) return false;
  const reason = 'no Chromium/Edge binary found (set WEBSCOUT_BROWSER)';
  if (process.env.WEBSCOUT_REQUIRE_BROWSER === '1') throw new Error(`${reason}, but WEBSCOUT_REQUIRE_BROWSER=1 forbids skipping the browser tests`);
  return reason;
}

const envNum = (name, fallback) => {
  const raw = process.env[name];
  const n = Number(raw);
  return raw !== undefined && raw !== '' && Number.isFinite(n) ? n : fallback;
};
const warn = (msg) => { try { process.stderr.write(`webscout: ${msg}\n`); } catch { /* stderr closed */ } };
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const sameDir = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

// Limits for every headless browser (env overrides):
//   WEBSCOUT_BROWSER_CPU     hard CPU cap for one browser's whole process tree, percent of the
//                            machine (default 25; 0 = none). Windows Job Object only.
//   WEBSCOUT_BROWSER_MAX_MS  hard lifetime of one browser (default 30 min; 0 = none).
const browserLimits = () => ({ cpuPct: envNum('WEBSCOUT_BROWSER_CPU', 25), maxMs: envNum('WEBSCOUT_BROWSER_MAX_MS', 30 * 60 * 1000) });

// Leak gate: a browser process still running after close() fails the run (exit code 1) instead of
// printing a warning that reads like housekeeping. WEBSCOUT_LEAK_OK=1 downgrades it to the message.
let leakHooked = false;
function failRunOnLeak() {
  if (process.env.WEBSCOUT_LEAK_OK === '1') return;
  process.exitCode = 1;
  if (leakHooked) return;
  leakHooked = true;
  process.on('exit', (code) => { if (!code) process.exitCode = 1; }); // also beats a later process.exit(0)
}

// Browser processes still running on `profile` after close: killed, and counted. Processes the job
// (or the polite quit) is tearing down stay listed for a while under load - a busy suite at the CPU
// cap took over a second - so only what is still there after up to 5s counts as leaked.
// Also refreshes the status-line cache from the same process list (no extra PowerShell call).
async function reapProfile(profile) {
  let all = listProfileProcesses();
  const onProfile = () => all.filter((p) => { const d = profileOf(p.commandLine); return d && sameDir(d, profile); });
  let stray = onProfile();
  for (let i = 0; i < 10 && stray.length; i += 1) { await sleep(500); all = listProfileProcesses(); stray = onProfile(); }
  if (stray.length) killPids(stray.map((p) => p.pid));
  const strayPids = new Set(stray.map((p) => p.pid));
  try { writeStatus(listBrowserGroups({ procs: all.filter((p) => !strayPids.has(p.pid)) })); } catch { /* status line only */ }
  return stray.length;
}

const openSocket = (url) => new Promise((resolve, reject) => {
  const ws = new WebSocket(url);
  ws.onopen = () => resolve(ws);
  ws.onerror = () => reject(new Error('CDP websocket failed'));
});

// { call, evaluate, errors } over one page target's websocket.
async function wireSession(ws) {
  let id = 0;
  const pending = new Map();
  const errors = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(`console.error: ${m.params.args.map((a) => a.value ?? a.description).join(' ')}`);
  };
  const call = (method, params = {}) => new Promise((resolve) => { const i = (id += 1); pending.set(i, resolve); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async (expression) => (await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;
  await call('Runtime.enable');
  await call('Page.enable');
  return { call, evaluate, errors };
}

const withTimeout = (p, ms) => Promise.race([p, new Promise((resolve) => setTimeout(() => resolve(null), ms))]);

// --- shared browser (WEBSCOUT_SHARED_BROWSER=1) ------------------------------------------
// One headless browser for every run on the machine instead of one per launchBrowser() call.
// Each caller gets its own browser context (separate storage, like an incognito window) that is
// disposed on close, or when the caller's socket drops. The browser lives in a Job Object with
// no owner and shuts itself down after WEBSCOUT_SHARED_IDLE_MS (default 5 min) with no real page
// open, or after WEBSCOUT_SHARED_MAX_MS (default 4 h). Windows only; elsewhere, and whenever the
// shared browser cannot be reached, launchBrowser() falls back to a private browser.
export const SHARED_STATE_FILE = () => path.join(os.tmpdir(), 'webscout-shared-browser.json');
async function cdpVersion(port) {
  try { const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) }); return r.ok ? await r.json() : null; } catch { return null; }
}

async function ensureSharedBrowser(browserPath) {
  const lock = `${SHARED_STATE_FILE()}.lock`;
  for (let i = 0; ; i += 1) {
    try { fs.mkdirSync(lock); break; } catch {
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 60000) { fs.rmSync(lock, { recursive: true, force: true }); continue; } } catch { /* raced */ }
      if (i > 300) throw new Error('shared browser lock held for over a minute');
      await sleep(200);
    }
  }
  try {
    const st = readJson(SHARED_STATE_FILE());
    if (st && isPidAlive(st.hostPid)) {
      const version = await cdpVersion(st.port);
      if (version) return { ...st, version };
    }
    sweepQuietly();
    const port = await freePort();
    const profile = createScratchDir('webscout-browser-profile-');
    const args = ['--headless=new', '--disable-gpu', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, ...SLIM_FLAGS, '--window-size=1500,1400', 'about:blank'];
    const job = await spawnInJob(browserPath, args, {
      ownerPid: 0, cpuPct: browserLimits().cpuPct, maxMs: envNum('WEBSCOUT_SHARED_MAX_MS', 4 * 60 * 60 * 1000),
      idlePort: port, idleMs: envNum('WEBSCOUT_SHARED_IDLE_MS', 5 * 60 * 1000), detachHost: true,
    });
    setOwner(profile, job.hostPid); // the sweep reclaims the profile once the host is gone
    let version = null;
    for (let i = 0; i < 75 && !version; i += 1) { version = await cdpVersion(port); if (!version) await sleep(200); }
    if (!version) { killPids([job.hostPid]); throw new Error('shared browser never exposed CDP'); }
    const state = { port, hostPid: job.hostPid, profile, startedAt: new Date().toISOString() };
    fs.writeFileSync(SHARED_STATE_FILE(), JSON.stringify(state));
    browserLedger({ ev: 'launch', mode: 'shared-host', profile: path.basename(profile) });
    return { ...state, version };
  } finally {
    try { fs.rmSync(lock, { recursive: true, force: true }); } catch { /* next caller ages it out */ }
  }
}

async function attachShared(browserPath) {
  const st = await ensureSharedBrowser(browserPath);
  const bws = await openSocket(st.version.webSocketDebuggerUrl);
  let bid = 0;
  const bpending = new Map();
  bws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && bpending.has(m.id)) { bpending.get(m.id)(m); bpending.delete(m.id); } };
  const bcall = (method, params = {}) => withTimeout(new Promise((resolve) => { const i = (bid += 1); bpending.set(i, resolve); bws.send(JSON.stringify({ id: i, method, params })); }), 5000);
  let browserContextId = null;
  try {
    browserContextId = (await bcall('Target.createBrowserContext', { disposeOnDetach: true }))?.result?.browserContextId;
    if (!browserContextId) throw new Error('Target.createBrowserContext failed');
    const targetId = (await bcall('Target.createTarget', { url: 'about:blank', browserContextId, newWindow: true, width: 1500, height: 1400 }))?.result?.targetId;
    if (!targetId) throw new Error('Target.createTarget failed');
    const ws = await openSocket(`ws://127.0.0.1:${st.port}/devtools/page/${targetId}`);
    const session = await wireSession(ws);
    browserLedger({ ev: 'launch', mode: 'shared', profile: path.basename(st.profile) });
    const startedAt = Date.now();
    let closing = null;
    const close = () => {
      closing ??= (async () => {
        try { ws.close(); } catch { /* already closed */ }
        await bcall('Target.disposeBrowserContext', { browserContextId });
        try { bws.close(); } catch { /* already closed */ }
        const stats = { mode: 'shared', ms: Date.now() - startedAt, cpuSeconds: null, leaked: 0 };
        browserLedger({ ev: 'close', ...stats, profile: path.basename(st.profile) });
        return stats;
      })();
      return closing;
    };
    return { ...session, navigate: (url) => session.call('Page.navigate', { url }), close, mode: 'shared', profile: st.profile };
  } catch (err) {
    if (browserContextId) await bcall('Target.disposeBrowserContext', { browserContextId });
    try { bws.close(); } catch { /* already closed */ }
    throw err;
  }
}

// Returns { call, evaluate, navigate, errors, close, mode, profile }. `errors` collects page
// exceptions and console.error calls seen since launch. close() resolves to
// { mode, ms, cpuSeconds, leaked } and is safe to call twice.
//
// Every private browser runs inside a Windows Job Object (win-job.mjs) when one is available:
// every process it spawns dies with the job, the tree runs at BELOW_NORMAL priority with a hard
// CPU cap, and it has a maximum lifetime. A machine-wide slot cap (browser-slots.mjs) limits how
// many run at once. After close, any process still on the profile is killed and fails the run.
export async function launchBrowser(browserPath = findBrowser()) {
  if (!browserPath) throw new Error('no Chromium/Edge binary found (set WEBSCOUT_BROWSER)');
  if (process.env.WEBSCOUT_SHARED_BROWSER === '1' && jobHostPath()) {
    try { return await attachShared(browserPath); } catch (err) { warn(`shared browser unavailable (${err.message}); launching a private one`); }
  }
  sweepQuietly();
  const lowDisk = lowDiskWarning();
  if (lowDisk) process.stderr.write(`webscout: WARNING: ${lowDisk}\n`);
  const releaseSlot = await acquireSlot();
  const cdpPort = await freePort();
  const scratch = ownScratchDir(createScratchDir('webscout-browser-profile-'));
  const profile = scratch.dir;
  const args = ['--headless=new', '--disable-gpu', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, ...SLIM_FLAGS, '--window-size=1500,1400'];
  if (process.platform === 'linux') args.push('--no-sandbox');
  let mode = 'plain';
  let job = null;
  let child = null;
  let childExited = false;
  if (jobHostPath()) {
    try { job = await spawnInJob(browserPath, [...args, 'about:blank'], browserLimits()); mode = 'job'; } catch (err) { warn(`job object unavailable (${err.message}); using a plain spawn`); }
  }
  if (job) {
    scratch.track(job.hostPid); // killing the host closes the job, which kills every browser process
    scratch.guard(job.hostPid);
  } else {
    child = spawn(browserPath, [...args, 'about:blank'], { stdio: 'ignore', windowsHide: true, detached: process.platform !== 'win32' });
    child.once('exit', () => { childExited = true; });
    try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* best effort */ }
    scratch.track(child.pid);
    scratch.guard(child.pid); // browser dies with us even on SIGKILL
  }
  browserLedger({ ev: 'launch', mode, profile: path.basename(profile) });
  const startedAt = Date.now();
  const gone = () => (job ? job.exited() : childExited);
  let ws;
  let closing = null;
  // Ask the browser to quit over CDP, wait up to 8s (a loaded machine at the CPU cap needs more than 3),
  // then kill: the job host (which takes the whole job with it) or the plain child's tree. Then count
  // what is still running on the profile.
  const close = () => {
    closing ??= (async () => {
      try {
        // WEBSCOUT_TEST_HARD_CLOSE=1 (browser-leak.test.mjs only): skip the polite quit, as a crash would.
        if (ws?.readyState === WebSocket.OPEN && process.env.WEBSCOUT_TEST_HARD_CLOSE !== '1') {
          ws.send(JSON.stringify({ id: 999999, method: 'Browser.close' }));
          for (let i = 0; i < 80 && !gone(); i += 1) await sleep(100);
        }
      } catch { /* fall through to the kill */ }
      try { ws?.close(); } catch { /* already closed */ }
      const report = job && gone() ? job.report() : null;
      if (job && !gone()) killPids([job.hostPid]);
      else if (child && !childExited) killTree(child.pid);
      if (job) for (let i = 0; i < 20 && !gone(); i += 1) await sleep(50);
      const leaked = await reapProfile(profile);
      scratch.dispose();
      releaseSlot();
      const stats = { mode, ms: Date.now() - startedAt, cpuSeconds: report?.cpuSeconds ?? null, exit: report?.reason ?? (job ? 'killed' : 'plain'), leaked };
      browserLedger({ ev: 'close', ...stats, profile: path.basename(profile) });
      if (leaked) {
        browserLedger({ ev: 'leak', mode, leaked, profile: path.basename(profile) });
        warn(`LEAK - ${leaked} headless browser process(es) were still running after close() on ${path.basename(profile)} (mode ${mode}); killed them now. This is what pinned the CPU on 2026-10-08: fix the harness, do not ignore it.${process.env.WEBSCOUT_LEAK_OK === '1' ? '' : ' Failing this run (WEBSCOUT_LEAK_OK=1 to only warn).'}`);
        failRunOnLeak();
      }
      return stats;
    })();
    return closing;
  };
  try {
    let targets = [];
    for (let i = 0; i < 75 && !targets.length; i += 1) {
      try { targets = (await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json()).filter((t) => t.type === 'page'); } catch { /* not up yet */ }
      if (!targets.length) await sleep(200);
    }
    if (!targets.length) throw new Error('browser never exposed a CDP page target');
    ws = await openSocket(targets[0].webSocketDebuggerUrl);
    const session = await wireSession(ws);
    return { ...session, navigate: (url) => session.call('Page.navigate', { url }), close, mode, profile };
  } catch (err) {
    await close();
    throw err;
  }
}

// Merges the activation query params onto whatever query string `target` already has, never
// clobbering it - "crv launch" against a URL that already carries its own params (e.g. a hash
// route, or an app-specific query flag) must not silently drop them. Exported (pure, no
// process spawn) so its merge behavior is unit-testable without a real browser.
export function buildLaunchUrl(target, agentName, relayPort) {
  const url = new URL(target);
  url.searchParams.set('webscout', '1');
  url.searchParams.set('webscout_name', agentName);
  // inject.js defaults to port 8973 when webscout_port is absent (see its own comment) - always
  // stamping the CLI's actual configured port here (not only when it differs from the default)
  // means the launched tab connects to the SAME relay this CLI is talking to, not silently the
  // default one, whenever a caller runs a non-default relay (confirmed needed: an ephemeral test
  // relay is never on 8973, and this is exactly how such a mismatch would go unnoticed).
  if (relayPort !== undefined && relayPort !== null) url.searchParams.set('webscout_port', String(relayPort));
  return url;
}

// Launches a REAL tab navigated directly to `url`, for the CLI's "crv launch" - unlike
// launchBrowser() above (CDP-attached, throwaway profile, auto-closed at test teardown), this
// tab is meant to stay open for the rest of an operator's CRV session: no CDP attached (the
// caller confirms the agent connected by polling the relay, not by evaluating page JS), and
// the profile persists across relaunches, keyed by the URL's own port, so repeating "crv
// launch" against the same throwaway static server reuses the same tab identity instead of
// starting from a blank profile every time. Nothing here closes it - the operator (or the OS)
// closes the window when the CRV pass is done.
//
// A HEADLESS tab has no window anyone can close, so nobody ever did: crv-launch.test.mjs left one
// running after every suite run (9 processes, still burning CPU). On Windows a headless tab now
// runs in its own Job Object with no owner and a hard lifetime (WEBSCOUT_CRV_HEADLESS_MAX_MS,
// default 2 h), at below-normal priority with the same CPU cap as every headless browser.
export async function launchTab(url, { headless = false } = {}) {
  const browserPath = findBrowser();
  if (!browserPath) throw new Error('no Chromium/Edge binary found (set WEBSCOUT_BROWSER)');
  let port = '0';
  try { port = new URL(url).port || '0'; } catch { /* keep '0' - still a valid, if shared, profile key */ }
  const profile = path.join(os.tmpdir(), `webscout-crv-tab-profile-${port}`);
  fs.mkdirSync(profile, { recursive: true });
  const args = ['--no-first-run', `--user-data-dir=${profile}`];
  if (headless) args.push('--headless=new', '--disable-gpu');
  if (headless && jobHostPath()) {
    const maxLifetimeMs = envNum('WEBSCOUT_CRV_HEADLESS_MAX_MS', 2 * 60 * 60 * 1000);
    try {
      const job = await spawnInJob(browserPath, [...args, url], { ownerPid: 0, cpuPct: browserLimits().cpuPct, maxMs: maxLifetimeMs, detachHost: true });
      return { pid: job.pid, hostPid: job.hostPid, profile, browserPath, maxLifetimeMs };
    } catch (err) { warn(`job object unavailable for the headless tab (${err.message}); it will run until killed`); }
  }
  const child = spawn(browserPath, [...args, url], { stdio: 'ignore', detached: true, windowsHide: true });
  child.unref();
  return { pid: child.pid, profile, browserPath };
}
