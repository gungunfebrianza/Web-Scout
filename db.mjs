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
// Content-addressed dedup for actions.params_json (see params_blobs table
// below) - same NULL-means-look-it-up-by-hash convention as result_hash
// above.
ensureColumn('actions', 'params_hash', 'params_hash TEXT');
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
// How many steps templatizeMacroSteps folded into a template entry at
// record/update time (group size minus the one template row that replaces
// it) - 0 for a macro with no near-duplicate run worth templating.
ensureColumn('macros', 'templated_steps_removed', 'templated_steps_removed INTEGER NOT NULL DEFAULT 0');
// Content-addressed dedup for the two highest-volume never-pruned tables -
// see text_blobs below.
ensureColumn('console_entries', 'message_hash', 'message_hash TEXT');
ensureColumn('console_entries', 'stack_hash', 'stack_hash TEXT');
ensureColumn('net_entries', 'url_hash', 'url_hash TEXT');
// Optional response-body preview (see "net capture" / net.setBodyCapture in
// inject.js) - off by default (both columns NULL on every pre-existing and
// most real rows), captured only for entries whose URL matched an
// operator-armed substring filter. Interned via the same text_blobs
// mechanism as url/console message/stack - a repeatedly-polled endpoint's
// body is real, confirmed-live-repeated content (an AI-review round trip
// polled several times while awaiting a result). body_truncated says
// whether NET_BODY_CAPTURE_LIMIT (inject.js) actually cut anything.
ensureColumn('net_entries', 'body_preview_hash', 'body_preview_hash TEXT');
ensureColumn('net_entries', 'body_truncated', 'body_truncated INTEGER');
// Scopes a snapshot to a subset of rows per store (same exact-equality
// semantics as idb.dump's own --where) - metadata only, never affects
// content_hash/dedup (computed off the actual captured stores either way).
// A partial (where-scoped) snapshot proves less than a full one: diff/
// restore against it only ever reflect the filtered subset, never the whole
// store - callers should treat `where` on a snapshot's own result as a flag
// to read the rest of that result more carefully, not silently assume a
// full-store baseline.
ensureColumn('state_snapshots', 'where_json', 'where_json TEXT');
// verity_runs.result_json is NOT NULL, same '' sentinel as console_entries.
// message below - reuses result_blobs (already generic hash->JSON content
// storage, no reason for a THIRD table when the mechanism is identical).
ensureColumn('verity_runs', 'result_hash', 'result_hash TEXT');
// state_diffs.diff_json is NOT NULL - same '' sentinel, reuses result_blobs
// (see saveDiff below). Was the one JSON blob in this whole file with zero
// content-addressing despite the golden-diff CACHE already existing - a
// cache hit still wrote the full diff_json again, every time.
ensureColumn('state_diffs', 'diff_hash', 'diff_hash TEXT');
// Points at the ORIGINAL state_snapshots row whose stores_json (the
// row-hash reference list, not the rows themselves - those already dedup
// via snapshot_rows) this row's own stores_json was byte-identical to. NULL
// for a genuinely fresh/first-seen snapshot content. See saveSnapshot.
ensureColumn('state_snapshots', 'served_from_snapshot_id', 'served_from_snapshot_id INTEGER');

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

// ---------- content-addressed PARAMS storage ----------
//
// result_blobs above dedups actions.result_json; actions.params_json was the
// one asymmetric gap left in that pattern - the very field
// findRepeatedActionLoops/redundancyKey already group calls BY (same type +
// same params = a loop/redundant-call candidate) was still stored as a full
// physical copy on every single row, even for the tight-polling-loop shape
// those detectors exist to find (the same params string, repeated verbatim,
// dozens of times in a row). Same intern-on-write/resolve-on-read/ref_count
// shape as result_blobs, own table since the two are logically distinct
// content domains even though the mechanism is identical.
db.exec(`
CREATE TABLE IF NOT EXISTS params_blobs (
  hash          TEXT PRIMARY KEY,
  json          TEXT NOT NULL,
  byte_length   INTEGER NOT NULL,
  first_seen_at TEXT NOT NULL,
  ref_count     INTEGER NOT NULL DEFAULT 0
);
`);
const stmtGetParamsBlob = db.prepare('SELECT json FROM params_blobs WHERE hash = ?');
const stmtInsertParamsBlob = db.prepare('INSERT INTO params_blobs (hash, json, byte_length, first_seen_at, ref_count) VALUES (?, ?, ?, ?, 1)');
const stmtBumpParamsBlob = db.prepare('UPDATE params_blobs SET ref_count = ref_count + 1 WHERE hash = ?');
const stmtHasParamsBlob = db.prepare('SELECT 1 FROM params_blobs WHERE hash = ?');

function internParams(paramsJson) {
  const hash = crypto.createHash('sha256').update(paramsJson).digest('hex');
  if (stmtHasParamsBlob.get(hash)) {
    stmtBumpParamsBlob.run(hash);
    return { hash, dedup: true };
  }
  stmtInsertParamsBlob.run(hash, paramsJson, paramsJson.length, new Date().toISOString());
  return { hash, dedup: false };
}

function resolveParamsJson(paramsJson, paramsHash) {
  if (paramsJson !== null && paramsJson !== undefined) return paramsJson;
  if (!paramsHash) return null;
  return stmtGetParamsBlob.get(paramsHash)?.json ?? null;
}

// ---------- generic content-addressed TEXT storage ----------
//
// console_entries/net_entries are explicitly NOT pruned (see their own
// section below) and net_entries alone already holds 60K+ real rows - the
// one place in this whole file with meaningful volume and ZERO dedup of any
// kind until now. A noisy page logging the same warning hundreds of times,
// or the same endpoint failing on every poll, pays full message/url bytes
// on every single occurrence. Same intern-on-write/resolve-on-read/
// ref_count shape as result_blobs/params_blobs, generic (plain text, not
// JSON) since a console message or a URL is not itself a JSON value.
db.exec(`
CREATE TABLE IF NOT EXISTS text_blobs (
  hash          TEXT PRIMARY KEY,
  text          TEXT NOT NULL,
  byte_length   INTEGER NOT NULL,
  first_seen_at TEXT NOT NULL,
  ref_count     INTEGER NOT NULL DEFAULT 0
);
`);
const stmtGetTextBlob = db.prepare('SELECT text FROM text_blobs WHERE hash = ?');
const stmtInsertTextBlob = db.prepare('INSERT INTO text_blobs (hash, text, byte_length, first_seen_at, ref_count) VALUES (?, ?, ?, ?, 1)');
const stmtBumpTextBlob = db.prepare('UPDATE text_blobs SET ref_count = ref_count + 1 WHERE hash = ?');
const stmtHasTextBlob = db.prepare('SELECT 1 FROM text_blobs WHERE hash = ?');

function internText(text) {
  const hash = crypto.createHash('sha256').update(text).digest('hex');
  if (stmtHasTextBlob.get(hash)) {
    stmtBumpTextBlob.run(hash);
    return { hash, dedup: true };
  }
  stmtInsertTextBlob.run(hash, text, text.length, new Date().toISOString());
  return { hash, dedup: false };
}

// console_entries.message is NOT NULL (pre-existing schema, real production
// rows) - rebuilding that table just to allow NULL is a needless-risk table
// rewrite against 60K+ live net_entries-scale data, so a deduped message is
// stored as '' (empty string, satisfies NOT NULL) instead of NULL, resolved
// back via the hash exactly like a NULL sentinel would be. A genuinely empty
// console message is not a realistic case (nothing meaningful to log); even
// if it happened, resolving '' as "look it up" still returns the correct
// (also empty) interned text, so there is no real ambiguity.
function resolveTextEmptySentinel(text, hash) {
  if (text !== '') return text;
  if (!hash) return text;
  return stmtGetTextBlob.get(hash)?.text ?? text;
}

// net_entries.url and console_entries.stack are already nullable columns -
// real NULL sentinel, same convention as result_hash/params_hash.
function resolveTextNullSentinel(text, hash) {
  if (text !== null && text !== undefined) return text;
  if (!hash) return null;
  return stmtGetTextBlob.get(hash)?.text ?? null;
}

