#!/usr/bin/env node
// Web-scout relay - a local, dependency-free WebSocket<->HTTP bridge between
// the in-page agent(s) (tools/web-scout/inject.js, injected into index.html,
// dormant unless explicitly activated) and the CLI (tools/web-scout/cli.mjs)
// that Claude Code invokes via Bash.
//
// Binds 127.0.0.1 ONLY - never 0.0.0.0 - so this control channel is never
// reachable from the network. See tools/web-scout/README.md for the full
// security model and non-goals; this is a companion, higher-privilege
// sibling to tools/ui-verifier (Verity UI Relay), not a replacement for it.
//
// No npm dependencies (matches this repo's existing zero-dependency
// convention for tools/ui-verifier) - the WebSocket server is hand-rolled
// on top of node:http's 'upgrade' event. It supports exactly what this
// control channel needs: single-frame, unfragmented text messages up to a
// 64-bit declared length. It does not implement permessage-deflate, ping/
// pong keepalive, or fragmented messages - none of those are needed for
// short-lived JSON control messages on localhost.
//
// Session gating: every /command dispatch requires an active session (goal
// declared first, evidentiary discipline - not tools/ui-verifier's
// safety-gate model, see README). Every dispatch, snapshot, diff, ask, and
// console/net capture batch gets persisted via tools/web-scout/db.mjs, and
// GET /events (Server-Sent Events) pushes a live "something changed" signal
// to the dashboard after every one of those writes.

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { exec, execSync, spawnSync } from 'node:child_process';
import * as dbApi from './db.mjs';
import { buildPrompt, askAI, DEFAULT_BACKEND_URL } from './ai.mjs';
import { buildReportMarkdown, buildReportJson } from './report.mjs';
// Which command types are strict-CRV / mutating / macro-replayed / long-polling /
// read-cacheable / timeout-verifiable / auto-screenshotted is declared once, per
// type, in command-registry.mjs - see its header for each flag's meaning.
import {
  STRICT_CRV_TYPES, LONG_POLL_TYPES, DEFAULT_MACRO_TYPES, TIMEOUT_VERIFIABLE_TYPES,
  AUTO_SCREENSHOT_ON_FAILURE_TYPES, READ_CACHEABLE_TYPES, MUTATING_TYPES, COMMAND_TYPES,
} from './command-registry.mjs';
import { RELAY_SOURCE_FILES, writePidfile, removePidfile, readPidfile, pidAlive, recordRelayEvent, readRelayEvents, summarizeRelayEvents, registerRelay, unregisterRelay, reapLeakedRelays } from './relay-control.mjs';
import { currentInjectBuild } from './build-id.mjs';
import { createReadPipeline, readTargetKey, SCOPING_PARAM_KEYS, FOLLOW_UP_WINDOW_MS, budgetLevel, BUDGET_TIGHTEN_PCT, BUDGET_STRICT_PCT, LEAN_GUARD_TOKENS } from './read-pipeline.mjs';
import { sizeOf } from './read-shape.mjs';
import { estimatorInfo, baselineBand } from './token-estimate.mjs';
import { parseExpect, buildVerifyReport, sampleStoreDiff } from './crv-verify.mjs';
import { buildSessionViz, buildWaste, diffCausality } from './session-viz.mjs';
import { discoverTranscripts, readTranscriptFile, importIntents } from './intent-import.mjs';
import { exportTrace, writeTrace } from './trace.mjs';
import { autoCalibrateIfMissing } from './transcript-tokens.mjs';
import * as repairApi from './self-repair.mjs';
import * as hostHealth from './host-health.mjs';
import * as friction from './friction.mjs';
import * as notices from './notices.mjs';
import { frictionRoutes } from './routes-friction.mjs';
import { macroRoutes } from './routes-macros.mjs';
import { stateRoutes } from './routes-state.mjs';
import { sessionsRoutes } from './routes-sessions.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOST = '127.0.0.1';
const PORT = Number(process.env.WEBSCOUT_PORT || 8973);
// True only when this file is the actual process entry point (`node relay.mjs`, or a subprocess
// spawned that way - startTestRelay/startRelay both do this). False for a plain `import('./relay.mjs')`
// - a syntax check, or any other programmatic import - so that alone can never bind a port.
// Confirmed real, twice: a `node -e "import('./relay.mjs')..."` syntax-check attempt actually ran
// the whole module, including the unconditional server.listen() this guard now wraps.
const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
// Bumped alongside docs/web-scout-roadmap.md's latest "## VN" entry - purely
// informational (the dashboard's About panel), never read by any behavior.
const WEBSCOUT_VERSION = '0.26.0'; // bumped alongside docs/web-scout-roadmap.md's V39 entry
const COMMAND_TIMEOUT_MS = 15000; // interactive dom/net/eval round trips
const SNAPSHOT_TIMEOUT_MS = 60000; // bulk idb.snapshot reads can be large
// Short, independent budgets for two round trips that must never inherit
// COMMAND_TIMEOUT_MS's full 15s: PING_TIMEOUT_MS backs POST /ping, a
// deliberately cheap liveness probe (see inject.js's 'ping' handler) meant
// to answer "is the page thread even responding" fast, not after paying the
// same wait as a real dom/eval command. DB_VERSION_DRIFT_TIMEOUT_MS backs
// GET /health's own db.version check - confirmed live to drag /health
// itself (meant to be a cheap status read, polled by the dashboard every
// few seconds) down to 15s whenever the connected tab was slow/unresponsive,
// exactly when a fast /health reply mattered most for diagnosing that.
const PING_TIMEOUT_MS = 3000;
const DB_VERSION_DRIFT_TIMEOUT_MS = 3000;
const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const DEFAULT_AGENT = 'default';
// macro run's cross-context guard threshold (see the route below) - a
// crude, deliberately cheap Jaccard-similarity-of-goal-words check, not
// real NLP. Low enough that two genuinely related goals ("verify P3.8
// candidate promotion" / "re-check P3.8 promotion after a fix") still pass
// without friction; low similarity is the actual signal worth blocking on
// (e.g. a macro recorded for "delete synthetic test rows" about to run
// against "verify production-mirroring dev session").
const MACRO_CONTEXT_SIMILARITY_THRESHOLD = 0.15;
// Same-session read-result cache (token-waste lever #10): a read call whose
// target provably cannot have changed since the last identical call in this
// SAME session - no mutating command ran in between - is answered from
// cache instead of re-dispatching to the page and re-logging a new action
// row. Deliberately narrow: only calls with no wait/poll semantics of their
// own (dom.wait/idb.wait/net.wait/console.wait must always actually check
// live state, caching them would be a correctness bug, not an optimization)
// and no side-effect risk (eval is excluded even though many eval calls are
// read-only, because this file cannot tell a read eval from a write eval).
// idb.snapshot is dispatched via POST /state/snapshot, never this route -
// not applicable here either way.
const sessionMutationCounters = new Map(); // sessionId -> counter, bumped on every MUTATING_TYPES dispatch
const readResultCache = new Map(); // sessionId -> Map(`${agent}::${type}::${JSON.stringify(params)}` -> { result, mutationCounter, pageEpoch, cachedAt })
// Cache-hit counts/bytes are persisted (db.mjs's bumpReadCacheSavings), so the
// savings shown by GET /token-report and the dashboard survive a relay restart.
// A cache hit skips withLoggedAction entirely (see both cache-hit sites
// below) - no actions row, so dbApi.getSessionTokensSoFar (which sums the
// actions table) never sees those bytes. But the cached result is still
// returned in THIS reply's body and the calling agent still reads it off
// stdout - so the running x-webscout-session-tokens total was silently
// UNDERcounting a session with any cache hits. Tracked per-session (not
// just the global persisted counter above) so the generic
// response wrapper can add exactly the right session's share back in.
const sessionCacheHitBytes = new Map(); // sessionId -> bytes
const lastReportedSessionTokens = new Map(); // sessionId -> last running total sent in x-webscout-session-tokens
const NOTABLE_CALL_TOKENS = 1000;
const tokenMilestone = (tokens) => (tokens < 5000 ? 0 : Math.floor(Math.log2(tokens / 5000)) + 1);

function getMutationCounter(sessionId) {
  return sessionMutationCounters.get(sessionId) || 0;
}
function bumpMutationCounter(sessionId) {
  sessionMutationCounters.set(sessionId, getMutationCounter(sessionId) + 1);
}

// inject.js stamps every reply with its page-change counter (pageEpoch). The
// result object is the join key: it passes through withLoggedAction by
// reference, so the cache can read the epoch without threading it through
// every return shape.
const replyEpochs = new WeakMap();
let readCachePageStaleMisses = 0; // hits the page-change probe turned into misses (this relay run)

const replyAvoided = new WeakMap(); // reply result -> bytes a scoped read left out (inject.js ctx.avoidedBytes)
const sessionSavingsTally = new Map(); // sessionId -> { scopedCalls, avoidedBytes, cacheHits, cacheBytes, shapedCalls, shapedBytes } for the end-of-session receipt

function tally(sessionId) {
  if (!sessionSavingsTally.has(sessionId)) sessionSavingsTally.set(sessionId, { scopedCalls: 0, avoidedBytes: 0, cacheHits: 0, cacheBytes: 0, shapedCalls: 0, shapedBytes: 0 });
  return sessionSavingsTally.get(sessionId);
}

// `bytes` is the size of the cached result (the page round trip skipped);
// `deliveredBytes` is what the caller actually received, which is smaller when a
// pointer/peek/table replaced the body - and is what the running total counts.
function noteCacheHit(sessionId, bytes, deliveredBytes = bytes) {
  dbApi.bumpReadCacheSavings(bytes);
  sessionCacheHitBytes.set(sessionId, (sessionCacheHitBytes.get(sessionId) || 0) + deliveredBytes);
  const t = tally(sessionId);
  t.cacheHits += 1;
  t.cacheBytes += bytes;
}

// A logged action always records the FULL result; when a shaped reply (peek, table,
// delta, pointer) sent the caller less, the action row also records what was
// delivered (dbApi.setActionDelivered), and every token total reads that number.
// Cache hits have no action row, so their delivered bytes are tallied here.
//
// The session's running estimated-token total, as the client prints it: what the
// logged actions delivered + what cache hits delivered.
function sessionRunningTokens(sessionId) {
  const extraBytes = sessionCacheHitBytes.get(sessionId) || 0;
  return Math.max(0, dbApi.getSessionTokensSoFar(sessionId) + Math.round(extraBytes / dbApi.CHARS_PER_TOKEN_ESTIMATE));
}

const readPipeline = createReadPipeline({ bump: (key, bytes) => dbApi.bumpSavingsDaily(key, bytes) });
const READ_GUARD_ENV_TOKENS = Number(process.env.WEBSCOUT_READ_GUARD_TOKENS);

const replyOutlineOld = new WeakMap(); // reply result -> bytes the pre-outline default reply would have been (inject.js ctx.outlineOldBytes)

// Was scoping enough? See SCOPING_PARAM_KEYS in read-pipeline.mjs: a scoped read
// followed within the window by the same read on the same tab WITHOUT the
// narrowing params means the caller paid for the rest anyway.
const UNSCOPED_FOLLOW_UP_WINDOW_MS = FOLLOW_UP_WINDOW_MS;
const recentScopedReads = new Map(); // `${agent}::${type}::${target}` -> ms
const recentOutlines = new Map(); // agent -> { selector, at }

function prune(map, now) {
  if (map.size < 200) return;
  for (const [k, v] of map) if (now - (typeof v === 'number' ? v : v.at) > UNSCOPED_FOLLOW_UP_WINDOW_MS) map.delete(k);
}

function noteScopedRead(sessionId, result, { agentName = DEFAULT_AGENT, type, params } = {}) {
  const isObj = result && typeof result === 'object';
  const avoided = isObj ? replyAvoided.get(result) : undefined;
  const now = Date.now();
  if (type === 'dom.query' && isObj) {
    const selector = String(params?.selector ?? '');
    const prev = recentOutlines.get(agentName);
    if (prev && now - prev.at <= UNSCOPED_FOLLOW_UP_WINDOW_MS && !Array.isArray(result.outline)) {
      // the next dom.query on this tab after an outline: the same selector with --full says the outline was not enough, any other selector says it worked as a map
      if (selector === prev.selector && params?.full) dbApi.bumpSavingsDaily('outlineFollowFull', 0);
      else if (selector !== prev.selector) dbApi.bumpSavingsDaily('outlineFollowDrill', 0);
      recentOutlines.delete(agentName);
    }
    if (Array.isArray(result.outline)) {
      dbApi.bumpSavingsDaily('outline', JSON.stringify(result).length);
      dbApi.bumpSavingsDaily('outlineOldDefault', replyOutlineOld.get(result) ?? 0);
      recentOutlines.set(agentName, { selector, at: now });
      prune(recentOutlines, now);
    }
  }
  if (type && SCOPING_PARAM_KEYS[type] && isObj) {
    const target = `${agentName}::${type}::${readTargetKey(type, params)}`;
    if (avoided) {
      recentScopedReads.set(target, now);
      prune(recentScopedReads, now);
    } else if (now - (recentScopedReads.get(target) ?? -Infinity) <= UNSCOPED_FOLLOW_UP_WINDOW_MS) {
      recentScopedReads.delete(target);
      dbApi.bumpSavingsDaily('reReadAfterScoped', JSON.stringify(result).length);
    }
  }
  if (!avoided) return;
  dbApi.bumpSavingsDaily('scopedReads', avoided);
  const t = tally(sessionId);
  t.scopedCalls += 1;
  t.avoidedBytes += avoided;
}

const readCacheKey = (agentName, type, params) => (READ_CACHEABLE_TYPES.has(type) ? `${agentName}::${type}::${JSON.stringify(params ?? {})}` : null);

// A hit needs the relay-side mutation counter unchanged AND the page's own
// change counter unchanged: a page that moved on its own (fetch landed, timer
// re-render, app wrote IndexedDB) must not be answered from the cache. The
// probe is one tiny round trip - the saving is the read's payload, not the trip.
async function lookupReadCache(sessionId, cacheKey, agentName) {
  const cached = readResultCache.get(sessionId)?.get(cacheKey);
  if (!cached || cached.mutationCounter !== getMutationCounter(sessionId)) return null;
  if (cached.pageEpoch === undefined) return cached; // page predates page.epoch - relay-side check only
  try {
    const { epoch } = await dispatchCommand('page.epoch', {}, PING_TIMEOUT_MS, agentName);
    if (epoch === cached.pageEpoch) return cached;
  } catch { /* unreachable page: fall through to a real dispatch, which reports the real error */ }
  readResultCache.get(sessionId)?.delete(cacheKey);
  readCachePageStaleMisses += 1;
  return null;
}

function storeReadCache(sessionId, cacheKey, result, actionId) {
  if (!readResultCache.has(sessionId)) readResultCache.set(sessionId, new Map());
  const pageEpoch = result && typeof result === 'object' ? replyEpochs.get(result) : undefined;
  readResultCache.get(sessionId).set(cacheKey, { result, actionId, mutationCounter: getMutationCounter(sessionId), pageEpoch, cachedAt: new Date().toISOString() });
}

// Token budget for the active session (--token-budget): its level drives the read
// guard and tabular output in read-pipeline.mjs. null when no budget was declared.
function currentBudget(session) {
  return budgetLevel(session.token_budget, sessionRunningTokens(session.id));
}

function goalWordSet(goal) {
  return new Set(String(goal ?? '').toLowerCase().match(/[a-z0-9]+/g) ?? []);
}

function jaccardSimilarity(setA, setB) {
  if (!setA.size && !setB.size) return 1;
  let intersection = 0;
  for (const w of setA) if (setB.has(w)) intersection += 1;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    // Additive, optional sidecar data for a failure response - e.g. the
    // post-timeout verification dispatchTracked() attaches below. Never
    // required; every existing HttpError call site (two-arg) is unaffected.
    if (extra) this.extra = extra;
  }
}

const agents = new Map(); // name -> { socket, buffer, connectedAt, origin, replacedCount, lastReplacedAt, ... }
// A replacement this recent is a live fight between two tabs sharing one agent name; an older one
// is history (a tab reloaded, or a stale tab finally closed) and shouldn't keep raising the alarm.
const TAB_COLLISION_WINDOW_MS = 5 * 60 * 1000;
const pending = new Map(); // command id -> { resolve, reject, timer, agentName }
let nextCommandId = 1;
const sseClients = new Set(); // open dashboard EventSource responses

function log(...args) {
  console.log('[web-scout relay]', ...args);
}

// ---------- Stale-relay detection ----------
//
// Node loads relay.mjs/db.mjs/... once at boot, so an edit to any of them is
// invisible to this running process until it restarts - a real session ran
// "24/24 pass" against a relay still executing the code from BEFORE the edit.
// Recorded once at boot; compared against the files' current mtimes at
// most every STALE_CHECK_TTL_MS so this stays off the hot path of every reply.
const RELAY_STARTED_AT = new Date();
const bootSourceMtimes = new Map();
for (const f of RELAY_SOURCE_FILES) {
  try { bootSourceMtimes.set(f, fs.statSync(path.join(__dirname, f)).mtimeMs); } catch { /* optional file */ }
}
const STALE_CHECK_TTL_MS = 2000;
let staleCheckCache = { at: 0, files: [] };
function getStaleSourceFiles() {
  const now = Date.now();
  if (now - staleCheckCache.at < STALE_CHECK_TTL_MS) return staleCheckCache.files;
  const files = [];
  for (const [f, bootMtime] of bootSourceMtimes) {
    try { if (fs.statSync(path.join(__dirname, f)).mtimeMs > bootMtime) files.push(f); } catch { /* deleted mid-run */ }
  }
  staleCheckCache = { at: now, files };
  return files;
}

// ---------- Realtime dashboard push (SSE) ----------
//
// One-way server->dashboard push over plain node:http (no ws needed for
// this direction) - broadcasts a "something changed" signal, never the
// full row payload, so the dashboard re-fetches via the same GET endpoints
// already used for the initial load (no duplicated serialization logic).
// `res.on('close')` alone is sufficient cleanup (confirmed fires reliably
// on an abrupt disconnect) - no need for a matching req-side listener too.

function broadcastUpdate(kind, sessionId, extra = {}) {
  if (kind === 'macro' || kind === 'analytics') macroCandidateCache = null; // the nudge's candidates read through this cache
  const payload = `event: update\ndata: ${JSON.stringify({ kind, sessionId, ...extra })}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      sseClients.delete(res);
    }
  }
}

// Opens the dashboard in the OS default browser whenever a session starts -
// the discrete "a human should be watching now" moment - so the operator
// notices Claude Code/Codex is actively using Web-scout instead of finding
// out only by reading a report after the fact. Best-effort: a headless/CI
// environment with no browser/open-handler just logs and continues: never
// blocks or fails the session-start request itself. Set
// WEBSCOUT_NO_AUTOOPEN=1 to disable (e.g. a long-lived background relay
// shared by many short sessions).
function openDashboardInBrowser() {
  if (process.env.WEBSCOUT_NO_AUTOOPEN === '1') return;
  const url = `http://${HOST}:${PORT}/dashboard`;
  const cmd =
    process.platform === 'win32' ? `start "" "${url}"` :
    process.platform === 'darwin' ? `open "${url}"` :
    `xdg-open "${url}"`;
  exec(cmd, (err) => {
    if (err) console.error('web-scout: could not auto-open dashboard:', err.message);
  });
}

// ---------- WebSocket framing (server<->client, text frames only) ----------

function encodeTextFrame(str) {
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function encodeCloseFrame() {
  return Buffer.from([0x88, 0x00]);
}

// Parses ONE frame off the front of `buf`. Returns null if `buf` does not
// yet contain a complete frame. Client->server frames are always masked
// per RFC 6455 - a well-behaved browser WebSocket client always masks, and
// an unmasked client frame is rejected as a protocol violation.
function decodeFrame(buf) {
  if (buf.length < 2) return null;
  const b0 = buf[0];
  const b1 = buf[1];
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  let len = b1 & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    len = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }
  if (!masked) return { error: 'unmasked client frame rejected', bytesConsumed: buf.length };
  if (buf.length < offset + 4) return null;
  const maskKey = buf.subarray(offset, offset + 4);
  offset += 4;
  if (buf.length < offset + len) return null;
  const rawPayload = buf.subarray(offset, offset + len);
  const payload = Buffer.alloc(len);
  for (let i = 0; i < len; i += 1) payload[i] = rawPayload[i] ^ maskKey[i % 4];
  return { opcode, text: payload.toString('utf8'), bytesConsumed: offset + len };
}

function sendToAgent(obj, agentName) {
  const agent = agents.get(agentName);
  if (!agent || agent.socket.destroyed) throw new HttpError(502, `no web-scout agent named '${agentName}' connected - open the target page with the activation flag first${agentName !== DEFAULT_AGENT ? ` (?webscout_name=${agentName})` : ''}`);
  agent.socket.write(encodeTextFrame(JSON.stringify(obj)));
}

// ---------- Command <-> agent round trip ----------

// origin.hostname, tolerant of a malformed/legacy origin string (a tab
// connected before this round's inject.js sends none, handled by the null
// check at each call site, never here).
function safeHostname(origin) {
  try { return new URL(origin).hostname; } catch { return null; }
}

// The two safety checks this round's real CRV incident named directly: (1) a
// session pinned to the origin its own agent reported at "session start" now
// refuses a command dispatched while that SAME agent name is connected from a
// DIFFERENT origin (the 127.0.0.1-vs-localhost mixup that went undetected for
// ~68 calls); (2) a MUTATING command (or eval) refuses against a non-local
// origin unless the session opted in - a stray tab on a real/production site
// must never receive a synthetic write. Both are advisory-strength by this
// tool's own non-goal ("no authorization boundary between agents") - null/
// unknown origin never blocks, and (2) has an explicit opt-out
// (`session start --allow-remote`), never a hard wall nothing can lift.
// Reads the CURRENT session fresh (not threaded as a parameter) so this
// fires for every real dispatch path (dispatchTracked's /command and
// /crv/run, but also /state/snapshot's and /state/restore's own direct
// dispatchCommand calls) rather than only the one caller that happens to
// have a `session` object in scope - a session-less dispatch (briefing,
// ping, before any "session start") has no pin to check against and is
// never blocked here.
function guardDispatchOrigin(type, agentName) {
  const session = dbApi.getCurrentSession();
  if (!session) return;
  const liveOrigin = agents.get(agentName)?.origin ?? null;
  if (session.pinned_origin && liveOrigin && session.pinned_origin !== liveOrigin) {
    throw new HttpError(409, `this session (#${session.id}) was pinned to ${session.pinned_origin} at "session start", but agent '${agentName}' is currently connected from ${liveOrigin} - a full navigation (not a same-page route change) moved it to a different origin, which is also a different IndexedDB. Start a new session against this origin, or reconnect the tab back to ${session.pinned_origin} first.`);
  }
  if ((MUTATING_TYPES.has(type) || type === 'eval') && !session.allow_remote) {
    const hostname = liveOrigin ? safeHostname(liveOrigin) : null;
    if (hostname && hostname !== 'localhost' && hostname !== '127.0.0.1') {
      throw new HttpError(403, `refusing to run '${type}' (a write/eval) against a non-local origin (${liveOrigin}) on agent '${agentName}' - this looks like a real site, not a local dev app. If this is genuinely intended, start the session with --allow-remote.`);
    }
  }
}

