// Pure friction-awareness helpers shared by relay.mjs (no I/O, no module-level DB access, so
// every rule here is unit-testable on plain arrays - see friction.test.mjs).
//
// What lives here, and why it is not inline in relay.mjs any more:
//   - target identity: a selector's risk used to be keyed by the exact `type::selector` string, so
//     `#row-41` vs `#row-42`, `click` vs `clickWait`, or `a > b` vs `a>b` each looked like a
//     brand-new, clean selector. idb.* writes fail by STORE, not selector, so a store is a target too.
//   - error classification: "not found" and "timeout" want different remediations.
//   - buildSelectorFriction: the cross-session scan behind the pre-action warn (and the dashboard's
//     Selectors panel - there is one view, not two). It is (a) origin-scoped, (b) success-aware
//     (a failure followed by a success no longer counts as unresolved), (c) class/cost/recovery-
//     annotated, (d) cost-weighted by wasted time and retries.
//   - the live per-session tracker: this session's own failures overlay the history (which the
//     relay now reads on demand, from OTHER sessions only, so nothing is frozen at session start).
//   - evaluateSelectorRisk: history + live + per-session dedupe/escalation -> one decision AND the
//     reason for it (so "why did / didn't it warn" is answerable, not a guess).
//   - one formatter for a failure's friction context, shared by the CLI and the MCP server.
//   - rate-spike, known-issue-candidate and "mark fixed?" suggestion detectors.

function envNumber(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Thresholds (configurable). All overridable via env so an operator can tune noise vs
// sensitivity without editing code; invalid/non-positive values fall back to the default.
export const RISKY_SELECTOR_FAIL_THRESHOLD = envNumber('WEBSCOUT_RISKY_FAIL_THRESHOLD', 3); // unresolved prior failures that make a selector "risky"
export const LIVE_FAIL_THRESHOLD = envNumber('WEBSCOUT_RISKY_LIVE_FAIL_THRESHOLD', 2); // same-session failures that warn on their own
export const ESCALATE_AFTER_LIVE_FAILS = envNumber('WEBSCOUT_RISKY_ESCALATE_FAILS', 3); // same-session failures at which the warning escalates
export const WASTE_MIN_CALLS = envNumber('WEBSCOUT_WASTE_MIN_CALLS', 5);
export const SPIKE_FACTOR = envNumber('WEBSCOUT_SPIKE_FACTOR', 3);
export const SPIKE_MIN_PRIOR_CALLS = envNumber('WEBSCOUT_SPIKE_MIN_PRIOR_CALLS', 10);
export const CANDIDATE_MIN_FAILS = envNumber('WEBSCOUT_KNOWN_ISSUE_CANDIDATE_MIN_FAILS', 3);
export const RESOLVE_SUGGEST_MIN_FAILS = envNumber('WEBSCOUT_RESOLVE_SUGGEST_MIN_FAILS', 3);
export const RESOLVE_SUGGEST_MIN_OKS = envNumber('WEBSCOUT_RESOLVE_SUGGEST_MIN_OKS', 3);
export const RESOLVE_SUGGEST_MIN_SESSIONS = envNumber('WEBSCOUT_RESOLVE_SUGGEST_MIN_SESSIONS', 2);
export const SELECTOR_FRICTION_LIMIT = 100;
// A failure inside a strict-CRV session also threw away that session's auto before/after snapshot
// pair around the action (the snapshots are taken regardless of how the action ends), so the same
// failure costs more there. The weight multiplies that failure's share of the ranking score; 1 turns
// it off.
export const STRICT_CRV_FAIL_WEIGHT = envNumber('WEBSCOUT_STRICT_CRV_FAIL_WEIGHT', 1.5);

// The knobs in effect, for `friction explain` and the health surface - an operator can see what
// the warn is being judged against without reading the environment.
// Tokens the agent spent issuing and reading a failed call (chars/4, the unit every ledger here uses) become
// ranking points at this rate: 250 tokens = 1 point = about one second of wasted time. 0 turns it off.
export const TOKENS_PER_POINT = (() => {
  const raw = process.env.WEBSCOUT_TOKENS_PER_POINT;
  if (raw === undefined || raw === '') return 250;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 250;
})();

export function frictionConfig() {
  return {
    riskyFailThreshold: RISKY_SELECTOR_FAIL_THRESHOLD,
    liveFailThreshold: LIVE_FAIL_THRESHOLD,
    escalateAfterLiveFails: ESCALATE_AFTER_LIVE_FAILS,
    wasteMinCalls: WASTE_MIN_CALLS,
    spikeFactor: SPIKE_FACTOR,
    spikeMinPriorCalls: SPIKE_MIN_PRIOR_CALLS,
    candidateMinFails: CANDIDATE_MIN_FAILS,
    resolveSuggest: { minFails: RESOLVE_SUGGEST_MIN_FAILS, minOks: RESOLVE_SUGGEST_MIN_OKS, minSessions: RESOLVE_SUGGEST_MIN_SESSIONS },
    block: process.env.WEBSCOUT_RISKY_BLOCK === '1',
    strictCrvFailWeight: STRICT_CRV_FAIL_WEIGHT,
    clusterMinTargets: CLUSTER_MIN_TARGETS,
    tokensPerPoint: TOKENS_PER_POINT,
  };
}

// ---------- target identity ----------

// click and clickWait are the same user intent on the same element; a selector that keeps
// failing under one is just as risky under the other. patch is a put with a merge.
const TYPE_FAMILIES = { 'dom.clickWait': 'dom.click', 'idb.patch': 'idb.put' };
export function typeFamily(type) {
  return TYPE_FAMILIES[type] ?? type;
}

// Conservative on purpose: only collapse things that are noise (whitespace, quote style,
// combinator spacing, positional indexes, 2+-digit runs and digit-bearing attribute values).
// `.col-md-6` and `[type="submit"]` stay as they are - merging distinct stable selectors would
// create false warnings, which is worse than missing a fuzzy match.
export function normalizeSelector(selector) {
  return String(selector)
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\s*([>+~,])\s*/g, '$1')
    .replace(/'/g, '"')
    .replace(/:nth-(child|of-type|last-child|last-of-type)\(\s*[^)]*\)/g, ':nth-$1(*)')
    .replace(/(\[[^\]=]+=)"([^"]*)"/g, (m, head, value) => (/\d/.test(value) ? `${head}"*"` : m))
    .replace(/\d{2,}/g, '*');
}

// What an action is aimed AT. dom.* commands aim at a selector; idb.* writes aim at a store (they
// fail by store, never by selector, so a selector-only model was blind to them). Key shape is
// `family::target`; a store target is prefixed so it can never collide with a selector.
// Commands that aim at the PAGE rather than an element or a store (a reload, a settle, a screenshot, a
// wait on the console/network). They have no selector to key on, so they fall back to the origin the
// agent was connected from: "page.reload keeps timing out on this site" is as real as a bad selector.
// Granularity is the origin plus a normalized path ("http://localhost:3000/orders/:id"): a reload that
// times out on one route is not evidence against the rest of the site. An agent that reports no path
// (an older tab) falls back to the bare origin.
export const PAGE_TYPES = new Set(['page.reload', 'page.hardReload', 'page.epoch', 'dom.settle', 'dom.screenshot', 'console.wait', 'net.wait', 'react.tree', 'idb.list']);

