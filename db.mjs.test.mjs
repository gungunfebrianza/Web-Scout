// Unit tests for tools/web-scout/db.mjs, against a throwaway SQLite file
// (WEBSCOUT_DB_PATH override - see db.mjs) instead of the real
// webscout.db, so this never touches real session history and can run
// with no relay/browser tab at all - no network involved, pure db.mjs.
// Run with: node --test tools/web-scout/db.mjs.test.mjs

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dbPath = path.join(os.tmpdir(), `webscout-test-${process.pid}-${Date.now()}.db`);
process.env.WEBSCOUT_DB_PATH = dbPath;

// Dynamic import AFTER the env var is set - db.mjs opens its DB at
// module-evaluation time, so a static top-level import would race the
// assignment above depending on hoisting.
const db = await import('./db.mjs');

after(() => {
  // Best-effort - node:sqlite has no exported close() here (db.mjs holds
  // it open for its whole module lifetime, matching the real relay's
  // process-lifetime usage), so on Windows the main .db file's handle may
  // still be open when this runs and unlink silently no-ops; harmless
  // either way since it's an OS tmpdir file, not anything in the repo.
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + suffix); } catch { /* may not exist, or still open */ }
  }
});

test('session lifecycle: start requires a goal, enforces one active session, end/current/get/list', () => {
  assert.throws(() => db.startSession({ goal: '' }), /non-empty goal/);
  assert.equal(db.getCurrentSession(), null);

  const s = db.startSession({ goal: 'test goal', context: 'test context', tags: ['a', 'b'] });
  assert.equal(s.status, 'active');
  assert.deepEqual(s.tags, ['a', 'b']);
  assert.equal(db.getCurrentSession().id, s.id);

  assert.throws(() => db.startSession({ goal: 'second one' }), /already active/);

  const fetched = db.getSession(s.id);
  assert.equal(fetched.goal, 'test goal');
  assert.throws(() => db.getSession(999999), /no such session/);

  assert.ok(db.listSessions().some((row) => row.id === s.id));

  const ended = db.endSession(s.id);
  assert.equal(ended.status, 'ended');
  assert.equal(db.getCurrentSession(), null);
  assert.throws(() => db.endSession(s.id), /not active/);

  // A prior session ending frees the one-active-session slot for a new one.
  const s2 = db.startSession({ goal: 'second session now allowed' });
  assert.notEqual(s2.id, s.id);
  db.endSession(s2.id);
});

test('actions: logged, listed newest-first by default, redaction applied by listActionsSummary only', () => {
  const s = db.startSession({ goal: 'action logging test' });
  const startedAt = new Date().toISOString();
  const endedAt = new Date(Date.now() + 5).toISOString();

  const id1 = db.logAction({ sessionId: s.id, type: 'dom.query', params: { selector: 'body' }, result: { found: true }, ok: true, startedAt, endedAt, agentName: 'default' });
  const id2 = db.logAction({
    sessionId: s.id, type: 'dom.screenshot', params: { selector: 'body' },
    result: { dataUrl: 'data:image/png;base64,AAAA', width: 10, height: 10 }, ok: true, startedAt, endedAt,
  });

  const full = db.listActions(s.id);
  assert.equal(full.length, 2);
  assert.equal(full[0].id, id2, 'newest first by default');
  assert.equal(full[1].id, id1);
  assert.equal(full[0].result.dataUrl, 'data:image/png;base64,AAAA', 'listActions never redacts');

  const ascending = db.listActions(s.id, { ascending: true });
  assert.equal(ascending[0].id, id1);

  const summary = db.listActionsSummary(s.id);
  const screenshotRow = summary.find((a) => a.id === id2);
  assert.equal(screenshotRow.result.dataUrl, null, 'listActionsSummary redacts dom.screenshot dataUrl');
  assert.equal(screenshotRow.result.redacted, true);
  const queryRow = summary.find((a) => a.id === id1);
  assert.deepEqual(queryRow.result, { found: true }, 'a non-heavy action type is untouched by redaction');

  const limited = db.listActionsSummary(s.id, { limit: 1 });
  assert.equal(limited.length, 1);

  const byId = db.getActionById(id1);
  assert.equal(byId.session_id, s.id);
  assert.throws(() => db.getActionById(999999), /no such action/);

  db.endSession(s.id);
});

