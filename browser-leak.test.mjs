// Headless browser lifecycle: nothing may outlive a run. On 2026-10-08, 68 orphaned headless
// msedge.exe processes (about 10 per e2e run) pinned the CPU for hours: the msedge.exe a run
// spawns is a trampoline that exits at once, so killing its pid or tree never reached the real
// browser. These tests hold the fix: a Job Object owns every browser process (win-job.mjs), close()
// counts and fails on anything left (the leak gate), an owner killed with no chance to clean up
// still takes its browser with it, and the slot cap / reaper / ledger logic behave.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { browserSkip, launchBrowser } from './browser-harness.mjs';
import { groupBrowsers, summarizeBrowserLedger, listProfileProcesses, profileOf } from './browser-reaper.mjs';
import { acquireSlot } from './browser-slots.mjs';
import { quoteWinArg, jobHostPath } from './win-job.mjs';
import { tmpDir } from './scratch.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const skip = browserSkip();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const onProfile = (profile) => listProfileProcesses().filter((p) => { const d = profileOf(p.commandLine); return d && path.resolve(d).toLowerCase() === path.resolve(profile).toLowerCase(); });

test('groupBrowsers: an orphan is a headless run whose owner is gone; CRV tabs and young unmarked runs never are', () => {
  const now = Date.parse('2026-10-08T12:00:00Z');
  const tmp = os.tmpdir();
  const p = (pid, ppid, profile, extra = '', created = '2026-10-08T11:59:00Z', cpuSeconds = 1) => ({ pid, ppid, commandLine: `msedge.exe --headless=new --user-data-dir=${path.join(tmp, profile)} ${extra}`, cpuSeconds, createdAt: created });
  const markers = { 'webscout-browser-profile-live': { pid: 100 }, 'webscout-browser-profile-dead': { pid: 200 } };
  const deps = { readMarker: (d) => markers[path.basename(d)] ?? null, isAlive: (pid) => pid === 100 || pid === 1, exists: () => true };
  const groups = groupBrowsers([
    p(11, 99999, 'webscout-browser-profile-live'), p(12, 11, 'webscout-browser-profile-live', '--type=renderer'),
    p(21, 99999, 'webscout-browser-profile-dead', '', '2026-10-08T11:00:00Z', 500), p(22, 21, 'webscout-browser-profile-dead', '--type=gpu-process', '2026-10-08T11:00:00Z', 260),
    p(31, 99999, 'webscout-browser-profile-young'),
    p(41, 99999, 'webscout-browser-profile-oldunmarked', '', '2026-10-08T10:00:00Z'),
    p(51, 1, 'webscout-crv-tab-profile-9137'),
    { pid: 61, ppid: 1, commandLine: 'msedge.exe --user-data-dir=C:/Users/me/AppData/Local/Microsoft/Edge/User Data', cpuSeconds: 9, createdAt: '2026-10-08T11:00:00Z' },
  ], deps, { now });
  const by = Object.fromEntries(groups.map((g) => [path.basename(g.profile), g]));
  assert.equal(by['webscout-browser-profile-live'].orphan, false);
  assert.equal(by['webscout-browser-profile-live'].processes, 2);
  assert.equal(by['webscout-browser-profile-dead'].orphan, true);
  assert.equal(by['webscout-browser-profile-dead'].cpuSeconds, 760);
  assert.equal(by['webscout-browser-profile-dead'].ageSeconds, 3600);
  assert.equal(by['webscout-browser-profile-young'].orphan, false, 'an unmarked group under 10 minutes old may still be a live run');
  assert.equal(by['webscout-browser-profile-oldunmarked'].orphan, true);
  assert.equal(by['webscout-crv-tab-profile-9137'].orphan, false);
  assert.equal(groups.length, 5, "the user's own Edge profile is never listed");
  assert.equal(groups[0].profile.endsWith('webscout-browser-profile-dead'), true, 'sorted by CPU, worst first');
});

