// Measures real chars-per-token from the agent's OWN transcript, with no API key.
//
// calibrate-tokens.mjs needs the Anthropic token-counting endpoint (a key and credits).
// But Claude Code already writes the real count into its transcript: every assistant message
// carries `usage` (input + cache-read + cache-creation tokens = the whole prompt that call was
// sent, plus output_tokens). When the agent runs one tool and the next assistant message
// arrives, the prompt has grown by exactly what was appended in between:
//
//   reply tokens  =  prompt(next call) - prompt(this call) - output tokens of this call
//
// and the reply's text is right there in the same file, so chars per token for that reply is
// known. One reply is noisy (system reminders and attachments ride along in the same gap), so
// only clean gaps are used - one tool call, one result, nothing else appended - and a line is
// fitted over many gaps per kind: its slope is chars per token, its intercept the constant every
// tool result carries with it.
//
// Measures the model that actually ran the session, which is the one the estimator is for. It
// is an estimate (labelled method "transcripts"), not the exact count the endpoint gives.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { kindForType, CALIBRATION_PATH, estimatorInfo, resetCalibrationCache } from './token-estimate.mjs';
import { discoverTranscripts, readTranscriptFile } from './intent-import.mjs';

export const MIN_GAP_CHARS = 300; // below this the framing/attachment noise dwarfs the signal
export const MIN_SAMPLES_PER_KIND = 8;
const HEAVY_INTERLOPER_CHARS = 200; // an attachment/system line this big in a gap makes it unusable
const PLAUSIBLE_RATIO = [1, 8]; // chars per token outside this is a measurement artefact, not text

const promptTokens = (u) => (u?.input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0);

function resultText(block) {
  const c = block?.content;
  if (typeof c === 'string') return { text: c, image: false };
  if (!Array.isArray(c)) return { text: '', image: false };
  let image = false;
  const text = c.map((b) => { if (b?.type === 'text') return b.text ?? ''; image = true; return ''; }).join('');
  return { text, image };
}

// A web-scout invocation by tool name / command text -> the kind of text its reply is, or null.
export function scoutKind(tool, input) {
  if (/^mcp__/i.test(tool) || /^webscout_/i.test(tool)) {
    const family = /webscout_(\w+)/i.exec(tool)?.[1];
    return family ? kindForType(`${family}.x`) : null;
  }
  const raw = input?.command;
  const command = Array.isArray(raw) ? raw.join(' ') : (typeof raw === 'string' ? raw : '');
  const m = /\bcli\.mjs\s+(\S+)/.exec(command);
  if (!m) return null;
  if (m[1] === 'help') return 'prose';
  return kindForType(`${m[1]}.x`);
}

// What kind of text is this? Only used with --all-tools, where the tool is not web-scout's.
export function classifyText(text) {
  const t = String(text).trimStart();
  if (t[0] === '{' || t[0] === '[') { try { JSON.parse(t); return 'json'; } catch { /* fall through */ } }
  if (t[0] === '<' && (t.match(/<\/?[a-z][^>]*>/gi) ?? []).length >= 3) return 'html';
  return 'prose';
}

