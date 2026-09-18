// Headless Chromium/Edge over CDP for the tests that need a real page. Tests
// skip themselves when findBrowser() returns null, like the connected-tab tests.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { freePort } from './test-relay.mjs';

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
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'webscout-browser-profile-'));
  const cdpPort = await freePort();
  const args = ['--headless=new', '--disable-gpu', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, '--no-first-run', '--window-size=1500,1400'];
  if (process.platform === 'linux') args.push('--no-sandbox');
  const child = spawn(browserPath, [...args, 'about:blank'], { stdio: 'ignore', windowsHide: true });
  let ws;
  const close = async () => {
    try { ws?.close(); } catch { /* already closed */ }
    try { child.kill(); } catch { /* already gone */ }
    await sleep(300); // the browser holds the profile dir open for a moment after kill
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* temp dir */ }
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
