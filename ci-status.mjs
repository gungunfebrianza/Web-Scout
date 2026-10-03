#!/usr/bin/env node
// CI status of the current HEAD via the gh CLI. No dependencies.
//   node ci-status.mjs [--wait]      exit 0 = latest run for HEAD succeeded, 1 = failed, 2 = in progress / no run
// --wait polls every 30s (max 20 min) until the latest run for HEAD is finished.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Pure: runs = parsed `gh run list --json headSha,status,conclusion,displayTitle` (newest first).
export function summarizeRuns(runs, sha) {
  const mine = (Array.isArray(runs) ? runs : []).filter((r) => r && r.headSha === sha);
  const lines = mine.map((r) => `${r.status === 'completed' ? (r.conclusion || 'completed') : (r.status || 'unknown')}  ${r.displayTitle || ''}`);
  const latest = mine[0];
  let code = 2;
  if (latest && latest.status === 'completed') code = latest.conclusion === 'success' ? 0 : 1;
  return { lines: lines.length ? lines : ['no CI run found for ' + String(sha).slice(0, 7)], code };
}

const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' }).trim();
function check() {
  const sha = sh('git', ['rev-parse', 'HEAD']);
  const runs = JSON.parse(sh('gh', ['run', 'list', '--limit', '5', '--json', 'headSha,status,conclusion,displayTitle']));
  return summarizeRuns(runs, sha);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const wait = process.argv.includes('--wait');
  const deadline = Date.now() + 20 * 60 * 1000;
  let res;
  for (;;) {
    res = check();
    console.log(res.lines.join('\n'));
    if (!wait || res.code !== 2 || Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, 30000));
  }
  process.exit(res.code);
}
