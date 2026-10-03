// Watchdog for a scratch dir + browser: exits with the owner. Spawned detached by
// scratch.mjs so the browser tree and profile are reclaimed even when the owner is
// SIGKILLed / crashes / loses power to the parent (no exit handler can run then).
// Stand-in for a Windows Job Object (KILL_ON_JOB_CLOSE), which Node cannot create
// without a native helper. Usage: node scratch-guard.mjs <ownerPid> <browserPid> <dir>
import fs from 'node:fs';
import path from 'node:path';
import { isPidAlive, killTree, removeDirSync, PREFIXES } from './scratch.mjs';

const [owner, browser, dir] = [Number(process.argv[2]), Number(process.argv[3]), process.argv[4]];
const safe = dir && PREFIXES.some((p) => path.basename(dir).startsWith(p)) && (() => { try { return !fs.lstatSync(dir).isSymbolicLink(); } catch { return false; } })();
if (!safe || !owner || !browser) process.exit(2);

const timer = setInterval(() => {
  if (isPidAlive(owner)) {
    if (!isPidAlive(browser)) { clearInterval(timer); process.exit(0); } // owner handles its own cleanup
    return;
  }
  clearInterval(timer);
  killTree(browser); // children first: the browser locks its profile
  removeDirSync(dir, { quiet: true });
  process.exit(0);
}, 500);
