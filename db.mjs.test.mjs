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

test('listActionsForViz carries a delivered-bytes estimate without reading the result body, and listClickNavigations reads dom.click hrefs', () => {
  const s = db.startSession({ goal: 'viz support test' });
  const startedAt = new Date().toISOString();
  const endedAt = new Date(Date.now() + 5).toISOString();

  const id1 = db.logAction({ sessionId: s.id, type: 'idb.dump', params: { store: 'a' }, result: { rows: [1, 2, 3] }, ok: true, startedAt, endedAt });
  // A second, physically-deduped result (same JSON) still needs a byte figure - from result_blobs.byte_length, not a second copy.
  const id2 = db.logAction({ sessionId: s.id, type: 'idb.dump', params: { store: 'b' }, result: { rows: [1, 2, 3] }, ok: true, startedAt, endedAt });
  const viz = db.listActionsForViz(s.id);
  const row1 = viz.find((a) => a.id === id1);
  const row2 = viz.find((a) => a.id === id2);
  assert.equal(row1.bytes, JSON.stringify({ rows: [1, 2, 3] }).length);
  assert.equal(row2.bytes, row1.bytes, 'the deduped row still reports the same byte size');
  assert.deepEqual(row1.params, { store: 'a' });
  assert.ok(!('params_json' in row1));

  const clickOk = db.logAction({
    sessionId: s.id, type: 'dom.click', params: { selector: '#nav' },
    result: { clicked: true, mutated: true, hrefChanged: true, hrefBefore: 'https://app/#/a', href: 'https://app/#/b' },
    ok: true, startedAt, endedAt,
  });
  db.logAction({ sessionId: s.id, type: 'dom.click', params: { selector: '#bad' }, result: null, error: 'no element', ok: false, startedAt, endedAt });
  const clicks = db.listClickNavigations(s.id);
  assert.equal(clicks.length, 1, 'a failed click carries no navigation info and is excluded');
  assert.deepEqual(clicks[0], { id: clickOk, startedAt, agentName: 'default', hrefChanged: true, hrefBefore: 'https://app/#/a', href: 'https://app/#/b' });

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

test('read-cache savings are persisted in the DB (they used to reset on every relay restart)', () => {
  const before = db.getReadCacheSavings();
  db.bumpReadCacheSavings(4000);
  db.bumpReadCacheSavings(400);
  const after = db.getReadCacheSavings();
  assert.equal(after.hits, before.hits + 2);
  assert.equal(after.bytesSaved, before.bytesSaved + 4400);
  assert.equal(after.estTokensSaved, Math.round(after.bytesSaved / db.CHARS_PER_TOKEN_ESTIMATE));
});

test('getTokenSavingsReport labels each ledger by what it measures and only counts the counted ones', () => {
  const r = db.getTokenSavingsReport();
  const byKey = Object.fromEntries(r.ledgers.map((l) => [l.key, l]));
  for (const key of ['resultDedup', 'textDedup', 'snapshotRowDedup', 'snapshotDedup', 'paramsDedup', 'stepBlobDedup', 'columnDictCompaction']) {
    assert.equal(byKey[key].kind, 'storage', `${key} saves disk bytes, not agent tokens`);
    assert.equal(byKey[key].countedInTotal, true);
  }
  assert.equal(byKey.goldenDiffCache.countedInTotal, false, 'overlaps resultDedup - shown, not double counted');
  assert.match(byKey.goldenDiffCache.excludedBecause, /twice/);
  assert.equal(byKey.macroCompaction.kind, 'workflow');
  const countedBytes = r.ledgers.filter((l) => l.countedInTotal).reduce((sum, l) => sum + l.bytesSaved, 0);
  assert.equal(countedBytes, r.totalBytesSaved, 'the counted ledgers foot to the reported total');
  assert.equal(r.byKind.storage.bytesSaved, r.totalBytesSaved);
});

test('a ledger with a unique-bytes figure reports its real reduction percentage', () => {
  const s = db.startSession({ goal: 'ledger reduction' });
  const big = { rows: Array.from({ length: 40 }, (_, i) => ({ id: i, text: 'x'.repeat(50) })) };
  for (let i = 0; i < 4; i += 1) {
    db.logAction({ sessionId: s.id, type: 'idb.dump', params: { store: 'ledger_test' }, ok: true, result: big, startedAt: new Date().toISOString(), endedAt: new Date().toISOString() });
  }
  const ledger = db.getTokenSavingsReport().ledgers.find((l) => l.key === 'resultDedup');
  assert.ok(ledger.logicalBytes > ledger.uniqueBytes, 'four identical results stored once');
  assert.equal(ledger.reductionPct, Math.round((ledger.bytesSaved / ledger.logicalBytes) * 1000) / 10);
  assert.ok(ledger.refs.total > ledger.refs.unique);
  db.endSession(s.id);
});

test('startSession ifStaleMin: opt-in, fails closed on a young conflicting session, ends an old one first', () => {
  const first = db.startSession({ goal: 'stale-flag first', agentName: 'tab-a' });

  // Without the flag: exactly today's refusal, with no stale-flag wording in it.
  assert.throws(() => db.startSession({ goal: 'no flag' }), (err) => /already active/.test(err.message) && !/if-stale-min/.test(err.message));

  // Too young: refuses, says why, and leaves the running session alone.
  assert.throws(() => db.startSession({ goal: 'too young', ifStaleMin: 60 }), /already active[\s\S]*younger than --if-stale-min 60/);
  assert.equal(db.getCurrentSession().id, first.id, 'a refused start must not end anything');
  assert.equal(db.getSession(first.id).status, 'active');

  // The threshold is real arithmetic on started_at, not just "0 always wins": 59 min old vs a 60
  // threshold refuses, 61 min old vs 60 succeeds. (Date.now stubbed for this block only.)
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 59 * 60000;
    assert.throws(() => db.startSession({ goal: 'still young', ifStaleMin: 60 }), /already active/);
    Date.now = () => realNow() + 61 * 60000;
    const replaced = db.startSession({ goal: 'after stale', ifStaleMin: 60 });
    assert.equal(replaced.autoEndedSession.id, first.id);
    assert.equal(replaced.autoEndedSession.agent, 'tab-a');
    assert.ok(replaced.autoEndedSession.ageMin >= 61);
    assert.match(replaced.autoEndedSession.reason, /if-stale-min 60/);
    Date.now = realNow;
    db.endSession(replaced.id);
  } finally {
    Date.now = realNow;
  }
  assert.equal(db.getSession(first.id).status, 'ended', 'the stale session really is ended, not just hidden');

  // ifStaleMin 0 succeeds immediately; with no conflict the flag is a no-op (no autoEndedSession).
  const alone = db.startSession({ goal: 'no conflict', ifStaleMin: 0 });
  assert.equal(alone.autoEndedSession, undefined);
  const zero = db.startSession({ goal: 'zero threshold', ifStaleMin: 0 });
  assert.equal(zero.autoEndedSession.id, alone.id);
  assert.equal(db.getSession(alone.id).status, 'ended');
  db.endSession(zero.id);

  assert.throws(() => db.startSession({ goal: 'bad', ifStaleMin: -1 }), /ifStaleMin must be/);
  assert.throws(() => db.startSession({ goal: 'bad', ifStaleMin: Number.NaN }), /ifStaleMin must be/);
});
