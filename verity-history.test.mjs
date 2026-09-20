// Round-10 gap: "verity import" (relay.mjs POST /verity/import, cli.mjs `verity import`) was
// write-only - GET /sessions/:id/verity-runs and GET /verity-runs/:id (relay.mjs) already
// existed and were already read internally by "session report" (gatherReportBundle), but had
// no filtered, cross-session-callable verb of their own, unlike net_entries/console_entries
// ("net history"/"console history" - analytics-net-console-known-issues.test.mjs's own header
// comment). This checks the new client.mjs verityHistory (mirrors netHistory/consoleHistory,
// wired as `verity history` in cli.mjs and `webscout_session.verity_history` in
// mcp-server.mjs) and the raw GET /verity-runs/:id route (`verity show` /
// `webscout_session.verity_show`).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestRelay } from './test-relay.mjs';

const relay = await startTestRelay();
// client.mjs reads WEBSCOUT_PORT once at import time (see client-notes.test.mjs's own note) -
// the env must be set BEFORE this dynamic import, after the ephemeral relay's real port is known.
process.env.WEBSCOUT_PORT = String(relay.port);
const { request, verityHistory } = await import('./client.mjs');

test.after(async () => { await relay.stop(); });

async function newSession(goal) {
  const health = await request('GET', '/health');
  if (health.active_session) await request('POST', `/sessions/${health.active_session.id}/end`);
  return (await request('POST', '/sessions', { goal, context: 'verity-history.test.mjs', briefing: false })).id;
}

function scenarioResult(steps) {
  return { passed: steps.every(Boolean), steps: steps.map((passed, i) => ({ id: `step-${i}`, passed })) };
}

test('verityHistory lists a session\'s imported runs newest-first, metadata only (no full result)', async () => {
  const id = await newSession('verity history basic test');
  await request('POST', '/verity/import', { sessionId: id, label: 'first pass', result: scenarioResult([true, true]) });
  await request('POST', '/verity/import', { sessionId: id, label: 'second pass', result: scenarioResult([true, false]) });

  const { sessionId, count, runs } = await verityHistory({ sessionId: id });
  assert.equal(sessionId, id);
  assert.equal(count, 2);
  assert.equal(runs[0].label, 'second pass', 'newest run first, same order as the underlying route');
  assert.equal(runs[0].passed, false);
  assert.equal(runs[0].passed_count, 1);
  assert.equal(runs[0].failed_count, 1);
  assert.equal('result' in runs[0], false, 'history is metadata only - the full per-step result is verityShow\'s job');
});

test('verityHistory filters by label substring and limit, client-side, same shape as netHistory/consoleHistory', async () => {
  const id = await newSession('verity history filter test');
  await request('POST', '/verity/import', { sessionId: id, label: 'checkout flow', result: scenarioResult([true]) });
  await request('POST', '/verity/import', { sessionId: id, label: 'login flow', result: scenarioResult([true]) });
  await request('POST', '/verity/import', { sessionId: id, label: 'checkout regression', result: scenarioResult([false]) });

  const byLabel = await verityHistory({ sessionId: id, label: 'checkout' });
  assert.equal(byLabel.count, 2);
  assert.ok(byLabel.runs.every((r) => r.label.includes('checkout')));

  const limited = await verityHistory({ sessionId: id, limit: 1 });
  assert.equal(limited.count, 1);
});

test('verityHistory defaults to the active session, same fallback as netHistory/consoleHistory', async () => {
  const id = await newSession('verity history default-session test');
  await request('POST', '/verity/import', { sessionId: id, label: 'active session run', result: scenarioResult([true]) });

  const { sessionId } = await verityHistory({});
  assert.equal(sessionId, id);
});

test('GET /verity-runs/:id ("verity show") returns the full per-step result a history row omits', async () => {
  const id = await newSession('verity show test');
  const imported = await request('POST', '/verity/import', { sessionId: id, label: 'detail test', result: scenarioResult([true, false, true]) });

  const shown = await request('GET', `/verity-runs/${imported.id}`);
  assert.equal(shown.label, 'detail test');
  assert.equal(shown.result.steps.length, 3);
  assert.equal(shown.result.steps[1].passed, false);
});
