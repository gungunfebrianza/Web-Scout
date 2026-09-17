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
import { fileURLToPath } from 'node:url';
import { exec, execSync } from 'node:child_process';
import * as dbApi from './db.mjs';
import { buildPrompt, askAI, DEFAULT_BACKEND_URL } from './ai.mjs';
import { buildReportMarkdown, buildReportJson } from './report.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOST = '127.0.0.1';
const PORT = Number(process.env.WEBSCOUT_PORT || 8973);
// Bumped alongside docs/web-scout-roadmap.md's latest "## VN" entry - purely
// informational (the dashboard's About panel), never read by any behavior.
const WEBSCOUT_VERSION = '0.15.0';
const COMMAND_TIMEOUT_MS = 15000; // interactive dom/net/eval round trips
const SNAPSHOT_TIMEOUT_MS = 60000; // bulk idb.snapshot reads can be large
const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const DEFAULT_AGENT = 'default';
// Strict-CRV mode auto-snapshots before/after any command in this set -
// deliberately includes idb.put/idb.delete/idb.clear/idb.deleteMany (the
// tool's real write paths besides eval), since excluding them would leave
// strict-CRV not covering the exact thing it exists to audit.
const STRICT_CRV_TYPES = new Set(['dom.click', 'dom.fill', 'eval', 'idb.put', 'idb.delete', 'idb.clear', 'idb.deleteMany']);
// dom.wait/idb.wait poll, dom.pick blocks on a real human click, and eval
// now races its own page-side timeout (see inject.js's eval handler,
// EVAL_TIMEOUT_MS) so an async hang gets a diagnostic reply instead of
// silently masking as the relay's own generic timeout - all for up to
// their own `timeoutMs` - the relay's own round-trip timeout must exceed
// that or it fires first and masks the more informative in-page message.
const LONG_POLL_TYPES = new Set(['dom.wait', 'dom.settle', 'idb.wait', 'net.wait', 'dom.pick', 'eval']);
// Default replayable action types for macro record - excludes read-only
// query/dump/list/snapshot/net/console commands, which are noise in a
// replay (nothing to "redo"). Pass {"all": true} to POST /macros to
// include everything the session logged instead.
const DEFAULT_MACRO_TYPES = new Set(['dom.click', 'dom.fill', 'dom.wait', 'dom.settle', 'idb.wait', 'net.wait', 'idb.put', 'idb.delete', 'idb.deleteMany', 'idb.clear', 'page.reload', 'eval']);
// A failure on one of these carries a selector worth screenshotting - the
// broken state is often gone by the time a human goes looking for it by
// hand (confirmed: this was previously a manual, opt-in-after-the-fact
// step). Best-effort: capture failure never masks or replaces the original
// error, it is logged as its own separate action row.
const AUTO_SCREENSHOT_ON_FAILURE_TYPES = new Set(['dom.click', 'dom.fill', 'dom.wait']);
// macro run's cross-context guard threshold (see the route below) - a
// crude, deliberately cheap Jaccard-similarity-of-goal-words check, not
// real NLP. Low enough that two genuinely related goals ("verify P3.8
// candidate promotion" / "re-check P3.8 promotion after a fix") still pass
// without friction; low similarity is the actual signal worth blocking on
// (e.g. a macro recorded for "delete synthetic test rows" about to run
// against "verify production-mirroring dev session").
const MACRO_CONTEXT_SIMILARITY_THRESHOLD = 0.15;

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
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const agents = new Map(); // name -> { socket, buffer }
const pending = new Map(); // command id -> { resolve, reject, timer, agentName }
let nextCommandId = 1;
const sseClients = new Set(); // open dashboard EventSource responses