function dispatchCommand(type, params, timeoutMs = COMMAND_TIMEOUT_MS, agentName = DEFAULT_AGENT) {
  guardDispatchOrigin(type, agentName);
  return new Promise((resolve, reject) => {
    const id = nextCommandId;
    nextCommandId += 1;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new HttpError(504, `command '${type}' timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer, agentName });
    try {
      sendToAgent({ kind: 'command', id, type, params }, agentName);
    } catch (err) {
      clearTimeout(timer);
      pending.delete(id);
      reject(err);
    }
  });
}

// Handles both request/reply pairs (existing) and fire-and-forget `event`
// batches (console/net capture - see tools/web-scout/inject.js). A reply
// is only honored if it came from the SAME agent the command was
// dispatched to - cheap hardening once multiple sockets share one global
// command-id space.
function handleAgentMessage(text, agentName) {
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    log('agent sent non-JSON message, ignoring');
    return;
  }
  if (msg.kind === 'reply' && typeof msg.id === 'number') {
    const entry = pending.get(msg.id);
    if (!entry) return;
    if (entry.agentName !== agentName) {
      log(`reply for command ${msg.id} arrived from agent '${agentName}' but was dispatched to '${entry.agentName}', ignoring`);
      return;
    }
    clearTimeout(entry.timer);
    pending.delete(msg.id);
    // Any reply at all - ok or failed - proves the page's JS thread is
    // actually processing messages right now, which raw socket presence
    // does not (see agentsDetail() above).
    const agentEntry = agents.get(agentName);
    if (agentEntry) {
      agentEntry.lastAckAt = Date.now();
      if (typeof msg.path === 'string' && msg.path) agentEntry.path = msg.path.slice(0, 300); // the route the tab is on NOW (SPA navigations)
    }
    if (msg.ok) {
      if (msg.result && typeof msg.result === 'object') {
        if (typeof msg.epoch === 'number') replyEpochs.set(msg.result, msg.epoch);
        if (typeof msg.avoided === 'number' && msg.avoided > 0) replyAvoided.set(msg.result, msg.avoided);
        if (typeof msg.outlineOld === 'number') replyOutlineOld.set(msg.result, msg.outlineOld);
      }
      entry.resolve(msg.result);
    }
    else entry.reject(new Error(msg.error || 'agent command failed'));
    return;
  }
  if (msg.kind === 'event' && (msg.type === 'console' || msg.type === 'net') && Array.isArray(msg.entries) && msg.entries.length) {
    const session = dbApi.getCurrentSession();
    if (!session) return; // dropped - no active session, matches "context before action"
    try {
      if (msg.type === 'console') dbApi.insertConsoleEntries(session.id, agentName, msg.entries);
      else dbApi.insertNetEntries(session.id, agentName, msg.entries);
      broadcastUpdate(msg.type, session.id);
    } catch (err) {
      log(`failed to persist ${msg.type} event batch:`, err.message);
    }
  }
}

// ---------- Diffing (relay-side, generic per store's own real keyPath -
// not every store in this app's IndexedDB layer uses keyPath: 'id', see
// js/db.js) ----------

function keyOf(row, keyPath) {
  if (Array.isArray(keyPath)) return JSON.stringify(keyPath.map((k) => row?.[k]));
  return JSON.stringify(row?.[keyPath]);
}

function computeDiff(beforeStores, afterStores) {
  const names = new Set([...Object.keys(beforeStores || {}), ...Object.keys(afterStores || {})]);
  const diff = {};
  for (const name of names) {
    const beforeEntry = beforeStores?.[name] ?? { keyPath: afterStores?.[name]?.keyPath ?? 'id', rows: [] };
    const afterEntry = afterStores?.[name] ?? { keyPath: beforeEntry.keyPath, rows: [] };
    const keyPath = afterEntry.keyPath ?? beforeEntry.keyPath ?? 'id';
    const beforeMap = new Map(beforeEntry.rows.map((r) => [keyOf(r, keyPath), r]));
    const afterMap = new Map(afterEntry.rows.map((r) => [keyOf(r, keyPath), r]));
    const added = [];
    const removed = [];
    const changed = [];
    for (const [k, row] of afterMap) {
      if (!beforeMap.has(k)) added.push(row);
      else if (JSON.stringify(beforeMap.get(k)) !== JSON.stringify(row)) changed.push({ key: k, before: beforeMap.get(k), after: row });
    }
    for (const [k, row] of beforeMap) {
      if (!afterMap.has(k)) removed.push(row);
    }
    if (added.length || removed.length || changed.length) {
      diff[name] = { keyPath, added, removed, changed };
    }
  }
  return diff;
}

function summarizeDiff(diff) {
  const summary = {};
  for (const [name, d] of Object.entries(diff)) {
    summary[name] = { added: d.added.length, removed: d.removed.length, changed: d.changed.length };
  }
  return summary;
}

// Collapses a cleanup dry-run/confirm row list (pendingDeletes/deleted/
// failed/changedNotDeleted - each an array of {store, ...}) down to a
// per-store count - "session cleanup --summary" against a store with a
// large diff used to mean an 11K+-token wall of full rows just to see "6
// rows in store X" before ever asking for the detail. Also totals an
// estBytes/estTokens per store (Buffer.byteLength on the `row`/`before`+
// `after` already sitting in memory - never a fresh fetch, so this costs
// nothing extra) - a raw count alone didn't say whether "6 rows" was 200
// bytes or 20KB, and that's exactly the number an operator needs to decide
// whether --summary is even worth reaching for over the full listing.
// actionLog-mode items carry no row content (only store/key) - those count
// toward `count` with 0 bytes, since the tracker never read the row back.
function summarizeByStore(list) {
  const byStore = {};
  let totalBytes = 0;
  for (const item of list) {
    const s = byStore[item.store] || (byStore[item.store] = { count: 0, estBytes: 0 });
    s.count += 1;
    const content = item.row !== undefined ? item.row : (item.before !== undefined || item.after !== undefined) ? { before: item.before, after: item.after } : undefined;
    if (content !== undefined) {
      const bytes = Buffer.byteLength(JSON.stringify(content), 'utf8');
      s.estBytes += bytes;
      totalBytes += bytes;
    }
  }
  for (const store of Object.keys(byStore)) byStore[store].estTokens = Math.round(byStore[store].estBytes / dbApi.CHARS_PER_TOKEN_ESTIMATE);
  return { total: list.length, totalEstTokens: Math.round(totalBytes / dbApi.CHARS_PER_TOKEN_ESTIMATE), byStore };
}

// ---------- Warm-start briefing ----------
//
// The first minutes of a session are nearly always the same handful of reads:
// which stores exist, how many rows, what DB version, is the tab current. One
// bounded call at `session start` answers them all, so the caller does not spend
// 5-8 exploratory round trips (and their tokens) finding out. Best-effort by
// design: no connected tab, a slow page or a handler error just yields
// {available:false, reason}, never a failed session start. Not a logged action.
const BRIEFING_MAX_STORES = 60;
const BRIEFING_TIMEOUT_MS = PING_TIMEOUT_MS * 2;

// Best-effort, fire-and-forget, at most once per relay process: the estimator's bands stay
// rule-of-thumb defaults until someone remembers to run transcript-tokens.mjs by hand, and nobody
// does (confirmed: token-calibration.json still does not exist after several rounds of this tool
// being built). Since that method needs no API key, try it once, the first time a session starts
// with nothing calibrated yet - never awaited, so a first session of the day is never slowed down
// by scanning this machine's transcript history.
//
// Opt-IN (WEBSCOUT_AUTO_CALIBRATE=1), not opt-out, and deliberately so: a relay this file's own
// isMainModule guard lets run is not necessarily a REAL, interactive one - several test files
// (relay-control.test.mjs, auto-restart.test.mjs, autostart.test.mjs, relay-events.test.mjs) spawn
// a genuine `node relay.mjs` to test relay-control.mjs's own start/stop/restart behavior, each with
// its own hand-built env that predates this flag and has no reason to know about it. An opt-out
// flag those files would all need to remember to set was tried first and confirmed to fail exactly
// this way: a test run wrote a REAL token-calibration.json from this machine's REAL transcripts
// into the project tree. client.mjs's two real relay-(re)start call sites (autostartRelay,
// ensureFreshRelayForNewSession) and cli.mjs's `relay start`/`relay restart` are the only places
// that set this env var - every test-spawned relay, by construction, does not.
let autoCalibrateAttempted = false;
// Set once the deferred scan actually finishes (success, no-op, or error) - see
// token-estimate.mjs's estimatorInfo({ autoCalibrate }), which reports this distinctly from
// "never tried" (flag off) or "tried, still running" (attempted but this is still null).
let autoCalibrateOutcome = null;
function currentAutoCalibrateState() {
  return { enabled: process.env.WEBSCOUT_AUTO_CALIBRATE === '1', scheduled: autoCalibrateAttempted, outcome: autoCalibrateOutcome };
}
function maybeAutoCalibrate() {
  if (autoCalibrateAttempted || process.env.WEBSCOUT_AUTO_CALIBRATE !== '1') return;
  autoCalibrateAttempted = true;
  // Deferred past this tick so it runs AFTER the /sessions response has already been sent - the
  // scan (discoverTranscripts + readTranscripts over up to 40 files) is synchronous and must never
  // be what a caller's "session start" round trip is waiting on.
  setImmediate(() => {
    try {
      const outcome = autoCalibrateIfMissing();
      autoCalibrateOutcome = outcome;
      if (outcome.written) log(`auto-calibrated from ${outcome.transcriptCount} transcript(s): ${outcome.kinds.join(', ')}`);
    } catch (err) {
      autoCalibrateOutcome = { attempted: true, written: false, reason: err.message };
      log(`auto-calibrate skipped: ${err.message}`);
    }
  });
}

async function buildBriefing(agentName) {
  const entry = agents.get(agentName);
  if (!entry?.socket || entry.socket.destroyed) return { available: false, reason: `no tab connected as '${agentName}' - open the app, then "status" shows it` };
  const build = agentBuildStatus(entry);
  // A tab on an older inject.js may still create an empty database when asked to list one
  // that does not exist yet; an automatic call must not risk that, so it waits for a reload.
  if (build.agentStale) return { available: false, reason: 'this tab runs an older in-page agent than inject.js on disk - reload it ("page reload --hard"), then briefing works; nothing was asked of the page' };
  try {
    const [list, version] = await Promise.all([
      dispatchCommand('idb.list', {}, BRIEFING_TIMEOUT_MS, agentName),
      dispatchCommand('db.version', {}, BRIEFING_TIMEOUT_MS, agentName),
    ]);
    const counts = list?.counts ?? {};
    const nonEmpty = Object.entries(counts).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
    const shown = nonEmpty.slice(0, BRIEFING_MAX_STORES);
    const staleFiles = getStaleSourceFiles();
    return {
      available: true,
      agent: agentName,
      db: { name: version?.name ?? null, version: version?.version ?? null },
      storeCount: (list?.stores ?? Object.keys(counts)).length,
      stores: Object.fromEntries(shown),
      ...(nonEmpty.length > shown.length ? { storesOmitted: nonEmpty.length - shown.length } : {}),
      emptyStores: (list?.stores ?? Object.keys(counts)).length - nonEmpty.length,
      tab: { build: build.build, agentStale: build.agentStale },
      ...(staleFiles.length ? { relayStaleSourceFiles: staleFiles } : {}),
      note: 'this answers "idb list" and "db version-check" for now; row counts are as of session start',
    };
  } catch (err) {
    return { available: false, reason: `briefing skipped: ${err.message}` };
  }
}

// ---------- Action logging wrapper (requirement 1: every action recorded) ----------

async function withLoggedAction(sessionId, type, params, fn, agentName = DEFAULT_AGENT) {
  const startedAt = new Date().toISOString();
  // Pushed BEFORE the round trip resolves so the dashboard can render an
  // in-flight row immediately - dom.wait/idb.wait/dom.pick can take up to
  // their own 10-15s timeout, and a dead-looking dashboard during that wait
  // was confirmed friction in a real verification pass. The dashboard clears
  // this the moment the matching 'action' event (full refresh) arrives.
  broadcastUpdate('action_start', sessionId, { type, agentName, startedAt });
  // Read AFTER the reply: the reply is what tells the relay which route the tab is on right now, so a
  // page command that ran just after an in-app navigation is logged against the route it ran on.
  const originNow = () => frictionOriginFor(agentName, type);
  ensureFrictionSession(sessionId); // before the first note() below, so a restarted relay's counters are rebuilt, not seeded from one row
  try {
    const result = await fn();
    const origin = originNow();
    const endedAt = new Date().toISOString();
    const actionId = dbApi.logAction({ sessionId, type, params, result, ok: true, error: null, startedAt, endedAt, agentName, origin });
    frictionTracker.note(sessionId, { type, params, origin, ok: true, durationMs: Date.parse(endedAt) - Date.parse(startedAt), at: startedAt });
    return { result, actionId };
  } catch (err) {
    const origin = originNow();
    const endedAt = new Date().toISOString();
    dbApi.logAction({ sessionId, type, params, result: null, ok: false, error: err.message, startedAt, endedAt, agentName, origin, errorClass: friction.classifyError(err.message) });
    frictionTracker.note(sessionId, { type, params, origin, ok: false, error: err.message, durationMs: Date.parse(endedAt) - Date.parse(startedAt), at: startedAt });
    throw err;
  }
}

// Wraps withLoggedAction+dispatchCommand for the triggering command of a
// /command dispatch. On failure of an AUTO_SCREENSHOT_ON_FAILURE_TYPES type
// carrying a selector, best-effort captures a dom.screenshot of that
// selector as its OWN separate logged action (not attached to the failed
// row - simpler, and the action log is append-only by convention) before
// rethrowing the original error unchanged. Screenshot failure never masks
// or replaces the original error.
// Best-effort re-check of live state right after a TIMED-OUT (not
// genuinely-failed) dom.click/dom.fill/idb.put/idb.patch - a timeout only
// proves the RELAY never got a reply in time, never that the page didn't
// receive or even finish the command. Confirmed real, repeated friction: a
// dom.click that timed out was treated as "the click failed", triggering a
// retry, when idb.dump ground-truth later showed it had actually landed -
// the CLI had no way to tell those two situations apart from a bare error
// message. Uses its own short PING_TIMEOUT_MS-scale budget per probe (not
// the original command's full timeout) - if the page is still that slow,
// this should fail fast and cheap rather than piling a second long wait on
// top of the first. Never throws - a failed verification attempt (the page
// is ALSO not responding to the cheap probe) is itself real signal, folded
// into the same shape as a successful one.
async function verifyAfterTimeout(type, params, agentName) {
  const probeTimeoutMs = PING_TIMEOUT_MS * 2;
  try {
    if (type === 'dom.click' || type === 'dom.clickWait' || type === 'dom.fill') {
      if (!params?.selector) return { attempted: false, reason: 'no selector on the timed-out command to re-query' };
      const query = await dispatchCommand('dom.query', { selector: params.selector }, probeTimeoutMs, agentName);
      return { attempted: true, via: 'dom.query', selector: params.selector, ...query };
    }
    if (type === 'idb.put' || type === 'idb.patch') {
      if (!params?.store) return { attempted: false, reason: 'no store on the timed-out command to re-check' };
      const list = await dispatchCommand('idb.list', {}, probeTimeoutMs, agentName);
      return { attempted: true, via: 'idb.list', store: params.store, rowCountNow: list.counts?.[params.store] ?? null, note: 'compare rowCountNow against what you expected before the timed-out write - this cannot prove the SPECIFIC row landed, only whether the store moved at all. Use "idb get"/"idb dump" for a definitive answer.' };
    }
  } catch (err) {
    return { attempted: true, failed: true, error: err.message, note: 'the re-verification probe ALSO failed/timed out - this is a stronger signal the page is genuinely unresponsive, not just that one command was slow' };
  }
  return { attempted: false, reason: `no verification strategy for type '${type}'` };
}

async function dispatchTracked(session, type, params, agentName, dispatchTimeoutMs, autoRemediate = false) {
  try {
    return await withLoggedAction(session.id, type, params ?? {}, () => dispatchCommand(type, params ?? {}, dispatchTimeoutMs, agentName), agentName);
  } catch (err) {
    if (err instanceof HttpError && err.status === 504 && TIMEOUT_VERIFIABLE_TYPES.has(type)) {
      // Logged as its own action either way, same append-only convention as
      // the auto-screenshot-on-failure block below - never mutates or
      // replaces the original timeout error being rethrown.
      try {
        const { result: verification } = await withLoggedAction(session.id, 'timeout.verify', { for: type, params, via: 'auto-on-timeout' }, () => verifyAfterTimeout(type, params, agentName), agentName);
        err.extra = { ...err.extra, postTimeoutVerification: verification };
      } catch { /* verification itself threw unexpectedly - leave the original timeout error unannotated */ }
      broadcastUpdate('action', session.id);
    }
    // Same registry crv preflight checks against boot console errors, now also checked
    // against THIS failure's own message - a known bug otherwise looks identical to a
    // brand-new mystery until a separate "analytics" call is made.
    const { match: known, checkError: knownIssuesCheckError } = matchKnownIssueForError(err.message);
    if (known) err.extra = { ...err.extra, knownIssue: known };
    else if (knownIssuesCheckError) err.extra = { ...err.extra, knownIssuesCheckError };
    // The failure's own reply carries what friction awareness knows (class, repeat count, what
    // worked last time) - a header on the pre-action reply is easy to miss, and an error body is
    // where a caller already looks. Best-effort: never masks the original error.
    try {
      const facts = frictionFactsFor(session.id, type, params ?? {}, agentName);
      if (facts?.context) err.extra = { ...err.extra, selectorFriction: facts.context };
      // Live emergent detection: don't wait for "session end" to say a pattern is new.
      const emergentNow = liveEmergentFriction(session.id, type, facts);
      if (emergentNow.length) err.extra = { ...err.extra, emergentFriction: emergentNow };
    } catch { /* best-effort */ }
    queueFrictionBroadcast(session, agentName, type, params, known);
    // Opt-in (--auto-remediate) one-shot retry of the matched issue's own structured alternate
    // action. The ORIGINAL failure is still rethrown either way - a retry that succeeds is
    // reported next to it (extra.remediationAttempt), never silently substituted for it, so the
    // caller decides whether the run counts as recovered. Logged as its own action (via:
    // 'auto-remediate') like the auto-screenshot below, so the session trail shows it happened.
    // Never retried for a timeout (the page may still be mid-command - a second dispatch on top
    // would race it), and never recursive: the retry goes through dispatchCommand directly.
    if (autoRemediate && known?.retry && !(err instanceof HttpError && err.status === 504)) {
      const { type: retryType, params: retryParams } = known.retry;
      try {
        const { result: retryResult } = await withLoggedAction(session.id, retryType, { ...retryParams, via: 'auto-remediate', for: type, knownIssueId: known.id }, () => dispatchCommand(retryType, retryParams, LONG_POLL_TYPES.has(retryType) ? (Number(retryParams?.timeoutMs) || 15000) + 5000 : COMMAND_TIMEOUT_MS, agentName), agentName);
        if (MUTATING_TYPES.has(retryType)) bumpMutationCounter(session.id);
        err.extra = { ...err.extra, remediationAttempt: { knownIssueId: known.id, type: retryType, params: retryParams, ok: true, result: retryResult } };
      } catch (retryErr) {
        err.extra = { ...err.extra, remediationAttempt: { knownIssueId: known.id, type: retryType, params: retryParams, ok: false, error: retryErr.message } };
      }
      broadcastUpdate('action', session.id);
    }
    if (AUTO_SCREENSHOT_ON_FAILURE_TYPES.has(type) && params?.selector) {
      // Logged as its own action EITHER way (success or failure) - a
      // silent swallow on failure would hide exactly the case confirmed
      // live against this app's own real page: dom.screenshot's rendering
      // technique (see inject.js) chokes on ordinary cross-origin content
      // (e.g. a webfont) common enough here that "attempted, also failed,
      // here's why" is worth a visible row, not silence. Never touches or
      // replaces the ORIGINAL failure being rethrown below either way.
      try {
        await withLoggedAction(session.id, 'dom.screenshot', { selector: params.selector, via: 'auto-on-failure', for: type }, () => dispatchCommand('dom.screenshot', { selector: params.selector }, COMMAND_TIMEOUT_MS, agentName), agentName);
      } catch { /* already logged as a failed action by withLoggedAction itself */ }
      broadcastUpdate('action', session.id);
    }
    throw err;
  }
}

// ---------- Mid-session macro nudge ----------
//
// "consider macro record" previously only ever printed at `session end`
// (see the /sessions/:id/end route) - confirmed real friction: a session
// hand-rolling a seed/verify/cleanup shape got the nudge only after the
// work was already fully done by hand, too late to actually save the
// re-typing it exists to prevent. Surfaced instead the moment a session
// crosses the SAME >=5-replayable-actions threshold mid-flight, then again
// every MID_SESSION_NUDGE_REPEAT_EVERY actions after that (a still-growing
// session doing a second distinct repeatable shape deserves a second nudge,
// not silence for the rest of its life) - never more than once per
// threshold crossing. Delivered via the x-webscout-nudge response header
// (see client.mjs's request()) rather than the JSON body, so it can never
// change the shape of any command's own real result.
const MID_SESSION_NUDGE_REPEAT_EVERY = 8;
const sessionNudgeState = new Map(); // sessionId -> last replayable count a nudge was sent at

function maybeMidSessionNudge(sessionId, res) {
  try {
    const replayableCount = dbApi.listActions(sessionId).filter((a) => a.ok && DEFAULT_MACRO_TYPES.has(a.type)).length;
    if (replayableCount < 5) return;
    const lastNudgedAt = sessionNudgeState.get(sessionId) ?? 0;
    if (replayableCount - lastNudgedAt < (lastNudgedAt === 0 ? 5 : MID_SESSION_NUDGE_REPEAT_EVERY)) return;
    sessionNudgeState.set(sessionId, replayableCount);
    const noticeText = `${replayableCount} replayable action(s) so far this session - consider "macro record \\"<name>\\" ${sessionId}" if this shape will repeat.`;
    res.setHeader('x-webscout-nudge', noticeText);
    notify(res, sessionId, { kind: 'nudge', message: noticeText, next: [notices.macroRecordCommand(sessionId)] });
  } catch { /* best-effort - never block a command reply on this */ }
}

// Awareness strategy for the caching/dedup/compaction machinery itself: a
// PASSIVE doc (README/usage()) only reaches a caller who already thought to
// go read it. This fires the JUST-IN-TIME moment instead - the FIRST time a
// session's own call is actually served from the read-result cache, tell
// the caller right then (it just benefited from a real event, not a
// speculative ad) and point at where the aggregate numbers live. Once per
// session - a caller told once doesn't need repeating on every later hit.
const sessionCacheAwarenessNudged = new Set();

function maybeCacheAwarenessNudge(sessionId, res) {
  if (sessionCacheAwarenessNudged.has(sessionId)) return;
  sessionCacheAwarenessNudged.add(sessionId);
  try {
    const noticeText = 'this result was served from the same-session read-result cache instead of re-dispatched (__cacheHit:true) - identical results are also deduped once at the DB level, macros are auto-compacted, and repeat suite diffs are cache-served; run "token-report" (no --session) for real bytes/tokens saved by all of these so far.';
    res.setHeader('x-webscout-nudge', noticeText);
    notify(res, sessionId, { kind: 'nudge', message: noticeText });
  } catch { /* best-effort - never block a command reply on this */ }
}

// ---------- Per-session friction snapshot (selector history, failed types, macro candidates) ----------
//
// Both nudges below need "what does analytics already know is risky" on EVERY command
// dispatch - calling the shared getAnalytics() there would be wrong even though it is
// cached: computing it (or extending its cache) from inside a fast-moving session would
// freeze the SHARED analytics cache on a pre-this-session's-own-failures snapshot for up
// to ANALYTICS_CACHE_MS, which is exactly the poisoning bug session start's own
// macroAdoptionNote/frictionNote deliberately avoid by using computeAnalytics() uncached
// (confirmed real here too: a fast scripted session hitting the same broken selector twice
// got back a "clean" GET /analytics immediately after, because the first command's own
// pre-check had already cached the pre-failure snapshot). Instead, the snapshot is computed
// ONCE per session (at session start, from the SAME uncached computeAnalytics() call
// session start already makes for macroAdoptionNote/frictionNote - no extra recompute) and
// consulted here as a plain in-memory lookup - never touches the shared analytics cache.
// The snapshot is HISTORY only and stays frozen; what happens inside the current session is
// overlaid from frictionTracker (friction.mjs), which every logged action updates, so a
// selector that starts failing mid-session is no longer invisible until the next session.
// Cleaned up in dropSessionMemory like every other per-session map.
// Macro nudge candidates are read on demand (see macroCandidates()), never frozen per session.
const frictionTracker = friction.createFrictionTracker({
  // The "already said" state outlives a relay restart (the counters are rebuilt from the action log).
  persist: {
    warn: (sessionId, key, atLive, count) => { try { dbApi.saveFrictionWarn(sessionId, key, atLive, count); } catch { /* best-effort */ } },
    announce: (sessionId, kind, key) => { try { dbApi.saveFrictionAnnounce(sessionId, kind, key); } catch { /* best-effort */ } },
  },
});
const frictionHydrated = new Set(); // sessionIds whose live counters were checked against the DB this process
const RISKY_SELECTOR_BLOCK = process.env.WEBSCOUT_RISKY_BLOCK === '1';

// A relay restarted under a live session has an empty tracker: without this the session's own
// failures were forgotten and the warning started again from nothing. Rebuilds the counters from
// the session's logged actions, once per session per process, before anything reads or writes them.
function ensureFrictionSession(sessionId) {
  if (frictionHydrated.has(sessionId)) return;
  frictionHydrated.add(sessionId);
  if (frictionTracker.has(sessionId)) return;
  try {
    const rows = dbApi.listActions(sessionId, { ascending: true });
    if (rows.length) frictionTracker.restore(sessionId, rows, dbApi.listFrictionSessionState(sessionId));
  } catch { /* best-effort - an unreadable log just means a cold start, the old behaviour */ }
}

// known-issues.json matcher for the history lookups: loaded lazily (only if some failure needs
// matching) and once per lookup. Any load problem degrades to "no match", never an error.
function lazyKnownIssueMatcher() {
  let issues;
  return (errorText) => {
    if (!errorText) return [];
    if (issues === undefined) {
      try { issues = loadKnownIssues()?.issues ?? []; } catch { issues = []; }
    }
    return issues.filter((issue) => issue.matches(errorText)).map(({ id, description, remediation }) => ({ id, description, remediation }));
  };
}

// What a command's friction target is scoped to: the agent's origin, plus the route it is on for the
// page-level commands (a reload that times out on /checkout says nothing about /settings). Selector and
// store targets stay origin-scoped.
function frictionOriginFor(agentName, type) {
  const agent = agents.get(agentName);
  const origin = agent?.origin ?? null;
  return origin && agent.path && friction.PAGE_TYPES.has(type) ? `${origin}${agent.path}` : origin;
}

// Everything the system knows about ONE action target, from ONE place: the earlier-session
// history (an indexed lookup on actions.selector_key - nothing is frozen at session start, so a
// selector that failed once before is seen as exactly that), this session's live counters, the
// persisted "already said" state and the operator's resolution. The pre-action header, the
// failure's own error body, the macro runner and `friction explain` all read this object, so they
// cannot disagree about a selector.
function frictionFactsFor(sessionId, type, params, agentName, originOverride) {
  const origin = originOverride ?? frictionOriginFor(agentName, type);
  const target = friction.frictionTarget(type, params, origin);
  if (!target) return null;
  ensureFrictionSession(sessionId);
  const key = friction.frictionKeyFor(type, params, origin);
  const resolutions = new Map();
  const resolution = dbApi.getFrictionResolution(key);
  if (resolution) resolutions.set(key, resolution.resolved_at);
  const rows = dbApi.listFrictionKeyHistory(key, { excludeSessionId: sessionId });
  const entry = friction.buildSelectorFriction(rows, { matchKnownIssues: lazyKnownIssueMatcher(), resolutions, minFails: 1 }).find((e) => e.key === key) ?? null;
  const live = frictionTracker.get(sessionId, key);
  const state = frictionTracker.warnState(sessionId, key);
  const snooze = (() => { try { return dbApi.getFrictionSnooze(key); } catch { return null; } })();
  const snoozedUntil = snooze?.until ?? null;
  const evaluation = friction.evaluateSelectorRisk({ type, selector: target.value, targetKind: target.kind, entry, live, state, origin, snoozedUntil });
  const context = friction.failureContext({ type, selector: target.value, targetKind: target.kind, entry, live, origin });
  return { key, target, entry, live, state, origin, resolution, snooze, evaluation, context };
}

// --try-recovery: after a click/fill/wait fails, run it ONCE more on the alternative selector that has
// repeatedly been what worked after this exact failure (>= 3 recorded trials, >= 80% of them). Opt-in
// per call, same-type and same-params apart from the selector, and never for a page script error.
// Both attempts are logged as ordinary actions (so the evidence trail shows what really ran) and the
// reply says which selector actually ran. A different element can be the wrong one: that is the
// reason it is opt-in and why the bar is "worked 4 of 5 times", not "worked once".
const RECOVERY_RETRY_TYPES = new Set(['dom.click', 'dom.clickWait', 'dom.fill', 'dom.wait']);
const RECOVERY_MIN_TRIALS = 3;
const RECOVERY_MIN_RATE = 0.8;
// The selector that has repeatedly been what worked after this one failed (>= RECOVERY_MIN_TRIALS trials, >= RECOVERY_MIN_RATE of
// them), as a suggestion with its evidence - or null. `recovery` is a friction entry's .recovery.
function reliableAlternative(recovery, ownSelector) {
  if (!recovery || recovery.kind !== 'alt-selector' || !recovery.selector || recovery.of < RECOVERY_MIN_TRIALS || recovery.worked / recovery.of < RECOVERY_MIN_RATE) return null;
  if (ownSelector && friction.normalizeSelector(recovery.selector) === friction.normalizeSelector(ownSelector)) return null;
  return { selector: recovery.selector, worked: recovery.worked, of: recovery.of, evidence: `after this failed, "${recovery.selector}" worked ${recovery.worked} of ${recovery.of} times` };
}

function recoveryRetryFor(sessionId, type, params, agentName, err) {
  if (!RECOVERY_RETRY_TYPES.has(type) || typeof params?.selector !== 'string') return null;
  if (friction.classifyError(err?.message) === 'eval-throw') return null;
  let facts = null;
  try { facts = frictionFactsFor(sessionId, type, params, agentName); } catch { return null; }
  const r = facts?.entry?.recovery;
  if (!r || r.kind !== 'alt-selector' || !r.selector || r.of < RECOVERY_MIN_TRIALS || r.worked / r.of < RECOVERY_MIN_RATE) return null;
  if (friction.normalizeSelector(r.selector) === friction.normalizeSelector(params.selector)) return null;
  const { nth, ...rest } = params; // an index into the ORIGINAL selector's matches means nothing for another one
  return { params: { ...rest, selector: r.selector }, recovery: r };
}

// "Which steps of this plan will draw a warning?" - answered BEFORE any of them runs, from the same
// facts the pre-action header uses (so the two cannot disagree), but ignoring the once-per-session
// dedupe: a plan check should list every risky step, not only the ones not yet announced. Side-effect
// free. Judged against the active session if there is one, else history alone.
function planFrictionReport(plan, agentName) {
  const sessionId = dbApi.getCurrentSession()?.id ?? -1;
  const risky = [];
  let checked = 0;
  plan.slice(0, 50).forEach((step, index) => {
    if (!step || typeof step.type !== 'string') return;
    let facts = null;
    try { facts = frictionFactsFor(sessionId, step.type, step.params ?? {}, agentName); } catch { /* one unreadable step must not hide the rest */ }
    if (!facts) return;
    checked += 1;
    const { assessment } = friction.evaluateSelectorRisk({ type: step.type, selector: facts.target.value, targetKind: facts.target.kind, entry: facts.entry, live: facts.live, state: null, origin: facts.origin });
    if (assessment) {
      const alt = facts.target.kind === 'selector' ? reliableAlternative(facts.entry?.recovery, facts.target.value) : null;
      risky.push({ step: index + 1, type: step.type, target: facts.target, key: facts.key, level: assessment.level, message: assessment.message, ...(alt ? { suggest: alt } : {}) });
    }
  });
  return { checked, risky };
}

// Macro nudge candidates: every macro that can still plausibly work - never-run ones AND proven ones -
// minus macros that have run and never once succeeded (nudging toward a known-broken macro would be
// worse than silence). Run history rides along so the nudge can say how reliable the macro has been.
// Read on demand from a short-lived cache instead of a per-session snapshot, so a macro recorded,
// run, or declared fixed in the middle of a session is seen by the very next command. The cache
// drops on every macro/analytics change (broadcastUpdate) and otherwise after a minute, which bounds
// how often the analytics scan behind it runs on the command path.
const MACRO_CANDIDATE_TTL_MS = 60_000;
let macroCandidateCache = null; // { at, list }
function macroCandidates() {
  if (macroCandidateCache && Date.now() - macroCandidateCache.at < MACRO_CANDIDATE_TTL_MS) return macroCandidateCache.list;
  const list = buildMacroCandidates(getAnalytics());
  macroCandidateCache = { at: Date.now(), list };
  return list;
}

function buildMacroCandidates(analytics) {
  const neverRunIds = new Set((analytics.macrosNeverRun ?? []).map((m) => m.id));
  const brokenIds = new Set((analytics.macrosNeverSucceeding ?? []).map((m) => m.id));
  const runsById = new Map((analytics.macroHealth ?? []).map((m) => [m.id, m.runs]));
  try {
    return dbApi.listMacros()
      .filter((m) => Array.isArray(m.steps) && m.steps.length >= 2 && !brokenIds.has(m.id))
      .map((m) => ({ ...m, neverRun: neverRunIds.has(m.id), runs: runsById.get(m.id) ?? [] }));
  } catch {
    return []; // best-effort - an empty list just means no macro-match nudge
  }
}

// ---------- Pre-action risky-selector warn ----------
//
// A selector that has repeatedly failed was previously only visible via a separate "analytics"
// call, so an agent about to click/fill the SAME risky selector again had no signal until AFTER
// it failed again, the exact same wall. friction.assessSelectorRisk combines the frozen history
// (origin-scoped, success-aware, normalized selector) with this session's own live failures and
// decides whether to say anything: once per selector per session, again only when a NEW failure
// happened since, and escalated once the warning has been ignored ESCALATE_AFTER_LIVE_FAILS
// times. Surfaced as a response header, same convention as the mid-session macro nudge below -
// decorates the reply without changing the result shape for a caller that isn't reading headers.
// It never blocks the dispatch, with one opt-in exception: WEBSCOUT_RISKY_BLOCK=1 refuses an
// ESCALATED selector (409) unless the call passes ackRisk:true.
// The things one command is aimed at: itself, plus a dom.drag's drop target (checked as its own selector).
function riskTargetsOf(type, params) {
  const out = [{ type, params: params ?? {}, role: null }];
  if (type === 'dom.drag' && typeof params?.to === 'string' && params.to) out.push({ type, params: { selector: params.to }, role: 'to' });
  return out;
}

function maybeRiskySelectorWarn(sessionId, type, params, res, agentName, ackRisk) {
  let blockMessage = null;
  const keys = [];
  const messages = [];
  const notices_ = [];
  try {
   for (const t of riskTargetsOf(type, params)) {
    const facts = frictionFactsFor(sessionId, t.type, t.params, agentName);
    if (!facts) continue;
    const { key, target, live } = facts;
    const assessment = facts.evaluation.assessment;
    // A block must outlive the warning's own dedupe: the header is said once, but a refused call
    // retried without ackRisk has to be refused again, not waved through because "it was already told".
    const stillEscalated = RISKY_SELECTOR_BLOCK && ackRisk !== true && (live?.unresolved ?? 0) >= friction.ESCALATE_AFTER_LIVE_FAILS;
    if (!assessment) {
      if (stillEscalated) blockMessage = `${target.kind} "${target.value}" (${type}) has failed ${live.unresolved}x in a row this session without a success - refusing (WEBSCOUT_RISKY_BLOCK=1); pass ackRisk:true to run it anyway.`;
    } else {
      frictionTracker.recordWarn(sessionId, key, assessment.liveUnresolved);
      keys.push(key);
      notices_.push({ kind: 'selector-risk', level: assessment.level === 'escalated' ? 'escalated' : 'warn', message: assessment.message, key, next: [notices.whyCommand(friction.typeFamily(t.type), target.value), ...(facts.live?.unresolved ? [] : [notices.fixedCommand(friction.typeFamily(t.type), target.value)]), notices.snoozeCommand(friction.typeFamily(t.type), target.value)] });
      messages.push(t.role === 'to' ? `drop target "${target.value}" - ${assessment.message}` : assessment.message);
      if (assessment.level === 'escalated' && stillEscalated) blockMessage = `${assessment.message} - refusing (WEBSCOUT_RISKY_BLOCK=1); pass ackRisk:true to run it anyway.`;
    }
   }
   if (messages.length) {
     // Header values must be printable ASCII - an error text with a newline or non-latin1
     // character would make setHeader throw and silently swallow the whole warning.
     res.setHeader('x-webscout-selector-risk', messages.join(' ').replace(/[^\x20-\x7e]/g, '?'));
     // Stable key for the client's cross-process warn-cache: the text changes as counts climb, the key does not.
     res.setHeader('x-webscout-selector-risk-key', keys.join(',').replace(/[^\x20-\x7e]/g, '?'));
     for (const n of notices_) notify(res, sessionId, n);
   }
  } catch { /* best-effort - never block a command dispatch on a bookkeeping failure */ }
  if (blockMessage) throw new HttpError(409, blockMessage);
}

// Everything known about ONE command type, from the same tally the analytics panel uses: earlier
// sessions (indexed by type, the resolution cut-off applied) plus this session's own calls. The live
// "first failure ever" line reads this instead of a separate query, so it cannot disagree with
// failureRateByType.
function typeFactsFor(sessionId, type) {
  const cutoff = (() => { try { return dbApi.getFrictionResolution(friction.scopeKey('type', type))?.resolved_at ?? null; } catch { return null; } })();
  const counts = (a) => !(cutoff && a.started_at && a.started_at <= cutoff);
  const history = dbApi.listTypeHistory(type, sessionId);
  const prior = friction.tallyTypeFailures(history, { counts }).get(type) ?? { type, total: 0, failed: 0, wastedMs: 0 };
  const own = friction.tallyTypeFailures(dbApi.listActions(sessionId).filter((a) => a.type === type), { counts }).get(type) ?? { type, total: 0, failed: 0, wastedMs: 0 };
  const total = prior.total + own.total;
  const failed = prior.failed + own.failed;
  return { type, prior, session: own, total, failed, failureRate: total ? failed / total : 0, everFailedBefore: history.some((a) => !a.ok) }; // declared-fixed failures still happened
}

// Live version of the session-end emergent diff: said once, on the failure itself, instead of
// only after the session is over. Judged against the frozen snapshot (no analytics recompute on
// the hot path), so "no history" means "not in the session-start snapshot".
function liveEmergentFriction(sessionId, type, facts) {
  const lines = [];
  if (!typeFactsFor(sessionId, type).everFailedBefore && frictionTracker.announceOnce(sessionId, 'type', type)) {
    lines.push(`"${type}" just failed for the first time ever (no earlier session recorded a failure of this type).`);
  }
  // Judged against the indexed history of OTHER sessions, so "no history" is exact: a target that
  // failed once before is not an emerging pattern, and one that never failed is.
  if (facts && facts.live && facts.live.fails >= 2 && !facts.entry && frictionTracker.announceOnce(sessionId, 'selector', facts.key)) {
    lines.push(`${facts.target.kind} "${facts.target.value}" (${type}) has now failed ${facts.live.fails}x this session and never failed in an earlier session - an emerging pattern.`);
  }
  return lines;
}

// ---------- Pre-run macro risk preview ----------
//
// riskySelectorWarningText above fires PER STEP, as each one is about to dispatch - an agent
// running a 10-step macro only learns step 7 is about to hit a selector with a 12x fail history
// right as step 7 starts, after steps 1-6 already ran. This scans every step against the SAME
// frozen per-session snapshot up front, so the whole risk shape of a macro is visible before any
// step runs (worst offender first) rather than trickling in one warning at a time. Purely
// additive: never changes which steps run or in what order, and empty (field omitted from the
// reply, per the macro-run handler below) for a macro with no risky steps - a clean macro stays
// exactly as quiet as it is today.
function buildMacroRiskPreview(sessionId, steps, stepOffset, agentName) {
  const preview = [];
  steps.forEach((step, i) => {
    for (const t of riskTargetsOf(step.type, step.params)) {
      let facts = null;
      try { facts = frictionFactsFor(sessionId, t.type, t.params, agentName); } catch { /* one unreadable step must not hide the rest */ }
      const e = facts?.entry;
      const live = facts?.live;
      if (!facts || (!e && !live)) continue; // no history and nothing failing this session: nothing to preview
      const { assessment } = friction.evaluateSelectorRisk({ type: t.type, selector: facts.target.value, targetKind: facts.target.kind, entry: e, live, state: null, origin: facts.origin });
      if (!assessment) continue;
      preview.push({
        stepIndex: i + stepOffset, type: step.type, selector: facts.target.value, ...(t.role ? { role: t.role } : {}), failCount: e?.failCount ?? live.fails, sessionCount: e?.sessionCount ?? 1,
        lastFailedAt: e?.lastFailedAt ?? live.lastFailedAt ?? null, knownIssue: e?.knownIssues?.[0] ?? null,
      });
    }
  });
  preview.sort((x, y) => y.failCount - x.failCount);
  return preview;
}

// ---------- Friction-aware macro authoring ----------
//
// "macro record" bakes in whatever selector each step literally used, including one with a
// 12x failure history - the very selector the risky-selector warning would fire on at every
// replay. This checks a recorded step's fragile selector against the session's OWN evidence
// for a different selector that reached the SAME element. The only identity signal web-scout
// really has is dom.query's reply: it carries the element's tag and id, and an id is unique
// within a document - so two successful dom.query results with the same tag + non-null id but
// different queried selectors are the same element, reached two ways. dom.click/fill results
// carry no element identity, and text/position similarity would be a guess, so neither is used:
// no id-bearing query evidence means no suggestion. SUGGESTION ONLY - the recorded steps are
// never rewritten here; the caller swaps one deliberately via "macro update". An alternative
// must itself be non-risky (same type, per the same analytics threshold), or it is no upgrade.
function buildMacroSelectorSuggestions(sessionId, steps, actions) {
  try {
    // The same ranked list the pre-action warning is built from: a selector counts as fragile when it has failed at least
    // RISKY_SELECTOR_FAIL_THRESHOLD times (a later success does not make a recorded step less fragile to bake in). Keyed by type + selector as the lookups below expect.
    const risky = new Map(getAnalytics().selectorFriction
      .filter((f) => f.targetKind === 'selector' && f.failCount >= friction.RISKY_SELECTOR_FAIL_THRESHOLD)
      .map((f) => [f.key, f]));
    if (!risky.size) return [];
    const selectorsByElement = new Map(); // "TAG#id" -> Set<selector>
    for (const a of actions) {
      if (!a.ok || a.type !== 'dom.query' || typeof a.params?.selector !== 'string') continue;
      const r = a.result;
      if (!r || r.found !== true || typeof r.tag !== 'string' || typeof r.id !== 'string' || !r.id) continue;
      const key = `${r.tag}#${r.id}`;
      if (!selectorsByElement.has(key)) selectorsByElement.set(key, new Set());
      selectorsByElement.get(key).add(a.params.selector);
    }
    const suggestions = [];
    steps.forEach((step, stepIndex) => {
      const selector = step.params?.selector;
      const hit = typeof selector === 'string' ? risky.get(friction.frictionKeyFor(step.type, { selector })) : null;
      if (!hit) return;
      for (const [element, selectors] of selectorsByElement) {
        if (!selectors.has(selector)) continue;
        const alternatives = [...selectors].filter((s) => s !== selector && !risky.has(friction.frictionKeyFor(step.type, { selector: s }))).sort((a, b) => a.length - b.length);
        if (!alternatives.length) continue;
        suggestions.push({
          stepIndex, type: step.type, selector, failCount: hit.failCount, sessionCount: hit.sessionCount,
          alternative: alternatives[0], element,
          evidence: `dom.query on "${selector}" and on "${alternatives[0]}" both returned ${element} in this session`,
        });
        return;
      }
      // No same-element evidence in this session: fall back to what history says worked after this selector failed.
      const alt = reliableAlternative(hit.recovery, selector);
      if (alt) suggestions.push({ stepIndex, type: step.type, selector, failCount: hit.failCount, sessionCount: hit.sessionCount, alternative: alt.selector, element: null, source: 'recovery', evidence: alt.evidence });
    });
    return suggestions;
  } catch { return []; /* best-effort - a suggestion bug must never fail the macro recording itself */ }
}

// ---------- Live cross-agent friction broadcast ----------
//
// Two agents (two tabs named via webscout_name, each driven by its own CLI/MCP caller) share ONE
// relay and ONE active session, but a failure one of them hits only ever reached the other via
// a later "analytics" call - by which point it had usually hit the same wall itself. There is
// no push channel to a CLI/MCP caller (they are request/response), so this reuses the one
// delivery convention every other nudge here already uses: queue a notice per OTHER connected
// agent and drain it into an x-webscout-friction-broadcast header on that agent's NEXT /command
// reply - never blocks or interrupts anything in flight, never touches a result body. The
// dashboard's existing SSE channel gets the same event ('friction') for free via broadcastUpdate.
// Fires only on the two signals that already mean something elsewhere: a failure carrying an
// inline knownIssue, or a selector's failure count in THIS session reaching the same 3-fail
// risky threshold the cross-session warning uses (exactly at the crossing, not every failure
// after it). Per-agent queue is capped and keyed by session so it can never outlive one.
const pendingFrictionNotices = new Map(); // `${sessionId}::${agentName}` -> [{ fromAgent, type, selector, failCount, knownIssue, reason }]
const FRICTION_NOTICE_CAP = 5;

function queueFrictionBroadcast(session, fromAgent, type, params, known) {
  try {
    // A remediation retry is dispatched by the relay on the failing agent's behalf - its own
    // failure is already reported on that reply, not news for the other agent.
    if (params?.via === 'auto-remediate') return;
    const selector = typeof params?.selector === 'string' && params.selector ? params.selector : null;
    let failCount = null;
    let crossed = false;
    if (selector) {
      failCount = dbApi.listActions(session.id).filter((a) => !a.ok && a.type === type && a.params?.selector === selector).length;
      crossed = failCount === friction.RISKY_SELECTOR_FAIL_THRESHOLD;
    }
    if (!known && !crossed) return;
    const notice = { fromAgent, type, selector, failCount, knownIssue: known ?? null, reason: known ? 'known-issue' : 'repeated-failure' };
    for (const other of connectedAgentNames()) {
      if (other === fromAgent) continue;
      const key = `${session.id}::${other}`;
      const queue = pendingFrictionNotices.get(key) ?? [];
      queue.push(notice);
      pendingFrictionNotices.set(key, queue.slice(-FRICTION_NOTICE_CAP));
    }
    broadcastUpdate('friction', session.id, notice);
  } catch { /* best-effort - a broadcast bug must never change the failing command's own error */ }
}

function frictionNoticeText(n) {
  const target = n.selector ? ` on "${n.selector}"` : '';
  const known = n.knownIssue ? ` - known issue: ${n.knownIssue.id}${n.knownIssue.remediation ? ` (${n.knownIssue.remediation})` : ''}` : '';
  const count = n.failCount ? ` (${n.failCount}x this session)` : '';
  return `agent "${n.fromAgent}" just failed ${n.type}${target}${count}${known}`;
}

function maybeFrictionBroadcastNotice(sessionId, agentName, res) {
  try {
    const key = `${sessionId}::${agentName}`;
    const queue = pendingFrictionNotices.get(key);
    if (!queue?.length) return;
    pendingFrictionNotices.delete(key);
    const noticeText = `${queue.map(frictionNoticeText).join('; ')} - check before repeating it.`.replace(/[\r\n]+/g, ' ');
    res.setHeader('x-webscout-friction-broadcast', noticeText);
    notify(res, sessionId, { kind: 'friction-broadcast', message: noticeText, next: queue.length === 1 && queue[0].selector ? [notices.whyCommand(friction.typeFamily(queue[0].type), queue[0].selector)] : [] });
  } catch { /* best-effort - never block a command reply on this */ }
}

// ---------- Proactive macro-match nudge ----------
//
// A macro that was recorded but never replayed (or a proven one that simply was not reused) was
// previously visible only on a separate "analytics" call, well after the moment it could have
// saved anything. This catches it LIVE: if this session's own last N replayable actions match a
// candidate macro's step TYPE sequence (in order), nudge to replay it now instead of continuing
// to hand-type the exact sequence it already exists to save. The match is by action TYPE (a
// selector/value match alone would be brittle against dynamic ids - a different row key each run
// is normal), but the nudge says how strong the match was: "same selectors" when every step's
// selector/store also matches, "params differ" otherwise, plus the macro's own run record, so a
// flaky macro is offered with its pass rate instead of as a sure thing. A tail that is itself a
// macro replay is never nudged (it just ran). Reads the same frozen per-session snapshot as the
// warn above (never the shared analytics cache - see its comment). One nudge per macro per
// session (sessionMacroMatchNudged), same header convention as the mid-session nudge - never
// folded into a command's own result body.
const sessionMacroMatchNudged = new Map(); // sessionId -> Set<macroId> already nudged this session
const MACRO_PARAM_KEYS = ['selector', 'store'];
function describeMacroReliability(macro) {
  if (macro.neverRun) return 'recorded but never run';
  const passed = macro.runs.filter(Boolean).length;
  const verdict = macro.runs.length >= 2 && passed / macro.runs.length < 0.5 ? ' - unreliable, check it first' : '';
  return `${passed}/${macro.runs.length} recent run(s) passed${verdict}`;
}
function maybeMacroMatchNudge(sessionId, res) {
  try {
    const candidates = macroCandidates();
    if (!candidates?.length) return;
    const nudged = sessionMacroMatchNudged.get(sessionId) ?? new Set();
    const recent = dbApi.listActions(sessionId, { ascending: true }).filter((a) => a.ok && DEFAULT_MACRO_TYPES.has(a.type));
    for (const macro of candidates) {
      if (nudged.has(macro.id) || recent.length < macro.steps.length) continue;
      const tail = recent.slice(-macro.steps.length);
      if (!macro.steps.every((step, i) => step.type === tail[i].type)) continue;
      if (tail.some((a) => a.params?.macroId !== undefined)) continue; // that tail IS a macro replay
      nudged.add(macro.id);
      sessionMacroMatchNudged.set(sessionId, nudged);
      const sameParams = macro.steps.every((step, i) => MACRO_PARAM_KEYS.every((k) => step.params?.[k] === undefined || step.params[k] === tail[i].params?.[k]));
      const noticeText = `last ${macro.steps.length} action(s) match macro "${macro.name}" (#${macro.id}; ${sameParams ? 'same selectors/stores' : 'types match, params differ'}; ${describeMacroReliability(macro)}) - "macro run ${macro.id}" instead of continuing by hand.`.replace(/[^\x20-\x7e]/g, '?');
      res.setHeader('x-webscout-macro-match', noticeText);
      notify(res, sessionId, { kind: 'macro-match', level: 'info', message: noticeText, key: `macro:${macro.id}`, next: [notices.macroRunCommand(macro.id)] });
      return; // one macro's worth of nudge per reply is enough
    }
  } catch { /* best-effort - never block a command reply on this */ }
}

function requireActiveSession() {
  const session = dbApi.getCurrentSession();
  if (!session) {
    throw new HttpError(409, 'no active session - context and goal must be defined before any action. Start one: POST /sessions {goal, context}, or `node tools/web-scout/cli.mjs session start "<goal>"`.');
  }
  return session;
}

// Nothing under an ended session can change again - an unbounded relay process would otherwise keep
// every past session's read-result cache and mutation counter alive in memory forever. Shared by
// the explicit "session end" route and by "session start --if-stale-min"'s auto-end, so a session
// ended either way is released the same way.
function dropSessionMemory(sessionId) {
  readResultCache.delete(sessionId);
  sessionMutationCounters.delete(sessionId);
  sessionCacheAwarenessNudged.delete(sessionId);
  sessionCacheHitBytes.delete(sessionId);
  sessionMacroMatchNudged.delete(sessionId);
  frictionTracker.dropSession(sessionId);
  frictionHydrated.delete(sessionId);
  try { dbApi.clearFrictionSessionState(sessionId); } catch { /* best-effort */ }
  for (const key of pendingFrictionNotices.keys()) {
    if (key.startsWith(`${sessionId}::`)) pendingFrictionNotices.delete(key);
  }
  readPipeline.endSession(sessionId);
  lastReportedSessionTokens.delete(sessionId);
}

// ---------- Known-issues registry (opt-in, operator-maintained) ----------
//
// A per-checkout JSON file of already-diagnosed failure signatures, so a console error that has
// been root-caused once is named (with its remediation) by "crv preflight" instead of being
// rediscovered from scratch. Deliberately mechanism only: nothing ships in it, the file is
// untracked (see .gitignore), and its absence is normal - the feature is simply inert. Shape, see
// known-issues.example.json: an array of { id, signature, description, remediation }. `signature`
// is a plain substring, or "/pattern/flags" for a regex. Read on every preflight (a small file, and
// an operator's edit takes effect without restarting the relay). WEBSCOUT_KNOWN_ISSUES points
// elsewhere - the tests' own isolation, so they never read or write a real operator's file.
const KNOWN_ISSUES_PATH = process.env.WEBSCOUT_KNOWN_ISSUES || path.join(__dirname, 'known-issues.json');

function compileSignature(signature) {
  const asRegex = /^\/(.+)\/([a-z]*)$/s.exec(signature);
  if (asRegex) {
    // g/y make RegExp.test stateful across calls (lastIndex) - never wanted for a yes/no match.
    const re = new RegExp(asRegex[1], asRegex[2].replace(/[gy]/g, ''));
    return (text) => re.test(text);
  }
  return (text) => text.includes(signature);
}

// null = no file (inert, not an error). Throws on an unreadable/unparseable/non-array file so the
// caller can say "could not check" instead of pretending nothing matched.
// WEBSCOUT_KNOWN_ISSUES_SHARED: one or more files (path-delimiter separated) of the same shape, read-only, merged UNDER
// the local registry (a local id wins). A team keeps one in a shared location; nobody copies files by hand, and this
// tool never writes to them. An unreadable shared file is skipped (reported by GET /known-issues), never fatal.
function sharedKnownIssueFiles() {
  return (process.env.WEBSCOUT_KNOWN_ISSUES_SHARED || '').split(path.delimiter).map((p) => p.trim()).filter(Boolean);
}
function readSharedKnownIssues() {
  return sharedKnownIssueFiles().map((file) => {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      return Array.isArray(parsed) ? { file, entries: parsed } : { file, entries: [], error: 'not a JSON array' };
    } catch (err) { return { file, entries: [], error: err.message }; }
  });
}
function sharedKnownIssueEntries(localEntries) {
  const have = new Set(localEntries.map((e) => e?.id));
  const out = [];
  for (const s of readSharedKnownIssues()) {
    for (const e of s.entries) {
      if (!e || typeof e.id !== 'string' || have.has(e.id)) continue;
      have.add(e.id);
      out.push({ ...e, shared: s.file });
    }
  }
  return out;
}