// origin + path with the volatile parts removed: numeric, uuid and long-hex segments become :id, query and
// hash are dropped, trailing slash is ignored. Idempotent, so a value typed on the CLI and one reported by
// the page land on the same key. Anything that is not a URL is returned trimmed.
export function normalizePageScope(value) {
  const text = String(value ?? '').trim();
  let url;
  try { url = new URL(text); } catch { return text; }
  if (!url.pathname || url.pathname === '/') return url.origin;
  const segments = url.pathname.split('/').filter(Boolean).map((s) => (/^\d+$/.test(s) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s) || /^[0-9a-f]{16,}$/i.test(s) ? ':id' : s));
  return `${url.origin}/${segments.join('/')}`;
}

// dom.drag has TWO selector-bearing params: selector (the thing dragged) and to (the drop target). A
// failure can be either one's fault, so a drag counts against both - expandDragTargets turns one logged
// drag into the action itself plus a pseudo-action aimed at the drop target (same type, same outcome),
// which every consumer below then treats like any other selector. Anything else comes back unchanged.
export function expandDragTargets(a) {
  const to = a?.params?.to;
  if (a?.type !== 'dom.drag' || typeof to !== 'string' || !to) return [a];
  return [a, { ...a, params: { selector: to } }];
}

export function frictionTarget(type, params, origin = null) {
  const selector = params?.selector;
  if (typeof selector === 'string' && selector) return { kind: 'selector', value: selector };
  const store = params?.store;
  if (typeof store === 'string' && store && /^idb\./.test(type)) return { kind: 'store', value: store };
  if (typeof origin === 'string' && origin && PAGE_TYPES.has(type)) return { kind: 'page', value: normalizePageScope(origin) };
  return null;
}

function targetKey(type, target) {
  const part = target.kind === 'store' ? `store:${target.value.trim()}` : target.kind === 'page' ? `page:${target.value.trim()}` : normalizeSelector(target.value);
  return `${typeFamily(type)}::${part}`;
}

// "Mark fixed" is one idea with several scopes. A target (selector / store / page) is keyed by
// frictionKeyFor; the scopes below are keyed here, so one table, one command and one rule ("only what
// happened AFTER the declared instant counts") cover them all.
//   type  - a command type's failure rate        (friction resolve type dom.wait)
//   macro - a macro that never once succeeds      (friction resolve macro 3)
//   verity - a verity label still failing         (friction resolve verity checkout)
export const SCOPE_KINDS = new Set(['type', 'macro', 'verity']);
export const scopeKey = (kind, id) => `${kind}::${String(id).trim()}`;

export function frictionKey(type, selector) {
  return targetKey(type, { kind: 'selector', value: selector });
}

// null when the action has no friction target.
export function frictionKeyFor(type, params, origin = null) {
  const target = frictionTarget(type, params, origin);
  return target ? targetKey(type, target) : null;
}

const targetLabel = (kind) => (kind === 'store' ? 'store' : kind === 'page' ? 'page' : 'selector');

// ---------- error classification ----------

export function classifyError(message) {
  const text = String(message ?? '');
  if (!text) return 'other';
  if (/timed? ?out|timeout|did not (?:respond|reply)|no reply/i.test(text)) return 'timeout';
  if (/detached|stale element|no longer (?:in|attached)|not attached|removed from (?:the )?dom/i.test(text)) return 'detached';
  if (/not found|no element|no such element|did not match|matched (?:0|no)|could not find|unable to find/i.test(text)) return 'not-found';
  if (/navigat|page (?:reload|unload)|execution context was destroyed|frame (?:was )?detached/i.test(text)) return 'navigation';
  if (/syntaxerror|referenceerror|typeerror|rangeerror|is not (?:a function|defined)|cannot read propert|eval/i.test(text)) return 'eval-throw';
  return 'other';
}

const CLASS_ADVICE = {
  timeout: 'the page was slow or never replied - add a settle/dom.wait first, or check "ping".',
  detached: 'the element was re-rendered between lookup and use - use dom.click-wait or re-query first.',
  'not-found': 'nothing matched - confirm the selector with dom.query or a snapshot before acting.',
  navigation: 'the page navigated mid-command - wait for the new page to settle first.',
  'eval-throw': 'the page script threw - check "console" for the underlying exception.',
};

// ---------- cross-session scan ----------

const WAIT_TYPE = /^(?:dom|idb)\.(?:wait|clickWait)/;
const RECOVERY_LOOKAHEAD = 6;
// Recovery and retries are judged over each target's most recent failing sessions only. The per-command
// lookup (db.listFrictionKeyHistory) loads the surroundings of exactly this many, so the project-wide scan
// uses the same window - otherwise "worked 4 of 5" in the warning and "worked 5 of 8" in analytics.
export const RECOVERY_SESSIONS = 5;
// What one logged call cost the agent in tokens: the command and its params going out, the error (or short result)
// coming back. chars/4, same unit as token-report, so the two never disagree about what a token is.
export function actionTokens(a) {
  const params = a?.params ? JSON.stringify(a.params) : '';
  return Math.round(((a?.type?.length ?? 0) + params.length + String(a?.error ?? '').length + 40) / 4);
}

const RETRY_WEIGHT = 0.5; // a failure that was immediately re-attempted cost an extra round trip

function emptyBucket() {
  return { fails: 0, unresolved: 0, lastFailedAt: null, lastSuccessAt: null };
}

