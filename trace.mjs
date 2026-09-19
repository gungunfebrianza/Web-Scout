#!/usr/bin/env node
// Replay benchmark from REAL sessions. token-benchmark.test.mjs runs a scripted session, so
// its ratio is a best case by construction. This exports what a real session actually read
// (anonymised: every string is replaced by a same-length, same-equality stand-in, so sizes,
// structure and "is this the same value" survive but no content does) and replays it through
// the same reply pipeline the relay uses, under three strategies:
//
//   default     what callers got before shaping existed: every result in full
//   leanBest    a --lean session, callers satisfied by the shape whenever they got one
//   leanWorst   a --lean session, callers ALWAYS re-asked for the body after a shape
//
// The truth for a real caller lies between the two; the width of the band is the risk of
// turning shaping on. A guard-threshold sweep over the same trace is how the lean guard
// (LEAN_GUARD_TOKENS) is tuned from data rather than judgement.
//
//   node tools/web-scout/trace.mjs export <sessionId> --out traces/x.json.gz [--db <webscout.db>] [--keep a,b]
//   node tools/web-scout/trace.mjs replay traces/x.json.gz [more...] [--guard N] [--sweep]

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createReadPipeline, LEAN_GUARD_TOKENS } from './read-pipeline.mjs';
import { READ_CACHEABLE_TYPES } from './command-registry.mjs';

export const TRACE_VERSION = 1;
// String values under these keys are schema, not data, and are kept as they are (a keyPath
// value names a field, and the delta logic reads it). Nothing else is: equality is all a replay
// needs of a store name, a status or an enum value.
export const KEEP_KEYS = ['keyPath'];
export const SWEEP_GUARDS = [800, 1500, 2500, 4000, 8000, 16000];

// ---------- anonymising ----------

const b36 = (s) => parseInt(crypto.createHash('sha1').update(s).digest('hex').slice(0, 10), 16).toString(36);

// Same string in, same string out; distinct strings out (up to the hash's collisions); same length.
export function standIn(s) {
  const len = s.length;
  if (len === 0) return s;
  const tag = b36(s);
  if (len <= tag.length) return tag.slice(0, len).padEnd(len, 'x');
  return tag + 'x'.repeat(len - tag.length);
}

export function anonymize(value, { keep = KEEP_KEYS } = {}, key = null) {
  if (typeof value === 'string') return key !== null && keep.includes(key) ? value : standIn(value);
  if (Array.isArray(value)) return value.map((v) => anonymize(v, { keep }, key));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, anonymize(v, { keep }, k)]));
  return value;
}

// ---------- export ----------

export async function exportTrace({ dbPath, sessionId, keep = KEEP_KEYS, maxEvents = 2000 }) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const session = db.prepare('SELECT id, goal, started_at FROM sessions WHERE id = ?').get(Number(sessionId));
    if (!session) throw new Error(`no session ${sessionId} in ${dbPath}`);
    const rows = db.prepare(`
      SELECT a.id, a.type, a.ok, a.started_at,
        COALESCE(a.params_json, pb.json) AS params_json,
        COALESCE(a.result_json, rb.json) AS result_json
      FROM actions a LEFT JOIN result_blobs rb ON a.result_hash = rb.hash LEFT JOIN params_blobs pb ON a.params_hash = pb.hash
      WHERE a.session_id = ? ORDER BY a.id ASC LIMIT ?`).all(Number(sessionId), maxEvents);
    const t0 = rows.length ? Date.parse(rows[0].started_at) : 0;
    const events = rows.map((r) => {
      const cacheable = READ_CACHEABLE_TYPES.has(r.type);
      const event = { t: Date.parse(r.started_at) - t0, type: r.type, ok: !!r.ok };
      if (r.params_json) event.params = anonymize(JSON.parse(r.params_json), { keep });
      const bytes = r.result_json ? r.result_json.length : 0;
      if (cacheable && r.ok && r.result_json) event.result = anonymize(JSON.parse(r.result_json), { keep });
      else event.bytes = bytes; // not shaped, so only its size matters
      return event;
    });
    return { version: TRACE_VERSION, source: { sessionId: Number(sessionId), exportedAt: new Date().toISOString(), anonymised: true, keptKeys: keep }, events };
  } finally {
    db.close();
  }
}

export function writeTrace(file, trace) {
  const json = JSON.stringify(trace);
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, file.endsWith('.gz') ? zlib.gzipSync(json, { level: 9 }) : json);
}

export function readTrace(file) {
  const buf = fs.readFileSync(file);
  const trace = JSON.parse((file.endsWith('.gz') ? zlib.gunzipSync(buf) : buf).toString('utf8'));
  if (trace.version !== TRACE_VERSION) throw new Error(`${file}: trace version ${trace.version}, this tool reads ${TRACE_VERSION}`);
  return trace;
}

// ---------- replay ----------

