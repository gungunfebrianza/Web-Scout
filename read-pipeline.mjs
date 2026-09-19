// What a read looks like when it reaches the caller. The relay dispatches (or
// serves from cache) the FULL result, logs it, caches it; this pipeline then
// decides what to hand back:
//
//   pointer   the caller opted in (--if-changed / --delta) and already holds this
//             exact result: a one-line "unchanged, same as action #N"
//   delta     the caller opted in (--delta) and holds an older result of the same
//             call: only what changed
//   peek      --peek, or the session budget guard: shape and size, not the body
//   table     --table, or a tightened budget: rows as {columns, rows:[[...]]}
//   full      otherwise, exactly as before
//
// A session started with --lean makes the first four the DEFAULT (rows as tables, a
// repeat as a pointer or delta, a large body as its shape) so one setting replaces
// a flag on every call; --no-guard on a call still gets the body.
//
// "Holds" is tracked precisely: a body counts as held only when it was actually
// delivered in full (or tabulated, or rebuilt from a delta) - never after a peek.
// The pipeline also watches what callers do next (peek then narrow or full read,
// scoped then unscoped, identical full re-deliveries) and turns that into one-line
// hints, measured for whether they were followed, capped per session and silenced
// per kind once the caller has ignored two of them, and costed (bytes sent vs bytes
// saved on the calls that adopted one). Pure state machine: no I/O, the
// ledger writer is injected, so read-pipeline.test.mjs drives it directly.

import { tabulate, peekSummary, computeReadDelta, sizeOf } from './read-shape.mjs';
import { baselineTokens, baselineBand, kindForType } from './token-estimate.mjs';

// Params that narrow a read, per type. A scoped read (one whose reply claimed
// avoided bytes) followed within the window by the same read on the same tab
// WITHOUT them means the caller paid for the rest anyway.
export const SCOPING_PARAM_KEYS = {
  'dom.query': ['meta', 'pick'],
  'react.inspect': ['pick'],
  'idb.list': ['stores', 'nonEmpty'],
  'idb.dump': ['where', 'fields', 'limit', 'countOnly'],
  'idb.get': ['fields'],
  'net.log': ['urlContains', 'limit', 'fields', 'failed'],
  'console.log': ['limit', 'level', 'contains', 'fields'],
};
export const FOLLOW_UP_WINDOW_MS = 90000;
export const HINT_MIN_TOKENS = 1500;
export const REUSE_HINT_AFTER_FULL_HITS = 2;
export const BUDGET_TIGHTEN_PCT = 60;
export const BUDGET_STRICT_PCT = 85;
export const GUARD_TOKENS_BY_LEVEL = { tighten: 3000, strict: 1000 };
// Tuned on real-session traces (trace.mjs replay --sweep): 4000 had the lower worst case on three of
// four traces and cost little best case; 2500 was the earlier judgement.
export const LEAN_GUARD_TOKENS = 4000;
export const MAX_HINTS_PER_SESSION = 4;
export const HINT_IGNORED_LIMIT = 2;

export function readTargetKey(type, params) {
  const rest = { ...(params ?? {}) };
  for (const k of SCOPING_PARAM_KEYS[type] ?? []) delete rest[k];
  if (type === 'dom.query') delete rest.full;
  return JSON.stringify(Object.fromEntries(Object.entries(rest).sort(([a], [b]) => (a < b ? -1 : 1))));
}

export function isNarrowed(type, params) {
  return (SCOPING_PARAM_KEYS[type] ?? []).some((k) => params?.[k] !== undefined && params?.[k] !== null && params?.[k] !== false);
}

const scopeOf = (type, params) => Object.fromEntries((SCOPING_PARAM_KEYS[type] ?? []).filter((k) => params?.[k] !== undefined && params?.[k] !== null && params?.[k] !== false).map((k) => [k, params[k]]));

export function normalizeShapeOpts(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  return { table: !!o.table, ifChanged: !!o.ifChanged, delta: !!o.delta, peek: !!o.peek, noGuard: !!o.noGuard };
}