function loadKnownIssues() {
  let raw;
  try {
    raw = fs.readFileSync(KNOWN_ISSUES_PATH, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`known-issues file unreadable: ${err.message}`);
    if (!sharedKnownIssueFiles().length) return null;
    raw = '[]'; // no local file, but shared ones: they still apply
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch (err) { throw new Error(`known-issues file is not valid JSON: ${err.message}`); }
  if (!Array.isArray(parsed)) throw new Error('known-issues file must be a JSON array of { id, signature, description, remediation }');
  parsed = [...parsed, ...sharedKnownIssueEntries(parsed)];
  const issues = [];
  const warnings = [];
  parsed.forEach((entry, i) => {
    if (!entry || typeof entry.id !== 'string' || typeof entry.signature !== 'string' || !entry.signature) {
      warnings.push(`entry ${i} skipped: needs a string id and a non-empty string signature`);
      return;
    }
    try {
      // `remediation` stays a plain string everywhere it is printed/returned (backward compatible
      // with every existing entry). It MAY instead be { text, retry: { type, params } } - `text` is
      // then what every existing surface shows, and `retry` (same {type, params} shape /command
      // takes) is what --auto-remediate re-dispatches once. A malformed retry drops the retry
      // only, never the entry: the text hint is still worth having.
      let remediation = entry.remediation ?? null;
      let retry = null;
      if (remediation && typeof remediation === 'object') {
        const r = remediation.retry;
        if (r && typeof r.type === 'string' && r.type && r.type !== 'idb.snapshot' && (r.params === undefined || (r.params && typeof r.params === 'object' && !Array.isArray(r.params)))) {
          retry = { type: r.type, params: r.params ?? {} };
        } else if (r !== undefined) {
          warnings.push(`entry ${i} (${entry.id}): remediation.retry ignored - needs { type: <command type, not idb.snapshot>, params?: object }`);
        }
        remediation = typeof remediation.text === 'string' ? remediation.text : null;
      }
      issues.push({ id: entry.id, description: entry.description ?? null, remediation, retry, matches: compileSignature(entry.signature) });
    } catch (err) {
      warnings.push(`entry ${i} (${entry.id}) skipped: bad signature regex: ${err.message}`);
    }
  });
  return { issues, warnings };
}

// Always an array when the check could run (empty = "checked, none matched"); null only when it
// could not (unreadable file, or loaded issues but no console result to match them against).
function matchKnownIssues(bootErrors, report) {
  let loaded;
  try {
    loaded = loadKnownIssues();
  } catch (err) {
    report.knownIssuesCheckError = err.message;
    return null;
  }
  if (!loaded) return [];
  if (loaded.warnings.length) report.knownIssuesWarnings = loaded.warnings;
  if (!loaded.issues.length) return [];
  if (!Array.isArray(bootErrors)) return null;
  const texts = bootErrors.map((e) => `${e?.message ?? ''}\n${e?.stack ?? ''}`);
  return loaded.issues
    .filter((issue) => texts.some((text) => issue.matches(text)))
    .map(({ id, description, remediation }) => ({ id, description, remediation }));
}

// Best-effort single-hit known-issue match for ONE failed action's own error text - used
// inline on a /command failure (see dispatchTracked) so a bug that was already root-caused
// once (the same registry "crv preflight" checks against boot console errors) reaches the
// agent in the SAME reply as the failure, instead of only via a later, separate "analytics"
// round trip. Returns the first match only (a failure needs one remediation to act on, not
// a ranked list). Never throws.
//
// Distinguishes "checked, nothing matched" (match: null, checkError: null) from "could not
// check" (match: null, checkError: <message>) - a malformed/unreadable known-issues.json
// previously failed the SAME way as a clean miss here (matchKnownIssues, the older
// crv-preflight-only sibling of this function, already reports load failures via
// report.knownIssuesCheckError; this one silently looked identical to "no match" until now).
function matchKnownIssueForError(errorText) {
  if (!errorText) return { match: null, checkError: null };
  let loaded;
  try { loaded = loadKnownIssues(); } catch (err) { return { match: null, checkError: err.message }; }
  if (!loaded?.issues.length) return { match: null, checkError: null };
  const hit = loaded.issues.find((issue) => issue.matches(errorText));
  // `retry` rides along only when the entry declared one, so a text-only entry's match keeps
  // exactly the shape every existing consumer/test already sees.
  return { match: hit ? { id: hit.id, description: hit.description, remediation: hit.remediation, ...(hit.retry ? { retry: hit.retry } : {}) } : null, checkError: null };
}

// Round-9 gap: matchKnownIssueForError above decorates a failed ACTION's error inline
// (dispatchTracked), but the durable "net history"/"console history" routes (GET
// /sessions/:id/net, GET /sessions/:id/console - db.mjs's passively-captured tables) returned
// raw entries with no known-issue match of their own, even though the cross-session aggregate
// (topFailedNetUrls/topFailedConsoleMessages, computeAnalytics below) has carried one since
// round 8. Same single-hit-per-entry shape as matchKnownIssueForError; skips entries whose
// text is empty (e.g. a net entry with no error and no status) rather than matching nothing.
function decorateEntriesWithKnownIssue(entries, textFor) {
  return entries.map((entry) => {
    const { match } = matchKnownIssueForError(textFor(entry));
    return match ? { ...entry, knownIssue: match } : entry;
  });
}

// getActionCostByTarget's "biggest single targets" ranks by bytes alone - a target near the
// top because it keeps failing and getting retried looks identical to one that's just
// naturally verbose, so the dashboard's cut-hint column had no way to point at the real fix
// (the known-issue's remediation) instead of a generic scoping tip. Joins on the same
// `${type}::${target}` key getActionFailureTextsByTarget groups on.
function decorateTargetsWithKnownIssue(rows, failureTextsByTarget) {
  return rows.map((r) => {
    const errors = failureTextsByTarget.get(`${r.type}::${r.target}`);
    if (!errors?.length) return r;
    const { match } = matchKnownIssueForError(errors.join('\n'));
    return match ? { ...r, knownIssue: match } : r;
  });
}

// decorateTargetsWithKnownIssue above only reaches idb.dump/dom.query rows - the only two types
// getActionCostByTarget can extract a meaningful target for. Every other spend-driving type
// (eval, net.log, console.log, idb.put, timeout.verify - all of which already have their own
// SV_CUT_HINTS entry client-side) had no known-issue path at all. Joins on type ALONE against
// getActionFailureTextsByType, so it reaches the full byType spend table instead.
function decorateTypesWithKnownIssue(rows, failureTextsByType) {
  return rows.map((r) => {
    const errors = failureTextsByType.get(r.type);
    if (!errors?.length) return r;
    const { match } = matchKnownIssueForError(errors.join('\n'));
    return match ? { ...r, knownIssue: match } : r;
  });
}

// One row per currently-connected agent, so a single preflight can answer "is some tab fighting
// another over this agent name" instead of several manual `eval location.href` round trips.
function connectedAgentsSummary() {
  const now = Date.now();
  return [...agents.entries()]
    .filter(([, entry]) => entry.socket && !entry.socket.destroyed)
    .map(([name, entry]) => {
      const replacedCount = entry.replacedCount ?? 0;
      const msSinceLastReplace = entry.lastReplacedAt ? now - entry.lastReplacedAt : null;
      return {
        name, origin: entry.origin ?? null, connectedAt: entry.connectedAt, replacedCount, msSinceLastReplace,
        tabCollision: replacedCount > 0 && msSinceLastReplace !== null && msSinceLastReplace < TAB_COLLISION_WINDOW_MS,
      };
    });
}

// ---------- Ask AI ----------

async function handleAsk(sessionIdInput, question) {
  if (!question || typeof question !== 'string' || !question.trim()) {
    throw new HttpError(400, 'question is required');
  }
  const session = sessionIdInput ? dbApi.getSession(sessionIdInput) : dbApi.getCurrentSession();
  if (!session) throw new HttpError(409, 'no session specified and no active session - pass session_id or start one first');

  const actions = dbApi.listActions(session.id);
  const snapshots = dbApi.listSnapshots(session.id);
  const diffs = dbApi.listDiffs(session.id).map((d) => dbApi.getDiff(d.id));
  const { system_prompt, user_prompt } = buildPrompt({ session, actions, snapshots, diffs, question });

  const askedAt = new Date().toISOString();
  let answer = null;
  let error = null;
  try {
    answer = await askAI({ system_prompt, user_prompt });
  } catch (err) {
    error = err.message;
  }
  const answeredAt = new Date().toISOString();
  const actionId = dbApi.logAction({
    sessionId: session.id, type: 'ai.ask', params: { question },
    result: error ? null : { answer }, ok: !error, error, startedAt: askedAt, endedAt: answeredAt, agentName: DEFAULT_AGENT,
  });
  dbApi.saveQA({ sessionId: session.id, actionId, question, context: { system_prompt, user_prompt }, answer, error, askedAt, answeredAt });
  broadcastUpdate('action', session.id);
  broadcastUpdate('qa', session.id);
  if (error) throw new HttpError(502, error);
  return { answer, sessionId: session.id };
}

// ---------- HTTP plumbing ----------

// A notice is what an agent was just told (notices.mjs): it rides back in x-webscout-notices, is kept in
// session_notices for the report / "friction notices", and is pushed to the dashboard. The legacy per-kind
// header is still set by the caller, so older clients and scripts keep working unchanged.
function notify(res, sessionId, input) {
  try {
    const notice = notices.makeNotice(input);
    (res.webscoutNotices ??= []).push(notice);
    if (sessionId !== null && sessionId !== undefined) {
      dbApi.saveNotice(sessionId, notice);
      broadcastUpdate('notice', sessionId, { notice });
    }
  } catch { /* best-effort - a notice bug must never change a command's own reply */ }
}

function sendJson(res, status, body) {
  if (res.webscoutNotices?.length && !res.headersSent) { try { res.setHeader(notices.NOTICES_HEADER, notices.serializeNotices(res.webscoutNotices)); } catch { /* header is an extra, never the reply */ } }
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

// Canonical wire names are camelCase (the MCP params, ackRisk, tryRecovery...). The snake_case spellings the
// session-start route used to take are still accepted: every snake_case key also appears as its camelCase twin.
function withCamelAliases(body) {
  const out = { ...body };
  for (const [k, v] of Object.entries(body ?? {})) {
    if (!k.includes('_')) continue;
    const camel = k.replace(/_([a-z])/g, (_m, c) => c.toUpperCase());
    if (!(camel in out)) out[camel] = v;
  }
  return out;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      if (!body) { resolve({}); return; }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new HttpError(400, 'invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function connectedAgentNames() {
  return [...agents.entries()].filter(([, a]) => a.socket && !a.socket.destroyed).map(([name]) => name);
}

// `agents_connected`/`GET /agents` only ever reported socket-level presence
// - confirmed live to be actively misleading during a stuck-tab episode: it
// kept reporting the agent as "connected" for several minutes while the
// page's own JS thread was not responding to anything (reload, idb.list,
// eval all timed out serially). lastAckAt (set in handleAgentMessage below,
// on ANY reply - success or failure, `ping` included) is the one honest
// signal that the page thread itself is actually still alive, not just the
// socket. Additive - connectedAgentNames() above is unchanged so no
// existing caller (waitForReconnect's `agents.includes(name)`, the
// dashboard) needs to change shape.
function agentsDetail() {
  const now = Date.now();
  return [...agents.entries()]
    .filter(([, a]) => a.socket && !a.socket.destroyed)
    .map(([name, a]) => ({
      name,
      connectedAt: a.connectedAt ?? null,
      lastAckAt: a.lastAckAt ?? null,
      msSinceLastAck: a.lastAckAt ? now - a.lastAckAt : null,
      // Only changes on a real navigation (inject.js stamps this at script
      // eval time, not at WS-connect time) - see inject.js's RELAY_URL
      // comment. waitForReconnect uses a CHANGED loadId, not just a later
      // connectedAt, as its proof of an actual reload.
      loadId: a.loadId ?? null,
      // Set once per real navigation (same lifecycle as loadId, above) - a tab
      // predating this round's inject.js sends none, which is reported as null,
      // never guessed. See dispatchTracked's origin-pin check.
      origin: a.origin ?? null,
      ...agentBuildStatus(a),
    }));
}

// A tab keeps the inject.js it loaded until it navigates. `build` is the hash it
// reported on connect; a tab that sent none predates build stamps, so it is older
// than any inject.js this relay could compare against.
function agentBuildStatus(agent) {
  const expected = currentInjectBuild();
  const build = agent.build || null;
  return { build, expectedBuild: expected, agentStale: expected !== null && build !== expected };
}

function staleAgentNames() {
  return [...agents.entries()]
    .filter(([, a]) => a.socket && !a.socket.destroyed && agentBuildStatus(a).agentStale)
    .map(([name]) => name);
}

// What friction awareness did for ONE session, for its report: what it was told (kept notices), what it
// ignored (a target warned about that kept failing afterwards), what was declared fixed during it.
function sessionFrictionSummary(sessionId, session, actions) {
  const told = dbApi.listNotices({ sessionId, limit: 1000 });
  const failureTimes = new Map(); // friction key -> failed-action timestamps
  for (const a of actions) {
    if (a.ok) continue;
    for (const x of friction.expandDragTargets(a)) {
      const key = friction.frictionKeyFor(x.type, x.params, x.origin);
      if (!key) continue;
      const list = failureTimes.get(key) ?? [];
      list.push(a.started_at);
      failureTimes.set(key, list);
    }
  }
  const ignored = [];
  const seen = new Set();
  for (const n of told) {
    if (n.kind !== 'selector-risk' || !n.key || seen.has(n.key)) continue;
    seen.add(n.key);
    const after = (failureTimes.get(n.key) ?? []).filter((at) => at > n.at);
    if (after.length) ignored.push({ key: n.key, warnedAt: n.at, failuresAfter: after.length, message: n.message });
  }
  const to = session.ended_at ?? new Date().toISOString();
  let resolved = [];
  try {
    resolved = dbApi.listFrictionResolutions().filter((x) => x.resolved_at >= session.started_at && x.resolved_at <= to).map((x) => ({ type: x.type, selector: x.selector, resolvedAt: x.resolved_at, note: x.note ?? null }));
  } catch { /* best-effort */ }
  const byKind = {};
  for (const n of told) byKind[n.kind] = (byKind[n.kind] ?? 0) + 1;
  // Is each target that failed here getting better or worse over the sessions? (project-wide history, this session's targets)
  let trends = [];
  try {
    const cutoffs = new Map();
    for (const x of dbApi.listFrictionResolutions()) cutoffs.set(x.key, x.resolved_at);
    trends = friction.buildFrictionTrend(allActionsIncremental().actions, { resolutions: cutoffs })
      .filter((r) => failureTimes.has(r.key) && r.points.length >= 2)
      .slice(0, 6)
      .map((r) => ({ key: r.key, type: r.type, selector: r.selector, direction: r.direction, sparkline: r.sparkline }));
  } catch { /* best-effort */ }
  return { noticeCount: told.length, told: byKind, notices: told.slice(-50), ignored, resolved, trends };
}

// The full ranked target list (not the digest's top-N), rebuilt at most once per ANALYTICS_CACHE_MS: the
// filter / sort / limit of GET /friction/targets run over it, so every surface asks the same question.
let targetsMemo = null; // { at, list }
function allFrictionTargets() {
  const now = Date.now();
  if (targetsMemo && now - targetsMemo.at < ANALYTICS_CACHE_MS) return targetsMemo.list;
  const { actions } = allActionsIncremental();
  const resolutions = new Map();
  try { for (const x of dbApi.listFrictionResolutions()) resolutions.set(x.key, x.resolved_at); } catch { /* best-effort */ }
  const sessionWeights = new Map();
  for (const s of dbApi.listSessions()) if (s.strict_crv && friction.STRICT_CRV_FAIL_WEIGHT !== 1) sessionWeights.set(s.id, friction.STRICT_CRV_FAIL_WEIGHT);
  const list = friction.buildSelectorFriction(actions, { matchKnownIssues: lazyKnownIssueMatcher(), resolutions, sessionWeights, limit: 5000 });
  targetsMemo = { at: now, list };
  return list;
}

// What changed between a fix and the failure that followed it: the commits made in that window, from the project's own
// git history (WEBSCOUT_GIT_DIR, default this directory). null = no git here / git unavailable; [] = git says nothing
// was committed in between (so the relapse is probably not a code change: data, environment, a flaky page).
function commitsBetween(since, until) {
  if (!since || !until) return null;
  try {
    const r = spawnSync('git', ['-C', process.env.WEBSCOUT_GIT_DIR || __dirname, 'log', `--since=${since}`, `--until=${until}`, '--format=%h\t%s', '-n', '8'], { encoding: 'utf8', timeout: 3000, windowsHide: true });
    if (r.status !== 0 || r.error) return null;
    return r.stdout.split('\n').filter(Boolean).map((l) => { const [hash, ...rest] = l.split('\t'); return { hash, subject: rest.join('\t').slice(0, 120) }; });
  } catch { return null; }
}

// The ids of known issues whose reviewBy has passed; a session start mentions them so the date does not go unseen.
function knownIssuesDue() {
  try {
    const today = new Date().toISOString().slice(0, 10);
    return readKnownIssuesRaw().filter((e) => e && typeof e === 'object' && e.reviewBy && String(e.reviewBy) <= today).map((e) => e.id);
  } catch { return []; }
}

// known-issues.json as written (not compiled): what export hands out and import merges into.
function readKnownIssuesRaw() {
  try {
    const parsed = JSON.parse(fs.readFileSync(KNOWN_ISSUES_PATH, 'utf8'));
    if (!Array.isArray(parsed)) throw new HttpError(409, 'known-issues file must be a JSON array');
    return parsed;
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    if (err instanceof HttpError) throw err;
    throw new HttpError(409, `known-issues.json could not be read: ${err.message}`);
  }
}

async function gatherReportBundle(sessionId) {
  const session = dbApi.getSession(sessionId);
  const snapshots = dbApi.listSnapshots(sessionId);
  const diffs = dbApi.listDiffs(sessionId).map((d) => dbApi.getDiff(d.id));
  const actions = dbApi.listActions(sessionId);
  // Known-issues cross-reference on THIS session's own failed actions - matchKnownIssueForError
  // already runs live on a /command failure (dispatchTracked), so an agent mid-session sees the
  // remediation, but a saved/exported report previously re-derived nothing: it showed a bare
  // "FAIL: <message>" with zero trace that the bug was already root-caused. Re-matched here
  // (not read off the live action, which never persisted err.extra) so the report stays
  // correct even against a known-issues.json updated after the session ended. checkError is
  // surfaced once, not per action - a malformed registry degrading every row identically is
  // one fact, not N.
  let knownIssuesCheckError = null;
  const knownIssues = [];
  for (const a of actions) {
    if (a.ok || !a.error) continue;
    const { match, checkError } = matchKnownIssueForError(a.error);
    if (checkError) { knownIssuesCheckError = checkError; break; }
    if (match) knownIssues.push({ actionId: a.id, type: a.type, error: a.error, knownIssue: match });
  }
  return {
    session,
    actions,
    snapshots,
    diffs,
    qa: dbApi.listQA(sessionId),
    // Round-10 gap: GET /sessions/:id/net and /console (used live by "net history"/"console
    // history") gained per-entry knownIssue decoration in round 9 (decorateEntriesWithKnownIssue,
    // above), but this second call site over the same tables - a saved/exported report, the
    // ONE other place a session's raw net/console rows are read back - was missed, so a report
    // showed a bare failed request/console error with no trace it was already a known bug, same
    // gap round 9 had just closed for the live route.
    console: decorateEntriesWithKnownIssue(dbApi.listConsoleEntries(sessionId), (e) => e.message),
    net: decorateEntriesWithKnownIssue(dbApi.listNetEntries(sessionId), (e) => e.error || (e.status ? `HTTP ${e.status}` : '')),
    verityRuns: dbApi.listVerityRuns(sessionId).map((r) => dbApi.getVerityRun(r.id)),
    tokenReport: dbApi.getActionCostReport(sessionId),
    repeatedActionLoops: dbApi.findRepeatedActionLoops(sessionId),
    knownIssues,
    friction: sessionFrictionSummary(sessionId, session, actions),
    ...(knownIssuesCheckError ? { knownIssuesCheckError } : {}),
    // The dashboard's round-1/round-2 visualizations (session-viz.mjs), same models GET
    // /sessions/:id/viz serves - a saved report had zero trace of any of them before this.
    // Its own query (listActionsForViz), separate from the full listActions() above, since
    // that one intentionally skips result bodies this report never needed either.
    viz: buildSessionViz({
      session, actions: dbApi.listActionsForViz(sessionId, { limit: 20000 }), snapshots, diffs, clicks: dbApi.listClickNavigations(sessionId),
    }),
  };
}

// ---------- Friction Analytics ----------
//
// Every other route in this file is session-scoped by design (the
// evidentiary gate ties evidence to one declared goal) - this is the one
// deliberate global exception. Every prior improvement round (V4/V5/V6) got
// built the same way: a human hit friction in one bad session and reported
// it, then a fix shipped for that one thing. This reads the data this tool
// has already been recording since V1 - failure/ok per action, macro run
// tags, verity pass/fail - and surfaces recurring patterns across EVERY
// session, so friction is visible the moment someone opens the dashboard,
// not only after it gets hit again and complained about. See
// docs/web-scout-roadmap.md's V7 entry.
// Every action ever recorded, without re-reading and re-parsing the whole table on each analytics call. Rows are
// append-only, so the cache is exact with two cheap reads: the rows logged since the last call (id above the newest
// cached one) and the rows the db reports as updated since (its change feed, takeDirtyActionIds - delivered bytes,
// intents). Nothing is guessed about "recent" rows. pruneOldResults / pruneOldReadRows drop the cache.
let actionsMemo = null; // action rows, id ascending, result bodies dropped (analytics never reads them; keeping them would pin the whole history in memory)
// Only a golden diff's summary is read from a result (the "still dirty" panel); every other body is dropped.
const slimAction = (a) => ({ ...a, result: a.type === 'idb.diff' && a.result ? { summary: a.result.summary } : null, result_json: null });
function allActionsIncremental() {
  if (!actionsMemo) {
    actionsMemo = dbApi.listAllActions().actions.map(slimAction);
    dbApi.takeDirtyActionIds(); // everything was just read fresh
  } else {
    const lastId = actionsMemo.length ? actionsMemo[actionsMemo.length - 1].id : 0;
    const dirty = dbApi.takeDirtyActionIds().filter((id) => id <= lastId);
    if (dirty.length) {
      const fresh = new Map(dbApi.listAllActionsByIds(dirty).map((row) => [row.id, slimAction(row)]));
      actionsMemo = actionsMemo.map((row) => fresh.get(row.id) ?? row);
    }
    const added = dbApi.listAllActionsFrom(lastId + 1).actions.map(slimAction);
    if (added.length) actionsMemo = actionsMemo.concat(added);
  }
  return { actions: actionsMemo, skipped: Math.max(0, dbApi.countActions() - actionsMemo.length) };
}

function computeAnalytics() {
  const sessions = dbApi.listSessions();
  const { actions, skipped: malformedActionsSkipped } = allActionsIncremental();
  const macros = dbApi.listMacros();
  const verityRuns = dbApi.listAllVerityRuns();

  // Known-issues cross-reference (the operator-maintained known-issues.json registry, see
  // "Known-issues registry" above) previously only matched against live boot-console-errors
  // at "crv preflight" time - a failed action's own error text was never checked against it,
  // so a failure this engine already flags as recurring (failureRateByType, selectorFriction)
  // looked identical whether it was a brand-new mystery or a bug someone already root-caused
  // months ago. Loaded once per call and reused below. Best-effort: any load/parse problem
  // must not break the rest of analytics (same discipline as matchKnownIssues above).
  let knownIssues = [];
  let knownIssuesCheckError = null;
  try {
    const loaded = loadKnownIssues();
    if (loaded?.issues.length) knownIssues = loaded.issues;
  } catch (err) {
    // Same distinction the other two known-issues.json readers already make (matchKnownIssues'
    // report.knownIssuesCheckError, matchKnownIssueForError's checkError) - this was the one
    // remaining call site still silently degrading to "no cross-refs" on a malformed registry,
    // which reads identically to "checked, genuinely nothing matched" everywhere this feeds:
    // GET /analytics, crv preflight's knownFriction, the dashboard's friction panel.
    knownIssuesCheckError = err.message;
  }
  const matchKnownIssuesFor = (errorText) => {
    if (!errorText || !knownIssues.length) return [];
    return knownIssues.filter((issue) => issue.matches(errorText)).map(({ id, description, remediation }) => ({ id, description, remediation }));
  };
  // "Mark fixed" declarations (friction_resolutions): selector failures at or before the
  // declared instant stop counting, so a fixed selector stops ranking on cumulative-forever history.
  const resolutions = new Map();
  let resolutionRows = [];
  try {
    resolutionRows = dbApi.listFrictionResolutions();
    for (const r of resolutionRows) resolutions.set(r.key, r.resolved_at);
  } catch { /* best-effort - analytics works without resolutions */ }

  // 1. Failure rate by action type - only types with >=1 failure matter
  // here (a 100%-ok type is not friction), sorted by raw failure count.
  // wastedMs (summed duration of the failed calls) is the cost proxy behind the severity
  // score below: a timeout burns ~15s, a not-found miss ~nothing, and raw counts hid that.
  const byType = new Map();
  const knownIssuesByType = new Map();
  // after(kind, id, at): false when that scope was declared fixed at or after `at` (friction resolve type|macro|verity).
  const afterFix = (kind, id, at) => { const cutoff = resolutions.get(friction.scopeKey(kind, id)); return !(cutoff && at && at <= cutoff); };
  const countsForType = (a) => afterFix('type', a.type, a.started_at);
  for (const [type, t] of friction.tallyTypeFailures(actions, { counts: countsForType })) byType.set(type, t);
  for (const a of actions) {
    if (a.ok || !countsForType(a)) continue;
    for (const hit of matchKnownIssuesFor(a.error)) {
      const list = knownIssuesByType.get(a.type) ?? [];
      if (!list.some((x) => x.id === hit.id)) list.push(hit);
      knownIssuesByType.set(a.type, list);
    }
  }
  // Trend: current cumulative-forever counts can't say "did the fix work" - a bad early
  // round permanently drags the number even after a selector stops failing. Split
  // sessions (already chronological, oldest first) into two non-overlapping windows -
  // the most recent TREND_WINDOW sessions vs the TREND_WINDOW before those - and compare
  // per-type failure rate between them. Needs at least 4 sessions to form two windows of
  // 2+; below that there's nothing to split, so trend is simply omitted rather than
  // computed from a misleadingly tiny window.
  const TREND_WINDOW = Math.min(10, Math.floor(sessions.length / 2));
  const recentByType = new Map();
  const priorByType = new Map();
  if (TREND_WINDOW >= 2) {
    const orderedIds = sessions.map((s) => s.id);
    const recentWindowIds = new Set(orderedIds.slice(-TREND_WINDOW));
    const priorWindowIds = new Set(orderedIds.slice(-TREND_WINDOW * 2, -TREND_WINDOW));
    for (const a of actions) {
      const bucket = recentWindowIds.has(a.session_id) ? recentByType : priorWindowIds.has(a.session_id) ? priorByType : null;
      if (!bucket || !afterFix('type', a.type, a.started_at)) continue;
      const t = bucket.get(a.type) ?? { total: 0, failed: 0 };
      t.total += 1;
      if (!a.ok) t.failed += 1;
      bucket.set(a.type, t);
    }
  }
  const trendFor = (type) => {
    const r = recentByType.get(type);
    const p = priorByType.get(type);
    if (!r || !p) return undefined;
    const recentRate = r.failed / r.total;
    const priorRate = p.failed / p.total;
    return { recentRate, priorRate, delta: recentRate - priorRate };
  };
  const failureRateByType = [...byType.values()]
    .filter((t) => t.failed > 0)
    .map((t) => {
      const trend = trendFor(t.type);
      const knownForType = knownIssuesByType.get(t.type);
      return { ...t, failureRate: t.failed / t.total, ...(trend ? { trend } : {}), ...(knownForType?.length ? { knownIssues: knownForType } : {}) };
    })
    .sort((a, b) => b.failed - a.failed);

  // 2. Selectors that failed more than once - a single one-off miss is
  // normal; a selector failing repeatedly across sessions is the exact
  // "same wall hit again" pattern this exists to surface.
  // lastFailedAt is tracked alongside failCount so a selector that failed 5x two months
  // ago (since fixed) doesn't rank identically to one still failing this week - a plain
  // count has no way to tell "chronic" from "stale", and chasing a stale entry wastes a
  // session on something already dead.
  // One view, not two: the exact-string scan that used to live here disagreed with the warning an
  // agent was shown (different keys, no origin, no success-awareness), so the panel could say one
  // thing and the pre-action header another. selectorFriction (friction.mjs's buildSelectorFriction)
  // is the single source - selector-normalized and type-family-merged, scoped per origin,
  // success-aware (failures since the last success = "unresolved"), cost-ranked (failures + time
  // wasted + retries) and annotated with error classes and the recoveries that worked. Stores are
  // targets too (idb writes fail by store). The old `topFailedSelectors` alias is retired.
  const sessionWeights = new Map();
  for (const s of sessions) if (s.strict_crv && friction.STRICT_CRV_FAIL_WEIGHT !== 1) sessionWeights.set(s.id, friction.STRICT_CRV_FAIL_WEIGHT);
  const selectorFriction = friction.buildSelectorFriction(actions, { matchKnownIssues: matchKnownIssuesFor, resolutions, sessionWeights });
  // Many targets failing with one message is a single root cause, not N problems.
  const frictionClusters = friction.buildFrictionClusters(selectorFriction);
  // Failed a lot, then worked repeatedly across sessions: probably fixed, never declared.
  const resolveSuggestions = friction.findResolveSuggestions(actions, { resolutions });

  // 2c. Known-issue candidates - the same error text failing repeatedly with no
  // known-issues.json match is the entry nobody has written yet; draft only, never auto-written.
  const knownIssueCandidates = friction.buildKnownIssueCandidates(actions, { matchKnownIssues: matchKnownIssuesFor, frictionEntries: selectorFriction });
  // Declared fixed, failing again: what "mark fixed" promised to keep visible.
  const relapsedFriction = friction.buildRelapses(resolutionRows, actions);

  // 3. Macros recorded but never actually replayed, and macros that HAVE
  // been replayed but never once succeeded on any step (recorded,
  // presumably worked once to be recordable, but rot the moment the page
  // changes underneath it - a real, otherwise invisible failure mode for a
  // "record once, replay forever" feature).
  const macroRunStats = new Map(); // macroId -> { total, ok }
  for (const a of actions) {
    const macroId = a.params?.macroId;
    if (macroId === undefined || !afterFix('macro', macroId, a.started_at)) continue;
    const s = macroRunStats.get(macroId) ?? { total: 0, ok: 0 };
    s.total += 1;
    if (a.ok) s.ok += 1;
    macroRunStats.set(macroId, s);
  }
  const macrosNeverRun = macros.filter((m) => !macroRunStats.has(m.id)).map((m) => ({ id: m.id, name: m.name }));
  const macrosNeverSucceeding = macros
    .filter((m) => macroRunStats.has(m.id) && macroRunStats.get(m.id).ok === 0)
    .map((m) => ({ id: m.id, name: m.name, attemptedSteps: macroRunStats.get(m.id).total }));

  // 4. Verity labels whose most recent import is still FAIL - a scenario
  // that got imported failing and never came back passing (no later
  // re-import under the same label with passed:true).
  const byLabel = new Map();
  for (const v of verityRuns) {
    if (!v.label || !afterFix('verity', v.label, v.imported_at)) continue;
    const arr = byLabel.get(v.label) ?? [];
    arr.push(v);
    byLabel.set(v.label, arr);
  }
  const verityLabelsStillFailing = [...byLabel.entries()]
    .map(([label, runs]) => ({ label, runs: runs.sort((a, b) => a.id - b.id) }))
    .filter(({ runs }) => runs[runs.length - 1].passed === false)
    .map(({ label, runs }) => ({ label, importCount: runs.length, lastImportedAt: runs[runs.length - 1].imported_at }));

  // 5. Type x session failure-rate heatmap - the last HEATMAP_SESSION_LIMIT
  // sessions (most recent, chronological) crossed with the
  // HEATMAP_TYPE_LIMIT busiest action types (by total call count). Bounded
  // both ways so this stays a glanceable grid instead of growing unreadable
  // (or unboundedly expensive) as the DB accumulates history - a heatmap
  // with 500 columns defeats its own purpose.
  const HEATMAP_SESSION_LIMIT = 15;
  const HEATMAP_TYPE_LIMIT = 8;
  const recentSessions = sessions.slice(-HEATMAP_SESSION_LIMIT);
  const recentSessionIds = new Set(recentSessions.map((s) => s.id));
  const topTypes = [...byType.values()].sort((a, b) => b.total - a.total).slice(0, HEATMAP_TYPE_LIMIT).map((t) => t.type);
  const topTypeSet = new Set(topTypes);
  const heatmapCells = new Map(); // `${sessionId}::${type}` -> { total, failed }
  for (const a of actions) {
    if (!recentSessionIds.has(a.session_id) || !topTypeSet.has(a.type)) continue;
    const key = `${a.session_id}::${a.type}`;
    const cell = heatmapCells.get(key) ?? { total: 0, failed: 0 };
    cell.total += 1;
    if (!a.ok) cell.failed += 1;
    heatmapCells.set(key, cell);
  }
  const heatmap = {
    sessions: recentSessions.map((s) => ({ id: s.id, goal: s.goal })),
    types: topTypes,
    cells: recentSessions.flatMap((s) => topTypes.map((type) => {
      const cell = heatmapCells.get(`${s.id}::${type}`);
      return { sessionId: s.id, type, total: cell?.total ?? 0, failed: cell?.failed ?? 0 };
    })),
  };

  // 6. Per-macro run history (pass/fail dot strip, CI-build-style). A "run"
  // is a burst of consecutive same-macroId actions in the overall
  // chronological action log - macro steps for one invocation are always
  // logged back-to-back, so a macroId change (or a non-macro action
  // between them) is a real run boundary, not an artifact of storage order.
  // Capped to the last MACRO_RUN_HISTORY_LIMIT runs per macro (most recent
  // last) - this feeds a small dot strip, not a full audit log.
  const macroRunHistory = friction.buildMacroRuns(actions, { afterFix });
  const macroHealth = macros.map((m) => ({
    id: m.id,
    name: m.name,
    runs: (macroRunHistory.get(m.id) ?? []).map((r) => r.ok),
  }));

  // 7. Session activity punchcard - hour-of-day x day-of-week counts across
  // EVERY session's own started_at, github-contributions-style. Answers
  // "when does work/friction actually happen" at a glance, which no
  // existing single-session view (all scoped to one session's own short
  // window) can show.
  const activityPunchcard = Array.from({ length: 7 }, () => new Array(24).fill(0));
  for (const s of sessions) {
    const d = new Date(s.started_at);
    if (Number.isNaN(d.getTime())) continue;
    activityPunchcard[d.getDay()][d.getHours()] += 1;
  }

  // 8. Action duration percentiles by type, across every session - the
  // Action log's own "ms" column sorts one session at a time and shows raw
  // values; this answers "which action TYPE has a long tail" project-wide,
  // which sorting a single session's rows can't (a type that's usually fast
  // but occasionally very slow looks identical to a consistently-medium one
  // in a sorted list).
  const durationsByType = new Map();
  for (const a of actions) {
    const list = durationsByType.get(a.type) ?? [];
    list.push(a.duration_ms);
    durationsByType.set(a.type, list);
  }
  const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  const durationByType = [...durationsByType.entries()]
    .map(([type, list]) => {
      const sorted = [...list].sort((a, b) => a - b);
      return { type, count: sorted.length, p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), max: sorted[sorted.length - 1] };
    })
    .sort((a, b) => b.p95 - a.p95);

  // 9. Waste rate by session - reuses buildWaste (session-viz.mjs's own round-2 "Waste and
  // retries" model), grouping the SAME `actions` array already scanned above by session_id
  // (no extra query). Ranks sessions where the highest share of calls bought nothing (a failure
  // never retried, a duplicate read that came back unchanged) - the per-session Waste panel's own
  // number, made visible across every session at once instead of requiring a human to open each
  // one to notice a chronically wasteful shape of work. Sessions under WASTE_MIN_CALLS are
  // excluded - a 2-call session at 50% waste is noise, not a pattern.
  const WASTE_MIN_CALLS = friction.WASTE_MIN_CALLS;
  const actionsBySession = new Map();
  for (const a of actions) {
    const list = actionsBySession.get(a.session_id);
    if (list) list.push(a); else actionsBySession.set(a.session_id, [a]);
  }
  const wasteBySession = sessions
    .map((s) => {
      const w = buildWaste(actionsBySession.get(s.id) ?? []);
      return { sessionId: s.id, goal: s.goal, calls: w.totals.calls, wastedCalls: w.totals.wastedCalls, wastePct: w.totals.wastePct };
    })
    .filter((r) => r.calls >= WASTE_MIN_CALLS)
    .sort((a, b) => b.wastePct - a.wastePct)
    .slice(0, 15);

  // 10. Macro adoption - macrosNeverRun (above) catches a macro that was recorded but
  // never replayed; this catches the earlier failure: sessions that crossed the
  // mid-session "consider macro record" nudge threshold (see maybeMidSessionNudge's
  // own >=5 replayable-actions check, same DEFAULT_MACRO_TYPES/threshold reused here so
  // this can never disagree with what was actually shown) and STILL never recorded a
  // macro at all. Confirmed real: a session hit that nudge, printed it to stderr mid a
  // long CRV pass, and the macro was never recorded that session or any later one -
  // the nudge fired and was seen, but nothing kept the fact that it was ignored visible
  // past that session's own scrollback. macrosEverRecorded===0 here is the same signal
  // "analytics".totals.macros already carries; this just also names WHICH sessions
  // earned the nudge, so the note below is a claim a human/agent can go verify.
  const NUDGE_ELIGIBLE_THRESHOLD = 5;
  const replayableCountBySession = new Map();
  for (const a of actions) {
    if (!a.ok || !DEFAULT_MACRO_TYPES.has(a.type)) continue;
    replayableCountBySession.set(a.session_id, (replayableCountBySession.get(a.session_id) ?? 0) + 1);
  }
  const nudgeEligibleSessions = [...replayableCountBySession.entries()]
    .filter(([, count]) => count >= NUDGE_ELIGIBLE_THRESHOLD)
    .map(([sessionId, count]) => ({ sessionId, count, goal: sessions.find((s) => s.id === sessionId)?.goal ?? null }));
  const macroAdoption = {
    nudgeEligibleSessionCount: nudgeEligibleSessions.length,
    macrosEverRecorded: macros.length,
    recentEligibleSessions: nudgeEligibleSessions.slice(-5),
    ...(macros.length === 0 && nudgeEligibleSessions.length >= 3
      ? { note: `${nudgeEligibleSessions.length} session(s) crossed the "consider recording a macro" nudge threshold (>=${NUDGE_ELIGIBLE_THRESHOLD} replayable actions) and none ever recorded one - the nudge is firing and being ignored, not missing. Run "macro record \\"<name>\\" <sessionId>" the next time a seed/verify/cleanup (or similar) shape repeats.` }
      : {}),
  };

  // 11. Golden-diff dirt still failing - structurally the same gap verityLabelsStillFailing
  // (above) closes for Verity imports: a "diff-golden" comparison (POST /state/diff with a
  // golden name, logged as an 'idb.diff' action with params.golden) whose most recent result
  // came back non-clean (summary has keys - something changed) had zero cross-session
  // visibility before this - you'd only notice by re-running that exact diff-golden call
  // again. "Clean" uses the same test runSuite's own diff-golden step already applies
  // (Object.keys(summary).length === 0).
  const isDiffClean = (a) => Object.keys(a.result?.summary || {}).length === 0;
  const byGolden = new Map();
  for (const a of actions) {
    if (a.type !== 'idb.diff' || !a.params?.golden) continue;
    const arr = byGolden.get(a.params.golden) ?? [];
    arr.push(a);
    byGolden.set(a.params.golden, arr);
  }
  const goldenDiffsStillFailing = [...byGolden.entries()]
    .map(([golden, runs]) => ({ golden, runs: runs.sort((x, y) => x.id - y.id) }))
    .filter(({ runs }) => !isDiffClean(runs[runs.length - 1]))
    .map(({ golden, runs }) => ({ golden, diffCount: runs.length, lastDiffedAt: runs[runs.length - 1].started_at }));

  // 12. Repeating network/console failures - matchKnownIssuesFor (above) only ever ran
  // against actions.error (a dom/idb/eval dispatch failure logged through dispatchTracked).
  // net_entries/console_entries are captured passively, batched straight from the page (see
  // inject.js), and never contributed to a failure-rate ranking or the known-issues
  // cross-reference - a repeating HTTP 500 or console.error was invisible here even though
  // "net log --failed" already tags each request pass/fail. Same shape as topFailedSelectors
  // above (repeat-count ranked, decorated with knownIssues when the registry matches); built
  // from failed/errored rows only (dbApi.listFailedNetEntries/listFailedConsoleEntries filter
  // in SQL), not a scan of the 60K+ rows net_entries alone can hold.
  const netByUrl = new Map();
  for (const n of dbApi.listFailedNetEntries()) {
    const key = n.url || '(no url)';
    const s = netByUrl.get(key) ?? { url: key, failCount: 0, sessionIds: new Set(), lastFailedAt: null, knownIssues: [] };
    s.failCount += 1;
    s.sessionIds.add(n.session_id);
    if (!s.lastFailedAt || n.started_at > s.lastFailedAt) s.lastFailedAt = n.started_at;
    for (const hit of matchKnownIssuesFor(n.error || (n.status ? `HTTP ${n.status}` : ''))) if (!s.knownIssues.some((x) => x.id === hit.id)) s.knownIssues.push(hit);
    netByUrl.set(key, s);
  }
  const topFailedNetUrls = [...netByUrl.values()]
    .filter((s) => s.failCount > 1)
    .map((s) => ({ url: s.url, failCount: s.failCount, sessionCount: s.sessionIds.size, lastFailedAt: s.lastFailedAt, ...(s.knownIssues.length ? { knownIssues: s.knownIssues } : {}) }))
    .sort((a, b) => b.failCount - a.failCount);

  const consoleByMessage = new Map();
  for (const c of dbApi.listFailedConsoleEntries()) {
    const key = c.message;
    const s = consoleByMessage.get(key) ?? { message: key, failCount: 0, sessionIds: new Set(), lastFailedAt: null, knownIssues: [] };
    s.failCount += 1;
    s.sessionIds.add(c.session_id);
    if (!s.lastFailedAt || c.occurred_at > s.lastFailedAt) s.lastFailedAt = c.occurred_at;
    for (const hit of matchKnownIssuesFor(c.message)) if (!s.knownIssues.some((x) => x.id === hit.id)) s.knownIssues.push(hit);
    consoleByMessage.set(key, s);
  }
  const topFailedConsoleMessages = [...consoleByMessage.values()]
    .filter((s) => s.failCount > 1)
    .map((s) => ({ message: s.message, failCount: s.failCount, sessionCount: s.sessionIds.size, lastFailedAt: s.lastFailedAt, ...(s.knownIssues.length ? { knownIssues: s.knownIssues } : {}) }))
    .sort((a, b) => b.failCount - a.failCount);

  // 13. Repeated eval-body shapes - a session asked "what's still being hand-rolled via eval"
  // by hand-querying webscout.db's actions table directly (see [[web-scout-v43-round]]) and
  // found the answer was there all along, just never surfaced: css.hasRule (V42) came from
  // that one manual query, but the query itself was a one-off - nothing kept re-running it.
  // Normalizes each eval's expr (string/number literals -> placeholders, whitespace collapsed)
  // so structurally-identical calls that only differ by selector/literal text collapse into one
  // shape, then ranks by repeat count. A shape repeated only once is normal variation, not a
  // pattern - EVAL_SHAPE_MIN_COUNT excludes it. This is a candidate-command finder, not a
  // command itself: a shape ranking here is a lead to design a real typed command around
  // (the way css.hasRule replaced the #1 shape a manual pass of this exact idea once found),
  // not something to build sight-unseen from the normalized text alone.
  const EVAL_SHAPE_MIN_COUNT = 2;
  const normalizeEvalShape = (expr) => expr
    .replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g, 'STR')
    .replace(/\b\d+(\.\d+)?\b/g, 'NUM')
    .replace(/\s+/g, ' ')
    .trim();
  const evalShapes = new Map();
  for (const a of actions) {
    if (a.type !== 'eval') continue;
    const expr = a.params?.expr;
    if (!expr || typeof expr !== 'string') continue;
    const shape = normalizeEvalShape(expr);
    const s = evalShapes.get(shape) ?? { shape, count: 0, sessionIds: new Set(), firstSeenAt: a.started_at, lastSeenAt: a.started_at, example: expr };
    s.count += 1;
    s.sessionIds.add(a.session_id);
    if (a.started_at < s.firstSeenAt) s.firstSeenAt = a.started_at;
    if (a.started_at >= s.lastSeenAt) { s.lastSeenAt = a.started_at; s.example = expr; }
    evalShapes.set(shape, s);
  }
  const repeatedEvalShapes = [...evalShapes.values()]
    .filter((s) => s.count >= EVAL_SHAPE_MIN_COUNT)
    .map((s) => ({ shape: s.shape, count: s.count, sessionCount: s.sessionIds.size, firstSeenAt: s.firstSeenAt, lastSeenAt: s.lastSeenAt, example: s.example.length > 300 ? `${s.example.slice(0, 300)}...` : s.example }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);

  // 14. Top friction items - everything above is now ~14 separate arrays; this is a single
  // ranked digest of the highest-signal entry from each, so a human/agent can read one
  // short list instead of scanning the whole analytics blob to find what to fix first.
  // Severity is a deliberately crude score (not a real cost model) - good enough to rank a
  // handful of candidates, not meant to be precise. Failure counts are weighted by wasted time
  // (1 point per second spent inside failed calls), so one selector that burns a 15s timeout
  // each time outranks ten instant not-found misses. Time is the only cost measured here;
  // a failed call's reply is tiny, so token cost would add noise, not signal.
  const wastedText = (ms) => (ms >= 1000 ? `, ~${Math.round(ms / 1000)}s spent failing` : '');
  const topFrictionItems = [];
  const knownIssueText = (list) => (list?.length
    ? ` - known issue: ${list.map((k) => (k.remediation ? `${k.id} (${k.remediation})` : k.id)).join(', ')}`
    : '');
  if (failureRateByType[0]) {
    const t = failureRateByType[0];
    const trendText = t.trend ? `, trend ${t.trend.delta <= 0 ? 'improving' : 'worsening'} (${Math.round(t.trend.priorRate * 100)}% -> ${Math.round(t.trend.recentRate * 100)}%)` : '';
    topFrictionItems.push({ kind: 'failureRateByType', severity: t.failed + Math.round(t.wastedMs / 1000), summary: `"${t.type}" failed ${t.failed}/${t.total} times (${Math.round(t.failureRate * 100)}%)${wastedText(t.wastedMs)}${trendText}${knownIssueText(t.knownIssues)} - fixed? friction resolve type ${t.type}` });
  }
  if (selectorFriction.length) {
    // Already cost-ranked (failures + time wasted + retries) by buildSelectorFriction.
    const s = selectorFriction[0];
    topFrictionItems.push({ kind: 'topFailedSelector', severity: Math.round(s.score), summary: `${s.targetKind === 'store' ? 'store' : 'selector'} "${s.selector}" (${s.type}) failed ${s.failCount}x across ${s.sessionCount} session(s), last at ${s.lastFailedAt}${wastedText(s.wastedMs)}${s.wastedTokens ? `, ~${s.wastedTokens} tokens` : ''}${s.retries ? `, retried ${s.retries}x` : ''}${knownIssueText(s.knownIssues)}` });
  }
  for (const m of macrosNeverSucceeding) {
    topFrictionItems.push({ kind: 'macroNeverSucceeding', severity: 50 + m.attemptedSteps, summary: `macro "${m.name}" (#${m.id}) has run ${m.attemptedSteps} step(s) and never once succeeded - fixed? friction resolve macro ${m.id}` });
  }
  for (const v of verityLabelsStillFailing) {
    topFrictionItems.push({ kind: 'verityLabelStillFailing', severity: 40 + v.importCount, summary: `verity label "${v.label}" imported ${v.importCount}x, still FAIL as of ${v.lastImportedAt} - fixed? friction resolve verity ${JSON.stringify(v.label)}` });
  }
  for (const g of goldenDiffsStillFailing) {
    topFrictionItems.push({ kind: 'goldenDiffStillFailing', severity: 40 + g.diffCount, summary: `golden "${g.golden}" diffed ${g.diffCount}x, still dirty as of ${g.lastDiffedAt}` });
  }
  if (topFailedNetUrls[0]) {
    const n = topFailedNetUrls[0];
    topFrictionItems.push({ kind: 'topFailedNetUrl', severity: n.failCount, summary: `network request "${n.url}" failed ${n.failCount}x across ${n.sessionCount} session(s), last at ${n.lastFailedAt}${knownIssueText(n.knownIssues)}` });
  }
  if (topFailedConsoleMessages[0]) {
    const c = topFailedConsoleMessages[0];
    topFrictionItems.push({ kind: 'topFailedConsoleMessage', severity: c.failCount, summary: `console error "${c.message.slice(0, 120)}" occurred ${c.failCount}x across ${c.sessionCount} session(s), last at ${c.lastFailedAt}${knownIssueText(c.knownIssues)}` });
  }
  if (macroAdoption.note) {
    topFrictionItems.push({ kind: 'macroAdoption', severity: 30 + macroAdoption.nudgeEligibleSessionCount, summary: macroAdoption.note });
  }
  if (wasteBySession[0]) {
    const w = wasteBySession[0];
    topFrictionItems.push({ kind: 'wasteBySession', severity: Math.round((w.wastePct / 100) * w.calls), summary: `session ${w.sessionId}${w.goal ? ` ("${w.goal}")` : ''} wasted ${Math.round(w.wastePct)}% of ${w.calls} calls` });
  }
  // Host resources (scratch dirs/MB, orphan browsers, free disk) from the cached host-health snapshot - peeked, never
  // awaited, so analytics stays synchronous and fast; null until the first background scan lands (or scan disabled).
  const host = hostHealth.peekHostHealth();
  topFrictionItems.push(...hostHealth.hostFrictionItems(host));
  if (repeatedEvalShapes[0]) {
    const e = repeatedEvalShapes[0];
    const preview = e.example.length > 80 ? `${e.example.slice(0, 80)}...` : e.example;
    topFrictionItems.push({ kind: 'repeatedEvalShape', severity: e.count, summary: `eval shape repeated ${e.count}x across ${e.sessionCount} session(s) - "${preview}" - candidate for a real command` });
  }
  if (relapsedFriction[0]) {
    const x = relapsedFriction[0];
    topFrictionItems.push({ kind: 'regression', severity: 80 + x.failuresSince, summary: `${x.summary}${relapsedFriction.length > 1 ? ` (+${relapsedFriction.length - 1} more relapse(s))` : ''} - see: friction regressions` });
  }
  topFrictionItems.sort((a, b) => b.severity - a.severity);
  topFrictionItems.splice(5);

  return {
    totals: { sessions: sessions.length, actions: actions.length, macros: macros.length, verityRuns: verityRuns.length },
    malformedActionsSkipped,
    ...(knownIssuesCheckError ? { knownIssuesCheckError } : {}),
    failureRateByType,
    selectorFriction,
    frictionClusters,
    knownIssueCandidates,
    resolveSuggestions,
    frictionConfig: friction.frictionConfig(),
    relapsedFriction,
    resolvedFriction: resolutionRows.map((r) => ({ key: r.key, type: r.type, selector: r.selector, note: r.note, resolvedAt: r.resolved_at })),
    topFailedNetUrls,
    topFailedConsoleMessages,
    macrosNeverRun,
    macrosNeverSucceeding,
    verityLabelsStillFailing,
    goldenDiffsStillFailing,
    heatmap,
    macroHealth,
    macroAdoption,
    repeatedEvalShapes,
    topFrictionItems,
    host: host ? { scratchBytes: host.scratchBytes, scratchDirs: host.metrics.dirs, staleDirs: host.staleDirs, orphanBrowsers: host.orphanBrowsers.length, freeDiskGb: host.metrics.freeGb, at: host.at } : null,
    activityPunchcard,
    durationByType,
    wasteBySession,
    // One row per session (id/goal/tags/startedAt/totalEstTokens) - the
    // dashboard groups these by shared tag client-side to trend token cost
    // across repeated work (this project's own round-1/round-2/... CRV
    // convention), answering "is this shape getting cheaper or more
    // wasteful each time" which no single session's own token-report can.
    sessionTokenTotals: dbApi.getSessionTokenTotals(),
  };
}

// Every open dashboard tab polls this every 3s (see dashboard.html's
// refreshAll); computeAnalytics() does a full scan of EVERY action ever
// recorded, unfiltered and unpaginated. Fine at today's row count, but with
// N open tabs that's N full scans every 3 seconds, forever, growing with
// every session the tool ever records - confirmed as the actual shape of
// the problem (this endpoint was flagged as its own future bottleneck the
// same round it shipped). A short server-side TTL cache means at most one
// full scan per ANALYTICS_CACHE_MS server-wide, shared across every open
// tab, regardless of how many are polling - result can be up to that many
// ms stale, acceptable given the dashboard already tolerates the same lag
// via its own poll/SSE pattern elsewhere.
// WEBSCOUT_ANALYTICS_CACHE_MS=0 turns the cache off (tests that assert on analytics across several steps).
const ANALYTICS_CACHE_MS = process.env.WEBSCOUT_ANALYTICS_CACHE_MS ? Number(process.env.WEBSCOUT_ANALYTICS_CACHE_MS) || 0 : 5000;
let analyticsCache = null; // { at, data }

function getAnalytics() {
  const now = Date.now();
  if (analyticsCache && (now - analyticsCache.at) < ANALYTICS_CACHE_MS) return analyticsCache.data;
  const data = computeAnalytics();
  analyticsCache = { at: now, data };
  return data;
}

// ---------- Emergent-friction diff (session end) ----------
//
// topFrictionItems is a global top-5 digest - real but rare friction from ONE session would
// never surface there (it hasn't accumulated enough occurrences project-wide to rank yet).
// This diffs a just-ended session's own failures against the CURRENT project-wide totals
// (computeAnalytics(), uncached, so this session's own just-logged actions are reflected -
// same discipline as session start's own uncached call) and flags a type/selector whose
// entire historical fail count IS this session's count - i.e. the first session ever to see
// it fail (or, for a selector, fail more than once) - as "emergent", the moment it happens
// instead of only after it quietly repeats enough to rank on its own.
function emergentFrictionForSession(sessionId) {
  const sessionFails = dbApi.listActions(sessionId).filter((a) => !a.ok);
  // Round-9 gap: this used to only scan dbApi.listActions (dom/idb/eval/net-wait/console-wait
  // command dispatches) - a session's first-ever failing network request or console error,
  // passively captured into net_entries/console_entries rather than dispatched as a command,
  // was invisible here even though topFailedNetUrls/topFailedConsoleMessages (round 8) track
  // the exact same data cross-session. Filtered to this session up front so the early-return
  // below still skips computeAnalytics() for a session with no failures of any kind.
  const sessionFailedNet = dbApi.listFailedNetEntries().filter((n) => n.session_id === sessionId);
  const sessionFailedConsole = dbApi.listFailedConsoleEntries().filter((c) => c.session_id === sessionId);
  if (!sessionFails.length && !sessionFailedNet.length && !sessionFailedConsole.length) return [];
  const analytics = computeAnalytics();
  const emergent = [];

  const failCountByType = new Map();
  for (const a of sessionFails) failCountByType.set(a.type, (failCountByType.get(a.type) ?? 0) + 1);
  for (const [type, countThisSession] of failCountByType) {
    const global = analytics.failureRateByType.find((t) => t.type === type);
    if (global && global.failed === countThisSession) {
      emergent.push(`"${type}" failed ${countThisSession}x this session - the first session ever to see this type fail.`);
    }
  }

  const failCountByTarget = new Map();
  for (const a of sessionFails.flatMap(friction.expandDragTargets)) {
    const target = friction.frictionTarget(a.type, a.params, a.origin);
    if (!target) continue;
    const key = friction.frictionKeyFor(a.type, a.params, a.origin);
    const g = failCountByTarget.get(key) ?? { count: 0, target };
    g.count += 1;
    failCountByTarget.set(key, g);
  }
  for (const [key, { count: countThisSession, target }] of failCountByTarget) {
    // selectorFriction only lists failCount > 1 - below that threshold there is nothing
    // to diff against yet, so a target failing exactly once this session is left for a
    // later session to potentially flag, not reported as emergent on a single data point.
    if (countThisSession < 2) continue;
    const global = analytics.selectorFriction.find((s) => s.key === key);
    if (global && global.failCount === countThisSession) {
      emergent.push(`${target.kind} "${target.value}" (${friction.typeFamily(global.type)}) failed ${countThisSession}x this session - the first session ever to see it fail more than once.`);
    }
  }
  // Types that already have failure history are skipped by the "first ever" diff above even
  // when this session made them dramatically worse - flag a failure-rate spike against the
  // rate across every OTHER session.
  emergent.push(...friction.findRateSpikes(dbApi.listActions(sessionId), analytics.failureRateByType));

  const failCountByUrl = new Map();
  for (const n of sessionFailedNet) {
    const key = n.url || '(no url)';
    failCountByUrl.set(key, (failCountByUrl.get(key) ?? 0) + 1);
  }
  for (const [url, countThisSession] of failCountByUrl) {
    // topFailedNetUrls only lists failCount > 1 - same threshold discipline as selectors above.
    if (countThisSession < 2) continue;
    const global = analytics.topFailedNetUrls.find((s) => s.url === url);
    if (global && global.failCount === countThisSession) {
      emergent.push(`network request "${url}" failed ${countThisSession}x this session - the first session ever to see it fail more than once.`);
    }
  }

  const failCountByMessage = new Map();
  for (const c of sessionFailedConsole) {
    failCountByMessage.set(c.message, (failCountByMessage.get(c.message) ?? 0) + 1);
  }
  for (const [message, countThisSession] of failCountByMessage) {
    if (countThisSession < 2) continue;
    const global = analytics.topFailedConsoleMessages.find((s) => s.message === message);
    if (global && global.failCount === countThisSession) {
      emergent.push(`console error "${message.slice(0, 120)}" occurred ${countThisSession}x this session - the first session ever to see it repeat.`);
    }
  }
  return emergent;
}

// "Mark fixed?" at session end: for each target this session touched (indexed lookups, not a full
// scan), ask whether it failed repeatedly in the past and has now worked several times running
// across sessions. A human would have to notice that and run `friction resolve`; this says so.
// type + (selector | store) from a JSON body or query, normalized to friction.mjs's key.
// Declares a target fixed as of now. The one place that writes a resolution, so the route, session end's
// apply path and any future caller store exactly the same row.
function declareFrictionResolved(type, value, kind, note) {
  if (friction.SCOPE_KINDS.has(kind)) {
    return dbApi.markFrictionResolved({ key: friction.scopeKey(kind, value), type: kind, selector: String(value), note: typeof note === 'string' ? note : null });
  }
  const params = kind === 'page' ? {} : kind === 'store' ? { store: value } : { selector: value };
  const origin = kind === 'page' ? value : null;
  const target = friction.frictionTarget(type, params, origin);
  if (!target) throw new HttpError(400, `"${type}" cannot be tracked as a ${kind}`);
  return dbApi.markFrictionResolved({ key: friction.frictionKeyFor(type, params, origin), type: friction.typeFamily(type), selector: target.value, note: typeof note === 'string' ? note : null });
}

// `friction resolve cluster <id>`: one declaration for every target of a one-cause cluster (ids come from
// analytics.frictionClusters / the digest). The cluster is recomputed uncached at call time, with ALL its
// targets, so the ones the digest truncated are included. Returns what was resolved - the undo list.
function resolveFrictionCluster(body, resolve) {
  let targets;
  const id = typeof body.selector === 'string' && body.selector ? body.selector : typeof body.id === 'string' ? body.id : '';
  if (!resolve && Array.isArray(body.targets)) {
    targets = body.targets; // undo: a resolved cluster no longer exists to look up, so the caller hands back what it got
  } else {
    if (!id) throw new HttpError(400, 'a cluster id is required: friction resolve cluster <id> (ids are listed under frictionClusters in "analytics")');
    const cluster = friction.buildFrictionClusters(computeAnalytics().selectorFriction, { limit: Infinity, targetLimit: Infinity }).find((c) => c.id === id);
    if (!cluster) throw new HttpError(404, `no cluster "${id}" (it may already be resolved; clusters are listed under frictionClusters in "analytics")`);
    targets = cluster.targets.map((t) => ({ type: t.type, selector: t.selector, kind: t.targetKind || 'selector' }));
  }
  const done = [];
  for (const t of targets.slice(0, 200)) {
    if (!t || typeof t.type !== 'string' || typeof t.selector !== 'string') continue;
    const kind = t.kind || 'selector';
    if (resolve) declareFrictionResolved(t.type, t.selector, kind, body.note ?? `cluster ${id}`);
    else {
      const params = kind === 'page' ? {} : kind === 'store' ? { store: t.selector } : { selector: t.selector };
      const key = friction.frictionKeyFor(t.type, params, kind === 'page' ? t.selector : null);
      if (key) dbApi.clearFrictionResolved(key);
    }
    done.push({ type: t.type, selector: t.selector, kind });
  }
  analyticsCache = null;
  broadcastUpdate('analytics', null);
  return { cluster: id || null, [resolve ? 'resolved' : 'unresolved']: done, count: done.length };
}

// A page-level type (page.reload, dom.settle, ...) is keyed by origin, which callers pass in the
// same `selector` slot: `friction explain page.reload http://localhost:3000`.
function frictionTargetFromBody(body, { allowScopes = true } = {}) {
  if (typeof body.type !== 'string' || !body.type) throw new HttpError(400, 'type is required (e.g. "dom.click")');
  if (friction.SCOPE_KINDS.has(body.type)) {
    const id = typeof body.selector === 'string' && body.selector ? body.selector : typeof body.store === 'string' ? body.store : '';
    if (!allowScopes) throw new HttpError(400, `"${body.type}" is a whole-scope target (resolve/unresolve only) - explain works on a selector, store or page target`);
    if (!id) throw new HttpError(400, `${body.type === 'type' ? 'a command type' : body.type === 'macro' ? 'a macro id' : 'a verity label'} is required: friction resolve ${body.type} <${body.type === 'type' ? 'command-type' : body.type === 'macro' ? 'id' : 'label'}>`);
    return { type: body.type, target: { kind: body.type, value: id }, key: friction.scopeKey(body.type, id), params: {}, origin: null };
  }
  const pageLevel = friction.PAGE_TYPES.has(body.type);
  const value = typeof body.selector === 'string' && body.selector ? body.selector : typeof body.store === 'string' && body.store ? body.store : '';
  if (!value) throw new HttpError(400, pageLevel ? `an origin is required for "${body.type}" (e.g. http://localhost:3000)` : 'selector (or store, for idb.* types) is required');
  const params = pageLevel ? {} : typeof body.selector === 'string' && body.selector ? { selector: body.selector } : { store: body.store };
  const origin = pageLevel ? value : null;
  const target = friction.frictionTarget(body.type, params, origin);
  if (!target) throw new HttpError(400, `"${body.type}" cannot be tracked by ${Object.keys(params)[0]} (a store only applies to idb.* types)`);
  return { type: body.type, target, key: friction.frictionKeyFor(body.type, params, origin), params, origin };
}

function resolveSuggestionsForSession(sessionId) {
  try {
    const keys = new Set(dbApi.listActions(sessionId).map((a) => a.selector_key).filter(Boolean));
    const out = [];
    for (const key of keys) {
      const rows = dbApi.listFrictionKeyHistory(key, { excludeSessionId: -1, recoverySessions: 0 });
      const cutoff = dbApi.getFrictionResolution(key)?.resolved_at;
      out.push(...friction.findResolveSuggestions(rows, { resolutions: cutoff ? new Map([[key, cutoff]]) : new Map(), onlyKeys: new Set([key]) }));
    }
    return out;
  } catch {
    return []; // best-effort - a suggestion is a courtesy, never a reason to fail "session end"
  }
}

// ---------- DB_VERSION drift check (dashboard-visible) ----------
//
// cli.mjs's own warnOnDbVersionDrift prints this to the CLI's stderr at
// `session start` only - invisible to whoever is actually watching the
// dashboard (the discrete "a human should be watching now" moment this
// tool auto-opens a browser tab for). Same comparison, exposed on GET
// /health instead so the dashboard can render it as a banner. Reads
// js/db.js relative to THIS file's own location (not process.cwd()) so it
// resolves correctly regardless of the directory the relay was started
// from. Cached on the same short TTL as Friction Analytics - every open
// dashboard tab polls /health every 3s, and a real dispatchCommand round
// trip to the connected agent on every one of those would be wasteful.
const DB_VERSION_DRIFT_CACHE_MS = 5000;
let dbVersionDriftCache = null; // { at, data }

function readSourceDbVersion() {
  try {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'js', 'db.js'), 'utf8');
    const match = src.match(/DB_VERSION\s*=\s*(\d+)/);
    return match ? Number(match[1]) : null;
  } catch {
    return null; // no js/db.js at that path - not every project using this tool has one
  }
}

