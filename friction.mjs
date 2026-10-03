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

// The knobs in effect, for `friction explain` and the health surface - an operator can see what
// the warn is being judged against without reading the environment.
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
// Origin granularity, not path - the agent reports an origin only.
export const PAGE_TYPES = new Set(['page.reload', 'page.hardReload', 'page.epoch', 'dom.settle', 'dom.screenshot', 'console.wait', 'net.wait', 'react.tree', 'idb.list']);

export function frictionTarget(type, params, origin = null) {
  const selector = params?.selector;
  if (typeof selector === 'string' && selector) return { kind: 'selector', value: selector };
  const store = params?.store;
  if (typeof store === 'string' && store && /^idb\./.test(type)) return { kind: 'store', value: store };
  if (typeof origin === 'string' && origin && PAGE_TYPES.has(type)) return { kind: 'page', value: origin };
  return null;
}

function targetKey(type, target) {
  const part = target.kind === 'store' ? `store:${target.value.trim()}` : target.kind === 'page' ? `page:${target.value.trim()}` : normalizeSelector(target.value);
  return `${typeFamily(type)}::${part}`;
}

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
const RETRY_WEIGHT = 0.5; // a failure that was immediately re-attempted cost an extra round trip

function emptyBucket() {
  return { fails: 0, unresolved: 0, lastFailedAt: null, lastSuccessAt: null };
}

// actions: chronological rows as returned by db.listAllActions() (optionally carrying
// `origin` / `error_class` columns). `resolutions`: Map<frictionKey, resolvedAtISO> - failures
// at or before that instant are an operator-declared "fixed" and are ignored. `minFails` is 2 for
// "recurring" lists and 1 when the caller wants the entry for ONE key whatever its count.
export function buildSelectorFriction(actions, { matchKnownIssues = () => [], resolutions = new Map(), limit = SELECTOR_FRICTION_LIMIT, minFails = 2 } = {}) {
  const entries = new Map();
  const isResolved = (key, at) => {
    const cutoff = resolutions.get(key);
    return Boolean(cutoff && at && at <= cutoff);
  };

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
      origins: {}, errorClasses: {}, lastError: null, wastedMs: 0, retries: 0, knownIssues: [], recMap: new Map(), recoveryTrials: 0,
    };
    entries.set(key, entry);
    entry.failCount += 1;
    entry.sessionIds.add(a.session_id);
    entry.wastedMs += Number(a.duration_ms) || 0;
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
      entry.recoveryTrials += 1;
      let recoveryFound = false;
      let retried = false;
      for (let j = i + 1; j < rows.length && j <= i + RECOVERY_LOOKAHEAD; j += 1) {
        const next = rows[j];
        const nextTarget = frictionTarget(next.type, next.params, next.origin);
        if (!retried && nextTarget && targetKey(next.type, nextTarget) === key) {
          retried = true;
          entry.retries += 1;
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
    .map(({ sessionIds, recMap, recoveryTrials, knownIssues, ...rest }) => {
      const recoveries = [...recMap.values()]
        .map((r) => ({ ...r, of: recoveryTrials }))
        .sort((a, b) => b.worked - a.worked || (b.at > a.at ? 1 : -1))
        .slice(0, 3);
      // Ranking cost: failures, plus a second per second spent failing, plus half a point per
      // retry. A selector that "works on the 3rd try" bleeds time with few outright failures.
      const score = Math.round((rest.failCount + rest.wastedMs / 1000 + rest.retries * RETRY_WEIGHT) * 10) / 10;
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
      const key = frictionKeyFor(type, params, origin);
      if (!key) return null;
      const entries = sessionMap(live, sessionId);
      const entry = entries.get(key) ?? { fails: 0, unresolved: 0, lastOkAt: null, lastFailedAt: null, lastError: null, errorClass: null, classes: {}, wastedMs: 0 };
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
export function evaluateSelectorRisk({ type, selector, targetKind = 'selector', entry, live, state, origin }) {
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
    const normalized = firstLine.replace(/"[^"]*"|'[^']*'|#[\w-]+|\b0x[0-9a-f]+\b|\d+/gi, '*').replace(/\s+/g, ' ').trim();
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
