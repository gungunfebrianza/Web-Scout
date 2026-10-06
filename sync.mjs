// Keeps vendored copies of the browser harness current.
//
// Other projects carry their own copy of tools/web-scout. The leak this repo fixed (a ~230 MB browser profile per
// test run) kept happening in those copies because nothing carried the fix over. `harness sync` copies the files
// that own browser/profile lifecycle into a copy; `harness check` says whether a copy is current (exit 1 when not).
// The three files are self-contained (host-health.mjs is an optional import), so they work in a copy that is
// otherwise many versions behind.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HARNESS_VERSION } from './scratch.mjs';

export const HARNESS_FILES = ['browser-harness.mjs', 'scratch.mjs', 'scratch-guard.mjs'];
export const STAMP_NAME = '.webscout-harness.json';
export const BACKUP_DIR = '.webscout-sync-backup';
const here = path.dirname(fileURLToPath(import.meta.url));

const sha = (file) => { try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return null; } };

// Does `dir` look like a web-scout copy at all? (Refuses to scribble files into an arbitrary directory.)
export const looksLikeCopy = (dir) => ['browser-harness.mjs', 'test-relay.mjs', 'relay.mjs', 'cli.mjs'].some((f) => fs.existsSync(path.join(dir, f)));

// { state: 'current' | 'stale' | 'missing', files: [{ file, state: 'same' | 'differs' | 'absent' }], stamp }
export function checkCopy(target, { source = here } = {}) {
  const dir = path.resolve(target);
  const files = HARNESS_FILES.map((file) => {
    const a = sha(path.join(source, file));
    const b = sha(path.join(dir, file));
    return { file, state: b === null ? 'absent' : a === b ? 'same' : 'differs' };
  });
  let stamp = null;
  try { stamp = JSON.parse(fs.readFileSync(path.join(dir, STAMP_NAME), 'utf8')); } catch { /* never synced */ }
  const state = files.every((f) => f.state === 'same') ? 'current' : files.every((f) => f.state === 'absent') ? 'missing' : 'stale';
  return { target: dir, state, files, stamp, harness: HARNESS_VERSION };
}

// Copies HARNESS_FILES into `target`. A file that would change is first saved under <target>/.webscout-sync-backup/
// (the copy may not be under git). dryRun reports what would change and writes nothing.
export function syncCopy(target, { dryRun = false, source = here, now = Date.now() } = {}) {
  const dir = path.resolve(target);
  if (path.resolve(source) === dir) throw new Error('target is this checkout itself - nothing to sync');
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`${dir} is not a directory`);
  if (!looksLikeCopy(dir)) throw new Error(`${dir} does not look like a web-scout copy (no browser-harness.mjs, test-relay.mjs, relay.mjs or cli.mjs) - point this at the folder that holds them, e.g. <project>/tools/web-scout`);
  const before = checkCopy(dir, { source });
  const changed = before.files.filter((f) => f.state !== 'same').map((f) => f.file);
  if (!dryRun && changed.length) {
    const backup = path.join(dir, BACKUP_DIR, new Date(now).toISOString().replace(/[:.]/g, '-'));
    for (const file of changed) {
      const dest = path.join(dir, file);
      if (fs.existsSync(dest)) { fs.mkdirSync(backup, { recursive: true }); fs.copyFileSync(dest, path.join(backup, file)); }
      fs.copyFileSync(path.join(source, file), dest);
    }
  }
  if (!dryRun) fs.writeFileSync(path.join(dir, STAMP_NAME), JSON.stringify({ harness: HARNESS_VERSION, from: source, at: new Date(now).toISOString(), files: HARNESS_FILES }, null, 2));
  return { target: dir, dryRun, changed, unchanged: HARNESS_FILES.filter((f) => !changed.includes(f)), harness: HARNESS_VERSION };
}
