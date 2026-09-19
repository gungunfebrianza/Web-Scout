// chars/4 stays the ledger unit; the estimator adds an honest band per kind of text,
// and calibrate-tokens.mjs replaces the rule-of-thumb defaults with measured ratios.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnClean } from './test-relay.mjs';
import { calibrateKinds, makeApiCounter, gatherSamples } from './calibrate-tokens.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));

function withCalibration(json, fn) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'webscout-cal-')), 'cal.json');
  if (json !== null) fs.writeFileSync(file, JSON.stringify(json));
  const script = `const m = await import(${JSON.stringify(new URL('./token-estimate.mjs', import.meta.url).href)}); console.log(JSON.stringify({ info: m.estimatorInfo(), est: m.estimateTokens(12000, 'json'), band: m.baselineBand(12000, 'json'), html: m.estimateTokens(12000, 'html') }));`;
  const r = spawnClean(['--input-type=module', '-e', script], { env: { WEBSCOUT_TOKEN_CALIBRATION: file } });
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
  assert.equal(r.status, 0, r.stderr);
  return fn(JSON.parse(r.stdout));
}

test('without a calibration file the band is the labelled rule-of-thumb default', () => {
  withCalibration(null, (o) => {
    assert.equal(o.info.unit, 'chars/4');
    assert.equal(o.info.calibrated, false);
    assert.match(o.info.source, /uncalibrated/);
    assert.match(o.info.note, /calibrate-tokens/);
    assert.ok(o.est.low < o.est.est && o.est.est < o.est.high);
    assert.equal(o.band.baseline, 3000, 'the ledger unit is unchanged: 12000 chars / 4');
    assert.ok(o.band.low < 3000 && o.band.high > 3000, 'and the band brackets it');
    assert.ok(o.html.est > o.est.est, 'markup costs more tokens per character than JSON');
  });
});

test('a valid calibration file replaces the defaults for its kinds, an invalid one is ignored', () => {
  const kinds = { json: { ratio: 3, low: 2.5, high: 3.4 }, html: { ratio: 2.9, low: 2.4, high: 3.2 }, prose: { ratio: 4.1, low: 3.7, high: 4.5 } };
  withCalibration({ model: 'test-model', sampledAt: '2026-09-19T00:00:00Z', kinds }, (o) => {
    assert.equal(o.info.calibrated, true);
    assert.match(o.info.source, /measured \(test-model/);
    assert.equal(o.est.est, 4000);
    assert.equal(o.band.low, Math.round(12000 / 3.4));
  });
  withCalibration({ kinds: { json: { ratio: 5, low: 6, high: 7 } } }, (o) => {
    assert.equal(o.info.calibrated, false, 'low > ratio is nonsense - the default stays');
    assert.ok(o.est.est > 3000);
  });
});

test('calibrateKinds derives ratio and band from counted tokens, subtracting message framing', async () => {
  const framing = 7;
  // a stand-in counter: JSON at 3 chars/token, prose at 5 chars/token, plus framing
  const countTokens = async (text) => framing + (text === '.' ? 1 : Math.ceil(text.length / (text.startsWith('{') ? 3 : text.startsWith('<') ? 2.5 : 5)));
  const json = Array.from({ length: 6 }, (_, i) => `{"row":${i},"pad":"${'x'.repeat(100 + i * 40)}"}`);
  const html = Array.from({ length: 4 }, (_, i) => `<div>${'y'.repeat(120 + i * 30)}</div>`);
  const prose = Array.from({ length: 5 }, (_, i) => `${'word '.repeat(30 + i * 5)}`);
  const { kinds, detail } = await calibrateKinds({ samples: { json, html, prose }, countTokens });
  assert.ok(Math.abs(kinds.json.ratio - 3) < 0.15, `json ratio ${kinds.json.ratio}`);
  assert.ok(Math.abs(kinds.html.ratio - 2.5) < 0.2);
  assert.ok(Math.abs(kinds.prose.ratio - 5) < 0.2);
  for (const k of ['json', 'html', 'prose']) assert.ok(kinds[k].low <= kinds[k].ratio && kinds[k].ratio <= kinds[k].high, `${k} band brackets its ratio`);
  assert.equal(detail.json.samples, 6);
});

test('a kind with too few usable samples is skipped, not invented', async () => {
  const { kinds, detail } = await calibrateKinds({ samples: { json: ['{"a":1}'.padEnd(100, ' ')], html: [], prose: [] }, countTokens: async () => 30 });
  assert.deepEqual(kinds, {});
  assert.match(detail.json.skipped, /fewer than 3/);
});

test('the API counter posts the text to count_tokens and returns input_tokens; it needs a key', async () => {
  assert.throws(() => makeApiCounter({}), /ANTHROPIC_API_KEY/);
  const seen = [];
  const counter = makeApiCounter({
    apiKey: 'sk-test', model: 'm-1',
    fetchImpl: async (url, init) => { seen.push({ url, init }); return { ok: true, status: 200, json: async () => ({ input_tokens: 42 }) }; },
  });
  assert.equal(await counter('hello'), 42);
  assert.equal(seen[0].url, 'https://api.anthropic.com/v1/messages/count_tokens');
  assert.equal(seen[0].init.headers['x-api-key'], 'sk-test');
  assert.deepEqual(JSON.parse(seen[0].init.body), { model: 'm-1', messages: [{ role: 'user', content: 'hello' }] });
  const failing = makeApiCounter({ apiKey: 'k', fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ error: 'nope' }) }) });
  await assert.rejects(failing('x'), /count_tokens failed \(401\)/);
});

