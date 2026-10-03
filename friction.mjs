// Pure friction-awareness helpers shared by relay.mjs (no I/O, no module-level DB access, so
// every rule here is unit-testable on plain arrays - see friction.test.mjs).
//
// What lives here, and why it is not inline in relay.mjs any more:
//   - selector normalization + type families: a selector's risk used to be keyed by the exact
//     `type::selector` string, so `#row-41` vs `#row-42`, `click` vs `clickWait`, or `a > b` vs
//     `a>b` each looked like a brand-new, clean selector.
//   - error classification: "not found" and "timeout" want different remediations.
//   - buildSelectorFriction: the cross-session scan behind the pre-action warn. Unlike the older
//     topFailedSelectors it is (a) origin-scoped, (b) success-aware (a failure followed by a
//     success no longer counts as unresolved), (c) class/cost/recovery-annotated.
//   - the live per-session tracker: the session-start snapshot is frozen on purpose (it must
//     never poison the shared analytics cache), so a selector that starts failing INSIDE the
//     current session was invisible to the warn until the next session. The tracker overlays it.
//   - assessSelectorRisk: history + live + per-session dedupe/escalation -> one decision.
//   - rate-spike and known-issue-candidate detectors.

function envNumber(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Thresholds (item: configurable). All overridable via env so an operator can tune noise vs
// sensitivity without editing code; invalid/non-positive values fall back to the default.
export const RISKY_SELECTOR_FAIL_THRESHOLD = envNumber('WEBSCOUT_RISKY_FAIL_THRESHOLD', 3); // unresolved prior failures that make a selector "risky"
export const LIVE_FAIL_THRESHOLD = envNumber('WEBSCOUT_RISKY_LIVE_FAIL_THRESHOLD', 2); // same-session failures that warn on their own
export const ESCALATE_AFTER_LIVE_FAILS = envNumber('WEBSCOUT_RISKY_ESCALATE_FAILS', 3); // same-session failures at which the warning escalates
export const WASTE_MIN_CALLS = envNumber('WEBSCOUT_WASTE_MIN_CALLS', 5);
export const SPIKE_FACTOR = envNumber('WEBSCOUT_SPIKE_FACTOR', 3);
export const SPIKE_MIN_PRIOR_CALLS = envNumber('WEBSCOUT_SPIKE_MIN_PRIOR_CALLS', 10);
export const CANDIDATE_MIN_FAILS = envNumber('WEBSCOUT_KNOWN_ISSUE_CANDIDATE_MIN_FAILS', 3);
export const SELECTOR_FRICTION_LIMIT = 100;

// ---------- selector identity ----------

// click and clickWait are the same user intent on the same element; a selector that keeps
// failing under one is just as risky under the other.
const TYPE_FAMILIES = { 'dom.clickWait': 'dom.click' };
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

export function frictionKey(type, selector) {
  return `${typeFamily(type)}::${normalizeSelector(selector)}`;
}

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

const WAIT_TYPE = /^dom\.(?:wait|clickWait)/;
const RECOVERY_LOOKAHEAD = 6;

function emptyBucket() {
  return { fails: 0, unresolved: 0, lastFailedAt: null, lastSuccessAt: null };
}

// actions: chronological rows as returned by db.listAllActions() (optionally carrying
// `origin` / `error_class` columns). `resolutions`: Map<frictionKey, resolvedAtISO> - failures
// at or before that instant are an operator-declared "fixed" and are ignored.
export function buildSelectorFriction(actions, { matchKnownIssues = () => [], resolutions = new Map(), limit = SELECTOR_FRICTION_LIMIT } = {}) {
  const entries = new Map();
  const isResolved = (key, at) => {
    const cutoff = resolutions.get(key);
    return Boolean(cutoff && at && at <= cutoff);
  };

  for (const a of actions) {
    const selector = a.params?.selector;
    if (!selector || typeof selector !== 'string') continue;
    const key = frictionKey(a.type, selector);
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
      key, type: typeFamily(a.type), selector, failCount: 0, sessionIds: new Set(), lastFailedAt: null, lastSuccessAt: null,
      origins: {}, errorClasses: {}, lastError: null, wastedMs: 0, knownIssues: [], recovery: null,
    };
    entries.set(key, entry);
    entry.failCount += 1;
    entry.sessionIds.add(a.session_id);
    entry.wastedMs += Number(a.duration_ms) || 0;
    const klass = a.error_class || classifyError(a.error);
    entry.errorClasses[klass] = (entry.errorClasses[klass] ?? 0) + 1;
    if (!entry.lastFailedAt || a.started_at >= entry.lastFailedAt) {
      entry.lastFailedAt = a.started_at;
      entry.selector = selector;
      entry.lastError = a.error ? String(a.error).slice(0, 200) : null;
    }
    const bucket = (entry.origins[origin] ??= emptyBucket());
    bucket.fails += 1;
    bucket.unresolved += 1;
    if (!bucket.lastFailedAt || a.started_at > bucket.lastFailedAt) bucket.lastFailedAt = a.started_at;
    for (const hit of matchKnownIssues(a.error)) if (!entry.knownIssues.some((x) => x.id === hit.id)) entry.knownIssues.push(hit);
  }

  // Recovery pass: what did the SAME session do right after a failure that then worked? Looks a
  // few actions ahead for (a) the same intent with a different selector or (b) a wait/settle step.
  const bySession = new Map();
  for (const a of actions) {
    const list = bySession.get(a.session_id);
    if (list) list.push(a); else bySession.set(a.session_id, [a]);
  }
  for (const rows of bySession.values()) {
    for (let i = 0; i < rows.length; i += 1) {
      const fail = rows[i];
      if (fail.ok || typeof fail.params?.selector !== 'string') continue;
      const key = frictionKey(fail.type, fail.params.selector);
      const entry = entries.get(key);
      if (!entry || isResolved(key, fail.started_at)) continue;
      for (let j = i + 1; j < rows.length && j <= i + RECOVERY_LOOKAHEAD; j += 1) {
        const next = rows[j];
        if (!next.ok) continue;
        const nextSel = typeof next.params?.selector === 'string' ? next.params.selector : null;
        let recovery = null;
        if (typeFamily(next.type) === typeFamily(fail.type) && nextSel && normalizeSelector(nextSel) !== normalizeSelector(fail.params.selector)) {
          recovery = { kind: 'alt-selector', type: next.type, selector: nextSel };
        } else if (WAIT_TYPE.test(next.type)) {
          recovery = { kind: 'wait', type: next.type, ...(nextSel ? { selector: nextSel } : {}) };
        }
        if (recovery) {
          if (!entry.recovery || next.started_at >= entry.recovery.at) entry.recovery = { ...recovery, at: next.started_at };
          break;
        }
      }
    }
  }

  return [...entries.values()]
    .filter((e) => e.failCount >= 2)
    .sort((a, b) => b.failCount - a.failCount || (b.lastFailedAt > a.lastFailedAt ? 1 : -1))
    .slice(0, limit)
    .map(({ sessionIds, ...rest }) => ({ ...rest, sessionCount: sessionIds.size }));
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

export function createFrictionTracker() {
  const live = new Map(); // sessionId -> Map<frictionKey, liveEntry>
  const warned = new Map(); // sessionId -> Map<frictionKey, { atLive, count }>
  const announced = new Set(); // `${sessionId}|${kind}|${key}` for one-shot live emergent notes

  const sessionMap = (map, sessionId) => {
    let m = map.get(sessionId);
    if (!m) { m = new Map(); map.set(sessionId, m); }
    return m;
  };

  return {
    // Called from the one place every action is logged. Returns the updated live entry when the
    // action carried a selector (null otherwise) so callers can react to a failure immediately.
    note(sessionId, { type, params, ok, error, durationMs, at }) {
      const selector = params?.selector;
      if (!selector || typeof selector !== 'string') return null;
      const key = frictionKey(type, selector);
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
    warnState(sessionId, key) {
      return warned.get(sessionId)?.get(key) ?? null;
    },
    recordWarn(sessionId, key, atLive) {
      const map = sessionMap(warned, sessionId);
      const prev = map.get(key);
      map.set(key, { atLive, count: (prev?.count ?? 0) + 1 });
    },
    // true the first time (sessionId, kind, key) is seen - for once-per-session live notes.
    announceOnce(sessionId, kind, key) {
      const id = `${sessionId}|${kind}|${key}`;
      if (announced.has(id)) return false;
      announced.add(id);
      return true;
    },
    dropSession(sessionId) {
      live.delete(sessionId);
      warned.delete(sessionId);
      const prefix = `${sessionId}|`;
      for (const id of announced) if (id.startsWith(prefix)) announced.delete(id);
    },
  };
}

// ---------- the pre-action decision ----------

function describeRecovery(recovery) {
  if (!recovery) return null;
  if (recovery.kind === 'alt-selector') return `after a failure here, "${recovery.selector}" (${recovery.type}) worked`;
  return `after a failure here, ${recovery.type}${recovery.selector ? ` on "${recovery.selector}"` : ''} then worked`;
}

function topClass(classes) {
  let best = null;
  for (const [k, n] of Object.entries(classes ?? {})) if (!best || n > best[1]) best = [k, n];
  return best?.[0] ?? null;
}

// entry: the frozen session-start selectorFriction entry (or undefined). live: tracker entry
// (or null). state: tracker warnState (or null). Returns null (say nothing) or
// { level: 'warn' | 'repeat' | 'escalated', message, errorClass, liveFailures }.
export function assessSelectorRisk({ type, selector, entry, live, state, origin }) {
  const hist = historyForOrigin(entry, origin);
  const liveUnresolved = live?.unresolved ?? 0;
  const liveFails = live?.fails ?? 0;
  // It worked earlier in THIS session and has not failed since: whatever history says, it works now.
  if (live?.lastOkAt && liveUnresolved === 0) return null;

  const risky = hist.unresolved + liveUnresolved >= RISKY_SELECTOR_FAIL_THRESHOLD || liveUnresolved >= LIVE_FAIL_THRESHOLD;
  if (!risky) return null;
  // Already warned, and nothing new has happened since: stay quiet (a warning repeated on every
  // call trains the reader to ignore it). A further same-session failure counts as new.
  if (state && liveUnresolved <= state.atLive) return null;

  const level = liveUnresolved >= ESCALATE_AFTER_LIVE_FAILS ? 'escalated' : state ? 'repeat' : 'warn';
  const klass = live?.errorClass ?? topClass(entry?.errorClasses);
  const parts = [];
  if (hist.fails > 0) parts.push(`failed ${hist.fails}x before across ${entry.sessionCount} session(s), last at ${hist.lastFailedAt}`);
  if (liveFails > 0) parts.push(`failed ${liveFails}x already this session`);
  let message = `selector "${selector}" (${type}) has ${parts.join(' and ')}`;
  if (klass && klass !== 'other') message += ` [${klass}]`;
  const lastError = live?.lastError ?? entry?.lastError;
  if (lastError) message += ` - last error: ${JSON.stringify(lastError.slice(0, 120))}`;
  const recoveryText = describeRecovery(entry?.recovery);
  message += recoveryText ? ` - ${recoveryText}.` : ` - ${CLASS_ADVICE[klass] ?? 'consider dom.click-wait or a settle/wait first.'}`;
  const known = entry?.knownIssues?.[0];
  if (known) message += ` known issue: ${known.id}${known.remediation ? ` (${known.remediation})` : ''}`;
  if (level === 'escalated') message = `ESCALATED (${liveUnresolved} failures this session, warning already shown): ${message}`;
  return { level, message, errorClass: klass, liveFailures: liveFails, liveUnresolved };
}

// What a FAILED command's own error should carry (item: not only a header). Null when the
// action had no selector.
export function failureContext({ type, selector, entry, live, origin }) {
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
  };
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

// ---------- known-issue candidates ----------

// Failing the same way repeatedly with no known-issues.json match is exactly the entry an
// operator has not written yet. Groups failed actions by a placeholder-normalized message and
// proposes a draft entry (signature = the stable literal prefix, so it works as a plain
// substring match). Draft only - nothing is written to the registry automatically.
export function buildKnownIssueCandidates(actions, { matchKnownIssues = () => [], limit = 5 } = {}) {
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
      return {
        errorClass: classifyError(g.sample),
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
