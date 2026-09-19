// The token estimator says how far to trust its own band: uncalibrated, partial, stale or
// calibrated. `calibrate-tokens.mjs --check` turns that into an exit code, and a CI that sets
// WEBSCOUT_REQUIRE_CALIBRATION=1 refuses a tree whose committed token-calibration.json is missing,
// incomplete or older than STALE_AFTER_DAYS - the same opt-in shape as WEBSCOUT_REQUIRE_BROWSER, so
// a green run cannot quietly mean "we never measured". Measuring needs ANTHROPIC_API_KEY, so the
// suite does not do it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnClean } from './test-relay.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const KINDS = { json: { ratio: 3, low: 2.5, high: 3.4 }, html: { ratio: 2.9, low: 2.4, high: 3.2 }, prose: { ratio: 4.1, low: 3.7, high: 4.5 } };
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

function withCalibration(json, fn) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'webscout-cal-status-')), 'cal.json');
  if (json !== null) fs.writeFileSync(file, JSON.stringify(json));
  try { return fn(file); } finally { fs.rmSync(path.dirname(file), { recursive: true, force: true }); }
}
const infoFor = (json) => withCalibration(json, (file) => {
  const script = `const m = await import(${JSON.stringify(new URL('./token-estimate.mjs', import.meta.url).href)}); console.log(JSON.stringify(m.estimatorInfo()));`;
  const r = spawnClean(['--input-type=module', '-e', script], { env: { WEBSCOUT_TOKEN_CALIBRATION: file } });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
});
const check = (json, extraEnv = {}) => withCalibration(json, (file) => spawnClean([path.join(dir, 'calibrate-tokens.mjs'), '--check'], { env: { WEBSCOUT_TOKEN_CALIBRATION: file, ...extraEnv } }));

test('no file is uncalibrated, and says how to fix it', () => {
  const i = infoFor(null);
  assert.equal(i.status, 'uncalibrated');
  assert.equal(i.calibrated, false);
  assert.match(i.note, /calibrate-tokens\.mjs --write/);
});

test('all three kinds, measured recently, is calibrated with an age', () => {
  const i = infoFor({ model: 'm', sampledAt: daysAgo(3), kinds: KINDS });
  assert.equal(i.status, 'calibrated');
  assert.equal(i.calibrated, true);
  assert.equal(i.ageDays, 3);
  assert.equal(i.staleAfterDays, 90);
});

test('a calibration older than the limit, or with no date, is stale - and still used', () => {
  const old = infoFor({ model: 'm', sampledAt: daysAgo(120), kinds: KINDS });
  assert.equal(old.status, 'stale');
  assert.equal(old.calibrated, true, 'the measured ranges are still what the band uses');
  assert.match(old.note, /120 days old/);
  assert.equal(infoFor({ model: 'm', kinds: KINDS }).status, 'stale', 'undated cannot be shown to be fresh');
});

test('some kinds measured is partial, a file with no valid kind is uncalibrated', () => {
  const partial = infoFor({ model: 'm', sampledAt: daysAgo(1), kinds: { json: KINDS.json } });
  assert.equal(partial.status, 'partial');
  assert.deepEqual(partial.calibratedKinds, ['json']);
  assert.equal(infoFor({ kinds: { json: { ratio: 5, low: 6, high: 7 } } }).status, 'uncalibrated');
});

test('calibrate-tokens.mjs --check is offline and exits 0 only for a complete, fresh calibration', () => {
  const ok = check({ model: 'm', sampledAt: daysAgo(2), kinds: KINDS });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /calibrated/);
  const missing = check(null);
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /uncalibrated/);
  assert.equal(check({ model: 'm', sampledAt: daysAgo(400), kinds: KINDS }).status, 1);
});

// Opt-in: the committed calibration must be complete and fresh. This repository has not been
// measured yet (it needs an API key), so the test skips with that reason until it has.
const requireCalibration = process.env.WEBSCOUT_REQUIRE_CALIBRATION === '1';
const committed = fs.existsSync(path.join(dir, 'token-calibration.json'));
test('the committed token-calibration.json is complete and fresh (CI: WEBSCOUT_REQUIRE_CALIBRATION=1)', { skip: requireCalibration ? false : (committed ? false : 'no committed token-calibration.json yet - run calibrate-tokens.mjs --write with ANTHROPIC_API_KEY, then set WEBSCOUT_REQUIRE_CALIBRATION=1 in CI') }, () => {
  const r = spawnClean([path.join(dir, 'calibrate-tokens.mjs'), '--check'], { env: { WEBSCOUT_TOKEN_CALIBRATION: path.join(dir, 'token-calibration.json') } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