async function computeDbVersionDrift() {
  const sourceVersion = readSourceDbVersion();
  if (sourceVersion === null) return { checked: false };
  const session = dbApi.getCurrentSession();
  if (!session || !agents.size) return { checked: false, sourceVersion };
  try {
    const live = await dispatchCommand('db.version', {}, DB_VERSION_DRIFT_TIMEOUT_MS, DEFAULT_AGENT);
    return { checked: true, sourceVersion, liveVersion: live.version, drift: live.version !== sourceVersion };
  } catch (err) {
    return { checked: false, sourceVersion, error: err.message };
  }
}

async function getDbVersionDrift() {
  const now = Date.now();
  if (dbVersionDriftCache && (now - dbVersionDriftCache.at) < DB_VERSION_DRIFT_CACHE_MS) return dbVersionDriftCache.data;
  const data = await computeDbVersionDrift();
  dbVersionDriftCache = { at: now, data };
  return data;
}

// ---------- Repo info (dashboard's About panel) ----------
//
// Best-effort, read-only, git-derived - never blocks or throws into a route
// handler (a fork of this tool run outside a git checkout, or a shallow
// clone missing a remote, is still a valid way to use it). Cached: each
// call is a handful of synchronous `git` subprocess spawns, and the About
// tab is opened rarely, but there's no reason to repeat that work on every
// dialog open within the same short window.
const REPO_INFO_CACHE_MS = 30000;
let repoInfoCache = null; // { at, data }
const REPO_ROOT = path.join(__dirname, '..', '..');

