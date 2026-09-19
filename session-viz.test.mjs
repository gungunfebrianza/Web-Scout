// The swimlane, episode tree and state machine are pure functions of stored rows - every rule the
// dashboard's three visualizations rely on is pinned here, without a relay or a browser.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSwimlane, buildEpisodes, buildStateMachine, buildSessionViz, targetOf,
  buildSequence, buildWaste, buildCostBreakdown, buildFailureHeatmap, buildCausality, buildRouteMachine,
} from './session-viz.mjs';

const BASE = Date.parse('2026-09-19T10:00:00.000Z');
let nextId = 1;
// `at` is seconds after BASE; ids ascend in the order rows are created, like the real table.
function act(type, at, { dur = 200, ok = true, agent = 'default', params = null, id, resultHash = null, intent = null, intentSource = null, intentCall = null, error = null, bytes = 0 } = {}) {
  return {
    id: id ?? nextId++, type, params, ok: ok ? 1 : 0, error: ok ? null : (error ?? 'boom'), agent_name: agent, result_hash: resultHash, params_hash: null,
    started_at: new Date(BASE + at * 1000).toISOString(), ended_at: new Date(BASE + at * 1000 + dur).toISOString(), duration_ms: dur,
    intent, intent_source: intentSource, intent_call: intentCall, bytes,
  };
}
const reset = () => { nextId = 1; };

describe('targetOf', () => {
  test('names what a call touched, shortest useful form', () => {
    assert.equal(targetOf({ selector: '#save' }), '#save');
    assert.equal(targetOf({ store: 'skills', key: 4 }), 'skills key=4');
    assert.equal(targetOf({ store: 'skills', row: { id: 9 } }), 'skills id=9');
    assert.equal(targetOf({ stores: ['a', 'b'] }), 'a,b');
    assert.equal(targetOf(null), '');
    assert.ok(targetOf({ expr: 'x'.repeat(200) }).length <= 60);
  });
});

describe('buildSwimlane', () => {
  test('one lane per agent, in first-seen order, with per-lane think time', () => {
    reset();
    const rows = [act('dom.query', 0, { dur: 1000 }), act('dom.click', 5, { dur: 500 }), act('idb.dump', 1, { agent: 'b', dur: 200 })];
    const s = buildSwimlane(rows);
    assert.deepEqual(s.lanes.map((l) => l.agent), ['default', 'b']);
    assert.equal(s.lanes[0].actions, 2);
    // 1s action then next call 5s in: 4s of thinking on that lane.
    assert.equal(s.gaps.length, 1);
    assert.equal(s.gaps[0].ms, 4000);
    assert.equal(s.gaps[0].kind, 'think');
    assert.equal(s.stats.thinkMs, 4000);
    assert.equal(s.bars.length, 3);
    assert.equal(s.bars[0].t0, 0);
  });

  test('a long absence is idle, not thinking, and is collapsed on the time axis', () => {
    reset();
    const s = buildSwimlane([act('dom.query', 0), act('dom.click', 600)]);
    assert.equal(s.stats.thinkMs, 0);
    assert.ok(s.stats.idleMs > 500_000);
    assert.equal(s.gaps[0].kind, 'idle');
    assert.deepEqual(s.segments.map((x) => x.collapsed), [false, true, false]);
    assert.equal(s.segments[0].t0, 0);
    assert.equal(s.segments[2].t1, s.span);
  });

  test('idle time is wall-clock, not summed per lane', () => {
    reset();
    const s = buildSwimlane([act('dom.query', 0), act('dom.query', 1, { agent: 'b' }), act('dom.click', 600), act('dom.click', 601, { agent: 'b' })]);
    assert.equal(s.gaps.filter((g) => g.kind === 'idle').length, 2, 'each lane was absent');
    assert.ok(s.stats.idleMs > 590_000 && s.stats.idleMs < 610_000, `one absence of ~600s, got ${s.stats.idleMs}`);
  });

  test('failed actions are counted per lane; an empty session yields an empty model', () => {
    reset();
    const s = buildSwimlane([act('dom.click', 0, { ok: false }), act('dom.click', 1)]);
    assert.equal(s.lanes[0].failed, 1);
    assert.equal(s.bars[0].ok, false);
    const empty = buildSwimlane([]);
    assert.deepEqual([empty.bars, empty.lanes, empty.segments], [[], [], []]);
  });

  test('the transcript why rides on the bar', () => {
    reset();
    const s = buildSwimlane([act('dom.click', 0, { intent: 'saving the form', intentSource: 'transcript' })]);
    assert.equal(s.bars[0].why, 'saving the form');
  });
});

