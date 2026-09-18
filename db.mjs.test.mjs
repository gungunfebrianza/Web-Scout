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

test('strict_crv_stores: persisted/hydrated as an array, null when omitted or empty', () => {
  const scoped = db.startSession({ goal: 'strict-crv scoped', strictCrv: true, strictCrvStores: ['foo', 'bar'] });
  assert.equal(scoped.strict_crv, true);
  assert.deepEqual(scoped.strict_crv_stores, ['foo', 'bar']);
  assert.deepEqual(db.getSession(scoped.id).strict_crv_stores, ['foo', 'bar']);
  db.endSession(scoped.id);

  const unscoped = db.startSession({ goal: 'strict-crv unscoped', strictCrv: true });
  assert.equal(unscoped.strict_crv_stores, null);
  db.endSession(unscoped.id);

  const emptyArray = db.startSession({ goal: 'strict-crv empty array', strictCrv: true, strictCrvStores: [] });
  assert.equal(emptyArray.strict_crv_stores, null);
  db.endSession(emptyArray.id);
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

  const { actions: allActions } = db.listAllActions();
  const allScreenshotRow = allActions.find((a) => a.id === id2);
  assert.equal(allScreenshotRow.result.dataUrl, null, 'listAllActions redacts dom.screenshot dataUrl too (Friction Analytics never needs result content)');
  assert.equal(allScreenshotRow.result.redacted, true);
  const allQueryRow = allActions.find((a) => a.id === id1);
  assert.deepEqual(allQueryRow.result, { found: true }, 'a non-heavy action type is untouched by listAllActions redaction');

  db.endSession(s.id);
});