// Turns a Claude Code JSONL transcript into { kind, chars, tokens } samples.
export function extractGaps(text, { allTools = false } = {}) {
  const steps = []; // main-chain assistant messages in order, each with what appeared after it
  const byId = new Map();
  const stats = { lines: 0, assistantMessages: 0, gaps: 0, used: 0, skipped: { multiTool: 0, interloper: 0, userText: 0, image: 0, noResult: 0, negative: 0, notScout: 0, small: 0 } };
  let current = null;
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim();
    if (!line || line[0] !== '{') continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    stats.lines += 1;
    if (o.isSidechain) continue;
    if (o.type === 'assistant' && o.message?.usage) {
      const id = o.message.id ?? `${o.timestamp}`;
      let step = byId.get(id);
      if (!step) {
        step = { id, usage: o.message.usage, out: 0, tools: [], after: [] };
        byId.set(id, step);
        steps.push(step);
        stats.assistantMessages += 1;
      }
      step.usage = { ...step.usage, ...o.message.usage };
      step.out = Math.max(step.out, o.message.usage.output_tokens ?? 0);
      for (const b of Array.isArray(o.message.content) ? o.message.content : []) if (b?.type === 'tool_use') step.tools.push({ id: b.id, name: String(b.name ?? ''), input: b.input });
      current = step;
    } else if (current) {
      if (o.type === 'user') {
        const blocks = Array.isArray(o.message?.content) ? o.message.content : [];
        const results = blocks.filter((b) => b?.type === 'tool_result');
        const other = blocks.filter((b) => b?.type !== 'tool_result');
        current.after.push({ kind: 'user', results, hasUserText: !results.length || other.some((b) => b?.type === 'text' && b.text?.trim().length > HEAVY_INTERLOPER_CHARS) || typeof o.message?.content === 'string' });
      } else if (o.type === 'attachment' || o.type === 'system') {
        current.after.push({ kind: 'noise', chars: JSON.stringify(o.attachment ?? o.content ?? o.message ?? '').length });
      }
    }
  }

  const samples = [];
  for (let i = 0; i + 1 < steps.length; i += 1) {
    const a = steps[i];
    const b = steps[i + 1];
    stats.gaps += 1;
    if (a.tools.length !== 1) { stats.skipped.multiTool += 1; continue; }
    const users = a.after.filter((x) => x.kind === 'user');
    if (users.length !== 1 || users[0].results.length !== 1 || users[0].results[0].tool_use_id !== a.tools[0].id) { stats.skipped.noResult += 1; continue; }
    if (users[0].hasUserText) { stats.skipped.userText += 1; continue; }
    if (a.after.some((x) => x.kind === 'noise' && x.chars > HEAVY_INTERLOPER_CHARS)) { stats.skipped.interloper += 1; continue; }
    const { text: replyText, image } = resultText(users[0].results[0]);
    if (image) { stats.skipped.image += 1; continue; }
    const kind = scoutKind(a.tools[0].name, a.tools[0].input) ?? (allTools ? classifyText(replyText) : null);
    if (!kind) { stats.skipped.notScout += 1; continue; }
    if (replyText.length < MIN_GAP_CHARS) { stats.skipped.small += 1; continue; }
    const tokens = promptTokens(b.usage) - promptTokens(a.usage) - a.out;
    if (!(tokens > 0)) { stats.skipped.negative += 1; continue; }
    samples.push({ kind, chars: replyText.length, tokens, tool: a.tools[0].name });
    stats.used += 1;
  }
  return { samples, stats };
}

const median = (xs) => { if (!xs.length) return NaN; const s = [...xs].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)))];
const round2 = (n) => Math.round(n * 100) / 100;

// Least squares tokens = a + b * chars, refit once without the points that sit more than three
// median-absolute-deviations off the line (an attachment or reminder that rode along in a gap only
// ever ADDS tokens, so outliers are one-sided).
function fitLine(rows) {
  const fit = (pts) => {
    const n = pts.length;
    const mx = pts.reduce((s, p) => s + p.chars, 0) / n;
    const my = pts.reduce((s, p) => s + p.tokens, 0) / n;
    let sxy = 0;
    let sxx = 0;
    for (const p of pts) { sxy += (p.chars - mx) * (p.tokens - my); sxx += (p.chars - mx) ** 2; }
    if (!(sxx > 0)) return null;
    const b = sxy / sxx;
    return { a: my - b * mx, b };
  };
  let line = fit(rows);
  if (!line) return null;
  const resid = (p, l) => p.tokens - (l.a + l.b * p.chars);
  const mad = median(rows.map((p) => Math.abs(resid(p, line))));
  const kept = rows.filter((p) => Math.abs(resid(p, line)) <= 3 * Math.max(mad, 1));
  if (kept.length >= 4 && kept.length < rows.length) line = fit(kept) ?? line;
  return { ...line, kept: kept.length };
}

