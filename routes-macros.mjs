// The macro (record/replay) family of HTTP routes, split out of relay.mjs. Everything the handlers need arrives in `d`.
// surfaces.test.mjs reads this file too.
import * as friction from './friction.mjs';

export function macroRoutes(d) {
  const { allActionsIncremental, broadcastUpdate, bumpMutationCounter, buildMacroRiskPreview, buildMacroSelectorSuggestions, COMMAND_TIMEOUT_MS, dbApi, DEFAULT_AGENT, DEFAULT_MACRO_TYPES, dispatchCommand, frictionFactsFor, frictionTracker, getAnalytics, goalWordSet, HOST, HttpError, jaccardSimilarity, LONG_POLL_TYPES, lookupReadCache, MACRO_CONTEXT_SIMILARITY_THRESHOLD, matchKnownIssueForError, MUTATING_TYPES, noteCacheHit, noteScopedRead, readCacheKey, readJsonBody, requireActiveSession, SNAPSHOT_TIMEOUT_MS, storeReadCache, withLoggedAction } = d;
  return [
  // ---------- Macros (record/replay) ----------
  //
  // A macro is a named, saved subset of one session's own already-logged
  // actions - see js session flow: propose->attach-evidence->review->
  // promote in a real P3.8 verification pass was exactly this shape,
  // re-typed by hand every round. Record once, replay with one call.
  {
    method: 'POST',
    pattern: /^\/macros$/,
    handler: async (req) => {
      const body = await readJsonBody(req);
      if (!body.name || typeof body.name !== 'string' || !body.name.trim()) throw new HttpError(400, 'name is required');
      if (!body.sessionId) throw new HttpError(400, 'sessionId is required');
      const actions = dbApi.listActions(Number(body.sessionId), { ascending: true });
      const allow = body.all ? null : DEFAULT_MACRO_TYPES;
      const steps = actions.filter((a) => a.ok && (!allow || allow.has(a.type))).map((a) => ({ type: a.type, params: a.params ?? {} }));
      if (!steps.length) throw new HttpError(400, 'no replayable actions found in that session - nothing matched the macro type allowlist (pass {"all":true} to include read-only actions too)');
      const macro = dbApi.createMacro({ name: body.name.trim(), sourceSessionId: Number(body.sessionId), steps });
      // The mid-session macro-match nudge reads macroCandidates() on demand, and this broadcast drops
      // its cache - a macro recorded during a still-active session is offered to that same session.
      broadcastUpdate('macro', null);
      const selectorSuggestions = buildMacroSelectorSuggestions(Number(body.sessionId), steps, actions);
      return selectorSuggestions.length ? { ...macro, selectorSuggestions } : macro;
    },
  },
  {
    // ?risk=1 adds, per macro, how many of its steps would draw a friction warning right now (the same facts the
    // pre-action header uses) and the worst one - capped to 50 macros so the dashboard can ask on every refresh.
    // ?health=1 adds how its replays have gone: runs, pass rate, and what the last run did (the first step that failed).
    method: 'GET',
    pattern: /^\/macros$/,
    handler: async (req) => {
      const macros = dbApi.listMacros();
      const q = new URL(req.url, `http://${HOST}`).searchParams;
      const wantRisk = q.get('risk') === '1';
      const runs = q.get('health') === '1' ? friction.buildMacroRuns(allActionsIncremental().actions) : null;
      if (!wantRisk && !runs) return macros;
      const sessionId = dbApi.getCurrentSession()?.id ?? -1;
      return macros.map((m, i) => {
        if (runs) m = { ...m, health: friction.summarizeMacroRuns(runs.get(m.id)) };
        if (!wantRisk || i >= 50 || !Array.isArray(m.steps)) return m;
        let preview = [];
        try { preview = buildMacroRiskPreview(sessionId, m.steps, 0, DEFAULT_AGENT); } catch { /* best-effort */ }
        return { ...m, risk: { riskySteps: preview.length, worst: preview[0] ? { stepIndex: preview[0].stepIndex, selector: preview[0].selector, failCount: preview[0].failCount } : null } };
      });
    },
  },
  { method: 'GET', pattern: /^\/macros\/(\d+)$/, handler: async (_req, m) => dbApi.getMacro(Number(m[1])) },
  {
    // Full step-array replace - backs the dashboard's macro step inspector
    // (reorder/remove a step before replaying). Body: {"steps": [...]}. No
    // partial/index-based PATCH - the whole array is small (this tool's own
    // macros, not arbitrary data) and a full replace can't drift out of sync
    // with a stale index.
    method: 'PUT',
    pattern: /^\/macros\/(\d+)\/steps$/,
    handler: async (req, m) => {
      const body = await readJsonBody(req);
      if (!Array.isArray(body.steps)) throw new HttpError(400, 'steps (array) is required');
      for (const s of body.steps) {
        if (!s || typeof s.type !== 'string') throw new HttpError(400, 'every step needs a string "type"');
      }
      const macro = dbApi.updateMacroSteps(Number(m[1]), body.steps);
      broadcastUpdate('macro', null);
      return macro;
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/macros\/(\d+)$/,
    handler: async (_req, m) => {
      const result = dbApi.deleteMacro(Number(m[1]));
      broadcastUpdate('macro', null);
      return result;
    },
  },
  {
    // Replays a macro's steps against the CURRENTLY active session (same
    // "context before action" discipline as everything else - a macro
    // does not implicitly create or reuse its source session). Stops at
    // the first failing step unless {"continueOnError": true}. Optional
    // {"fromStep": n} (0-based) skips earlier steps - lets an operator
    // resume a macro after fixing whatever made step n fail, instead of
    // replaying already-succeeded steps again. Does NOT get strict-CRV
    // auto-snapshotting even in a strict-crv session - each step is
    // dispatched directly, not routed back through /command's strict-CRV
    // branch - documented as a known limitation in README.
    //
    // Cross-context replay guard: a macro carrying real mutations (idb.put/
    // delete/clear/eval) can be run against ANY currently active session,
    // not only the one it was recorded from - by design (see above), but
    // that design has no safety net of its own. A macro recorded in one
    // session's throwaway/test context, replayed later against an
    // unrelated real session, mutates that session's data with no warning.
    // Refuses (409) when the target session's goal has low word-overlap
    // with the macro's own source session's goal, unless {"confirm": true}
    // is passed - cheap and approximate on purpose (see
    // MACRO_CONTEXT_SIMILARITY_THRESHOLD above), not a semantic check.
    method: 'POST',
    pattern: /^\/macros\/(\d+)\/run$/,
    handler: async (req, m) => {
      const macro = dbApi.getMacro(Number(m[1]));
      const body = await readJsonBody(req);
      const agentName = body.agent || DEFAULT_AGENT;
      const continueOnError = !!body.continueOnError;
      const confirmCrossContext = !!body.confirm;
      const fromStep = Number.isInteger(body.fromStep) && body.fromStep > 0 ? body.fromStep : 0;
      const session = requireActiveSession();

      if (macro.source_session_id && !confirmCrossContext) {
        let sourceSession = null;
        try { sourceSession = dbApi.getSession(macro.source_session_id); } catch { /* source session no longer resolvable - nothing to compare against */ }
        if (sourceSession) {
          const similarity = jaccardSimilarity(goalWordSet(sourceSession.goal), goalWordSet(session.goal));
          if (similarity < MACRO_CONTEXT_SIMILARITY_THRESHOLD) {
            throw new HttpError(409, `cross-context replay guard: macro "${macro.name}" was recorded in session #${sourceSession.id} ("${sourceSession.goal}") but the currently active session #${session.id} ("${session.goal}") looks unrelated (word-overlap ${(similarity * 100).toFixed(0)}% < ${(MACRO_CONTEXT_SIMILARITY_THRESHOLD * 100).toFixed(0)}%). Pass {"confirm": true} to run it anyway.`);
          }
        }
      }

      // No-op skip: a replayed idb.put whose row is already byte-identical
      // to what's already stored is pure waste - it mutates nothing, but
      // still pays a full dispatch round trip AND a logged action (echoing
      // the row back) every single replay. Only safe when the row carries
      // an explicit "id" field the pre-check can idb.get by - a store
      // relying on IndexedDB autoIncrement to assign a fresh key on insert
      // has no stable id to check against, so those rows always dispatch
      // normally (this is a heuristic, not a general keyPath resolver - see
      // README). The idb.get pre-check itself is NOT logged as an action
      // (dispatchCommand called directly, bypassing withLoggedAction) -
      // logging a small read to skip a large write would eat into the very
      // savings this exists to produce.
      async function isNoOpPut(step) {
        if (step.type !== 'idb.put') return false;
        const row = step.params?.row;
        if (!row || typeof row !== 'object' || row.id === undefined) return false;
        try {
          const existing = await dispatchCommand('idb.get', { store: step.params.store, key: row.id }, COMMAND_TIMEOUT_MS, agentName);
          return existing.found && JSON.stringify(existing.row) === JSON.stringify(row);
        } catch {
          return false;
        }
      }

      // The friction analytics engine already knows (macrosNeverSucceeding) when a macro
      // has been run before and never once succeeded end-to-end - that signal previously
      // only surfaced in the dashboard/analytics command, never at the one place it could
      // actually save an attempt: right before running it again. Cached getAnalytics() is
      // fine here (unlike session start, staleness of a few seconds doesn't matter for a
      // warning) and only checked on a fresh run (fromStep 0), not a resume.
      const priorNeverSucceeding = fromStep === 0
        ? getAnalytics().macrosNeverSucceeding.find((mns) => mns.id === macro.id)
        : undefined;


      // One id per replay: back-to-back runs of the same macro are otherwise one burst in the log (friction.buildMacroRuns).
      const macroRun = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const results = [];
      const frictionWarnings = [];
      // The whole macro's risk shape up front, worst first - before any step runs.
      const riskPreview = buildMacroRiskPreview(session.id, macro.steps.slice(fromStep), fromStep, agentName);
      for (const step of macro.steps.slice(fromStep)) {
        if (await isNoOpPut(step)) {
          results.push({ type: step.type, ok: true, skipped: true, reason: 'idb.put: identical row already present' });
          continue;
        }
        // Same-session read-result cache (see READ_CACHEABLE_TYPES/
        // readResultCache above) previously only applied inside POST
        // /command - a macro replaying a read step (idb.dump, dom.query...)
        // dispatched to the page every single time, even immediately after
        // an earlier step (in this SAME replay, or an earlier /command call
        // this session) already asked the identical question with nothing
        // mutating in between. Wired through here too now, so a macro's
        // read steps get the exact same cache-hit short-circuit.
        const cacheKey = readCacheKey(agentName, step.type, step.params);
        if (cacheKey) {
          const cached = await lookupReadCache(session.id, cacheKey, agentName);
          if (cached) {
            noteCacheHit(session.id, JSON.stringify(cached.result).length);
            results.push({ type: step.type, ok: true, skipped: true, reason: 'read result served from same-session cache', result: cached.result, durationMs: 0 });
            continue;
          }
        }
        const stepTimeoutMs = LONG_POLL_TYPES.has(step.type) ? (Number(step.params?.timeoutMs) || 15000) + 5000
          : step.type === 'idb.snapshot' ? SNAPSHOT_TIMEOUT_MS : COMMAND_TIMEOUT_MS;
        const stepStartedAt = Date.now();
        // A macro step is dispatched internally, so it used to bypass the pre-action warn that the
        // same click gets through POST /command. Same facts, same dedupe, collected per replay.
        try {
          const stepFacts = frictionFactsFor(session.id, step.type, step.params ?? {}, agentName);
          const assessment = stepFacts?.evaluation.assessment;
          if (assessment) {
            frictionTracker.recordWarn(session.id, stepFacts.key, assessment.liveUnresolved);
            frictionWarnings.push({ step: fromStep + results.length + 1, type: step.type, message: assessment.message });
          }
        } catch { /* best-effort - friction bookkeeping never blocks a replay */ }
        try {
          const { result } = await withLoggedAction(session.id, step.type, { ...step.params, via: 'macro', macroId: macro.id, macroName: macro.name, macroRun }, () => dispatchCommand(step.type, step.params ?? {}, stepTimeoutMs, agentName), agentName);
          // A macro's mutating steps (idb.put/delete/eval/...) previously
          // never bumped sessionMutationCounters - invisible to /command's
          // own cache too, so a stale read cached before this macro ran
          // could still be served afterward even though the macro just
          // changed the exact state that read reflects. Bumping it here
          // closes that correctness gap, not just enables the cache-hit
          // path above.
          if (MUTATING_TYPES.has(step.type)) bumpMutationCounter(session.id);
          noteScopedRead(session.id, result, { agentName, type: step.type, params: step.params });
          if (cacheKey) storeReadCache(session.id, cacheKey, result);
          results.push({ type: step.type, ok: true, result, durationMs: Date.now() - stepStartedAt });
        } catch (err) {
          let stepContext = null;
          try { stepContext = frictionFactsFor(session.id, step.type, step.params ?? {}, agentName)?.context ?? null; } catch { /* best-effort */ }
          const { match: knownIssue } = matchKnownIssueForError(err.message);
          results.push({ type: step.type, ok: false, error: err.message, durationMs: Date.now() - stepStartedAt, ...(stepContext ? { selectorFriction: stepContext } : {}), ...(knownIssue ? { knownIssue } : {}) });
          if (!continueOnError) break;
        }
      }
      broadcastUpdate('action', session.id);
      broadcastUpdate('macro', null); // this run changed the macro's own record: the nudge must not keep quoting the old one
      const skippedCount = results.filter((r) => r.skipped).length;
      // Compact by default: a step's full result (can be as large as any
      // other command's - idb.dump/dom.query-shaped) was previously always
      // echoed back in FULL for every step, on every replay, forever - the
      // caller almost never needs it (it already has each step's result
      // from when the macro was first recorded). Default response keeps
      // only {type,ok,skipped,reason,durationMs} per step; a FAILED step
      // always keeps its error/result in full (that's the one case a
      // caller genuinely needs detail to debug), and {"full": true} opts
      // back into every step's full result.
      const includeFull = !!body.full;
      const compactResults = results.map((r) => (includeFull || !r.ok
        ? r
        // riskWarning is a short string, not a result body - the whole point of compacting is
        // to not echo back a potentially-large result the caller already has; a warning that a
        // step is about to repeat a known-bad selector is exactly the kind of thing compacting
        // must not silently drop.
        : { type: r.type, ok: r.ok, skipped: r.skipped, reason: r.reason, durationMs: r.durationMs, ...(r.riskWarning ? { riskWarning: r.riskWarning } : {}) }));
      return {
        macro: { id: macro.id, name: macro.name },
        fromStep,
        ranSteps: results.length,
        totalSteps: macro.steps.length,
        skippedCount,
        results: compactResults,
        ...(frictionWarnings.length ? { frictionWarnings } : {}),
        ...(riskPreview.length ? { riskPreview } : {}),
        ...(priorNeverSucceeding
          ? { warning: `macro "${macro.name}" (#${macro.id}) has run ${priorNeverSucceeding.attemptedSteps} step(s) before this and never once succeeded - check "macro inspect ${macro.id}" or the dashboard's macro health strip before relying on it again.` }
          : {}),
      };
    },
  },
  ];
}