// actions: chronological rows as returned by db.listAllActions() (optionally carrying
// `origin` / `error_class` columns). `resolutions`: Map<frictionKey, resolvedAtISO> - failures
// at or before that instant are an operator-declared "fixed" and are ignored. `minFails` is 2 for
// "recurring" lists and 1 when the caller wants the entry for ONE key whatever its count.
export function buildSelectorFriction(actions, { matchKnownIssues = () => [], resolutions = new Map(), limit = SELECTOR_FRICTION_LIMIT, minFails = 2, sessionWeights = new Map() } = {}) {
  const entries = new Map();
  const isResolved = (key, at) => {
    const cutoff = resolutions.get(key);
    return Boolean(cutoff && at && at <= cutoff);
  };

  actions = actions.flatMap(expandDragTargets);
  for (const a of actions) {
    const target = frictionTarget(a.type, a.params, a.origin);
    if (!target) continue;
    const key = targetKey(a.type, target);
    const origin = a.origin || '';
    if (a.ok) {
      const entry = entries.get(key);
      if (!entry) continue;
      const bucket = (entry.origins[origin] ??= emptyBucket());
      bucket.unresolved = 0;
      bucket.lastSuccessAt = a.started_at;
      if (!entry.lastSuccessAt || a.started_at > entry.lastSuccessAt) entry.lastSuccessAt = a.started_at;
      continue;
    }
    if (isResolved(key, a.started_at)) continue;
    const entry = entries.get(key) ?? {
      key, type: typeFamily(a.type), targetKind: target.kind, selector: target.value, failCount: 0, sessionIds: new Set(), lastFailedAt: null, lastSuccessAt: null,
      origins: {}, errorClasses: {}, lastError: null, wastedMs: 0, wastedTokens: 0, retries: 0, knownIssues: [], recMap: new Map(), recoveryTrials: 0, weightedCost: 0,
    };
    entries.set(key, entry);
    entry.failCount += 1;
    entry.sessionIds.add(a.session_id);
    entry.wastedMs += Number(a.duration_ms) || 0;
    entry.wastedTokens += actionTokens(a);
    entry.weightedCost += (sessionWeights.get(a.session_id) ?? 1) * (1 + (Number(a.duration_ms) || 0) / 1000);
    const klass = a.error_class || classifyError(a.error);
    entry.errorClasses[klass] = (entry.errorClasses[klass] ?? 0) + 1;
    if (!entry.lastFailedAt || a.started_at >= entry.lastFailedAt) {
      entry.lastFailedAt = a.started_at;
      entry.selector = target.value;
      entry.lastError = a.error ? String(a.error).slice(0, 200) : null;
    }
    const bucket = (entry.origins[origin] ??= emptyBucket());
    bucket.fails += 1;
    bucket.unresolved += 1;
    if (!bucket.lastFailedAt || a.started_at > bucket.lastFailedAt) bucket.lastFailedAt = a.started_at;
    for (const hit of matchKnownIssues(a.error)) if (!entry.knownIssues.some((x) => x.id === hit.id)) entry.knownIssues.push(hit);
  }

  // Per-session pass over each failure: was it retried (cost), and what did the SAME session do
  // right after it that then worked (recovery)? Recoveries are aggregated over EVERY failure, so
  // the warning can say "worked 4 of 5 times" instead of repeating whichever happened last.
  const windows = new Map();
  const recoveryWindow = (entry) => {
    let w = windows.get(entry.key);
    if (!w) { w = new Set([...entry.sessionIds].slice(-RECOVERY_SESSIONS)); windows.set(entry.key, w); }
    return w;
  };
  const bySession = new Map();
  for (const a of actions) {
    const list = bySession.get(a.session_id);
    if (list) list.push(a); else bySession.set(a.session_id, [a]);
  }
  for (const rows of bySession.values()) {
    for (let i = 0; i < rows.length; i += 1) {
      const fail = rows[i];
      if (fail.ok) continue;
      const failTarget = frictionTarget(fail.type, fail.params, fail.origin);
      if (!failTarget) continue;
      const key = targetKey(fail.type, failTarget);
      const entry = entries.get(key);
      if (!entry || isResolved(key, fail.started_at)) continue;
      if (!recoveryWindow(entry).has(fail.session_id)) continue;
      entry.recoveryTrials += 1;
      let recoveryFound = false;
      let retried = false;
      for (let j = i + 1; j < rows.length && j <= i + RECOVERY_LOOKAHEAD; j += 1) {
        const next = rows[j];
        const nextTarget = frictionTarget(next.type, next.params, next.origin);
        if (!retried && nextTarget && targetKey(next.type, nextTarget) === key) {
          retried = true;
          entry.retries += 1;
          entry.wastedTokens += actionTokens(next);
        }
        if (recoveryFound || !next.ok) continue;
        const nextSel = nextTarget?.kind === 'selector' ? nextTarget.value : null;
        let recovery = null;
        if (failTarget.kind === 'selector' && typeFamily(next.type) === typeFamily(fail.type) && nextSel && normalizeSelector(nextSel) !== normalizeSelector(failTarget.value)) {
          recovery = { kind: 'alt-selector', type: next.type, selector: nextSel };
        } else if (WAIT_TYPE.test(next.type)) {
          recovery = { kind: 'wait', type: next.type, ...(nextSel ? { selector: nextSel } : {}) };
        }
        if (recovery) {
          recoveryFound = true;
          const sig = `${recovery.kind}|${recovery.type}|${recovery.selector ? normalizeSelector(recovery.selector) : ''}`;
          const prev = entry.recMap.get(sig);
          entry.recMap.set(sig, { ...recovery, worked: (prev?.worked ?? 0) + 1, at: !prev || next.started_at >= prev.at ? next.started_at : prev.at });
        }
      }
    }
  }

  return [...entries.values()]
    .filter((e) => e.failCount >= minFails)
    .map(({ sessionIds, recMap, recoveryTrials, knownIssues, weightedCost, ...rest }) => {
      const recoveries = [...recMap.values()]
        .map((r) => ({ ...r, of: recoveryTrials }))
        .sort((a, b) => b.worked - a.worked || (b.at > a.at ? 1 : -1))
        .slice(0, 3);
      // Ranking cost: failures, plus a second per second spent failing, plus half a point per
      // retry. A selector that "works on the 3rd try" bleeds time with few outright failures.
      const tokenPoints = TOKENS_PER_POINT > 0 ? rest.wastedTokens / TOKENS_PER_POINT : 0;
      const score = Math.round((weightedCost + rest.retries * RETRY_WEIGHT + tokenPoints) * 10) / 10;
      return { ...rest, ...(knownIssues.length ? { knownIssues } : {}), sessionCount: sessionIds.size, score, recoveries, recovery: recoveries[0] ?? null };
    })
    .sort((a, b) => b.score - a.score || (b.lastFailedAt > a.lastFailedAt ? 1 : -1))
    .slice(0, limit);
}

// Failures that apply to `origin`: that origin's own bucket plus the '' bucket (rows recorded
// before origin tracking existed - unknown, so conservatively counted). With no live origin
// (agent did not report one) every bucket counts.
export function historyForOrigin(entry, origin) {
  const out = emptyBucket();
  if (!entry) return out;
  for (const [o, b] of Object.entries(entry.origins)) {
    if (origin && o && o !== origin) continue;
    out.fails += b.fails;
    out.unresolved += b.unresolved;
    if (b.lastFailedAt && (!out.lastFailedAt || b.lastFailedAt > out.lastFailedAt)) out.lastFailedAt = b.lastFailedAt;
    if (b.lastSuccessAt && (!out.lastSuccessAt || b.lastSuccessAt > out.lastSuccessAt)) out.lastSuccessAt = b.lastSuccessAt;
  }
  return out;
}

// ---------- one view of the ranked list, for every surface ----------

export const TARGET_SORTS = {
  cost: (x, y) => y.score - x.score,
  fails: (x, y) => y.failCount - x.failCount || y.score - x.score,
  wasted: (x, y) => y.wastedMs - x.wastedMs || y.score - x.score,
  tokens: (x, y) => (y.wastedTokens || 0) - (x.wastedTokens || 0) || y.score - x.score,
  recent: (x, y) => String(y.lastFailedAt || '').localeCompare(String(x.lastFailedAt || '')),
  oldest: (x, y) => String(x.lastFailedAt || '~').localeCompare(String(y.lastFailedAt || '~')),
};

// Filter (case-insensitive substring over target, type, kind, origins, error classes and last error) then sort
// then cap. The CLI, the MCP action, GET /friction/targets and the dashboard all call this, so "the same
// filter" returns the same rows everywhere.
export function viewFrictionTargets(entries, { q = '', sort = 'cost', limit = 0 } = {}) {
  const needle = String(q ?? '').trim().toLowerCase();
  const by = TARGET_SORTS[sort] ?? TARGET_SORTS.cost;
  const hit = (e) => !needle || [e.selector, e.type, e.targetKind, ...Object.keys(e.origins || {}), ...Object.keys(e.errorClasses || {}), e.lastError || ''].join(' ').toLowerCase().includes(needle);
  const rows = (entries ?? []).filter(hit).sort(by);
  const n = Number(limit);
  return n > 0 ? rows.slice(0, n) : rows;
}

