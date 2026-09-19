// Every byte-to-token figure in this tool is chars/4. That is one number for
// three very different kinds of text: JSON (short keys, ids, punctuation) costs
// more tokens per character than prose, markup more still. So the ledgers keep
// chars/4 as their common UNIT (it keeps every number comparable across days
// and versions) and reports add an honest BAND next to it.
//
// The band starts as rule-of-thumb defaults, labelled uncalibrated. Running
// `node tools/web-scout/calibrate-tokens.mjs --write` counts real tokens for
// samples of each kind with the Anthropic token-counting endpoint and stores the
// measured ratios in token-calibration.json (next to this file, or wherever
// WEBSCOUT_TOKEN_CALIBRATION points); this module picks that file up on load.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BASELINE_CHARS_PER_TOKEN = 4;
// A measured calibration older than this is reported as stale: tokenizers and the shape of what
// this tool returns both drift, and a band nobody has re-measured in a quarter is a guess again.
export const STALE_AFTER_DAYS = 90;

// chars per token: `ratio` is the central guess, `low`..`high` the range a real
// tokenizer is expected to land in. A LOWER chars-per-token ratio means MORE tokens.
export const DEFAULT_KINDS = {
  json: { ratio: 3.5, low: 2.8, high: 4.2 },
  html: { ratio: 3.2, low: 2.6, high: 3.8 },
  prose: { ratio: 4.0, low: 3.5, high: 4.6 },
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const CALIBRATION_PATH = process.env.WEBSCOUT_TOKEN_CALIBRATION || path.join(__dirname, 'token-calibration.json');

let loaded;

function loadCalibration() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CALIBRATION_PATH, 'utf8'));
    const kinds = {};
    for (const k of Object.keys(DEFAULT_KINDS)) {
      const m = parsed.kinds?.[k];
      if (m && [m.ratio, m.low, m.high].every((n) => Number.isFinite(n) && n > 0) && m.low <= m.ratio && m.ratio <= m.high) kinds[k] = { ratio: m.ratio, low: m.low, high: m.high };
    }
    return { kinds, meta: { model: parsed.model ?? null, sampledAt: parsed.sampledAt ?? null, path: CALIBRATION_PATH } };
  } catch {
    return { kinds: {}, meta: null };
  }
}

function state() {
  if (!loaded) loaded = loadCalibration();
  return loaded;
}

export function resetCalibrationCache() { loaded = undefined; }

export function kindsInUse() {
  const { kinds } = state();
  return Object.fromEntries(Object.entries(DEFAULT_KINDS).map(([k, d]) => [k, kinds[k] ?? d]));
}

// Which kind of text a command's result mostly is.
export function kindForType(type) {
  return /^(dom\.|react\.)/.test(String(type)) ? 'html' : 'json';
}

// { est, low, high } tokens for `chars` characters of `kind`. `est` follows the
// kind's central ratio; low/high bracket it.
export function estimateTokens(chars, kind = 'json') {
  const r = kindsInUse()[kind] ?? DEFAULT_KINDS.json;
  const n = Math.max(0, Number(chars) || 0);
  return { est: Math.round(n / r.ratio), low: Math.round(n / r.high), high: Math.round(n / r.low), kind };
}

// The ledger unit: what every "estTokens" elsewhere in this tool means.
export const baselineTokens = (chars) => Math.round(Math.max(0, Number(chars) || 0) / BASELINE_CHARS_PER_TOKEN);

// Range a chars/4 figure could really be, for a body of mostly `kind` text.
export function baselineBand(chars, kind = 'json') {
  const e = estimateTokens(chars, kind);
  return { baseline: baselineTokens(chars), low: e.low, high: e.high };
}

// status: 'uncalibrated' (no usable file) | 'partial' (some kinds measured) | 'stale' (measured, but
// older than STALE_AFTER_DAYS or undated) | 'calibrated'. `now` is a parameter for tests.
export function estimatorInfo({ now = Date.now() } = {}) {
  const { kinds, meta } = state();
  const calibrated = Object.keys(kinds);
  const complete = calibrated.length === Object.keys(DEFAULT_KINDS).length;
  const sampled = meta?.sampledAt ? Date.parse(meta.sampledAt) : NaN;
  const ageDays = Number.isFinite(sampled) ? Math.max(0, Math.floor((now - sampled) / 86400000)) : null;
  const status = !calibrated.length ? 'uncalibrated' : !complete ? 'partial' : ageDays === null || ageDays > STALE_AFTER_DAYS ? 'stale' : 'calibrated';
  const rerun = 'Run "node tools/web-scout/calibrate-tokens.mjs --write" (needs ANTHROPIC_API_KEY)';
  const notes = {
    uncalibrated: `no usable token-calibration.json - ranges are rule-of-thumb defaults. ${rerun} to measure them; ledgers keep reporting chars/4 either way`,
    partial: `only ${calibrated.join(', ')} are measured; the other kinds still use rule-of-thumb defaults. ${rerun} to measure all three`,
    stale: `the calibration is ${ageDays === null ? 'undated' : `${ageDays} days old (limit ${STALE_AFTER_DAYS})`}. ${rerun} to refresh it`,
    calibrated: 'ranges come from token-calibration.json; every ledger still reports chars/4 so numbers stay comparable across versions',
  };
  return {
    unit: `chars/${BASELINE_CHARS_PER_TOKEN}`,
    calibrated: complete,
    status,
    ageDays,
    staleAfterDays: STALE_AFTER_DAYS,
    calibratedKinds: calibrated,
    kinds: kindsInUse(),
    source: meta && calibrated.length ? `measured (${meta.model ?? 'unknown model'}, ${meta.sampledAt ?? 'unknown date'})` : 'uncalibrated rule-of-thumb defaults',
    note: notes[status],
  };
}