test('params dedup: a repeated params object is physically stored once, resolved transparently everywhere', () => {
  const s = db.startSession({ goal: 'params dedup test' });
  const startedAt = new Date().toISOString();
  const endedAt = new Date(Date.now() + 5).toISOString();
  const params = { store: 'bookmarks' };

  const id1 = db.logAction({ sessionId: s.id, type: 'idb.dump', params, result: { rows: [1] }, ok: true, startedAt, endedAt });
  const id2 = db.logAction({ sessionId: s.id, type: 'idb.dump', params, result: { rows: [1] }, ok: true, startedAt, endedAt });
  const id3 = db.logAction({ sessionId: s.id, type: 'idb.dump', params, result: { rows: [1] }, ok: true, startedAt, endedAt });

  assert.deepEqual(db.getActionById(id1).params, params);
  assert.deepEqual(db.getActionById(id2).params, params, 'a deduped row still resolves its full params via hash');
  assert.deepEqual(db.getActionById(id3).params, params);

  const savings = db.getParamsDedupSavings();
  assert.ok(savings.bytesSaved > 0, 'repeated params physically stored once, not three times');

  // The very detectors that key on params identity (findRepeatedActionLoops/
  // findRedundantCalls) must still see the real content post-dedup, not a
  // blank/NULL target.
  const loops = db.findRepeatedActionLoops(s.id);
  assert.equal(loops.length, 1);
  assert.deepEqual(loops[0].params, params);

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

test('snapshot-level dedup: a byte-identical repeat snapshot reuses the original stores_json', () => {
  const s = db.startSession({ goal: 'snapshot dedup test' });
  const stores = { foo: { rows: [{ id: 1, tag: 'unchanged' }, { id: 2, tag: 'unchanged' }] } };

  const first = db.saveSnapshot({ sessionId: s.id, stores, agentName: 'default' });
  const repeat = db.saveSnapshot({ sessionId: s.id, stores, agentName: 'default' });
  const third = db.saveSnapshot({ sessionId: s.id, stores, agentName: 'default' });

  assert.notEqual(repeat.id, first.id, 'still a distinct row/id per snapshot call');
  assert.deepEqual(db.getSnapshot(repeat.id).stores, stores, 'a deduped snapshot still resolves its full store content via the pointer');
  assert.deepEqual(db.getSnapshot(third.id).stores, stores);
  assert.equal(db.getSnapshot(repeat.id).counts.foo, 2, 'counts stay real per-row, not skipped by the dedup path');

  const savings = db.getSnapshotDedupSavings();
  assert.equal(savings.dedupedCount, 2, 'two of the three saves matched an existing content_hash');
  assert.ok(savings.bytesSaved > 0);

  // A genuinely different snapshot content must NOT be mistaken for a repeat.
  const changed = db.saveSnapshot({ sessionId: s.id, stores: { foo: { rows: [{ id: 1, tag: 'changed' }] } }, agentName: 'default' });
  assert.deepEqual(db.getSnapshot(changed.id).stores, { foo: { rows: [{ id: 1, tag: 'changed' }] } });

  db.endSession(s.id);
});

test('diff content dedup: a repeat diff-golden-shaped diff reuses the original diff_json via result_blobs', () => {
  const s = db.startSession({ goal: 'diff dedup test' });
  const snap1 = db.saveSnapshot({ sessionId: s.id, stores: { foo: { rows: [{ id: 1 }] } }, agentName: 'default' });
  const snap2 = db.saveSnapshot({ sessionId: s.id, stores: { foo: { rows: [{ id: 1 }, { id: 2 }] } }, agentName: 'default' });

  const summary = { foo: { added: 1, removed: 0, changed: 0 } };
  const diffContent = { foo: { added: [{ id: 2 }] } };
  const original = db.saveDiff({ sessionId: s.id, fromId: snap1.id, toId: snap2.id, summary, diff: diffContent });
  // A cache-served diff (servedFromDiffId set) is byte-identical to the diff
  // it was served from by construction - this is exactly what
  // findCachedDiff's real caller (relay.mjs) does on a cache hit.
  const served = db.saveDiff({ sessionId: s.id, fromId: snap1.id, toId: snap2.id, summary, diff: diffContent, servedFromDiffId: original.id });

  assert.deepEqual(db.getDiff(served.id).diff, diffContent, 'a cache-served diff row still resolves its full diff content via the shared blob');
  assert.deepEqual(db.getDiff(original.id).diff, diffContent);

  const cacheSavings = db.getGoldenDiffCacheSavings();
  assert.equal(cacheSavings.cacheHits, 1);
  assert.ok(cacheSavings.bytesSaved > 0, 'reflects the real interned blob size, not the (now empty) diff_json column');

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
    { level: 'error', message: 'boom', stack: 'at foo\nat bar', at: now },
    { level: 'error', message: 'boom', stack: 'at foo\nat bar', at: now },
  ]);
  const consoleEntries = db.listConsoleEntries(s.id);
  assert.equal(consoleEntries.length, 4);
  assert.ok(consoleEntries.every((e) => e.message === 'boom' || e.message === 'careful'), 'a deduped message resolves back to its full text, never the "" storage sentinel');
  const withStack = consoleEntries.filter((e) => e.stack);
  assert.equal(withStack.length, 2);
  assert.ok(withStack.every((e) => e.stack === 'at foo\nat bar'), 'a deduped stack resolves back to its full text too');
  assert.equal(db.listConsoleEntries(s.id, { limit: 1 }).length, 1);

  db.insertNetEntries(s.id, 'default', [
    { via: 'fetch', method: 'GET', url: '/a', status: 200, startedAt: now, endedAt: now },
    { via: 'fetch', method: 'GET', url: '/a', status: 200, startedAt: now, endedAt: now },
    { via: 'fetch', method: 'GET', url: '/c', status: 200, startedAt: now, endedAt: now },
  ]);
  const netEntries = db.listNetEntries(s.id);
  assert.equal(netEntries.length, 3);
  assert.equal(netEntries.filter((e) => e.url === '/a').length, 2, 'a deduped url resolves back to the real url, never null');
  assert.equal(db.listNetEntries(s.id, { limit: 2 }).length, 2);

  const textSavings = db.getTextDedupSavings();
  assert.ok(textSavings.bytesSaved > 0, 'repeated console message/stack and net url physically stored once');

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

  // A repeat import of the byte-identical scenario result (e.g. a re-run
  // CRV round with no real change) must still resolve its full result
  // content, even though it's stored via the "" sentinel (result_json is
  // NOT NULL) rather than physically duplicated.
  const reimported = db.importVerityRun({
    sessionId: s.id, label: 'smoke-2',
    result: { passed: false, steps: [{ passed: true }, { passed: true }, { passed: false }] },
  });
  assert.deepEqual(reimported.result, imported.result);
  assert.equal(db.getVerityRun(reimported.id).result.steps.length, 3, 'a deduped verity result still resolves via its hash on a fresh read');

  db.endSession(s.id);
});
