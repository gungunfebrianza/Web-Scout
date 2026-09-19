// trace.mjs's rankAutoTraces(): "session end --trace" grows traces/auto/ on its own, but nothing
// ever looked at the pile it leaves behind - promoting one into the committed, benchmarked
// traces/*.json.gz set stays a human choosing a good session, on purpose (see the roadmap). This
// turns the pile into ranked CANDIDATES using the same leanWorst distrust-rate signal
// read-pipeline.mjs and the dashboard already surface.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rankAutoTraces, writeTrace, TRACE_VERSION } from './trace.mjs';
import { spawnClean } from './test-relay.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));

const dump = (n, pad, tag = 'a') => ({ store: `s${tag}`, keyPath: 'id', count: n, rows: Array.from({ length: n }, (_, i) => ({ id: i + 1, owner: `user-${i}`, note: 'n'.repeat(pad) })) });
const ev = (type, params, result) => ({ t: 0, type, ok: true, params, result });

function tmpAutoDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'webscout-rank-auto-')); }

test('a trace whose reads are all distrusted under leanWorst ranks above one that never is', () => {
  const auto = tmpAutoDir();
  try {
    // Big enough results to blow past the lean guard every time -> leanWorst always re-asks (100% distrust).
    const noisy = { version: TRACE_VERSION, events: [ev('idb.dump', { store: 'a' }, dump(600, 80, 'a')), ev('idb.dump', { store: 'b' }, dump(600, 80, 'b'))] };
    // Small results never trip the guard -> full replies -> nothing to distrust (0%).
    const calm = { version: TRACE_VERSION, events: [ev('idb.dump', { store: 'a' }, dump(3, 5, 'a')), ev('idb.dump', { store: 'b' }, dump(3, 5, 'b'))] };
    writeTrace(path.join(auto, 'noisy.json.gz'), noisy);
    writeTrace(path.join(auto, 'calm.json.gz'), calm);

    const { dir: usedDir, candidates, broken } = rankAutoTraces({ dir: auto });
    assert.equal(usedDir, auto);
    assert.deepEqual(broken, []);
    assert.equal(candidates.length, 2);
    assert.equal(candidates[0].file, 'noisy.json.gz', JSON.stringify(candidates));
    assert.ok(candidates[0].distrustRatePct > candidates[1].distrustRatePct);
    assert.equal(candidates[1].file, 'calm.json.gz');
    assert.equal(candidates[1].distrustRatePct, 0);
  } finally {
    fs.rmSync(auto, { recursive: true, force: true });
  }
});

test('an unreadable file is reported as broken, not thrown, and does not block the others', () => {
  const auto = tmpAutoDir();
  try {
    writeTrace(path.join(auto, 'good.json.gz'), { version: TRACE_VERSION, events: [ev('idb.dump', { store: 'a' }, dump(3, 5))] });
    fs.writeFileSync(path.join(auto, 'corrupt.json.gz'), Buffer.from('not actually gzip json'));
    const { candidates, broken } = rankAutoTraces({ dir: auto });
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].file, 'good.json.gz');
    assert.equal(broken.length, 1);
    assert.equal(broken[0].file, 'corrupt.json.gz');
  } finally {
    fs.rmSync(auto, { recursive: true, force: true });
  }
});

test('a directory that does not exist yet: empty candidates, no throw', () => {
  const { candidates, broken } = rankAutoTraces({ dir: path.join(os.tmpdir(), 'webscout-rank-auto-does-not-exist-xyz') });
  assert.deepEqual(candidates, []);
  assert.deepEqual(broken, []);
});

test('CLI: "trace.mjs rank-auto <dir>" prints the ranked list', () => {
  const auto = tmpAutoDir();
  try {
    writeTrace(path.join(auto, 'noisy.json.gz'), { version: TRACE_VERSION, events: [ev('idb.dump', { store: 'a' }, dump(600, 80, 'a'))] });
    const r = spawnClean([path.join(dir, 'trace.mjs'), 'rank-auto', auto], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /noisy\.json\.gz/);
    assert.match(r.stdout, /distrusted/);
  } finally {
    fs.rmSync(auto, { recursive: true, force: true });
  }
});

test('CLI: an empty auto dir says so instead of printing nothing', () => {
  const auto = tmpAutoDir();
  try {
    const r = spawnClean([path.join(dir, 'trace.mjs'), 'rank-auto', auto], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /no auto-exported traces found/);
  } finally {
    fs.rmSync(auto, { recursive: true, force: true });
  }
});