export function getTextDedupSavings() {
  const row = db.prepare(
    'SELECT COUNT(*) AS uniqueBlobs, SUM(ref_count) AS totalReferences, SUM(byte_length) AS uniqueBytes, SUM((ref_count - 1) * byte_length) AS bytesSaved FROM text_blobs',
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

export function getParamsDedupSavings() {
  const row = db.prepare(
    'SELECT COUNT(*) AS uniqueBlobs, SUM(ref_count) AS totalReferences, SUM(byte_length) AS uniqueBytes, SUM((ref_count - 1) * byte_length) AS bytesSaved FROM params_blobs',
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

// ---------- content-addressed snapshot ROW storage ----------
//
// result_blobs above dedups a whole action result; a snapshot's stores_json
// is its own separate large blob and was still stored FULL on every single
// idb.snapshot, even though most rows in a real store don't change between
// two consecutive snapshots (idb.snapshot is confirmed the #1 all-time cost
// offender even with --since scoping it to changed stores only - the
// UNCHANGED rows inside a "changed" store were still paying full storage
// every time). This interns at ROW granularity instead: each row's own JSON
// is hashed and stored once; a snapshot keeps only an ordered list of row
// hashes per store. Deliberately content-only (no store+key in the hash) -
// two different stores holding byte-identical rows (e.g. two empty-ish
// config rows) legitimately share one physical copy.
db.exec(`
CREATE TABLE IF NOT EXISTS snapshot_rows (
  hash          TEXT PRIMARY KEY,
  json          TEXT NOT NULL,
  byte_length   INTEGER NOT NULL,
  first_seen_at TEXT NOT NULL,
  ref_count     INTEGER NOT NULL DEFAULT 0
);
`);
const stmtGetSnapshotRow = db.prepare('SELECT json FROM snapshot_rows WHERE hash = ?');
const stmtInsertSnapshotRow = db.prepare('INSERT INTO snapshot_rows (hash, json, byte_length, first_seen_at, ref_count) VALUES (?, ?, ?, ?, 1)');
const stmtBumpSnapshotRow = db.prepare('UPDATE snapshot_rows SET ref_count = ref_count + 1 WHERE hash = ?');
const stmtHasSnapshotRow = db.prepare('SELECT 1 FROM snapshot_rows WHERE hash = ?');

function internSnapshotRow(rowJson) {
  const hash = crypto.createHash('sha256').update(rowJson).digest('hex');
  if (stmtHasSnapshotRow.get(hash)) {
    stmtBumpSnapshotRow.run(hash);
    return hash;
  }
  stmtInsertSnapshotRow.run(hash, rowJson, rowJson.length, new Date().toISOString());
  return hash;
}

function resolveSnapshotRow(hash) {
  return stmtGetSnapshotRow.get(hash)?.json ?? 'null';
}

// A pre-migration snapshot's stores_json is still the FULL legacy shape
// ({storeName: {rows:[...]}}) - only a new row's stores_json is the compact
// {storeName: {rowHashes:[...]}} refs shape, distinguished per-store by
// which key is present, same NULL/legacy-fallback discipline as
// resolveResultJson above.
function resolveStores(storesJson) {
  const parsed = JSON.parse(storesJson);
  const stores = {};
  for (const [name, entry] of Object.entries(parsed)) {
    if (entry && Array.isArray(entry.rowHashes)) {
      const rawRows = entry.rowHashes.map((h) => JSON.parse(resolveSnapshotRow(h)));
      stores[name] = { rows: expandColumnDictionary(rawRows, entry.dict || null) };
    } else {
      stores[name] = entry;
    }
  }
  return stores;
}

export function getSnapshotRowDedupSavings() {
  const row = db.prepare(
    'SELECT COUNT(*) AS uniqueRows, SUM(ref_count) AS totalReferences, SUM(byte_length) AS uniqueBytes, SUM((ref_count - 1) * byte_length) AS bytesSaved FROM snapshot_rows',
  ).get();
  const bytesSaved = row.bytesSaved || 0;
  return {
    uniqueRows: row.uniqueRows || 0,
    totalReferences: row.totalReferences || 0,
    uniqueBytes: row.uniqueBytes || 0,
    bytesSaved,
    estTokensSaved: Math.round(bytesSaved / CHARS_PER_TOKEN_ESTIMATE),
  };
}

// ---------- columnar field-dictionary compaction (pre-row-hash pass) ----------
//
// snapshot_rows above dedups a WHOLE row repeating across snapshots/stores -
// it does nothing for a field VALUE repeating across ROWS of the SAME store
// in one single snapshot (e.g. 500 rows all sharing status:'active'), since
// that repetition is present even the FIRST time a store is ever
// snapshotted, before row-hash dedup has a second occurrence to catch. This
// is a pre-pass applied BEFORE internSnapshotRow: any field whose value
// repeats across >= COLUMN_DICT_MIN_REPEATS rows of the same store is
// factored into a small per-store dictionary, and each row keeps only a
// {$dictRef: index} in that field's place - so the interned row's own JSON
// (and its hash) is smaller too, compounding with row-hash dedup instead of
// competing with it.
const COLUMN_DICT_MIN_REPEATS = 2;

function buildColumnDictionary(rows) {
  const valueCounts = new Map(); // field -> Map(JSON value -> count)
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    for (const [k, v] of Object.entries(row)) {
      let m = valueCounts.get(k);
      if (!m) { m = new Map(); valueCounts.set(k, m); }
      const vj = JSON.stringify(v);
      m.set(vj, (m.get(vj) || 0) + 1);
    }
  }
  const candidateFields = new Set(
    [...valueCounts.entries()]
      .filter(([, m]) => [...m.values()].some((c) => c >= COLUMN_DICT_MIN_REPEATS))
      .map(([k]) => k),
  );
  if (!candidateFields.size) return null;
  const dict = {};
  const indexOf = {};
  for (const field of candidateFields) {
    const values = [...valueCounts.get(field).keys()].map((vj) => JSON.parse(vj));
    dict[field] = values;
    indexOf[field] = new Map(values.map((v, i) => [JSON.stringify(v), i]));
  }
  const compactRows = rows.map((row) => {
    if (!row || typeof row !== 'object') return row;
    const out = {};
    for (const [k, v] of Object.entries(row)) {
      out[k] = candidateFields.has(k) ? { $d: indexOf[k].get(JSON.stringify(v)) } : v;
    }
    return out;
  });
  // A {$d:N} reference has real overhead of its own (~7-8 bytes) - a
  // short/low-cardinality repeated value (e.g. a 3-char status enum
  // repeated twice) can end up costing MORE as a reference than it ever did
  // inline. Only apply when the WHOLE store's rows + the one-time
  // dictionary genuinely serialize smaller than the raw rows would have -
  // never a "compaction" that makes storage bigger.
  const rawBytes = JSON.stringify(rows).length;
  const compactBytes = JSON.stringify(compactRows).length + JSON.stringify(dict).length;
  if (compactBytes >= rawBytes) return null;
  return { dict, rows: compactRows };
}

function expandColumnDictionary(rows, dict) {
  if (!dict) return rows;
  return rows.map((row) => {
    if (!row || typeof row !== 'object') return row;
    const out = {};
    for (const [k, v] of Object.entries(row)) {
      out[k] = (v && typeof v === 'object' && v.$d !== undefined) ? dict[k][v.$d] : v;
    }
    return out;
  });
}

db.exec(`
CREATE TABLE IF NOT EXISTS column_dict_savings (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  bytes_saved INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO column_dict_savings (id, bytes_saved) VALUES (1, 0);
`);
const stmtBumpColumnDictSavings = db.prepare('UPDATE column_dict_savings SET bytes_saved = bytes_saved + ? WHERE id = 1');
const stmtGetColumnDictSavings = db.prepare('SELECT bytes_saved FROM column_dict_savings WHERE id = 1');

export function getColumnDictSavings() {
  const bytesSaved = stmtGetColumnDictSavings.get()?.bytes_saved || 0;
  return { bytesSaved, estTokensSaved: Math.round(bytesSaved / CHARS_PER_TOKEN_ESTIMATE) };
}

// The relay's same-session read cache used to count its hits in process
// memory, so every relay restart zeroed the savings shown on the dashboard -
// and `relay restart` now makes restarts routine. Persisted here instead
// (same single-row counter shape as column_dict_savings above).
db.exec(`
CREATE TABLE IF NOT EXISTS read_cache_savings (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  hits        INTEGER NOT NULL DEFAULT 0,
  bytes_saved INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO read_cache_savings (id, hits, bytes_saved) VALUES (1, 0, 0);
`);
const stmtBumpReadCacheSavings = db.prepare('UPDATE read_cache_savings SET hits = hits + 1, bytes_saved = bytes_saved + ? WHERE id = 1');
const stmtGetReadCacheSavings = db.prepare('SELECT hits, bytes_saved FROM read_cache_savings WHERE id = 1');

export function bumpReadCacheSavings(bytes) {
  const n = Math.max(0, Number(bytes) || 0);
  stmtBumpReadCacheSavings.run(n);
  bumpSavingsDaily('readCache', n);
}

export function getReadCacheSavings() {
  const row = stmtGetReadCacheSavings.get();
  const bytesSaved = row?.bytes_saved || 0;
  return { hits: row?.hits || 0, bytesSaved, estTokensSaved: Math.round(bytesSaved / CHARS_PER_TOKEN_ESTIMATE) };
}

// Per-day buckets of the two saving kinds that only exist at runtime - a read
// answered from the relay cache, and a scoped read that returned less than the
// unscoped call would have. Storage-dedup ledgers cannot be bucketed (they are
// derived from ref counts, not events), so the trend covers delivery only.
// `bytes` for 'scopedReads' is bytes NOT delivered; for 'readCache' it is the
// bytes of a hit (still delivered, only the page round trip was skipped).
db.exec(`
CREATE TABLE IF NOT EXISTS savings_daily (
  day   TEXT NOT NULL,
  key   TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, key)
);
`);
const stmtBumpSavingsDaily = db.prepare(`
  INSERT INTO savings_daily (day, key, calls, bytes) VALUES (?, ?, 1, ?)
  ON CONFLICT (day, key) DO UPDATE SET calls = calls + 1, bytes = bytes + excluded.bytes
`);
const stmtSavingsDailyTotal = db.prepare('SELECT COALESCE(SUM(calls), 0) AS calls, COALESCE(SUM(bytes), 0) AS bytes FROM savings_daily WHERE key = ?');
const stmtSavingsDailyRange = db.prepare('SELECT day, key, calls, bytes FROM savings_daily WHERE day >= ? ORDER BY day');
const stmtDeliveredPerDay = db.prepare(`
  SELECT substr(a.started_at, 1, 10) AS day, COUNT(*) AS calls,
         SUM(COALESCE(LENGTH(a.result_json), (SELECT byte_length FROM result_blobs WHERE hash = a.result_hash), 0)) AS bytes
  FROM actions a WHERE a.started_at >= ? GROUP BY day ORDER BY day
`);

export function bumpSavingsDaily(key, bytes) {
  stmtBumpSavingsDaily.run(new Date().toISOString().slice(0, 10), key, Math.max(0, Number(bytes) || 0));
}

export function getScopedReadSavings() {
  const row = stmtSavingsDailyTotal.get('scopedReads');
  return { calls: row.calls, bytesSaved: row.bytes, estTokensSaved: Math.round(row.bytes / CHARS_PER_TOKEN_ESTIMATE) };
}

// Is the read strategy improving? Per day: what callers were actually handed
// (delivered), what scoped reads left out (avoided), and how much of the
// would-have-been total that is. Days with no activity are omitted.
export function getSavingsTrend(days = 14) {
  const since = new Date(Date.now() - (Math.max(1, days) - 1) * 86400000).toISOString().slice(0, 10);
  const byDay = new Map();
  const slot = (day) => {
    if (!byDay.has(day)) byDay.set(day, { day, calls: 0, deliveredBytes: 0, scopedCalls: 0, avoidedBytes: 0, cacheHits: 0, cacheBytes: 0 });
    return byDay.get(day);
  };
  for (const r of stmtDeliveredPerDay.all(`${since}T00:00:00`)) { const s = slot(r.day); s.calls = r.calls; s.deliveredBytes = r.bytes || 0; }
  for (const r of stmtSavingsDailyRange.all(since)) {
    const s = slot(r.day);
    if (r.key === 'scopedReads') { s.scopedCalls = r.calls; s.avoidedBytes = r.bytes; }
    if (r.key === 'readCache') { s.cacheHits = r.calls; s.cacheBytes = r.bytes; }
  }
  return [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1)).map((s) => {
    const wouldHave = s.deliveredBytes + s.avoidedBytes;
    return {
      ...s,
      deliveredTokens: Math.round(s.deliveredBytes / CHARS_PER_TOKEN_ESTIMATE),
      avoidedTokens: Math.round(s.avoidedBytes / CHARS_PER_TOKEN_ESTIMATE),
      avoidedPct: wouldHave ? Math.round((s.avoidedBytes / wouldHave) * 1000) / 10 : 0,
    };
  });
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
  INSERT INTO actions (session_id, type, params_json, params_hash, result_json, result_hash, ok, error, started_at, ended_at, duration_ms, agent_name)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const stmtListActions = db.prepare('SELECT * FROM actions WHERE session_id = ? ORDER BY id DESC');
const stmtListActionsAsc = db.prepare('SELECT * FROM actions WHERE session_id = ? ORDER BY id ASC');
const stmtListActionsLimit = db.prepare('SELECT * FROM actions WHERE session_id = ? ORDER BY id DESC LIMIT ?');
const stmtGetActionById = db.prepare('SELECT * FROM actions WHERE id = ?');

export function logAction({ sessionId, type, params, result, ok, error, startedAt, endedAt, agentName }) {
  const durationMs = new Date(endedAt).getTime() - new Date(startedAt).getTime();
  const resultJson = result === undefined ? null : JSON.stringify(result);
  const paramsJson = params === undefined ? null : JSON.stringify(params);
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
  // Same dedup for params_json (see params_blobs above) - the tight-loop
  // shape (same call, same params, dozens of times) is exactly where this
  // pays off most.
  let storedParamsJson = paramsJson;
  let paramsHash = null;
  if (paramsJson !== null) {
    const interned = internParams(paramsJson);
    paramsHash = interned.hash;
    if (interned.dedup) storedParamsJson = null;
  }
  const info = stmtInsertAction.run(
    sessionId, type,
    storedParamsJson, paramsHash,
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
    const paramsJson = resolveParamsJson(r.params_json, r.params_hash);
    return { ...r, params: paramsJson ? JSON.parse(paramsJson) : null, result: resultJson ? JSON.parse(resultJson) : null };
  });
}

export function getActionById(actionId) {
  const row = stmtGetActionById.get(Number(actionId));
  if (!row) throw new Error(`no such action: ${actionId}`);
  const resultJson = resolveResultJson(row.result_json, row.result_hash);
  const paramsJson = resolveParamsJson(row.params_json, row.params_hash);
  return { ...row, params: paramsJson ? JSON.parse(paramsJson) : null, result: resultJson ? JSON.parse(resultJson) : null };
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
    const paramsJson = resolveParamsJson(r.params_json, r.params_hash);
    const result = resultJson ? JSON.parse(resultJson) : null;
    const redact = HEAVY_ACTION_RESULT_REDACTORS[r.type];
    return {
      ...r,
      params: paramsJson ? JSON.parse(paramsJson) : null,
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
    SUM(LENGTH(COALESCE(a.params_json, pb.json, ''))) AS paramsBytes
  FROM actions a LEFT JOIN result_blobs rb ON a.result_hash = rb.hash
    LEFT JOIN params_blobs pb ON a.params_hash = pb.hash
  WHERE a.session_id = ? GROUP BY a.type ORDER BY resultBytes DESC
`);
const stmtActionCostByTypeAll = db.prepare(`
  SELECT a.type AS type,
    COUNT(*) AS calls,
    SUM(LENGTH(COALESCE(a.result_json, rb.json, ''))) AS resultBytes,
    SUM(LENGTH(COALESCE(a.params_json, pb.json, ''))) AS paramsBytes
  FROM actions a LEFT JOIN result_blobs rb ON a.result_hash = rb.hash
    LEFT JOIN params_blobs pb ON a.params_hash = pb.hash
  GROUP BY a.type ORDER BY resultBytes DESC
`);
// chars/4 - the commonly-cited rough proxy for English/JSON-ish text tokens,
// not a real tokenizer. Good enough to RANK command types against each
// other and spot the outliers; never treat as an exact bill.
export const CHARS_PER_TOKEN_ESTIMATE = 4;

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

// Cheap single-row running total for the ACTIVE session, read after every
// command completes (see relay.mjs's generic response wrapper) so an
// operator sees cumulative cost build up call-by-call instead of only
// discovering the total after the fact via "token-report" - confirmed real
// gap: a 278K-token idb.snapshot surfaced only in a post-hoc audit, well
// after the CRV session that paid for it was already over. Same
// COALESCE(result_json, blob)/chars-per-4 estimate as getActionCostReport,
// just SUMmed with no GROUP BY - one aggregate row, not one per type.
const stmtSessionTokensSoFar = db.prepare(`
  SELECT SUM(LENGTH(COALESCE(a.result_json, rb.json, '')) + LENGTH(COALESCE(a.params_json, pb.json, ''))) AS totalBytes
  FROM actions a LEFT JOIN result_blobs rb ON a.result_hash = rb.hash
    LEFT JOIN params_blobs pb ON a.params_hash = pb.hash
  WHERE a.session_id = ?
`);
export function getSessionTokensSoFar(sessionId) {
  const row = stmtSessionTokensSoFar.get(Number(sessionId));
  return Math.round((row?.totalBytes || 0) / CHARS_PER_TOKEN_ESTIMATE);
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
const stmtActionSequence = db.prepare('SELECT type, params_json, params_hash, started_at FROM actions WHERE session_id = ? ORDER BY id ASC');
const REPEAT_WINDOW_MS = 5000;
const REPEAT_MIN_RUN = 3;

export function findRepeatedActionLoops(sessionId) {
  const rows = stmtActionSequence.all(Number(sessionId));
  const loops = [];
  let run = null;
  const flush = () => { if (run && run.count >= REPEAT_MIN_RUN) loops.push({ type: run.type, params: run.params, count: run.count, firstAt: run.firstAt, lastAt: run.lastAt }); };
  for (const r of rows) {
    // params_hash (when set) IS the identity of the params content - same
    // hash means byte-identical params whether or not this particular row
    // was the one that got deduped, so it's a strictly cheaper AND equally
    // correct loop-detection key than the raw JSON string used to be.
    // Falls back to the raw string only for a pre-migration row with no
    // params_hash yet.
    const key = `${r.type}::${r.params_hash ?? r.params_json ?? ''}`;
    const t = new Date(r.started_at).getTime();
    if (run && run.key === key && Number.isFinite(t) && t - run.lastT <= REPEAT_WINDOW_MS) {
      run.count += 1;
      run.lastT = t;
      run.lastAt = r.started_at;
    } else {
      flush();
      const paramsJson = resolveParamsJson(r.params_json, r.params_hash);
      run = { key, type: r.type, params: paramsJson ? JSON.parse(paramsJson) : null, count: 1, firstAt: r.started_at, lastAt: r.started_at, lastT: t };
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
  "SELECT id, type, params_json, params_hash, result_json, result_hash, started_at FROM actions WHERE session_id = ? AND type IN ('idb.dump','dom.query') ORDER BY id ASC",
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
    // params_json is NULL for a deduped row (see params_blobs) - resolve it
    // first so redundancyKey still sees the real store/selector, not a
    // blank target.
    const paramsJson = resolveParamsJson(r.params_json, r.params_hash);
    const target = redundancyKey(r.type, paramsJson);
    const key = `${r.type}::${target}`;
    // result_hash is already computed once at write time (logAction's
    // internResult) - reuse it directly instead of re-hashing the full
    // result content here. Only a pre-migration row (result_hash NULL,
    // result_json still the full legacy content) falls back to hashing.
    const hash = r.result_hash || hashResultJson(r.result_json);
    const prev = lastByKey.get(key);
    if (prev && prev.hash === hash) {
      redundant.push({ type: r.type, target, actionId: r.id, repeatsActionId: prev.actionId, at: r.started_at });
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
  "SELECT a.type AS type, COALESCE(a.params_json, pb.json) AS params_json, LENGTH(COALESCE(a.result_json, rb.json, '')) AS resultBytes, LENGTH(COALESCE(a.params_json, pb.json, '')) AS paramsBytes FROM actions a LEFT JOIN result_blobs rb ON a.result_hash = rb.hash LEFT JOIN params_blobs pb ON a.params_hash = pb.hash WHERE a.session_id = ? AND a.type IN ('idb.dump','dom.query') ORDER BY a.id ASC",
);
const stmtActionsForTargetCostAll = db.prepare(
  "SELECT a.type AS type, COALESCE(a.params_json, pb.json) AS params_json, LENGTH(COALESCE(a.result_json, rb.json, '')) AS resultBytes, LENGTH(COALESCE(a.params_json, pb.json, '')) AS paramsBytes FROM actions a LEFT JOIN result_blobs rb ON a.result_hash = rb.hash LEFT JOIN params_blobs pb ON a.params_hash = pb.hash WHERE a.type IN ('idb.dump','dom.query') ORDER BY a.id ASC",
);

export function getActionCostByTarget(sessionId) {
  const rows = sessionId !== undefined && sessionId !== null
    ? stmtActionsForTargetCost.all(Number(sessionId))
    : stmtActionsForTargetCostAll.all();
  const byTarget = new Map(); // `${type}::${target}` -> accumulator
  for (const r of rows) {
    // params_json here is already resolved via the pb JOIN above (SQL-side,
    // no need for resolveParamsJson in JS).
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

// ---------- token cost by macro (which CRV phase actually cost what) ----------
//
// getActionCostReport groups by command TYPE across the whole session -
// "idb.snapshot cost 90K tokens total" doesn't say which macro/CRV phase
// those calls belonged to. Every macro-replayed action is logged with
// params.macroId (see the macro replay route) - group on that instead, and
// bucket everything else (ad-hoc, non-macro calls) under macroId: null so
// the totals still foot to getActionCostReport's own totalEstTokens for the
// same session.
const stmtActionsForMacroCost = db.prepare(
  "SELECT COALESCE(a.params_json, pb.json) AS params_json, LENGTH(COALESCE(a.result_json, rb.json, '')) AS resultBytes, LENGTH(COALESCE(a.params_json, pb.json, '')) AS paramsBytes FROM actions a LEFT JOIN result_blobs rb ON a.result_hash = rb.hash LEFT JOIN params_blobs pb ON a.params_hash = pb.hash WHERE a.session_id = ? ORDER BY a.id ASC",
);

export function getActionCostByMacro(sessionId) {
  const rows = stmtActionsForMacroCost.all(Number(sessionId));
  const byMacro = new Map(); // macroId (or null) -> accumulator
  for (const r of rows) {
    let macroId = null;
    if (r.params_json) {
      try { macroId = JSON.parse(r.params_json)?.macroId ?? null; } catch { /* leave as null */ }
    }
    const cur = byMacro.get(macroId) || { macroId, calls: 0, resultBytes: 0, paramsBytes: 0 };
    cur.calls += 1;
    cur.resultBytes += r.resultBytes;
    cur.paramsBytes += r.paramsBytes;
    byMacro.set(macroId, cur);
  }
  return [...byMacro.values()]
    .map((r) => {
      const macro = r.macroId !== null ? stmtGetMacro.get(Number(r.macroId)) : null;
      return {
        macroId: r.macroId,
        macroName: macro ? macro.name : r.macroId === null ? '(ad-hoc, not part of a macro replay)' : `(deleted macro #${r.macroId})`,
        calls: r.calls,
        estTokens: Math.round((r.resultBytes + r.paramsBytes) / CHARS_PER_TOKEN_ESTIMATE),
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
  SELECT s.id AS sessionId, s.goal AS goal, s.tags AS tagsJson, s.started_at AS startedAt, s.token_budget AS tokenBudget,
    SUM(LENGTH(COALESCE(a.result_json, rb.json, '')) + LENGTH(COALESCE(a.params_json, pb.json, ''))) AS totalBytes
  FROM sessions s LEFT JOIN actions a ON a.session_id = s.id LEFT JOIN result_blobs rb ON a.result_hash = rb.hash
    LEFT JOIN params_blobs pb ON a.params_hash = pb.hash
  GROUP BY s.id ORDER BY s.id ASC
`);

export function getSessionTokenTotals() {
  return stmtSessionTokenTotals.all().map((r) => ({
    sessionId: r.sessionId,
    goal: r.goal,
    tags: r.tagsJson ? JSON.parse(r.tagsJson) : [],
    startedAt: r.startedAt,
    tokenBudget: r.tokenBudget ?? null,
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
//
// Applies the same HEAVY_ACTION_RESULT_REDACTORS as listActionsSummary -
// Friction Analytics (this function's only caller, via GET /analytics) only
// ever reasons about type/timing/loop patterns across EVERY session, never
// result content, so shipping dom.screenshot dataUrls / idb.snapshot store
// dumps / net.log entries here (previously: every one of them, cross-session,
// unredacted - confirmed the one dedicated table-wide fetch with zero
// redaction anywhere in the codebase) was pure waste with no consumer.
export function listAllActions() {
  const rows = stmtListAllActions.all();
  const actions = [];
  let skipped = 0;
  for (const r of rows) {
    try {
      const resultJson = resolveResultJson(r.result_json, r.result_hash);
      const paramsJson = resolveParamsJson(r.params_json, r.params_hash);
      const result = resultJson ? JSON.parse(resultJson) : null;
      const redact = HEAVY_ACTION_RESULT_REDACTORS[r.type];
      actions.push({
        ...r,
        params: paramsJson ? JSON.parse(paramsJson) : null,
        result: redact ? redact(result) : result,
      });
    } catch {
      skipped += 1;
    }
  }
  return { actions, skipped };
}

// ---------- state snapshots ----------

const stmtInsertSnapshot = db.prepare(`
  INSERT INTO state_snapshots (session_id, action_id, taken_at, counts_json, stores_json, byte_size, agent_name, golden_name, content_hash, served_from_snapshot_id, where_json)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const stmtGetSnapshot = db.prepare('SELECT * FROM state_snapshots WHERE id = ?');
const stmtListSnapshots = db.prepare('SELECT id, session_id, action_id, taken_at, counts_json, byte_size, agent_name, golden_name FROM state_snapshots WHERE session_id = ? ORDER BY id DESC');
const stmtGetGoldenSnapshot = db.prepare('SELECT * FROM state_snapshots WHERE golden_name = ? ORDER BY id DESC LIMIT 1');
// Cross-session by design, same as findCachedDiff below - the exact same
// live-tab state re-snapshotted (a pre/post pair around a no-op action, a
// stability-confirming poll) is a real, observed shape, not hypothetical.
// Only matches an ORIGINAL (served_from_snapshot_id IS NULL) row, same
// no-chaining discipline as findCachedDiff.
const stmtFindSnapshotByContentHash = db.prepare(
  'SELECT id, stores_json FROM state_snapshots WHERE content_hash = ? AND served_from_snapshot_id IS NULL ORDER BY id DESC LIMIT 1',
);

export function saveSnapshot({ sessionId, actionId, stores, agentName, goldenName, where }) {
  const takenAt = new Date().toISOString();
  const whereJson = where && typeof where === 'object' ? JSON.stringify(where) : null;
  // Content hash is computed off the LOGICAL content (what a caller actually
  // receives) BEFORE any interning work happens - two snapshots taken from
  // identical store content must hash identically regardless of which rows
  // happened to already be interned, or findCachedDiff below would silently
  // stop matching real repeats.
  const logicalStoresJson = JSON.stringify(stores);
  const contentHash = crypto.createHash('sha256').update(logicalStoresJson).digest('hex');
  const counts = {};
  for (const [name, entry] of Object.entries(stores)) counts[name] = Array.isArray(entry?.rows) ? entry.rows.length : 0;

  // Snapshot-level dedup (see stmtFindSnapshotByContentHash above): the
  // row-hash REFERENCE LIST (stores_json) is its own real storage cost -
  // confirmed live at ~20KB/snapshot average - separate from the rows it
  // points to (already deduped via snapshot_rows). An exact content repeat
  // skips rebuilding that list entirely (no internSnapshotRow/column-dict
  // work either - nothing new to intern when nothing changed).
  const existing = stmtFindSnapshotByContentHash.get(contentHash);
  if (existing) {
    const info = stmtInsertSnapshot.run(sessionId, actionId ?? null, takenAt, JSON.stringify(counts), '', logicalStoresJson.length, agentName ?? 'default', goldenName ?? null, contentHash, existing.id, whereJson);
    return { id: Number(info.lastInsertRowid), takenAt, counts, byteSize: logicalStoresJson.length, agentName: agentName ?? 'default', goldenName: goldenName ?? null, contentHash, ...(where ? { where } : {}) };
  }

  const refs = {};
  let columnDictBytesSaved = 0;
  for (const [name, entry] of Object.entries(stores)) {
    const rows = Array.isArray(entry?.rows) ? entry.rows : [];
    const colDict = buildColumnDictionary(rows);
    const rowsForStorage = colDict ? colDict.rows : rows;
    if (colDict) columnDictBytesSaved += JSON.stringify(rows).length - JSON.stringify(rowsForStorage).length;
    refs[name] = { rowHashes: rowsForStorage.map((row) => internSnapshotRow(JSON.stringify(row))) };
    if (colDict) refs[name].dict = colDict.dict;
  }
  if (columnDictBytesSaved > 0) stmtBumpColumnDictSavings.run(columnDictBytesSaved);
  const refsJson = JSON.stringify(refs);
  // byte_size stays the LOGICAL size too (same discipline as the
  // COALESCE(result_json, blob) reads elsewhere) - a snapshot's reported
  // size never shrinks just because this run happened to dedup well.
  const info = stmtInsertSnapshot.run(sessionId, actionId ?? null, takenAt, JSON.stringify(counts), refsJson, logicalStoresJson.length, agentName ?? 'default', goldenName ?? null, contentHash, null, whereJson);
  return { id: Number(info.lastInsertRowid), takenAt, counts, byteSize: logicalStoresJson.length, agentName: agentName ?? 'default', goldenName: goldenName ?? null, contentHash, ...(where ? { where } : {}) };
}

// Read-side counterpart to the snapshot-level dedup above - a row whose own
// stores_json is '' (served_from_snapshot_id set) fetches the ORIGINAL
// row's stores_json instead. Named distinctly from resolveSnapshotRow above
// (that one resolves a single ROW by hash; this resolves a whole
// SNAPSHOT's reference list by pointer) - different granularity, easy to
// confuse otherwise.
function resolveSnapshotStoresJson(row) {
  if (row.stores_json !== '' || !row.served_from_snapshot_id) return row.stores_json;
  return stmtGetSnapshot.get(row.served_from_snapshot_id)?.stores_json ?? row.stores_json;
}

export function getSnapshot(id) {
  const row = stmtGetSnapshot.get(Number(id));
  if (!row) throw new Error(`no such snapshot: ${id}`);
  return { ...row, counts: JSON.parse(row.counts_json), stores: resolveStores(resolveSnapshotStoresJson(row)), where: row.where_json ? JSON.parse(row.where_json) : undefined };
}

export function listSnapshots(sessionId) {
  return stmtListSnapshots.all(Number(sessionId)).map((r) => ({ ...r, counts: JSON.parse(r.counts_json) }));
}

// Latest-tagged-wins lookup - a golden snapshot is identified by name, not
// id, so callers never need to remember/relay an id across sessions.
export function getGoldenSnapshot(name) {
  const row = stmtGetGoldenSnapshot.get(name);
  if (!row) throw new Error(`no such golden snapshot: ${name}`);
  return { ...row, counts: JSON.parse(row.counts_json), stores: resolveStores(resolveSnapshotStoresJson(row)), where: row.where_json ? JSON.parse(row.where_json) : undefined };
}

export function getSnapshotDedupSavings() {
  const row = db.prepare(`
    SELECT COUNT(*) AS dedupedCount, SUM(LENGTH(orig.stores_json)) AS bytesSaved
    FROM state_snapshots sd JOIN state_snapshots orig ON sd.served_from_snapshot_id = orig.id
  `).get();
  const bytesSaved = row.bytesSaved || 0;
  return { dedupedCount: row.dedupedCount || 0, bytesSaved, estTokensSaved: Math.round(bytesSaved / CHARS_PER_TOKEN_ESTIMATE) };
}

// ---------- state diffs ----------

const stmtInsertDiff = db.prepare(`
  INSERT INTO state_diffs (session_id, action_id, snapshot_from_id, snapshot_to_id, computed_at, summary_json, diff_json, diff_hash, served_from_diff_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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

// Read-side counterpart to internResult's '' sentinel (diff_json is NOT
// NULL, same convention as resolveVerityResultJson/resolveTextEmptySentinel
// elsewhere in this file).
function resolveDiffJson(diffJson, diffHash) {
  if (diffJson) return diffJson;
  if (!diffHash) return diffJson;
  return stmtGetResultBlob.get(diffHash)?.json ?? diffJson;
}

export function saveDiff({ sessionId, actionId, fromId, toId, summary, diff, servedFromDiffId }) {
  const computedAt = new Date().toISOString();
  const diffJson = JSON.stringify(diff);
  // Content-addressed dedup (see result_blobs above, reused here - a diff
  // blob is just JSON content like an action result, no reason for a
  // separate table) - a cache-served diff (servedFromDiffId set) is
  // BYTE-IDENTICAL to the diff it was served from by construction, so this
  // always dedups on a real cache hit; it can also dedup two UNRELATED
  // diffs that happen to produce the same output (e.g. both report {} for
  // a no-op), which is fine and harmless, same content-only discipline as
  // snapshot_rows.
  const interned = internResult(diffJson);
  const storedDiffJson = interned.dedup ? '' : diffJson;
  const info = stmtInsertDiff.run(sessionId, actionId ?? null, fromId, toId, computedAt, JSON.stringify(summary), storedDiffJson, interned.hash, servedFromDiffId ?? null);
  return { id: Number(info.lastInsertRowid), computedAt, summary, diff, servedFromDiffId: servedFromDiffId ?? null };
}

// Only matches against an ORIGINAL (non-cached) diff - chains of
// cache-serving-a-cache never happen, so cachedFromDiffId always points at
// a diff that genuinely ran computeDiff.
export function findCachedDiff(fromContentHash, toContentHash) {
  if (!fromContentHash || !toContentHash) return null;
  const row = stmtFindDiffByContentHash.get(fromContentHash, toContentHash);
  if (!row) return null;
  return { id: row.id, summary: JSON.parse(row.summary_json), diff: JSON.parse(resolveDiffJson(row.diff_json, row.diff_hash)) };
}

// bytesSaved now reflects what's REALLY not physically re-stored on a cache
// hit (the interned blob's own byte_length, via result_blobs - see saveDiff
// above), not the diff_json column's own length (which is '' for every
// deduped row post-fix, and previously - before diff-content-addressing
// existed - was always the full duplicated size, i.e. this ledger used to
// report a byte count that was never actually saved on disk).
export function getGoldenDiffCacheSavings() {
  const row = db.prepare(`
    SELECT COUNT(*) AS cacheHits, SUM(LENGTH(rb.json)) AS bytesSaved
    FROM state_diffs sd JOIN result_blobs rb ON sd.diff_hash = rb.hash
    WHERE sd.served_from_diff_id IS NOT NULL
  `).get();
  const bytesSaved = row.bytesSaved || 0;
  return { cacheHits: row.cacheHits || 0, bytesSaved, estTokensSaved: Math.round(bytesSaved / CHARS_PER_TOKEN_ESTIMATE) };
}

export function getDiff(id) {
  const row = stmtGetDiff.get(Number(id));
  if (!row) throw new Error(`no such diff: ${id}`);
  return { ...row, summary: JSON.parse(row.summary_json), diff: JSON.parse(resolveDiffJson(row.diff_json, row.diff_hash)) };
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
  INSERT INTO console_entries (session_id, agent_name, level, message, message_hash, stack, stack_hash, occurred_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
const stmtListConsole = db.prepare('SELECT * FROM console_entries WHERE session_id = ? ORDER BY id DESC');
const stmtListConsoleLimit = db.prepare('SELECT * FROM console_entries WHERE session_id = ? ORDER BY id DESC LIMIT ?');

function hydrateConsoleEntry(r) {
  return {
    ...r,
    message: resolveTextEmptySentinel(r.message, r.message_hash),
    stack: resolveTextNullSentinel(r.stack, r.stack_hash),
  };
}

export function insertConsoleEntries(sessionId, agentName, entries) {
  db.exec('BEGIN');
  try {
    for (const e of entries) {
      // Content-addressed dedup (see text_blobs above) - a page logging the
      // same warning/error message repeatedly stores it physically once.
      const msgInterned = internText(e.message ?? '');
      const storedMessage = msgInterned.dedup ? '' : (e.message ?? '');
      let storedStack = e.stack ?? null;
      let stackHash = null;
      if (e.stack) {
        const stackInterned = internText(e.stack);
        stackHash = stackInterned.hash;
        if (stackInterned.dedup) storedStack = null;
      }
      stmtInsertConsole.run(sessionId, agentName ?? 'default', e.level, storedMessage, msgInterned.hash, storedStack, stackHash, e.at);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function listConsoleEntries(sessionId, { limit } = {}) {
  const lim = Number.isFinite(limit) && limit > 0 ? Number(limit) : -1;
  const rows = lim > 0 ? stmtListConsoleLimit.all(Number(sessionId), lim) : stmtListConsole.all(Number(sessionId));
  return rows.map(hydrateConsoleEntry);
}

const stmtInsertNet = db.prepare(`
  INSERT INTO net_entries (session_id, agent_name, via, method, url, url_hash, status, error, started_at, ended_at, occurred_at, body_preview_hash, body_truncated)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const stmtListNet = db.prepare('SELECT * FROM net_entries WHERE session_id = ? ORDER BY id DESC');
const stmtListNetLimit = db.prepare('SELECT * FROM net_entries WHERE session_id = ? ORDER BY id DESC LIMIT ?');

function hydrateNetEntry(r) {
  return {
    ...r,
    url: resolveTextNullSentinel(r.url, r.url_hash),
    bodyPreview: r.body_preview_hash ? (stmtGetTextBlob.get(r.body_preview_hash)?.text ?? null) : null,
    bodyTruncated: !!r.body_truncated,
  };
}

export function insertNetEntries(sessionId, agentName, entries) {
  db.exec('BEGIN');
  try {
    for (const e of entries) {
      // Content-addressed dedup (see text_blobs above) - the same endpoint
      // hit repeatedly (a polling loop, a retried failing call) stores its
      // URL physically once across all 60K+ rows this table already holds.
      let storedUrl = e.url ?? null;
      let urlHash = null;
      if (e.url) {
        const urlInterned = internText(e.url);
        urlHash = urlInterned.hash;
        if (urlInterned.dedup) storedUrl = null;
      }
      // bodyPreview only ever present when net.setBodyCapture was armed for
      // a matching URL substring (see inject.js) - interned the same way,
      // since a polled endpoint's body during a wait loop is real repeated
      // content, not a one-off.
      let bodyPreviewHash = null;
      if (typeof e.bodyPreview === 'string') {
        bodyPreviewHash = internText(e.bodyPreview).hash;
      }
      stmtInsertNet.run(sessionId, agentName ?? 'default', e.via, e.method, storedUrl, urlHash, e.status ?? null, e.error ?? null, e.startedAt, e.endedAt, e.endedAt, bodyPreviewHash, e.bodyTruncated ? 1 : 0);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function listNetEntries(sessionId, { limit } = {}) {
  const lim = Number.isFinite(limit) && limit > 0 ? Number(limit) : -1;
  const rows = lim > 0 ? stmtListNetLimit.all(Number(sessionId), lim) : stmtListNet.all(Number(sessionId));
  return rows.map(hydrateNetEntry);
}

// ---------- macros (record/replay) ----------
//
// A macro is just a named, saved subset of one session's own already-
// logged actions (see `steps` construction in relay.mjs) - no separate
// recording mechanism, since every dom/idb/eval action is already
// persisted to `actions` the moment it runs.

const stmtInsertMacro = db.prepare('INSERT INTO macros (name, source_session_id, steps_json, created_at, steps_cost_est, compacted_steps_removed, templated_steps_removed) VALUES (?, ?, ?, ?, ?, ?, ?)');
const stmtGetMacro = db.prepare('SELECT * FROM macros WHERE id = ?');
const stmtListMacros = db.prepare('SELECT * FROM macros ORDER BY id DESC');
const stmtDeleteMacro = db.prepare('DELETE FROM macros WHERE id = ?');

// ---------- content-addressed macro STEP storage ----------
//
// Many macros recorded from different sessions share an identical prefix
// (navigate-to-page, log-in) - each macro previously stored that step's
// full {type,params} JSON in its own steps_json, once per macro. Same
// content-addressing shape as result_blobs/snapshot_rows above, applied one
// level down: a macro's steps_json becomes an ordered array of step-content
// hashes; the actual {type,params} JSON is stored once here regardless of
// how many macros (or how many times within one macro, post-compaction)
// reference it.
db.exec(`
CREATE TABLE IF NOT EXISTS step_blobs (
  hash          TEXT PRIMARY KEY,
  json          TEXT NOT NULL,
  byte_length   INTEGER NOT NULL,
  first_seen_at TEXT NOT NULL,
  ref_count     INTEGER NOT NULL DEFAULT 0
);
`);
const stmtGetStepBlob = db.prepare('SELECT json FROM step_blobs WHERE hash = ?');
const stmtInsertStepBlob = db.prepare('INSERT INTO step_blobs (hash, json, byte_length, first_seen_at, ref_count) VALUES (?, ?, ?, ?, 1)');
const stmtBumpStepBlob = db.prepare('UPDATE step_blobs SET ref_count = ref_count + 1 WHERE hash = ?');
const stmtHasStepBlob = db.prepare('SELECT 1 FROM step_blobs WHERE hash = ?');

function internStep(step) {
  const stepJson = JSON.stringify(step);
  const hash = crypto.createHash('sha256').update(stepJson).digest('hex');
  if (stmtHasStepBlob.get(hash)) {
    stmtBumpStepBlob.run(hash);
  } else {
    stmtInsertStepBlob.run(hash, stepJson, stepJson.length, new Date().toISOString());
  }
  return hash;
}

export function getStepBlobDedupSavings() {
  const row = db.prepare(
    'SELECT COUNT(*) AS uniqueSteps, SUM(ref_count) AS totalReferences, SUM(byte_length) AS uniqueBytes, SUM((ref_count - 1) * byte_length) AS bytesSaved FROM step_blobs',
  ).get();
  const bytesSaved = row.bytesSaved || 0;
  return {
    uniqueSteps: row.uniqueSteps || 0,
    totalReferences: row.totalReferences || 0,
    uniqueBytes: row.uniqueBytes || 0,
    bytesSaved,
    estTokensSaved: Math.round(bytesSaved / CHARS_PER_TOKEN_ESTIMATE),
  };
}

// A pre-migration macro's steps_json is still the full legacy array of
// {type,params} objects; a new row's steps_json is an array of step-content
// hashes (plain strings) - discriminated by the first element's type, same
// legacy-fallback discipline as resolveStores above. expandTemplateSteps
// (below) is applied unconditionally on every read, so templating is
// invisible to every caller (relay routes, cli.mjs, tests) - macro.steps
// always looks like the full, concrete, replayable step list; only the
// on-disk storage/step-blob volume is smaller.
function hydrateMacro(row) {
  if (!row) return row;
  const parsed = JSON.parse(row.steps_json);
  const stored = parsed.length && typeof parsed[0] === 'string'
    ? parsed.map((hash) => JSON.parse(stmtGetStepBlob.get(hash)?.json ?? 'null'))
    : parsed;
  return { ...row, steps: expandTemplateSteps(stored) };
}

// ---------- macro step templating (near-duplicate steps) ----------
//
// compactMacroSteps below only removes EXACT consecutive duplicates - a
// fixture-seeding macro (10 idb.put calls differing only by row.id/name)
// gets zero benefit from that, since every step differs by at least one
// value. This groups a run of consecutive same-type, same-param-KEY-shape
// steps into one template entry ({template:true, type, paramsTemplate,
// varyingKeys, values}) once the group is large enough to be worth it -
// expandTemplateSteps reconstructs the original concrete steps from it on
// every read (see hydrateMacro above), so replay behavior is unchanged;
// only the stored/interned step volume shrinks.
const TEMPLATE_MIN_GROUP_SIZE = 3;

function paramShapeKey(step) {
  return `${step.type}|${Object.keys(step.params ?? {}).sort().join(',')}`;
}

export function templatizeMacroSteps(steps) {
  const groups = [];
  let current = null;
  for (const step of steps) {
    const shapeKey = paramShapeKey(step);
    if (current && current.shapeKey === shapeKey) {
      current.items.push(step);
    } else {
      current = { shapeKey, type: step.type, items: [step] };
      groups.push(current);
    }
  }
  const out = [];
  let templated = 0;
  for (const g of groups) {
    if (g.items.length < TEMPLATE_MIN_GROUP_SIZE) {
      out.push(...g.items);
      continue;
    }
    const paramKeys = Object.keys(g.items[0].params ?? {});
    const varyingKeys = paramKeys.filter((k) => {
      const firstJson = JSON.stringify(g.items[0].params?.[k]);
      return g.items.some((it) => JSON.stringify(it.params?.[k]) !== firstJson);
    });
    if (!varyingKeys.length) {
      // Every step in the group is byte-identical - compactMacroSteps
      // already collapses exact consecutive dupes; leave alone rather than
      // build a degenerate zero-variable template.
      out.push(...g.items);
      continue;
    }
    const paramsTemplate = { ...g.items[0].params };
    for (const k of varyingKeys) paramsTemplate[k] = { $var: k };
    out.push({
      template: true,
      type: g.type,
      paramsTemplate,
      varyingKeys,
      values: g.items.map((it) => varyingKeys.map((k) => it.params?.[k])),
    });
    templated += g.items.length - 1; // steps folded into this one template entry
  }
  return { steps: out, templated };
}

// Read-side counterpart - expands every template entry back into its
// original concrete {type,params} steps, in order; a non-template step
// passes through unchanged (also makes this safe to call on an
// already-expanded/legacy steps array, which has no template entries at
// all).
export function expandTemplateSteps(steps) {
  const out = [];
  for (const step of steps) {
    if (!step || !step.template) { out.push(step); continue; }
    for (const values of step.values) {
      const params = { ...step.paramsTemplate };
      step.varyingKeys.forEach((k, i) => { params[k] = values[i]; });
      out.push({ type: step.type, params });
    }
  }
  return out;
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
  // Cost estimate is summed over the real (expanded) replay step count -
  // templating changes storage shape only, never which/how-many steps
  // actually dispatch, so it must be computed off `compacted`, not the
  // post-template list.
  const costEst = estimateStepsTokenCost(compacted);
  const { steps: templatized, templated } = templatizeMacroSteps(compacted);
  const stepHashes = templatized.map(internStep);
  let info;
  try {
    info = stmtInsertMacro.run(name, sourceSessionId ?? null, JSON.stringify(stepHashes), createdAt, costEst, removed, templated);
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) throw new Error(`a macro named "${name}" already exists`);
    throw err;
  }
  return hydrateMacro(stmtGetMacro.get(Number(info.lastInsertRowid)));
}

const stmtUpdateMacroSteps = db.prepare('UPDATE macros SET steps_json = ?, steps_cost_est = ?, compacted_steps_removed = ?, templated_steps_removed = ? WHERE id = ?');

export function updateMacroSteps(id, steps) {
  const { steps: compacted, removed } = compactMacroSteps(steps);
  const costEst = estimateStepsTokenCost(compacted);
  const { steps: templatized, templated } = templatizeMacroSteps(compacted);
  const stepHashes = templatized.map(internStep);
  const info = stmtUpdateMacroSteps.run(JSON.stringify(stepHashes), costEst, removed, templated, Number(id));
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
const stmtMacroTemplatingTotal = db.prepare('SELECT COALESCE(SUM(templated_steps_removed), 0) AS totalRemoved FROM macros');

// What each ledger actually measures matters more than the totals. Every
// DB-side ledger below counts bytes that were NOT PHYSICALLY STORED a second
// time on disk ("storage") - none of them shrinks what a calling agent reads
// off stdout, which is what getActionCostReport ranks. Dividing those bytes by
// 4 gives a token-EQUIVALENT (what the same text would cost as tokens), not
// tokens an agent avoided. Kinds:
//   storage   - bytes never stored twice in webscout.db
//   delivery  - bytes never sent back to the caller
//   roundtrip - a page round trip and an action-log row skipped, but the
//               result is still delivered to the caller in full
//   workflow  - steps that never get replayed (a count, no byte figure)
// `countedInTotal:false` rows are shown but excluded from the totals - either
// they overlap a counted row (goldenDiffCache) or have no byte figure.
function buildSavingsLedgers({ resultDedup, paramsDedup, textDedup, goldenDiffCache, macroCompaction, macroTemplating, snapshotRowDedup, snapshotDedup, stepBlobDedup, columnDictCompaction }) {
  const bytesLedger = (key, label, kind, what, data, { uniqueBytes, refs } = {}) => {
    const logicalBytes = uniqueBytes === undefined ? null : uniqueBytes + data.bytesSaved;
    return {
      key, label, kind, what, countedInTotal: true,
      bytesSaved: data.bytesSaved, estTokensSaved: data.estTokensSaved,
      uniqueBytes: uniqueBytes ?? null, logicalBytes,
      reductionPct: logicalBytes ? Math.round((data.bytesSaved / logicalBytes) * 1000) / 10 : null,
      refs: refs ?? null,
    };
  };
  return [
    bytesLedger('resultDedup', 'Action results', 'storage', 'An identical reply (a repeated idb.dump / dom.query / eval result) is stored once and ref-counted.', resultDedup, { uniqueBytes: resultDedup.uniqueBytes, refs: { unique: resultDedup.uniqueBlobs, total: resultDedup.totalReferences, unit: 'results' } }),
    bytesLedger('textDedup', 'Console / network text', 'storage', 'Repeated console messages and network URLs are stored once.', textDedup, { uniqueBytes: textDedup.uniqueBytes, refs: { unique: textDedup.uniqueBlobs, total: textDedup.totalReferences, unit: 'strings' } }),
    bytesLedger('snapshotRowDedup', 'Snapshot rows', 'storage', 'Each IndexedDB row is stored once, however many snapshots contain an unchanged copy.', snapshotRowDedup, { uniqueBytes: snapshotRowDedup.uniqueBytes, refs: { unique: snapshotRowDedup.uniqueRows, total: snapshotRowDedup.totalReferences, unit: 'rows' } }),
    bytesLedger('snapshotDedup', 'Whole snapshots', 'storage', 'A snapshot byte-identical to an earlier one points at it instead of copying it.', snapshotDedup, { refs: { unique: null, total: snapshotDedup.dedupedCount, unit: 'snapshots' } }),
    bytesLedger('paramsDedup', 'Command params', 'storage', 'Repeated command params (a poll loop sends the same ones dozens of times) are stored once.', paramsDedup, { uniqueBytes: paramsDedup.uniqueBytes, refs: { unique: paramsDedup.uniqueBlobs, total: paramsDedup.totalReferences, unit: 'param sets' } }),
    bytesLedger('stepBlobDedup', 'Macro steps', 'storage', 'A step shared by several macros is stored once.', stepBlobDedup, { uniqueBytes: stepBlobDedup.uniqueBytes, refs: { unique: stepBlobDedup.uniqueSteps, total: stepBlobDedup.totalReferences, unit: 'steps' } }),
    bytesLedger('columnDictCompaction', 'Column names', 'storage', 'Column names repeated across every row of a dump are stored in a dictionary.', columnDictCompaction),
    {
      key: 'goldenDiffCache', label: 'Golden-diff cache', kind: 'delivery', countedInTotal: false,
      what: 'A repeat diff-golden between content-identical snapshots is answered with a pointer, not the whole diff body again.',
      bytesSaved: goldenDiffCache.bytesSaved, estTokensSaved: goldenDiffCache.estTokensSaved, uniqueBytes: null, logicalBytes: null, reductionPct: null,
      refs: { unique: null, total: goldenDiffCache.cacheHits, unit: 'cache hits' },
      excludedBecause: 'its bytes are the same blobs Action results already counts - shown, not added, to avoid counting them twice',
    },
    {
      key: 'macroCompaction', label: 'Macro compaction', 'kind': 'workflow', countedInTotal: false,
      what: 'Consecutive duplicate steps (a retried click, a double submit) are dropped when a macro is recorded, so they are never replayed.',
      bytesSaved: 0, estTokensSaved: 0, uniqueBytes: null, logicalBytes: null, reductionPct: null,
      refs: { unique: null, total: macroCompaction.stepsRemoved, unit: 'steps removed' },
      excludedBecause: 'counts steps, not bytes',
    },
    {
      key: 'macroTemplating', label: 'Macro templating', kind: 'workflow', countedInTotal: false,
      what: 'Steps that differ only by a value are stored once as a template.',
      bytesSaved: 0, estTokensSaved: 0, uniqueBytes: null, logicalBytes: null, reductionPct: null,
      refs: { unique: null, total: macroTemplating.stepsRemoved, unit: 'steps removed' },
      excludedBecause: 'counts steps, not bytes',
    },
  ];
}

export function getTokenSavingsReport() {
  const resultDedup = getResultDedupSavings();
  const paramsDedup = getParamsDedupSavings();
  const textDedup = getTextDedupSavings();
  // goldenDiffCache now reuses result_blobs for diff storage (see saveDiff)
  // - its own bytesSaved (per CACHE-HIT ROW) and resultDedup's bytesSaved
  // (per UNIQUE BLOB's ref_count) both real, but overlapping: a diff cache
  // hit's bytes are counted by both. goldenDiffCache is reported on its own
  // (cacheHits is a distinct, non-overlapping metric worth keeping visible)
  // but deliberately excluded from the totals below to avoid double-
  // counting the same physical bytes twice.
  const goldenDiffCache = getGoldenDiffCacheSavings();
  const macroCompaction = { stepsRemoved: stmtMacroCompactionTotal.get().totalRemoved };
  const macroTemplating = { stepsRemoved: stmtMacroTemplatingTotal.get().totalRemoved };
  const snapshotRowDedup = getSnapshotRowDedupSavings();
  const snapshotDedup = getSnapshotDedupSavings();
  const stepBlobDedup = getStepBlobDedupSavings();
  const columnDictCompaction = getColumnDictSavings();
  const totalBytesSaved = resultDedup.bytesSaved + paramsDedup.bytesSaved + textDedup.bytesSaved + snapshotRowDedup.bytesSaved + snapshotDedup.bytesSaved + stepBlobDedup.bytesSaved + columnDictCompaction.bytesSaved;
  const totalEstTokensSaved = resultDedup.estTokensSaved + paramsDedup.estTokensSaved + textDedup.estTokensSaved + snapshotRowDedup.estTokensSaved + snapshotDedup.estTokensSaved + stepBlobDedup.estTokensSaved + columnDictCompaction.estTokensSaved;
  return {
    resultDedup,
    paramsDedup,
    textDedup,
    goldenDiffCache,
    macroCompaction,
    macroTemplating,
    snapshotRowDedup,
    snapshotDedup,
    stepBlobDedup,
    columnDictCompaction,
    totalBytesSaved,
    totalEstTokensSaved,
    ledgers: buildSavingsLedgers({ resultDedup, paramsDedup, textDedup, goldenDiffCache, macroCompaction, macroTemplating, snapshotRowDedup, snapshotDedup, stepBlobDedup, columnDictCompaction }),
    // Every DB ledger above is a storage saving; kept as its own key so a
    // reader never has to know which totals mean what.
    byKind: { storage: { bytesSaved: totalBytesSaved, estTokensSaved: totalEstTokensSaved } },
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
  INSERT INTO verity_runs (session_id, label, passed, step_count, passed_count, failed_count, result_json, result_hash, imported_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const stmtListVerityRuns = db.prepare('SELECT id, session_id, label, passed, step_count, passed_count, failed_count, imported_at FROM verity_runs WHERE session_id = ? ORDER BY id DESC');
const stmtGetVerityRun = db.prepare('SELECT * FROM verity_runs WHERE id = ?');

export function importVerityRun({ sessionId, label, result }) {
  const steps = Array.isArray(result?.steps) ? result.steps : [];
  const passedCount = steps.filter((s) => s?.passed).length;
  const failedCount = steps.length - passedCount;
  const importedAt = new Date().toISOString();
  const resultJson = JSON.stringify(result);
  // Reuses result_blobs (see internResult above) - a repeat CRV import of a
  // mostly-unchanged scenario now stores that result JSON physically once,
  // not on every single re-run. '' sentinel because result_json is NOT NULL
  // (pre-existing schema) - same convention as console_entries.message
  // below.
  const interned = internResult(resultJson);
  const storedResultJson = interned.dedup ? '' : resultJson;
  const info = stmtInsertVerityRun.run(
    Number(sessionId), label ?? null,
    result?.passed === undefined ? null : (result.passed ? 1 : 0),
    steps.length, passedCount, failedCount,
    storedResultJson, interned.hash, importedAt,
  );
  return { ...hydrateVerityRun(stmtGetVerityRun.get(Number(info.lastInsertRowid))) };
}

function resolveVerityResultJson(resultJson, resultHash) {
  if (resultJson) return resultJson;
  if (!resultHash) return resultJson;
  return stmtGetResultBlob.get(resultHash)?.json ?? resultJson;
}

function hydrateVerityRun(row) {
  if (!row) return row;
  const resultJson = resolveVerityResultJson(row.result_json, row.result_hash);
  return { ...row, passed: row.passed === null ? null : !!row.passed, result: resultJson ? JSON.parse(resultJson) : null };
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