// ---------- relapses: declared fixed, failing again ----------

// resolutions: rows of friction_resolutions ({ key, type, selector, resolved_at, note }). actions: chronological.
// A relapse is a target (or a whole command type) that has failed again AFTER it was declared fixed. This is
// what "mark fixed" promised to keep visible ("a relapse shows from zero") and nothing yet reported.
export function buildRelapses(resolutions, actions) {
  const cutoffs = new Map();
  for (const r of resolutions ?? []) if (r?.key && r.resolved_at && !/^(macro|verity)::/.test(r.key)) cutoffs.set(r.key, r);
  if (!cutoffs.size) return [];
  const since = new Map(); // key -> { count, lastFailedAt, lastError, sessions:Set }
  const note = (key, a) => {
    const r = cutoffs.get(key);
    if (!r || !a.started_at || a.started_at <= r.resolved_at) return;
    const e = since.get(key) ?? { count: 0, firstFailedAt: null, lastFailedAt: null, lastError: null, sessions: new Set() };
    e.count += 1;
    if (!e.firstFailedAt || a.started_at < e.firstFailedAt) e.firstFailedAt = a.started_at;
    e.sessions.add(a.session_id);
    if (!e.lastFailedAt || a.started_at >= e.lastFailedAt) { e.lastFailedAt = a.started_at; e.lastError = a.error ? String(a.error).slice(0, 200) : null; }
    since.set(key, e);
  };
  for (const a of actions ?? []) {
    if (a.ok) continue;
    note(scopeKey('type', a.type), a);
    for (const x of expandDragTargets(a)) {
      const key = frictionKeyFor(x.type, x.params, x.origin);
      if (key) note(key, a);
    }
  }
  return [...since.entries()].map(([key, e]) => {
    const r = cutoffs.get(key);
    return {
      key, type: r.type, selector: r.selector, resolvedAt: r.resolved_at, note: r.note ?? null,
      failuresSince: e.count, sessionsSince: e.sessions.size, firstFailedAt: e.firstFailedAt, lastFailedAt: e.lastFailedAt, lastError: e.lastError,
      summary: `${r.type} ${r.selector} was declared fixed at ${r.resolved_at} and has failed ${e.count}x since${e.lastError ? ` (last: ${e.lastError})` : ''}`,
    };
  }).sort((a, b) => b.failuresSince - a.failuresSince);
}

// ---------- replay diff: where did the replay stop matching the original? ----------

const VOLATILE_KEYS = new Set(['durationMs', 'duration_ms', 'elapsedMs', 'ts', 'at', 'timestamp', 'startedAt', 'time']);
const stable = (v) => JSON.stringify(v, (k, x) => (VOLATILE_KEYS.has(k) ? undefined : x));
const SLOW_FACTOR = 3;
const SLOW_MIN_EXTRA_MS = 500;

// steps: [{ index, type, original: { ok, error?, durationMs?, result? }, replay: { ok, error?, durationMs?, result? } }]
// kind per step: same | same-failure | now-fails | now-works | different-failure | result-changed | slower.
// firstDivergence is the first step that is none of same / same-failure - "same-failure" is the reproduction itself.
export function buildReplayDiff(steps) {
  const rows = (steps ?? []).map((s) => {
    const o = s.original ?? {};
    const r = s.replay ?? {};
    const base = { index: s.index, type: s.type };
    if (o.ok && !r.ok) return { ...base, kind: 'now-fails', errorClass: classifyError(r.error), error: String(r.error ?? '').slice(0, 160) };
    if (!o.ok && r.ok) return { ...base, kind: 'now-works', wasError: String(o.error ?? '').slice(0, 160) };
    if (!o.ok && !r.ok) {
      const was = classifyError(o.error);
      const now = classifyError(r.error);
      return was === now ? { ...base, kind: 'same-failure', errorClass: now } : { ...base, kind: 'different-failure', was, now, error: String(r.error ?? '').slice(0, 160) };
    }
    if (o.result !== undefined && r.result !== undefined && stable(o.result) !== stable(r.result)) {
      const keys = new Set([...Object.keys(o.result ?? {}), ...Object.keys(r.result ?? {})]);
      const changed = [...keys].filter((k) => !VOLATILE_KEYS.has(k) && JSON.stringify(o.result?.[k]) !== JSON.stringify(r.result?.[k])).slice(0, 5);
      return { ...base, kind: 'result-changed', changed };
    }
    const od = Number(o.durationMs) || 0;
    const rd = Number(r.durationMs) || 0;
    if (rd - od >= SLOW_MIN_EXTRA_MS && rd >= od * SLOW_FACTOR) return { ...base, kind: 'slower', originalMs: od, replayMs: rd };
    return { ...base, kind: 'same' };
  });
  const firstDivergence = rows.find((x) => x.kind !== 'same' && x.kind !== 'same-failure') ?? null;
  return { compared: rows.length, firstDivergence, steps: rows.filter((x) => x.kind !== 'same') };
}

// ---------- macro runs ----------

export const MACRO_RUN_HISTORY_LIMIT = 20;

// A "run" is a burst of consecutive same-macroId actions in the chronological log: the steps of one replay are logged
// back to back, so a macroId change (or a non-macro action between them) is a real boundary. Per macro, the last
// MACRO_RUN_HISTORY_LIMIT runs, newest last; a run records whether every logged step worked and, if not, the first
// that failed (`step` counts the run's LOGGED steps - cache hits and no-op skips write no row).
// afterFix(kind, id, at): false drops actions older than a declared "mark fixed" for that macro.
export function buildMacroRuns(actions, { afterFix = () => true } = {}) {
  const runs = new Map();
  let current = null;
  for (const a of actions ?? []) {
    const macroId = a.params?.macroId;
    if (macroId === undefined) { current = null; continue; }
    if (!afterFix('macro', macroId, a.started_at)) continue;
    // a replay stamps its own id (macroRun), so two runs in a row are two runs; rows from before that fall back to the burst
    if (!current || current.macroId !== macroId || (a.params?.macroRun !== undefined && current.run !== undefined && current.run !== a.params.macroRun)) {
      current = { macroId, run: a.params?.macroRun, ok: true, startedAt: a.started_at, sessionId: a.session_id, steps: 0, failedStep: null };
      const list = runs.get(macroId) ?? [];
      list.push(current);
      if (list.length > MACRO_RUN_HISTORY_LIMIT) list.shift();
      runs.set(macroId, list);
    }
    current.steps += 1;
    if (!a.ok) {
      current.ok = false;
      current.failedStep ??= { step: current.steps, type: a.type, target: frictionTarget(a.type, a.params, a.origin)?.value ?? null, error: a.error ? String(a.error).slice(0, 160) : null };
    }
  }
  return runs;
}

// One macro's runs as the line a list needs: how often it worked, and what the last run did.
export function summarizeMacroRuns(runs) {
  if (!runs?.length) return { runs: 0, passRate: null, lastRun: null, strip: [] };
  const last = runs[runs.length - 1];
  return {
    runs: runs.length,
    passRate: Math.round((runs.filter((r) => r.ok).length / runs.length) * 100) / 100,
    lastRun: { ok: last.ok, at: last.startedAt, sessionId: last.sessionId, steps: last.steps, ...(last.failedStep ? { failedStep: last.failedStep } : {}) },
    strip: runs.map((r) => r.ok),
  };
}

