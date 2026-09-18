#!/usr/bin/env node
// Measures real chars-per-token for the three kinds of text this tool moves
// (JSON results, HTML, prose) so token-estimate.mjs can put an honest band next
// to its chars/4 figures. Counting uses the Anthropic token-counting endpoint, so
// it needs ANTHROPIC_API_KEY and network; it is a manual, occasional step, never
// part of the test run.
//
//   node tools/web-scout/calibrate-tokens.mjs [--write] [--samples 20] [--model <id>]
//
// Samples are drawn from the relay's own recorded sessions (JSON = action
// results, HTML = dom.query outerHTML) and from README.md (prose). Without
// --write it only prints what it measured.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const KINDS = ['json', 'html', 'prose'];

function percentile(sorted, p) {
  if (!sorted.length) return NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)));
  return sorted[i];
}

const round2 = (n) => Math.round(n * 100) / 100;

// samples: { json: [text...], html: [...], prose: [...] }; countTokens: async (text) => number
// (a real counter adds a few tokens of message framing - measured once with a
// one-token message and subtracted).
export async function calibrateKinds({ samples, countTokens }) {
  const overhead = Math.max(0, (await countTokens('.')) - 1);
  const kinds = {};
  const detail = {};
  for (const kind of KINDS) {
    const ratios = [];
    let chars = 0;
    let tokens = 0;
    for (const text of samples[kind] ?? []) {
      if (!text || text.length < 40) continue;
      const counted = (await countTokens(text)) - overhead;
      if (!(counted > 0)) continue;
      ratios.push(text.length / counted);
      chars += text.length;
      tokens += counted;
    }
    if (ratios.length < 3) { detail[kind] = { samples: ratios.length, skipped: 'fewer than 3 usable samples' }; continue; }
    ratios.sort((a, b) => a - b);
    const ratio = chars / tokens;
    const low = Math.min(ratio, percentile(ratios, 0.1));
    const high = Math.max(ratio, percentile(ratios, 0.9));
    kinds[kind] = { ratio: round2(ratio), low: round2(low), high: round2(high) };
    detail[kind] = { samples: ratios.length, chars, tokens };
  }
  return { kinds, detail };
}

export function makeApiCounter({ apiKey, model = DEFAULT_MODEL, fetchImpl = fetch } = {}) {
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set - token counting needs it');
  return async function countTokens(text) {
    const res = await fetchImpl('https://api.anthropic.com/v1/messages/count_tokens', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: text }] }),
    });
    const body = await res.json();
    if (!res.ok || typeof body.input_tokens !== 'number') throw new Error(`count_tokens failed (${res.status}): ${JSON.stringify(body).slice(0, 200)}`);
    return body.input_tokens;
  };
}

// Draws samples from what this tool actually produced. `get` is the relay client's request().
export async function gatherSamples({ get, maxPerKind = 20, readmePath = path.join(__dirname, 'README.md') }) {
  const samples = { json: [], html: [], prose: [] };
  let sessions = [];
  try { sessions = (await get('GET', '/sessions')).slice(0, 6); } catch { /* relay not running - prose only */ }
  for (const s of sessions) {
    if (samples.json.length >= maxPerKind && samples.html.length >= maxPerKind) break;
    let actions = [];
    try { actions = await get('GET', `/sessions/${s.id}/actions?full=1&limit=300`); } catch { continue; }
    for (const a of actions) {
      if (!a.ok || a.result == null) continue;
      const text = JSON.stringify(a.result);
      if (text.length >= 200 && samples.json.length < maxPerKind) samples.json.push(text.slice(0, 6000));
      const html = a.type === 'dom.query' && typeof a.result?.outerHTML === 'string' ? a.result.outerHTML : null;
      if (html && html.length >= 200 && samples.html.length < maxPerKind) samples.html.push(html.slice(0, 6000));
    }
  }
  try {
    const paragraphs = fs.readFileSync(readmePath, 'utf8').split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p.length >= 200 && !p.startsWith('|') && !p.startsWith('```'));
    samples.prose = paragraphs.slice(0, maxPerKind);
  } catch { /* no README - prose skipped */ }
  return samples;
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name) => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1]; };
  const write = args.includes('--write');
  const model = flag('--model') || DEFAULT_MODEL;
  const maxPerKind = Number(flag('--samples')) || 20;
  const { request } = await import('./client.mjs');
  const { CALIBRATION_PATH } = await import('./token-estimate.mjs');
  const countTokens = makeApiCounter({ apiKey: process.env.ANTHROPIC_API_KEY, model });
  const samples = await gatherSamples({ get: (m, p) => request(m, p, undefined, { autostart: false }), maxPerKind });
  const { kinds, detail } = await calibrateKinds({ samples, countTokens });
  const out = { model, sampledAt: new Date().toISOString(), kinds, detail };
  console.log(JSON.stringify(out, null, 2));
  if (!Object.keys(kinds).length) { console.error('nothing calibrated - not enough samples (start a few sessions first).'); process.exitCode = 1; return; }
  if (write) {
    fs.writeFileSync(CALIBRATION_PATH, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
    console.error(`wrote ${CALIBRATION_PATH}`);
  } else {
    console.error('dry run - pass --write to store these ratios.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => { console.error(`calibrate-tokens: ${err.message}`); process.exitCode = 1; });
}