function log(...args) {
  console.log('[web-scout relay]', ...args);
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

function dispatchCommand(type, params, timeoutMs = COMMAND_TIMEOUT_MS, agentName = DEFAULT_AGENT) {
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
    if (msg.ok) entry.resolve(msg.result);
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

// ---------- Action logging wrapper (requirement 1: every action recorded) ----------

async function withLoggedAction(sessionId, type, params, fn, agentName = DEFAULT_AGENT) {
  const startedAt = new Date().toISOString();
  // Pushed BEFORE the round trip resolves so the dashboard can render an
  // in-flight row immediately - dom.wait/idb.wait/dom.pick can take up to
  // their own 10-15s timeout, and a dead-looking dashboard during that wait
  // was confirmed friction in a real verification pass. The dashboard clears
  // this the moment the matching 'action' event (full refresh) arrives.
  broadcastUpdate('action_start', sessionId, { type, agentName, startedAt });
  try {
    const result = await fn();
    const endedAt = new Date().toISOString();
    const actionId = dbApi.logAction({ sessionId, type, params, result, ok: true, error: null, startedAt, endedAt, agentName });
    return { result, actionId };
  } catch (err) {
    const endedAt = new Date().toISOString();
    dbApi.logAction({ sessionId, type, params, result: null, ok: false, error: err.message, startedAt, endedAt, agentName });
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
async function dispatchTracked(session, type, params, agentName, dispatchTimeoutMs) {
  try {
    return await withLoggedAction(session.id, type, params ?? {}, () => dispatchCommand(type, params ?? {}, dispatchTimeoutMs, agentName), agentName);
  } catch (err) {
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

function requireActiveSession() {
  const session = dbApi.getCurrentSession();
  if (!session) {
    throw new HttpError(409, 'no active session - context and goal must be defined before any action. Start one: POST /sessions {goal, context}, or `node tools/web-scout/cli.mjs session start "<goal>"`.');
  }
  return session;
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

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
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

async function gatherReportBundle(sessionId) {
  const session = dbApi.getSession(sessionId);
  return {
    session,
    actions: dbApi.listActions(sessionId),
    snapshots: dbApi.listSnapshots(sessionId),
    diffs: dbApi.listDiffs(sessionId).map((d) => dbApi.getDiff(d.id)),
    qa: dbApi.listQA(sessionId),
    console: dbApi.listConsoleEntries(sessionId),
    net: dbApi.listNetEntries(sessionId),
    verityRuns: dbApi.listVerityRuns(sessionId).map((r) => dbApi.getVerityRun(r.id)),
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
function computeAnalytics() {
  const sessions = dbApi.listSessions();
  const { actions, skipped: malformedActionsSkipped } = dbApi.listAllActions();
  const macros = dbApi.listMacros();
  const verityRuns = dbApi.listAllVerityRuns();

  // 1. Failure rate by action type - only types with >=1 failure matter
  // here (a 100%-ok type is not friction), sorted by raw failure count.
  const byType = new Map();
  for (const a of actions) {
    const t = byType.get(a.type) ?? { type: a.type, total: 0, failed: 0 };
    t.total += 1;
    if (!a.ok) t.failed += 1;
    byType.set(a.type, t);
  }
  const failureRateByType = [...byType.values()]
    .filter((t) => t.failed > 0)
    .map((t) => ({ ...t, failureRate: t.failed / t.total }))
    .sort((a, b) => b.failed - a.failed);

  // 2. Selectors that failed more than once - a single one-off miss is
  // normal; a selector failing repeatedly across sessions is the exact
  // "same wall hit again" pattern this exists to surface.
  const bySelector = new Map();
  for (const a of actions) {
    if (a.ok) continue;
    const sel = a.params?.selector;
    if (!sel || typeof sel !== 'string') continue;
    const key = `${a.type}::${sel}`;
    const s = bySelector.get(key) ?? { type: a.type, selector: sel, failCount: 0, sessionIds: new Set() };
    s.failCount += 1;
    s.sessionIds.add(a.session_id);
    bySelector.set(key, s);
  }
  const topFailedSelectors = [...bySelector.values()]
    .filter((s) => s.failCount > 1)
    .map((s) => ({ type: s.type, selector: s.selector, failCount: s.failCount, sessionCount: s.sessionIds.size }))
    .sort((a, b) => b.failCount - a.failCount);

  // 3. Macros recorded but never actually replayed, and macros that HAVE
  // been replayed but never once succeeded on any step (recorded,
  // presumably worked once to be recordable, but rot the moment the page
  // changes underneath it - a real, otherwise invisible failure mode for a
  // "record once, replay forever" feature).
  const macroRunStats = new Map(); // macroId -> { total, ok }
  for (const a of actions) {
    const macroId = a.params?.macroId;
    if (macroId === undefined) continue;
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
    if (!v.label) continue;
    const arr = byLabel.get(v.label) ?? [];
    arr.push(v);
    byLabel.set(v.label, arr);
  }
  const verityLabelsStillFailing = [...byLabel.entries()]
    .map(([label, runs]) => ({ label, runs: runs.sort((a, b) => a.id - b.id) }))
    .filter(({ runs }) => runs[runs.length - 1].passed === false)
    .map(({ label, runs }) => ({ label, importCount: runs.length, lastImportedAt: runs[runs.length - 1].imported_at }));

  return {
    totals: { sessions: sessions.length, actions: actions.length, macros: macros.length, verityRuns: verityRuns.length },
    malformedActionsSkipped,
    failureRateByType,
    topFailedSelectors,
    macrosNeverRun,
    macrosNeverSucceeding,
    verityLabelsStillFailing,
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
const ANALYTICS_CACHE_MS = 5000;
let analyticsCache = null; // { at, data }

function getAnalytics() {
  const now = Date.now();
  if (analyticsCache && (now - analyticsCache.at) < ANALYTICS_CACHE_MS) return analyticsCache.data;
  const data = computeAnalytics();
  analyticsCache = { at: now, data };
  return data;
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
    const live = await dispatchCommand('db.version', {}, COMMAND_TIMEOUT_MS, DEFAULT_AGENT);
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

const routes = [
  { method: 'GET', pattern: /^\/health$/, handler: async () => ({ status: 'ok', agents_connected: connectedAgentNames(), active_session: dbApi.getCurrentSession(), db_version_drift: await getDbVersionDrift() }) },
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
  { method: 'GET', pattern: /^\/agents$/, handler: async () => ({ agents: connectedAgentNames() }) },
  { method: 'GET', pattern: /^\/dashboard$/, isHtml: true, handler: async () => fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8') },

  {
    method: 'POST',
    pattern: /^\/sessions$/,
    handler: async (req) => {
      const body = await readJsonBody(req);
      const session = dbApi.startSession({
        goal: body.goal,
        context: body.context,
        strictCrv: !!body.strict_crv,
        strictCrvStores: Array.isArray(body.strict_crv_stores) ? body.strict_crv_stores : undefined,
        tags: Array.isArray(body.tags) ? body.tags : undefined,
      });
      broadcastUpdate('session', null);
      openDashboardInBrowser();
      return session;
    },
  },
  {
    method: 'POST',
    pattern: /^\/sessions\/(\d+)\/end$/,
    handler: async (_req, m) => {
      const session = dbApi.endSession(Number(m[1]));
      broadcastUpdate('session', null);
      return session;
    },
  },
  { method: 'GET', pattern: /^\/sessions$/, handler: async () => dbApi.listSessions() },
  { method: 'GET', pattern: /^\/sessions\/(\d+)$/, handler: async (_req, m) => dbApi.getSession(Number(m[1])) },
  {
    // Default response is redacted (see listActionsSummary in db.mjs - the
    // 3 known-heavy result shapes get their bulk stripped) since the
    // dashboard re-fetches this whole list on every refresh cycle and only
    // needs full detail for a row someone actually expands (fetched
    // separately below). Pass ?full=1 to get the untouched rows (the CLI's
    // `session show` needs this - a terminal dump has no lazy-expand step)
    // and/or ?limit=N to cap row count server-side rather than trusting the
    // client to discard the rest after paying to receive it.
    method: 'GET',
    pattern: /^\/sessions\/(\d+)\/actions$/,
    handler: async (req, m) => {
      const { searchParams } = new URL(req.url, `http://${HOST}`);
      const full = searchParams.get('full') === '1';
      const limitParam = searchParams.get('limit');
      const limit = limitParam ? Number(limitParam) : undefined;
      return full ? dbApi.listActions(Number(m[1])) : dbApi.listActionsSummary(Number(m[1]), { limit });
    },
  },
  {
    // Full, unredacted single action - what a dashboard row-expand fetches
    // lazily for one of the 3 redacted types instead of paying for every
    // row's full payload on every list refresh.
    method: 'GET',
    pattern: /^\/sessions\/(\d+)\/actions\/(\d+)$/,
    handler: async (_req, m) => {
      const action = dbApi.getActionById(Number(m[2]));
      if (action.session_id !== Number(m[1])) throw new HttpError(404, `action ${m[2]} does not belong to session ${m[1]}`);
      return action;
    },
  },
  { method: 'GET', pattern: /^\/sessions\/(\d+)\/snapshots$/, handler: async (_req, m) => dbApi.listSnapshots(Number(m[1])) },
  { method: 'GET', pattern: /^\/sessions\/(\d+)\/diffs$/, handler: async (_req, m) => dbApi.listDiffs(Number(m[1])) },
  { method: 'GET', pattern: /^\/sessions\/(\d+)\/qa$/, handler: async (_req, m) => dbApi.listQA(Number(m[1])) },
  {
    method: 'GET',
    pattern: /^\/sessions\/(\d+)\/console$/,
    handler: async (req, m) => {
      const { searchParams } = new URL(req.url, `http://${HOST}`);
      const limitParam = searchParams.get('limit');
      return dbApi.listConsoleEntries(Number(m[1]), { limit: limitParam ? Number(limitParam) : undefined });
    },
  },
  {
    method: 'GET',
    pattern: /^\/sessions\/(\d+)\/net$/,
    handler: async (req, m) => {
      const { searchParams } = new URL(req.url, `http://${HOST}`);
      const limitParam = searchParams.get('limit');
      return dbApi.listNetEntries(Number(m[1]), { limit: limitParam ? Number(limitParam) : undefined });
    },
  },
  { method: 'GET', pattern: /^\/sessions\/(\d+)\/verity-runs$/, handler: async (_req, m) => dbApi.listVerityRuns(Number(m[1])) },
  { method: 'GET', pattern: /^\/verity-runs\/(\d+)$/, handler: async (_req, m) => dbApi.getVerityRun(Number(m[1])) },
  {
    // Explicitly does NOT call requireActiveSession() - reviewing a
    // session (often already ended) is the entire point of this route.
    method: 'GET',
    pattern: /^\/sessions\/(\d+)\/report$/,
    handler: async (req, m) => {
      const bundle = await gatherReportBundle(Number(m[1]));
      const { searchParams } = new URL(req.url, `http://${HOST}`);
      const format = searchParams.get('format') === 'json' ? 'json' : 'md';
      return { format, content: format === 'json' ? buildReportJson(bundle) : buildReportMarkdown(bundle) };
    },
  },

  {
    // Session-scoped write ledger. Two independent modes, since neither one
    // alone is complete:
    //
    // Default (action-log mode): walks the session's own logged actions
    // (idb.put/idb.delete/idb.deleteMany/idb.clear) and computes exactly
    // which rows are still live and were written by this session, so an
    // operator doesn't have to hand-track keys to clean up test data -
    // confirmed tedious in a real session (12 rows deleted one CLI call
    // each). Blind to any write NOT made through those 4 command types -
    // in particular every real UI-driven write (a button click that runs
    // `someCrud.add(...)` inside the page's own code) and every `eval`
    // write are invisible to it. `eval` writes are at least flagged by
    // count (opaque expr, no structured store/key to recover); UI-driven
    // writes get no signal at all in this mode - confirmed to require a
    // full manual store dump + hand-picked ids in a real CRV session,
    // twice, because promote/observe/create-trial buttons all write this
    // way.
    //
    // {"sinceSnapshotId": N} (snapshot-diff mode): takes a fresh snapshot
    // scoped to the SAME stores as persisted snapshot N, diffs it against
    // that snapshot, and treats every row that is new since N - in ANY
    // store, however it got written (button click, eval, idb.put, doesn't
    // matter) - as a pending delete. This is what actually catches UI-
    // driven writes, which is most real writes in a CRV pass. Rows that
    // were merely CHANGED (not added) since N are reported separately and
    // never auto-deleted - a changed row is an edit to pre-existing data,
    // not something cleanup should blindly discard.
    method: 'POST',
    pattern: /^\/sessions\/(\d+)\/cleanup$/,
    handler: async (req, m) => {
      const sessionId = Number(m[1]);
      const body = await readJsonBody(req);
      const agentName = body.agent || DEFAULT_AGENT;

      if (body.sinceSnapshotId) {
        const baseline = dbApi.getSnapshot(Number(body.sinceSnapshotId));
        const stores = Object.keys(baseline.stores || {});
        const { result: freshResult, actionId: snapshotActionId } = await withLoggedAction(sessionId, 'idb.snapshot', { stores, via: 'cleanup', sinceSnapshotId: baseline.id }, () => dispatchCommand('idb.snapshot', { stores }, SNAPSHOT_TIMEOUT_MS, agentName), agentName);
        const freshSnap = dbApi.saveSnapshot({ sessionId, actionId: snapshotActionId, stores: freshResult.stores, agentName });
        const diff = computeDiff(baseline.stores, freshResult.stores);
        const pending = [];
        const changedNotDeleted = [];
        for (const [store, d] of Object.entries(diff)) {
          for (const row of d.added) {
            const key = Array.isArray(d.keyPath) ? d.keyPath.map((k) => row?.[k]) : row?.[d.keyPath];
            const keyIsUsable = Array.isArray(key) ? key.every((v) => v !== undefined) : key !== undefined;
            pending.push({ store, key: keyIsUsable ? key : undefined, row, keyPath: d.keyPath });
          }
          for (const c of d.changed) changedNotDeleted.push({ store, key: c.key, before: c.before, after: c.after });
        }
        broadcastUpdate('action', sessionId);
        broadcastUpdate('snapshot', sessionId);
        if (!body.confirm) {
          return {
            dryRun: true, mode: 'sinceSnapshotId', baselineSnapshotId: baseline.id, freshSnapshotId: freshSnap.id,
            pendingDeletes: pending, changedNotDeleted,
            note: `Compared against snapshot #${baseline.id} across store(s) ${stores.join(', ')}. Pass {"confirm":true,"sinceSnapshotId":${baseline.id}} to delete the ${pending.length} added row(s) listed above. ${changedNotDeleted.length} row(s) were changed (not added) since the baseline and are listed but NOT deleted - review by hand if they need reverting.`,
          };
        }
        const deleted = [];
        const failed = [];
        for (const w of pending) {
          if (w.key === undefined) { failed.push({ ...w, error: `store '${w.store}' keyPath '${w.keyPath}' not present on the added row - cannot derive a delete key` }); continue; }
          try {
            await withLoggedAction(sessionId, 'idb.delete', { store: w.store, key: w.key, via: 'cleanup', sinceSnapshotId: baseline.id }, () => dispatchCommand('idb.delete', { store: w.store, key: w.key }, COMMAND_TIMEOUT_MS, agentName), agentName);
            deleted.push(w);
          } catch (err) {
            failed.push({ ...w, error: err.message });
          }
        }
        broadcastUpdate('action', sessionId);
        return { dryRun: false, mode: 'sinceSnapshotId', baselineSnapshotId: baseline.id, freshSnapshotId: freshSnap.id, deleted, failed, changedNotDeleted };
      }

      const actions = dbApi.listActions(sessionId, { ascending: true });
      const state = new Map(); // `${store}::${JSON.stringify(key)}` -> { store, key, live }
      let evalWriteCount = 0;
      for (const a of actions) {
        if (!a.ok) continue;
        if (a.type === 'eval' && /\.(add|put|update|set|create)\s*\(/.test(String(a.params?.expr ?? ''))) evalWriteCount += 1;
        if (a.type === 'idb.put' && a.params?.store !== undefined && a.result?.key !== undefined) {
          state.set(`${a.params.store}::${JSON.stringify(a.result.key)}`, { store: a.params.store, key: a.result.key, live: true });
        } else if (a.type === 'idb.delete' && a.params?.store !== undefined && a.params?.key !== undefined) {
          state.set(`${a.params.store}::${JSON.stringify(a.params.key)}`, { store: a.params.store, key: a.params.key, live: false });
        } else if (a.type === 'idb.deleteMany' && a.params?.store !== undefined) {
          for (const key of a.params.keys ?? []) state.set(`${a.params.store}::${JSON.stringify(key)}`, { store: a.params.store, key, live: false });
        } else if (a.type === 'idb.clear' && a.params?.store !== undefined) {
          for (const [k, v] of state) if (v.store === a.params.store) v.live = false;
        }
      }
      const pending = [...state.values()].filter((v) => v.live);
      if (!body.confirm) {
        return {
          dryRun: true, mode: 'actionLog', pendingDeletes: pending, evalWriteActionsNotTracked: evalWriteCount,
          note: (evalWriteCount
            ? `${evalWriteCount} eval action(s) in this session look like writes and are NOT tracked here - review manually. `
            : '') + `This mode only tracks idb.put/idb.delete/idb.deleteMany/idb.clear - it does NOT see writes made by clicking a real UI button. Pass {"sinceSnapshotId": <id>} instead to catch those too. Pass {"confirm":true} to delete the ${pending.length} row(s) listed above.`,
        };
      }
      const deleted = [];
      const failed = [];
      for (const w of pending) {
        try {
          await withLoggedAction(sessionId, 'idb.delete', { store: w.store, key: w.key, via: 'cleanup' }, () => dispatchCommand('idb.delete', { store: w.store, key: w.key }, COMMAND_TIMEOUT_MS, agentName), agentName);
          deleted.push(w);
        } catch (err) {
          failed.push({ ...w, error: err.message });
        }
      }
      broadcastUpdate('action', sessionId);
      return { dryRun: false, mode: 'actionLog', deleted, failed, evalWriteActionsNotTracked: evalWriteCount };
    },
  },

  // ---------- Macros (record/replay) ----------
  //
  // A macro is a named, saved subset of one session's own already-logged
  // actions - see js session flow: propose->attach-evidence->review->
  // promote in a real P3.8 verification pass was exactly this shape,
  // re-typed by hand every round. Record once, replay with one call.
  {
    method: 'POST',
    pattern: /^\/macros$/,
    handler: async (req) => {
      const body = await readJsonBody(req);
      if (!body.name || typeof body.name !== 'string' || !body.name.trim()) throw new HttpError(400, 'name is required');
      if (!body.sessionId) throw new HttpError(400, 'sessionId is required');
      const actions = dbApi.listActions(Number(body.sessionId), { ascending: true });
      const allow = body.all ? null : DEFAULT_MACRO_TYPES;
      const steps = actions.filter((a) => a.ok && (!allow || allow.has(a.type))).map((a) => ({ type: a.type, params: a.params ?? {} }));
      if (!steps.length) throw new HttpError(400, 'no replayable actions found in that session - nothing matched the macro type allowlist (pass {"all":true} to include read-only actions too)');
      const macro = dbApi.createMacro({ name: body.name.trim(), sourceSessionId: Number(body.sessionId), steps });
      broadcastUpdate('macro', null);
      return macro;
    },
  },
  { method: 'GET', pattern: /^\/macros$/, handler: async () => dbApi.listMacros() },
  { method: 'GET', pattern: /^\/macros\/(\d+)$/, handler: async (_req, m) => dbApi.getMacro(Number(m[1])) },
  {
    // Full step-array replace - backs the dashboard's macro step inspector
    // (reorder/remove a step before replaying). Body: {"steps": [...]}. No
    // partial/index-based PATCH - the whole array is small (this tool's own
    // macros, not arbitrary data) and a full replace can't drift out of sync
    // with a stale index.
    method: 'PUT',
    pattern: /^\/macros\/(\d+)\/steps$/,
    handler: async (req, m) => {
      const body = await readJsonBody(req);
      if (!Array.isArray(body.steps)) throw new HttpError(400, 'steps (array) is required');
      for (const s of body.steps) {
        if (!s || typeof s.type !== 'string') throw new HttpError(400, 'every step needs a string "type"');
      }
      const macro = dbApi.updateMacroSteps(Number(m[1]), body.steps);
      broadcastUpdate('macro', null);
      return macro;
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/macros\/(\d+)$/,
    handler: async (_req, m) => {
      const result = dbApi.deleteMacro(Number(m[1]));
      broadcastUpdate('macro', null);
      return result;
    },
  },
  {
    // Replays a macro's steps against the CURRENTLY active session (same
    // "context before action" discipline as everything else - a macro
    // does not implicitly create or reuse its source session). Stops at
    // the first failing step unless {"continueOnError": true}. Optional
    // {"fromStep": n} (0-based) skips earlier steps - lets an operator
    // resume a macro after fixing whatever made step n fail, instead of
    // replaying already-succeeded steps again. Does NOT get strict-CRV
    // auto-snapshotting even in a strict-crv session - each step is
    // dispatched directly, not routed back through /command's strict-CRV
    // branch - documented as a known limitation in README.
    //
    // Cross-context replay guard: a macro carrying real mutations (idb.put/
    // delete/clear/eval) can be run against ANY currently active session,
    // not only the one it was recorded from - by design (see above), but
    // that design has no safety net of its own. A macro recorded in one
    // session's throwaway/test context, replayed later against an
    // unrelated real session, mutates that session's data with no warning.
    // Refuses (409) when the target session's goal has low word-overlap
    // with the macro's own source session's goal, unless {"confirm": true}
    // is passed - cheap and approximate on purpose (see
    // MACRO_CONTEXT_SIMILARITY_THRESHOLD above), not a semantic check.
    method: 'POST',
    pattern: /^\/macros\/(\d+)\/run$/,
    handler: async (req, m) => {
      const macro = dbApi.getMacro(Number(m[1]));
      const body = await readJsonBody(req);
      const agentName = body.agent || DEFAULT_AGENT;
      const continueOnError = !!body.continueOnError;
      const confirmCrossContext = !!body.confirm;
      const fromStep = Number.isInteger(body.fromStep) && body.fromStep > 0 ? body.fromStep : 0;
      const session = requireActiveSession();

      if (macro.source_session_id && !confirmCrossContext) {
        let sourceSession = null;
        try { sourceSession = dbApi.getSession(macro.source_session_id); } catch { /* source session no longer resolvable - nothing to compare against */ }
        if (sourceSession) {
          const similarity = jaccardSimilarity(goalWordSet(sourceSession.goal), goalWordSet(session.goal));
          if (similarity < MACRO_CONTEXT_SIMILARITY_THRESHOLD) {
            throw new HttpError(409, `cross-context replay guard: macro "${macro.name}" was recorded in session #${sourceSession.id} ("${sourceSession.goal}") but the currently active session #${session.id} ("${session.goal}") looks unrelated (word-overlap ${(similarity * 100).toFixed(0)}% < ${(MACRO_CONTEXT_SIMILARITY_THRESHOLD * 100).toFixed(0)}%). Pass {"confirm": true} to run it anyway.`);
          }
        }
      }

      const results = [];
      for (const step of macro.steps.slice(fromStep)) {
        const stepTimeoutMs = LONG_POLL_TYPES.has(step.type) ? (Number(step.params?.timeoutMs) || 15000) + 5000
          : step.type === 'idb.snapshot' ? SNAPSHOT_TIMEOUT_MS : COMMAND_TIMEOUT_MS;
        try {
          const { result } = await withLoggedAction(session.id, step.type, { ...step.params, via: 'macro', macroId: macro.id, macroName: macro.name }, () => dispatchCommand(step.type, step.params ?? {}, stepTimeoutMs, agentName), agentName);
          results.push({ type: step.type, ok: true, result });
        } catch (err) {
          results.push({ type: step.type, ok: false, error: err.message });
          if (!continueOnError) break;
        }
      }
      broadcastUpdate('action', session.id);
      return { macro: { id: macro.id, name: macro.name }, fromStep, ranSteps: results.length, totalSteps: macro.steps.length, results };
    },
  },

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
    handler: async (req) => {
      const body = await readJsonBody(req);
      const { type, params } = body;
      const agentName = body.agent || DEFAULT_AGENT;
      if (!type) throw new HttpError(400, 'type is required');
      if (type === 'idb.snapshot') throw new HttpError(400, "use POST /state/snapshot instead - idb.snapshot must be persisted, never dispatched raw");
      const session = requireActiveSession();
      const dispatchTimeoutMs = LONG_POLL_TYPES.has(type) ? (Number(params?.timeoutMs) || 15000) + 5000 : COMMAND_TIMEOUT_MS;

      if (session.strict_crv && STRICT_CRV_TYPES.has(type)) {
        // Scoped to session.strict_crv_stores when the session was started
        // with `--stores a,b,c` - unscoped (stores: undefined) still means
        // "whole db", same as before, so an old caller that never scoped
        // keeps its old (slow, but complete) behavior.
        const autoStores = session.strict_crv_stores || undefined;
        const before = await withLoggedAction(session.id, 'idb.snapshot', { auto: true, phase: 'before', for: type, stores: autoStores }, () => dispatchCommand('idb.snapshot', { stores: autoStores }, SNAPSHOT_TIMEOUT_MS, agentName), agentName);
        const beforeSnap = dbApi.saveSnapshot({ sessionId: session.id, actionId: before.actionId, stores: before.result.stores, agentName });

        const triggering = await dispatchTracked(session, type, params, agentName, dispatchTimeoutMs);

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

        return {
          data: triggering.result,
          crv: { before_snapshot_id: beforeSnap.id, after_snapshot_id: afterSnap.id, diff_id: savedDiff.id, diff_summary: savedDiff.summary },
        };
      }

      const { result } = await dispatchTracked(session, type, params, agentName, dispatchTimeoutMs);
      broadcastUpdate('action', session.id);
      return result;
    },
  },

  {
    method: 'POST',
    pattern: /^\/state\/snapshot$/,
    handler: async (req) => {
      const body = await readJsonBody(req);
      const agentName = body.agent || DEFAULT_AGENT;
      const stores = Array.isArray(body.stores) ? body.stores : undefined;
      const goldenName = typeof body.golden === 'string' && body.golden.trim() ? body.golden.trim() : undefined;
      const session = requireActiveSession();
      const { result, actionId } = await withLoggedAction(session.id, 'idb.snapshot', { stores, golden: goldenName }, () => dispatchCommand('idb.snapshot', { stores }, SNAPSHOT_TIMEOUT_MS, agentName), agentName);
      const saved = dbApi.saveSnapshot({ sessionId: session.id, actionId, stores: result.stores, agentName, goldenName });
      broadcastUpdate('action', session.id);
      broadcastUpdate('snapshot', session.id);
      return { id: saved.id, takenAt: saved.takenAt, counts: saved.counts, byteSize: saved.byteSize, agentName: saved.agentName, goldenName: saved.goldenName };
    },
  },
  { method: 'GET', pattern: /^\/state\/snapshots\/(\d+)$/, handler: async (_req, m) => dbApi.getSnapshot(Number(m[1])) },
  {
    // Accepts EITHER {idA, idB} (two persisted snapshot ids, original form)
    // OR {golden: "<name>", idB} (resolves idA via the latest snapshot
    // tagged with that name, from ANY session - see db.mjs's
    // getGoldenSnapshot) - a golden regression baseline lets a later phase
    // ask "did I touch anything this name already proved untouched" without
    // hunting down an old snapshot id by hand.
    method: 'POST',
    pattern: /^\/state\/diff$/,
    handler: async (req) => {
      const body = await readJsonBody(req);
      const idB = Number(body.idB);
      if (!idB) throw new HttpError(400, 'idB (snapshot id) is required');
      const session = requireActiveSession();
      let idA;
      if (body.golden) {
        const golden = dbApi.getGoldenSnapshot(String(body.golden));
        idA = golden.id;
      } else {
        idA = Number(body.idA);
        if (!idA) throw new HttpError(400, 'idA (snapshot id) or golden (name) is required');
      }
      const { result, actionId } = await withLoggedAction(session.id, 'idb.diff', { idA, idB, golden: body.golden ?? undefined }, async () => {
        const a = dbApi.getSnapshot(idA);
        const b = dbApi.getSnapshot(idB);
        const diff = computeDiff(a.stores, b.stores);
        return { diff, summary: summarizeDiff(diff) };
      });
      const saved = dbApi.saveDiff({ sessionId: session.id, actionId, fromId: idA, toId: idB, summary: result.summary, diff: result.diff });
      broadcastUpdate('action', session.id);
      broadcastUpdate('diff', session.id);
      return saved;
    },
  },

  {
    // Replays a persisted snapshot's rows back into IndexedDB, one idb.put
    // per row per store - the missing write-back half of golden snapshots/
    // idb diff (which only ever DETECT drift, never correct it). Accepts
    // either {snapshotId} or {golden: "<name>"} (resolved via
    // dbApi.getGoldenSnapshot, same latest-tagged-wins semantics as
    // /state/diff's own golden form). Deliberately additive-only: it never
    // deletes a row added since the snapshot was taken - an exact replace
    // needs an explicit idb.clear per store first, since a blind delete-
    // everything-then-restore could destroy real data restore was never
    // asked to touch. Each put is its own logged action (via: 'restore'),
    // so a partial failure (one bad row) still shows exactly which rows did
    // and didn't make it back, instead of one opaque batch result.
    method: 'POST',
    pattern: /^\/state\/restore$/,
    handler: async (req) => {
      const body = await readJsonBody(req);
      const agentName = body.agent || DEFAULT_AGENT;
      const session = requireActiveSession();
      let snapshot;
      if (body.golden) {
        snapshot = dbApi.getGoldenSnapshot(String(body.golden));
      } else {
        if (!body.snapshotId) throw new HttpError(400, 'snapshotId or golden (name) is required');
        snapshot = dbApi.getSnapshot(Number(body.snapshotId));
      }
      const stores = Object.keys(snapshot.stores || {});
      if (!stores.length) throw new HttpError(400, `snapshot ${snapshot.id} has no stores to restore`);
      const restored = {};
      const failed = [];
      for (const store of stores) {
        const rows = snapshot.stores[store].rows || [];
        let count = 0;
        for (const row of rows) {
          try {
            await withLoggedAction(session.id, 'idb.put', { store, row, via: 'restore', snapshotId: snapshot.id }, () => dispatchCommand('idb.put', { store, row }, COMMAND_TIMEOUT_MS, agentName), agentName);
            count += 1;
          } catch (err) {
            failed.push({ store, error: err.message, row });
          }
        }
        restored[store] = count;
      }
      broadcastUpdate('action', session.id);
      return {
        snapshotId: snapshot.id, goldenName: snapshot.golden_name ?? undefined, restored, failed,
        note: 'restore only PUTS rows from the snapshot - it does NOT delete rows added since the snapshot. Run idb.clear per store first if you need an exact replace instead of a merge.',
      };
    },
  },

  {
    // Declarative regression assertions against LIVE state - dispatches
    // idb.dump for every distinct store named in `checks` (cached within
    // one call) instead of a human eyeballing an idb.dump/snapshot diff by
    // hand every time a check needs re-running. Each check:
    //   { store, where?, count?, countGte?, countLte?, field?, equals? }
    // `where` (exact-equality field map) filters which rows count; omitted
    // means every row in the store. count/countGte/countLte check the
    // matched-row count; field+equals checks a field on the FIRST matched
    // row (requires `where` to be meaningful). All present conditions on a
    // check must pass for that check to pass. Logged as its own
    // 'session.assert' action, so a report shows exactly what was proven
    // and when - not just today's failure/success eyeballing this replaces.
    method: 'POST',
    pattern: /^\/sessions\/(\d+)\/assert$/,
    handler: async (req, m) => {
      const sessionId = Number(m[1]);
      const body = await readJsonBody(req);
      const agentName = body.agent || DEFAULT_AGENT;
      const checks = Array.isArray(body.checks) ? body.checks : [];
      if (!checks.length) throw new HttpError(400, 'checks (non-empty array) is required');
      const session = requireActiveSession();
      if (session.id !== sessionId) throw new HttpError(409, `session ${sessionId} is not the currently active session (active: ${session.id})`);

      const storeCache = new Map();
      async function getStore(store) {
        if (!store) throw new Error('check is missing "store"');
        if (storeCache.has(store)) return storeCache.get(store);
        const dump = await dispatchCommand('idb.dump', { store }, COMMAND_TIMEOUT_MS, agentName);
        storeCache.set(store, dump);
        return dump;
      }
      function rowsMatching(rows, where) {
        if (!where) return rows;
        return rows.filter((r) => Object.entries(where).every(([k, v]) => JSON.stringify(r?.[k]) === JSON.stringify(v)));
      }

      const { result: results, actionId } = await withLoggedAction(sessionId, 'session.assert', { checks }, async () => {
        const out = [];
        for (const check of checks) {
          const details = [];
          let pass = true;
          try {
            const dump = await getStore(check.store);
            const matched = rowsMatching(dump.rows, check.where);
            if (check.count !== undefined) {
              const ok = matched.length === check.count;
              pass = pass && ok;
              details.push(`count ${matched.length} ${ok ? '==' : '!='} ${check.count}`);
            }
            if (check.countGte !== undefined) {
              const ok = matched.length >= check.countGte;
              pass = pass && ok;
              details.push(`count ${matched.length} ${ok ? '>=' : '<'} ${check.countGte}`);
            }
            if (check.countLte !== undefined) {
              const ok = matched.length <= check.countLte;
              pass = pass && ok;
              details.push(`count ${matched.length} ${ok ? '<=' : '>'} ${check.countLte}`);
            }
            if (check.field !== undefined) {
              if (!matched.length) {
                pass = false;
                details.push(`field check on '${check.field}' requested but no row matched "where"`);
              } else {
                const actual = matched[0][check.field];
                const ok = JSON.stringify(actual) === JSON.stringify(check.equals);
                pass = pass && ok;
                details.push(`field '${check.field}' = ${JSON.stringify(actual)} ${ok ? '==' : '!='} ${JSON.stringify(check.equals)}`);
              }
            }
            if (!details.length) { pass = false; details.push('check specified none of count/countGte/countLte/field - nothing to assert'); }
          } catch (err) {
            pass = false;
            details.push(`error: ${err.message}`);
          }
          out.push({ ...check, pass, detail: details.join('; ') });
        }
        return out;
      }, agentName);
      const passed = results.every((r) => r.pass);
      broadcastUpdate('action', sessionId);
      return { passed, actionId, results };
    },
  },
  { method: 'GET', pattern: /^\/state\/diffs\/(\d+)$/, handler: async (_req, m) => dbApi.getDiff(Number(m[1])) },

  // See computeAnalytics()/getAnalytics() above for what this returns and
  // why it's cached.
  { method: 'GET', pattern: /^\/analytics$/, handler: async () => getAnalytics() },

  {
    method: 'POST',
    pattern: /^\/ask$/,
    handler: async (req) => {
      const body = await readJsonBody(req);
      return handleAsk(body.session_id ? Number(body.session_id) : null, body.question);
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
    const result = await route.handler(req, match);
    if (route.isHtml) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(result);
      return;
    }
    sendJson(res, 200, { ok: true, result });
  } catch (err) {
    // db.mjs's lookup functions (getSession/getSnapshot/getDiff) throw a
    // plain Error with this exact "no such <thing>: <id>" prefix on a
    // missing row - translated to 404 here rather than teaching the
    // persistence layer about HTTP status codes.
    const status = err instanceof HttpError ? err.status : (err.message?.startsWith('no such ') ? 404 : 500);
    sendJson(res, status, { ok: false, error: err.message });
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
  if (existing && !existing.socket.destroyed) {
    log(`replacing previously connected agent '${agentName}'`);
    existing.socket.destroy();
  }
  agents.set(agentName, { socket, buffer: Buffer.alloc(0) });
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

server.listen(PORT, HOST, () => {
  log(`listening on http://${HOST}:${PORT} (bound to localhost only)`);
  log('waiting for the in-page agent to connect at /agent ...');
  const current = dbApi.getCurrentSession();
  log(current ? `active session: #${current.id} "${current.goal}"` : 'no active session - start one before dispatching any command');
});