// ---------- trend: is a target getting better or worse across sessions? ----------

const SPARK = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
export const TREND_SESSIONS = 8;
const TREND_DELTA = 0.15; // a change of this much in the failure rate is a trend; less is noise

export function sparkline(rates) {
  return rates.map((r) => SPARK[Math.min(SPARK.length - 1, Math.max(0, Math.round(r * (SPARK.length - 1))))]).join('');
}

// Per target, per session: how many calls failed and how many worked. `direction` compares the newest session's
// failure rate with the mean of up to three before it. `fixedAt` (from friction_resolutions) marks the sessions that
// began after the declared fix, so a fix that held reads as a drop that stays down, a relapse as a climb.
//   actions: chronological rows; resolutions: Map<key, ISO>; key: one target (else every target with 2+ sessions)
export function buildFrictionTrend(actions, { resolutions = new Map(), key = null, sessions = TREND_SESSIONS } = {}) {
  const perKey = new Map(); // key -> { target info, bySession: Map<sessionId, { fails, oks, firstAt }> }
  for (const a of (actions ?? []).flatMap(expandDragTargets)) {
    const target = frictionTarget(a.type, a.params, a.origin);
    if (!target) continue;
    const k = targetKey(a.type, target);
    if (key && k !== key) continue;
    const e = perKey.get(k) ?? { key: k, type: typeFamily(a.type), targetKind: target.kind, selector: target.value, bySession: new Map() };
    const s = e.bySession.get(a.session_id) ?? { sessionId: a.session_id, fails: 0, oks: 0, firstAt: a.started_at };
    if (a.ok) s.oks += 1; else { s.fails += 1; e.selector = target.value; }
    if (a.started_at && (!s.firstAt || a.started_at < s.firstAt)) s.firstAt = a.started_at;
    e.bySession.set(a.session_id, s);
    perKey.set(k, e);
  }
  const rows = [];
  for (const e of perKey.values()) {
    const fixedAt = resolutions.get(e.key) ?? null;
    const points = [...e.bySession.values()].sort((x, y) => x.sessionId - y.sessionId).slice(-Math.max(2, sessions)).map((s) => ({
      sessionId: s.sessionId, fails: s.fails, oks: s.oks, rate: Math.round((s.fails / Math.max(1, s.fails + s.oks)) * 100) / 100, ...(fixedAt && s.firstAt && s.firstAt > fixedAt ? { afterFix: true } : {}),
    }));
    if (!key && (points.length < 2 || !points.some((p) => p.fails > 0))) continue;
    let direction = 'new';
    let delta = 0;
    if (points.length >= 2) {
      const last = points[points.length - 1].rate;
      const before = points.slice(-4, -1);
      const prev = before.reduce((sum, p) => sum + p.rate, 0) / before.length;
      delta = Math.round((last - prev) * 100) / 100;
      direction = delta >= TREND_DELTA ? 'worsening' : delta <= -TREND_DELTA ? 'improving' : 'steady';
    }
    rows.push({ key: e.key, type: e.type, targetKind: e.targetKind, selector: e.selector, direction, delta, sparkline: sparkline(points.map((p) => p.rate)), fixedAt, points });
  }
  return rows.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
}

// The two lists a person scans: what is getting worse (act on these) and what is getting better (the fix held).
export function summarizeTrends(rows, { limit = 5 } = {}) {
  const lean = (r) => ({ key: r.key, type: r.type, selector: r.selector, delta: r.delta, sparkline: r.sparkline, sessions: r.points.length, lastRate: r.points[r.points.length - 1].rate });
  return {
    worsening: rows.filter((r) => r.direction === 'worsening').slice(0, limit).map(lean),
    improving: rows.filter((r) => r.direction === 'improving').slice(0, limit).map(lean),
    tracked: rows.length,
  };
}

// ---------- session-start briefing ----------

const GOAL_STOPWORDS = new Set(['with', 'from', 'that', 'this', 'into', 'then', 'test', 'tests', 'page', 'check', 'make', 'when', 'have', 'does', 'only', 'about', 'after', 'before']);

// The targets that are STILL failing and likely to matter to THIS session, ranked by relevance to its
// declared goal and the origin it is pinned to, then by cost. Relevance: the target was seen on the
// session's origin (+2) and each distinct goal word (4+ letters) found in its selector / last error (+1,
// capped at 3). Entries that were fixed since (a success after the last failure on every origin) are
// left out - a briefing about solved problems is noise. Nothing relevant? the costliest still-failing
// targets are returned unmarked, so a fresh goal still sees the project's worst wall.
export function buildSessionBriefing(selectorFriction, { goal = '', origin = null, limit = 5 } = {}) {
  const words = [...new Set(String(goal).toLowerCase().match(/[a-z][a-z0-9_-]{3,}/g) ?? [])].filter((w) => !GOAL_STOPWORDS.has(w));
  const rows = [];
  for (const e of selectorFriction ?? []) {
    const unresolved = Object.values(e.origins ?? {}).reduce((n, b) => n + (b.unresolved || 0), 0);
    if (!unresolved) continue;
    const originHit = Boolean(origin) && Object.keys(e.origins ?? {}).some((o) => o && (o === origin || o.startsWith(origin)));
    const haystack = `${e.selector} ${e.lastError ?? ''}`.toLowerCase();
    const goalHits = words.filter((w) => haystack.includes(w)).length;
    const relevance = (originHit ? 2 : 0) + Math.min(goalHits, 3);
    const topClass = Object.entries(e.errorClasses ?? {}).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const r = e.recovery;
    rows.push({
      key: e.key, type: e.type, kind: e.targetKind, target: e.selector, failCount: e.failCount, unresolved, errorClass: topClass, score: e.score, relevance, relevant: relevance > 0,
      ...(r ? { worked: r.kind === 'alt-selector' ? `use "${r.selector}" instead (worked ${r.worked}/${r.of})` : `${r.type}${r.selector ? ` "${r.selector}"` : ''} first (worked ${r.worked}/${r.of})` } : {}),
    });
  }
  rows.sort((a, b) => b.relevance - a.relevance || b.score - a.score);
  return rows.slice(0, limit);
}

// ---------- live per-session tracker ----------

