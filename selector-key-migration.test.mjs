// Migration safety for actions.selector_key. The backfill runs at module load on EVERY database, so
// it must cope with what real databases contain: a table that predates the column, rows whose
// params_json is malformed, rows with no target, an interrupted earlier run, and a second boot.
// Each phase runs db.mjs in its own process against one on-disk file.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpDir } from './scratch.mjs';
import { frictionKeyFor } from './friction.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const tmp = tmpDir('webscout-migration-');
const dbPath = path.join(tmp, 'legacy.db');

// Boots db.mjs (schema + migrations + backfill) against dbPath in a child process and exits.
const boot = () => {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', "await import('./db.mjs')"], { cwd: dir, encoding: 'utf8', env: { ...process.env, WEBSCOUT_DB_PATH: dbPath } });
  assert.equal(r.status, 0, r.stderr);
};
const keys = () => {
  const db = new DatabaseSync(dbPath);
  try { return Object.fromEntries(db.prepare('SELECT id, selector_key AS k FROM actions ORDER BY id').all().map((r) => [r.id, r.k])); } finally { db.close(); }
};

test('a database from before the column is migrated: keys backfilled, malformed rows skipped, reboot is a no-op', () => {
  boot(); // creates the current schema
  const db = new DatabaseSync(dbPath);
  db.exec('DROP INDEX IF EXISTS idx_actions_selector_key');
  db.exec('ALTER TABLE actions DROP COLUMN selector_key'); // now it looks like a legacy table
  db.prepare("INSERT INTO sessions (goal, status, started_at) VALUES ('legacy', 'ended', '2026-01-01T00:00:00Z')").run();
  const add = db.prepare("INSERT INTO actions (session_id, type, params_json, ok, error, started_at, ended_at, duration_ms) VALUES (1, ?, ?, ?, ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:01Z', 5)");
  add.run('dom.click', JSON.stringify({ selector: '#row-41' }), 0, 'Element not found');
  add.run('dom.clickWait', JSON.stringify({ selector: '#row-97' }), 1, null);
  add.run('idb.patch', JSON.stringify({ store: 'orders' }), 0, 'boom');
  add.run('dom.click', '{not json', 0, 'x'); // malformed
  add.run('dom.click', null, 0, 'y'); // no params at all
  add.run('ping', JSON.stringify({}), 1, null); // no target
  db.close();

  boot();
  const k = keys();
  assert.equal(k[1], frictionKeyFor('dom.click', { selector: '#row-41' }));
  assert.equal(k[1], k[2], '#row-41 and #row-97 share a normalized key, and clickWait shares the click family');
  assert.equal(k[3], frictionKeyFor('idb.put', { store: 'orders' }), 'idb.patch and idb.put share a store key');
  assert.equal(k[4], '', 'malformed params: no target, not an error');
  assert.equal(k[5], '');
  assert.equal(k[6], '');

  const before = JSON.stringify(k);
  boot();
  assert.equal(JSON.stringify(keys()), before, 'a second boot changes nothing');
});

test('an interrupted backfill finishes on the next boot without touching rows already done', () => {
  const db = new DatabaseSync(dbPath);
  db.prepare("UPDATE actions SET selector_key = NULL WHERE id IN (1, 3)").run(); // as if the previous run died part-way
  db.prepare("UPDATE actions SET selector_key = 'keep-me' WHERE id = 2").run();
  db.close();
  boot();
  const k = keys();
  assert.equal(k[1], frictionKeyFor('dom.click', { selector: '#row-41' }));
  assert.equal(k[3], frictionKeyFor('idb.put', { store: 'orders' }));
  assert.equal(k[2], 'keep-me', 'only NULL rows are examined');
});

test('cleanup', () => { fs.rmSync(tmp, { recursive: true, force: true }); });
