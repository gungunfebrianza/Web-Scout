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

// ---------- sessions ----------

const stmtInsertSession = db.prepare('INSERT INTO sessions (goal, context, status, started_at, strict_crv, tags) VALUES (?, ?, ?, ?, ?, ?)');
const stmtGetCurrentSession = db.prepare("SELECT * FROM sessions WHERE status = 'active' LIMIT 1");
const stmtGetSession = db.prepare('SELECT * FROM sessions WHERE id = ?');
const stmtEndSession = db.prepare("UPDATE sessions SET status = 'ended', ended_at = ? WHERE id = ? AND status = 'active'");
const stmtListSessions = db.prepare('SELECT * FROM sessions ORDER BY id DESC');

function hydrateSession(row) {
  if (!row) return row;
  return { ...row, strict_crv: !!row.strict_crv, tags: row.tags ? JSON.parse(row.tags) : [] };
}

export function getCurrentSession() {
  return hydrateSession(stmtGetCurrentSession.get() ?? null);
}

export function startSession({ goal, context, strictCrv, tags }) {
  if (!goal || typeof goal !== 'string' || !goal.trim()) {
    throw new Error('a non-empty goal is required to start a session');
  }
  const existing = getCurrentSession();
  if (existing) {
    throw new Error(`a session is already active (id ${existing.id}: "${existing.goal}") - end it first with "session end", or keep using it`);
  }
  const startedAt = new Date().toISOString();
  const info = stmtInsertSession.run(goal, context ?? null, 'active', startedAt, strictCrv ? 1 : 0, JSON.stringify(tags ?? []));
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
  INSERT INTO actions (session_id, type, params_json, result_json, ok, error, started_at, ended_at, duration_ms, agent_name)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const stmtListActions = db.prepare('SELECT * FROM actions WHERE session_id = ? ORDER BY id DESC');
const stmtListActionsAsc = db.prepare('SELECT * FROM actions WHERE session_id = ? ORDER BY id ASC');
const stmtListActionsLimit = db.prepare('SELECT * FROM actions WHERE session_id = ? ORDER BY id DESC LIMIT ?');
const stmtGetActionById = db.prepare('SELECT * FROM actions WHERE id = ?');

export function logAction({ sessionId, type, params, result, ok, error, startedAt, endedAt, agentName }) {
  const durationMs = new Date(endedAt).getTime() - new Date(startedAt).getTime();
  const info = stmtInsertAction.run(
    sessionId, type,
    params === undefined ? null : JSON.stringify(params),
    result === undefined ? null : JSON.stringify(result),
    ok ? 1 : 0,
    error ?? null,
    startedAt, endedAt, Number.isFinite(durationMs) ? durationMs : 0,
    agentName ?? 'default',
  );
  return Number(info.lastInsertRowid);
}

export function listActions(sessionId, { ascending = false } = {}) {
  const rows = (ascending ? stmtListActionsAsc : stmtListActions).all(Number(sessionId));
  return rows.map((r) => ({
    ...r,
    params: r.params_json ? JSON.parse(r.params_json) : null,
    result: r.result_json ? JSON.parse(r.result_json) : null,
  }));
}

export function getActionById(actionId) {
  const row = stmtGetActionById.get(Number(actionId));
  if (!row) throw new Error(`no such action: ${actionId}`);
  return {
    ...row,
    params: row.params_json ? JSON.parse(row.params_json) : null,
    result: row.result_json ? JSON.parse(row.result_json) : null,
  };
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
    const result = r.result_json ? JSON.parse(r.result_json) : null;
    const redact = HEAVY_ACTION_RESULT_REDACTORS[r.type];
    return {
      ...r,
      params: r.params_json ? JSON.parse(r.params_json) : null,
      result: redact ? redact(result) : result,
    };
  });
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
      actions.push({
        ...r,
        params: r.params_json ? JSON.parse(r.params_json) : null,
        result: r.result_json ? JSON.parse(r.result_json) : null,
      });
    } catch {
      skipped += 1;
    }
  }
  return { actions, skipped };
}

// ---------- state snapshots ----------

const stmtInsertSnapshot = db.prepare(`
  INSERT INTO state_snapshots (session_id, action_id, taken_at, counts_json, stores_json, byte_size, agent_name, golden_name)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
const stmtGetSnapshot = db.prepare('SELECT * FROM state_snapshots WHERE id = ?');
const stmtListSnapshots = db.prepare('SELECT id, session_id, action_id, taken_at, counts_json, byte_size, agent_name, golden_name FROM state_snapshots WHERE session_id = ? ORDER BY id DESC');
const stmtGetGoldenSnapshot = db.prepare('SELECT * FROM state_snapshots WHERE golden_name = ? ORDER BY id DESC LIMIT 1');

export function saveSnapshot({ sessionId, actionId, stores, agentName, goldenName }) {
  const takenAt = new Date().toISOString();
  const counts = {};
  for (const [name, entry] of Object.entries(stores)) counts[name] = entry.rows.length;
  const storesJson = JSON.stringify(stores);
  const info = stmtInsertSnapshot.run(sessionId, actionId ?? null, takenAt, JSON.stringify(counts), storesJson, storesJson.length, agentName ?? 'default', goldenName ?? null);
  return { id: Number(info.lastInsertRowid), takenAt, counts, byteSize: storesJson.length, agentName: agentName ?? 'default', goldenName: goldenName ?? null };
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
  INSERT INTO state_diffs (session_id, action_id, snapshot_from_id, snapshot_to_id, computed_at, summary_json, diff_json)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
const stmtGetDiff = db.prepare('SELECT * FROM state_diffs WHERE id = ?');
const stmtListDiffs = db.prepare('SELECT id, session_id, action_id, snapshot_from_id, snapshot_to_id, computed_at, summary_json FROM state_diffs WHERE session_id = ? ORDER BY id DESC');

export function saveDiff({ sessionId, actionId, fromId, toId, summary, diff }) {
  const computedAt = new Date().toISOString();
  const info = stmtInsertDiff.run(sessionId, actionId ?? null, fromId, toId, computedAt, JSON.stringify(summary), JSON.stringify(diff));
  return { id: Number(info.lastInsertRowid), computedAt, summary, diff };
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

const stmtInsertMacro = db.prepare('INSERT INTO macros (name, source_session_id, steps_json, created_at) VALUES (?, ?, ?, ?)');
const stmtGetMacro = db.prepare('SELECT * FROM macros WHERE id = ?');
const stmtListMacros = db.prepare('SELECT * FROM macros ORDER BY id DESC');
const stmtDeleteMacro = db.prepare('DELETE FROM macros WHERE id = ?');

function hydrateMacro(row) {
  if (!row) return row;
  return { ...row, steps: JSON.parse(row.steps_json) };
}

export function createMacro({ name, sourceSessionId, steps }) {
  const createdAt = new Date().toISOString();
  let info;
  try {
    info = stmtInsertMacro.run(name, sourceSessionId ?? null, JSON.stringify(steps), createdAt);
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) throw new Error(`a macro named "${name}" already exists`);
    throw err;
  }
  return hydrateMacro(stmtGetMacro.get(Number(info.lastInsertRowid)));
}

const stmtUpdateMacroSteps = db.prepare('UPDATE macros SET steps_json = ? WHERE id = ?');

export function updateMacroSteps(id, steps) {
  const info = stmtUpdateMacroSteps.run(JSON.stringify(steps), Number(id));
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