function gitOneLine(args) {
  try {
    return execSync(`git ${args}`, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null; // not a git checkout, git not on PATH, no remote configured, etc.
  }
}

function computeRepoInfo() {
  return {
    remoteUrl: gitOneLine('remote get-url origin'),
    branch: gitOneLine('branch --show-current'),
    commit: gitOneLine('rev-parse HEAD'),
    commitDate: gitOneLine('log -1 --format=%cI'),
  };
}

function getRepoInfo() {
  const now = Date.now();
  if (repoInfoCache && (now - repoInfoCache.at) < REPO_INFO_CACHE_MS) return repoInfoCache.data;
  const data = computeRepoInfo();
  repoInfoCache = { at: now, data };
  return data;
}

// The verify half of baseline -> action -> verify: re-snapshot `baseline`'s own stores, diff,
// check `expect` (crv-verify.mjs), persist the fresh snapshot and full diff like any other. Shared
// by POST /state/verify (an explicit baseline reference) and POST /crv/run (a baseline it just took
// itself, one call earlier in the same request).
async function verifyAgainstBaseline(session, agentName, { baseline, stores, expect, allowExtra, samples, verbose }) {
  let expectations;
  try { expectations = parseExpect(expect); } catch (err) { throw new HttpError(400, err.message); }
  const where = baseline.where && typeof baseline.where === 'object' ? baseline.where : undefined;
  const { result: fresh, actionId: freshActionId } = await withLoggedAction(session.id, 'idb.snapshot', { stores, where, for: 'idb.verify', baselineId: baseline.id }, () => dispatchCommand('idb.snapshot', { stores, where }, SNAPSHOT_TIMEOUT_MS, agentName), agentName);
  const freshSnap = dbApi.saveSnapshot({ sessionId: session.id, actionId: freshActionId, stores: fresh.stores, agentName, where });
  const baselineStores = Object.fromEntries(Object.entries(baseline.stores || {}).filter(([name]) => stores.includes(name)));
  const diff = computeDiff(baselineStores, fresh.stores);
  const summary = summarizeDiff(diff);
  const { result: report } = await withLoggedAction(session.id, 'idb.verify', { baselineId: baseline.id, afterId: freshSnap.id, expect: expect ?? null, allowExtra: !!allowExtra }, async () => {
    const savedDiff = dbApi.saveDiff({ sessionId: session.id, actionId: null, fromId: baseline.id, toId: freshSnap.id, summary, diff });
    return buildVerifyReport({
      baselineId: baseline.id, afterId: freshSnap.id, diffId: savedDiff.id, summary, diff, expectations,
      allowExtra: !!allowExtra, samples: Number.isFinite(Number(samples)) && Number(samples) > 0 ? Math.min(Number(samples), 50) : 3, verbose: !!verbose,
    });
  }, agentName);
  broadcastUpdate('action', session.id);
  broadcastUpdate('snapshot', session.id);
  broadcastUpdate('diff', session.id);
  return report;
}

const routes = [
  {
    // pending_command_count: how many dispatched commands are currently
    // in-flight (awaiting a reply from any agent) RIGHT NOW - global, not
    // per-agent/session (this tool has one operator at a time in practice).
    // Exists to answer a real, previously unanswerable question during a
    // string of back-to-back timeouts: is the relay genuinely stuck
    // processing a backlog of piled-up retries, or is each new command a
    // fresh, independent attempt against a slow-but-not-jammed page? A
    // caller retrying blind into a growing queue makes the real problem
    // worse; seeing this stay high across polls is the signal to stop
    // retrying and investigate instead.
    method: 'GET',
    pattern: /^\/health$/,
    handler: async () => {
      const detail = agentsDetail();
      // Real incident this round: two agent connections (same relay, different
      // agent names) reported two different origins, and nothing surfaced it
      // until a mutating command had already landed against the wrong one.
      // Informational only - never refuses anything by itself (see
      // dispatchTracked for the actual per-session guard).
      const distinctOrigins = [...new Set(detail.map((a) => a.origin).filter(Boolean))];
      return {
        status: 'ok', agents_connected: connectedAgentNames(), agents_detail: detail, stale_agents: staleAgentNames(), active_session: dbApi.getCurrentSession(), db_version_drift: await getDbVersionDrift(), pending_command_count: pending.size,
        ...(distinctOrigins.length > 1 ? { origin_conflict: `connected agents report ${distinctOrigins.length} different origins (${distinctOrigins.join(', ')}) - double-check which agent a command actually targets before mutating anything` } : {}),
        // stale_source_files non-empty = this process is running OLDER code than what is on disk - restart it (`relay restart`).
        relay: { pid: process.pid, started_at: RELAY_STARTED_AT.toISOString(), uptime_seconds: Math.round((Date.now() - RELAY_STARTED_AT.getTime()) / 1000), stale_source_files: getStaleSourceFiles(), events_24h: summarizeRelayEvents(readRelayEvents(PORT)) },
      };
    },
  },
  {
    // Powers the dashboard's Settings dialog (Server config + About tabs).
    // Everything except aiBackendUrl is read-only from the browser's point
    // of view: HOST/PORT are bound at process start (changing them here
    // wouldn't move the socket this very response is served on), and
    // WEBSCOUT_NO_AUTOOPEN only matters at the one auto-open moment that
    // already happened by the time any dashboard tab could ask about it.
    // aiBackendUrl is genuinely different - ai.mjs's askAI() re-reads
    // process.env.WEBSCOUT_AI_BACKEND_URL on every call, so mutating it here
    // takes effect on the very next "Ask AI" with no relay restart needed.
    method: 'GET',
    pattern: /^\/config$/,
    handler: async () => {
      const aiBackendUrl = process.env.WEBSCOUT_AI_BACKEND_URL || DEFAULT_BACKEND_URL;
      return {
        webscoutVersion: WEBSCOUT_VERSION,
        host: HOST,
        port: PORT,
        dbPath: process.env.WEBSCOUT_DB_PATH || path.join(__dirname, 'webscout.db'),
        nodeVersion: process.version,
        platform: process.platform,
        autoOpenEnabled: process.env.WEBSCOUT_NO_AUTOOPEN !== '1',
        aiBackendUrl,
        aiBackendUrlDefault: DEFAULT_BACKEND_URL,
        aiBackendUrlIsOverridden: aiBackendUrl !== DEFAULT_BACKEND_URL,
        repo: getRepoInfo(),
      };
    },
  },
  {
    method: 'PUT',
    pattern: /^\/config$/,
    handler: async (req) => {
      const body = await readJsonBody(req);
      if (!('aiBackendUrl' in body)) throw new HttpError(400, 'aiBackendUrl is required (a URL string, or null to reset to the built-in default)');
      if (body.aiBackendUrl === null) {
        delete process.env.WEBSCOUT_AI_BACKEND_URL;
      } else {
        if (typeof body.aiBackendUrl !== 'string') throw new HttpError(400, 'aiBackendUrl must be a string');
        try { new URL(body.aiBackendUrl); } catch { throw new HttpError(400, 'aiBackendUrl must be a valid URL'); }
        process.env.WEBSCOUT_AI_BACKEND_URL = body.aiBackendUrl;
      }
      log(`AI backend URL ${body.aiBackendUrl === null ? 'reset to default' : `set to ${body.aiBackendUrl}`} via dashboard settings`);
      const aiBackendUrl = process.env.WEBSCOUT_AI_BACKEND_URL || DEFAULT_BACKEND_URL;
      return { aiBackendUrl, aiBackendUrlDefault: DEFAULT_BACKEND_URL, aiBackendUrlIsOverridden: aiBackendUrl !== DEFAULT_BACKEND_URL };
    },
  },
  { method: 'GET', pattern: /^\/agents$/, handler: async () => ({ agents: connectedAgentNames(), detail: agentsDetail() }) },
  {
    // Fire-and-forget telemetry from the CLI's own "help" (see cli.mjs's noteHelpUsage): does
    // "help all" (~16k tokens) still get called, against the sliced forms (index/group/one
    // command) it exists to replace? No session required - help works before one is started.
    method: 'POST',
    pattern: /^\/help-used$/,
    handler: async (req) => {
      const body = await readJsonBody(req);
      if (body.kind !== 'all' && body.kind !== 'sliced') throw new HttpError(400, 'kind must be "all" or "sliced"');
      dbApi.bumpSavingsDaily(body.kind === 'all' ? 'helpAll' : 'helpSliced', 0);
      return { ok: true };
    },
  },
  {
    // Cheap, dedicated liveness probe - see inject.js's 'ping' handler and
    // PING_TIMEOUT_MS above. Deliberately does NOT require an active
    // session (requireActiveSession() is skipped here on purpose): the
    // exact moment this is most useful is mid-diagnosis, when a caller
    // isn't sure a session-gated command is even worth trying yet. Never
    // throws on a failed/timed-out probe - `alive:false` with the
    // underlying error is itself the answer, not a route failure.
    method: 'POST',
    pattern: /^\/ping$/,
    handler: async (req) => {
      const body = await readJsonBody(req);
      const agentName = body.agent || DEFAULT_AGENT;
      const start = Date.now();
      try {
        await dispatchCommand('ping', {}, PING_TIMEOUT_MS, agentName);
        return { alive: true, roundTripMs: Date.now() - start };
      } catch (err) {
        return { alive: false, roundTripMs: Date.now() - start, error: err.message };
      }
    },
  },
  { method: 'GET', pattern: /^\/dashboard$/, isHtml: true, handler: async () => fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8') },

  // /sessions/* routes live in routes-sessions.mjs.
  ...sessionsRoutes({ knownIssuesDue, LONG_POLL_TYPES, DEFAULT_MACRO_TYPES, MUTATING_TYPES, COMMAND_TYPES, dropAnalyticsCache: () => { analyticsCache = null; }, setMacroCandidateCache: (v) => { macroCandidateCache = v; }, BUDGET_STRICT_PCT, BUDGET_TIGHTEN_PCT, COMMAND_TIMEOUT_MS, DEFAULT_AGENT, HOST, HttpError, LEAN_GUARD_TOKENS, SNAPSHOT_TIMEOUT_MS, __dirname, agents, broadcastUpdate, buildBriefing, buildMacroCandidates, buildMacroRiskPreview, buildReportJson, buildReportMarkdown, buildSessionViz, bumpMutationCounter, computeAnalytics, computeDiff, dbApi, declareFrictionResolved, decorateEntriesWithKnownIssue, discoverTranscripts, dispatchCommand, dispatchTracked, dropSessionMemory, emergentFrictionForSession, exportTrace, friction, gatherReportBundle, http, importIntents, log, maybeAutoCalibrate, openDashboardInBrowser, path, pending, readJsonBody, readTranscriptFile, requireActiveSession, resolveSuggestionsForSession, sessionRunningTokens, sessionSavingsTally, summarizeByStore, withCamelAliases, withLoggedAction, writeTrace }),
  {
    // savings is cross-session/global by nature (a macro or a golden-diff
    // pair is reused across sessions, not scoped to one) - only surfaced on
    // the all-time report, not the per-session one above. Combines db.mjs's
    // real DB-backed ledgers (getTokenSavingsReport) with the relay's
    // read-result-cache counter (persisted since the read_cache_savings table).
    method: 'GET',
    pattern: /^\/token-report$/,
    handler: async () => {
      const dbSavings = dbApi.getTokenSavingsReport();
      const runtimeCache = {
        ...dbApi.getReadCacheSavings(),
        note: 'persisted across relay restarts (counts hits since the read_cache_savings table was added)',
      };
      const cost = dbApi.getActionCostReport();
      const scoped = dbApi.getScopedReadSavings();
      const strategy = dbApi.getReadStrategyStats();
      const shapedBytes = strategy.shaping.netBytesSaved;
      const shapedTokens = Math.round(shapedBytes / dbApi.CHARS_PER_TOKEN_ESTIMATE);
      // Storage-side context for the "storage" ledgers: how big the database
      // actually is on disk (main file + write-ahead log) and what it would
      // have been without dedup. Approximate by nature (SQLite does not
      // shrink its file when rows go away), so it is labeled as such.
      const dbPath = process.env.WEBSCOUT_DB_PATH || path.join(__dirname, 'webscout.db');
      let dbFileBytes = null;
      try {
        dbFileBytes = fs.statSync(dbPath).size;
        try { dbFileBytes += fs.statSync(`${dbPath}-wal`).size; } catch { /* no WAL file right now */ }
      } catch { /* db path unreadable - leave null */ }
      const storageSaved = dbSavings.byKind.storage.bytesSaved;
      dbApi.snapshotSavings('storage', storageSaved); // sampled so the trend can show day-to-day storage savings
      // Which dispatchable actions this relay has NEVER logged a call for, all-time - a real
      // usage count (not a guess) for the MCP tool list's own token cost: an action nobody has
      // ever called is a candidate to trim from the always-sent schema (schema-budget.test.mjs)
      // or move behind a secondary tool, once there is enough history to trust the answer.
      // ping/page.epoch are internal (liveness probe, cache-invalidation check), never a real
      // MCP action, so excluded rather than flagged as unused.
      const calledTypes = new Set(cost.byType.map((r) => r.type));
      const neverCalledTypes = Object.keys(COMMAND_TYPES).filter((t) => t !== 'ping' && t !== 'page.epoch' && !calledTypes.has(t)).sort();
      return {
        ...cost,
        byType: decorateTypesWithKnownIssue(cost.byType, dbApi.getActionFailureTextsByType()),
        byTarget: decorateTargetsWithKnownIssue(dbApi.getActionCostByTarget(), dbApi.getActionFailureTextsByTarget()),
        // One row per session, tags included (db.mjs's getSessionTokenTotals) - the caller (dashboard)
        // does the tag-matching client-side, same reasoning as that function's own comment. Lets
        // "tokens spent by the self-repair loop" (sessions tagged 'self-repair') answer from data
        // already collected here, instead of a second tracking system - see self-repair.mjs.
        bySession: dbApi.getSessionTokenTotals(),
        neverCalled: {
          types: neverCalledTypes,
          sampleSizeCalls: cost.totalCalls,
          note: cost.totalCalls < 50
            ? `only ${cost.totalCalls} call(s) logged all-time - too small a sample to trust "never" yet`
            : 'all-time across every session this relay has ever logged',
        },
        helpUsage: dbApi.getHelpUsage(),
        savings: {
          ...dbSavings,
          runtimeReadCache: runtimeCache,
          totalEstTokensSaved: dbSavings.totalEstTokensSaved + runtimeCache.estTokensSaved + scoped.estTokensSaved + shapedTokens,
          // The cache skips a page round trip and an action-log row, but the
          // result is still delivered to the caller - a roundtrip saving,
          // not a storage or delivery one.
          ledgers: [...dbSavings.ledgers, {
            key: 'runtimeReadCache', label: 'Read cache', kind: 'roundtrip', countedInTotal: true,
            what: 'An identical read repeated with nothing mutating in between is answered from memory instead of asking the page again. The caller still receives the full result.',
            bytesSaved: runtimeCache.bytesSaved, estTokensSaved: runtimeCache.estTokensSaved, uniqueBytes: null, logicalBytes: null, reductionPct: null,
            refs: { unique: null, total: runtimeCache.hits, unit: 'cache hits' },
            note: runtimeCache.note,
          }, {
            key: 'scopedReads', label: 'Scoped reads', kind: 'delivery', countedInTotal: true,
            what: 'A read narrowed with --where / --fields / --limit / --url-contains / --meta, or a whole-page selector answered with an outline, returns less than the unscoped call. Counted against the unscoped size the page measured (exact up to 2000 rows, sampled above).',
            bytesSaved: scoped.bytesSaved, estTokensSaved: scoped.estTokensSaved, uniqueBytes: null, logicalBytes: null, reductionPct: null,
            refs: { unique: null, total: scoped.calls, unit: 'scoped reads' },
            note: 'measured against an unscoped call the caller may never have made - an upper bound on what scoping saved them',
          }, {
            key: 'deliveryShaping', label: 'Shaped replies', kind: 'delivery', countedInTotal: true,
            what: 'Replies the caller asked to be smaller (--if-changed / --delta pointers, --peek, --table) or the session budget made smaller (guard, tabular rows). Counted against the full result this same call would have delivered, so unlike scoped reads it is not an upper bound; a peek that was then followed by the full read gets that spend taken back out.',
            bytesSaved: shapedBytes, estTokensSaved: shapedTokens, uniqueBytes: null, logicalBytes: null, reductionPct: null,
            refs: { unique: null, total: strategy.shaping.pointer.calls + strategy.shaping.delta.calls + strategy.shaping.peek.calls + strategy.shaping.table.calls, unit: 'shaped replies' },
            note: 'a pointer or delta is only offered when the caller says it still holds the earlier result - if its context was compacted since, it must repeat the call without the flag',
          }],
          byKind: {
            ...dbSavings.byKind,
            roundtrip: { bytesSaved: runtimeCache.bytesSaved, estTokensSaved: runtimeCache.estTokensSaved },
            delivery: { bytesSaved: scoped.bytesSaved + shapedBytes, estTokensSaved: scoped.estTokensSaved + shapedTokens },
          },
          readCache: { pageStaleMisses: readCachePageStaleMisses, note: 'hits the page-change probe turned into misses since this relay started' },
          readStrategy: strategy,
          estimator: estimatorInfo({ autoCalibrate: currentAutoCalibrateState() }),
          trend: dbApi.getSavingsTrend(14),
          storageContext: {
            dbFileBytes,
            bytesWithoutDedup: dbFileBytes === null ? null : dbFileBytes + storageSaved,
            reductionPct: dbFileBytes === null ? null : Math.round((storageSaved / (dbFileBytes + storageSaved)) * 1000) / 10,
            note: 'approximate - SQLite keeps freed pages in its file, so the real without-dedup size is not exactly file + saved',
          },
          // Spend is what the CALLER read; every ledger above is storage or
          // round-trip. They share a unit (chars/4) but not a meaning - the
          // dashboard shows them side by side, never as a ratio.
          spend: { calls: cost.totalCalls, estTokens: cost.totalEstTokens, estTokensBand: baselineBand(cost.totalEstTokens * dbApi.CHARS_PER_TOKEN_ESTIMATE, 'json') },
        },
      };
    },
  },

  // Macro routes (record/replay) live in routes-macros.mjs.
  ...macroRoutes({ allActionsIncremental, broadcastUpdate, bumpMutationCounter, buildMacroRiskPreview, buildMacroSelectorSuggestions, COMMAND_TIMEOUT_MS, dbApi, DEFAULT_AGENT, DEFAULT_MACRO_TYPES, dispatchCommand, frictionFactsFor, frictionTracker, getAnalytics, goalWordSet, HOST, HttpError, jaccardSimilarity, LONG_POLL_TYPES, lookupReadCache, MACRO_CONTEXT_SIMILARITY_THRESHOLD, matchKnownIssueForError, MUTATING_TYPES, noteCacheHit, noteScopedRead, readCacheKey, readJsonBody, requireActiveSession, SNAPSHOT_TIMEOUT_MS, storeReadCache, withLoggedAction }),

  {
    // Cross-session search over every session's own action log (type/params/
    // result/error, stringified) - answers "which session/action touched
    // store X" without opening sessions one by one by hand. Local dev tool,
    // small data volume expected - a linear scan over every session's
    // actions is deliberately simple rather than adding a FTS index.
    method: 'GET',
    pattern: /^\/search$/,
    handler: async (req) => {
      const { searchParams } = new URL(req.url, `http://${HOST}`);
      const q = (searchParams.get('q') || '').trim().toLowerCase();
      if (!q) throw new HttpError(400, 'q is required');
      const matches = [];
      for (const s of dbApi.listSessions()) {
        for (const a of dbApi.listActions(s.id)) {
          const haystack = [a.type, JSON.stringify(a.params), JSON.stringify(a.result), a.error].filter(Boolean).join(' ');
          const idx = haystack.toLowerCase().indexOf(q);
          if (idx === -1) continue;
          matches.push({
            sessionId: s.id, sessionGoal: s.goal, sessionStatus: s.status,
            actionId: a.id, type: a.type, ok: a.ok, startedAt: a.started_at,
            snippet: haystack.slice(Math.max(0, idx - 40), idx + q.length + 80),
          });
          if (matches.length >= 200) break;
        }
        if (matches.length >= 200) break;
      }
      return { query: q, count: matches.length, matches };
    },
  },

  // ---------- Verity UI Relay import ----------
  //
  // tools/ui-verifier's own `scenario` command prints its result JSON to
  // stdout and persists nothing - this bundles that result into a web-scout
  // session's own evidence trail (dashboard timeline, session report)
  // instead of leaving two tools' output to be reconciled by eye. Takes an
  // EXPLICIT sessionId, not requireActiveSession() - importing evidence
  // against an already-ended session (to finish its report) is a real,
  // expected use, matching /sessions/:id/report's own precedent.
  {
    method: 'POST',
    pattern: /^\/verity\/import$/,
    handler: async (req) => {
      const body = await readJsonBody(req);
      if (!body.sessionId) throw new HttpError(400, 'sessionId is required');
      if (!body.result || typeof body.result !== 'object') throw new HttpError(400, 'result (a Verity scenario-result JSON object) is required');
      dbApi.getSession(Number(body.sessionId)); // throws 'no such session' -> 404 below if invalid
      const run = dbApi.importVerityRun({ sessionId: Number(body.sessionId), label: body.label, result: body.result });
      broadcastUpdate('verity', Number(body.sessionId));
      return run;
    },
  },

  {
    method: 'POST',
    pattern: /^\/command$/,
    handler: async (req, _m, res) => {
      const body = await readJsonBody(req);
      const { type, params } = body;
      const agentName = body.agent || DEFAULT_AGENT;
      if (!type) throw new HttpError(400, 'type is required');
      if (type === 'idb.snapshot') throw new HttpError(400, "use POST /state/snapshot instead - idb.snapshot must be persisted, never dispatched raw");
      const session = requireActiveSession();
      const dispatchTimeoutMs = LONG_POLL_TYPES.has(type) ? (Number(params?.timeoutMs) || 15000) + 5000 : COMMAND_TIMEOUT_MS;
      maybeRiskySelectorWarn(session.id, type, params, res, agentName, body.ackRisk);
      maybeFrictionBroadcastNotice(session.id, agentName, res);

      const cacheKey = readCacheKey(agentName, type, params);
      const budget = cacheKey ? currentBudget(session) : null;
      // What the caller receives for a read (pointer/delta/peek/table/full) is
      // decided by read-pipeline.mjs; the FULL result is what gets logged and cached.
      const deliverRead = ({ full, hit, entry, actionId }) => {
        const shaped = readPipeline.shape({
          sessionId: session.id, type, agentName, params, cacheKey, full, hit, entry, actionId, opts: body.opts, budget, lean: session.lean,
          envGuardTokens: Number.isFinite(READ_GUARD_ENV_TOKENS) && READ_GUARD_ENV_TOKENS > 0 ? READ_GUARD_ENV_TOKENS : null,
        });
        if (hit) noteCacheHit(session.id, sizeOf(full), shaped.outBytes);
        else if (shaped.outBytes < shaped.fullBytes) dbApi.setActionDelivered(actionId, shaped.outBytes);
        if (shaped.mode !== 'full') { const t = tally(session.id); t.shapedCalls += 1; t.shapedBytes += shaped.spared; }
        const budgetNote = readPipeline.budgetNote(session.id, budget);
        if (budgetNote) res.setHeader('x-webscout-budget', budgetNote);
        if (shaped.hint) res.setHeader('x-webscout-hint', shaped.hint);
        return shaped.out;
      };
      if (cacheKey) {
        const cached = await lookupReadCache(session.id, cacheKey, agentName);
        if (cached) {
          maybeCacheAwarenessNudge(session.id, res);
          return deliverRead({ full: cached.result, hit: true, entry: cached, actionId: cached.actionId });
        }
      }

      let resultOut;
      let freshActionId;
      // idb.put/idb.putMany --dry-run write nothing (readonly transaction,
      // no .put() call in inject.js) - wrapping either in a before/after
      // auto-snapshot+diff pair would pay real snapshot cost to prove a
      // diff that can never be anything but empty.
      const isDryRunPut = (type === 'idb.put' || type === 'idb.putMany') && params?.dryRun === true;
      if (session.strict_crv && STRICT_CRV_TYPES.has(type) && !isDryRunPut) {
        // Scoped to session.strict_crv_stores when the session was started
        // with `--stores a,b,c` - unscoped (stores: undefined) still means
        // "whole db", same as before, so an old caller that never scoped
        // keeps its old (slow, but complete) behavior.
        const autoStores = session.strict_crv_stores || undefined;
        const before = await withLoggedAction(session.id, 'idb.snapshot', { auto: true, phase: 'before', for: type, stores: autoStores }, () => dispatchCommand('idb.snapshot', { stores: autoStores }, SNAPSHOT_TIMEOUT_MS, agentName), agentName);
        const beforeSnap = dbApi.saveSnapshot({ sessionId: session.id, actionId: before.actionId, stores: before.result.stores, agentName });

        const triggering = await dispatchTracked(session, type, params, agentName, dispatchTimeoutMs, !!body.autoRemediate);

        const after = await withLoggedAction(session.id, 'idb.snapshot', { auto: true, phase: 'after', for: type, triggered_by_action_id: triggering.actionId, stores: autoStores }, () => dispatchCommand('idb.snapshot', { stores: autoStores }, SNAPSHOT_TIMEOUT_MS, agentName), agentName);
        const afterSnap = dbApi.saveSnapshot({ sessionId: session.id, actionId: after.actionId, stores: after.result.stores, agentName });

        const diffOutcome = await withLoggedAction(session.id, 'idb.diff', { auto: true, triggered_by_action_id: triggering.actionId, idA: beforeSnap.id, idB: afterSnap.id }, async () => {
          const diff = computeDiff(before.result.stores, after.result.stores);
          return { diff, summary: summarizeDiff(diff) };
        }, agentName);
        const savedDiff = dbApi.saveDiff({ sessionId: session.id, actionId: diffOutcome.actionId, fromId: beforeSnap.id, toId: afterSnap.id, summary: diffOutcome.result.summary, diff: diffOutcome.result.diff });

        broadcastUpdate('action', session.id);
        broadcastUpdate('snapshot', session.id);
        broadcastUpdate('diff', session.id);
        maybeMidSessionNudge(session.id, res);
        maybeMacroMatchNudge(session.id, res);

        // `--crv-compact` (session.strict_crv_compact): counts alone often are not enough to tell
        // whether the right rows changed, and the only way to see more today is a second, full-body
        // round trip to GET /state/diffs/:id. A sampled preview (same shape "idb verify"'s pass
        // branch already returns) answers that in the SAME reply for the common case, without
        // changing anything for a session that never asked for it - diff_summary/diff_id are
        // unchanged either way, and the full diff is still saved and still fetchable by id.
        const compactSamples = session.strict_crv_compact
          ? Object.fromEntries(Object.entries(savedDiff.summary).map(([store]) => [store, sampleStoreDiff(diffOutcome.result.diff[store])]).filter(([, s]) => Object.keys(s).length))
          : undefined;

        resultOut = {
          data: triggering.result,
          crv: { before_snapshot_id: beforeSnap.id, after_snapshot_id: afterSnap.id, diff_id: savedDiff.id, diff_summary: savedDiff.summary, ...(compactSamples && Object.keys(compactSamples).length ? { samples: compactSamples } : {}) },
        };
      } else {
        let outcome;
        let ranParams = params;
        try {
          outcome = await dispatchTracked(session, type, params, agentName, dispatchTimeoutMs, !!body.autoRemediate);
        } catch (err) {
          const retry = body.tryRecovery === true || (body.tryRecovery !== false && session.auto_recover) ? recoveryRetryFor(session.id, type, params, agentName, err) : null;
          if (!retry) throw err;
          // If the alternative fails too, its own error (with its own friction context) is what the caller gets.
          outcome = await dispatchTracked(session, type, retry.params, agentName, dispatchTimeoutMs, !!body.autoRemediate);
          ranParams = retry.params;
          const noticeText = `"${params.selector}" (${type}) failed; ran "${retry.recovery.selector}" instead (it worked ${retry.recovery.worked} of ${retry.recovery.of} times after this failure)`.replace(/[^\x20-\x7e]/g, '?');
          res.setHeader('x-webscout-recovered', noticeText);
          notify(res, session.id, { kind: 'recovered', message: noticeText, next: [notices.whyCommand(friction.typeFamily(type), params.selector)] });
        }
        const { result, actionId } = outcome;
        noteScopedRead(session.id, result, { agentName, type, params: ranParams });
        broadcastUpdate('action', session.id);
        maybeMidSessionNudge(session.id, res);
        maybeMacroMatchNudge(session.id, res);
        resultOut = result;
        freshActionId = actionId;
      }

      if (MUTATING_TYPES.has(type)) bumpMutationCounter(session.id);
      if (cacheKey) {
        storeReadCache(session.id, cacheKey, resultOut, freshActionId);
        return deliverRead({ full: resultOut, hit: false, actionId: freshActionId });
      }
      return resultOut;
    },
  },

  // /state/* routes live in routes-state.mjs (snapshot, snapshots/:id, diff, diffs/:id, verify, restore).
  ...stateRoutes({ broadcastUpdate, COMMAND_TIMEOUT_MS, computeDiff, dbApi, DEFAULT_AGENT, dispatchCommand, HttpError, readJsonBody, requireActiveSession, SNAPSHOT_TIMEOUT_MS, summarizeDiff, verifyAgainstBaseline, withLoggedAction }),

  {
    // One call replacing the four hand-run before every CRV pass a real
    // session this round needed (status, db version-check, dom query, idb
    // list) to answer "is this even the right tab, in a state worth
    // testing": agent connectivity/origin/staleness, DB version drift,
    // whether the requested stores exist, whether a target selector is
    // present, and recent console errors on this page load. Read-only, never
    // requires an active session (the whole point is answering this BEFORE
    // deciding whether it's safe to start one) and never mutates anything.
    method: 'POST',
    pattern: /^\/crv\/preflight$/,
    handler: async (req) => {
      const body = await readJsonBody(req);
      const agentName = body.agent || DEFAULT_AGENT;
      const stores = Array.isArray(body.stores) ? body.stores : [];
      const selector = typeof body.selector === 'string' && body.selector.trim() ? body.selector.trim() : null;
      const plan = Array.isArray(body.plan) ? body.plan : null;

      const agentEntry = agents.get(agentName);
      const connected = !!(agentEntry?.socket && !agentEntry.socket.destroyed);
      // `agents` covers every connected agent, not only the requested one, and rides on every reply
      // shape below (including "not connected") - a tab-name collision is exactly the case where the
      // requested agent's own row alone can look fine.
      const report = { agent: agentName, connected, origin: agentEntry?.origin ?? null, agents: connectedAgentsSummary() };
      if (!connected) {
        return {
          ...report, ok: false,
          reason: `no web-scout agent named '${agentName}' connected - open the target page with the activation flag first${agentName !== DEFAULT_AGENT ? ` (?webscout_name=${agentName})` : ''}`,
        };
      }
      Object.assign(report, agentBuildStatus(agentEntry));
      report.dbVersionDrift = await getDbVersionDrift();
      if (report.agentStale) {
        return { ...report, ok: false, reason: 'this tab runs an older in-page agent than inject.js on disk - reload it ("page reload --hard") before relying on any live check below' };
      }

      try {
        const list = await dispatchCommand('idb.list', {}, BRIEFING_TIMEOUT_MS, agentName);
        const existingStores = new Set(list?.stores ?? Object.keys(list?.counts ?? {}));
        report.storesExist = Object.fromEntries(stores.map((s) => [s, existingStores.has(s)]));
        report.missingStores = stores.filter((s) => !existingStores.has(s));
      } catch (err) {
        report.storesExist = null;
        report.storesCheckError = err.message;
      }

      if (selector) {
        try {
          const query = await dispatchCommand('dom.query', { selector }, BRIEFING_TIMEOUT_MS, agentName);
          report.selectorPresent = !!query?.found;
          try {
            const facts = frictionFactsFor(dbApi.getCurrentSession()?.id ?? -1, 'dom.click', { selector }, agentName);
            const verdict = facts?.entry ? friction.evaluateSelectorRisk({ type: 'dom.click', selector, targetKind: 'selector', entry: facts.entry, live: facts.live, state: null, origin: facts.origin }) : null;
            const alt = verdict?.assessment ? reliableAlternative(facts.entry.recovery, selector) : null;
            if (alt) report.selectorSuggestion = { selector, alternative: alt.selector, evidence: alt.evidence, warning: verdict.assessment.message };
          } catch { /* advisory only */ }
        } catch (err) {
          report.selectorPresent = null;
          report.selectorCheckError = err.message;
        }
      }

      // Best-effort, honestly scoped: this is the tab's own in-page ring buffer
      // (inject.js's consoleLog), reset on every real navigation - it answers
      // "any console.error since this page last loaded", never further back,
      // and is never faked as an empty [] when the check itself failed.
      try {
        const consoleResult = await dispatchCommand('console.log', { level: 'error' }, BRIEFING_TIMEOUT_MS, agentName);
        report.bootErrors = consoleResult?.entries ?? [];
      } catch (err) {
        report.bootErrors = null;
        report.bootErrorsCheckError = err.message;
      }
      report.knownIssueMatches = matchKnownIssues(report.bootErrors, report);
      // Project-wide ranked friction digest (see computeAnalytics()'s topFrictionItems),
      // cached (getAnalytics(), 5s TTL - cheap to add here). Lets an agent front-load the
      // riskiest known-bad selectors/types/macros into the pass it's about to run instead
      // of discovering them one at a time as each one fails live.
      try {
        const analytics = getAnalytics();
        report.knownFriction = analytics.topFrictionItems;
        const briefing = friction.buildSessionBriefing(analytics.selectorFriction, { goal: dbApi.getCurrentSession()?.goal ?? '', origin: agents.get(agentName)?.origin ?? null });
        if (briefing.length) report.frictionBriefing = briefing;
        if (analytics.knownIssuesCheckError && !report.knownIssuesCheckError) report.knownIssuesCheckError = analytics.knownIssuesCheckError;
      } catch { /* best-effort - never blocks preflight */ }
      // The caller's own plan, checked step by step against the facts the pre-action warn will use.
      // Advisory: a risky step is something to reorder or guard, not a reason to call the page unfit.
      if (plan) report.planRisk = planFrictionReport(plan, agentName);
      // Host resources: warns (never fails the preflight) when the disk is low or browsers/profiles have leaked.
      try { report.host = hostHealth.preflightHostReport(); } catch { /* best-effort */ }

      report.ok = !(report.missingStores?.length) && (selector ? report.selectorPresent !== false : true) && !(report.bootErrors?.length);
      return report;
    },
  },
  {
    // The WHOLE baseline -> action -> verify loop in ONE call: snapshot `stores`, dispatch one
    // action (`type`/`params`, the same shape /command takes), re-snapshot, diff, check `expect` -
    // three round trips (and three full-body replies, if done by hand) become one, few-line reply.
    // Declining `type: idb.snapshot` (dispatch it via a real snapshot instead), a mutating action
    // is required (a read here would make baseline and after identical by construction, which is
    // not a bug - it just means "verify" is the wrong tool for a read; use "dom query" directly).
    // On the ACTION failing, the whole call fails (like /command does) - no baseline was consumed
    // by a verify that then couldn't mean anything, and the caller's own error handling (retry,
    // postTimeoutVerification, ...) applies exactly as it already does to a bare action.
    method: 'POST',
    pattern: /^\/crv\/run$/,
    handler: async (req, _m, res) => {
      const body = await readJsonBody(req);
      const agentName = body.agent || DEFAULT_AGENT;
      const session = requireActiveSession();
      const stores = Array.isArray(body.stores) && body.stores.length ? body.stores : undefined;
      if (!stores) throw new HttpError(400, 'stores (array) is required - "crv run" scopes its own before/after snapshots, same as "idb snapshot --stores a,b"');
      const type = body.type;
      if (!type) throw new HttpError(400, 'type is required (the action to run between the two snapshots, e.g. "dom.click")');
      if (type === 'idb.snapshot') throw new HttpError(400, 'use "idb snapshot" for the baseline - "crv run" takes its own');
      const params = body.params ?? {};
      maybeRiskySelectorWarn(session.id, type, params, res, agentName, body.ackRisk); // before the baseline is taken: a refusal must not leave a snapshot behind
      const before = await withLoggedAction(session.id, 'idb.snapshot', { stores, for: 'crv.run', phase: 'before' }, () => dispatchCommand('idb.snapshot', { stores }, SNAPSHOT_TIMEOUT_MS, agentName), agentName);
      const savedBaseline = dbApi.saveSnapshot({ sessionId: session.id, actionId: before.actionId, stores: before.result.stores, agentName });
      // saveSnapshot's own return value is a SUMMARY (id/counts/byteSize, no store content - see
      // /state/snapshot's own reply) - verifyAgainstBaseline needs the full row content, the same
      // read-back /state/verify does for an explicit baseline id.
      const baseline = dbApi.getSnapshot(savedBaseline.id);
      broadcastUpdate('snapshot', session.id);
      const dispatchTimeoutMs = LONG_POLL_TYPES.has(type) ? (Number(params?.timeoutMs) || 15000) + 5000 : COMMAND_TIMEOUT_MS;
      // The pre-dispatch risky-selector warning for this action was issued before the baseline snapshot (above).
      const { result: actionResult, actionId } = await dispatchTracked(session, type, params, agentName, dispatchTimeoutMs);
      broadcastUpdate('action', session.id);
      if (MUTATING_TYPES.has(type)) bumpMutationCounter(session.id);
      maybeMacroMatchNudge(session.id, res);
      const report = await verifyAgainstBaseline(session, agentName, { baseline, stores, expect: body.expect, allowExtra: body.allowExtra, samples: body.samples, verbose: body.verbose });
      return { action: { type, ok: true, actionId, result: actionResult }, ...report };
    },
  },

  // ---------------- self-repair loop (see webscout2.md, self-repair.mjs, docs/self-repair-loop.md) ----------------
  //
  // C = a coding agent that reads B's (causal) evidence AND holds write access to the code A (live
  // control) exercises, then re-runs to confirm its own patch. Scoped to the example app under
  // self-repair.mjs's configured scopeDir ONLY (never a real page) and disabled by default
  // (fail-closed) - see self-repair.mjs's own comments for the enforcement, not just this doc note.
  {
    method: 'GET',
    pattern: /^\/repair\/config$/,
    handler: async () => ({ ...repairApi.getConfig(), history: repairApi.getConfigHistory(10) }),
  },
  {
    // The kill-switch: a server-checked flag, not a display preference (a dashboard toggle that
    // only hid a panel would be decorative - anyone driving the CLI/MCP directly would ignore it).
    method: 'PUT',
    pattern: /^\/repair\/config$/,
    handler: async (req) => {
      const body = await readJsonBody(req);
      if (typeof body.enabled !== 'boolean') throw new HttpError(400, 'enabled (boolean) is required');
      const config = repairApi.setEnabled(body.enabled, { by: body.by });
      log(`self-repair loop ${body.enabled ? 'ENABLED' : 'disabled'} via ${body.by || 'unknown caller'}`);
      broadcastUpdate('repair-config', null);
      return config;
    },
  },
  {
    // A literal find/replace against ONE file inside the configured scope dir - see self-repair.mjs
    // for the fail-closed enforcement (disabled, out-of-scope path, ambiguous/missing match all
    // refuse here, before any write happens). Logged as a normal 'fs.patch' action via
    // withLoggedAction, same evidence-trail convention as every dispatched command - fixesActionId
    // (optional) becomes a RECORDED causal edge (session-viz.mjs's buildRecordedRepairEdges), not a
    // guessed one.
    method: 'POST',
    pattern: /^\/repair\/patch$/,
    handler: async (req) => {
      const body = await readJsonBody(req);
      const session = requireActiveSession();
      const { file, find, replace, fixesActionId } = body;
      let logged;
      try {
        logged = await withLoggedAction(
          session.id, 'fs.patch',
          { file, find, replace, fixesActionId: fixesActionId !== undefined && fixesActionId !== null ? Number(fixesActionId) : null },
          async () => repairApi.applyPatch({ file, find, replace }),
          'repair',
        );
      } catch (err) {
        throw new HttpError(400, err.message);
      }
      broadcastUpdate('action', session.id);
      return { actionId: logged.actionId, ...logged.result };
    },
  },
  {
    // The confirm-fix step: same snapshot -> dispatch -> verify shape as POST /crv/run above
    // (deliberately not refactored to share code with it - lower regression risk on a route this
    // repo's own tests already cover heavily than a shared-helper extraction), replayed against the
    // now-patched app. patchActionId (optional) becomes a RECORDED 'confirmed_by' edge. A FAILING
    // confirm is a normal result ({pass:false, ...}), not a thrown error - "still failing" is a real
    // finding the self-repair loop's own caller needs to see, exactly like /state/verify's own
    // pass/fail shape.
    method: 'POST',
    pattern: /^\/repair\/verify$/,
    handler: async (req) => {
      if (!repairApi.isEnabled()) throw new HttpError(403, 'self-repair loop is disabled - enable it first ("repair enable" / the dashboard kill-switch)');
      const body = await readJsonBody(req);
      const agentName = body.agent || DEFAULT_AGENT;
      const session = requireActiveSession();
      const stores = Array.isArray(body.stores) && body.stores.length ? body.stores : undefined;
      if (!stores) throw new HttpError(400, 'stores (array) is required, same as "crv run"');
      const type = body.type;
      if (!type) throw new HttpError(400, 'type is required (the same action that originally failed, replayed now against the patched code)');
      if (type === 'idb.snapshot') throw new HttpError(400, 'use "idb snapshot" for the baseline - "repair verify" takes its own');
      const params = body.params ?? {};
      const before = await withLoggedAction(session.id, 'idb.snapshot', { stores, for: 'repair.verify', phase: 'before' }, () => dispatchCommand('idb.snapshot', { stores }, SNAPSHOT_TIMEOUT_MS, agentName), agentName);
      const savedBaseline = dbApi.saveSnapshot({ sessionId: session.id, actionId: before.actionId, stores: before.result.stores, agentName });
      const baseline = dbApi.getSnapshot(savedBaseline.id);
      broadcastUpdate('snapshot', session.id);
      const { result: actionResult, actionId: replayedActionId } = await dispatchTracked(session, type, params, agentName, COMMAND_TIMEOUT_MS);
      broadcastUpdate('action', session.id);
      if (MUTATING_TYPES.has(type)) bumpMutationCounter(session.id);
      // verifyAgainstBaseline's own report shape (buildVerifyReport, crv-verify.mjs) carries the
      // pass/fail flag as `passed`, not `ok` - matched exactly here rather than renamed, so a
      // caller comparing this against /state/verify's or /crv/run's own reply sees the same field.
      const report = await verifyAgainstBaseline(session, agentName, { baseline, stores, expect: body.expect, allowExtra: body.allowExtra, samples: body.samples, verbose: body.verbose });
      const patchActionId = body.patchActionId !== undefined && body.patchActionId !== null ? Number(body.patchActionId) : null;
      const { actionId: verifyActionId } = await withLoggedAction(
        session.id, 'repair.verify',
        { patchActionId, replayedActionId, type, params },
        async () => ({ pass: report.passed }),
        'repair',
      );
      broadcastUpdate('action', session.id);
      return { pass: report.passed, verifyActionId, replayedActionId, action: { type, actionId: replayedActionId, result: actionResult }, ...report };
    },
  },
  {
    // Two sessions' causality trees diffed (session-viz.mjs's diffCausality) - the self-repair
    // loop's own evidence that a patch actually removed the failing chain, not just "the session
    // ended without an error". Read-only, no new storage.
    method: 'GET',
    pattern: /^\/repair\/causal-diff$/,
    handler: async (req) => {
      const { searchParams } = new URL(req.url, `http://${HOST}`);
      const a = searchParams.get('a');
      const b = searchParams.get('b');
      if (!a || !b) throw new HttpError(400, 'query params a and b (session ids) are required');
      const actionsA = dbApi.listActions(Number(a), { ascending: true });
      const actionsB = dbApi.listActions(Number(b), { ascending: true });
      return diffCausality(actionsA, actionsB);
    },
  },
  {
    // Cross-session feed of the loop's own dispatched actions (fs.patch + repair.verify), newest
    // first - powers the dashboard's patch ledger and pass/fail funnel without either one scanning
    // every session's action log client-side. Reuses dbApi.listAllActions() (already the source for
    // computeAnalytics' cross-session digests, same discipline: best-effort, a malformed row is
    // skipped not fatal) rather than adding a dedicated table - fs.patch/repair.verify are logged
    // exactly like any other action, this just filters and sorts what's already stored. Capped at
    // 300 - a ledger this deep is already well past "read it all", not a pagination gap.
    method: 'GET',
    pattern: /^\/repair\/activity$/,
    handler: async () => {
      const { actions } = dbApi.listAllActions();
      const goalBySession = new Map(dbApi.listSessions().map((s) => [s.id, s.goal]));
      const rows = actions
        .filter((a) => a.type === 'fs.patch' || a.type === 'repair.verify')
        .sort((x, y) => y.id - x.id)
        .slice(0, 300)
        .map((a) => ({
          id: a.id, sessionId: a.session_id, goal: goalBySession.get(a.session_id) ?? null,
          type: a.type, ok: a.ok, startedAt: a.started_at, error: a.error,
          file: a.params?.file ?? null, find: a.params?.find ?? null, replace: a.params?.replace ?? null,
          fixesActionId: a.params?.fixesActionId ?? null, patchActionId: a.params?.patchActionId ?? null,
          pass: a.type === 'repair.verify' ? (a.result?.pass ?? null) : null,
        }));
      const patches = rows.filter((r) => r.type === 'fs.patch');
      const verifies = rows.filter((r) => r.type === 'repair.verify');
      return {
        rows,
        funnel: {
          patchesAttempted: patches.length, patchesApplied: patches.filter((r) => r.ok).length,
          verifiesRun: verifies.length, verifiesPassed: verifies.filter((r) => r.pass === true).length,
        },
      };
    },
  },


  // See computeAnalytics()/getAnalytics() above for what this returns and
  // why it's cached.
  { method: 'GET', pattern: /^\/analytics$/, handler: async () => getAnalytics() },

  // Friction routes live in routes-friction.mjs (mark fixed, explain, targets, notices, regressions, prune, known-issues).
  ...frictionRoutes({
    allActionsIncremental, allFrictionTargets, broadcastUpdate, COMMAND_TYPES, commitsBetween, compileSignature, computeAnalytics, dbApi, declareFrictionResolved, DEFAULT_AGENT, ensureFrictionSession, frictionFactsFor, frictionTargetFromBody, frictionTracker, getAnalytics, HOST, HttpError, KNOWN_ISSUES_PATH, loadKnownIssues, PORT, readJsonBody, readKnownIssuesRaw, readSharedKnownIssues, resolveFrictionCluster,
    dropAnalyticsCache: () => { analyticsCache = null; },
    dropActionsMemo: () => { actionsMemo = null; },
  }),

  // ---- Host health (dashboard panels): scratch dirs/MB, owners, orphan browsers, free disk, trend, per-session
  // cost, footprint log, last test run. Cleanup/kill actions re-derive what is safe to touch server-side
  // (scratch.mjs rules: our prefixes only, stale owner only, browsers naming one of our profile dirs).
  { method: 'GET', pattern: /^\/host\/health$/, handler: async (req) => hostHealth.getHostHealth({ force: new URL(req.url, `http://${HOST}`).searchParams.get('fresh') === '1' }) },
  { method: 'GET', pattern: /^\/host\/trend$/, handler: async (req) => hostHealth.readTrend({ days: Math.min(90, Math.max(1, Number(new URL(req.url, `http://${HOST}`).searchParams.get('days')) || 14)) }) },
  { method: 'GET', pattern: /^\/host\/sessions$/, handler: async () => hostHealth.sessionScratchCost(dbApi.listSessions()) },
  { method: 'GET', pattern: /^\/host\/footprint$/, handler: async () => hostHealth.readFootprint() },
  { method: 'GET', pattern: /^\/host\/test-run$/, handler: async () => hostHealth.readLastTestRun() },
  {
    method: 'POST',
    pattern: /^\/host\/cleanup$/,
    handler: async (req) => {
      const body = await readJsonBody(req);
      // Dry-run unless the caller explicitly sends dryRun:false; a big real delete also needs confirm:true.
      const r = hostHealth.cleanupScratch({ dryRun: body.dryRun !== false, confirm: body.confirm === true, dirs: body.dirs });
      broadcastUpdate('host', null);
      return r;
    },
  },
  {
    method: 'POST',
    pattern: /^\/host\/kill-orphans$/,
    handler: async (req) => {
      const body = await readJsonBody(req);
      const r = await hostHealth.killOrphans({ pids: body.pids });
      broadcastUpdate('host', null);
      return r;
    },
  },

  {
    method: 'POST',
    pattern: /^\/ask$/,
    handler: async (req) => {
      const body = await readJsonBody(req);
      return handleAsk(body.sessionId ? Number(body.sessionId) : body.session_id ? Number(body.session_id) : null, body.question);
    },
  },
];

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://${HOST}`);

  // SSE is handled outside the generic JSON router - the response stays
  // open indefinitely instead of ending after one write.
  if (req.method === 'GET' && pathname === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders?.();
    res.write('retry: 2000\n\n');
    sseClients.add(res);
    res.on('close', () => sseClients.delete(res));
    return;
  }

  const route = routes.find((r) => r.method === req.method && r.pattern.test(pathname));
  if (!route) {
    sendJson(res, 404, { ok: false, error: 'not found' });
    return;
  }
  try {
    const match = pathname.match(route.pattern);
    const result = await route.handler(req, match, res);
    if (route.isHtml) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(result);
      return;
    }
    // Running session token total, delivered via response HEADER (same
    // established convention as x-webscout-nudge above - never folded into
    // the JSON body, so it can't change the shape of any command's own real
    // result). Lets an operator see cumulative cost build up call-by-call
    // instead of only discovering it after the fact via "token-report" -
    // confirmed real gap: a 278K-token idb.snapshot surfaced only in a
    // post-hoc audit, well after the session that paid for it was over.
    // Best-effort - never blocks or fails a reply over this.
    try {
      const staleFiles = getStaleSourceFiles();
      if (staleFiles.length) res.setHeader('x-webscout-relay-stale', staleFiles.join(','));
      const staleAgents = staleAgentNames();
      if (staleAgents.length) res.setHeader('x-webscout-agent-stale', staleAgents.join(','));
      const activeSession = dbApi.getCurrentSession();
      if (activeSession) {
        // + cache-hit bytes: see sessionCacheHitBytes above - a cache hit
        // never writes an actions row, so the DB-side sum alone would
        // silently undercount the bytes this reply (and every earlier
        // cache-hit reply this session) actually put in front of the agent.
        const totalTokens = sessionRunningTokens(activeSession.id);
        res.setHeader('x-webscout-session-tokens', String(totalTokens));
        // What THIS call added to the running total. Known only once a first
        // total was seen for the session by this process (a relay restarted
        // mid-session has no baseline, so it sends nothing rather than
        // reporting the whole prior total as one call's cost).
        const prevTotal = lastReportedSessionTokens.get(activeSession.id);
        if (prevTotal !== undefined) {
          const callTokens = Math.max(0, totalTokens - prevTotal);
          res.setHeader('x-webscout-call-tokens', String(callTokens));
          // A running total after every call is noise: only a call that added a lot, or a total
          // that crossed its next doubling (5k, 10k, 20k, ...), is worth the caller's tokens.
          if (callTokens < NOTABLE_CALL_TOKENS && tokenMilestone(totalTokens) === tokenMilestone(prevTotal)) res.setHeader('x-webscout-tokens-quiet', '1');
        }
        lastReportedSessionTokens.set(activeSession.id, totalTokens);
      }
    } catch { /* best-effort only */ }
    sendJson(res, 200, { ok: true, result });
  } catch (err) {
    // db.mjs's lookup functions (getSession/getSnapshot/getDiff) throw a
    // plain Error with this exact "no such <thing>: <id>" prefix on a
    // missing row - translated to 404 here rather than teaching the
    // persistence layer about HTTP status codes.
    const status = err instanceof HttpError ? err.status : (err.message?.startsWith('no such ') ? 404 : 500);
    let notice = null;
    try { notice = notices.errorNotice({ status, message: err.message }); } catch { /* best-effort */ }
    sendJson(res, status, { ok: false, error: err.message, extra: err.extra, ...(notice ? { notice } : {}) });
  }
});

