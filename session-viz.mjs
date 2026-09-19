// Pure models behind the dashboard's session visualizations. No I/O, no DOM: rows in, plain
// JSON out, so every rule here is unit-testable and the relay can serve the result as-is.
//
//   buildSwimlane(actions)            - one lane per agent, a bar per action, per-lane think time
//   buildEpisodes(actions, opts)      - goal > episode > step > action tree, plus a "why" per action
//   buildStateMachine({actions, snapshots, diffs})
//                                     - nodes are distinct snapshot CONTENT, edges are what happened
//                                       between two snapshots (the state graph a session walked)
//   buildSessionViz(...)              - all three, from one row set
//
// Inputs are the lightweight rows db.listActionsForViz / listSnapshots / listDiffs return. A
// "why" is either the agent's own words (actions.intent, imported from its transcript - see
// intent-import.mjs) or an inferred one derived from the call sequence; each carries its source so
// the UI never presents a guess as the agent's reasoning.

import { MUTATING_TYPES } from './command-registry.mjs';

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
      why: s.why, ...(s.ok ? {} : { error: clip(s.error, 120) }),
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
  };
}

// --------------------------------------------------------------------- all

export function buildSessionViz({ session = null, actions = [], snapshots = [], diffs = [], limit = null } = {}) {
  const episodes = buildEpisodes(actions, { snapshots, goal: session?.goal ?? null });
  return {
    sessionId: session?.id ?? null,
    generatedAt: new Date().toISOString(),
    // The row set was capped to the newest N; nodes/edges that need older actions are approximate.
    truncated: Number.isFinite(limit) && limit > 0 && actions.length >= limit,
    swimlane: buildSwimlane(actions),
    episodes,
    stateMachine: buildStateMachine({ actions, snapshots, diffs }),
  };
}
