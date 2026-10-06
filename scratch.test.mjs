// Scratch-dir lifecycle: removal on normal exit / exception / hard kill, the stale sweep,
// and the prefix + live-owner guards. Every dir here lives under its own private base dir
// (never the real %TEMP% contents) and is removed by the test.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createScratchDir, ownScratchDir, withScratchDir, sweepStale, sweepFixtures, scratchStats, readMarker, isPidAlive, MARKER, HARNESS_VERSION } from './scratch.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'webscout-scratchtest-base-'));
const PFX = 'webscout-browser-profile-';
after(() => { fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });

const deadPid = () => { let p = 4000000; while (isPidAlive(p)) p += 1; return p; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('dir is removed after normal exit', async () => {
  let seen;
  await withScratchDir(PFX, async (dir) => { seen = dir; fs.writeFileSync(path.join(dir, 'f'), 'x'); assert.ok(fs.existsSync(path.join(dir, MARKER))); }, { baseDir: base });
  assert.equal(fs.existsSync(seen), false);
});

test('dir is removed after an exception', async () => {
  let seen;
  await assert.rejects(withScratchDir(PFX, async (dir) => { seen = dir; throw new Error('boom'); }, { baseDir: base }), /boom/);
  assert.equal(fs.existsSync(seen), false);
});

test('dispose is idempotent and never throws on a missing dir', () => {
  const h = ownScratchDir(createScratchDir(PFX, { baseDir: base }));
  h.dispose();
  assert.doesNotThrow(() => h.dispose());
});

test('hard-killed owner: sweep removes its dir and kills the orphan process naming it', async () => {
  const dir = createScratchDir(PFX, { baseDir: base, ownerPid: 1 });
  // Owner script: registers the dir, spawns a stand-in "browser" (node) whose command line
  // carries --user-data-dir=<dir>, prints its pid, then idles until SIGKILLed.
  const ownerSrc = "const { spawn } = require('node:child_process'); const dir = process.argv[1];"
    + " const b = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)', '--', '--user-data-dir=' + dir], { stdio: 'ignore', windowsHide: true, detached: true }); b.unref();"
    + " console.log(b.pid); setInterval(()=>{},1000);";
  const owner = spawn(process.execPath, ['-e', ownerSrc, dir], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  const browserPid = Number(await new Promise((resolve) => owner.stdout.once('data', (d) => resolve(String(d).trim()))));
  fs.writeFileSync(path.join(dir, MARKER), JSON.stringify({ pid: owner.pid, createdAt: Date.now() }));
  assert.ok(isPidAlive(browserPid));
  owner.kill('SIGKILL'); // no exit handlers run
  for (let i = 0; i < 50 && isPidAlive(owner.pid); i += 1) await sleep(50);
  const r = sweepStale({ baseDir: base, prefixes: [PFX], browserNames: ['node.exe', 'node'] });
  assert.ok(r.removed.some((x) => x.dir === dir), 'dir swept');
  assert.ok(r.killedProcesses.includes(browserPid), 'orphan killed');
  for (let i = 0; i < 50 && isPidAlive(browserPid); i += 1) await sleep(100);
  assert.equal(isPidAlive(browserPid), false);
  assert.equal(fs.existsSync(dir), false);
});

test('sweep removes a dead-PID dir and leaves a live-PID dir', () => {
  const dead = createScratchDir(PFX, { baseDir: base, ownerPid: deadPid() });
  const live = createScratchDir(PFX, { baseDir: base, ownerPid: process.pid });
  const r = sweepStale({ baseDir: base, prefixes: [PFX] });
  assert.equal(fs.existsSync(dead), false);
  assert.equal(fs.existsSync(live), true);
  assert.ok(r.skippedLive >= 1);
  fs.rmSync(live, { recursive: true, force: true });
});

test('dry run touches nothing but reports what it would free', () => {
  const dead = createScratchDir(PFX, { baseDir: base, ownerPid: deadPid() });
  fs.writeFileSync(path.join(dead, 'blob'), Buffer.alloc(4096));
  const r = sweepStale({ baseDir: base, prefixes: [PFX], dryRun: true });
  assert.equal(fs.existsSync(dead), true);
  assert.ok(r.removed.some((x) => x.dir === dead && x.bytes >= 4096));
  fs.rmSync(dead, { recursive: true, force: true });
});

test('sweep ignores dirs without our prefix, plain files, and symlinks', () => {
  const foreign = fs.mkdtempSync(path.join(base, 'other-app-'));
  fs.writeFileSync(path.join(foreign, MARKER), JSON.stringify({ pid: deadPid(), createdAt: Date.now() }));
  const file = path.join(base, `${PFX}iamafile`);
  fs.writeFileSync(file, 'x');
  const target = fs.mkdtempSync(path.join(base, 'link-target-'));
  fs.writeFileSync(path.join(target, 'keep'), 'x');
  const link = path.join(base, `${PFX}link`);
  try { fs.symlinkSync(target, link, 'junction'); } catch { /* cannot link here: skip that assertion */ }
  sweepStale({ baseDir: base, prefixes: [PFX], now: Date.now() + 10 * 24 * 3600 * 1000 });
  assert.equal(fs.existsSync(foreign), true);
  assert.equal(fs.existsSync(file), true);
  assert.equal(fs.existsSync(path.join(target, 'keep')), true, 'never followed the link');
  for (const p of [foreign, file, link, target]) fs.rmSync(p, { recursive: true, force: true });
});

test('unmarked dir is only swept once older than 24h', () => {
  const d = fs.mkdtempSync(path.join(base, PFX));
  sweepStale({ baseDir: base, prefixes: [PFX] });
  assert.equal(fs.existsSync(d), true);
  sweepStale({ baseDir: base, prefixes: [PFX], now: Date.now() + 25 * 3600 * 1000 });
  assert.equal(fs.existsSync(d), false);
});

test('wl-* dirs are swept only with includeForeign', () => {
  const d = fs.mkdtempSync(path.join(base, 'wl-browser-'));
  fs.writeFileSync(path.join(d, MARKER), JSON.stringify({ pid: deadPid(), createdAt: Date.now() }));
  sweepStale({ baseDir: base });
  assert.equal(fs.existsSync(d), true);
  sweepStale({ baseDir: base, includeForeign: true });
  assert.equal(fs.existsSync(d), false);
});

test('CLI scratch cleanup --dry-run runs and prints a summary', () => {
  // scans the real %TEMP% read-only (--dry-run); never deletes
  const r = spawn(process.execPath, [path.join(here, 'cli.mjs'), 'scratch', 'cleanup', '--dry-run'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = '';
  r.stdout.on('data', (d) => { out += d; });
  return new Promise((resolve, reject) => r.on('close', (code) => {
    try { assert.equal(code, 0); assert.match(out, /would remove \d+ dir/); resolve(); } catch (e) { reject(e); }
  }));
});

test('markerOnly sweep reclaims marked dead dirs but never touches unmarked legacy dirs', () => {
  const marked = createScratchDir(PFX, { baseDir: base, ownerPid: deadPid() });
  const legacy = fs.mkdtempSync(path.join(base, PFX));
  sweepStale({ baseDir: base, prefixes: [PFX], markerOnly: true, now: Date.now() + 10 * 24 * 3600 * 1000 });
  assert.equal(fs.existsSync(marked), false);
  assert.equal(fs.existsSync(legacy), true, 'unmarked dir needs an explicit cleanup');
  fs.rmSync(legacy, { recursive: true, force: true });
});

test('scratchStats counts our dirs and the reclaimable ones', () => {
  const dead = createScratchDir(PFX, { baseDir: base, ownerPid: deadPid() });
  const live = createScratchDir(PFX, { baseDir: base, ownerPid: process.pid });
  const st = scratchStats({ baseDir: base, sizes: true });
  assert.equal(st.dirs, 2);
  assert.equal(st.stale, 1);
  assert.ok(st.staleBytes > 0);
  for (const d of [dead, live]) fs.rmSync(d, { recursive: true, force: true });
});

test('guardian kills the browser and removes the profile after the owner is SIGKILLed', async () => {
  const dir = createScratchDir(PFX, { baseDir: base });
  const src = `
    import { spawn } from 'node:child_process';
    import { ownScratchDir } from ${JSON.stringify(new URL('./scratch.mjs', import.meta.url).href)};
    const h = ownScratchDir(process.argv[1]);
    const b = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true, detached: true });
    b.unref(); h.track(b.pid); h.guard(b.pid);
    console.log(b.pid); setInterval(()=>{},1000);`;
  const owner = spawn(process.execPath, ['--input-type=module', '-e', src, dir], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  const browserPid = Number(await new Promise((resolve) => owner.stdout.once('data', (d) => resolve(String(d).trim()))));
  assert.ok(isPidAlive(browserPid));
  await sleep(700); // let the guardian start watching
  owner.kill('SIGKILL');
  for (let i = 0; i < 60 && (isPidAlive(browserPid) || fs.existsSync(dir)); i += 1) await sleep(200);
  assert.equal(isPidAlive(browserPid), false, 'browser killed');
  assert.equal(fs.existsSync(dir), false, 'profile removed');
});

test('lint: no bare mkdtemp under the temp dir outside scratch helpers (route through tmpDir/withScratchDir)', () => {
  const allowed = new Set(['scratch.mjs', 'scratch.test.mjs', 'scratch-guard.mjs', 'run-tests.mjs']);
  const bad = fs.readdirSync(here).filter((f) => f.endsWith('.mjs') && !allowed.has(f))
    .filter((f) => /mkdtempSync\(\s*path\.join\(os\.tmpdir\(\)/.test(fs.readFileSync(path.join(here, f), 'utf8')));
  assert.deepEqual(bad, []);
});

test('CLI cleanup above 200 dirs needs --confirm (deletes nothing without it)', async () => {
  const root = fs.mkdtempSync(path.join(base, 'confirm-root-'));
  const dead = deadPid();
  for (let i = 0; i < 205; i += 1) createScratchDir(PFX, { baseDir: root, ownerPid: dead });
  const run = (...args) => new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(here, 'cli.mjs'), 'scratch', 'cleanup', ...args], { stdio: 'ignore', windowsHide: true, env: { ...process.env, WEBSCOUT_TMPDIR: root } });
    c.on('close', resolve);
  });
  assert.equal(await run(), 1);
  assert.equal(fs.readdirSync(root).length, 205);
  assert.equal(await run('--confirm'), 0);
  assert.equal(fs.readdirSync(root).length, 0);
});

test('marker names the harness version and the copy that made the dir', () => {
  const d = createScratchDir(PFX, { baseDir: base });
  const m = JSON.parse(fs.readFileSync(path.join(d, MARKER), 'utf8'));
  assert.equal(m.harness, HARNESS_VERSION);
  assert.equal(m.source, here);
  assert.ok(readMarker(d));
});

test('scratchStats counts unmarked (older-harness) dirs as legacy', () => {
  const root = fs.mkdtempSync(path.join(base, 'legacy-root-'));
  createScratchDir(PFX, { baseDir: root });
  fs.mkdirSync(path.join(root, PFX + 'old'));
  const st = scratchStats({ baseDir: root });
  assert.equal(st.dirs, 2);
  assert.equal(st.legacy, 1);
});

test('sweepStale counts the unmarked dirs it reclaims', () => {
  const root = fs.mkdtempSync(path.join(base, 'unmarked-root-'));
  fs.mkdirSync(path.join(root, PFX + 'old'));
  const r = sweepStale({ baseDir: root, prefixes: [PFX], staleUnownedMs: 0, now: Date.now() + 1000, browserNames: ['node.exe', 'node'] });
  assert.equal(r.removed.length, 1);
  assert.equal(r.unmarked, 1);
});

test('sweepFixtures removes only old fixture dirs, test dbs and logs; keeps new ones, live-relay logs and foreign names', () => {
  const root = fs.mkdtempSync(path.join(base, 'fixture-root-'));
  const old = Date.now() - 3 * 24 * 3600 * 1000;
  const make = (name, { dir = false, age = old } = {}) => {
    const p = path.join(root, name);
    if (dir) { fs.mkdirSync(p); fs.writeFileSync(path.join(p, 'f'), 'x'); } else fs.writeFileSync(p, 'x');
    fs.utimesSync(p, new Date(age), new Date(age));
    return p;
  };
  const oldDir = make('webscout-friction-awareness-aaaaaa', { dir: true });
  const oldDb = make('webscout-test-123-456.db');
  const oldWal = make('webscout-test-123-456.db-wal');
  const oldLog = make('webscout-serve-9111.log');
  const deadRelayLog = make('webscout-relay-9001.log');
  const liveRelayLog = make('webscout-relay-9002.log');
  fs.writeFileSync(path.join(root, 'webscout-relay-9002.pid'), JSON.stringify({ pid: process.pid, port: 9002 }));
  const newDir = make('webscout-events-bbbbbb', { dir: true, age: Date.now() });
  const foreign = make('other-app-cccccc', { dir: true });
  const ledger = make('webscout-scratch-ledger.jsonl');
  const profile = make(PFX + 'dddddd', { dir: true }); // profiles belong to sweepStale, never to the fixture sweep
  const dry = sweepFixtures({ baseDir: root, dryRun: true });
  assert.equal(dry.removed, 5);
  assert.ok(fs.existsSync(oldDir), 'dry run deletes nothing');
  const r = sweepFixtures({ baseDir: root });
  assert.equal(r.removed, 5);
  for (const gone of [oldDir, oldDb, oldWal, oldLog, deadRelayLog]) assert.equal(fs.existsSync(gone), false, gone);
  for (const kept of [liveRelayLog, newDir, foreign, ledger, profile, path.join(root, 'webscout-relay-9002.pid')]) assert.equal(fs.existsSync(kept), true, kept);
});