server.on('upgrade', (req, socket) => {
  const { pathname, searchParams } = new URL(req.url, `http://${HOST}`);
  if (pathname !== '/agent') {
    socket.destroy();
    return;
  }
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }
  const agentName = searchParams.get('name') || DEFAULT_AGENT;
  const loadId = searchParams.get('loadId') || null;
  const build = searchParams.get('build') || null;
  const origin = searchParams.get('origin') || null;
  const pagePath = (searchParams.get('path') || '').slice(0, 300) || null;
  const accept = crypto.createHash('sha1').update(key + WS_MAGIC).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n'
    + 'Upgrade: websocket\r\n'
    + 'Connection: Upgrade\r\n'
    + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );

  // A new connection under the SAME name replaces the prior one - unchanged
  // behavior for the default single-tab case. Different names coexist.
  const existing = agents.get(agentName);
  const replacingLive = !!(existing && !existing.socket.destroyed);
  if (replacingLive) {
    log(`replacing previously connected agent '${agentName}'`);
    existing.socket.destroy();
  }
  // Collision bookkeeping, surfaced by "crv preflight": two real tabs connecting under one name take
  // the connection from each other, and from the caller's side that looks like the agent's origin
  // flip-flopping between calls. The counters carry over from the entry being replaced so a
  // back-and-forth fight accumulates instead of resetting to 1 each time.
  agents.set(agentName, {
    socket, buffer: Buffer.alloc(0), connectedAt: Date.now(), lastAckAt: null, loadId, build, origin, path: pagePath,
    replacedCount: (existing?.replacedCount ?? 0) + (replacingLive ? 1 : 0),
    lastReplacedAt: replacingLive ? Date.now() : (existing?.lastReplacedAt ?? null),
  });
  log(`agent '${agentName}' connected from`, req.socket.remoteAddress);
  broadcastUpdate('agent', null);

  socket.on('data', (chunk) => {
    const entry = agents.get(agentName);
    if (!entry || entry.socket !== socket) return; // this socket was already replaced
    entry.buffer = Buffer.concat([entry.buffer, chunk]);
    for (;;) {
      const frame = decodeFrame(entry.buffer);
      if (!frame) break;
      entry.buffer = entry.buffer.subarray(frame.bytesConsumed);
      if (frame.error) {
        log('protocol error from agent:', frame.error);
        socket.destroy();
        break;
      }
      if (frame.opcode === 0x8) { // close
        socket.end(encodeCloseFrame());
        break;
      }
      if (frame.opcode === 0x1) { // text
        handleAgentMessage(frame.text, agentName);
      }
    }
  });
  socket.on('close', () => {
    const entry = agents.get(agentName);
    if (entry && entry.socket === socket) {
      agents.delete(agentName);
      log(`agent '${agentName}' disconnected`);
      broadcastUpdate('agent', null);
    }
  });
  socket.on('error', () => {
    const entry = agents.get(agentName);
    if (entry && entry.socket === socket) agents.delete(agentName);
  });
});