// samples from any number of transcripts -> the same shape token-calibration.json carries.
// Per kind: chars per token is the reciprocal of the fitted slope (the intercept absorbs the
// constant a tool result carries with it - wrapper, reminder lines), and the low..high band is the
// 10th..90th percentile of the per-sample ratio with that intercept removed.
export function calibrateFromSamples({ samples, minSamples = MIN_SAMPLES_PER_KIND }) {
  const kinds = {};
  const detail = {};
  let overheadSum = 0;
  let overheadN = 0;
  for (const kind of ['json', 'html', 'prose']) {
    const rows = samples.filter((s) => s.kind === kind);
    if (rows.length < minSamples) { detail[kind] = { samples: rows.length, skipped: `fewer than ${minSamples} usable samples` }; continue; }
    const spread = Math.max(...rows.map((r) => r.chars)) / Math.max(1, Math.min(...rows.map((r) => r.chars)));
    const line = spread >= 2 ? fitLine(rows) : null;
    if (!line || !(line.b > 0)) { detail[kind] = { samples: rows.length, skipped: 'reply sizes too alike to separate per-character cost from the per-reply constant' }; continue; }
    const ratio = 1 / line.b;
    if (ratio < PLAUSIBLE_RATIO[0] || ratio > PLAUSIBLE_RATIO[1]) { detail[kind] = { samples: rows.length, skipped: `fitted ${round2(ratio)} chars/token is outside ${PLAUSIBLE_RATIO.join('..')} - the gaps are not clean enough to trust` }; continue; }
    const perSample = rows.map((r) => r.chars / (r.tokens - Math.max(0, line.a))).filter((r) => Number.isFinite(r) && r >= PLAUSIBLE_RATIO[0] && r <= PLAUSIBLE_RATIO[1]).sort((x, y) => x - y);
    const low = Math.min(ratio, perSample.length ? percentile(perSample, 0.1) : ratio);
    const high = Math.max(ratio, perSample.length ? percentile(perSample, 0.9) : ratio);
    kinds[kind] = { ratio: round2(ratio), low: round2(low), high: round2(high) };
    detail[kind] = { samples: rows.length, fitted: line.kept, perReplyConstantTokens: round2(Math.max(0, line.a)), chars: rows.reduce((n, r) => n + r.chars, 0) };
    overheadSum += Math.max(0, line.a);
    overheadN += 1;
  }
  return { kinds, detail, perReplyConstantTokens: overheadN ? round2(overheadSum / overheadN) : null };
}

export function readTranscripts(files, opts = {}) {
  const all = { samples: [], transcripts: [] };
  for (const file of files) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (err) { all.transcripts.push({ file, error: err.message }); continue; }
    const { samples, stats } = extractGaps(text, opts);
    all.samples.push(...samples);
    all.transcripts.push({ file, ...stats });
  }
  return all;
}

