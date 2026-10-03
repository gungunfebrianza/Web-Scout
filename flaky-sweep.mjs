#!/usr/bin/env node
// Runs the suite N times (default 3) and lists every test that failed in ANY run, with how often.
// A test that passes on a rerun is a flaky test, not a green one: this is how they get found.
//   node flaky-sweep.mjs [runs] [test files...]
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const runs = Math.max(1, Number(process.argv[2]) || 3);
const files = process.argv.slice(3);
const failures = new Map(); // test name -> number of runs it failed in
let redRuns = 0;
for (let n = 1; n <= runs; n += 1) {
  const r = spawnSync(process.execPath, ['run-tests.mjs', '--test-reporter=tap', ...files], { cwd: here, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const failed = new Set([...r.stdout.matchAll(/^\s*not ok \d+ - (.+?)(?:\s+#.*)?$/gm)].map((m) => m[1]));
  if (r.status !== 0) redRuns += 1;
  for (const name of failed) failures.set(name, (failures.get(name) || 0) + 1);
  console.error(`flaky-sweep: run ${n}/${runs}: exit ${r.status}, ${failed.size} failing test(s)`);
}
const rows = [...failures].sort((a, b) => b[1] - a[1]);
if (!rows.length) console.log(`flaky-sweep: ${runs} run(s), no test ever failed${redRuns ? ` (but ${redRuns} run(s) exited non-zero: a leak or host check)` : ''}.`);
else {
  console.log(`flaky-sweep: ${rows.length} test(s) failed at least once in ${runs} run(s):`);
  for (const [name, n] of rows) console.log(`  ${n}/${runs}  ${name}${n < runs ? '  <- FLAKY' : '  <- consistently red'}`);
}
process.exit(redRuns ? 1 : 0);
