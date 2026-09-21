// Headless Chromium/Edge over CDP for the tests that need a real page. Tests
// skip themselves when findBrowser() returns null, like the connected-tab tests.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { freePort } from './test-relay.mjs';
import { createScratchDir, ownScratchDir, sweepStale } from './scratch.mjs';
import { lowDiskWarning } from './host-health.mjs';

// Cuts the profile's disk footprint (~460 MB of caches/component data per run before).
export const SLIM_FLAGS = [
  '--no-first-run', '--disk-cache-size=1', '--media-cache-size=1', '--disable-background-networking',
  '--disable-component-update', '--disable-extensions', '--disable-sync', '--disable-default-apps',
  '--no-default-browser-check', '--disable-breakpad',
];

// Reclaim profiles/browsers orphaned by earlier crashed runs. Never lets a sweep failure block a launch.
function sweepQuietly() {
  if (process.env.WEBSCOUT_NO_SWEEP === '1' || process.env.NODE_ENV === 'test') return; // opt-outs; tests get a private root instead
  try { sweepStale({ markerOnly: true }); } catch { /* best effort */ }
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

// Returns { call, evaluate, navigate, errors, close }. `errors` collects page
// exceptions and console.error calls seen since launch.
export async function launchBrowser(browserPath = findBrowser()) {
  if (!browserPath) throw new Error('no Chromium/Edge binary found (set WEBSCOUT_BROWSER)');
  sweepQuietly();
  const lowDisk = lowDiskWarning();
  if (lowDisk) process.stderr.write(`webscout: WARNING: ${lowDisk}\n`);
  const cdpPort = await freePort();
  const scratch = ownScratchDir(createScratchDir('webscout-browser-profile-'));
  const profile = scratch.dir;
  const args = ['--headless=new', '--disable-gpu', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, ...SLIM_FLAGS, '--window-size=1500,1400'];
  if (process.platform === 'linux') args.push('--no-sandbox');
  const child = spawn(browserPath, [...args, 'about:blank'], { stdio: 'ignore', windowsHide: true, detached: process.platform !== 'win32' });
  scratch.track(child.pid);
  scratch.guard(child.pid); // browser dies with us even on SIGKILL
  let ws;
  // Idempotent. Tree-kill first (the browser holds locks on the profile), then delete with retries.
  const close = async () => {
    try { ws?.close(); } catch { /* already closed */ }
    scratch.dispose();
  };
  try {
    let targets = [];
    for (let i = 0; i < 75 && !targets.length; i += 1) {
      try { targets = (await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json()).filter((t) => t.type === 'page'); } catch { /* not up yet */ }
      if (!targets.length) await sleep(200);
    }
    if (!targets.length) throw new Error('browser never exposed a CDP page target');
    ws = new WebSocket(targets[0].webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('CDP websocket failed')); });
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
    return { call, evaluate, errors, navigate: (url) => call('Page.navigate', { url }), close };
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
export function launchTab(url, { headless = false } = {}) {
  const browserPath = findBrowser();
  if (!browserPath) throw new Error('no Chromium/Edge binary found (set WEBSCOUT_BROWSER)');
  let port = '0';
  try { port = new URL(url).port || '0'; } catch { /* keep '0' - still a valid, if shared, profile key */ }
  const profile = path.join(os.tmpdir(), `webscout-crv-tab-profile-${port}`);
  fs.mkdirSync(profile, { recursive: true });
  const args = ['--no-first-run', `--user-data-dir=${profile}`];
  if (headless) args.push('--headless=new', '--disable-gpu');
  const child = spawn(browserPath, [...args, url], { stdio: 'ignore', detached: true, windowsHide: true });
  child.unref();
  return { pid: child.pid, profile, browserPath };
}
