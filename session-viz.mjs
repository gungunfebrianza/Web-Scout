// Pure models behind the dashboard's session visualizations. No I/O, no DOM: rows in, plain
// JSON out, so every rule here is unit-testable and the relay can serve the result as-is.
//
//   buildSwimlane(actions)            - one lane per agent, a bar per action, per-lane think time
//   buildEpisodes(actions, opts)      - goal > episode > step > action tree, plus a "why" per action
//                                       and a "caused by" link per step (see buildCausality)
//   buildStateMachine({actions, snapshots, diffs})
//                                     - nodes are distinct snapshot CONTENT, edges are what happened
//                                       between two snapshots (the state graph a session walked)
//   buildSequence(actions)            - a UML-style sequence diagram: each agent against "the page",
//                                       call then return, in strict order (not time-scaled)
//   buildWaste(actions, opts)         - failed calls, duplicate re-reads that came back unchanged,
//                                       and no-op writes - the calls that bought nothing
//   buildCostBreakdown(actions)       - delivered bytes/tokens grouped by type and by agent, plus
//                                       the single most expensive calls (an icicle's own numbers)
//   buildFailureHeatmap(actions, opts) - call type x time bucket, for where in the session failures
//                                       clustered (distinct from the dashboard's cross-SESSION one)
//   buildCausality(episodes)          - the causedBy links buildEpisodes attaches, reshaped into a
//                                       forest: a retry points at the failure it followed, a verify
//                                       at the change it checked, a recovery at the failure it fixed
//   buildRouteMachine(clicks)         - like buildStateMachine, but nodes are pages/routes the
//                                       session navigated between (see db.listClickNavigations)
//   buildSessionViz(...)              - all of the above, from one row set
//   buildRecordedRepairEdges(actions) - self-repair loop's own fixed_by/confirmed_by edges (ground
//                                       truth the loop declared, NOT inferred - see webscout2.md)
//   diffCausality(actionsA, actionsB) - two sessions' causality trees diffed by edge identity, for
//                                       the self-repair loop's confirm-fix step
//
// Inputs are the lightweight rows db.listActionsForViz / listSnapshots / listDiffs / listClickNavigations
// return. A "why" is either the agent's own words (actions.intent, imported from its transcript -
// see intent-import.mjs) or an inferred one derived from the call sequence; each carries its source
// so the UI never presents a guess as the agent's reasoning.

import { MUTATING_TYPES } from './command-registry.mjs';
import { baselineTokens } from './token-estimate.mjs';

const toMs = (iso) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};
const clip = (s, n) => {
  const str = String(s ?? '').replace(/\s+/g, ' ').trim();
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
};

// Calls that say nothing about what the agent is doing (liveness probes).
const NOISE_TYPES = new Set(['ping', 'page.epoch']);
// Calls that block until something happens - a different kind of step than a read.
const WAIT_TYPES = new Set(['dom.wait', 'dom.settle', 'dom.pick', 'idb.wait', 'net.wait', 'console.wait']);
// Strict-CRV logs an auto snapshot before and after a write, plus an auto diff. They are part of
// the write, not steps of their own.
const isInternal = (a) => a.params?.auto === true;

// One short "what did this touch" label, same fields the Action log's Target column reads.
export function targetOf(params) {
  const p = params && typeof params === 'object' ? params : {};
  const parts = [];
  if (p.selector) parts.push(String(p.selector));
  if (p.store) parts.push(String(p.store));
  if (p.key !== undefined && p.key !== null && typeof p.key !== 'object') parts.push(`key=${p.key}`);
  else if (p.row && typeof p.row === 'object' && p.row.id !== undefined) parts.push(`id=${p.row.id}`);
  if (p.urlPattern) parts.push(String(p.urlPattern));
  if (p.substr) parts.push(String(p.substr));
  if (p.expr) parts.push(String(p.expr));
  if (p.question) parts.push(String(p.question));
  if (!parts.length && Array.isArray(p.stores) && p.stores.length) parts.push(p.stores.join(','));
  return clip(parts.join(' '), 60);
}

function ascending(actions) {
  return [...actions].sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
}

// ---------------------------------------------------------------- swimlane

// Idle gaps longer than this are drawn collapsed: a session left open for lunch should not squash
// every real action into one pixel. The gap is still counted, as idle rather than thinking.
export const DEFAULT_COLLAPSE_GAP_MS = 60_000;

