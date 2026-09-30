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
import { removeDirSync, scratchStats, killTree, listBrowserProcesses } from './scratch.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const realTmp = os.tmpdir();
const root = fs.mkdtempSync(path.join(realTmp, 'webscout-testroot-'));
const IGNORED = ['node-compile-cache', 'webscout-relays.jsonl', 'webscout-scratch-log.jsonl', 'cv_debug.log']; // shared-by-design files
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

const left = fs.readdirSync(root).filter((n) => !IGNORED.some((p) => n.startsWith(p))).length;
// Browsers still pointing into the private root are leaks too: kill, then wipe.
const orphans = listBrowserProcesses().filter((p) => p.commandLine.toLowerCase().includes(root.toLowerCase()));
for (const p of orphans) killTree(p.pid);
if (left) console.error(`run-tests: leaked: ${fs.readdirSync(root).filter((n) => !IGNORED.some((p) => n.startsWith(p))).join(', ')}`);
const ok = removeDirSync(root);
const grew = ours(realTmp) - before;
console.error(`\nrun-tests: ${left} scratch entr${left === 1 ? 'y' : 'ies'} left in the private root${left ? ' (tests that leaked - fix them)' : ''}; ${orphans.length} orphan browser(s) killed; root ${ok ? 'wiped' : 'could NOT be fully wiped'}; real temp gained ${grew} web-scout dir(s).`);
if (grew > 0 || orphans.length) { console.error('run-tests: FAIL - the run leaked outside its private root or left a browser running.'); process.exit(1); }
process.exit(r.status ?? 1);
