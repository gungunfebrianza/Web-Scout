// Watchdog for a scratch dir + browser: exits with the owner. Spawned detached by
// scratch.mjs so the browser tree and profile are reclaimed even when the owner is
// SIGKILLed / crashes / loses power to the parent (no exit handler can run then).
// Stand-in for a Windows Job Object (KILL_ON_JOB_CLOSE), which Node cannot create
// without a native helper. Usage: node scratch-guard.mjs <ownerPid> <browserPid> <dir>
import fs from 'node:fs';
import path from 'node:path';
import { isPidAlive, killTree, removeDirSync, PREFIXES } from './scratch.mjs';

// --reap <dir>: a dir whose files stayed locked (AV scan, indexer) past the owner's own retries. Keep
// trying in the background for up to two minutes instead of leaving it for the next sweep.
if (process.argv[2] === '--reap') {
  const target = process.argv[3];
  const ok = target && PREFIXES.some((p) => path.basename(target).startsWith(p)) && (() => { try { return !fs.lstatSync(target).isSymbolicLink(); } catch { return false; } })();
  if (!ok) process.exit(2);
  const until = Date.now() + 120000;
  const tick = () => {
    if (removeDirSync(target, { attempts: 3, quiet: true }) || Date.now() > until) process.exit(0);
    setTimeout(tick, 2000);
  };
  tick();
} else {
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
}