test('summarizeBrowserLedger: leaks, reaped processes and CPU over the window', () => {
  const now = Date.parse('2026-10-08T12:00:00Z');
  const at = (h) => new Date(now - h * 3600000).toISOString();
  const s = summarizeBrowserLedger([
    { at: at(30), ev: 'leak', leaked: 99, script: 'old.mjs' },
    { at: at(2), ev: 'launch', mode: 'job', script: 'a.e2e.mjs' },
    { at: at(2), ev: 'close', mode: 'job', cpuSeconds: 20.4, leaked: 0, script: 'a.e2e.mjs' },
    { at: at(1), ev: 'launch', mode: 'plain', script: 'b.e2e.mjs' },
    { at: at(1), ev: 'close', mode: 'plain', cpuSeconds: null, leaked: 10, script: 'b.e2e.mjs' },
    { at: at(1), ev: 'leak', mode: 'plain', leaked: 10, script: 'b.e2e.mjs', profile: 'p' },
    { at: at(0.5), ev: 'reap', processes: 7 },
  ], { now });
  assert.equal(s.launches, 2);
  assert.equal(s.closes, 2);
  assert.equal(s.jobContained, 1);
  assert.equal(s.leaks, 1);
  assert.equal(s.leakedProcesses, 10, 'the 30h-old leak is outside the 24h window');
  assert.equal(s.reapedProcesses, 7);
  assert.equal(s.cpuSeconds, 20);
  assert.equal(s.recentLeaks[0].script, 'b.e2e.mjs');
});

test('quoteWinArg: survives CommandLineToArgvW for spaces, quotes and trailing backslashes', () => {
  assert.equal(quoteWinArg('--headless=new'), '--headless=new');
  assert.equal(quoteWinArg('--user-data-dir=C:\\Temp Dir\\p'), '"--user-data-dir=C:\\Temp Dir\\p"');
  assert.equal(quoteWinArg('C:\\a b\\'), '"C:\\a b\\\\"');
  assert.equal(quoteWinArg('say "hi"'), '"say \\"hi\\""');
  assert.equal(quoteWinArg(''), '""');
});

test('acquireSlot: waits while the cap is full, takes a slot whose owner died', async () => {
  const slots = tmpDir('webscout-slots-test-');
  const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  try {
    fs.writeFileSync(path.join(slots, 'slot-0.json'), JSON.stringify({ pid: holder.pid, at: new Date().toISOString() }));
    const logs = [];
    await assert.rejects(acquireSlot({ dir: slots, cap: 1, waitMs: 400, log: (m) => logs.push(m) }), /no headless browser slot freed up/);
    assert.match(logs[0], /busy/);
    holder.kill();
    await new Promise((r) => holder.once('exit', r));
    const release = await acquireSlot({ dir: slots, cap: 1, waitMs: 2000, log: () => {} });
    assert.equal(JSON.parse(fs.readFileSync(path.join(slots, 'slot-0.json'), 'utf8')).pid, process.pid);
    const again = await acquireSlot({ dir: slots, cap: 1, waitMs: 400, log: () => {} }); // re-entrant: same process
    again();
    assert.ok(fs.existsSync(path.join(slots, 'slot-0.json')), 'still held by the first acquisition');
    release();
    assert.ok(!fs.existsSync(path.join(slots, 'slot-0.json')));
  } finally {
    try { holder.kill(); } catch { /* gone */ }
    fs.rmSync(slots, { recursive: true, force: true });
  }
});