if (isMainModule) {
  server.listen(PORT, HOST, () => {
    // A pidfile left behind by a dead process means the previous relay never ran its
    // clean shutdown - it was killed (`relay stop` removes the pidfile itself).
    const previous = readPidfile(PORT);
    if (previous && previous.pid !== process.pid && !pidAlive(previous.pid)) recordRelayEvent(PORT, { kind: 'unclean-exit', pid: previous.pid, startedAt: previous.startedAt ?? null });
    writePidfile(PORT);
    // Tracked in the same leaked-relay registry the test harness uses, so a relay started outside
    // any test run (a hand-run `node relay.mjs`, or one autostarted by the CLI) is also found and
    // cleaned up if it is ever orphaned - see relay-control.mjs's own comment.
    registerRelay({ pid: process.pid, port: PORT, dir: null, startedAt: new Date().toISOString() });
    reapLeakedRelays();
    for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { removePidfile(PORT); unregisterRelay(process.pid, null); process.exit(0); });
    process.on('exit', () => { removePidfile(PORT); unregisterRelay(process.pid, null); });
    // sample the storage-dedup total once a day-ish even if nobody asks for a report
    // host-resource trend sample (dirs / MB / orphans), at most one per 10 min across processes
    if (process.env.WEBSCOUT_NO_HOST_SCAN !== '1') { hostHealth.getHostHealth().catch(() => {}); setInterval(() => hostHealth.getHostHealth({ force: true }).catch(() => {}), 10 * 60 * 1000).unref(); }
    setInterval(() => { try { dbApi.snapshotSavings('storage', dbApi.getTokenSavingsReport().byKind.storage.bytesSaved); } catch { /* best effort */ } }, 6 * 3600 * 1000).unref();
    log(`listening on http://${HOST}:${PORT} (bound to localhost only)`);
    log('waiting for the in-page agent to connect at /agent ...');
    const current = dbApi.getCurrentSession();
    log(current ? `active session: #${current.id} "${current.goal}"` : 'no active session - start one before dispatching any command');
  });
}