// strategy: 'default' | 'leanBest' | 'leanWorst'. Only reads the page was actually asked are in a trace
// (a cache hit logs nothing), so every recorded read is a fresh one.
function runStrategy(trace, strategy, leanGuardTokens) {
  const pipeline = createReadPipeline({ bump: () => {}, now: () => 0, leanGuardTokens });
  const lean = strategy !== 'default';
  const out = { readBytes: 0, fixedBytes: 0, reads: 0, modes: {}, followUps: 0 };
  const sid = 1;
  trace.events.forEach((e, i) => {
    const isRead = READ_CACHEABLE_TYPES.has(e.type) && e.ok && e.result && typeof e.result === 'object';
    if (!isRead) { out.fixedBytes += e.bytes ?? 0; return; }
    const cacheKey = `default::${e.type}::${JSON.stringify(e.params ?? {})}`;
    const shaped = pipeline.shape({ sessionId: sid, type: e.type, agentName: 'default', params: e.params ?? {}, cacheKey, full: e.result, hit: false, actionId: i + 1, opts: {}, budget: null, lean });
    out.reads += 1;
    out.readBytes += shaped.outBytes;
    out.modes[shaped.mode] = (out.modes[shaped.mode] ?? 0) + 1;
    // leanWorst: a caller handed only the shape asks again, with --no-guard, for the body it needed
    if (strategy === 'leanWorst' && (shaped.mode === 'guard' || shaped.mode === 'peek')) {
      const again = pipeline.shape({ sessionId: sid, type: e.type, agentName: 'default', params: e.params ?? {}, cacheKey, full: e.result, hit: true, entry: { cachedAt: 'trace', actionId: i + 1 }, actionId: i + 1, opts: { noGuard: true }, budget: null, lean });
      out.readBytes += again.outBytes;
      out.followUps += 1;
    }
  });
  out.totalBytes = out.readBytes + out.fixedBytes;
  out.estTokens = Math.round(out.totalBytes / 4);
  return out;
}

export function replayTrace(trace, { leanGuardTokens = LEAN_GUARD_TOKENS } = {}) {
  const strategies = {
    default: runStrategy(trace, 'default', leanGuardTokens),
    leanBest: runStrategy(trace, 'leanBest', leanGuardTokens),
    leanWorst: runStrategy(trace, 'leanWorst', leanGuardTokens),
  };
  const base = strategies.default.readBytes || 1;
  const ratio = (s) => Math.round((s.readBytes / base) * 1000) / 1000;
  return {
    events: trace.events.length,
    reads: strategies.default.reads,
    leanGuardTokens,
    strategies,
    readRatio: { leanBest: ratio(strategies.leanBest), leanWorst: ratio(strategies.leanWorst) },
    totalRatio: {
      leanBest: Math.round((strategies.leanBest.totalBytes / (strategies.default.totalBytes || 1)) * 1000) / 1000,
      leanWorst: Math.round((strategies.leanWorst.totalBytes / (strategies.default.totalBytes || 1)) * 1000) / 1000,
    },
  };
}

export function sweepGuard(trace, guards = SWEEP_GUARDS) {
  return guards.map((g) => {
    const r = replayTrace(trace, { leanGuardTokens: g });
    return { leanGuardTokens: g, leanBest: r.readRatio.leanBest, leanWorst: r.readRatio.leanWorst };
  });
}

// ---------- CLI ----------

function flag(args, name) {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === 'export') {
    const sessionId = args[0];
    const out = flag(args, '--out');
    if (!sessionId || !out) throw new Error('usage: trace.mjs export <sessionId> --out <file.json[.gz]> [--db <webscout.db>] [--keep a,b]');
    const dbPath = flag(args, '--db') ?? path.join(path.dirname(fileURLToPath(import.meta.url)), 'webscout.db');
    const keepArg = flag(args, '--keep');
    const trace = await exportTrace({ dbPath, sessionId, keep: keepArg ? keepArg.split(',').map((s) => s.trim()) : KEEP_KEYS });
    writeTrace(out, trace);
    console.log(`wrote ${out}: ${trace.events.length} events (${trace.events.filter((e) => e.result).length} shapeable reads), ${fs.statSync(out).size} bytes on disk`);
    return;
  }
  if (cmd === 'replay') {
    const files = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--guard');
    if (!files.length) throw new Error('usage: trace.mjs replay <file...> [--guard N] [--sweep]');
    const guard = flag(args, '--guard');
    for (const file of files) {
      const trace = readTrace(file);
      const r = replayTrace(trace, guard ? { leanGuardTokens: Number(guard) } : {});
      console.log(`${file}: ${r.events} events, ${r.reads} shapeable reads`);
      for (const [name, s] of Object.entries(r.strategies)) console.log(`  ${name.padEnd(10)} reads ${s.readBytes} bytes (~${Math.round(s.readBytes / 4)} tokens), modes ${JSON.stringify(s.modes)}${s.followUps ? `, ${s.followUps} follow-ups` : ''}`);
      console.log(`  lean read bytes vs default: best ${r.readRatio.leanBest}, worst ${r.readRatio.leanWorst}  (guard ${r.leanGuardTokens} tokens)`);
      if (args.includes('--sweep')) for (const row of sweepGuard(trace)) console.log(`    guard ${String(row.leanGuardTokens).padStart(6)}: best ${row.leanBest}, worst ${row.leanWorst}`);
    }
    return;
  }
  console.log('usage: trace.mjs export <sessionId> --out <file.json[.gz]> [--db <webscout.db>] [--keep a,b]\n       trace.mjs replay <file...> [--guard N] [--sweep]');
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error('trace error:', err.message); process.exitCode = 1; });
}
