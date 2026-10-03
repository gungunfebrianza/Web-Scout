// flaky-sweep.mjs's summarizeRun: pulls failing test names and run-tests.mjs leak lines out of a run's output,
// and importing the module must not start a sweep.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeRun } from './flaky-sweep.mjs';
import { isIgnoredLeak, formatLeakNames } from './leak-ignore.mjs';

test('isIgnoredLeak is per-platform: PowerShell probe ignored on win32 only', () => {
  assert.equal(isIgnoredLeak('__PSScriptPolicyTest_abc.ps1', 'win32'), true);
  assert.equal(isIgnoredLeak('__PSScriptPolicyTest_abc.ps1', 'linux'), false);
  assert.equal(isIgnoredLeak('msedge_x', 'linux'), false);
  assert.equal(isIgnoredLeak('node-compile-cache', 'linux'), true);
  assert.equal(isIgnoredLeak('wl-abc', 'win32'), false);
});

test('formatLeakNames caps at 20 and reports the rest', () => {
  const names = Array.from({ length: 23 }, (_, i) => 'n' + i);
  const s = formatLeakNames(names);
  assert.ok(s.endsWith('+3 more') && s.includes('n19') && !s.includes('n20'));
  assert.equal(formatLeakNames(['a', 'b']), 'a, b');
});

test('summarizeRun extracts failing test names and leak report lines', () => {
  const out = [
    'TAP version 13', 'ok 1 - fine', 'not ok 2 - broken thing # TODO', '    not ok 1 - nested bad', 'not ok 2 - broken thing',
    '--- stderr ---',
    'run-tests: stopped 2 detached helper process(es) the tests left running (leak - fix them).',
    'run-tests: leaked: wl-abc, webscout-profile-1',
    'run-tests: 2 scratch entries left in the private root (tests that leaked - fix them); 0 orphan browser(s) killed',
    'run-tests: FAIL - the run leaked (entries left in its private root).',
  ].join('\r\n');
  const s = summarizeRun(out);
  assert.deepEqual(s.failed, ['broken thing', 'nested bad']);
  assert.equal(s.leaks.length, 4);
  assert.ok(s.leaks.some((l) => l.includes('wl-abc, webscout-profile-1')));
});

test('summarizeRun on a clean run is empty (a zero-entry summary line is not a leak)', () => {
  assert.deepEqual(summarizeRun('ok 1 - a\nrun-tests: 0 scratch entries left in the private root; 0 orphan browser(s) killed'), { failed: [], leaks: [] });
  assert.deepEqual(summarizeRun(undefined), { failed: [], leaks: [] });
});