// Budget level for a session: 'ok' below 60% of its --token-budget, 'tighten' from
// 60%, 'strict' from 85%. `used` is the same running total the client prints.
export function budgetLevel(limit, used) {
  const l = Number(limit);
  if (!(l > 0)) return null;
  const pct = (used / l) * 100;
  const level = pct >= BUDGET_STRICT_PCT ? 'strict' : pct >= BUDGET_TIGHTEN_PCT ? 'tighten' : 'ok';
  return { limit: l, used, pct: Math.round(pct * 10) / 10, level, guardTokens: level === 'ok' ? null : GUARD_TOKENS_BY_LEVEL[level] };
}

const tok = (bytes) => baselineTokens(bytes);

// leanGuardTokens is a parameter only so trace.mjs can sweep it; the relay uses the default.
export function createReadPipeline({ bump, now = () => Date.now(), leanGuardTokens = LEAN_GUARD_TOKENS }) {
  const delivered = new Map(); // sessionId -> Map(cacheKey -> { result, actionId })
  const trails = new Map(); // sessionId -> per-session behaviour trail
  const budgetAnnounced = new Map(); // sessionId -> last level announced

  const deliveredFor = (sid) => { if (!delivered.has(sid)) delivered.set(sid, new Map()); return delivered.get(sid); };
  const trailFor = (sid) => {
    if (!trails.has(sid)) trails.set(sid, { scopedAt: new Map(), lastScope: new Map(), reReads: new Map(), fullHits: new Map(), hinted: new Set(), pendingScope: new Set(), pendingReuse: new Map(), peeks: new Map(), leanWithheld: new Map(), hintsSent: 0, kinds: new Map() });
    return trails.get(sid);
  };

  // One line, at most, per shaped read. Only from what the caller has actually done.
  const kindState = (trail, kind) => { if (!trail.kinds.has(kind)) trail.kinds.set(kind, { sent: 0, adopted: 0 }); return trail.kinds.get(kind); };
  // A hint goes out only while the session is under its cap and the caller has not already
  // ignored HINT_IGNORED_LIMIT hints of this kind: advice nobody follows is noise they pay for.
  const mayHint = (trail, kind) => trail.hintsSent < MAX_HINTS_PER_SESSION && kindState(trail, kind).sent - kindState(trail, kind).adopted < HINT_IGNORED_LIMIT;
  const noteAdopted = (trail, kind, savedBytes) => { kindState(trail, kind).adopted += 1; bump('hintAdopted', savedBytes); };

  // spared: bytes this very call kept off the caller's screen (what an adopting call is credited with)
  function behaviourHint({ trail, type, params, cacheKey, target, mode, hit, outBytes, opts, spared }) {
    const t = now();
    const narrowed = isNarrowed(type, params);
    const scopable = !!SCOPING_PARAM_KEYS[type];
    const fullDelivery = mode === 'full' || mode === 'table';
    let hint = null;
    const issue = (kind, text) => {
      const state = kindState(trail, kind);
      state.sent += 1;
      trail.hintsSent += 1;
      bump(kind === 'scope' ? 'hintScope' : 'hintReuse', 0);
      bump('hintBytes', text.length);
      return text;
    };

    // adoption of an earlier hint
    if (trail.pendingReuse.has(cacheKey) && (opts.ifChanged || opts.delta || opts.table)) { const kind = trail.pendingReuse.get(cacheKey); trail.pendingReuse.delete(cacheKey); noteAdopted(trail, kind, spared); }
    if (scopable && narrowed && trail.pendingScope.has(target)) { trail.pendingScope.delete(target); noteAdopted(trail, 'scope', 0); }

    if (scopable && narrowed) {
      trail.scopedAt.set(target, t);
      trail.lastScope.set(target, scopeOf(type, params));
    } else if (scopable && fullDelivery && trail.scopedAt.has(target)) {
      trail.reReads.set(target, (trail.reReads.get(target) ?? 0) + 1);
      const big = tok(outBytes) >= HINT_MIN_TOKENS;
      if (big && (trail.reReads.get(target) ?? 0) >= 2 && !trail.hinted.has(`reuse:${target}`) && mayHint(trail, 'reuse')) {
        trail.hinted.add(`reuse:${target}`);
        trail.pendingReuse.set(cacheKey, 'reuse');
        hint = issue('reuse', `this ${type} target was read in full again after being scoped (${trail.reReads.get(target)} times this session, ~${tok(outBytes)} tokens each). Scoping is not answering it - use --delta (only what changed since your last read) or --table (keys stated once) for these full reads.`);
      } else if (big && !trail.hinted.has(`scope:${target}`) && mayHint(trail, 'scope')) {
        trail.hinted.add(`scope:${target}`);
        trail.pendingScope.add(target);
        hint = issue('scope', `this unscoped ${type} read cost ~${tok(outBytes)} tokens; earlier this session you read the same target with ${JSON.stringify(trail.lastScope.get(target))}. Reuse that scope unless you need everything.`);
      }
    }

    if (hit && fullDelivery) {
      const n = (trail.fullHits.get(cacheKey) ?? 0) + 1;
      trail.fullHits.set(cacheKey, n);
      if (!hint && n >= REUSE_HINT_AFTER_FULL_HITS && tok(outBytes) >= HINT_MIN_TOKENS && !trail.hinted.has(`hit:${cacheKey}`) && mayHint(trail, 'hit')) {
        trail.hinted.add(`hit:${cacheKey}`);
        trail.pendingReuse.set(cacheKey, 'hit');
        hint = issue('hit', `this identical read has now been served from the relay cache ${n} times and re-delivered in full each time (~${tok(outBytes)} tokens each). Add --if-changed and an unchanged repeat becomes a one-line pointer.`);
      }
    }
    return hint;
  }

  // full: the complete result (never mutated); returns what to hand the caller.
  function shape({ sessionId, type, agentName, params, cacheKey, full, hit, entry, actionId, opts: rawOpts, budget, envGuardTokens, lean }) {
    const explicit = normalizeShapeOpts(rawOpts);
    // a lean session shapes by default; --no-guard on the call asks for the body as it is
    const leanOn = !!lean && !explicit.noGuard;
    const opts = leanOn ? { ...explicit, table: true, delta: true } : explicit;
    const held = deliveredFor(sessionId);
    const trail = trailFor(sessionId);
    const target = `${agentName}::${type}::${readTargetKey(type, params)}`;
    const fullBytes = sizeOf(full);
    const base = hit ? { ...full, __cacheHit: true, __cachedAt: entry?.cachedAt } : full;
    const previous = held.get(cacheKey);
    const guardTokens = [budget?.guardTokens, envGuardTokens, leanOn ? leanGuardTokens : null].filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b)[0] ?? null;
    let out = null;
    let mode = 'full';

    if (hit && (opts.ifChanged || opts.delta) && previous && previous.result === full) {
      out = { unchanged: true, ...(previous.actionId ? { sameAs: previous.actionId } : {}), cachedAt: entry?.cachedAt, omittedBytes: fullBytes, note: 'nothing changed since the read you already hold - not re-sent. Repeat without --if-changed/--delta to get the body again.' };
      mode = 'pointer';
    } else if (!hit && opts.delta && previous && previous.result !== full) {
      const d = computeReadDelta(previous.result, full);
      if (d) { out = { __delta: true, ...(previous.actionId ? { sameAs: previous.actionId } : {}), ...d, note: 'only what changed since the read you already hold (same call) - apply it to that result. Repeat without --delta for the full body.' }; mode = 'delta'; }
    }

    if (!out && opts.peek) {
      const peek = peekSummary(type, full, { estBytes: fullBytes, estTokens: tok(fullBytes) });
      peek.estTokensBand = [baselineBand(fullBytes, kindForType(type)).low, baselineBand(fullBytes, kindForType(type)).high];
      if (sizeOf(peek) < fullBytes) { out = peek; mode = 'peek'; }
    }
    if (!out && !opts.noGuard && guardTokens && tok(fullBytes) > guardTokens) {
      const peek = peekSummary(type, full, { estBytes: fullBytes, estTokens: tok(fullBytes), guarded: true, guardTokens });
      peek.estTokensBand = [baselineBand(fullBytes, kindForType(type)).low, baselineBand(fullBytes, kindForType(type)).high];
      if (sizeOf(peek) < fullBytes) { out = peek; mode = 'guard'; }
    }
    if (!out && (opts.table || (budget && budget.level !== 'ok'))) {
      const t = tabulate(base);
      if (t.changed && sizeOf(t.result) < sizeOf(base)) { out = t.result; mode = 'table'; }
    }
    if (!out) out = base;
    const outBytes = sizeOf(out);

    // what the caller can now be said to hold
    if (mode === 'full' || mode === 'table') held.set(cacheKey, { result: full, actionId: actionId ?? entry?.actionId });
    else if (mode === 'delta') held.set(cacheKey, { result: full, actionId });

    // ledger: bytes the caller was spared, measured against what this call would have delivered
    const spared = Math.max(0, (hit ? sizeOf(base) : fullBytes) - outBytes);
    if (mode === 'pointer') bump('unchangedPointer', spared);
    else if (mode === 'delta') bump('deltaRead', spared);
    else if (mode === 'peek') bump('peek', spared);
    else if (mode === 'guard') bump('guardedPeek', spared);
    else if (mode === 'table') bump('tabular', spared);

    // peek follow-up: did the caller narrow (the peek worked as a map) or take the whole body anyway?
    if (mode === 'peek' || mode === 'guard') {
      trail.peeks.set(target, now());
      if (trail.peeks.size > 200) for (const [k, at] of trail.peeks) if (now() - at > FOLLOW_UP_WINDOW_MS) trail.peeks.delete(k);
    } else if (trail.peeks.has(target) && now() - trail.peeks.get(target) <= FOLLOW_UP_WINDOW_MS) {
      trail.peeks.delete(target);
      bump(isNarrowed(type, params) ? 'peekThenNarrowed' : 'peekThenFull', outBytes);
    }

    // pointer/delta follow-up: "trust what you already hold" only pays off if the caller then
    // actually relies on it - a raw FULL re-read of the same target afterwards (not another
    // pointer/delta, not a table - only the unshaped body) means it did not, and the bytes it
    // looked like this call saved were spent after all. This is what "leanWorst" in trace.mjs
    // simulates as a whole-session policy; this is the same thing measured live, per call.
    if (mode === 'pointer' || mode === 'delta') {
      trail.leanWithheld.set(target, { at: now(), mode });
      if (trail.leanWithheld.size > 200) for (const [k, w] of trail.leanWithheld) if (now() - w.at > FOLLOW_UP_WINDOW_MS) trail.leanWithheld.delete(k);
    } else if (mode === 'full' && trail.leanWithheld.has(target) && now() - trail.leanWithheld.get(target).at <= FOLLOW_UP_WINDOW_MS) {
      const origin = trail.leanWithheld.get(target).mode;
      trail.leanWithheld.delete(target);
      bump(isNarrowed(type, params) ? `${origin}ThenNarrowed` : `${origin}ThenFull`, outBytes);
    }

    // who chose the shaping: the caller (explicit flags), the session (lean), or nobody (plain)
    const asked = explicit.table || explicit.ifChanged || explicit.delta || explicit.peek;
    bump(asked ? 'readExplicit' : leanOn ? 'readLean' : 'readPlain', outBytes);

    // opts as the CALLER gave them: the hint logic is about what the caller chose to do
    const hint = behaviourHint({ trail, type, params, cacheKey, target, mode, hit, outBytes, opts: explicit, spared });
    return { out, mode, fullBytes, outBytes, spared, hint };
  }

  // Announce a budget level once per change, not on every read.
  function budgetNote(sessionId, budget) {
    if (!budget) return null;
    const last = budgetAnnounced.get(sessionId) ?? 'ok';
    if (budget.level === last) return null;
    budgetAnnounced.set(sessionId, budget.level);
    if (budget.level === 'ok') return null;
    return `token budget ${budget.pct}% used (~${budget.used} of ${budget.limit} estimated tokens). ${budget.level === 'strict' ? 'Strict' : 'Tightened'} mode: reads over ~${budget.guardTokens} tokens now return their shape (peek) instead of the body - repeat with --no-guard to force it - and rows come back as {columns, rows}.`;
  }

  function endSession(sessionId) {
    delivered.delete(sessionId);
    trails.delete(sessionId);
    budgetAnnounced.delete(sessionId);
  }

  return { shape, budgetNote, endSession };
}
