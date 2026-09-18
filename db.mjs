// Web-scout persistence - node:sqlite wrapper (no npm dependency, matches
// this repo's zero-dependency tooling convention). Single source of truth
// for sessions/actions/state snapshots/diffs/Q&A - everything the relay
// records survives a relay restart or a tab reload, closing the "lost on
// restart" gap this tool's own README previously named.
//
// WAL mode is not needed for in-process correctness (DatabaseSync is
// synchronous/single-threaded, so there is no genuine concurrent-writer
// race inside this one Node process) - it's set anyway so an external
// SQLite viewer can safely read webscout.db while the relay is running,
// mirroring backend/database.py's own convention for the same reason.

import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// WEBSCOUT_DB_PATH overrides the default location - lets a real deployment
// relocate the DB, and lets db.mjs.test.mjs point at a throwaway file
// instead of the real webscout.db (must be set before this module is
// imported, since the DB opens at module-evaluation time below).
const DB_PATH = process.env.WEBSCOUT_DB_PATH || path.join(__dirname, 'webscout.db');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA busy_timeout = 5000');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS sessions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  goal        TEXT NOT NULL,
  context     TEXT,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','ended')),
  started_at  TEXT NOT NULL,
  ended_at    TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_one_active
  ON sessions(status) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS actions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   INTEGER NOT NULL REFERENCES sessions(id),
  type         TEXT NOT NULL,
  params_json  TEXT,
  result_json  TEXT,
  ok           INTEGER NOT NULL CHECK (ok IN (0,1)),
  error        TEXT,
  started_at   TEXT NOT NULL,
  ended_at     TEXT NOT NULL,
  duration_ms  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_actions_session ON actions(session_id, id);

