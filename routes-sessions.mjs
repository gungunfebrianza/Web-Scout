// The /sessions/* family of HTTP routes (create/end/list/get, trace, actions, token-report, snapshots, diffs, viz,
// intents/import, replay, qa, console, net, verity-runs, report, cleanup, assert), split out of relay.mjs.
// Everything the handlers need arrives in `d`. surfaces.test.mjs reads this file too.
import * as notices from './notices.mjs';

export function sessionsRoutes(d) {
  const { knownIssuesDue, LONG_POLL_TYPES, DEFAULT_MACRO_TYPES, MUTATING_TYPES, COMMAND_TYPES, dropAnalyticsCache, setMacroCandidateCache, BUDGET_STRICT_PCT, BUDGET_TIGHTEN_PCT, COMMAND_TIMEOUT_MS, DEFAULT_AGENT, HOST, HttpError, LEAN_GUARD_TOKENS, SNAPSHOT_TIMEOUT_MS, __dirname, agents, broadcastUpdate, buildBriefing, buildMacroCandidates, buildMacroRiskPreview, buildReportJson, buildReportMarkdown, buildSessionViz, bumpMutationCounter, computeAnalytics, computeDiff, dbApi, declareFrictionResolved, decorateEntriesWithKnownIssue, discoverTranscripts, dispatchCommand, dispatchTracked, dropSessionMemory, emergentFrictionForSession, exportTrace, friction, gatherReportBundle, http, importIntents, log, maybeAutoCalibrate, openDashboardInBrowser, path, pending, readJsonBody, readTranscriptFile, requireActiveSession, resolveSuggestionsForSession, sessionRunningTokens, sessionSavingsTally, summarizeByStore, withCamelAliases, withLoggedAction, writeTrace } = d;
  return [
  {
    method: 'POST',
    pattern: /^\/sessions$/,
    handler: async (req) => {
      const body = withCamelAliases(await readJsonBody(req));
      const startingAgentName = body.agent || DEFAULT_AGENT;
      if (body.ifStaleMin !== undefined && body.ifStaleMin !== null && !(Number.isFinite(body.ifStaleMin) && body.ifStaleMin >= 0)) {
        throw new HttpError(400, 'ifStaleMin must be a number of minutes >= 0');
      }
      const session = dbApi.startSession({
        goal: body.goal,
        context: body.context,
        strictCrv: !!body.strictCrv,
        strictCrvStores: Array.isArray(body.strictCrvStores) ? body.strictCrvStores : undefined,
        tags: Array.isArray(body.tags) ? body.tags : undefined,
        tokenBudget: Number.isFinite(body.tokenBudget) ? Number(body.tokenBudget) : undefined,
        lean: !!body.lean,
        strictCrvCompact: !!body.crvCompact,
        // Best-effort - null when no agent is connected yet under this name
        // (a caller who hasn't opened the tab, or will connect a different
        // one). See dispatchTracked's guardDispatchOrigin for the check this
        // enables, and "session start --allow-remote" for the opt-out below.
        pinnedOrigin: agents.get(startingAgentName)?.origin ?? null,
        agentName: startingAgentName,
        allowRemote: !!body.allowRemote,
        autoRecover: !!body.autoRecover,
        ifStaleMin: body.ifStaleMin ?? undefined,
      });
      if (session.autoEndedSession) {
        // The db layer already ended the row; this drops the same per-session memory the explicit
        // "session end" route does, and says plainly in the relay log why a session vanished.
        dropSessionMemory(session.autoEndedSession.id);
        sessionSavingsTally.delete(session.autoEndedSession.id); // the explicit route reads this for its receipt first; nobody will here
        log(`session #${session.autoEndedSession.id} ("${session.autoEndedSession.goal}", agent '${session.autoEndedSession.agent ?? '?'}') ${session.autoEndedSession.reason}; started session #${session.id}`);
      }
      broadcastUpdate('session', null);
      try { dbApi.pruneOrphanFrictionState(); } catch { /* best-effort bookkeeping */ }
      openDashboardInBrowser();
      maybeAutoCalibrate();
      const briefing = body.briefing === false ? undefined : await buildBriefing(body.agent || DEFAULT_AGENT);
      // Surfaced at session start (not just buried in "analytics", which nothing prompts
      // anyone to run) so an ignored macro nudge from a past session is visible again right
      // when a new one could actually act on it. See computeAnalytics()'s own macroAdoption
      // comment for why this is derived, not a separately-tracked "was it acted on" flag.
      // Deliberately computeAnalytics() (uncached), not getAnalytics(): calling the cached
      // getter here would poison ANALYTICS_CACHE_MS with a snapshot taken before this brand
      // new session has any actions of its own - confirmed real, a fast scripted
      // start->act->end->GET /analytics sequence got back that pre-session stale result.
      const sessionStartAnalytics = computeAnalytics();
      const macroAdoptionNote = sessionStartAnalytics.macroAdoption?.note;
      // Same treatment as macroAdoptionNote above, generalized: the single top-ranked
      // entry from topFrictionItems (worst failing type/selector, a macro that never
      // once succeeds, a verity label stuck FAIL, the worst-waste session) surfaces here
      // too, instead of staying dashboard-only behind a manual "analytics" call. Skipped
      // when it IS the macroAdoption item, to avoid printing the same note twice.
      const topFriction = sessionStartAnalytics.topFrictionItems[0];
      const frictionNote = topFriction && topFriction.kind !== 'macroAdoption' ? topFriction.summary : undefined;
      // The top item says what hurts the project most; this says what is likely to hurt THIS session -
      // still-failing targets on its origin or mentioned by its goal, with what worked last time.
      const frictionBriefing = friction.buildSessionBriefing(sessionStartAnalytics.selectorFriction, { goal: body.goal, origin: session.pinned_origin ?? agents.get(startingAgentName)?.origin ?? null });
      setMacroCandidateCache({ at: Date.now(), list: buildMacroCandidates(sessionStartAnalytics) }); // seed from the scan just paid for
      const budget = session.token_budget
        ? { tokens: session.token_budget, tightenAtTokens: Math.round(session.token_budget * BUDGET_TIGHTEN_PCT / 100), strictAtTokens: Math.round(session.token_budget * BUDGET_STRICT_PCT / 100), note: 'past the first mark, reads over ~3000 tokens return their shape (--no-guard forces the body) and rows come back as {columns, rows}; past the second the guard drops to ~1000 tokens' }
        : undefined;
      const leanNote = session.lean
        ? { note: `lean session: reads come back as tables, a repeat of a result you already hold as a one-line pointer (or only what changed), and a body over ~${LEAN_GUARD_TOKENS} tokens as its shape (repeat the call to get it, from cache). --no-guard on a call gives the body as it is. Only rely on "unchanged"/deltas while the earlier result is still in your context.` }
        : undefined;
      const reviewDue = knownIssuesDue();
      const reviewNotice = reviewDue.length ? notices.makeNotice({ kind: 'review-due', level: 'warn', message: `${reviewDue.length} known issue(s) are past their review date: ${reviewDue.slice(0, 5).join(', ')}`, next: [notices.reviewCommand()] }) : null;
      return { ...session, ...(reviewNotice ? { reviewNotice } : {}), ...(briefing ? { briefing } : {}), ...(budget ? { budget } : {}), ...(leanNote ? { leanProfile: leanNote } : {}), ...(macroAdoptionNote ? { macroAdoptionNote } : {}), ...(frictionNote ? { frictionNote } : {}), ...(frictionBriefing.length ? { frictionBriefing } : {}) };
    },
  },
  {
    method: 'POST',
    pattern: /^\/sessions\/(\d+)\/end$/,
    handler: async (req, m) => {
      const sessionId = Number(m[1]);
      const endBody = await readJsonBody(req);
      // Surfaced so the CLI can nudge "consider macro record" for a session
      // that did real, replayable work and never got saved as one -
      // confirmed real: a seed/verify/cleanup shape hand-rolled once in a
      // session is exactly the shape the NEXT phase needs again, and
      // `macro record` (which already exists) has no prompt pointing at it.
      const replayableActionCount = dbApi.listActions(sessionId).filter((a) => a.ok && DEFAULT_MACRO_TYPES.has(a.type)).length;
      // Computed before endSession/dropSessionMemory - listActions works on an ended
      // session too, but this reads naturally as "one last look at what this session did".
      const emergentFriction = emergentFrictionForSession(sessionId);
      const resolveSuggestions = resolveSuggestionsForSession(sessionId);
      // applySuggestions: the caller already decided "yes, those are fixed" - declare each one resolved
      // through the same call `friction resolve` makes, and report them as applied instead of suggested.
      const appliedResolutions = [];
      if (endBody.applySuggestions === true) {
        for (const s of resolveSuggestions.splice(0)) {
          try { appliedResolutions.push(declareFrictionResolved(s.type, s.selector, s.targetKind, `auto: session #${sessionId} end --apply-suggestions (${s.failures} failures, then ${s.okStreak} successes)`)); } catch { resolveSuggestions.push(s); }
        }
        if (appliedResolutions.length) { dropAnalyticsCache(); broadcastUpdate('analytics', null); }
      }
      const session = dbApi.endSession(sessionId);
      const deliveredEstTokens = sessionRunningTokens(sessionId); // what the caller actually received, after shaping
      // Nothing under an ended session can change again - an unbounded relay
      // process would otherwise keep every past session's read-result cache
      // and mutation counter alive in memory forever for no benefit.
      dropSessionMemory(sessionId);
      try { dbApi.snapshotSavings('storage', dbApi.getTokenSavingsReport().byKind.storage.bytesSaved); } catch { /* the receipt never depends on it */ }
      const savingsReceipt = { ...(sessionSavingsTally.get(sessionId) ?? { scopedCalls: 0, avoidedBytes: 0, cacheHits: 0, cacheBytes: 0, shapedCalls: 0, shapedBytes: 0 }), deliveredEstTokens };
      sessionSavingsTally.delete(sessionId);
      broadcastUpdate('session', null);
      // The end of a session is when the person has the most to act on: what to save, what to mark fixed, what to read.
      const next = [
        ...(replayableActionCount >= 5 ? [notices.macroRecordCommand(sessionId)] : []),
        ...resolveSuggestions.slice(0, 3).map((x) => notices.fixedCommand(x.type, x.selector)),
        notices.reportCommand(sessionId),
        notices.checkCommand(),
      ];
      return { ...session, replayableActionCount, savingsReceipt, ...(emergentFriction.length ? { emergentFriction } : {}), ...(resolveSuggestions.length ? { resolveSuggestions } : {}), ...(appliedResolutions.length ? { appliedResolutions } : {}), next };
    },
  },
  { method: 'GET', pattern: /^\/sessions$/, handler: async () => dbApi.listSessions() },
  { method: 'GET', pattern: /^\/sessions\/(\d+)$/, handler: async (_req, m) => dbApi.getSession(Number(m[1])) },
  {
    // Grows the trace.mjs corpus without a separate offline step: "session end --trace" (or an
    // MCP end with trace:true) calls this right after ending, so the lean/read-strategy numbers
    // in trace-replay.test.mjs stop resting on four traces from one project. Anonymised the same
    // way trace.mjs's own "export" CLI command is (only structure, sizes and equality survive -
    // see trace.mjs), and written OUTSIDE the committed traces/ directory so nothing here is
    // accidentally promoted into the benchmark's own held numbers without a human choosing it.
    method: 'POST',
    pattern: /^\/sessions\/(\d+)\/trace$/,
    handler: async (_req, m) => {
      const sessionId = Number(m[1]);
      dbApi.getSession(sessionId); // throws 'no such session' -> 404 below if invalid
      const dbPath = process.env.WEBSCOUT_DB_PATH || path.join(__dirname, 'webscout.db');
      const trace = await exportTrace({ dbPath, sessionId });
      const dir = process.env.WEBSCOUT_TRACE_DIR || path.join(__dirname, 'traces', 'auto');
      const file = path.join(dir, `${sessionId}-${Date.now()}.json.gz`);
      writeTrace(file, trace);
      const reads = trace.events.filter((e) => e.result).length;
      return { file, events: trace.events.length, reads };
    },
  },
  {
    // Default response is redacted (see listActionsSummary in db.mjs - the
    // 3 known-heavy result shapes get their bulk stripped) since the
    // dashboard re-fetches this whole list on every refresh cycle and only
    // needs full detail for a row someone actually expands (fetched
    // separately below). Pass ?full=1 to get the untouched rows (the CLI's
    // `session show` needs this - a terminal dump has no lazy-expand step)
    // and/or ?limit=N to cap row count server-side rather than trusting the
    // client to discard the rest after paying to receive it.
    method: 'GET',
    pattern: /^\/sessions\/(\d+)\/actions$/,
    handler: async (req, m) => {
      const { searchParams } = new URL(req.url, `http://${HOST}`);
      const full = searchParams.get('full') === '1';
      const limitParam = searchParams.get('limit');
      const limit = limitParam ? Number(limitParam) : undefined;
      return full ? dbApi.listActions(Number(m[1])) : dbApi.listActionsSummary(Number(m[1]), { limit });
    },
  },
  {
    // Full, unredacted single action - what a dashboard row-expand fetches
    // lazily for one of the 3 redacted types instead of paying for every
    // row's full payload on every list refresh.
    method: 'GET',
    pattern: /^\/sessions\/(\d+)\/actions\/(\d+)$/,
    handler: async (_req, m) => {
      const action = dbApi.getActionById(Number(m[2]));
      if (action.session_id !== Number(m[1])) throw new HttpError(404, `action ${m[2]} does not belong to session ${m[1]}`);
      return action;
    },
  },
  {
    // Pure SQL aggregate (see db.mjs's getActionCostReport) - byType/
    // estTokens ranking of which command types are actually costing a
    // coding agent's own context window, plus flagged repeat-call loops
    // (e.g. a poll-while-booting eval sequence). Neither query touches
    // result_json content, so running this report never itself pays
    // anything close to the bytes it measures. byType/byTarget/byMacro rank
    // WHAT was called; byIntent ranks WHY (see db.mjs's getActionCostByIntent).
    method: 'GET',
    pattern: /^\/sessions\/(\d+)\/token-report$/,
    handler: async (_req, m) => ({
      ...dbApi.getActionCostReport(Number(m[1])),
      loops: dbApi.findRepeatedActionLoops(Number(m[1])),
      // Same-result repeats spaced further apart than the loop window above
      // catches - see db.mjs's findRedundantCalls for what counts.
      redundantCalls: dbApi.findRedundantCalls(Number(m[1])),
      // byType (above) can't say WHICH store/selector inside "idb.dump"/
      // "dom.query" is the actual hotspot - byTarget can.
      byTarget: dbApi.getActionCostByTarget(Number(m[1])),
      // Neither byType nor byTarget says which CRV phase/macro the cost
      // belongs to - byMacro answers "which replayed macro was actually
      // expensive" (ad-hoc, non-macro calls bucket under macroId: null).
      byMacro: dbApi.getActionCostByMacro(Number(m[1])),
      // None of the above says WHY - byIntent groups by the agent's own narrated reason
      // (imported from its transcript, see "session intents"), so a caller can see which
      // GOAL was expensive, not just which command type. Empty until intents are imported.
      byIntent: dbApi.getActionCostByIntent(Number(m[1])),
    }),
  },

  { method: 'GET', pattern: /^\/sessions\/(\d+)\/snapshots$/, handler: async (_req, m) => dbApi.listSnapshots(Number(m[1])) },
  { method: 'GET', pattern: /^\/sessions\/(\d+)\/diffs$/, handler: async (_req, m) => dbApi.listDiffs(Number(m[1])) },
  {
    // The dashboard's swimlane / episode tree / state machine, derived in one pass from rows that
    // are already stored (see session-viz.mjs). Reads no result bodies, so a long session costs
    // roughly what the Action log's own refresh does. ?limit=N keeps the newest N actions.
    method: 'GET',
    pattern: /^\/sessions\/(\d+)\/viz$/,
    handler: async (req, m) => {
      const id = Number(m[1]);
      const session = dbApi.getSession(id);
      const { searchParams } = new URL(req.url, `http://${HOST}`);
      const limit = Math.min(Math.max(Number(searchParams.get('limit')) || 1500, 50), 20000);
      return buildSessionViz({ session, actions: dbApi.listActionsForViz(id, { limit }), snapshots: dbApi.listSnapshots(id), diffs: dbApi.listDiffs(id), clicks: dbApi.listClickNavigations(id), limit });
    },
  },
  {
    // Fills each action's "why" from the agent's own transcript (Claude Code or Codex JSONL),
    // matched by time - see intent-import.mjs. No body = look for transcripts written since the
    // session started. Costs the agent nothing: it never types a reason, the host already logged it.
    method: 'POST',
    pattern: /^\/sessions\/(\d+)\/intents\/import$/,
    handler: async (req, m) => {
      const id = Number(m[1]);
      const session = dbApi.getSession(id);
      const body = await readJsonBody(req);
      const sources = [];
      if (typeof body.transcriptText === 'string') {
        sources.push({ label: '(inline)', text: body.transcriptText });
      } else if (typeof body.transcriptPath === 'string' && body.transcriptPath) {
        try { sources.push({ label: body.transcriptPath, text: readTranscriptFile(body.transcriptPath) }); } catch (err) { throw new HttpError(400, err.message); }
      } else {
        const sinceMs = (Date.parse(session.started_at) || 0) - 60_000;
        for (const f of discoverTranscripts({ sinceMs, limit: 6 })) {
          try { sources.push({ label: f.path, text: readTranscriptFile(f.path) }); } catch { /* unreadable or over the size cap - the next candidate may do */ }
        }
        if (!sources.length) throw new HttpError(404, 'no Claude Code or Codex transcript was written since this session started (looked in ~/.claude/projects and ~/.codex/sessions) - pass --transcript <file.jsonl>');
      }
      const format = body.format === 'claude' || body.format === 'codex' ? body.format : 'auto';
      const actions = dbApi.listActionsForViz(id, { limit: 20000 });
      const { items, transcripts, unmatchedActions } = importIntents({ actions, sources, format });
      const written = dbApi.setActionIntents(id, items);
      broadcastUpdate('action', id);
      return { sessionId: id, written, matchedActions: items.length, unmatchedActions, transcripts };
    },
  },
  {
    // Re-runs a recorded session against the CURRENTLY active one, up to and including its first failure, to see
    // whether the failure still reproduces ("it failed three sessions ago - does it still?"). The plan is the
    // session's successful macro-replayable actions (the ones that change state) in order, then the failing action.
    // These steps write to the page, so it is a dry run unless confirm:true - the plan, the expected failure and
    // the friction risk of each step come back without touching anything. {"all": true} replays the whole session.
    method: 'POST',
    pattern: /^\/sessions\/(\d+)\/replay$/,
    handler: async (req, m) => {
      const sourceId = Number(m[1]);
      const body = await readJsonBody(req);
      const agentName = body.agent || DEFAULT_AGENT;
      const source = dbApi.getSession(sourceId);
      const untilFailure = body.all !== true;
      const rows = dbApi.listActions(sourceId, { ascending: true });
      const clean = (params) => {
        const { via, macroId, macroName, macroRun, replayOf, auto, phase, for: _for, triggered_by_action_id: _t, ...rest } = params ?? {};
        return rest;
      };
      const replayable = (a) => a.type !== 'idb.snapshot' && a.params?.via !== 'auto-remediate' && a.params?.via !== 'replay' && !a.params?.auto;
      const failing = untilFailure ? rows.find((a) => !a.ok && replayable(a)) : null;
      if (untilFailure && !failing) throw new HttpError(404, `session #${sourceId} has no failed action to reproduce (pass {"all": true} to replay all of it anyway)`);
      const plan = [];
      for (const a of rows) {
        if (failing && a.id > failing.id) break;
        const isFailure = failing && a.id === failing.id;
        if (!replayable(a)) continue;
        if (!isFailure && !(a.ok && DEFAULT_MACRO_TYPES.has(a.type))) continue;
        plan.push({ index: plan.length, actionId: a.id, type: a.type, params: clean(a.params), isTheFailure: Boolean(isFailure) });
      }
      const original = failing ? { actionId: failing.id, type: failing.type, error: failing.error, errorClass: friction.classifyError(failing.error) } : null;
      const currentId = dbApi.getCurrentSession()?.id ?? -1;
      const riskPreview = buildMacroRiskPreview(currentId, plan.map((p) => ({ type: p.type, params: p.params })), 0, agentName);
      if (body.confirm !== true) {
        return { dryRun: true, sourceSession: { id: source.id, goal: source.goal }, steps: plan.length, plan, expected: original, ...(riskPreview.length ? { riskPreview } : {}), note: 'dry run - these steps write to the page. Repeat with confirm:true (CLI: --confirm) to run them in the active session, stopping at the first failure.' };
      }
      const session = requireActiveSession();
      const ran = [];
      const compared = []; // original vs replay per step, for friction.buildReplayDiff
      const originalOf = new Map(rows.map((a) => [a.id, a]));
      let now = null;
      for (const step of plan) {
        const timeoutMs = LONG_POLL_TYPES.has(step.type) ? (Number(step.params?.timeoutMs) || 15000) + 5000 : COMMAND_TIMEOUT_MS;
        const was = originalOf.get(step.actionId);
        const original = { ok: Boolean(was?.ok), error: was?.error, durationMs: was?.duration_ms, result: was?.result ?? undefined };
        const startedAt = Date.now();
        try {
          const out = await dispatchTracked(session, step.type, { ...step.params, via: 'replay', replayOf: sourceId }, agentName, timeoutMs);
          if (MUTATING_TYPES.has(step.type)) bumpMutationCounter(session.id);
          ran.push({ index: step.index, type: step.type, ok: true });
          compared.push({ index: step.index, type: step.type, original, replay: { ok: true, durationMs: Date.now() - startedAt, result: out?.result ?? undefined } });
        } catch (err) {
          ran.push({ index: step.index, type: step.type, ok: false, error: err.message });
          compared.push({ index: step.index, type: step.type, original, replay: { ok: false, error: err.message, durationMs: Date.now() - startedAt } });
          now = { index: step.index, type: step.type, error: err.message, errorClass: friction.classifyError(err.message) };
          break;
        }
      }
      broadcastUpdate('action', session.id);
      const reproduced = Boolean(original && now && now.index === plan.length - 1 && now.type === original.type && now.errorClass === original.errorClass);
      return {
        dryRun: false, sourceSession: { id: source.id, goal: source.goal }, steps: plan.length, ran: ran.length,
        reproduced, original, now,
        verdict: !original ? (now ? `the replay failed at step ${now.index + 1}: ${now.error}` : 'the whole session replayed without a failure')
          : reproduced ? `still reproduces: ${now.type} fails the same way (${now.errorClass})`
          : now ? `failed differently at step ${now.index + 1} (${now.type}: ${now.error}) - not the original failure`
          : 'does NOT reproduce: every step, including the one that failed before, succeeded',
        results: ran,
        diff: friction.buildReplayDiff(compared),
      };
    },
  },
  { method: 'GET', pattern: /^\/sessions\/(\d+)\/qa$/, handler: async (_req, m) => dbApi.listQA(Number(m[1])) },
  {
    method: 'GET',
    pattern: /^\/sessions\/(\d+)\/console$/,
    handler: async (req, m) => {
      const { searchParams } = new URL(req.url, `http://${HOST}`);
      const limitParam = searchParams.get('limit');
      const entries = dbApi.listConsoleEntries(Number(m[1]), { limit: limitParam ? Number(limitParam) : undefined });
      return decorateEntriesWithKnownIssue(entries, (e) => e.message);
    },
  },
  {
    method: 'GET',
    pattern: /^\/sessions\/(\d+)\/net$/,
    handler: async (req, m) => {
      const { searchParams } = new URL(req.url, `http://${HOST}`);
      const limitParam = searchParams.get('limit');
      const entries = dbApi.listNetEntries(Number(m[1]), { limit: limitParam ? Number(limitParam) : undefined });
      return decorateEntriesWithKnownIssue(entries, (e) => e.error || (e.status ? `HTTP ${e.status}` : ''));
    },
  },
  { method: 'GET', pattern: /^\/sessions\/(\d+)\/verity-runs$/, handler: async (_req, m) => dbApi.listVerityRuns(Number(m[1])) },
  { method: 'GET', pattern: /^\/verity-runs\/(\d+)$/, handler: async (_req, m) => dbApi.getVerityRun(Number(m[1])) },
  {
    // Explicitly does NOT call requireActiveSession() - reviewing a
    // session (often already ended) is the entire point of this route.
    method: 'GET',
    pattern: /^\/sessions\/(\d+)\/report$/,
    handler: async (req, m) => {
      const bundle = await gatherReportBundle(Number(m[1]));
      const { searchParams } = new URL(req.url, `http://${HOST}`);
      const format = searchParams.get('format') === 'json' ? 'json' : 'md';
      return { format, content: format === 'json' ? buildReportJson(bundle) : buildReportMarkdown(bundle) };
    },
  },

  {
    // Session-scoped write ledger. Two independent modes, since neither one
    // alone is complete:
    //
    // Default (action-log mode): walks the session's own logged actions
    // (idb.put/idb.delete/idb.deleteMany/idb.clear) and computes exactly
    // which rows are still live and were written by this session, so an
    // operator doesn't have to hand-track keys to clean up test data -
    // confirmed tedious in a real session (12 rows deleted one CLI call
    // each). Blind to any write NOT made through those 4 command types -
    // in particular every real UI-driven write (a button click that runs
    // `someCrud.add(...)` inside the page's own code) and every `eval`
    // write are invisible to it. `eval` writes are at least flagged by
    // count (opaque expr, no structured store/key to recover); UI-driven
    // writes get no signal at all in this mode - confirmed to require a
    // full manual store dump + hand-picked ids in a real CRV session,
    // twice, because promote/observe/create-trial buttons all write this
    // way.
    //
    // {"sinceSnapshotId": N} (snapshot-diff mode): takes a fresh snapshot
    // scoped to the SAME stores as persisted snapshot N, diffs it against
    // that snapshot, and treats every row that is new since N - in ANY
    // store, however it got written (button click, eval, idb.put, doesn't
    // matter) - as a pending delete. This is what actually catches UI-
    // driven writes, which is most real writes in a CRV pass. Rows that
    // were merely CHANGED (not added) since N are reported separately and
    // never auto-deleted - a changed row is an edit to pre-existing data,
    // not something cleanup should blindly discard.
    method: 'POST',
    pattern: /^\/sessions\/(\d+)\/cleanup$/,
    handler: async (req, m) => {
      const sessionId = Number(m[1]);
      const body = await readJsonBody(req);
      const agentName = body.agent || DEFAULT_AGENT;
      const summaryOnly = !!body.summary;

      if (body.sinceSnapshotId) {
        const baseline = dbApi.getSnapshot(Number(body.sinceSnapshotId));
        const stores = Object.keys(baseline.stores || {});
        const { result: freshResult, actionId: snapshotActionId } = await withLoggedAction(sessionId, 'idb.snapshot', { stores, via: 'cleanup', sinceSnapshotId: baseline.id }, () => dispatchCommand('idb.snapshot', { stores }, SNAPSHOT_TIMEOUT_MS, agentName), agentName);
        const freshSnap = dbApi.saveSnapshot({ sessionId, actionId: snapshotActionId, stores: freshResult.stores, agentName });
        const diff = computeDiff(baseline.stores, freshResult.stores);
        const pending = [];
        const changedNotDeleted = [];
        for (const [store, d] of Object.entries(diff)) {
          for (const row of d.added) {
            const key = Array.isArray(d.keyPath) ? d.keyPath.map((k) => row?.[k]) : row?.[d.keyPath];
            const keyIsUsable = Array.isArray(key) ? key.every((v) => v !== undefined) : key !== undefined;
            pending.push({ store, key: keyIsUsable ? key : undefined, row, keyPath: d.keyPath });
          }
          for (const c of d.changed) changedNotDeleted.push({ store, key: c.key, before: c.before, after: c.after });
        }
        broadcastUpdate('action', sessionId);
        broadcastUpdate('snapshot', sessionId);
        if (!body.confirm) {
          return {
            dryRun: true, mode: 'sinceSnapshotId', baselineSnapshotId: baseline.id, freshSnapshotId: freshSnap.id,
            pendingDeletes: summaryOnly ? summarizeByStore(pending) : pending,
            changedNotDeleted: summaryOnly ? summarizeByStore(changedNotDeleted) : changedNotDeleted,
            note: `Compared against snapshot #${baseline.id} across store(s) ${stores.join(', ')}. Pass {"confirm":true,"sinceSnapshotId":${baseline.id}} to delete the ${pending.length} added row(s) listed above. ${changedNotDeleted.length} row(s) were changed (not added) since the baseline and are listed but NOT deleted - review by hand if they need reverting.${summaryOnly ? ' (--summary: per-store counts only, not full rows - re-run without it for detail.)' : ''}`,
          };
        }
        const deleted = [];
        const failed = [];
        for (const w of pending) {
          if (w.key === undefined) { failed.push({ ...w, error: `store '${w.store}' keyPath '${w.keyPath}' not present on the added row - cannot derive a delete key` }); continue; }
          try {
            await withLoggedAction(sessionId, 'idb.delete', { store: w.store, key: w.key, via: 'cleanup', sinceSnapshotId: baseline.id }, () => dispatchCommand('idb.delete', { store: w.store, key: w.key }, COMMAND_TIMEOUT_MS, agentName), agentName);
            deleted.push(w);
          } catch (err) {
            failed.push({ ...w, error: err.message });
          }
        }
        broadcastUpdate('action', sessionId);
        return {
          dryRun: false, mode: 'sinceSnapshotId', baselineSnapshotId: baseline.id, freshSnapshotId: freshSnap.id,
          deleted: summaryOnly ? summarizeByStore(deleted) : deleted,
          failed: summaryOnly ? summarizeByStore(failed) : failed,
          changedNotDeleted: summaryOnly ? summarizeByStore(changedNotDeleted) : changedNotDeleted,
        };
      }

      const actions = dbApi.listActions(sessionId, { ascending: true });
      const state = new Map(); // `${store}::${JSON.stringify(key)}` -> { store, key, live }
      let evalWriteCount = 0;
      for (const a of actions) {
        if (!a.ok) continue;
        if (a.type === 'eval' && /\.(add|put|update|set|create)\s*\(/.test(String(a.params?.expr ?? ''))) evalWriteCount += 1;
        // Which branch a type takes is its `cleanup` kind in command-registry.mjs,
        // not a hardcoded type string - a new write command declares itself there.
        const kind = COMMAND_TYPES[a.type]?.cleanup;
        if (kind === 'put' && a.params?.store !== undefined && a.result?.key !== undefined) {
          state.set(`${a.params.store}::${JSON.stringify(a.result.key)}`, { store: a.params.store, key: a.result.key, live: true });
        } else if (kind === 'putMany' && a.params?.store !== undefined && a.result?.keyPath !== undefined) {
          const kp = a.result.keyPath;
          for (const row of a.result.rows ?? []) {
            const key = typeof kp === 'string' ? row?.[kp] : kp.map((k) => row?.[k]);
            if (key === undefined || (Array.isArray(key) && key.some((v) => v === undefined))) continue;
            state.set(`${a.params.store}::${JSON.stringify(key)}`, { store: a.params.store, key, live: true });
          }
        } else if (kind === 'delete' && a.params?.store !== undefined && a.params?.key !== undefined) {
          state.set(`${a.params.store}::${JSON.stringify(a.params.key)}`, { store: a.params.store, key: a.params.key, live: false });
        } else if (kind === 'deleteMany' && a.params?.store !== undefined) {
          for (const key of a.params.keys ?? []) state.set(`${a.params.store}::${JSON.stringify(key)}`, { store: a.params.store, key, live: false });
        } else if (kind === 'clear' && a.params?.store !== undefined) {
          for (const [k, v] of state) if (v.store === a.params.store) v.live = false;
        }
      }
      const pending = [...state.values()].filter((v) => v.live);
      if (!body.confirm) {
        return {
          dryRun: true, mode: 'actionLog',
          pendingDeletes: summaryOnly ? summarizeByStore(pending) : pending,
          evalWriteActionsNotTracked: evalWriteCount,
          note: (evalWriteCount
            ? `${evalWriteCount} eval action(s) in this session look like writes and are NOT tracked here - review manually. `
            : '') + `This mode only tracks ${Object.entries(COMMAND_TYPES).filter(([, m]) => m.cleanup).map(([t]) => t).join('/')} - it does NOT see writes made by clicking a real UI button. Pass {"sinceSnapshotId": <id>} instead to catch those too. Pass {"confirm":true} to delete the ${pending.length} row(s) listed above.${summaryOnly ? ' (--summary: per-store counts only, not full rows.)' : ''}`,
        };
      }
      const deleted = [];
      const failed = [];
      for (const w of pending) {
        try {
          await withLoggedAction(sessionId, 'idb.delete', { store: w.store, key: w.key, via: 'cleanup' }, () => dispatchCommand('idb.delete', { store: w.store, key: w.key }, COMMAND_TIMEOUT_MS, agentName), agentName);
          deleted.push(w);
        } catch (err) {
          failed.push({ ...w, error: err.message });
        }
      }
      broadcastUpdate('action', sessionId);
      return {
        dryRun: false, mode: 'actionLog',
        deleted: summaryOnly ? summarizeByStore(deleted) : deleted,
        failed: summaryOnly ? summarizeByStore(failed) : failed,
        evalWriteActionsNotTracked: evalWriteCount,
      };
    },
  },

  {
    // Declarative regression assertions against LIVE state - dispatches
    // idb.dump for every distinct store named in `checks` (cached within
    // one call) instead of a human eyeballing an idb.dump/snapshot diff by
    // hand every time a check needs re-running. Each check:
    //   { store, where?, count?, countGte?, countLte?, field?, equals? }
    // `where` (exact-equality field map) filters which rows count; omitted
    // means every row in the store. count/countGte/countLte check the
    // matched-row count; field+equals checks a field on the FIRST matched
    // row (requires `where` to be meaningful). All present conditions on a
    // check must pass for that check to pass. Logged as its own
    // 'session.assert' action, so a report shows exactly what was proven
    // and when - not just today's failure/success eyeballing this replaces.
    method: 'POST',
    pattern: /^\/sessions\/(\d+)\/assert$/,
    handler: async (req, m) => {
      const sessionId = Number(m[1]);
      const body = await readJsonBody(req);
      const agentName = body.agent || DEFAULT_AGENT;
      const checks = Array.isArray(body.checks) ? body.checks : [];
      if (!checks.length) throw new HttpError(400, 'checks (non-empty array) is required');
      const session = requireActiveSession();
      if (session.id !== sessionId) throw new HttpError(409, `session ${sessionId} is not the currently active session (active: ${session.id})`);

      const storeCache = new Map();
      async function getStore(store) {
        if (!store) throw new Error('check is missing "store"');
        if (storeCache.has(store)) return storeCache.get(store);
        const dump = await dispatchCommand('idb.dump', { store }, COMMAND_TIMEOUT_MS, agentName);
        storeCache.set(store, dump);
        return dump;
      }
      function rowsMatching(rows, where) {
        if (!where) return rows;
        return rows.filter((r) => Object.entries(where).every(([k, v]) => JSON.stringify(r?.[k]) === JSON.stringify(v)));
      }

      const { result: results, actionId } = await withLoggedAction(sessionId, 'session.assert', { checks }, async () => {
        const out = [];
        for (const check of checks) {
          const details = [];
          let pass = true;
          try {
            const dump = await getStore(check.store);
            const matched = rowsMatching(dump.rows, check.where);
            if (check.count !== undefined) {
              const ok = matched.length === check.count;
              pass = pass && ok;
              details.push(`count ${matched.length} ${ok ? '==' : '!='} ${check.count}`);
            }
            if (check.countGte !== undefined) {
              const ok = matched.length >= check.countGte;
              pass = pass && ok;
              details.push(`count ${matched.length} ${ok ? '>=' : '<'} ${check.countGte}`);
            }
            if (check.countLte !== undefined) {
              const ok = matched.length <= check.countLte;
              pass = pass && ok;
              details.push(`count ${matched.length} ${ok ? '<=' : '>'} ${check.countLte}`);
            }
            if (check.field !== undefined) {
              if (!matched.length) {
                pass = false;
                details.push(`field check on '${check.field}' requested but no row matched "where"`);
              } else {
                const actual = matched[0][check.field];
                const ok = JSON.stringify(actual) === JSON.stringify(check.equals);
                pass = pass && ok;
                details.push(`field '${check.field}' = ${JSON.stringify(actual)} ${ok ? '==' : '!='} ${JSON.stringify(check.equals)}`);
              }
            }
            if (!details.length) { pass = false; details.push('check specified none of count/countGte/countLte/field - nothing to assert'); }
          } catch (err) {
            pass = false;
            details.push(`error: ${err.message}`);
          }
          out.push({ ...check, pass, detail: details.join('; ') });
        }
        return out;
      }, agentName);
      const passed = results.every((r) => r.pass);
      broadcastUpdate('action', sessionId);
      return { passed, actionId, results };
    },
  },
  ];
}