export function buildSwimlane(actions, { collapseGapMs = DEFAULT_COLLAPSE_GAP_MS } = {}) {
  const rows = ascending(actions).filter((a) => toMs(a.started_at) !== null);
  if (!rows.length) {
    return { origin: null, span: 0, lanes: [], bars: [], gaps: [], segments: [], stats: { busyMs: 0, thinkMs: 0, idleMs: 0, thinkShare: 0, longestGaps: [] } };
  }
  const origin = Math.min(...rows.map((a) => toMs(a.started_at)));
  const laneNames = [];
  const bars = rows.map((a) => {
    const agent = a.agent_name ?? 'default';
    if (!laneNames.includes(agent)) laneNames.push(agent);
    const start = toMs(a.started_at) - origin;
    const ended = toMs(a.ended_at);
    const dur = Math.max(0, Number.isFinite(a.duration_ms) ? a.duration_ms : (ended !== null ? ended - toMs(a.started_at) : 0));
    return {
      id: a.id, lane: laneNames.indexOf(agent), type: a.type, ok: !!a.ok,
      t0: start, t1: Math.max(start + dur, ended !== null ? ended - origin : 0), ms: dur,
      ...(a.intent ? { why: clip(a.intent, 160) } : {}),
    };
  });

  const lanes = laneNames.map((agent) => ({ agent, actions: 0, failed: 0, busyMs: 0, thinkMs: 0 }));
  const gaps = [];
  const lastEnd = new Map();
  for (const b of bars) {
    const lane = lanes[b.lane];
    lane.actions += 1;
    if (!b.ok) lane.failed += 1;
    lane.busyMs += b.t1 - b.t0;
    const prev = lastEnd.get(b.lane);
    if (prev && b.t0 > prev.t1) {
      const ms = b.t0 - prev.t1;
      // "think" = the agent went away and came back; "idle" = nobody was here at all.
      const kind = ms > collapseGapMs ? 'idle' : 'think';
      gaps.push({ lane: b.lane, fromId: prev.id, toId: b.id, t0: prev.t1, t1: b.t0, ms, kind });
      if (kind === 'think') lane.thinkMs += ms;
    }
    lastEnd.set(b.lane, b);
  }

  // Time axis: union of every busy interval, with any gap between them wider than collapseGapMs
  // turned into a collapsed segment the renderer draws at fixed width.
  const span = Math.max(...bars.map((b) => b.t1));
  const union = bars.map((b) => [b.t0, b.t1]).sort((a, b) => a[0] - b[0]);
  const segments = [];
  let segStart = 0;
  let cursor = union[0][1];
  for (const [t0, t1] of union) {
    if (t0 - cursor > collapseGapMs) {
      segments.push({ t0: segStart, t1: cursor, collapsed: false });
      segments.push({ t0: cursor, t1: t0, collapsed: true });
      segStart = t0;
    }
    cursor = Math.max(cursor, t1);
  }
  segments.push({ t0: segStart, t1: Math.max(cursor, span), collapsed: false });

  const busyMs = lanes.reduce((s, l) => s + l.busyMs, 0);
  const thinkMs = lanes.reduce((s, l) => s + l.thinkMs, 0);
  // Idle is wall-clock time when NOBODY called anything - read off the collapsed axis segments,
  // not summed per lane (two agents both absent for ten minutes is ten idle minutes, not twenty).
  const idleMs = segments.filter((s) => s.collapsed).reduce((n, s) => n + (s.t1 - s.t0), 0);
  return {
    origin: new Date(origin).toISOString(), span, lanes, bars, gaps, segments,
    stats: {
      busyMs, thinkMs, idleMs,
      thinkShare: busyMs + thinkMs > 0 ? thinkMs / (busyMs + thinkMs) : 0,
      longestGaps: gaps.filter((g) => g.kind === 'think').sort((a, b) => b.ms - a.ms).slice(0, 3).map((g) => ({ fromId: g.fromId, toId: g.toId, ms: g.ms })),
    },
  };
}

// ---------------------------------------------------------------- episodes

// An episode is one thing the agent was trying to do: look around, change something, check that
// the change took. A new one starts when the agent changes, when it goes quiet for a while, or when
// it starts a new change after already having verified the last one.
export const DEFAULT_EPISODE_IDLE_MS = 30_000;

function makeStep(row) {
  return { rows: [row] };
}

// Folds a strict-CRV call's own machinery into the step it belongs to, and folds every action a
// single transcript tool call produced into one step.
function buildSteps(rows) {
  const steps = [];
  let carry = [];
  for (const row of rows) {
    if (NOISE_TYPES.has(row.type)) continue;
    const last = steps[steps.length - 1];
    if (isInternal(row)) {
      if (row.params?.phase === 'before') carry.push(row);
      else if (last) last.rows.push(row);
      else carry.push(row);
      continue;
    }
    const sameCall = last && row.intent_call && last.rows.some((r) => r.intent_call === row.intent_call);
    if (sameCall) { last.rows.push(row); continue; }
    const step = makeStep(row);
    if (carry.length) { step.rows.unshift(...carry); carry = []; }
    steps.push(step);
  }
  if (carry.length) steps.push({ rows: carry });
  return steps.map((s) => finishStep(s));
}

function finishStep(step) {
  const rows = step.rows;
  const primary = rows.find((r) => !isInternal(r)) ?? rows[0];
  const started = Math.min(...rows.map((r) => toMs(r.started_at) ?? Infinity));
  const ended = Math.max(...rows.map((r) => toMs(r.ended_at) ?? toMs(r.started_at) ?? 0));
  const withIntent = rows.find((r) => r.intent);
  return {
    id: primary.id,
    actionIds: rows.map((r) => r.id),
    agent: primary.agent_name ?? 'default',
    type: primary.type,
    types: [...new Set(rows.map((r) => r.type))],
    params: primary.params ?? null,
    paramsKey: primary.params_hash ?? JSON.stringify(primary.params ?? null),
    resultHash: primary.result_hash ?? null,
    target: targetOf(primary.params),
    ok: rows.every((r) => !!r.ok),
    error: rows.find((r) => !r.ok)?.error ?? null,
    mutating: rows.some((r) => !isInternal(r) && MUTATING_TYPES.has(r.type)),
    waiting: WAIT_TYPES.has(primary.type),
    t0: started, t1: ended, ms: Math.max(0, ended - started),
    intent: withIntent?.intent ?? null,
    intentSource: withIntent?.intent_source ?? null,
  };
}

function classify(step, episode) {
  if (episode.failedOpen) return 'recover';
  if (step.mutating) return 'act';
  if (step.waiting) return episode.hasAct ? 'verify' : 'wait';
  return episode.hasAct ? 'verify' : 'explore';
}

const PHASE_LABEL = { explore: 'Explore', wait: 'Wait', change: 'Change', 'change+verify': 'Change + verify' };