// `persist` (optional) lets the owner make the dedupe state survive a relay restart:
//   persist.warn(sessionId, key, atLive, count) / persist.announce(sessionId, kind, key).
// The counters themselves are rebuilt from the action log (see replay) - they are a pure function
// of it, so only the "already said" state needs storing.
export function createFrictionTracker({ persist = null } = {}) {
  const live = new Map(); // sessionId -> Map<frictionKey, liveEntry>
  const warned = new Map(); // sessionId -> Map<frictionKey, { atLive, count }>
  const announced = new Set(); // `${sessionId}|${kind}|${key}` for one-shot live emergent notes

  const sessionMap = (map, sessionId) => {
    let m = map.get(sessionId);
    if (!m) { m = new Map(); map.set(sessionId, m); }
    return m;
  };

  const tracker = {
    // Called from the one place every action is logged. Returns the updated live entry when the
    // action carried a target (null otherwise) so callers can react to a failure immediately.
    note(sessionId, { type, params, origin, ok, error, durationMs, at }) {
      // A drag also counts against its drop target (see expandDragTargets).
      if (type === 'dom.drag' && typeof params?.to === 'string' && params.to) tracker.note(sessionId, { type, params: { selector: params.to }, origin, ok, error, durationMs, at });
      const target = frictionTarget(type, params, origin);
      if (!target) return null;
      const key = targetKey(type, target);
      const entries = sessionMap(live, sessionId);
      const entry = entries.get(key) ?? { target: { kind: target.kind, value: target.value, type: typeFamily(type) }, fails: 0, unresolved: 0, lastOkAt: null, lastFailedAt: null, lastError: null, errorClass: null, classes: {}, wastedMs: 0 };
      entries.set(key, entry);
      if (ok) {
        entry.unresolved = 0;
        entry.lastOkAt = at ?? new Date().toISOString();
      } else {
        const klass = classifyError(error);
        entry.fails += 1;
        entry.unresolved += 1;
        entry.lastFailedAt = at ?? new Date().toISOString();
        entry.lastError = error ? String(error).slice(0, 200) : null;
        entry.errorClass = klass;
        entry.classes[klass] = (entry.classes[klass] ?? 0) + 1;
        entry.wastedMs += Number(durationMs) || 0;
      }
      return entry;
    },
    get(sessionId, key) {
      return live.get(sessionId)?.get(key) ?? null;
    },
    // Every key this session has touched, for session-end summaries.
    keys(sessionId) {
      return [...(live.get(sessionId)?.keys() ?? [])];
    },
    has(sessionId) {
      return live.has(sessionId);
    },
    warnState(sessionId, key) {
      return warned.get(sessionId)?.get(key) ?? null;
    },
    recordWarn(sessionId, key, atLive) {
      const map = sessionMap(warned, sessionId);
      const prev = map.get(key);
      const count = (prev?.count ?? 0) + 1;
      map.set(key, { atLive, count });
      persist?.warn?.(sessionId, key, atLive, count);
    },
    // true the first time (sessionId, kind, key) is seen - for once-per-session live notes.
    announceOnce(sessionId, kind, key) {
      const id = `${sessionId}|${kind}|${key}`;
      if (announced.has(id)) return false;
      announced.add(id);
      persist?.announce?.(sessionId, kind, key);
      return true;
    },
    // Rebuild a session's counters from its logged actions (chronological rows, as
    // db.listActions(id, {ascending:true}) returns them) and re-install the persisted dedupe state.
    // Safe to call once per session per process: used when a relay restarts under a live session.
    restore(sessionId, rows, { warns = [], announces = [] } = {}) {
      for (const a of rows) {
        tracker.note(sessionId, { type: a.type, params: a.params, origin: a.origin, ok: Boolean(a.ok), error: a.error, durationMs: a.duration_ms, at: a.started_at });
      }
      const map = sessionMap(warned, sessionId);
      for (const w of warns) map.set(w.key, { atLive: w.at_live, count: w.count });
      for (const n of announces) announced.add(`${sessionId}|${n.kind}|${n.key}`);
    },
    dropSession(sessionId) {
      live.delete(sessionId);
      warned.delete(sessionId);
      const prefix = `${sessionId}|`;
      for (const id of announced) if (id.startsWith(prefix)) announced.delete(id);
    },
  };
  return tracker;
}

// ---------- the pre-action decision ----------

function describeRecovery(recovery) {
  if (!recovery) return null;
  const odds = recovery.of > 1 ? ` (${recovery.worked} of ${recovery.of} times)` : '';
  if (recovery.kind === 'alt-selector') return `after a failure here, "${recovery.selector}" (${recovery.type}) worked${odds}`;
  return `after a failure here, ${recovery.type}${recovery.selector ? ` on "${recovery.selector}"` : ''} then worked${odds}`;
}

function topClass(classes) {
  let best = null;
  for (const [k, n] of Object.entries(classes ?? {})) if (!best || n > best[1]) best = [k, n];
  return best?.[0] ?? null;
}

// entry: the history entry for this key (or undefined) - built from OTHER sessions only. live:
// tracker entry (or null). state: tracker warnState (or null). Returns
// { assessment, reason, facts }: assessment is null (say nothing) or
// { level: 'warn' | 'repeat' | 'escalated', message, errorClass, liveFailures, liveUnresolved };
// reason says why in one line; facts carries the numbers it was judged on. No side effects, so
// `friction explain` can call it without disturbing the once-per-session dedupe.
export function evaluateSelectorRisk({ type, selector, targetKind = 'selector', entry, live, state, origin, snoozedUntil = null }) {
  const hist = historyForOrigin(entry, origin);
  const liveUnresolved = live?.unresolved ?? 0;
  const liveFails = live?.fails ?? 0;
  const facts = {
    historyFails: hist.fails,
    historyUnresolved: hist.unresolved,
    liveFails,
    liveUnresolved,
    warnedAtLive: state?.atLive ?? null,
    thresholds: { unresolvedHistory: RISKY_SELECTOR_FAIL_THRESHOLD, liveFails: LIVE_FAIL_THRESHOLD, escalateAt: ESCALATE_AFTER_LIVE_FAILS },
  };
  // Snoozed on purpose: quiet until the date, without claiming it is fixed.
  if (snoozedUntil) return { assessment: null, reason: `quiet: snoozed until ${snoozedUntil} (friction unsnooze to hear about it again)`, facts };
  // It worked earlier in THIS session and has not failed since: whatever history says, it works now.
  if (live?.lastOkAt && liveUnresolved === 0) {
    return { assessment: null, reason: 'quiet: it succeeded earlier in this session and has not failed since, so older history is ignored', facts };
  }
  const risky = hist.unresolved + liveUnresolved >= RISKY_SELECTOR_FAIL_THRESHOLD || liveUnresolved >= LIVE_FAIL_THRESHOLD;
  if (!risky) {
    return { assessment: null, reason: `quiet: ${hist.unresolved} unresolved earlier failure(s) + ${liveUnresolved} this session; it warns at ${RISKY_SELECTOR_FAIL_THRESHOLD} combined or ${LIVE_FAIL_THRESHOLD} this session`, facts };
  }
  // Already warned, and nothing new has happened since: stay quiet (a warning repeated on every
  // call trains the reader to ignore it). A further same-session failure counts as new.
  if (state && liveUnresolved <= state.atLive) {
    return { assessment: null, reason: `quiet: already warned this session (at ${state.atLive} live failure(s)) and nothing new has failed since`, facts };
  }

  const level = liveUnresolved >= ESCALATE_AFTER_LIVE_FAILS ? 'escalated' : state ? 'repeat' : 'warn';
  const klass = live?.errorClass ?? topClass(entry?.errorClasses);
  const parts = [];
  if (hist.fails > 0) parts.push(`failed ${hist.fails}x before across ${entry.sessionCount} session(s), last at ${hist.lastFailedAt}`);
  if (liveFails > 0) parts.push(`failed ${liveFails}x already this session`);
  let message = `${targetLabel(targetKind)} "${selector}" (${type}) has ${parts.join(' and ')}`;
  if (klass && klass !== 'other') message += ` [${klass}]`;
  const lastError = live?.lastError ?? entry?.lastError;
  if (lastError) message += ` - last error: ${JSON.stringify(lastError.slice(0, 120))}`;
  const recoveryText = describeRecovery(entry?.recovery);
  message += recoveryText ? ` - ${recoveryText}.` : ` - ${CLASS_ADVICE[klass] ?? 'consider dom.click-wait or a settle/wait first.'}`;
  const known = entry?.knownIssues?.[0];
  if (known) message += ` known issue: ${known.id}${known.remediation ? ` (${known.remediation})` : ''}`;
  if (level === 'escalated') message = `ESCALATED (${liveUnresolved} failures this session, warning already shown): ${message}`;
  return { assessment: { level, message, errorClass: klass, liveFailures: liveFails, liveUnresolved }, reason: `would say it (${level})`, facts };
}

