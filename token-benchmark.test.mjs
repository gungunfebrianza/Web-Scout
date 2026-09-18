// Token benchmark: a scripted CRV session (baseline -> action -> verify) against a
// fixture page, run twice through a real relay - once the way a caller reads by
// default, once with the read strategy this tool documents (warm-start briefing,
// peek then scope, --delta / --if-changed for the verify pass). What is measured is
// the bytes a caller would actually print (compact JSON), per CRV phase.
//
// Two assertions keep the tool honest:
//   * the DEFAULT path stays under NAIVE_BUDGET_BYTES - a change that makes
//     ordinary replies bigger (a verbose field, pretty-printing, a new envelope)
//     fails here instead of showing up as a bill later;
//   * the LEAN path stays under LEAN_MAX_RATIO of the default path - the read
//     strategy has to keep earning its keep.
// When a change legitimately moves the numbers, raise the constant in the same
// commit and say why; the table printed below is the evidence.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestRelay, connectFakeAgent } from './test-relay.mjs';

const NAIVE_BUDGET_BYTES = 160000; // measured 151901 (~38k tokens): 5% headroom, the run is deterministic
const LEAN_MAX_RATIO = 0.08; // measured 0.046 on this fixture - a best case for the strategy, not a forecast for real sessions

const relay = await startTestRelay();
const skipLive = relay.live ? 'skipped under WEBSCOUT_TEST_LIVE=1' : false;
const BASE = `http://127.0.0.1:${relay.port}`;
const tabs = [];
after(async () => { tabs.forEach((t) => t.close()); await relay.stop(); });

async function api(method, route, body) {
  const res = await fetch(`${BASE}${route}`, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  return (await res.json()).result;
}

// A small app: 40 stores, an orders store, a request log and one panel.
function makeFixture() {
  const fx = {
    orders: Array.from({ length: 150 }, (_, i) => ({ id: i + 1, status: i % 3 ? 'open' : 'done', owner: `customer-${i % 17}`, total: 100 + i * 7, createdAt: `2026-09-01T10:${String(i % 60).padStart(2, '0')}:00Z`, updatedAt: `2026-09-02T11:${String(i % 60).padStart(2, '0')}:00Z`, tags: ['web', i % 2 ? 'promo' : 'organic'], note: `order ${i + 1} placed through the storefront checkout` })),
    log: Array.from({ length: 120 }, (_, i) => ({ via: 'fetch', method: 'GET', url: `/api/orders?page=${i}`, status: 200, startedAt: `2026-09-02T11:00:${String(i % 60).padStart(2, '0')}.000Z`, endedAt: `2026-09-02T11:00:${String(i % 60).padStart(2, '0')}.120Z` })),
    panel: 'Orders: 150 open. Last sync ok.',
    clicked: false,
  };
  const scopedRows = (p) => {
    let rows = fx.orders;
    if (p.where) rows = rows.filter((r) => Object.entries(p.where).every(([k, v]) => JSON.stringify(r[k]) === JSON.stringify(v)));
    const matchedCount = rows.length;
    if (Number.isFinite(p.limit)) rows = rows.slice(0, p.limit);
    if (Array.isArray(p.fields)) rows = rows.map((r) => Object.fromEntries(p.fields.map((f) => [f, r[f]])));
    return { store: p.store, keyPath: 'id', totalCount: fx.orders.length, matchedCount, count: rows.length, rows };
  };
  const handlers = (state) => ({
    'idb.list': () => ({ stores: Array.from({ length: 40 }, (_, i) => (i === 0 ? 'orders' : `store_${i}`)), counts: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [i === 0 ? 'orders' : `store_${i}`, i === 0 ? fx.orders.length : i % 5 === 0 ? 0 : i * 3])) }),
    'db.version': () => ({ name: 'app', version: 42 }),
    'idb.dump': (p) => scopedRows(p),
    'net.log': (p) => {
      const entries = Number.isFinite(p.limit) ? fx.log.slice(-p.limit) : fx.log;
      return { count: entries.length, ...(entries.length < fx.log.length ? { total: fx.log.length } : {}), entries };
    },
    'dom.query': (p) => (p.meta ? { found: true, tag: 'section', id: 'panel', matchCount: 1 } : { found: true, tag: 'section', id: 'panel', outerHTML: `<section id="panel" class="panel">${fx.panel}${'<span class="badge">x</span>'.repeat(30)}</section>`, text: fx.panel }),
    'dom.click': () => {
      fx.clicked = true;
      fx.orders = fx.orders.map((r) => (r.id === 12 ? { ...r, status: 'shipped', updatedAt: '2026-09-02T12:00:00Z' } : r));
      fx.log = [...fx.log.slice(3), ...[0, 1, 2].map((i) => ({ via: 'fetch', method: 'POST', url: '/api/ship', status: 200, startedAt: `2026-09-02T12:00:0${i}.000Z`, endedAt: `2026-09-02T12:00:0${i}.090Z` }))];
      fx.panel = 'Orders: 149 open. Order 12 shipped.';
      state.epoch += 1;
      return { clicked: true };
    },
  });
  return { fx, handlers };
}