test('launchBrowser + close leaves no browser process and no profile behind', { skip }, async () => {
  const b = await launchBrowser();
  const profile = b.profile;
  try {
    assert.equal(await b.evaluate('1 + 1'), 2);
    const running = onProfile(profile);
    assert.ok(running.length >= 2, `expected the browser's processes on its profile, saw ${running.length}`);
    if (process.platform === 'win32' && jobHostPath()) {
      assert.equal(b.mode, 'job');
      const pr = spawnSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${running.map((p) => p.pid).join(',')} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty PriorityClass | Sort-Object -Unique) -join ','`], { encoding: 'utf8', windowsHide: true });
      assert.equal(pr.stdout.trim(), 'BelowNormal', 'every process in the job runs below normal priority');
    }
  } finally {
    const stats = await b.close();
    assert.equal(stats.leaked, 0);
    // 'killed' = the polite quit took over 8s (a loaded machine) and the job ended it - still nothing left.
    if (stats.mode === 'job') assert.ok(['browser-exited', 'killed'].includes(stats.exit), stats.exit);
  }
  assert.equal(onProfile(profile).length, 0);
  assert.equal(fs.existsSync(profile), false);
});

// Runs a child that launches, skips the polite Browser.close, closes, then exits 0 on purpose.
function hardCloseRun(env) {
  const harness = pathToFileURL(path.join(dir, 'browser-harness.mjs')).href;
  const script = `const { launchBrowser } = await import(${JSON.stringify(harness)}); const b = await launchBrowser(); await b.evaluate('1'); const s = await b.close(); console.log(JSON.stringify(s)); process.exit(0);`;
  const root = tmpDir('webscout-leak-test-'); // private ledger: the intended leak must not reach real analytics
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: { ...process.env, WEBSCOUT_TMPDIR: root, WEBSCOUT_MAX_BROWSERS: '0', WEBSCOUT_TEST_HARD_CLOSE: '1', WEBSCOUT_LEAK_OK: '', ...env }, timeout: 90000 });
  fs.rmSync(root, { recursive: true, force: true });
  return { status: r.status, stats: JSON.parse(r.stdout.trim().split('\n').at(-1) || '{}'), stderr: r.stderr };
}

test('leak gate: a plain spawn whose browser outlives close() fails the run even after process.exit(0)', { skip: skip || process.platform !== 'win32' }, () => {
  const r = hardCloseRun({ WEBSCOUT_NO_JOB: '1' });
  assert.equal(r.stats.mode, 'plain');
  assert.ok(r.stats.leaked > 0, 'the trampoline exits at once, so killing its tree misses the real browser');
  assert.match(r.stderr, /LEAK - \d+ headless browser process/);
  assert.equal(r.status, 1);
});

test('the job contains a browser that never got the polite quit: nothing leaks, run passes', { skip: skip || process.platform !== 'win32' || !jobHostPath() }, () => {
  const r = hardCloseRun({});
  assert.equal(r.stats.mode, 'job');
  assert.equal(r.stats.leaked, 0);
  assert.equal(r.status, 0, r.stderr);
});

test('an owner killed without cleanup still takes its browser with it', { skip }, async () => {
  const harness = pathToFileURL(path.join(dir, 'browser-harness.mjs')).href;
  const script = `const { launchBrowser } = await import(${JSON.stringify(harness)}); const b = await launchBrowser(); console.log(b.profile); setInterval(() => {}, 1000);`;
  // No slot cap in the child: under a full suite it would queue behind other files' browsers and time out.
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, WEBSCOUT_MAX_BROWSERS: '0' } });
  const profile = await new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (d) => { out += d; const line = out.split('\n')[0].trim(); if (out.includes('\n')) resolve(line); });
    child.once('exit', () => reject(new Error('child exited before launching')));
    setTimeout(() => reject(new Error('child never launched a browser')), 30000);
  });
  assert.ok(onProfile(profile).length >= 2);
  if (process.platform === 'win32') spawnSync('taskkill', ['/F', '/PID', String(child.pid)], { stdio: 'ignore' }); // no exit hook can run
  else child.kill('SIGKILL');
  let left = -1;
  for (let i = 0; i < 20 && left !== 0; i += 1) { await sleep(500); left = onProfile(profile).length; }
  assert.equal(left, 0, 'browser processes outlived their killed owner');
});
