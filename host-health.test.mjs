// Host-health feed behind the dashboard's resource panels: thresholds, orphan-browser detection (only
// browsers naming OUR profile dirs), trend/ledger/footprint readers, cleanup guards, and the /host/* routes.
// See CONTRIBUTING.md: the top-level await must stay above every test() call.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpDir, createScratchDir, ownScratchDir, isPidAlive, LEDGER_NAME } from './scratch.mjs';
import {
  level, findOrphanBrowsers, readFootprint, readTrend, sessionScratchCost, cleanupScratch, lowDiskWarning,
  hostFrictionItems, FOOTPRINT_NAME, SAMPLES_NAME,
} from './host-health.mjs';
import { startTestRelay } from './test-relay.mjs';

const PFX = 'webscout-browser-profile-';
const root = tmpDir('webscout-hosthealth-');
const testRunPath = path.join(root, 'last-run.json');
const relay = await startTestRelay({ env: { WEBSCOUT_TMPDIR: root, WEBSCOUT_TESTRUN_FILE: testRunPath } });
const BASE = `http://127.0.0.1:${relay.port}`;
const skipLive = relay.live ? 'skipped under WEBSCOUT_TEST_LIVE=1 (the live relay reads its own temp root)' : false;
process.env.WEBSCOUT_TMPDIR = root; // in-process readers/cleanup use the same private root as the relay