async function runSession(name, script) {
  const { fx, handlers } = makeFixture();
  const holder = { state: null };
  const tab = await connectFakeAgent(relay.port, new Proxy({}, { get: (_t, type) => handlers(holder.state)[type] }), { name, epoch: 0 });
  holder.state = tab.state;
  tabs.push(tab);
  const phases = { briefing: 0, baseline: 0, action: 0, verify: 0 };
  let phase = 'briefing';
  const call = async (type, params, opts) => {
    const res = await fetch(`${BASE}/command`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type, params, agent: name, opts }) });
    const json = await res.json();
    phases[phase] += JSON.stringify(json.result).length;
    return json.result;
  };
  const session = await api('POST', '/sessions', { goal: `token-benchmark ${name}`, context: 'automated', agent: name, briefing: script.briefing });
  if (session.briefing) phases.briefing += JSON.stringify(session.briefing).length;
  phase = 'baseline';
  await script.baseline(call);
  phase = 'action';
  await script.action(call);
  phase = 'verify';
  await script.verify(call);
  await api('POST', `/sessions/${session.id}/end`);
  return { phases, total: Object.values(phases).reduce((a, b) => a + b, 0), fx };
}

const PANEL = { selector: '#panel' };

// What a caller does with no flags: look around, dump, act, dump again, re-check.
const naive = {
  briefing: false,
  baseline: async (call) => {
    await call('idb.list', {});
    await call('idb.dump', { store: 'orders' });
    await call('net.log', {});
    await call('dom.query', PANEL);
  },
  action: async (call) => { await call('dom.click', PANEL); },
  verify: async (call) => {
    await call('idb.dump', { store: 'orders' });
    await call('net.log', {});
    await call('dom.query', PANEL);
    await call('idb.dump', { store: 'orders' }); // "did anything else change?" - nothing did
    await call('net.log', {});
  },
};

// The documented strategy: the briefing replaces the exploratory reads, the baseline
// reads only what the check needs, and the verify pass asks for changes, not bodies.
const SCOPE = { store: 'orders', fields: ['id', 'status', 'updatedAt'], limit: 30 };
const lean = {
  briefing: true,
  baseline: async (call) => {
    await call('idb.dump', { store: 'orders' }, { peek: true });
    await call('idb.dump', SCOPE, { delta: true });
    await call('net.log', { limit: 5 }, { delta: true });
    await call('dom.query', { ...PANEL, meta: true });
  },
  action: async (call) => { await call('dom.click', PANEL); },
  verify: async (call) => {
    await call('idb.dump', SCOPE, { delta: true });
    await call('net.log', { limit: 5 }, { delta: true });
    await call('dom.query', PANEL, { delta: true });
    await call('idb.dump', SCOPE, { delta: true });
    await call('net.log', { limit: 5 }, { delta: true });
  },
};

test('a scripted CRV session: default replies stay in budget and the read strategy earns its keep', { skip: skipLive, timeout: 60000 }, async (t) => {
  const a = await runSession('bench-naive', naive);
  const b = await runSession('bench-lean', lean);
  const row = (label, r) => `${label.padEnd(8)} briefing ${String(r.phases.briefing).padStart(6)}  baseline ${String(r.phases.baseline).padStart(6)}  action ${String(r.phases.action).padStart(4)}  verify ${String(r.phases.verify).padStart(6)}  total ${String(r.total).padStart(6)} bytes (~${Math.round(r.total / 4)} tokens)`;
  t.diagnostic(`\n${row('default', a)}\n${row('lean', b)}\nlean/default = ${(b.total / a.total).toFixed(3)}`);
  assert.ok(a.total <= NAIVE_BUDGET_BYTES, `default replies delivered ${a.total} bytes, over the ${NAIVE_BUDGET_BYTES}-byte budget - if this is intended, raise NAIVE_BUDGET_BYTES with the reason`);
  assert.ok(b.total / a.total <= LEAN_MAX_RATIO, `the read strategy delivered ${b.total} of ${a.total} bytes (${(b.total / a.total).toFixed(3)}), above the ${LEAN_MAX_RATIO} ceiling`);
  assert.ok(a.phases.verify > a.phases.baseline * 0.5, 'sanity: the default verify pass is about as heavy as its baseline, which is the waste the strategy targets');
});

test('the lean run reads the same facts: the delta carries the changed order and the new requests', { skip: skipLive, timeout: 60000 }, async () => {
  const name = 'bench-facts';
  const holder = { state: null };
  const { handlers } = makeFixture();
  const tab = await connectFakeAgent(relay.port, new Proxy({}, { get: (_t, type) => handlers(holder.state)[type] }), { name, epoch: 0 });
  holder.state = tab.state;
  tabs.push(tab);
  const s = await api('POST', '/sessions', { goal: 'token-benchmark facts', context: 'automated', agent: name, briefing: false });
  const call = async (type, params, opts) => api('POST', '/command', { type, params, agent: name, opts });
  const before = await call('idb.dump', SCOPE, { delta: true });
  assert.equal(before.rows.length, 30);
  await call('dom.click', PANEL);
  const d = await call('idb.dump', SCOPE, { delta: true });
  assert.equal(d.__delta, true);
  assert.deepEqual(d.arrays.rows.changed.map((r) => [r.id, r.status]), [[12, 'shipped']]);
  await api('POST', `/sessions/${s.id}/end`);
});