describe('buildEpisodes', () => {
  test('explore, change, verify is one episode; the next change starts another', () => {
    reset();
    const rows = [
      act('dom.query', 0, { params: { selector: '#form' } }),
      act('dom.click', 2, { params: { selector: '#save' } }),
      act('idb.dump', 4, { params: { store: 'skills' } }),
      act('dom.click', 6, { params: { selector: '#next' } }),
    ];
    const { episodes } = buildEpisodes(rows);
    assert.equal(episodes.length, 2);
    assert.equal(episodes[0].kind, 'change+verify');
    assert.deepEqual(episodes[0].steps.map((s) => s.phase), ['explore', 'act', 'verify']);
    assert.equal(episodes[1].kind, 'change');
  });

  test('a quiet spell or a different agent splits episodes', () => {
    reset();
    const idle = buildEpisodes([act('dom.query', 0), act('dom.query', 120)]);
    assert.equal(idle.episodes.length, 2);
    reset();
    const agents = buildEpisodes([act('dom.query', 0), act('dom.query', 1, { agent: 'b' })]);
    assert.equal(agents.episodes.length, 2);
  });

  test('a failure followed by a success is a recovered episode, and the retry says so', () => {
    reset();
    const params = { selector: '#save' };
    const rows = [act('dom.click', 0, { ok: false, params, error: 'not found' }), act('dom.click', 1, { params })];
    const { episodes, why } = buildEpisodes(rows);
    assert.equal(episodes.length, 1);
    assert.equal(episodes[0].outcome, 'recovered');
    assert.match(why[2][0], /^retry #1/);
    assert.equal(why[2][1], 'inferred');
    const failedOnly = buildEpisodes([act('dom.click', 50, { ok: false })]);
    assert.equal(failedOnly.episodes[0].outcome, 'failed');
  });

  test("the agent's own words win over an inferred why, and its source is kept", () => {
    reset();
    const rows = [act('dom.click', 0, { intent: 'submitting the skill form', intentSource: 'transcript', params: { selector: '#save' } }), act('dom.query', 1)];
    const { episodes, why, stats } = buildEpisodes(rows);
    assert.deepEqual(why[1].slice(0, 2), ['submitting the skill form', 'transcript']);
    assert.equal(why[2][1], 'inferred');
    assert.equal(episodes[0].title, 'submitting the skill form');
    assert.equal(episodes[0].titleSource, 'transcript');
    assert.equal(stats.stepsWithTranscriptWhy, 1);
  });

  test('a title prefers a step the agent narrated itself over one that only inherited a note', () => {
    reset();
    const rows = [
      act('dom.query', 0, { intent: 'carried note', intentSource: 'transcript-carried', intentCall: 'c1' }),
      act('dom.click', 1, { intent: 'own words', intentSource: 'transcript', intentCall: 'c2', params: { selector: '#x' } }),
    ];
    const { episodes } = buildEpisodes(rows);
    assert.equal(episodes[0].title, 'own words');
    assert.equal(episodes[0].titleSource, 'transcript');
    const onlyCarried = buildEpisodes([act('dom.query', 100, { intent: 'carried note', intentSource: 'transcript-carried', intentCall: 'c3' })]);
    assert.equal(onlyCarried.episodes[0].titleSource, 'transcript-carried');
  });

  test('every action one tool call produced is one step (strict-CRV click = 4 rows)', () => {
    reset();
    const call = 'toolu_1';
    const rows = [
      act('idb.snapshot', 0, { params: { auto: true, phase: 'before' }, intentCall: call, intent: 'clicking save', intentSource: 'transcript' }),
      act('dom.click', 1, { params: { selector: '#save' }, intentCall: call, intent: 'clicking save', intentSource: 'transcript' }),
      act('idb.snapshot', 2, { params: { auto: true, phase: 'after' }, intentCall: call, intent: 'clicking save', intentSource: 'transcript' }),
      act('idb.diff', 2, { params: { auto: true }, intentCall: call, intent: 'clicking save', intentSource: 'transcript' }),
    ];
    const { episodes, stats } = buildEpisodes(rows);
    assert.equal(stats.steps, 1);
    assert.equal(episodes[0].steps[0].actionIds.length, 4);
    assert.equal(episodes[0].steps[0].type, 'dom.click');
  });

  test('strict-CRV machinery without a transcript still folds into the write it wraps', () => {
    reset();
    const rows = [
      act('idb.snapshot', 0, { params: { auto: true, phase: 'before' } }),
      act('dom.click', 1, { params: { selector: '#save' } }),
      act('idb.snapshot', 2, { params: { auto: true, phase: 'after' } }),
      act('idb.diff', 2, { params: { auto: true } }),
    ];
    const { stats, episodes } = buildEpisodes(rows);
    assert.equal(stats.steps, 1);
    assert.equal(episodes[0].steps[0].actionIds.length, 4);
  });

  test('a repeat read says whether the answer changed', () => {
    reset();
    const p = { store: 'skills' };
    const rows = [act('idb.dump', 0, { params: p, resultHash: 'a' }), act('dom.click', 1, { params: { selector: '#x' } }), act('idb.dump', 2, { params: p, resultHash: 'b' })];
    const { why } = buildEpisodes(rows);
    assert.match(why[3][0], /again after #1 - changed/);
  });

  test('episodes list the snapshots their actions took, for cross-highlighting', () => {
    reset();
    const rows = [act('dom.click', 0), act('idb.snapshot', 1, { params: { stores: ['a'] } })];
    const { episodes } = buildEpisodes(rows, { snapshots: [{ id: 77, action_id: rows[1].id }] });
    assert.deepEqual(episodes[0].snapshotIds, [77]);
  });

  test('liveness probes are not steps', () => {
    reset();
    const { stats } = buildEpisodes([act('ping', 0), act('dom.query', 1)]);
    assert.equal(stats.steps, 1);
  });
});

describe('buildStateMachine', () => {
  const snap = (id, actionId, hash, counts, extra = {}) => ({ id, action_id: actionId, content_hash: hash, counts, taken_at: new Date(BASE + id * 1000).toISOString(), agent_name: 'default', ...extra });

  test('no snapshots, no graph - and every action is reported as unanchored', () => {
    reset();
    const m = buildStateMachine({ actions: [act('dom.click', 0)], snapshots: [] });
    assert.deepEqual([m.nodes.length, m.edges.length, m.preSnapshotActions], [0, 0, 1]);
  });

  test('identical content is one node; a return to it is a revisit', () => {
    reset();
    const a1 = act('idb.snapshot', 0); const put = act('idb.put', 1, { params: { store: 'skills' } }); const a2 = act('idb.snapshot', 2);
    const del = act('idb.delete', 3, { params: { store: 'skills' } }); const a3 = act('idb.snapshot', 4);
    const m = buildStateMachine({
      actions: [a1, put, a2, del, a3],
      snapshots: [snap(1, a1.id, 'H0', { skills: 1 }), snap(2, a2.id, 'H1', { skills: 2 }), snap(3, a3.id, 'H0', { skills: 1 })],
    });
    assert.equal(m.nodes.length, 2);
    assert.equal(m.nodes[0].visits, 2);
    assert.deepEqual(m.path, ['n1', 'n2', 'n1']);
    assert.equal(m.stats.revisits, 1);
    const forward = m.edges.find((e) => e.from === 'n1' && e.to === 'n2');
    assert.deepEqual(forward.mutations.map((x) => x.type), ['idb.put']);
    assert.deepEqual(forward.summary, { skills: { added: 1, removed: 0, changed: 0 } });
    assert.equal(forward.summarySource, 'counts');
    assert.equal(m.current, 'n1');
  });

  test('a saved diff beats the row-count guess', () => {
    reset();
    const a1 = act('idb.snapshot', 0); const put = act('idb.patch', 1); const a2 = act('idb.snapshot', 2);
    const m = buildStateMachine({
      actions: [a1, put, a2],
      snapshots: [snap(1, a1.id, 'H0', { skills: 3 }), snap(2, a2.id, 'H1', { skills: 3 })],
      diffs: [{ snapshot_from_id: 1, snapshot_to_id: 2, summary: { skills: { added: 0, removed: 0, changed: 2 } } }],
    });
    const e = m.edges[0];
    assert.equal(e.summarySource, 'diff');
    assert.deepEqual(e.totals, { added: 0, removed: 0, changed: 2 });
  });

  test('a successful write between identical snapshots is flagged as having changed nothing', () => {
    reset();
    const a1 = act('idb.snapshot', 0); const click = act('dom.click', 1, { params: { selector: '#noop' } }); const a2 = act('idb.snapshot', 2);
    const m = buildStateMachine({ actions: [a1, click, a2], snapshots: [snap(1, a1.id, 'H', { s: 1 }), snap(2, a2.id, 'H', { s: 1 })] });
    assert.equal(m.nodes.length, 1);
    assert.equal(m.edges[0].noChange, true);
    assert.equal(m.stats.noopMutations, 1);
    assert.match(m.insights[0], /did not change/);
  });

  test('reads between snapshots are counted on the state they ran in, not drawn as transitions', () => {
    reset();
    const a1 = act('idb.snapshot', 0); const r1 = act('idb.dump', 1); const r2 = act('dom.query', 2); const a2 = act('idb.snapshot', 3);
    const m = buildStateMachine({ actions: [a1, r1, r2, a2], snapshots: [snap(1, a1.id, 'H', { s: 1 }), snap(2, a2.id, 'H', { s: 1 })] });
    assert.equal(m.nodes[0].reads.count, 2);
    assert.deepEqual(m.nodes[0].reads.types, { 'idb.dump': 1, 'dom.query': 1 });
    assert.equal(m.edges[0].mutations.length, 0);
  });

  test('a failed write is listed but not blamed for a change, and golden names surface on the node', () => {
    reset();
    const a1 = act('idb.snapshot', 0); const bad = act('idb.put', 1, { ok: false }); const a2 = act('idb.snapshot', 2);
    const m = buildStateMachine({ actions: [a1, bad, a2], snapshots: [snap(1, a1.id, 'H', { s: 1 }, { golden_name: 'baseline' }), snap(2, a2.id, 'H', { s: 1 })] });
    assert.equal(m.edges[0].failedMutations, 1);
    assert.equal(m.stats.noopMutations, 0);
    assert.deepEqual(m.nodes[0].golden, ['baseline']);
  });

  test('actions after the last snapshot belong to its state; snapshots without a hash stay distinct', () => {
    reset();
    const a1 = act('idb.snapshot', 0); const later = act('dom.query', 5);
    const m = buildStateMachine({ actions: [a1, later], snapshots: [snap(1, a1.id, null, { s: 1 }), snap(2, null, null, { s: 1 }, { taken_at: new Date(BASE + 9000).toISOString() })] });
    assert.equal(m.nodes.length, 2);
    const single = buildStateMachine({ actions: [a1, later], snapshots: [snap(1, a1.id, 'H', {})] });
    assert.equal(single.nodes[0].reads.count, 1);
  });
});

test('buildSessionViz assembles all three from one row set and flags a capped fetch', () => {
  reset();
  const rows = [act('dom.click', 0), act('idb.dump', 1)];
  const viz = buildSessionViz({ session: { id: 3, goal: 'g' }, actions: rows, snapshots: [], diffs: [], limit: 2 });
  assert.equal(viz.sessionId, 3);
  assert.equal(viz.truncated, true);
  assert.equal(viz.episodes.goal, 'g');
  assert.equal(viz.swimlane.bars.length, 2);
  assert.equal(viz.stateMachine.nodes.length, 0);
  assert.equal(buildSessionViz({ actions: rows, limit: 100 }).truncated, false);
  assert.ok(viz.sequence.messages.length === 2);
  assert.ok(viz.waste);
  assert.ok(viz.costTree);
  assert.ok(viz.failureHeatmap);
  assert.ok(viz.causality);
  assert.deepEqual(viz.routeMachine.nodes, []);
});

describe('buildSequence', () => {
  test('one message per call, in order, agents plus the page as participants', () => {
    reset();
    const rows = [act('dom.click', 0, { params: { selector: '#a' } }), act('idb.dump', 1, { agent: 'b', ok: false })];
    const s = buildSequence(rows);
    assert.deepEqual(s.participants, ['default', 'b', 'page']);
    assert.equal(s.messages.length, 2);
    assert.deepEqual(s.messages.map((m) => m.seq), [1, 2]);
    assert.equal(s.messages[0].target, '#a');
    assert.equal(s.messages[1].ok, false);
    assert.equal(s.stats.failed, 1);
  });

  test('liveness probes and strict-CRV internals are not messages', () => {
    reset();
    const rows = [act('ping', 0), act('idb.snapshot', 1, { params: { auto: true, phase: 'before' } }), act('dom.click', 2)];
    assert.equal(buildSequence(rows).messages.length, 1);
  });
});

describe('buildWaste', () => {
  test('a failed call with no retry is wasted on its own', () => {
    reset();
    const rows = [act('idb.put', 0, { ok: false, params: { store: 's' } })];
    const w = buildWaste(rows);
    assert.equal(w.retries.length, 1);
    assert.deepEqual([w.retries[0].attempts.length, w.retries[0].resolvedOk], [1, false]);
    assert.equal(w.totals.wastedCalls, 1);
  });

  test('a retry that succeeds counts only the failed attempt(s) as waste', () => {
    reset();
    const rows = [act('idb.put', 0, { ok: false, params: { store: 's' } }), act('idb.put', 1, { ok: true, params: { store: 's' } })];
    const w = buildWaste(rows);
    assert.equal(w.retries.length, 1);
    assert.deepEqual([w.retries[0].attempts, w.retries[0].resolvedOk], [[1, 2], true]);
    assert.equal(w.totals.wastedCalls, 1);
  });

  test('a re-read with an unchanged answer is a wasted duplicate; a changed one is not', () => {
    reset();
    const rows = [
      act('idb.dump', 0, { params: { store: 's' }, resultHash: 'H1' }),
      act('idb.dump', 1, { params: { store: 's' }, resultHash: 'H1' }),
      act('idb.dump', 2, { params: { store: 's' }, resultHash: 'H2' }),
    ];
    const w = buildWaste(rows);
    assert.equal(w.duplicateReads.length, 1);
    assert.deepEqual(w.duplicateReads[0].ids, [2]);
    assert.equal(w.duplicateReads[0].firstId, 1);
    assert.equal(w.totals.wastedCalls, 1);
  });

  test('a no-op mutation from the state machine is counted too', () => {
    reset();
    const rows = [act('dom.click', 0)];
    const w = buildWaste(rows, { stateMachine: { noopMutations: [{ id: 99, type: 'dom.click', target: '' }] } });
    assert.equal(w.noopMutations.length, 1);
    assert.equal(w.totals.wastedCalls, 1);
  });
});

describe('buildCostBreakdown', () => {
  test('groups delivered bytes by type and by agent, and ranks the worst offenders', () => {
    reset();
    const rows = [
      act('idb.dump', 0, { bytes: 1000 }),
      act('idb.dump', 1, { bytes: 100 }),
      act('dom.query', 2, { agent: 'b', bytes: 4000 }),
    ];
    const c = buildCostBreakdown(rows);
    assert.equal(c.totalBytes, 5100);
    assert.equal(c.byType[0].type, 'dom.query');
    assert.equal(c.byAgent[0].agent, 'b');
    assert.ok(Math.abs(c.byAgent[0].share - 4000 / 5100) < 1e-9);
    assert.equal(c.topCalls[0].bytes, 4000);
    assert.equal(c.topCalls.length, 3);
  });
});

describe('buildFailureHeatmap', () => {
  test('buckets by time, ranks types, and finds the worst cell', () => {
    reset();
    const rows = [
      ...[0, 0, 0, 0].map((_, i) => act('net.log', 0, { ok: i !== 3 })), // 1 of 4 fails
      ...[0, 0, 0, 0].map((_, i) => act('net.log', 100, { ok: false })), // 4 of 4 fail
    ];
    const h = buildFailureHeatmap(rows, { buckets: 2 });
    assert.equal(h.totals.calls, 8);
    assert.equal(h.totals.failed, 5);
    assert.equal(h.worst.bucket, 1);
    assert.equal(h.worst.failRate, 1);
  });

  test('types past the cap are folded into "other"', () => {
    reset();
    const types = Array.from({ length: 10 }, (_, i) => `t${i}`);
    const rows = types.map((t, i) => act(t, i));
    const h = buildFailureHeatmap(rows, { topTypes: 8 });
    assert.equal(h.rowTypes.length, 9);
    assert.ok(h.rowTypes.includes('other'));
  });

  test('no actions is an empty, not a crashing, result', () => {
    assert.deepEqual(buildFailureHeatmap([]).cells, []);
  });
});

describe('buildCausality', () => {
  test('a retry chains to its failure, and a verify chains to the write it checked', () => {
    reset();
    const rows = [
      act('idb.put', 0, { ok: false, params: { store: 's' } }),
      act('idb.put', 1, { ok: true, params: { store: 's' } }),
      act('idb.dump', 2),
      act('dom.query', 20), // unrelated, idle-split into its own episode, no cause - excluded
    ];
    const episodes = buildEpisodes(rows, { idleSplitMs: 5000 });
    const c = buildCausality(episodes);
    assert.deepEqual(c.roots, [1]);
    assert.deepEqual(c.childrenOf['1'], [2]);
    assert.deepEqual(c.childrenOf['2'], [3]);
    assert.equal(c.edges.find((e) => e.to === 2).kind, 'recovered');
    assert.equal(c.edges.find((e) => e.to === 3).kind, 'verifies');
    assert.equal(c.nodes.some((n) => n.id === 4), false);
    assert.equal(c.stats.chains, 1);
  });

  test('no episodes, no forest', () => {
    assert.deepEqual(buildCausality({ episodes: [] }), { nodes: [], edges: [], roots: [], childrenOf: {}, stats: { linkedActions: 0, chains: 0, edges: 0 } });
  });
});

describe('buildRouteMachine', () => {
  const click = (id, hrefBefore, href, hrefChanged = true) => ({ id, hrefChanged, hrefBefore, href });

  test('collapses to distinct routes and flags a return to one already visited', () => {
    const clicks = [
      click(1, 'https://app/#/home', 'https://app/#/list'),
      click(2, 'https://app/#/list', 'https://app/#/list', false),
      click(3, 'https://app/#/list', 'https://app/#/home'),
    ];
    const r = buildRouteMachine(clicks);
    assert.equal(r.nodes.length, 2);
    assert.deepEqual(r.path, ['r1', 'r2', 'r1']);
    assert.equal(r.stats.navigations, 2);
    assert.equal(r.stats.nonNavClicks, 1);
    assert.equal(r.stats.revisits, 1);
    assert.equal(r.current, 'r1');
  });

  test('no navigation, no graph', () => {
    assert.deepEqual(buildRouteMachine([click(1, null, null, false)]), { nodes: [], edges: [], path: [], current: null, stats: { navigations: 0, routes: 0, transitions: 0, revisits: 0, nonNavClicks: 1 } });
  });
});