const api = async (method, route, body) => {
  const res = await fetch(`${BASE}${route}`, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json();
  if (!json.ok) throw Object.assign(new Error(json.error), { status: res.status });
  return json.result;
};
const deadPid = () => { const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }); return Number(r.stdout); };
const jsonl = (name, rows) => fs.writeFileSync(path.join(root, name), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
after(async () => { delete process.env.WEBSCOUT_TMPDIR; await relay.stop(); });

test('level: higher is worse for counts, lower is worse for free disk, null is unknown', () => {
  assert.equal(level('dirs', 5), 'ok');
  assert.equal(level('dirs', 20), 'warn');
  assert.equal(level('dirs', 100), 'crit');
  assert.equal(level('freeGb', 50), 'ok');
  assert.equal(level('freeGb', 5), 'warn');
  assert.equal(level('freeGb', 1), 'crit');
  assert.equal(level('freeGb', null), 'unknown');
  assert.equal(level('orphans', 0), 'ok');
  assert.equal(level('orphans', 1), 'warn');
});

test('findOrphanBrowsers lists only root browsers naming one of OUR profile dirs whose owner/parent is dead', () => {
  const dead = deadPid();
  const deadOwned = createScratchDir(PFX, { baseDir: root, ownerPid: dead });
  const liveOwned = createScratchDir(PFX, { baseDir: root, ownerPid: process.pid });
  const cmd = (dir, extra = '') => `"msedge.exe" --headless=new --user-data-dir=${dir} ${extra}`;
  const procs = [
    { pid: 101, ppid: process.pid, commandLine: cmd(deadOwned) },                       // parent alive, owner dead -> orphan
    { pid: 102, ppid: dead, commandLine: cmd(liveOwned) },                              // parent dead -> orphan
    { pid: 103, ppid: process.pid, commandLine: cmd(liveOwned) },                       // healthy
    { pid: 104, ppid: dead, commandLine: cmd(deadOwned, '--type=renderer') },           // child process, skipped
    { pid: 105, ppid: dead, commandLine: '"msedge.exe" --user-data-dir=C:\\Users\\me\\AppData\\Local\\Microsoft\\Edge\\User Data' }, // the user's own browser
    { pid: 106, ppid: dead, commandLine: cmd(path.join(root, 'not-ours-profile')) },    // right root, wrong prefix
  ];
  const found = findOrphanBrowsers(procs, { baseDir: root });
  assert.deepEqual(found.map((o) => o.pid).sort(), [101, 102]);
  assert.equal(found.find((o) => o.pid === 101).reason, 'owner dead');
  assert.equal(found.find((o) => o.pid === 102).reason, 'parent dead');
  fs.rmSync(deadOwned, { recursive: true, force: true });
  fs.rmSync(liveOwned, { recursive: true, force: true });
});

test('readFootprint marks a run at least 1.5x the median of the ten before it as a jump', () => {
  const sizes = [8, 8, 9, 8, 8, 9, 8, 8, 120, 8];
  jsonl(FOOTPRINT_NAME, sizes.map((mb, i) => ({ at: `2026-10-01T00:0${i}:00Z`, dir: `p${i}`, bytes: mb * 1048576 })));
  const rows = readFootprint();
  assert.equal(rows.length, 10);
  assert.deepEqual(rows.filter((r) => r.jump).map((r) => r.dir), ['p8']);
  assert.equal(rows[0].jump, false, 'too few prior rows to judge');
});

test('readTrend buckets ledger creations per day by source, and releases; drops rows outside the window', () => {
  const now = Date.parse('2026-10-10T12:00:00Z');
  jsonl(LEDGER_NAME, [
    { at: '2026-10-09T01:00:00Z', ev: 'create', dir: 'a', source: PFX },
    { at: '2026-10-09T02:00:00Z', ev: 'create', dir: 'b', source: PFX },
    { at: '2026-10-09T02:01:00Z', ev: 'dispose', dir: 'a', released: true },
    { at: '2026-09-01T02:00:00Z', ev: 'create', dir: 'old', source: PFX },
  ]);
  jsonl(SAMPLES_NAME, [{ at: '2026-10-09T03:00:00Z', dirs: 2, mb: 16, stale: 1, browsers: 0, orphans: 0, freeGb: 50, bySource: {} }]);
  const t = readTrend({ days: 14, now });
  assert.equal(t.samples.length, 1);
  assert.deepEqual(t.daily, [{ day: '2026-10-09', bySource: { [PFX]: 2 }, created: 2, released: 1 }]);
});

test('sessionScratchCost attributes spawned/released/processes to the session whose window holds the event', () => {
  jsonl(LEDGER_NAME, [
    { at: '2026-10-09T10:05:00Z', ev: 'create', dir: 'p1', source: PFX },
    { at: '2026-10-09T10:05:01Z', ev: 'track', dir: 'p1', pid: 4242 },
    { at: '2026-10-09T10:06:00Z', ev: 'dispose', dir: 'p1', released: true },
    { at: '2026-10-09T10:07:00Z', ev: 'create', dir: 'p2', source: PFX },
    { at: '2026-10-09T11:30:00Z', ev: 'create', dir: 'other', source: PFX },
  ]);
  const rows = sessionScratchCost([
    { id: 1, goal: 'a', started_at: '2026-10-09T10:00:00Z', ended_at: '2026-10-09T11:00:00Z' },
    { id: 2, goal: 'quiet', started_at: '2026-10-09T12:00:00Z', ended_at: '2026-10-09T13:00:00Z' },
  ]);
  assert.equal(rows.length, 1, 'a session that spawned nothing is omitted');
  assert.deepEqual({ spawned: rows[0].spawned, released: rows[0].released, leaked: rows[0].leaked, processes: rows[0].processes }, { spawned: 2, released: 1, leaked: 1, processes: 1 });
});

test('real scratch lifecycle writes create/track/dispose ledger events', () => {
  fs.rmSync(path.join(root, LEDGER_NAME), { force: true });
  const h = ownScratchDir(createScratchDir(PFX, { baseDir: root }));
  h.track(process.pid + 100000); // never killed: dispose only kills tracked pids, and this one does not exist
  h.dispose();
  const events = fs.readFileSync(path.join(root, LEDGER_NAME), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).map((e) => e.ev);
  assert.deepEqual(events, ['create', 'track', 'dispose']);
});

test('cleanupScratch: dry-run by default deletes nothing; `dirs` narrows a real run to the named rows', () => {
  const dead = deadPid();
  const a = createScratchDir(PFX, { baseDir: root, ownerPid: dead });
  const b = createScratchDir(PFX, { baseDir: root, ownerPid: dead });
  const live = createScratchDir(PFX, { baseDir: root, ownerPid: process.pid });
  fs.writeFileSync(path.join(a, 'x.bin'), Buffer.alloc(2048));
  const dry = cleanupScratch({});
  assert.equal(dry.dryRun, true);
  assert.ok(fs.existsSync(a) && fs.existsSync(b), 'dry-run touched nothing');
  assert.ok(dry.removed.some((r) => r.name === path.basename(a)));
  const real = cleanupScratch({ dryRun: false, dirs: [path.basename(a), path.basename(live)] });
  assert.deepEqual(real.removed.map((r) => r.name), [path.basename(a)], 'only the named dead-owner row; a live-owner row is never reclaimable');
  assert.ok(!fs.existsSync(a));
  assert.ok(fs.existsSync(b), 'an unnamed stale dir survives a targeted cleanup');
  assert.ok(fs.existsSync(live));
  for (const d of [b, live]) fs.rmSync(d, { recursive: true, force: true });
});

test('cleanupScratch: a real delete of more than 200 dirs is refused without confirm', () => {
  const dead = deadPid();
  const made = Array.from({ length: 205 }, () => createScratchDir(PFX, { baseDir: root, ownerPid: dead }));
  const refused = cleanupScratch({ dryRun: false });
  assert.equal(refused.needsConfirm, true);
  assert.equal(refused.dryRun, true);
  assert.ok(made.every((d) => fs.existsSync(d)), 'nothing deleted without confirm');
  const done = cleanupScratch({ dryRun: false, confirm: true });
  assert.equal(done.removed.length, 205);
  assert.ok(made.every((d) => !fs.existsSync(d)));
});

test('lowDiskWarning warns when free space is below the threshold, and is silent otherwise', () => {
  assert.match(lowDiskWarning({ dir: root, minFreeGb: 1e9 }), /GB free/);
  assert.equal(lowDiskWarning({ dir: root, minFreeGb: 0 }), null);
});

test('hostFrictionItems: nothing for a healthy or missing snapshot; orphans/leaks/low disk become ranked items', () => {
  assert.deepEqual(hostFrictionItems(null), []);
  const base = { root: 'C:/tmp', scratchBytes: 1048576, staleDirs: 0, orphanBrowsers: [], metrics: { dirs: 1, freeGb: 100 }, levels: { dirs: 'ok', mb: 'ok', reclaimable: 'ok', freeGb: 'ok' } };
  assert.deepEqual(hostFrictionItems(base), []);
  const bad = hostFrictionItems({ ...base, orphanBrowsers: [{ pid: 9 }], staleDirs: 30, metrics: { dirs: 40, freeGb: 1 }, levels: { dirs: 'warn', mb: 'ok', reclaimable: 'crit', freeGb: 'crit' } });
  assert.deepEqual(bad.map((i) => i.kind).sort(), ['lowDisk', 'orphanBrowsers', 'scratchLeak']);
});

test('GET /host/health lists dirs with owner alive/dead and reclaimable flags', { skip: skipLive }, async () => {
  const dead = deadPid();
  const d = createScratchDir(PFX, { baseDir: root, ownerPid: dead });
  fs.writeFileSync(path.join(d, 'f.bin'), Buffer.alloc(4096));
  const h = await api('GET', '/host/health?fresh=1');
  const row = h.dirs.find((x) => x.name === path.basename(d));
  assert.ok(row, 'seeded dir listed');
  assert.equal(row.ownerPid, dead);
  assert.equal(row.ownerAlive, false);
  assert.equal(row.stale, true);
  assert.ok(row.bytes >= 4096);
  assert.ok(h.metrics.reclaimable >= 1);
  assert.equal(h.levels.reclaimable, 'warn');
  assert.ok(Array.isArray(h.orphanBrowsers));
  assert.ok(h.disk === null || h.disk.freeBytes > 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test('POST /host/cleanup previews by default and only deletes on an explicit dryRun:false', { skip: skipLive }, async () => {
  const d = createScratchDir(PFX, { baseDir: root, ownerPid: deadPid() });
  const preview = await api('POST', '/host/cleanup', { dirs: [path.basename(d)] });
  assert.equal(preview.dryRun, true);
  assert.equal(preview.removed.length, 1);
  assert.ok(fs.existsSync(d), 'preview deleted nothing');
  const real = await api('POST', '/host/cleanup', { dirs: [path.basename(d)], dryRun: false });
  assert.equal(real.dryRun, false);
  assert.ok(!fs.existsSync(d));
});

test('POST /host/kill-orphans never reports a kill when no orphan browser names one of our profile dirs', { skip: skipLive }, async () => {
  const r = await api('POST', '/host/kill-orphans', { pids: [process.pid] }); // not a browser: must be ignored
  assert.deepEqual(r.killed, []);
  assert.ok(isPidAlive(process.pid));
});

test('GET /host/test-run, /host/footprint, /host/trend, /host/sessions serve their feeds', { skip: skipLive }, async () => {
  assert.equal(await api('GET', '/host/test-run'), null, 'no run recorded yet');
  fs.writeFileSync(testRunPath, JSON.stringify({ at: '2026-10-01T00:00:00Z', leakedCount: 2, failed: true }));
  assert.equal((await api('GET', '/host/test-run')).leakedCount, 2);
  assert.ok(Array.isArray(await api('GET', '/host/footprint')));
  assert.ok(Array.isArray((await api('GET', '/host/trend')).daily));
  assert.ok(Array.isArray(await api('GET', '/host/sessions')));
});

test('analytics carries a host block (null while the host scan is off)', { skip: skipLive }, async () => {
  const a = await api('GET', '/analytics');
  assert.ok('host' in a);
  assert.equal(a.host, null, 'test relays run with WEBSCOUT_NO_HOST_SCAN=1');
});
