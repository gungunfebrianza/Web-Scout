// GET /analytics's repeatedEvalShapes (relay.mjs computeAnalytics, round-13 addition) - the
// eval-body audit that found css.hasRule's shape (17 occurrences, see V42) was a one-off manual
// SQL query against webscout.db. This makes that query a standing signal: normalizes each eval's
// expr (string/number literals -> placeholders) so calls that differ only by selector/literal
// text collapse into one shape, ranks by repeat count, and feeds the #1 shape into
// topFrictionItems - same digest every other friction signal already reaches through.
// Real relay, real fake-agent tab, no browser.
//
// Each test spins its own relay (rather than sharing one across the file) specifically because
// GET /analytics is server-side cached for ANALYTICS_CACHE_MS (5s, see relay.mjs's getAnalytics) -
// two tests sharing one relay within that window would read each other's stale snapshot, not a
// real bug in the feature itself.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestRelay, connectFakeAgent } from './test-relay.mjs';

async function withRelay(fn) {
  const relay = await startTestRelay();
  const tab = await connectFakeAgent(relay.port, { eval: () => ({ value: null }) });
  const api = async (method, route, body) => {
    const res = await fetch(`http://127.0.0.1:${relay.port}${route}`, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || `request failed: ${route}`);
    return json.result;
  };
  const command = (type, params) => api('POST', '/command', { type, params });
  try {
    await fn({ api, command });
  } finally {
    await tab.close();
    await relay.stop();
  }
}

test('eval calls that differ only by literal text collapse into one repeated shape, ranked by count', async () => {
  await withRelay(async ({ api, command }) => {
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
});

// Pins the normalization's known limits, since a fuzzy clusterer is only as trustworthy as its
// documented failure modes (see web-scout-roadmap.md's V43 entry: "a lead to design a real
// command around, not something to build from the normalized text alone"). Not a proposal to
// tighten it blindly - tightening in either direction trades one failure mode for the other
// (merge two genuinely different shapes vs. miss a real repeat), so this exists to make the
// CURRENT trade-off visible and regression-tested, not to declare it correct.
test('normalization limits: structurally different calls never merge; a renamed variable is NOT recognized as the same shape (documented gap)', async () => {
  await withRelay(async ({ api, command }) => {
    const s1 = (await api('POST', '/sessions', { goal: 'shape-distinct', context: 'analytics-eval-shapes.test.mjs' })).id;
    // Two genuinely different operations, each repeated - must rank as two separate shapes, not
    // collapse into one just because both contain a normalized STR placeholder.
    await command('eval', { expr: "document.querySelector('a').href" });
    await command('eval', { expr: "document.querySelector('b').href" });
    await command('eval', { expr: "localStorage.getItem('theme')" });
    await command('eval', { expr: "localStorage.getItem('lang')" });
    await api('POST', `/sessions/${s1}/end`);

    const a = await api('GET', '/analytics');
    const querySelectorShape = a.repeatedEvalShapes.find((s) => s.shape.includes('querySelector'));
    const localStorageShape = a.repeatedEvalShapes.find((s) => s.shape.includes('localStorage'));
    assert.ok(querySelectorShape && localStorageShape, 'both distinct shapes rank on their own');
    assert.notEqual(querySelectorShape.shape, localStorageShape.shape, 'two different operations never collapse into one shape');
    assert.equal(querySelectorShape.count, 2);
    assert.equal(localStorageShape.count, 2);
  });
});

test('normalization limits: a renamed variable around the same logic is NOT recognized as a repeat (documented gap, not yet tuned)', async () => {
  await withRelay(async ({ api, command }) => {
    // Known, deliberate limitation: normalization only replaces string/number literals, never
    // identifiers - the same logic under a renamed variable does not collapse. This is the
    // false-negative half of the merge/miss trade-off (the false-positive half is covered by the
    // "structurally different calls never merge" test above).
    const s1 = (await api('POST', '/sessions', { goal: 'shape-renamed', context: 'analytics-eval-shapes.test.mjs' })).id;
    await command('eval', { expr: "const rows = document.querySelectorAll('li'); rows.length" });
    await command('eval', { expr: "const items = document.querySelectorAll('li'); items.length" });
    await api('POST', `/sessions/${s1}/end`);

    const a = await api('GET', '/analytics');
    const renamedShape = a.repeatedEvalShapes.find((s) => s.shape.includes('querySelectorAll'));
    assert.equal(renamedShape, undefined, 'a variable rename is NOT collapsed by this normalization - known gap, not yet tuned');
  });
});
