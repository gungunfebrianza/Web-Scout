#!/usr/bin/env node
// Runs the suite inside ONE private scratch root so a run can never leak into the real
// %TEMP%: TEMP/TMP/TMPDIR/WEBSCOUT_TMPDIR point at it for every child (browser profiles,
// relay pid files, fixtures). Afterwards it reports what the run left behind (a leak: tests
// are meant to clean up after themselves), wipes the root, and FAILS if the real temp dir
// gained web-scout dirs anyway.
//   node run-tests.mjs [node --test args / files...]     (default: every *.test.mjs)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reapLeakedRelays } from './relay-control.mjs';
import { removeDirSync, PREFIXES, scratchStats, killTree, listBrowserProcesses } from './scratch.mjs';
import { testRunFile } from './host-health.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const realTmp = os.tmpdir();
const root = fs.mkdtempSync(path.join(realTmp, 'webscout-testroot-'));
const IGNORED = ['node-compile-cache', 'webscout-relays.jsonl', 'webscout-scratch-log.jsonl', 'webscout-scratch-ledger.jsonl', 'webscout-host-samples.jsonl', 'webscout-warn-cache-', 'msedge_', 'cv_debug.log']; // shared-by-design files
const ours = (dir) => scratchStats({ baseDir: dir }).dirs; // our prefixes only: unrelated tools may create wl-* meanwhile
const before = ours(realTmp);

const files = process.argv.slice(2);
const args = ['--test', ...(files.length ? files : fs.readdirSync(here).filter((f) => f.endsWith('.test.mjs')))];
const r = spawnSync(process.execPath, args, {
  cwd: here, stdio: 'inherit',
  env: { ...process.env, NODE_ENV: 'test', WEBSCOUT_TMPDIR: root, TEMP: root, TMP: root, TMPDIR: root },
});

// Detached helpers the tests spawned and never stopped: test relays (registry lives in the private root)
// and static servers (pidfiles). Stop them first - they hold locks on the root.
let reaped = 0;
try { reaped += reapLeakedRelays({ ageMs: 0, registryPath: path.join(root, 'webscout-relays.jsonl') }).killedRelays; } catch { /* best effort */ }
for (const n of fs.readdirSync(root).filter((f) => /^webscout-serve-\d+\.json$/.test(f))) {
  try { const { pid } = JSON.parse(fs.readFileSync(path.join(root, n), 'utf8')); if (Number.isInteger(pid)) { killTree(pid); reaped += 1; } } catch { /* unreadable pidfile */ }
}
if (reaped) { console.error(`run-tests: stopped ${reaped} detached helper process(es) the tests left running (leak - fix them).`); await new Promise((r) => setTimeout(r, 500)); }

// A profile whose files are still locked by a scanner is not a leak yet: give it a real chance to release
// before it counts (the failure this replaced was a 7s window under load).
for (const n of fs.readdirSync(root).filter((f) => PREFIXES.some((p) => f.startsWith(p)))) removeDirSync(path.join(root, n), { attempts: 25, quiet: true });
// <guid>.tmp: scratch files a Chromium/Edge process writes into TEMP itself when it is killed mid-write - not ours.
const BROWSER_TMP = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}.tmp$/i;
const isLeak = (n) => !IGNORED.some((p) => n.startsWith(p)) && !BROWSER_TMP.test(n);
const leakedNames = fs.readdirSync(root).filter(isLeak);
const left = leakedNames.length;
// Browsers still pointing into the private root are leaks too: kill, then wipe.
const orphans = listBrowserProcesses().filter((p) => p.commandLine.toLowerCase().includes(root.toLowerCase()));
for (const p of orphans) killTree(p.pid);
if (left) console.error(`run-tests: leaked: ${fs.readdirSync(root).filter(isLeak).join(', ')}`);
const ok = removeDirSync(root);
const grew = ours(realTmp) - before;
console.error(`\nrun-tests: ${left} scratch entr${left === 1 ? 'y' : 'ies'} left in the private root${left ? ' (tests that leaked - fix them)' : ''}; ${orphans.length} orphan browser(s) killed; root ${ok ? 'wiped' : 'could NOT be fully wiped'}; real temp gained ${grew} web-scout dir(s).`);
// Last-run record for the dashboard's "Test runs" panel. Written to the REAL temp dir (the private root is wiped).
try {
  fs.writeFileSync(testRunFile(), JSON.stringify({
    at: new Date().toISOString(), exitStatus: r.status ?? null, leakedEntries: leakedNames, leakedCount: left, helpersStopped: reaped,
    orphansKilled: orphans.length, rootWiped: ok, realTempGained: grew, failed: grew > 0 || orphans.length > 0 || left > 0 || (r.status ?? 1) !== 0,
  }));
} catch { /* dashboard convenience only */ }
if (grew > 0 || orphans.length || left > 0) {
  // Forensics: a leak-only failure has no failing test to point at, so keep the list (flaky-sweep.mjs reads it too).
  try {
    fs.mkdirSync(path.join(here, '.sweep'), { recursive: true });
    fs.writeFileSync(path.join(here, '.sweep', 'last-leaks.json'), JSON.stringify({ at: new Date().toISOString(), leakedEntries: leakedNames, orphansKilled: orphans.length, realTempGained: grew, helpersStopped: reaped, testExitStatus: r.status ?? null }, null, 2));
  } catch { /* forensics only */ }
  console.error('run-tests: FAIL - the run leaked (' + (left ? 'entries left in its private root' : 'outside its private root or left a browser running') + ').');
  process.exit(1);
}
process.exit(r.status ?? 1);