CREATE TABLE IF NOT EXISTS state_snapshots (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   INTEGER NOT NULL REFERENCES sessions(id),
  action_id    INTEGER REFERENCES actions(id),
  taken_at     TEXT NOT NULL,
  counts_json  TEXT NOT NULL,
  stores_json  TEXT NOT NULL,
  byte_size    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snapshots_session ON state_snapshots(session_id, id);

CREATE TABLE IF NOT EXISTS state_diffs (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id        INTEGER NOT NULL REFERENCES sessions(id),
  action_id         INTEGER REFERENCES actions(id),
  snapshot_from_id  INTEGER NOT NULL REFERENCES state_snapshots(id),
  snapshot_to_id    INTEGER NOT NULL REFERENCES state_snapshots(id),
  computed_at       TEXT NOT NULL,
  summary_json      TEXT NOT NULL,
  diff_json         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_diffs_session ON state_diffs(session_id, id);

CREATE TABLE IF NOT EXISTS qa_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   INTEGER NOT NULL REFERENCES sessions(id),
  action_id    INTEGER REFERENCES actions(id),
  question     TEXT NOT NULL,
  context_json TEXT NOT NULL,
  answer       TEXT,
  error        TEXT,
  asked_at     TEXT NOT NULL,
  answered_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_qa_session ON qa_log(session_id, id);

CREATE TABLE IF NOT EXISTS console_entries (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   INTEGER NOT NULL REFERENCES sessions(id),
  agent_name   TEXT NOT NULL,
  level        TEXT NOT NULL CHECK (level IN ('error','warn','uncaught','unhandledrejection')),
  message      TEXT NOT NULL,
  stack        TEXT,
  occurred_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_console_session ON console_entries(session_id, id);

CREATE TABLE IF NOT EXISTS macros (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  name               TEXT NOT NULL UNIQUE,
  source_session_id  INTEGER REFERENCES sessions(id),
  steps_json         TEXT NOT NULL,
  created_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS verity_runs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   INTEGER NOT NULL REFERENCES sessions(id),
  label        TEXT,
  passed       INTEGER,
  step_count   INTEGER NOT NULL DEFAULT 0,
  passed_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  result_json  TEXT NOT NULL,
  imported_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_verity_session ON verity_runs(session_id, id);

CREATE TABLE IF NOT EXISTS net_entries (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   INTEGER NOT NULL REFERENCES sessions(id),
  agent_name   TEXT NOT NULL,
  via          TEXT NOT NULL CHECK (via IN ('fetch','xhr')),
  method       TEXT NOT NULL,
  url          TEXT,
  status       INTEGER,
  error        TEXT,
  started_at   TEXT NOT NULL,
  ended_at     TEXT NOT NULL,
  occurred_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_net_session ON net_entries(session_id, id);
`);

// Migrations onto tables that pre-date this column - node:sqlite's bundled
// SQLite does NOT support `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`
// (confirmed: throws `near "EXISTS": syntax error` on this build), so
// existence is checked via PRAGMA table_info first. table/column names are
// string-interpolated below because SQLite cannot bind them as `?`
// parameters in DDL - safe here because both are always internal constants
// defined in this file, never user input.
function ensureColumn(table, column, ddl) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

ensureColumn('sessions', 'strict_crv', 'strict_crv INTEGER NOT NULL DEFAULT 0');
// Scopes every strict-crv auto-snapshot (before/after each dom.click/fill/
// eval/idb.put/idb.delete) to a given store list, same as the manual
// `idb snapshot --stores` form - without this, strict-crv always snapshots
// the WHOLE db, which times out (SNAPSHOT_TIMEOUT_MS, 60s) against a
// real-size production IndexedDB (confirmed live: this is what actually
// forced abandoning --strict-crv mid-session in a real CRV run).
ensureColumn('sessions', 'strict_crv_stores', 'strict_crv_stores TEXT');
ensureColumn('sessions', 'tags', 'tags TEXT');
ensureColumn('actions', 'agent_name', "agent_name TEXT NOT NULL DEFAULT 'default'");
ensureColumn('state_snapshots', 'agent_name', "agent_name TEXT NOT NULL DEFAULT 'default'");
// Golden regression baseline - a snapshot tagged with a name here can be
// diffed against by ANY future session (not just two ids within the same
// session), so "did this later phase touch anything an earlier phase
// already proved untouched" is a name lookup instead of hunting down an old
// snapshot id. No uniqueness constraint - re-tagging the same name just
// means the latest-by-id wins (see getGoldenSnapshot), so re-baselining
// never requires a migration or a delete first.
ensureColumn('state_snapshots', 'golden_name', 'golden_name TEXT');
// Optional cost cap declared at `session start --token-budget N` - purely
// advisory (nothing here blocks a command from running over it), read by
// the CLI ("session end"/"session show"/"token-report") and the dashboard's
// Token cost panel to render a burn-rate bar and print a warning once the
// session's own estTokens total crosses it. NULL means no budget declared.
ensureColumn('sessions', 'token_budget', 'token_budget INTEGER');
// Content-addressed dedup for actions.result_json (see result_blobs table
// below) - NULL means this row's result was byte-identical to an earlier
// one already stored in result_blobs, so this row's own result_json is left
// NULL and the real content is fetched by hash instead (resolveResultJson).
// NULL on a pre-migration row (or a row whose result was never deduped)
// simply means "read result_json directly", same as always.
ensureColumn('actions', 'result_hash', 'result_hash TEXT');
// Content hash of a snapshot's own stores_json - lets a diff be recognized
// as "identical content to a diff already computed" across DIFFERENT
// snapshot ids (every idb.snapshot takes a fresh id even when nothing
// changed), which a snapshot-id-based cache never could.
ensureColumn('state_snapshots', 'content_hash', 'content_hash TEXT');
// Set when a diff was served from the cache (see findCachedDiff) instead of
// freshly computed - points at the diff id whose summary_json/diff_json was
// reused. NULL for a genuinely fresh computation.
ensureColumn('state_diffs', 'served_from_diff_id', 'served_from_diff_id INTEGER');
// Historical-average estTokens for a macro's own steps, stamped once at
// record/update time (see estimateStepsTokenCost) - "macro list" can then
// show every saved macro's cost with zero live query, instead of asking
// before every single "macro run".
ensureColumn('macros', 'steps_cost_est', 'steps_cost_est INTEGER');
// How many consecutive-duplicate steps compactMacroSteps removed at
// record/update time - 0 for a macro with no such noise.
ensureColumn('macros', 'compacted_steps_removed', 'compacted_steps_removed INTEGER NOT NULL DEFAULT 0');

// ---------- content-addressed result storage ----------
//
// Many action results are byte-identical to an earlier call in the SAME
// session (idb.dump of an unchanged store, dom.query of a static element -
// findRedundantCalls above already proves this happens for real) or even
// across DIFFERENT sessions (the same fixture store dumped in CRV round
// after CRV round). Instead of storing a full physical copy of that JSON on
// every single actions row, store it once here (keyed by its own sha256)
// and have logAction point at it by hash - ref_count tracks how many
// actions rows share it, so getResultDedupSavings can report real bytes
// never physically duplicated on disk, not just a hypothetical estimate.
db.exec(`
CREATE TABLE IF NOT EXISTS result_blobs (
  hash          TEXT PRIMARY KEY,
  json          TEXT NOT NULL,
  byte_length   INTEGER NOT NULL,
  first_seen_at TEXT NOT NULL,
  ref_count     INTEGER NOT NULL DEFAULT 0
);
`);
const stmtGetResultBlob = db.prepare('SELECT json FROM result_blobs WHERE hash = ?');
const stmtInsertResultBlob = db.prepare('INSERT INTO result_blobs (hash, json, byte_length, first_seen_at, ref_count) VALUES (?, ?, ?, ?, 1)');
const stmtBumpResultBlob = db.prepare('UPDATE result_blobs SET ref_count = ref_count + 1 WHERE hash = ?');
const stmtHasResultBlob = db.prepare('SELECT 1 FROM result_blobs WHERE hash = ?');

// Called once per logged action with a result - stores the JSON physically
// only the FIRST time its exact content is ever seen; every later
// occurrence just bumps ref_count and leaves the actions row's own
// result_json NULL (see resolveResultJson for the read-side counterpart).
function internResult(resultJson) {
  const hash = crypto.createHash('sha256').update(resultJson).digest('hex');
  if (stmtHasResultBlob.get(hash)) {
    stmtBumpResultBlob.run(hash);
    return { hash, dedup: true };
  }
  stmtInsertResultBlob.run(hash, resultJson, resultJson.length, new Date().toISOString());
  return { hash, dedup: false };
}

// Read-side counterpart to internResult - a row's own result_json is the
// answer when present; a NULL result_json with a result_hash means "look it
// up in result_blobs instead" (deduped). Never throws on a missing blob
// (shouldn't happen short of manual DB surgery) - just returns null, same
// as a row with no result at all.
function resolveResultJson(resultJson, resultHash) {
  if (resultJson !== null && resultJson !== undefined) return resultJson;
  if (!resultHash) return null;
  return stmtGetResultBlob.get(resultHash)?.json ?? null;
}

export function getResultDedupSavings() {
  const row = db.prepare(
    'SELECT COUNT(*) AS uniqueBlobs, SUM(ref_count) AS totalReferences, SUM(byte_length) AS uniqueBytes, SUM((ref_count - 1) * byte_length) AS bytesSaved FROM result_blobs',
  ).get();
  const bytesSaved = row.bytesSaved || 0;
  return {
    uniqueBlobs: row.uniqueBlobs || 0,
    totalReferences: row.totalReferences || 0,
    uniqueBytes: row.uniqueBytes || 0,
    bytesSaved,
    estTokensSaved: Math.round(bytesSaved / CHARS_PER_TOKEN_ESTIMATE),
  };
}

// ---------- sessions ----------

const stmtInsertSession = db.prepare('INSERT INTO sessions (goal, context, status, started_at, strict_crv, strict_crv_stores, tags, token_budget) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
const stmtGetCurrentSession = db.prepare("SELECT * FROM sessions WHERE status = 'active' LIMIT 1");
const stmtGetSession = db.prepare('SELECT * FROM sessions WHERE id = ?');
const stmtEndSession = db.prepare("UPDATE sessions SET status = 'ended', ended_at = ? WHERE id = ? AND status = 'active'");
const stmtListSessions = db.prepare('SELECT * FROM sessions ORDER BY id DESC');

function hydrateSession(row) {
  if (!row) return row;
  return {
    ...row,
    strict_crv: !!row.strict_crv,
    strict_crv_stores: row.strict_crv_stores ? JSON.parse(row.strict_crv_stores) : null,
    tags: row.tags ? JSON.parse(row.tags) : [],
  };
}

export function getCurrentSession() {
  return hydrateSession(stmtGetCurrentSession.get() ?? null);
}

export function startSession({ goal, context, strictCrv, strictCrvStores, tags, tokenBudget }) {
  if (!goal || typeof goal !== 'string' || !goal.trim()) {
    throw new Error('a non-empty goal is required to start a session');
  }
  const existing = getCurrentSession();
  if (existing) {
    throw new Error(`a session is already active (id ${existing.id}: "${existing.goal}") - end it first with "session end", or keep using it`);
  }
  const startedAt = new Date().toISOString();
  const storesJson = Array.isArray(strictCrvStores) && strictCrvStores.length ? JSON.stringify(strictCrvStores) : null;
  const info = stmtInsertSession.run(goal, context ?? null, 'active', startedAt, strictCrv ? 1 : 0, storesJson, JSON.stringify(tags ?? []), Number.isFinite(tokenBudget) ? Number(tokenBudget) : null);
  return hydrateSession(stmtGetSession.get(Number(info.lastInsertRowid)));
}

export function endSession(id) {
  const target = id ?? getCurrentSession()?.id;
  if (!target) throw new Error('no active session to end');
  const endedAt = new Date().toISOString();
  const info = stmtEndSession.run(endedAt, target);
  if (info.changes === 0) throw new Error(`session ${target} is not active (already ended, or does not exist)`);
  return hydrateSession(stmtGetSession.get(Number(target)));
}

export function getSession(id) {
  const row = stmtGetSession.get(Number(id));
  if (!row) throw new Error(`no such session: ${id}`);
  return hydrateSession(row);
}

export function listSessions() {
  return stmtListSessions.all().map(hydrateSession);
}

// ---------- actions ----------

const stmtInsertAction = db.prepare(`
  INSERT INTO actions (session_id, type, params_json, result_json, result_hash, ok, error, started_at, ended_at, duration_ms, agent_name)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const stmtListActions = db.prepare('SELECT * FROM actions WHERE session_id = ? ORDER BY id DESC');
const stmtListActionsAsc = db.prepare('SELECT * FROM actions WHERE session_id = ? ORDER BY id ASC');
const stmtListActionsLimit = db.prepare('SELECT * FROM actions WHERE session_id = ? ORDER BY id DESC LIMIT ?');
const stmtGetActionById = db.prepare('SELECT * FROM actions WHERE id = ?');

export function logAction({ sessionId, type, params, result, ok, error, startedAt, endedAt, agentName }) {
  const durationMs = new Date(endedAt).getTime() - new Date(startedAt).getTime();
  const resultJson = result === undefined ? null : JSON.stringify(result);
  // Content-addressed dedup (see result_blobs above): a duplicate result is
  // stored ONCE, ever - this row just points at it by hash and stores NULL
  // for its own result_json.
  let storedResultJson = resultJson;
  let resultHash = null;
  if (resultJson !== null) {
    const interned = internResult(resultJson);
    resultHash = interned.hash;
    if (interned.dedup) storedResultJson = null;
  }
  const info = stmtInsertAction.run(
    sessionId, type,
    params === undefined ? null : JSON.stringify(params),
    storedResultJson, resultHash,
    ok ? 1 : 0,
    error ?? null,
    startedAt, endedAt, Number.isFinite(durationMs) ? durationMs : 0,
    agentName ?? 'default',
  );
  return Number(info.lastInsertRowid);
}

export function listActions(sessionId, { ascending = false } = {}) {
  const rows = (ascending ? stmtListActionsAsc : stmtListActions).all(Number(sessionId));
  return rows.map((r) => {
    const resultJson = resolveResultJson(r.result_json, r.result_hash);
    return { ...r, params: r.params_json ? JSON.parse(r.params_json) : null, result: resultJson ? JSON.parse(resultJson) : null };
  });
}

export function getActionById(actionId) {
  const row = stmtGetActionById.get(Number(actionId));
  if (!row) throw new Error(`no such action: ${actionId}`);
  const resultJson = resolveResultJson(row.result_json, row.result_hash);
  return { ...row, params: row.params_json ? JSON.parse(row.params_json) : null, result: resultJson ? JSON.parse(resultJson) : null };
}

// The heaviest rows this table ever holds are a handful of known result
// shapes: dom.screenshot's base64 dataUrl, idb.snapshot's full multi-store
// dump, and net.log's captured-entries array - measured directly against a
// live webscout.db at 50-90KB per row for these three types, dwarfing every
// other action's result. The dashboard actions table re-fetches and
// re-renders this whole list on every refresh, so shipping those bytes
// (and re-parsing them client-side) on every poll/SSE tick is the real
// driver behind a long CRV session's browser tab memory climbing far past
// what's actually needed for a table that shows 5 columns per row. This is
// list-view only - getActionById above still returns the untouched row for
// a caller that explicitly wants one action's full detail (see relay.mjs's
// GET /sessions/:id/actions/:actionId, used by the dashboard's row-expand).
const HEAVY_ACTION_RESULT_REDACTORS = {
  'dom.screenshot': (r) => (r && typeof r === 'object' && r.dataUrl ? { ...r, dataUrl: null, redacted: true } : r),
  'idb.snapshot': (r) => (r && typeof r === 'object' && r.stores ? { ...r, stores: null, redacted: true } : r),
  'net.log': (r) => (r && typeof r === 'object' && Array.isArray(r.entries) ? { ...r, entries: null, entryCount: r.entries.length, redacted: true } : r),
};

export function listActionsSummary(sessionId, { limit } = {}) {
  const lim = Number.isFinite(limit) && limit > 0 ? Number(limit) : -1;
  const rows = stmtListActionsLimit.all(Number(sessionId), lim);
  return rows.map((r) => {
    const resultJson = resolveResultJson(r.result_json, r.result_hash);
    const result = resultJson ? JSON.parse(resultJson) : null;
    const redact = HEAVY_ACTION_RESULT_REDACTORS[r.type];
    return {
      ...r,
      params: r.params_json ? JSON.parse(r.params_json) : null,
      result: redact ? redact(result) : result,
    };
  });
}

// ---------- action token-cost report ----------
//
// Every action's full result_json is already stored (logAction above) -
// this is the same substrate a coding agent's own token spend comes from,
// since printResult/session-report put that exact JSON on stdout for it to
// read. A pure SQL aggregate (SUM(LENGTH(...)) GROUP BY type) never
// materializes the actual row content in Node, so running this report costs
// nothing close to what it's measuring - unlike fetching listActions(full)
// and summing client-side, which would re-pay the very bytes being audited.
// LEFT JOIN result_blobs so a deduped row's LOGICAL size (what a caller
// would actually receive/print - identical whether physically stored once
// or N times) is still counted accurately, even though internResult above
// only physically stores it once.
const stmtActionCostByType = db.prepare(`
  SELECT a.type AS type,
    COUNT(*) AS calls,
    SUM(LENGTH(COALESCE(a.result_json, rb.json, ''))) AS resultBytes,
    SUM(LENGTH(COALESCE(a.params_json, ''))) AS paramsBytes
  FROM actions a LEFT JOIN result_blobs rb ON a.result_hash = rb.hash
  WHERE a.session_id = ? GROUP BY a.type ORDER BY resultBytes DESC
`);
const stmtActionCostByTypeAll = db.prepare(`
  SELECT a.type AS type,
    COUNT(*) AS calls,
    SUM(LENGTH(COALESCE(a.result_json, rb.json, ''))) AS resultBytes,
    SUM(LENGTH(COALESCE(a.params_json, ''))) AS paramsBytes
  FROM actions a LEFT JOIN result_blobs rb ON a.result_hash = rb.hash
  GROUP BY a.type ORDER BY resultBytes DESC
`);
// chars/4 - the commonly-cited rough proxy for English/JSON-ish text tokens,
// not a real tokenizer. Good enough to RANK command types against each
// other and spot the outliers; never treat as an exact bill.
const CHARS_PER_TOKEN_ESTIMATE = 4;

function toActionCostRow(r) {
  const resultBytes = r.resultBytes || 0;
  const paramsBytes = r.paramsBytes || 0;
  return {
    type: r.type,
    calls: r.calls,
    resultBytes,
    paramsBytes,
    avgResultBytes: r.calls ? Math.round(resultBytes / r.calls) : 0,
    estTokens: Math.round((resultBytes + paramsBytes) / CHARS_PER_TOKEN_ESTIMATE),
  };
}

export function getActionCostReport(sessionId) {
  const rows = (sessionId !== undefined && sessionId !== null
    ? stmtActionCostByType.all(Number(sessionId))
    : stmtActionCostByTypeAll.all()
  ).map(toActionCostRow);
  return {
    scope: sessionId !== undefined && sessionId !== null ? { sessionId: Number(sessionId) } : { allSessions: true },
    byType: rows,
    totalCalls: rows.reduce((sum, r) => sum + r.calls, 0),
    totalEstTokens: rows.reduce((sum, r) => sum + r.estTokens, 0),
  };
}

// ---------- repeated-call loop detection ----------
//
// Reads type/params_json/started_at only - never result_json - so spotting
// a real polling loop (the confirmed "eval 1+1 while waiting for boot"
// shape) never itself pays the cost of the heavy results those calls may
// have returned. Consecutive same-type+same-params calls within
// REPEAT_WINDOW_MS of each other count as one loop; a run of 3+ is reported
// (2 identical calls minutes apart is ordinary re-checking, not a loop).
const stmtActionSequence = db.prepare('SELECT type, params_json, started_at FROM actions WHERE session_id = ? ORDER BY id ASC');
const REPEAT_WINDOW_MS = 5000;
const REPEAT_MIN_RUN = 3;

export function findRepeatedActionLoops(sessionId) {
  const rows = stmtActionSequence.all(Number(sessionId));
  const loops = [];
  let run = null;
  const flush = () => { if (run && run.count >= REPEAT_MIN_RUN) loops.push({ type: run.type, params: run.params, count: run.count, firstAt: run.firstAt, lastAt: run.lastAt }); };
  for (const r of rows) {
    const key = `${r.type}::${r.params_json ?? ''}`;
    const t = new Date(r.started_at).getTime();
    if (run && run.key === key && Number.isFinite(t) && t - run.lastT <= REPEAT_WINDOW_MS) {
      run.count += 1;
      run.lastT = t;
      run.lastAt = r.started_at;
    } else {
      flush();
      run = { key, type: r.type, params: r.params_json ? JSON.parse(r.params_json) : null, count: 1, firstAt: r.started_at, lastAt: r.started_at, lastT: t };
    }
  }
  flush();
  return loops;
}

// ---------- redundant read-call detection ----------
//
// A distinct waste shape from the repeated-loop detector above: not a tight
// poll (same call 3+ times within 5s), but two of the SAME read call (same
// type + same target - store for idb.dump, selector for dom.query) spaced
// minutes apart in the same session, whose RESULT never actually changed in
// between - "did I already know this" re-checking, the exact case the
// same-session read-result cache (relay.mjs's readResultCache) now also
// short-circuits going forward. This function looks BACKWARD at what
// already happened (useful even for a session that predates that cache, or
// ran with mutating commands the cache correctly treats as invalidating).
// Only two read types worth this (idb.dump/dom.query are the #1 and #3
// all-time cost offenders per getActionCostReport) - net.log/console.log
// are inherently append-only ring buffers where "same result twice" is not
// a meaningful redundancy signal.
const REDUNDANCY_CHECK_TYPES = new Set(['idb.dump', 'dom.query']);
const stmtActionsForRedundancy = db.prepare(
  "SELECT id, type, params_json, result_json, result_hash, started_at FROM actions WHERE session_id = ? AND type IN ('idb.dump','dom.query') ORDER BY id ASC",
);

function redundancyKey(type, paramsJson) {
  if (!paramsJson) return '';
  try {
    const p = JSON.parse(paramsJson);
    if (type === 'idb.dump') return p.store ?? '';
    if (type === 'dom.query') return p.selector ?? '';
  } catch { /* fall through to the raw string below */ }
  return paramsJson;
}

function hashResultJson(resultJson) {
  return crypto.createHash('sha256').update(resultJson ?? '').digest('hex');
}

export function findRedundantCalls(sessionId) {
  const rows = stmtActionsForRedundancy.all(Number(sessionId));
  const lastByKey = new Map(); // `${type}::${key}` -> { hash, actionId, at }
  const redundant = [];
  for (const r of rows) {
    const key = `${r.type}::${redundancyKey(r.type, r.params_json)}`;
    // result_hash is already computed once at write time (logAction's
    // internResult) - reuse it directly instead of re-hashing the full
    // result content here. Only a pre-migration row (result_hash NULL,
    // result_json still the full legacy content) falls back to hashing.
    const hash = r.result_hash || hashResultJson(r.result_json);
    const prev = lastByKey.get(key);
    if (prev && prev.hash === hash) {
      redundant.push({ type: r.type, target: redundancyKey(r.type, r.params_json), actionId: r.id, repeatsActionId: prev.actionId, at: r.started_at });
    }
    lastByKey.set(key, { hash, actionId: r.id, at: r.started_at });
  }
  return redundant;
}

// ---------- token cost by target (store/selector), not just by type ----------
//
// getActionCostReport groups by TYPE only - "idb.dump costs 90K tokens
// total" doesn't say WHICH store. Reuses redundancyKey (above) to extract
// the same store/selector target findRedundantCalls already keys on, so a
// caller sees "store X dumped 40x, 90K tokens" instead of having to guess
// which store inside "idb.dump" is the actual hotspot. Byte lengths only
// (LENGTH(...) in SQL) - never fetches full result_json here, same
// no-re-paying-the-bytes-being-measured discipline as getActionCostReport.
const stmtActionsForTargetCost = db.prepare(
  "SELECT a.type AS type, a.params_json AS params_json, LENGTH(COALESCE(a.result_json, rb.json, '')) AS resultBytes, LENGTH(COALESCE(a.params_json,'')) AS paramsBytes FROM actions a LEFT JOIN result_blobs rb ON a.result_hash = rb.hash WHERE a.session_id = ? AND a.type IN ('idb.dump','dom.query') ORDER BY a.id ASC",
);
const stmtActionsForTargetCostAll = db.prepare(
  "SELECT a.type AS type, a.params_json AS params_json, LENGTH(COALESCE(a.result_json, rb.json, '')) AS resultBytes, LENGTH(COALESCE(a.params_json,'')) AS paramsBytes FROM actions a LEFT JOIN result_blobs rb ON a.result_hash = rb.hash WHERE a.type IN ('idb.dump','dom.query') ORDER BY a.id ASC",
);

export function getActionCostByTarget(sessionId) {
  const rows = sessionId !== undefined && sessionId !== null
    ? stmtActionsForTargetCost.all(Number(sessionId))
    : stmtActionsForTargetCostAll.all();
  const byTarget = new Map(); // `${type}::${target}` -> accumulator
  for (const r of rows) {
    const target = redundancyKey(r.type, r.params_json);
    const key = `${r.type}::${target}`;
    const cur = byTarget.get(key) || { type: r.type, target, calls: 0, resultBytes: 0, paramsBytes: 0 };
    cur.calls += 1;
    cur.resultBytes += r.resultBytes;
    cur.paramsBytes += r.paramsBytes;
    byTarget.set(key, cur);
  }
  return [...byTarget.values()]
    .map((r) => {
      const estTokens = Math.round((r.resultBytes + r.paramsBytes) / CHARS_PER_TOKEN_ESTIMATE);
      return {
        ...r,
        avgResultBytes: r.calls ? Math.round(r.resultBytes / r.calls) : 0,
        estTokens,
        avgEstTokens: r.calls ? Math.round(estTokens / r.calls) : 0,
      };
    })
    .sort((a, b) => b.estTokens - a.estTokens);
}

// ---------- token cost trend across sessions sharing a tag ----------
//
// A single session's own token-report (getActionCostReport above) can only
// ever answer "how much did THIS session cost" - it can't say whether a
// repeated shape of work (this project's own round-1/round-2/... CRV
// convention, tracked via session tags) is getting cheaper or more wasteful
// each time it's repeated. One row per session (LEFT JOIN so a session with
// zero actions still appears, at 0 tokens, rather than vanishing) - the
// caller (dashboard) does the tag-matching/grouping client-side, since
// "which tag to trend on" is a per-viewer choice (the currently open
// session's own tags), not something this function should guess.
const stmtSessionTokenTotals = db.prepare(`
  SELECT s.id AS sessionId, s.goal AS goal, s.tags AS tagsJson, s.started_at AS startedAt,
    SUM(LENGTH(COALESCE(a.result_json, rb.json, '')) + LENGTH(COALESCE(a.params_json, ''))) AS totalBytes
  FROM sessions s LEFT JOIN actions a ON a.session_id = s.id LEFT JOIN result_blobs rb ON a.result_hash = rb.hash
  GROUP BY s.id ORDER BY s.id ASC
`);

export function getSessionTokenTotals() {
  return stmtSessionTokenTotals.all().map((r) => ({
    sessionId: r.sessionId,
    goal: r.goal,
    tags: r.tagsJson ? JSON.parse(r.tagsJson) : [],
    startedAt: r.startedAt,
    totalEstTokens: Math.round((r.totalBytes || 0) / CHARS_PER_TOKEN_ESTIMATE),
  }));
}

// Cross-session - backs GET /analytics ("Friction Analytics", see
// docs/web-scout-roadmap.md's V7 entry). Every other actions query is
// session-scoped by design (the evidentiary gate ties evidence to one
// declared goal); this is the one deliberate exception, since finding a
// recurring pattern requires looking across every session's own log.
const stmtListAllActions = db.prepare('SELECT * FROM actions ORDER BY id ASC');

// Parses params_json/result_json per row inside a try/catch, SKIPPING (not
// throwing on) a malformed row - the earlier version's single JSON.parse
// failure anywhere in the whole table threw for the ENTIRE call, silently
// breaking Friction Analytics globally from one bad row in one session's
// history (the dashboard's own best-effort catch swallowed the error with
// no visible sign anything was wrong). `skipped` is returned so the caller
// can surface it instead of pretending nothing happened.
export function listAllActions() {
  const rows = stmtListAllActions.all();
  const actions = [];
  let skipped = 0;
  for (const r of rows) {
    try {
      const resultJson = resolveResultJson(r.result_json, r.result_hash);
      actions.push({
        ...r,
        params: r.params_json ? JSON.parse(r.params_json) : null,
        result: resultJson ? JSON.parse(resultJson) : null,
      });
    } catch {
      skipped += 1;
    }
  }
  return { actions, skipped };
}

// ---------- state snapshots ----------

const stmtInsertSnapshot = db.prepare(`
  INSERT INTO state_snapshots (session_id, action_id, taken_at, counts_json, stores_json, byte_size, agent_name, golden_name, content_hash)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const stmtGetSnapshot = db.prepare('SELECT * FROM state_snapshots WHERE id = ?');
const stmtListSnapshots = db.prepare('SELECT id, session_id, action_id, taken_at, counts_json, byte_size, agent_name, golden_name FROM state_snapshots WHERE session_id = ? ORDER BY id DESC');
const stmtGetGoldenSnapshot = db.prepare('SELECT * FROM state_snapshots WHERE golden_name = ? ORDER BY id DESC LIMIT 1');

export function saveSnapshot({ sessionId, actionId, stores, agentName, goldenName }) {
  const takenAt = new Date().toISOString();
  const counts = {};
  for (const [name, entry] of Object.entries(stores)) counts[name] = entry.rows.length;
  const storesJson = JSON.stringify(stores);
  // Content hash (not the row's own id) is what findCachedDiff keys on -
  // lets a diff be recognized as "nothing new" across DIFFERENT snapshot
  // ids, since every idb.snapshot takes a fresh id even when the store's
  // content didn't actually change.
  const contentHash = crypto.createHash('sha256').update(storesJson).digest('hex');
  const info = stmtInsertSnapshot.run(sessionId, actionId ?? null, takenAt, JSON.stringify(counts), storesJson, storesJson.length, agentName ?? 'default', goldenName ?? null, contentHash);
  return { id: Number(info.lastInsertRowid), takenAt, counts, byteSize: storesJson.length, agentName: agentName ?? 'default', goldenName: goldenName ?? null, contentHash };
}

export function getSnapshot(id) {
  const row = stmtGetSnapshot.get(Number(id));
  if (!row) throw new Error(`no such snapshot: ${id}`);
  return { ...row, counts: JSON.parse(row.counts_json), stores: JSON.parse(row.stores_json) };
}

export function listSnapshots(sessionId) {
  return stmtListSnapshots.all(Number(sessionId)).map((r) => ({ ...r, counts: JSON.parse(r.counts_json) }));
}

// Latest-tagged-wins lookup - a golden snapshot is identified by name, not
// id, so callers never need to remember/relay an id across sessions.
export function getGoldenSnapshot(name) {
  const row = stmtGetGoldenSnapshot.get(name);
  if (!row) throw new Error(`no such golden snapshot: ${name}`);
  return { ...row, counts: JSON.parse(row.counts_json), stores: JSON.parse(row.stores_json) };
}

// ---------- state diffs ----------

const stmtInsertDiff = db.prepare(`
  INSERT INTO state_diffs (session_id, action_id, snapshot_from_id, snapshot_to_id, computed_at, summary_json, diff_json, served_from_diff_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
const stmtGetDiff = db.prepare('SELECT * FROM state_diffs WHERE id = ?');
const stmtListDiffs = db.prepare('SELECT id, session_id, action_id, snapshot_from_id, snapshot_to_id, computed_at, summary_json, served_from_diff_id FROM state_diffs WHERE session_id = ? ORDER BY id DESC');
// Two snapshots with matching content_hash produce the SAME diff no matter
// their own ids - if this exact (fromHash, toHash) pair was already
// diffed, reuse that result instead of recomputing (computeDiff is cheap,
// but the caller - suite run's diff-golden step - paying to receive and
// print an identical multi-KB diff every single re-run is the real waste,
// same shape as findRedundantCalls above but for diffs instead of reads).
const stmtFindDiffByContentHash = db.prepare(`
  SELECT sd.* FROM state_diffs sd
  JOIN state_snapshots sa ON sd.snapshot_from_id = sa.id
  JOIN state_snapshots sb ON sd.snapshot_to_id = sb.id
  WHERE sa.content_hash = ? AND sb.content_hash = ? AND sd.served_from_diff_id IS NULL
  ORDER BY sd.id DESC LIMIT 1
`);

export function saveDiff({ sessionId, actionId, fromId, toId, summary, diff, servedFromDiffId }) {
  const computedAt = new Date().toISOString();
  const info = stmtInsertDiff.run(sessionId, actionId ?? null, fromId, toId, computedAt, JSON.stringify(summary), JSON.stringify(diff), servedFromDiffId ?? null);
  return { id: Number(info.lastInsertRowid), computedAt, summary, diff, servedFromDiffId: servedFromDiffId ?? null };
}

// Only matches against an ORIGINAL (non-cached) diff - chains of
// cache-serving-a-cache never happen, so cachedFromDiffId always points at
// a diff that genuinely ran computeDiff.
export function findCachedDiff(fromContentHash, toContentHash) {
  if (!fromContentHash || !toContentHash) return null;
  const row = stmtFindDiffByContentHash.get(fromContentHash, toContentHash);
  if (!row) return null;
  return { id: row.id, summary: JSON.parse(row.summary_json), diff: JSON.parse(row.diff_json) };
}

export function getGoldenDiffCacheSavings() {
  const row = db.prepare(
    "SELECT COUNT(*) AS cacheHits, SUM(LENGTH(diff_json)) AS bytesSaved FROM state_diffs WHERE served_from_diff_id IS NOT NULL",
  ).get();
  const bytesSaved = row.bytesSaved || 0;
  return { cacheHits: row.cacheHits || 0, bytesSaved, estTokensSaved: Math.round(bytesSaved / CHARS_PER_TOKEN_ESTIMATE) };
}

export function getDiff(id) {
  const row = stmtGetDiff.get(Number(id));
  if (!row) throw new Error(`no such diff: ${id}`);
  return { ...row, summary: JSON.parse(row.summary_json), diff: JSON.parse(row.diff_json) };
}

export function listDiffs(sessionId) {
  return stmtListDiffs.all(Number(sessionId)).map((r) => ({ ...r, summary: JSON.parse(r.summary_json) }));
}

// ---------- Q&A ----------

const stmtInsertQA = db.prepare(`
  INSERT INTO qa_log (session_id, action_id, question, context_json, answer, error, asked_at, answered_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
const stmtListQA = db.prepare('SELECT * FROM qa_log WHERE session_id = ? ORDER BY id DESC');

export function saveQA({ sessionId, actionId, question, context, answer, error, askedAt, answeredAt }) {
  const info = stmtInsertQA.run(sessionId, actionId ?? null, question, JSON.stringify(context), answer ?? null, error ?? null, askedAt, answeredAt ?? null);
  return Number(info.lastInsertRowid);
}

export function listQA(sessionId) {
  return stmtListQA.all(Number(sessionId)).map((r) => ({ ...r, context: JSON.parse(r.context_json) }));
}

// ---------- console / network capture ----------
//
// High-frequency, batched from the page (see tools/web-scout/inject.js) -
// each flushed batch is inserted inside ONE transaction, never one INSERT
// per entry (DatabaseSync is synchronous; N autocommit inserts back-to-back
// would block the whole event loop, including concurrent /command HTTP
// handling, for the duration of a bursty page's capture). Unlike actions/
// snapshots, these two tables are NOT pruned - same no-pruning convention,
// but a meaningfully higher volume profile; documented in README.

const stmtInsertConsole = db.prepare(`
  INSERT INTO console_entries (session_id, agent_name, level, message, stack, occurred_at)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const stmtListConsole = db.prepare('SELECT * FROM console_entries WHERE session_id = ? ORDER BY id DESC');
const stmtListConsoleLimit = db.prepare('SELECT * FROM console_entries WHERE session_id = ? ORDER BY id DESC LIMIT ?');

export function insertConsoleEntries(sessionId, agentName, entries) {
  db.exec('BEGIN');
  try {
    for (const e of entries) {
      stmtInsertConsole.run(sessionId, agentName ?? 'default', e.level, e.message, e.stack ?? null, e.at);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function listConsoleEntries(sessionId, { limit } = {}) {
  const lim = Number.isFinite(limit) && limit > 0 ? Number(limit) : -1;
  return lim > 0 ? stmtListConsoleLimit.all(Number(sessionId), lim) : stmtListConsole.all(Number(sessionId));
}

const stmtInsertNet = db.prepare(`
  INSERT INTO net_entries (session_id, agent_name, via, method, url, status, error, started_at, ended_at, occurred_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const stmtListNet = db.prepare('SELECT * FROM net_entries WHERE session_id = ? ORDER BY id DESC');
const stmtListNetLimit = db.prepare('SELECT * FROM net_entries WHERE session_id = ? ORDER BY id DESC LIMIT ?');

export function insertNetEntries(sessionId, agentName, entries) {
  db.exec('BEGIN');
  try {
    for (const e of entries) {
      stmtInsertNet.run(sessionId, agentName ?? 'default', e.via, e.method, e.url ?? null, e.status ?? null, e.error ?? null, e.startedAt, e.endedAt, e.endedAt);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function listNetEntries(sessionId, { limit } = {}) {
  const lim = Number.isFinite(limit) && limit > 0 ? Number(limit) : -1;
  return lim > 0 ? stmtListNetLimit.all(Number(sessionId), lim) : stmtListNet.all(Number(sessionId));
}

// ---------- macros (record/replay) ----------
//
// A macro is just a named, saved subset of one session's own already-
// logged actions (see `steps` construction in relay.mjs) - no separate
// recording mechanism, since every dom/idb/eval action is already
// persisted to `actions` the moment it runs.

const stmtInsertMacro = db.prepare('INSERT INTO macros (name, source_session_id, steps_json, created_at, steps_cost_est, compacted_steps_removed) VALUES (?, ?, ?, ?, ?, ?)');
const stmtGetMacro = db.prepare('SELECT * FROM macros WHERE id = ?');
const stmtListMacros = db.prepare('SELECT * FROM macros ORDER BY id DESC');
const stmtDeleteMacro = db.prepare('DELETE FROM macros WHERE id = ?');

function hydrateMacro(row) {
  if (!row) return row;
  return { ...row, steps: JSON.parse(row.steps_json) };
}

// Consecutive identical type+params steps are recording noise (a retried
// click, a double-submit) - a macro replay gains nothing from doing the
// same thing twice in a row, and every step it drops is one less thing
// "macro run"'s pre-replay cost estimate has to count and one less action
// logged (and printed) on every future replay. Only COLLAPSES consecutive
// runs, never reorders/merges non-adjacent steps - a step's position can
// matter (e.g. idb.put then idb.patch aren't safely mergeable in general).
function compactMacroSteps(steps) {
  const compacted = [];
  let removed = 0;
  for (const step of steps) {
    const prev = compacted[compacted.length - 1];
    if (prev && prev.type === step.type && JSON.stringify(prev.params ?? {}) === JSON.stringify(step.params ?? {})) {
      removed += 1;
      continue;
    }
    compacted.push(step);
  }
  return { steps: compacted, removed };
}

// Sums each step's own action type's ALL-TIME historical average
// estTokens/call (getActionCostReport's byType, no session filter) - stamped
// once here at record/update time so "macro list" can show every saved
// macro's cost with zero live query (see relay.mjs's steps_cost_est
// passthrough), instead of a caller having to ask before every "macro run".
// Best-effort: a step type with no prior history contributes 0, never
// blocks saving the macro.
function estimateStepsTokenCost(steps) {
  const report = getActionCostReport();
  const avgByType = new Map(report.byType.map((r) => [r.type, r.calls ? r.estTokens / r.calls : 0]));
  return Math.round(steps.reduce((sum, s) => sum + (avgByType.get(s.type) || 0), 0));
}

export function createMacro({ name, sourceSessionId, steps }) {
  const createdAt = new Date().toISOString();
  const { steps: compacted, removed } = compactMacroSteps(steps);
  const costEst = estimateStepsTokenCost(compacted);
  let info;
  try {
    info = stmtInsertMacro.run(name, sourceSessionId ?? null, JSON.stringify(compacted), createdAt, costEst, removed);
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) throw new Error(`a macro named "${name}" already exists`);
    throw err;
  }
  return hydrateMacro(stmtGetMacro.get(Number(info.lastInsertRowid)));
}

const stmtUpdateMacroSteps = db.prepare('UPDATE macros SET steps_json = ?, steps_cost_est = ?, compacted_steps_removed = ? WHERE id = ?');

export function updateMacroSteps(id, steps) {
  const { steps: compacted, removed } = compactMacroSteps(steps);
  const costEst = estimateStepsTokenCost(compacted);
  const info = stmtUpdateMacroSteps.run(JSON.stringify(compacted), costEst, removed, Number(id));
  if (info.changes === 0) throw new Error(`no such macro: ${id}`);
  return hydrateMacro(stmtGetMacro.get(Number(id)));
}

export function getMacro(id) {
  const row = stmtGetMacro.get(Number(id));
  if (!row) throw new Error(`no such macro: ${id}`);
  return hydrateMacro(row);
}

export function listMacros() {
  return stmtListMacros.all().map(hydrateMacro);
}

export function deleteMacro(id) {
  const info = stmtDeleteMacro.run(Number(id));
  if (info.changes === 0) throw new Error(`no such macro: ${id}`);
  return { deleted: true };
}

// ---------- token savings report ----------
//
// Combines every DB-side waste-prevention mechanism's OWN real, measured
// numbers into one place - "how much did these features actually save",
// not a guess. Deliberately three separate real ledgers, not one fabricated
// composite score (same no-composite-score discipline this project's
// cognitive-layer work already applies elsewhere): result-blob dedup
// (physical storage never duplicated), golden-diff cache (bytes never
// re-included in a repeat diff-golden response), macro compaction (steps
// never replayed/logged again). The relay's same-session readResultCache
// (runtime, in-memory, resets on restart) is a FOURTH real savings source
// this function cannot see - it lives in relay.mjs's own process memory,
// not this DB - so relay.mjs merges its own counter in alongside this at
// the route level; this export only ever reports what SQL can prove.
const stmtMacroCompactionTotal = db.prepare('SELECT COALESCE(SUM(compacted_steps_removed), 0) AS totalRemoved FROM macros');

export function getTokenSavingsReport() {
  const resultDedup = getResultDedupSavings();
  const goldenDiffCache = getGoldenDiffCacheSavings();
  const macroCompaction = { stepsRemoved: stmtMacroCompactionTotal.get().totalRemoved };
  return {
    resultDedup,
    goldenDiffCache,
    macroCompaction,
    totalBytesSaved: resultDedup.bytesSaved + goldenDiffCache.bytesSaved,
    totalEstTokensSaved: resultDedup.estTokensSaved + goldenDiffCache.estTokensSaved,
  };
}

// ---------- Verity UI Relay import ----------
//
// tools/ui-verifier (Verity) has no persistence of its own - a `scenario`
// result JSON is printed to stdout and nowhere else (see its own README).
// This table lets one web-scout session hold both kinds of evidence -
// DOM/IndexedDB truth (this tool) and accessibility-tree truth (Verity) -
// against the same declared goal, instead of two separately-produced
// artifacts a human reconciles by eye. See docs/web-scout-roadmap.md's V6
// entry.

const stmtInsertVerityRun = db.prepare(`
  INSERT INTO verity_runs (session_id, label, passed, step_count, passed_count, failed_count, result_json, imported_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
const stmtListVerityRuns = db.prepare('SELECT id, session_id, label, passed, step_count, passed_count, failed_count, imported_at FROM verity_runs WHERE session_id = ? ORDER BY id DESC');
const stmtGetVerityRun = db.prepare('SELECT * FROM verity_runs WHERE id = ?');

export function importVerityRun({ sessionId, label, result }) {
  const steps = Array.isArray(result?.steps) ? result.steps : [];
  const passedCount = steps.filter((s) => s?.passed).length;
  const failedCount = steps.length - passedCount;
  const importedAt = new Date().toISOString();
  const info = stmtInsertVerityRun.run(
    Number(sessionId), label ?? null,
    result?.passed === undefined ? null : (result.passed ? 1 : 0),
    steps.length, passedCount, failedCount,
    JSON.stringify(result), importedAt,
  );
  return { ...hydrateVerityRun(stmtGetVerityRun.get(Number(info.lastInsertRowid))) };
}

function hydrateVerityRun(row) {
  if (!row) return row;
  return { ...row, passed: row.passed === null ? null : !!row.passed, result: row.result_json ? JSON.parse(row.result_json) : null };
}

export function listVerityRuns(sessionId) {
  return stmtListVerityRuns.all(Number(sessionId)).map((r) => ({ ...r, passed: r.passed === null ? null : !!r.passed }));
}

export function getVerityRun(id) {
  const row = stmtGetVerityRun.get(Number(id));
  if (!row) throw new Error(`no such verity run: ${id}`);
  return hydrateVerityRun(row);
}

const stmtListAllVerityRuns = db.prepare('SELECT id, session_id, label, passed, step_count, passed_count, failed_count, imported_at FROM verity_runs ORDER BY id ASC');

export function listAllVerityRuns() {
  return stmtListAllVerityRuns.all().map((r) => ({ ...r, passed: r.passed === null ? null : !!r.passed }));
}