export function buildEpisodes(actions, { idleSplitMs = DEFAULT_EPISODE_IDLE_MS, snapshots = [], goal = null } = {}) {
  const steps = buildSteps(ascending(actions));
  const snapshotByAction = new Map();
  for (const s of snapshots) if (s.action_id != null) snapshotByAction.set(s.action_id, s.id);

  const episodes = [];
  let cur = null;
  const seen = new Map(); // paramsKey -> last step that ran it (repeat / re-check detection)
  let lastActStep = null;
  let prev = null;

  for (const step of steps) {
    const gap = prev ? step.t0 - prev.t1 : 0;
    const agentChanged = prev && prev.agent !== step.agent;
    const newActAfterVerify = cur && cur.phase === 'verify' && step.mutating;
    if (!cur || agentChanged || gap > idleSplitMs || newActAfterVerify) {
      cur = { steps: [], hasAct: false, hasVerify: false, failed: 0, failedOpen: false, phase: 'explore', agent: step.agent };
      episodes.push(cur);
    }
    const phase = classify(step, cur);
    step.phase = phase;
    // Inferred why - only used when the transcript supplied none.
    step.why = step.intent
      ? { text: step.intent, source: step.intentSource ?? 'transcript' }
      : { text: inferWhy(step, { prev, phase, seen, lastActStep }), source: 'inferred' };
    // The single most direct thing that made this step run - reshaped into a forest by
    // buildCausality. Computed with the same signals as inferWhy, before `seen` moves on.
    step.causedBy = causeOf(step, { prev, phase, seen, lastActStep });

    if (step.mutating) { cur.hasAct = true; lastActStep = step; }
    if (phase === 'verify') cur.hasVerify = true;
    if (!step.ok) { cur.failed += 1; cur.failedOpen = true; } else if (cur.failedOpen) cur.failedOpen = false;
    cur.phase = phase === 'recover' ? cur.phase : phase;
    cur.steps.push(step);
    seen.set(step.paramsKey + step.type, step);
    prev = step;
  }

  const shaped = episodes.map((ep, i) => shapeEpisode(ep, i + 1, snapshotByAction));
  const why = {};
  for (const ep of shaped) {
    for (const st of ep.steps) for (const id of st.actionIds) why[id] = [st.why.text, st.why.source, ep.index];
  }
  const withTranscript = steps.filter((s) => s.why.source !== 'inferred').length;
  return {
    goal,
    episodes: shaped,
    why,
    stats: {
      episodes: shaped.length, steps: steps.length, actions: steps.reduce((n, s) => n + s.actionIds.length, 0),
      failedEpisodes: shaped.filter((e) => e.outcome === 'failed').length,
      recoveredEpisodes: shaped.filter((e) => e.outcome === 'recovered').length,
      stepsWithTranscriptWhy: withTranscript,
    },
  };
}

// The evidence is the same inferWhy already gathers: a failed step just before (this one retried
// it or, having succeeded, recovered from it), a prior attempt of the exact same call, or the
// mutating step a verify-phase step is checking on. Only one cause per step - the most direct one -
// so the result is a forest, not a full dependency graph.
function causeOf(step, { prev, phase, seen, lastActStep }) {
  const again = seen.get(step.paramsKey + step.type);
  if (again && !again.ok) return { id: again.id, kind: step.ok ? 'recovered' : 'retried' };
  if (phase === 'verify' && lastActStep) return { id: lastActStep.id, kind: 'verifies' };
  if (prev && !prev.ok && (!again || again.id !== prev.id)) return { id: prev.id, kind: 'follows-failure' };
  return null;
}

function inferWhy(step, { prev, phase, seen, lastActStep }) {
  const t = step.target ? ` ${step.target}` : '';
  if (prev && !prev.ok) {
    if (prev.type === step.type && prev.paramsKey === step.paramsKey) return `retry #${prev.id}: ${clip(prev.error, 50) || 'it failed'}`;
    return `recover after #${prev.id} failed${prev.error ? ` (${clip(prev.error, 40)})` : ''}`;
  }
  const again = seen.get(step.paramsKey + step.type);
  if (again && !step.mutating) {
    const same = again.resultHash && step.resultHash && again.resultHash === step.resultHash;
    return `${step.type}${t} again after #${again.id}${again.resultHash && step.resultHash ? (same ? ' - unchanged' : ' - changed') : ''}`;
  }
  if (phase === 'verify' && lastActStep) return `check ${lastActStep.type}${lastActStep.target ? ` ${lastActStep.target}` : ''} (#${lastActStep.id}) took effect`;
  if (phase === 'wait' || step.waiting) return `wait for${t || ` ${step.type}`}`;
  if (step.mutating) return `change${t || ' state'} via ${step.type}`;
  return `read${t || ` ${step.type}`}`;
}

function shapeEpisode(ep, index, snapshotByAction) {
  const first = ep.steps[0];
  const last = ep.steps[ep.steps.length - 1];
  const kind = ep.hasAct ? (ep.hasVerify ? 'change+verify' : 'change') : (ep.steps.every((s) => s.phase === 'wait') ? 'wait' : 'explore');
  const outcome = !last.ok ? 'failed' : (ep.failed ? 'recovered' : 'ok');
  // A step the agent narrated itself makes a better title than one that only inherited a note.
  const narrated = ep.steps.find((s) => s.why.source === 'transcript') ?? ep.steps.find((s) => s.why.source !== 'inferred');
  const topTarget = mostCommon(ep.steps.map((s) => s.target).filter(Boolean));
  const snapshotIds = [];
  for (const st of ep.steps) for (const id of st.actionIds) if (snapshotByAction.has(id)) snapshotIds.push(snapshotByAction.get(id));
  return {
    id: `e${index}`, index, agent: ep.agent, kind, label: PHASE_LABEL[kind] ?? kind, outcome,
    title: narrated ? narrated.why.text : `${PHASE_LABEL[kind] ?? kind}${topTarget ? ` · ${topTarget}` : ''}`,
    titleSource: narrated ? narrated.why.source : 'inferred',
    t0: first.t0, t1: last.t1, ms: Math.max(0, last.t1 - first.t0),
    startedAt: new Date(first.t0).toISOString(),
    counts: {
      steps: ep.steps.length, actions: ep.steps.reduce((n, s) => n + s.actionIds.length, 0), failed: ep.failed,
      mutations: ep.steps.filter((s) => s.mutating).length, reads: ep.steps.filter((s) => !s.mutating).length,
    },
    snapshotIds,
    steps: ep.steps.map((s) => ({
      id: s.id, actionIds: s.actionIds, type: s.type, types: s.types, target: s.target, ok: s.ok, phase: s.phase, ms: s.ms,
      why: s.why, causedBy: s.causedBy ?? null, ...(s.ok ? {} : { error: clip(s.error, 120) }),
    })),
  };
}

