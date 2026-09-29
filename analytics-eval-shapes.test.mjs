// GET /analytics's repeatedEvalShapes (relay.mjs computeAnalytics, round-13 addition) - the
// eval-body audit that found css.hasRule's shape (17 occurrences, see V42) was a one-off manual
// SQL query against webscout.db. This makes that query a standing signal: normalizes each eval's
// expr (string/number literals -> placeholders) so calls that differ only by selector/literal
// text collapse into one shape, ranks by repeat count, and feeds the #1 shape into
// topFrictionItems - same digest every other friction signal already reaches through.
// Real relay, real fake-agent tab, no browser.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestRelay, connectFakeAgent } from './test-relay.mjs';

let relay;
let tab;
const api = async (method, route, body) => {
  const res = await fetch(`http://127.0.0.1:${relay.port}${route}`, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json();
  if (!json.ok) throw new Error(json.error || `request failed: ${route}`);
  return json.result;
};
const command = (type, params) => api('POST', '/command', { type, params });

before(async () => {
  relay = await startTestRelay();
  tab = await connectFakeAgent(relay.port, {
    eval: () => ({ value: null }),
  });
});
after(async () => { tab?.close(); await relay.stop(); });

test('eval calls that differ only by literal text collapse into one repeated shape, ranked by count', async () => {
  const s1 = (await api('POST', '/sessions', { goal: 'shape-a', context: 'analytics-eval-shapes.test.mjs' })).id;
  // Same structural shape, different selector/href literal each time - 3 calls.
  await command('eval', { expr: "[...document.styleSheets].find(s => (s.href||'').includes('a.css')).cssRules" });
  await command('eval', { expr: "[...document.styleSheets].find(s => (s.href||'').includes('b.css')).cssRules" });
  await command('eval', { expr: "[...document.styleSheets].find(s => (s.href||'').includes('c.css')).cssRules" });
  await api('POST', `/sessions/${s1}/end`);

  const s2 = (await api('POST', '/sessions', { goal: 'shape-b', context: 'analytics-eval-shapes.test.mjs' })).id;
  // A different shape, only ever run once - must not appear (below EVAL_SHAPE_MIN_COUNT).
  await command('eval', { expr: 'document.title' });
  await api('POST', `/sessions/${s2}/end`);

  const a = await api('GET', '/analytics');
  assert.ok(Array.isArray(a.repeatedEvalShapes), 'repeatedEvalShapes is present');
  const top = a.repeatedEvalShapes[0];
  assert.ok(top, 'the 3x-repeated shape ranks');
  assert.equal(top.count, 3);
  assert.equal(top.sessionCount, 1);
  assert.ok(top.shape.includes('STR'), 'string literals were normalized to a placeholder');
  assert.ok(!top.shape.includes('a.css') && !top.shape.includes('b.css'), 'the varying literal text itself is not part of the shape key');
  assert.ok(!a.repeatedEvalShapes.some((s) => s.count < 2), 'a one-off eval never ranks as a repeated shape');

  const digestHit = a.topFrictionItems.find((f) => f.kind === 'repeatedEvalShape');
  assert.ok(digestHit, 'the top repeated shape is folded into the topFrictionItems digest');
  assert.equal(digestHit.severity, 3);
});
