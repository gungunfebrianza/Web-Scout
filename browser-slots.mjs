// Machine-wide cap on concurrent headless browsers. Every launchBrowser() takes a slot first;
// a slot is a lock file `slot-<n>.json` holding the owner pid, created with O_EXCL so two
// processes cannot take the same one. A slot whose owner pid is dead is free again, so a crashed
// run never wedges the cap. One process holds at most one slot however many browsers it opens
// (a suite that opens two at once must not deadlock against itself).
//
// Several sessions each running an e2e suite used to start browsers with no limit at all; with
// the 2026-10-08 leak on top, that is how the machine reached 100% CPU for hours.
//   WEBSCOUT_MAX_BROWSERS    slots (default 2; 0 = no cap)
//   WEBSCOUT_SLOT_WAIT_MS    how long to wait for a slot before failing (default 15 min)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const slotsDir = () => process.env.WEBSCOUT_SLOTS_DIR || path.join(os.tmpdir(), 'webscout-browser-slots');
export const maxBrowsers = () => {
  const n = Number(process.env.WEBSCOUT_MAX_BROWSERS ?? 2);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 2;
};

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}
const readSlot = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Slots in use right now: [{ slot, pid, at, script }]. Dead owners' files are removed on the way.
export function slotHolders({ dir = slotsDir(), cap = maxBrowsers() } = {}) {
  const out = [];
  for (let n = 0; n < cap; n += 1) {
    const file = path.join(dir, `slot-${n}.json`);
    const s = readSlot(file);
    if (!s) continue;
    if (!pidAlive(s.pid)) { try { fs.rmSync(file, { force: true }); } catch { /* raced */ } continue; }
    out.push({ slot: n, ...s });
  }
  return out;
}

let held = null; // { file, refs }
let hooked = false;
function releaseSync() {
  if (!held) return;
  const s = readSlot(held.file);
  if (s?.pid === process.pid) { try { fs.rmSync(held.file, { force: true }); } catch { /* best effort */ } }
  held = null;
}

function tryTake(dir, cap) {
  for (let n = 0; n < cap; n += 1) {
    const file = path.join(dir, `slot-${n}.json`);
    const s = readSlot(file);
    if (s && !pidAlive(s.pid)) { try { fs.rmSync(file, { force: true }); } catch { /* raced */ } }
    try {
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), script: path.basename(process.argv[1] ?? '') }), { flag: 'wx' });
      return file;
    } catch { /* taken - try the next one */ }
  }
  return null;
}

// Resolves once this process holds a slot. Returns a release() for that acquisition.
export async function acquireSlot({ dir = slotsDir(), cap = maxBrowsers(), waitMs = Number(process.env.WEBSCOUT_SLOT_WAIT_MS ?? 15 * 60 * 1000), log = (m) => process.stderr.write(`${m}\n`) } = {}) {
  const noop = () => {};
  if (!cap) return noop;
  if (held) { held.refs += 1; return once(); }
  fs.mkdirSync(dir, { recursive: true });
  const deadline = Date.now() + waitMs;
  let told = false;
  for (;;) {
    const file = tryTake(dir, cap);
    if (file) {
      held = { file, refs: 1 };
      if (!hooked) { hooked = true; process.on('exit', releaseSync); }
      return once();
    }
    if (!told) {
      told = true;
      const who = slotHolders({ dir, cap }).map((h) => `pid ${h.pid}${h.script ? ` (${h.script})` : ''}`).join(', ');
      log(`webscout: all ${cap} headless browser slot(s) are busy (${who}); waiting. WEBSCOUT_MAX_BROWSERS raises the cap.`);
    }
    if (Date.now() > deadline) throw new Error(`no headless browser slot freed up within ${Math.round(waitMs / 1000)}s (cap ${cap}; holders: ${slotHolders({ dir, cap }).map((h) => h.pid).join(', ') || 'none'})`);
    await sleep(300);
  }
  function once() {
    let done = false;
    return () => {
      if (done || !held) return;
      done = true;
      held.refs -= 1;
      if (held.refs <= 0) releaseSync();
    };
  }
}