function mostCommon(list) {
  const counts = new Map();
  for (const v of list) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = null;
  for (const [v, n] of counts) if (!best || n > best[1]) best = [v, n];
  return best ? best[0] : null;
}

// ------------------------------------------------------------ state machine

const MAX_NODES = 60;

const safeParse = (json) => {
  if (!json || typeof json !== 'string') return null;
  try { return JSON.parse(json); } catch { return null; }
};
const sumRows = (counts) => Object.values(counts ?? {}).reduce((s, n) => s + (Number(n) || 0), 0);

function addSummary(into, summary) {
  for (const [store, c] of Object.entries(summary ?? {})) {
    const slot = (into[store] ??= { added: 0, removed: 0, changed: 0 });
    slot.added += c.added ?? 0;
    slot.removed += c.removed ?? 0;
    slot.changed += c.changed ?? 0;
  }
}
const totalsOf = (summary) => Object.values(summary).reduce((t, c) => ({ added: t.added + c.added, removed: t.removed + c.removed, changed: t.changed + c.changed }), { added: 0, removed: 0, changed: 0 });

// Row-count difference between two snapshots - all a pair with no saved diff can say. It is a net
// figure (a row replaced by another is invisible), which is why the edge records its source.
function countsSummary(fromCounts, toCounts) {
  const out = {};
  for (const store of new Set([...Object.keys(fromCounts ?? {}), ...Object.keys(toCounts ?? {})])) {
    const delta = (toCounts?.[store] ?? 0) - (fromCounts?.[store] ?? 0);
    if (delta > 0) out[store] = { added: delta, removed: 0, changed: 0 };
    else if (delta < 0) out[store] = { added: 0, removed: -delta, changed: 0 };
  }
  return out;
}