test('snapshots and diffs: save, get, list, golden lookup', () => {
  const s = db.startSession({ goal: 'snapshot/diff test' });
  const snap1 = db.saveSnapshot({ sessionId: s.id, stores: { foo: { rows: [{ id: 1 }] } }, agentName: 'default' });
  const snap2 = db.saveSnapshot({ sessionId: s.id, stores: { foo: { rows: [{ id: 1 }, { id: 2 }] } }, agentName: 'default', goldenName: 'my-baseline' });

  assert.equal(db.getSnapshot(snap1.id).stores.foo.rows.length, 1);
  assert.equal(db.listSnapshots(s.id).length, 2);

  const golden = db.getGoldenSnapshot('my-baseline');
  assert.equal(golden.id, snap2.id);
  assert.throws(() => db.getGoldenSnapshot('does-not-exist'), /no such golden snapshot/);

  const diff = db.saveDiff({ sessionId: s.id, fromId: snap1.id, toId: snap2.id, summary: { foo: { added: 1, removed: 0, changed: 0 } }, diff: { foo: { added: [{ id: 2 }] } } });
  assert.equal(db.getDiff(diff.id).summary.foo.added, 1);
  assert.equal(db.listDiffs(s.id).length, 1);

  db.endSession(s.id);
});

test('QA, console, and net entries: save/list, limit caps row count', () => {
  const s = db.startSession({ goal: 'qa/console/net test' });

  const now = new Date().toISOString();
  db.saveQA({ sessionId: s.id, question: 'what changed?', context: { some: 'context' }, answer: 'nothing yet', askedAt: now, answeredAt: now });
  assert.equal(db.listQA(s.id).length, 1);

  db.insertConsoleEntries(s.id, 'default', [
    { level: 'error', message: 'boom', at: now },
    { level: 'warn', message: 'careful', at: now },
  ]);
  assert.equal(db.listConsoleEntries(s.id).length, 2);
  assert.equal(db.listConsoleEntries(s.id, { limit: 1 }).length, 1);

  db.insertNetEntries(s.id, 'default', [
    { via: 'fetch', method: 'GET', url: '/a', status: 200, startedAt: now, endedAt: now },
    { via: 'fetch', method: 'GET', url: '/b', status: 200, startedAt: now, endedAt: now },
    { via: 'fetch', method: 'GET', url: '/c', status: 200, startedAt: now, endedAt: now },
  ]);
  assert.equal(db.listNetEntries(s.id).length, 3);
  assert.equal(db.listNetEntries(s.id, { limit: 2 }).length, 2);

  db.endSession(s.id);
});

test('macros: create, update steps, get, list, delete', () => {
  const s = db.startSession({ goal: 'macro test' });
  const macro = db.createMacro({ name: `test-macro-${Date.now()}`, sourceSessionId: s.id, steps: [{ type: 'dom.click', params: { selector: '#go' } }] });
  assert.equal(macro.steps.length, 1);

  const updated = db.updateMacroSteps(macro.id, [{ type: 'dom.click', params: { selector: '#go' } }, { type: 'dom.wait', params: { selector: '#done' } }]);
  assert.equal(updated.steps.length, 2);
  assert.throws(() => db.updateMacroSteps(999999, []), /no such macro/);

  assert.equal(db.getMacro(macro.id).name, macro.name);
  assert.ok(db.listMacros().some((m) => m.id === macro.id));

  assert.deepEqual(db.deleteMacro(macro.id), { deleted: true });
  assert.throws(() => db.getMacro(macro.id), /no such macro/);
  assert.throws(() => db.deleteMacro(macro.id), /no such macro/);

  db.endSession(s.id);
});

test('verity runs: import computes pass/fail counts from steps, get/list/listAll', () => {
  const s = db.startSession({ goal: 'verity import test' });
  const imported = db.importVerityRun({
    sessionId: s.id, label: 'smoke',
    result: { passed: false, steps: [{ passed: true }, { passed: true }, { passed: false }] },
  });
  assert.equal(imported.step_count, 3);
  assert.equal(imported.passed_count, 2);
  assert.equal(imported.failed_count, 1);
  assert.equal(imported.passed, false);

  assert.equal(db.getVerityRun(imported.id).label, 'smoke');
  assert.equal(db.listVerityRuns(s.id).length, 1);
  assert.ok(db.listAllVerityRuns().some((r) => r.id === imported.id));

  db.endSession(s.id);
});