// The estimator's own bands stay rule-of-thumb defaults until someone remembers to run this file
// with --write - and nobody does, so token-calibration.json never gets produced. Since this
// method needs no API key, a relay can just try it itself: called once (best-effort, never
// awaited) the first time a session starts with no usable calibration on disk. Deliberately never
// touches a calibration that already exists, even a 'stale' one - a real measurement (from the
// count_tokens endpoint, or a deliberate earlier transcript run) is still better evidence than an
// unattended one, so only the 'uncalibrated' state is ever auto-filled.
export function autoCalibrateIfMissing({ limit = 40, days, homeDir = process.env.WEBSCOUT_TRANSCRIPT_HOME || undefined, minSamples = MIN_SAMPLES_PER_KIND } = {}) {
  if (estimatorInfo().status !== 'uncalibrated') return { attempted: false, reason: 'a calibration already exists (partial, stale or calibrated) - never auto-overwritten' };
  const found = discoverTranscripts({ sinceMs: Number.isFinite(days) ? Date.now() - days * 86400000 : 0, homeDir, limit }).filter((t) => t.kind === 'claude');
  if (!found.length) return { attempted: true, written: false, reason: 'no Claude Code transcripts found' };
  const { samples, transcripts } = readTranscripts(found.map((t) => t.path));
  const cal = calibrateFromSamples({ samples, minSamples });
  if (!Object.keys(cal.kinds).length) return { attempted: true, written: false, reason: `not enough clean samples across ${found.length} transcript(s)` };
  const out = { model: 'session-transcripts (mixed)', sampledAt: new Date().toISOString(), method: 'transcripts', kinds: cal.kinds, detail: cal.detail, perReplyConstantTokens: cal.perReplyConstantTokens, transcripts: transcripts.map((t) => ({ file: path.basename(t.file), ...t })) };
  fs.writeFileSync(CALIBRATION_PATH, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
  resetCalibrationCache();
  return { attempted: true, written: true, kinds: Object.keys(cal.kinds), transcriptCount: found.length };
}

// ---------- CLI ----------
//
//   node tools/web-scout/transcript-tokens.mjs [file.jsonl ...] [--write] [--days N]
//                                               [--limit N] [--all-tools] [--min-samples N] [--home <dir>]
//
// No files given: auto-discovers this machine's own Claude Code transcripts (newest first, same
// files "session intents" already reads) instead of the count_tokens endpoint - no key needed.
// --all-tools widens sampling to every tool call, not only web-scout's own (classified by content
// shape instead of by command), which is useful once a repo has few web-scout calls of its own yet.

function flag(args, name) {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

async function main() {
  const args = process.argv.slice(2);
  const write = args.includes('--write');
  const allTools = args.includes('--all-tools');
  const minSamples = Number(flag(args, '--min-samples')) || MIN_SAMPLES_PER_KIND;
  const limit = Number(flag(args, '--limit')) || 40;
  const days = Number(flag(args, '--days'));
  const homeDir = flag(args, '--home');
  const explicit = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--min-samples' && args[i - 1] !== '--limit' && args[i - 1] !== '--days' && args[i - 1] !== '--home');

  let files;
  if (explicit.length) {
    files = explicit.map((f) => path.resolve(f));
    for (const f of files) readTranscriptFile(f); // throws early on a bad path/size, same guard "session intents" uses
  } else {
    const found = discoverTranscripts({ sinceMs: Number.isFinite(days) ? Date.now() - days * 86400000 : 0, homeDir, limit }).filter((t) => t.kind === 'claude');
    if (!found.length) { console.error('no Claude Code transcripts found (pass file paths explicitly, or check --home).'); process.exitCode = 1; return; }
    files = found.map((t) => t.path);
  }

  const { samples, transcripts } = readTranscripts(files, { allTools });
  const cal = calibrateFromSamples({ samples, minSamples });
  const out = { model: 'session-transcripts (mixed)', sampledAt: new Date().toISOString(), method: 'transcripts', kinds: cal.kinds, detail: cal.detail, perReplyConstantTokens: cal.perReplyConstantTokens, transcripts: transcripts.map((t) => ({ file: path.basename(t.file), ...t })) };
  console.log(JSON.stringify(out, null, 2));
  if (!Object.keys(cal.kinds).length) { console.error(`nothing calibrated from ${files.length} transcript(s) - not enough clean web-scout reply samples yet (try --all-tools, or a longer --days window).`); process.exitCode = 1; return; }
  if (write) {
    fs.writeFileSync(CALIBRATION_PATH, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
    console.error(`wrote ${CALIBRATION_PATH} (method: transcripts, from ${files.length} transcript file(s), no API key used)`);
  } else {
    console.error('dry run - pass --write to store these ratios.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => { console.error(`transcript-tokens: ${err.message}`); process.exitCode = 1; });
}