export function buildStateMachine({ actions = [], snapshots = [], diffs = [] } = {}) {
  const acts = ascending(actions);
  const snaps = [...snapshots].sort((a, b) => a.id - b.id);
  const empty = { nodes: [], edges: [], path: [], current: null, preSnapshotActions: acts.length, stats: { snapshots: snaps.length, nodes: 0, edges: 0, revisits: 0, noChangeTransitions: 0, noopMutations: 0 }, insights: [], truncatedNodes: 0 };
  if (!snaps.length) return empty;

  const indexById = new Map(acts.map((a, i) => [a.id, i]));
  const lowerBoundByTime = (iso) => {
    const t = toMs(iso);
    if (t === null) return acts.length;
    const i = acts.findIndex((a) => (toMs(a.started_at) ?? 0) >= t);
    return i === -1 ? acts.length : i;
  };
  // Where in the action sequence each snapshot sits: `before` = first index at/after it,
  // `after` = first index past the snapshot's own action.
  const pos = snaps.map((s) => {
    const at = s.action_id != null ? indexById.get(s.action_id) : undefined;
    return at !== undefined ? { before: at, after: at + 1 } : (() => { const i = lowerBoundByTime(s.taken_at); return { before: i, after: i }; })();
  });

  const nodes = [];
  const nodeByKey = new Map();
  const snapNode = new Map();
  const path = [];
  for (const s of snaps) {
    const key = s.content_hash || `snap:${s.id}`;
    let node = nodeByKey.get(key);
    if (!node) {
      const counts = s.counts ?? safeParse(s.counts_json) ?? {};
      node = {
        id: `n${nodes.length + 1}`, index: nodes.length + 1, hash: s.content_hash ?? null,
        snapshotIds: [], firstSnapshotId: s.id, lastSnapshotId: s.id, visits: 0, counts, totalRows: sumRows(counts),
        golden: [], agents: [], firstAt: s.taken_at, lastAt: s.taken_at, where: safeParse(s.where_json) ?? null,
        reads: { count: 0, types: {} },
      };
      nodes.push(node);
      nodeByKey.set(key, node);
    }
    node.snapshotIds.push(s.id);
    node.lastSnapshotId = s.id;
    node.lastAt = s.taken_at;
    node.visits += 1;
    if (s.golden_name && !node.golden.includes(s.golden_name)) node.golden.push(s.golden_name);
    if (s.agent_name && !node.agents.includes(s.agent_name)) node.agents.push(s.agent_name);
    snapNode.set(s.id, node);
    path.push(node.id);
  }

  // Saved diffs win over a row-count guess: by exact snapshot pair, then by content-hash pair.
  const snapById = new Map(snaps.map((s) => [s.id, s]));
  const diffByPair = new Map();
  const diffByHashPair = new Map();
  for (const d of diffs) {
    const summary = d.summary ?? safeParse(d.summary_json) ?? {};
    diffByPair.set(`${d.snapshot_from_id}>${d.snapshot_to_id}`, summary);
    const a = snapById.get(d.snapshot_from_id);
    const b = snapById.get(d.snapshot_to_id);
    if (a?.content_hash && b?.content_hash) diffByHashPair.set(`${a.content_hash}>${b.content_hash}`, summary);
  }

  const edges = new Map();
  const noopMutationIds = [];
  const countRead = (node, a) => {
    if (NOISE_TYPES.has(a.type) || isInternal(a) || MUTATING_TYPES.has(a.type)) return;
    node.reads.count += 1;
    node.reads.types[a.type] = (node.reads.types[a.type] ?? 0) + 1;
  };

  for (let i = 0; i < snaps.length - 1; i += 1) {
    const from = snapNode.get(snaps[i].id);
    const to = snapNode.get(snaps[i + 1].id);
    const between = acts.slice(pos[i].after, Math.max(pos[i].after, pos[i + 1].before));
    const mutations = [];
    for (const a of between) {
      if (NOISE_TYPES.has(a.type) || isInternal(a)) continue;
      if (MUTATING_TYPES.has(a.type)) mutations.push({ id: a.id, type: a.type, ok: !!a.ok, target: targetOf(a.params) });
      else countRead(from, a);
    }
    const key = `${from.id}>${to.id}`;
    let edge = edges.get(key);
    if (!edge) {
      edge = { from: from.id, to: to.id, count: 0, noChange: from === to, mutations: [], mutationTypes: {}, failedMutations: 0, summary: {}, summarySource: from === to ? 'identical' : 'none', pairs: [] };
      edges.set(key, edge);
    }
    edge.count += 1;
    edge.pairs.push([snaps[i].id, snaps[i + 1].id]);
    for (const m of mutations) {
      if (edge.mutations.length < 50) edge.mutations.push(m);
      edge.mutationTypes[m.type] = (edge.mutationTypes[m.type] ?? 0) + 1;
      if (!m.ok) edge.failedMutations += 1;
    }
    if (from === to) {
      for (const m of mutations) if (m.ok) noopMutationIds.push(m);
    } else {
      const saved = diffByPair.get(`${snaps[i].id}>${snaps[i + 1].id}`)
        ?? (snaps[i].content_hash && snaps[i + 1].content_hash ? diffByHashPair.get(`${snaps[i].content_hash}>${snaps[i + 1].content_hash}`) : undefined);
      const source = saved ? 'diff' : 'counts';
      addSummary(edge.summary, saved ?? countsSummary(snaps[i].counts, snaps[i + 1].counts));
      // One edge can aggregate several transitions; say so when they were not all measured alike.
      edge.summarySource = edge.summarySource === 'none' ? source : (edge.summarySource === source ? source : 'mixed');
    }
  }
  // Anything after the last snapshot happened in the state it left behind.
  const lastNode = snapNode.get(snaps[snaps.length - 1].id);
  for (const a of acts.slice(pos[snaps.length - 1].after)) countRead(lastNode, a);

  let edgeList = [...edges.values()].map((e) => ({ ...e, totals: totalsOf(e.summary) }));
  let shownNodes = nodes;
  let truncatedNodes = 0;
  if (nodes.length > MAX_NODES) {
    // Keep the most recently visited states; the older ones scroll off like the Action log's cap.
    shownNodes = [...nodes].sort((a, b) => b.lastSnapshotId - a.lastSnapshotId).slice(0, MAX_NODES).sort((a, b) => a.index - b.index);
    const keep = new Set(shownNodes.map((n) => n.id));
    edgeList = edgeList.filter((e) => keep.has(e.from) && keep.has(e.to));
    truncatedNodes = nodes.length - shownNodes.length;
  }

  const revisits = path.filter((id, i) => path.indexOf(id) !== i && path[i - 1] !== id).length;
  const noChangeTransitions = edgeList.filter((e) => e.noChange).reduce((n, e) => n + e.count, 0);
  const insights = [];
  if (noopMutationIds.length) {
    insights.push(`${noopMutationIds.length} successful write call(s) ran between two identical snapshots - the state did not change: ${noopMutationIds.slice(0, 5).map((m) => `#${m.id} ${m.type}`).join(', ')}${noopMutationIds.length > 5 ? ', …' : ''}`);
  }
  if (revisits) insights.push(`${revisits} return(s) to a state already seen - the session went back to where it had been`);
  return {
    nodes: shownNodes, edges: edgeList, path, current: lastNode.id,
    preSnapshotActions: acts.slice(0, pos[0].before).filter((a) => !NOISE_TYPES.has(a.type)).length,
    stats: { snapshots: snaps.length, nodes: nodes.length, edges: edgeList.length, revisits, noChangeTransitions, noopMutations: noopMutationIds.length },
    insights, truncatedNodes,
    // The raw list behind stats.noopMutations - buildWaste folds these into its own totals.
    noopMutations: noopMutationIds,
  };
}

// -------------------------------------------------------------- sequence diagram

const PAGE_PARTICIPANT = 'page';

// One lifeline per agent plus "the page", in strict call order (not time-scaled - that's the
// swimlane's job). Each message is a call/return pair: distinct value even for a single agent,
// since it reads as a request/response log rather than a Gantt chart.
export function buildSequence(actions) {
  const rows = ascending(actions).filter((a) => !NOISE_TYPES.has(a.type) && !isInternal(a));
  const agents = [];
  const messages = rows.map((a, i) => {
    const agent = a.agent_name ?? 'default';
    if (!agents.includes(agent)) agents.push(agent);
    return {
      id: a.id, seq: i + 1, agent, type: a.type, target: targetOf(a.params), ok: !!a.ok,
      ms: Number.isFinite(a.duration_ms) ? a.duration_ms : 0,
      mutating: MUTATING_TYPES.has(a.type),
      ...(a.intent ? { why: clip(a.intent, 140) } : {}),
    };
  });
  return {
    participants: [...agents, PAGE_PARTICIPANT], page: PAGE_PARTICIPANT, messages,
    stats: { messages: messages.length, participants: agents.length, failed: messages.filter((m) => !m.ok).length },
  };
}

// -------------------------------------------------------------- waste and retries

// What the session paid for and got nothing from: a failed call (retried or not), a re-read whose
// answer had not changed, a write that ran but changed nothing (from buildStateMachine, when given).
export function buildWaste(actions, { stateMachine = null } = {}) {
  const steps = buildSteps(ascending(actions));
  let openChain = null;
  const retryChains = [];
  const dupSeen = new Map(); // paramsKey+type -> { firstId, resultHash }
  const dupEntries = new Map(); // firstId -> entry
  for (const step of steps) {
    if (openChain && openChain.type === step.type && openChain.paramsKey === step.paramsKey) {
      openChain.attempts.push(step.id);
      openChain.ms += step.ms;
      if (step.ok) { openChain.resolvedId = step.id; openChain.resolvedOk = true; retryChains.push(openChain); openChain = null; }
      else if (step.error) openChain.error = step.error;
    } else if (!step.ok) {
      if (openChain) retryChains.push(openChain); // a different call intervened - the old chain ends unresolved
      openChain = { type: step.type, target: step.target, paramsKey: step.paramsKey, error: step.error, attempts: [step.id], ms: step.ms, resolvedId: null, resolvedOk: false };
    } else if (openChain) {
      retryChains.push(openChain);
      openChain = null;
    }
    if (!step.mutating && step.ok) {
      const key = step.paramsKey + step.type;
      const prevSeen = dupSeen.get(key);
      const isDup = prevSeen && prevSeen.resultHash && step.resultHash && prevSeen.resultHash === step.resultHash;
      if (isDup) {
        let entry = dupEntries.get(prevSeen.firstId);
        if (!entry) { entry = { type: step.type, target: step.target, firstId: prevSeen.firstId, resultHash: step.resultHash, ids: [] }; dupEntries.set(prevSeen.firstId, entry); }
        entry.ids.push(step.id);
        dupSeen.set(key, prevSeen);
      } else {
        dupSeen.set(key, { firstId: step.id, resultHash: step.resultHash });
      }
    }
  }
  if (openChain) retryChains.push(openChain);

  const duplicates = [...dupEntries.values()];
  const noop = stateMachine?.noopMutations ?? [];
  const wastedRetryCalls = retryChains.reduce((n, c) => n + c.attempts.length - (c.resolvedOk ? 1 : 0), 0);
  const wastedDupCalls = duplicates.reduce((n, d) => n + d.ids.length, 0);
  const wastedMs = retryChains.reduce((n, c) => n + c.ms, 0);
  const wastedCalls = wastedRetryCalls + wastedDupCalls + noop.length;
  const totalCalls = steps.length;
  return {
    totals: { calls: totalCalls, wastedCalls, wastedMs, wastePct: totalCalls ? wastedCalls / totalCalls : 0 },
    // A chain of length 1 is a failure nobody retried - still wasted, just not a "retry" in the
    // literal sense; kept in the same list rather than a separate bucket nobody would check.
    retries: retryChains.map((c) => ({ type: c.type, target: c.target, error: c.error ? clip(c.error, 100) : null, attempts: c.attempts, resolvedId: c.resolvedId, resolvedOk: c.resolvedOk, ms: c.ms })),
    duplicateReads: duplicates.map((d) => ({ type: d.type, target: d.target, firstId: d.firstId, ids: d.ids, count: d.ids.length + 1 })),
    noopMutations: noop,
  };
}

// -------------------------------------------------------------- token cost breakdown

// Delivered bytes (db.mjs's own COALESCE(delivered_bytes, LENGTH(result_json), byte_length, 0) -
// the same figure the token-report ledger books) grouped by type and by agent, plus the single
// most expensive calls - an icicle chart's numbers without committing to a fixed depth of nesting.
export function buildCostBreakdown(actions, { topN = 12 } = {}) {
  const rows = ascending(actions).filter((a) => !NOISE_TYPES.has(a.type) && !isInternal(a));
  const byType = new Map();
  const byAgent = new Map();
  let totalBytes = 0;
  for (const a of rows) {
    const bytes = Number.isFinite(a.bytes) ? a.bytes : 0;
    totalBytes += bytes;
    const t = byType.get(a.type) ?? { type: a.type, bytes: 0, count: 0 };
    t.bytes += bytes; t.count += 1; byType.set(a.type, t);
    const agent = a.agent_name ?? 'default';
    const g = byAgent.get(agent) ?? { agent, bytes: 0, count: 0 };
    g.bytes += bytes; g.count += 1; byAgent.set(agent, g);
  }
  const withShare = (list) => list.sort((x, y) => y.bytes - x.bytes).map((x) => ({ ...x, tokensEst: baselineTokens(x.bytes), share: totalBytes ? x.bytes / totalBytes : 0 }));
  const topCalls = rows.slice().sort((x, y) => (Number(y.bytes) || 0) - (Number(x.bytes) || 0)).slice(0, topN)
    .map((a) => ({ id: a.id, type: a.type, target: targetOf(a.params), bytes: Number(a.bytes) || 0, tokensEst: baselineTokens(Number(a.bytes) || 0), ok: !!a.ok }));
  return {
    totalBytes, totalTokensEst: baselineTokens(totalBytes), calls: rows.length,
    byType: withShare([...byType.values()]), byAgent: withShare([...byAgent.values()]), topCalls,
  };
}

// -------------------------------------------------------------- failure heatmap (this session)

// Call type x time bucket, within THIS session - where in the timeline failures clustered. The
// dashboard's other "Failure heatmap" panel is type x the last 15 SESSIONS; this is the per-session
// complement built from the same actions rows as everything else here.
export function buildFailureHeatmap(actions, { buckets = 20, topTypes = 8 } = {}) {
  const rows = ascending(actions).filter((a) => !NOISE_TYPES.has(a.type) && !isInternal(a) && toMs(a.started_at) !== null);
  if (!rows.length) return { origin: null, bucketMs: 0, buckets: 0, rowTypes: [], cells: [], totals: { calls: 0, failed: 0, failRate: 0 }, worst: null };
  const origin = Math.min(...rows.map((a) => toMs(a.started_at)));
  const end = Math.max(...rows.map((a) => toMs(a.ended_at) ?? toMs(a.started_at)));
  const bucketMs = Math.max(1000, Math.ceil((end - origin + 1) / buckets));
  const counts = new Map();
  for (const a of rows) counts.set(a.type, (counts.get(a.type) ?? 0) + 1);
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const kept = new Set(ranked.slice(0, topTypes).map(([t]) => t));
  const rowOf = (type) => (kept.has(type) ? type : 'other');
  const rowTypes = [...kept];
  if (ranked.length > topTypes) rowTypes.push('other');
  const matrix = new Map();
  let totalFailed = 0;
  // ids/failedIds (capped) - just enough evidence for a dashboard cell click to jump to a real
  // action row, same as every other panel here; capped so one dominant type/bucket can't bloat
  // the payload the way an uncapped per-cell list would on a long session.
  const CELL_ID_CAP = 20;
  for (const a of rows) {
    const bucket = Math.min(buckets - 1, Math.floor((toMs(a.started_at) - origin) / bucketMs));
    const key = `${rowOf(a.type)}|${bucket}`;
    const cell = matrix.get(key) ?? { calls: 0, failed: 0, ids: [], failedIds: [] };
    cell.calls += 1;
    if (cell.ids.length < CELL_ID_CAP) cell.ids.push(a.id);
    if (!a.ok) { cell.failed += 1; totalFailed += 1; if (cell.failedIds.length < CELL_ID_CAP) cell.failedIds.push(a.id); }
    matrix.set(key, cell);
  }
  let worst = null;
  const cells = [];
  for (const [key, c] of matrix) {
    const [type, bucketStr] = key.split('|');
    const bucket = Number(bucketStr);
    const failRate = c.calls ? c.failed / c.calls : 0;
    cells.push({ type, bucket, calls: c.calls, failed: c.failed, failRate, ids: c.ids, failedIds: c.failedIds });
    if (c.calls >= 3 && (!worst || failRate > worst.failRate)) worst = { type, bucket, calls: c.calls, failed: c.failed, failRate };
  }
  return {
    origin: new Date(origin).toISOString(), bucketMs, buckets, rowTypes, cells,
    totals: { calls: rows.length, failed: totalFailed, failRate: rows.length ? totalFailed / rows.length : 0 },
    worst,
  };
}

// -------------------------------------------------------------- causality tree

// Reshapes the causedBy link buildEpisodes attaches to each step into a forest: an uncaused step
// that started at least one chain is a root, and every step it caused (directly or through another
// caused step) hangs under it. A step nobody's chain touches is left out entirely - this is "why did
// THIS happen" evidence, not a restatement of the whole episode list.
export function buildCausality(episodesResult) {
  const steps = [];
  for (const ep of episodesResult?.episodes ?? []) {
    for (const st of ep.steps) {
      steps.push({ id: st.id, actionIds: st.actionIds, type: st.type, target: st.target, ok: st.ok, phase: st.phase, ms: st.ms, why: st.why, causedBy: st.causedBy ?? null, episodeId: ep.id, episodeIndex: ep.index });
    }
  }
  const byId = new Map(steps.map((s) => [s.id, s]));
  const childrenOf = new Map();
  const edges = [];
  for (const s of steps) {
    if (s.causedBy && byId.has(s.causedBy.id)) {
      edges.push({ from: s.causedBy.id, to: s.id, kind: s.causedBy.kind });
      if (!childrenOf.has(s.causedBy.id)) childrenOf.set(s.causedBy.id, []);
      childrenOf.get(s.causedBy.id).push(s.id);
    }
  }
  const roots = steps.filter((s) => childrenOf.has(s.id) && !s.causedBy).map((s) => s.id).sort((a, b) => a - b);
  const linkedIds = new Set([...childrenOf.keys(), ...edges.map((e) => e.to)]);
  return {
    nodes: steps.filter((s) => linkedIds.has(s.id)),
    edges, roots,
    childrenOf: Object.fromEntries([...childrenOf.entries()].map(([k, v]) => [k, v.sort((a, b) => a - b)])),
    stats: { linkedActions: linkedIds.size, chains: roots.length, edges: edges.length },
  };
}

// -------------------------------------------------------------- self-repair loop: recorded edges + causal diff

// buildCausality's edges above are ALL pattern-inferred (causeOf() matches on paramsKey/phase/
// ordering signals, never ground truth) - confirmed there is no recorded-edge concept anywhere in
// this file before this addition (see webscout2.md's "recorded vs inferred" gap). These two edges
// are different in kind: the self-repair loop's own patch/verify actions explicitly DECLARE what
// they fix/confirm (fixesActionId on an 'fs.patch' action, patchActionId on a 'repair.verify'
// action - see self-repair.mjs / relay.mjs's /repair/* routes) - that is ground truth the loop
// itself asserted, not a guessed pattern match. Deliberately kept in a SEPARATE list rather than
// merged into buildCausality's edges: those are keyed by episode STEP id, these by raw ACTION id -
// mixing the two id spaces in one edge list would silently mean two different things by the same
// field name. Never call this "inferred" or fold it into a causality tree render without the
// distinction staying visible.
export function buildRecordedRepairEdges(actions = []) {
  const edges = [];
  for (const a of actions) {
    if (a.type === 'fs.patch' && a.ok && a.params?.fixesActionId !== undefined && a.params?.fixesActionId !== null) {
      edges.push({ from: Number(a.params.fixesActionId), to: a.id, kind: 'fixed_by', recorded: true });
    }
    if (a.type === 'repair.verify' && a.params?.patchActionId !== undefined && a.params?.patchActionId !== null) {
      edges.push({ from: Number(a.params.patchActionId), to: a.id, kind: 'confirmed_by', recorded: true });
    }
  }
  return edges;
}

function inferredEdgeKey(e) { return `${e.from}->${e.to}:${e.kind}`; }

// Two sessions' own causality trees, diffed by edge identity (from/to/kind) - added/removed/kept.
// A self-repair loop's confirm-fix step reads this to see whether the patch actually removed the
// failing causal chain, not just "the session ended without an error" - e.g. session A is the
// witnessing run that hit a flagged/failing action, session B is the post-patch confirm run;
// `removed` shows exactly which inferred chain no longer forms. `recorded` is reported separately
// per session (see buildRecordedRepairEdges above) - never diffed against `inferred`, since a
// recorded edge in B proves nothing about whether an inferred chain from A actually went away.
export function diffCausality(actionsA = [], actionsB = []) {
  const causalA = buildCausality(buildEpisodes(actionsA));
  const causalB = buildCausality(buildEpisodes(actionsB));
  const byKeyA = new Map(causalA.edges.map((e) => [inferredEdgeKey(e), e]));
  const byKeyB = new Map(causalB.edges.map((e) => [inferredEdgeKey(e), e]));
  const removed = causalA.edges.filter((e) => !byKeyB.has(inferredEdgeKey(e)));
  const added = causalB.edges.filter((e) => !byKeyA.has(inferredEdgeKey(e)));
  const kept = causalA.edges.filter((e) => byKeyB.has(inferredEdgeKey(e))).length;
  return {
    inferred: {
      a: { nodes: causalA.nodes.length, edges: causalA.edges.length },
      b: { nodes: causalB.nodes.length, edges: causalB.edges.length },
      added, removed, kept,
    },
    recorded: {
      a: buildRecordedRepairEdges(actionsA),
      b: buildRecordedRepairEdges(actionsB),
    },
  };
}

// -------------------------------------------------------------- route / page FSM

function routeOf(href) {
  try { const u = new URL(href); return `${u.pathname}${u.hash || ''}` || '/'; } catch { return clip(href, 60); }
}

// Same shape as buildStateMachine (nodes are distinct states, edges are transitions between them),
// but the state is which page/route the session was on, from dom.click's own hrefBefore/href -
// the only navigation signal this tool captures (see inject.js). `clicks` is
// db.listClickNavigations(sessionId): every ok dom.click, oldest first.
export function buildRouteMachine(clicks = []) {
  const navs = clicks.filter((c) => c.hrefChanged && c.href && c.hrefBefore);
  if (!navs.length) return { nodes: [], edges: [], path: [], current: null, stats: { navigations: 0, routes: 0, transitions: 0, revisits: 0, nonNavClicks: clicks.length } };
  const nodeByKey = new Map();
  const nodes = [];
  const NODE_ID_CAP = 20;
  const ensure = (href, clickId) => {
    const key = routeOf(href);
    let n = nodeByKey.get(key);
    if (!n) { n = { id: `r${nodes.length + 1}`, index: nodes.length + 1, route: key, sample: href, visits: 0, actionIds: [] }; nodes.push(n); nodeByKey.set(key, n); }
    n.visits += 1;
    // Every click that touched this page (arrived at it or left from it) - capped, just enough
    // evidence for a dashboard click on a node to jump to a real action row.
    if (clickId != null && !n.actionIds.includes(clickId) && n.actionIds.length < NODE_ID_CAP) n.actionIds.push(clickId);
    return n;
  };
  const edges = new Map();
  const path = [];
  for (const c of navs) {
    const from = ensure(c.hrefBefore, c.id);
    const to = ensure(c.href, c.id);
    if (!path.length) path.push(from.id);
    path.push(to.id);
    const key = `${from.id}>${to.id}`;
    let e = edges.get(key);
    if (!e) { e = { from: from.id, to: to.id, count: 0, actionIds: [], noChange: from === to }; edges.set(key, e); }
    e.count += 1;
    e.actionIds.push(c.id);
  }
  const edgeList = [...edges.values()];
  const revisits = path.filter((id, i) => path.indexOf(id) !== i && path[i - 1] !== id).length;
  return {
    nodes, edges: edgeList, path, current: path[path.length - 1] ?? null,
    stats: { navigations: navs.length, routes: nodes.length, transitions: edgeList.length, revisits, nonNavClicks: clicks.length - navs.length },
  };
}

// --------------------------------------------------------------------- all

export function buildSessionViz({ session = null, actions = [], snapshots = [], diffs = [], clicks = [], limit = null } = {}) {
  const episodes = buildEpisodes(actions, { snapshots, goal: session?.goal ?? null });
  const stateMachine = buildStateMachine({ actions, snapshots, diffs });
  return {
    sessionId: session?.id ?? null,
    generatedAt: new Date().toISOString(),
    // The row set was capped to the newest N; nodes/edges that need older actions are approximate.
    truncated: Number.isFinite(limit) && limit > 0 && actions.length >= limit,
    swimlane: buildSwimlane(actions),
    episodes,
    stateMachine,
    sequence: buildSequence(actions),
    waste: buildWaste(actions, { stateMachine }),
    costTree: buildCostBreakdown(actions),
    failureHeatmap: buildFailureHeatmap(actions),
    causality: buildCausality(episodes),
    routeMachine: buildRouteMachine(clicks),
  };
}