export function assessSelectorRisk(args) {
  return evaluateSelectorRisk(args).assessment;
}

// What a FAILED command's own error should carry (not only a header). Null when the action had
// no friction target.
export function failureContext({ type, selector, targetKind = 'selector', entry, live, origin }) {
  if (!selector || typeof selector !== 'string') return null;
  const hist = historyForOrigin(entry, origin);
  const recovery = describeRecovery(entry?.recovery);
  return {
    errorClass: live?.errorClass ?? null,
    failuresThisSession: live?.fails ?? 0,
    priorFailures: hist.fails,
    ...(recovery ? { workedBefore: recovery } : {}),
    advice: recovery ? undefined : CLASS_ADVICE[live?.errorClass] ?? undefined,
    type,
    ...(targetKind !== 'selector' ? { targetKind } : {}),
  };
}

// The ONE rendering of a failure's friction context. The CLI and the MCP server both print
// through this, so the two front ends cannot drift apart again (friction-contract.test.mjs).
export function describeFailureContext(f) {
  if (!f) return null;
  return `Friction: ${f.errorClass ?? 'unclassified'} failure, ${f.failuresThisSession}x this session, ${f.priorFailures}x in earlier sessions${f.workedBefore ? ` - ${f.workedBefore}` : f.advice ? ` - ${f.advice}` : ''}`;
}

// ---------- rate-spike detector (session end) ----------

// totalsByType: [{ type, total, failed }] project-wide INCLUDING the session being judged
// (computeAnalytics().failureRateByType). Flags a type whose failure rate THIS session is
// SPIKE_FACTOR x its rate across every other session - the "same wall, much harder" case the
// first-ever diff cannot see because the type already has history.
// The one place per-command-type totals are counted. computeAnalytics (project-wide failureRateByType),
// the live "failed for the first time ever" line and the session-end spike check all read this, so a type's
// numbers cannot differ between the dashboard and what the agent was told. `counts(action)` lets the
// caller drop actions declared fixed. Returns Map type -> { type, total, failed, wastedMs }.
export function tallyTypeFailures(actions, { counts = () => true } = {}) {
  const byType = new Map();
  for (const a of actions) {
    if (!counts(a)) continue;
    const t = byType.get(a.type) ?? { type: a.type, total: 0, failed: 0, wastedMs: 0 };
    t.total += 1;
    if (!a.ok) { t.failed += 1; t.wastedMs += Number(a.duration_ms) || 0; }
    byType.set(a.type, t);
  }
  return byType;
}

export function findRateSpikes(sessionActions, totalsByType) {
  const perType = new Map();
  for (const a of sessionActions) {
    const t = perType.get(a.type) ?? { total: 0, failed: 0 };
    t.total += 1;
    if (!a.ok) t.failed += 1;
    perType.set(a.type, t);
  }
  const lines = [];
  for (const [type, s] of perType) {
    if (s.failed < 2 || s.total < 3) continue;
    const g = totalsByType.find((t) => t.type === type);
    const priorTotal = (g?.total ?? s.total) - s.total;
    const priorFailed = (g?.failed ?? s.failed) - s.failed;
    if (priorTotal < SPIKE_MIN_PRIOR_CALLS || priorFailed <= 0) continue; // no baseline, or "first ever" owns it
    const baseline = Math.max(priorFailed / priorTotal, 0.02);
    const rate = s.failed / s.total;
    if (rate >= baseline * SPIKE_FACTOR) {
      lines.push(`"${type}" failure rate spiked: ${Math.round(rate * 100)}% this session (${s.failed}/${s.total}) vs ${Math.round((priorFailed / priorTotal) * 100)}% across ${priorTotal} prior call(s).`);
    }
  }
  return lines;
}

// ---------- "mark fixed?" suggestions ----------

// A selector that failed repeatedly and has since worked several times in a row, across more
// than one session, is almost certainly fixed - but nobody ever declares that, so it keeps
// ranking on history. rows: chronological actions (any keys). resolutions as in
// buildSelectorFriction. Returns [{ key, type, selector, targetKind, failures, okStreak, sessions, hint }].
export function findResolveSuggestions(rows, { resolutions = new Map(), onlyKeys = null } = {}) {
  const byKey = new Map();
  for (const a of rows) {
    const target = frictionTarget(a.type, a.params, a.origin);
    if (!target) continue;
    const key = targetKey(a.type, target);
    if (onlyKeys && !onlyKeys.has(key)) continue;
    const g = byKey.get(key) ?? { key, type: typeFamily(a.type), target, failures: 0, streak: [], };
    const cutoff = resolutions.get(key);
    if (cutoff && a.started_at <= cutoff) { byKey.set(key, g); continue; }
    if (a.ok) {
      g.streak.push(a);
    } else {
      g.failures += 1;
      g.streak = [];
    }
    byKey.set(key, g);
  }
  const out = [];
  for (const g of byKey.values()) {
    if (g.failures < RESOLVE_SUGGEST_MIN_FAILS || g.streak.length < RESOLVE_SUGGEST_MIN_OKS) continue;
    const sessions = new Set(g.streak.map((a) => a.session_id)).size;
    if (sessions < RESOLVE_SUGGEST_MIN_SESSIONS) continue;
    out.push({
      key: g.key, type: g.type, selector: g.target.value, targetKind: g.target.kind, failures: g.failures, okStreak: g.streak.length, sessions,
      hint: `${targetLabel(g.target.kind)} "${g.target.value}" (${g.type}) failed ${g.failures}x, then succeeded ${g.streak.length}x in a row across ${sessions} session(s) - if it was fixed, run: friction resolve ${g.type} ${JSON.stringify(g.target.value)}`,
    });
  }
  return out;
}

// ---------- root-cause clusters ----------

// Same failure, many names: `.btn-primary` failing on five pages, or ten rows failing with the same
// "Element not found" - each is its own entry in the per-target list, but it is ONE cause. Entries
// that share an error class and a placeholder-normalized error message are grouped, and a group is a
// cluster once it spans CLUSTER_MIN_TARGETS different targets. Pure over buildSelectorFriction's rows.
export const CLUSTER_MIN_TARGETS = envNumber('WEBSCOUT_CLUSTER_MIN_TARGETS', 3);

export function normalizeErrorText(text) {
  const firstLine = String(text ?? '').split('\n')[0];
  return firstLine.replace(/"[^"]*"|'[^']*'|#[\w-]+|\b0x[0-9a-f]+\b|\d+/gi, '*').replace(/\s+/g, ' ').trim();
}

// Short stable id for a cluster (same cause = same id across calls), so `friction resolve cluster <id>` can name it.
const clusterId = (errorClass, signature) => {
  let h = 5381;
  for (const ch of `${errorClass}|${signature}`) h = ((h * 33) ^ ch.codePointAt(0)) >>> 0;
  return h.toString(16).padStart(8, '0');
};

