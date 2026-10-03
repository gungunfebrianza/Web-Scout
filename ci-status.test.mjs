import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeRuns } from './ci-status.mjs';

const run = (headSha, status, conclusion, displayTitle = 't') => ({ headSha, status, conclusion, displayTitle });

test('summarizeRuns: latest run for the sha decides the exit code', () => {
  assert.equal(summarizeRuns([run('a', 'completed', 'success'), run('a', 'completed', 'failure')], 'a').code, 0);
  assert.equal(summarizeRuns([run('b', 'completed', 'success'), run('a', 'completed', 'failure')], 'a').code, 1);
  assert.equal(summarizeRuns([run('a', 'in_progress', '')], 'a').code, 2);
});

test('summarizeRuns: one line per run for the sha; none found is code 2', () => {
  const s = summarizeRuns([run('a', 'completed', 'failure', 'x'), run('b', 'completed', 'success'), run('a', 'queued', '', 'y')], 'a');
  assert.equal(s.lines.length, 2);
  assert.match(s.lines[0], /failure/);
  const none = summarizeRuns([], 'abcdef123');
  assert.equal(none.code, 2);
  assert.match(none.lines[0], /abcdef1/);
});