test('estimatorInfo names WHY auto-calibrate has not filled the gap yet, when told', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'webscout-cal-')), 'cal.json');
  const script = `const m = await import(${JSON.stringify(new URL('./token-estimate.mjs', import.meta.url).href)});
    console.log(JSON.stringify({
      off: m.estimatorInfo({ autoCalibrate: { enabled: false, scheduled: false, outcome: null } }).note,
      notYetRun: m.estimatorInfo({ autoCalibrate: { enabled: true, scheduled: false, outcome: null } }).note,
      pending: m.estimatorInfo({ autoCalibrate: { enabled: true, scheduled: true, outcome: null } }).note,
      failed: m.estimatorInfo({ autoCalibrate: { enabled: true, scheduled: true, outcome: { written: false, reason: 'no Claude Code transcripts found' } } }).note,
      bare: m.estimatorInfo().note,
    }));`;
  const r = spawnClean(['--input-type=module', '-e', script], { env: { WEBSCOUT_TOKEN_CALIBRATION: file } });
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
  assert.equal(r.status, 0, r.stderr);
  const notes = JSON.parse(r.stdout);
  assert.match(notes.off, /WEBSCOUT_AUTO_CALIBRATE is not set on this relay/);
  assert.match(notes.notYetRun, /has not run yet on this relay/);
  assert.match(notes.pending, /already started; still finishing/);
  assert.match(notes.failed, /already tried once on this relay and did not write one: no Claude Code transcripts found/);
  assert.doesNotMatch(notes.bare, /AUTO_CALIBRATE/, 'no autoCalibrate arg (e.g. calibrate-tokens.mjs, transcript-tokens.mjs callers) adds nothing');
});

test('gatherSamples draws JSON and HTML from recorded actions and prose from the README', async () => {
  const get = async (_m, route) => {
    if (route === '/sessions') return [{ id: 1 }];
    return [
      { ok: true, type: 'idb.dump', result: { rows: Array.from({ length: 20 }, (_, i) => ({ id: i, pad: 'p'.repeat(30) })) } },
      { ok: true, type: 'dom.query', result: { outerHTML: `<div>${'z'.repeat(300)}</div>` } },
      { ok: false, type: 'dom.query', result: null },
    ];
  };
  const samples = await gatherSamples({ get, maxPerKind: 5, readmePath: path.join(dir, 'README.md') });
  assert.ok(samples.json.length >= 1 && samples.json[0].startsWith('{'));
  assert.equal(samples.html.length, 1);
  assert.ok(samples.prose.length >= 3, 'the README has prose paragraphs');
});
