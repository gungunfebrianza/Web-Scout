#!/usr/bin/env node
// Runs the suite N times (default 3) and lists every test that failed in ANY run, with how often.
// A test that passes on a rerun is a flaky test, not a green one: this is how they get found.
// Each run's full output (stdout + stderr) is kept in .sweep/run-<n>.log so a red run with no failing
// test (a leak report from run-tests.mjs) can still be diagnosed afterwards.
//   node flaky-sweep.mjs [runs] [test files...]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// Pure: what a run's output says went wrong. failed = TAP "not ok" test names; leaks = run-tests.mjs's
// own leak/FAIL report lines (they go to stderr, so the caller must pass stdout + stderr together).
export function summarizeRun(outputText) {
  const text = String(outputText ?? '');
  const failed = [...new Set([...text.matchAll(/^\s*not ok \d+ - (.+?)(?:\s+#.*)?$/gm)].map((m) => m[1]))];
  const leaks = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^run-tests: (leaked:|stopped \d+ detached|FAIL\b)/.test(l) || /^run-tests: [1-9]\d* scratch entr/.test(l));
  return { failed, leaks };
}

function main() {
  const runs = Math.max(1, Number(process.argv[2]) || 3);
  const files = process.argv.slice(3);
  const sweepDir = path.join(here, '.sweep');
  fs.mkdirSync(sweepDir, { recursive: true });
  const failures = new Map(); // test name -> number of runs it failed in
  const redDetails = [];
  let redRuns = 0;
  for (let n = 1; n <= runs; n += 1) {
    const r = spawnSync(process.execPath, ['run-tests.mjs', '--test-reporter=tap', ...files], { cwd: here, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    const logFile = path.join(sweepDir, `run-${n}.log`);
    const output = `${r.stdout || ''}${r.stderr ? `\n--- stderr ---\n${r.stderr}` : ''}`;
    fs.writeFileSync(logFile, output);
    const { failed, leaks } = summarizeRun(output);
    if (r.status !== 0) { redRuns += 1; redDetails.push({ n, status: r.status, failed, leaks, logFile }); }
    for (const name of failed) failures.set(name, (failures.get(name) || 0) + 1);
    console.error(`flaky-sweep: run ${n}/${runs}: exit ${r.status}, ${failed.length} failing test(s), ${leaks.length} leak line(s) (${logFile})`);
  }
  const rows = [...failures].sort((a, b) => b[1] - a[1]);
  if (!rows.length) console.log(`flaky-sweep: ${runs} run(s), no test ever failed${redRuns ? ` (but ${redRuns} run(s) exited non-zero: a leak or host check)` : ''}.`);
  else {
    console.log(`flaky-sweep: ${rows.length} test(s) failed at least once in ${runs} run(s):`);
    for (const [name, n] of rows) console.log(`  ${n}/${runs}  ${name}${n < runs ? '  <- FLAKY' : '  <- consistently red'}`);
  }
  for (const d of redDetails) {
    console.log(`flaky-sweep: run ${d.n} exited ${d.status} (log: ${d.logFile})`);
    for (const f of d.failed) console.log(`  not ok: ${f}`);
    for (const l of d.leaks) console.log(`  ${l}`);
    if (!d.failed.length && !d.leaks.length) console.log('  (no failing test and no leak report in the output: see the log)');
  }
  if (redDetails.some((d) => d.leaks.length)) console.log(`flaky-sweep: leak list also in ${path.join(sweepDir, 'last-leaks.json')} (the last leaking run).`);
  process.exit(redRuns ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