// targetLimit: how many targets each cluster lists (the digest shows 8; resolving a whole cluster needs all).
export function buildFrictionClusters(entries, { minTargets = CLUSTER_MIN_TARGETS, limit = 5, targetLimit = 8 } = {}) {
  const groups = new Map();
  for (const e of entries) {
    if (!e.lastError) continue;
    const errorClass = topClass(e.errorClasses) ?? 'other';
    // The message usually quotes the very selector that failed, which would make every target look unique.
    const signature = normalizeErrorText(e.selector ? e.lastError.split(e.selector).join('*') : e.lastError);
    if (!signature) continue;
    const id = `${errorClass}|${signature}`;
    const g = groups.get(id) ?? { errorClass, signature, sample: e.lastError, targets: [], failCount: 0, wastedMs: 0, score: 0, origins: new Set(), types: new Set() };
    g.targets.push({ key: e.key, type: e.type, selector: e.selector, targetKind: e.targetKind, failCount: e.failCount });
    g.failCount += e.failCount;
    g.wastedMs += e.wastedMs;
    g.score += e.score;
    g.types.add(e.type);
    for (const o of Object.keys(e.origins ?? {})) if (o) g.origins.add(o);
    groups.set(id, g);
  }
  return [...groups.values()]
    .filter((g) => g.targets.length >= minTargets)
    .map((g) => ({
      id: clusterId(g.errorClass, g.signature),
      errorClass: g.errorClass,
      signature: g.signature,
      sample: g.sample.slice(0, 200),
      targetCount: g.targets.length,
      failCount: g.failCount,
      wastedMs: g.wastedMs,
      score: Math.round(g.score * 10) / 10,
      types: [...g.types],
      origins: [...g.origins],
      targets: g.targets.sort((a, b) => b.failCount - a.failCount).slice(0, targetLimit),
      summary: `one cause behind ${g.targets.length} targets (${g.failCount} failures): ${g.sample.slice(0, 100)} - all fixed? friction resolve cluster ${clusterId(g.errorClass, g.signature)}`,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// ---------- known-issue candidates ----------

// A starting point for the one field a draft cannot know. Prefer what actually worked after these
// selectors failed (the most common recovery across their friction entries); otherwise the generic
// advice for the error class. Always a suggestion: promote still wants a human-supplied remediation.
function suggestRemediation(selectors, errorClass, entries) {
  const wanted = new Set(selectors.map((s) => normalizeSelector(s)));
  const tally = new Map();
  for (const e of entries) {
    if (e.targetKind !== 'selector' || !wanted.has(normalizeSelector(e.selector))) continue;
    for (const r of e.recoveries ?? []) {
      const sig = `${r.kind}|${r.type}|${r.selector ?? ''}`;
      const t = tally.get(sig) ?? { recovery: r, worked: 0, of: 0 };
      t.worked += r.worked;
      t.of += r.of;
      tally.set(sig, t);
    }
  }
  const best = [...tally.values()].sort((a, b) => b.worked - a.worked)[0];
  if (best && best.worked >= 2) {
    const r = best.recovery;
    const what = r.kind === 'alt-selector' ? `use "${r.selector}" (${r.type}) instead` : `${r.type}${r.selector ? ` on "${r.selector}"` : ''} first`;
    return { text: `${what} - it worked ${best.worked} of ${best.of} times after this failure`, from: 'recovery' };
  }
  return CLASS_ADVICE[errorClass] ? { text: CLASS_ADVICE[errorClass].replace(/\.$/, ''), from: 'advice' } : null;
}

// Failing the same way repeatedly with no known-issues.json match is exactly the entry an
// operator has not written yet. Groups failed actions by a placeholder-normalized message and
// proposes a draft entry (signature = the stable literal prefix, so it works as a plain
// substring match). Draft only - nothing is written to the registry unless `known-issues
// promote --confirm` is run on it.
export function buildKnownIssueCandidates(actions, { matchKnownIssues = () => [], limit = 5, frictionEntries = [] } = {}) {
  const groups = new Map();
  for (const a of actions) {
    if (a.ok || !a.error) continue;
    if (matchKnownIssues(a.error).length) continue;
    const firstLine = String(a.error).split('\n')[0];
    const normalized = normalizeErrorText(firstLine);
    if (!normalized) continue;
    const g = groups.get(normalized) ?? { normalized, sample: firstLine, count: 0, sessionIds: new Set(), types: new Set(), selectors: new Map() };
    g.count += 1;
    g.sessionIds.add(a.session_id);
    g.types.add(a.type);
    if (typeof a.params?.selector === 'string') g.selectors.set(a.params.selector, (g.selectors.get(a.params.selector) ?? 0) + 1);
    groups.set(normalized, g);
  }
  return [...groups.values()]
    .filter((g) => g.count >= CANDIDATE_MIN_FAILS)
    .sort((a, b) => b.count - a.count)
    .slice(0, limit)
    .map((g) => {
      const prefix = g.normalized.split('*')[0].trim().replace(/[:\-(,]+$/, '').trim();
      const signature = prefix.length >= 8 ? prefix : g.sample.slice(0, 80);
      const topSelectors = [...g.selectors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([s]) => s);
      const errorClass = classifyError(g.sample);
      const suggestion = suggestRemediation(topSelectors, errorClass, frictionEntries);
      return {
        errorClass,
        ...(suggestion ? { suggestedRemediation: suggestion.text, suggestedFrom: suggestion.from } : {}),
        sample: g.sample.slice(0, 200),
        count: g.count,
        sessionCount: g.sessionIds.size,
        types: [...g.types],
        topSelectors,
        draft: {
          id: `candidate-${signature.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'unnamed'}`,
          signature,
          description: `TODO: root cause. Seen ${g.count}x across ${g.sessionIds.size} session(s)${topSelectors.length ? `, e.g. ${topSelectors.join(', ')}` : ''}.`,
          remediation: 'TODO',
        },
      };
    });
}

// ---------- snooze ----------

export const SNOOZE_MAX_DAYS = 90;
const SNOOZE_UNIT_MS = { m: 60e3, h: 3600e3, d: 86400e3, w: 7 * 86400e3 };

// "30m" | "12h" | "2d" | "1w", or an ISO date / datetime, to the instant the snooze ends (ISO string).
// Throws a message that names the accepted forms; the cap keeps a snooze from becoming a silent mute.
export function parseSnoozeUntil(text, now = Date.now()) {
  const s = String(text ?? '').trim();
  const rel = /^(\d+)\s*([mhdw])$/i.exec(s);
  let at = null;
  if (rel) at = now + Number(rel[1]) * SNOOZE_UNIT_MS[rel[2].toLowerCase()];
  else if (/^\d{4}-\d{2}-\d{2}/.test(s) && !Number.isNaN(Date.parse(s))) at = Date.parse(s);
  if (at === null) throw new Error('for must be a span like 30m, 12h, 2d, 1w - or a date like 2026-12-31');
  if (at <= now) throw new Error('that time has already passed');
  if (at - now > SNOOZE_MAX_DAYS * 86400e3) throw new Error(`a snooze is at most ${SNOOZE_MAX_DAYS} days - mark it fixed, or capture it as a known issue, if it is longer than that`);
  return new Date(at).toISOString();
}
