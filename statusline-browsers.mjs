// Status-line wrapper: runs the real status-line command (argv) with Claude Code's JSON on stdin,
// then appends a headless-browser segment when web-scout browsers are running, so a pile-up is
// visible at a glance instead of only as a hot CPU. Reads the small cache browser-reaper.mjs
// writes (on every close(), the Stop hook and `browsers`), never spawns PowerShell itself.
//   "statusLine": { "type": "command", "command": "node <this file> <real command> [args...]" }
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const STALE_MS = 15 * 60 * 1000;
let input = '';
try { input = fs.readFileSync(0, 'utf8'); } catch { /* no stdin */ }

let line = '';
const [cmd, ...args] = process.argv.slice(2);
if (cmd) {
  const r = spawnSync(cmd, args, { input, encoding: 'utf8', windowsHide: true, timeout: 5000 });
  line = (r.stdout ?? '').replace(/\s+$/, '');
}

let segment = '';
try {
  const s = JSON.parse(fs.readFileSync(path.join(os.tmpdir(), 'webscout-browsers-status.json'), 'utf8'));
  if (Date.now() - Date.parse(s.at) < STALE_MS) {
    if (s.orphans) segment = `\x1b[31mheadless ${s.browsers} (${s.orphans} ORPHAN, ${s.processes} proc)\x1b[0m`;
    else if (s.browsers) segment = `\x1b[2mheadless ${s.browsers}\x1b[0m`;
  }
} catch { /* no cache yet */ }

process.stdout.write(segment ? `${line}${line ? ' | ' : ''}${segment}\n` : `${line}\n`);
