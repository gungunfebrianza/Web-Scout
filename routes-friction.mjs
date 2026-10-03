// The friction family of HTTP routes (mark fixed / explain / targets / notices / regressions / prune / known-issues),
// split out of relay.mjs: it was a 4,800-line file and this is the first slice that can leave without taking the rest
// with it. Everything the handlers need from the relay arrives in `d` (the relay owns the database, the live tracker
// and the analytics caches); what is pure comes straight from friction.mjs. surfaces.test.mjs reads this file too.
import fs from 'node:fs';
import * as friction from './friction.mjs';
import * as notices from './notices.mjs';

export function frictionRoutes(d) {
  const { allActionsIncremental, allFrictionTargets, broadcastUpdate, COMMAND_TYPES, commitsBetween, compileSignature, computeAnalytics, dbApi, declareFrictionResolved, DEFAULT_AGENT, ensureFrictionSession, frictionFactsFor, frictionTargetFromBody, frictionTracker, getAnalytics, HOST, HttpError, KNOWN_ISSUES_PATH, loadKnownIssues, PORT, readJsonBody, readKnownIssuesRaw, readSharedKnownIssues, resolveFrictionCluster } = d;
  const resolutionMap = () => {
    const map = new Map();
    try { for (const x of dbApi.listFrictionResolutions()) map.set(x.key, x.resolved_at); } catch { /* best-effort */ }
    return map;
  };
  // The notice a "next" request means: by id, else the newest one of the wanted session that offers any step.
  function describeNext(noticeId, session) {
    const sessionId = session === 'all' ? null : session ? Number(session) : (dbApi.getCurrentSession()?.id ?? null);
    const list = dbApi.listNotices({ sessionId, limit: 1000 });
    const notice = noticeId ? list.find((x) => x.id === Number(noticeId)) : [...list].reverse().find((x) => x.next?.length);
    if (!notice) throw new HttpError(404, noticeId ? `no notice #${noticeId} in that scope (list them with "friction notices")` : 'no notice with next steps yet - nothing to do');
    const steps = (notice.next ?? []).map((c, i) => ({ n: i + 1, label: c.label, cli: c.cli, http: c.http, mutating: notices.parseHttpStep(c)?.mutating ?? null }));
    return { notice, steps };
  }
  return [
  // ---- "Mark fixed": declare a selector's friction resolved as of now. Analytics then counts
  // only failures AFTER that instant (the selector's old history stops ranking and stops
  // warning), and a relapse after the fix is visible as fresh failures. type+selector are
  // normalized exactly like the pre-action warn (friction.frictionKey), so "dom.clickWait" and
  // "#row-41" resolve the same entry the warn matched.
  {
    method: 'POST',
    pattern: /^\/friction\/resolve$/,
    handler: async (req) => {
      const body = await readJsonBody(req);
      if (body.type === 'cluster') return resolveFrictionCluster(body, true);
      const { type, target } = frictionTargetFromBody(body);
      const resolution = declareFrictionResolved(type, target.value, target.kind, body.note);
      d.dropAnalyticsCache();
      broadcastUpdate('analytics', null);
      return resolution;
    },
  },
  { method: 'GET', pattern: /^\/friction\/resolutions$/, handler: async () => dbApi.listFrictionResolutions() },
  {
    method: 'POST',
    pattern: /^\/friction\/unresolve$/,
    handler: async (req) => {
      const body = await readJsonBody(req);
      if (body.type === 'cluster') return resolveFrictionCluster(body, false);
      const { key } = frictionTargetFromBody(body);
      const result = dbApi.clearFrictionResolved(key);
      d.dropAnalyticsCache();
      broadcastUpdate('analytics', null);
      return result;
    },
  },

  // ---- "Why did / didn't it warn": everything friction awareness knows about one target, built by
  // the same frictionFactsFor() the pre-action header and the failure's error body use, plus the
  // decision's reason and the thresholds it was judged against. Side-effect free (it never
  // consumes the once-per-session warning). ?type=&selector= (or &store=), optional &session=&agent=.
  {
    method: 'GET',
    pattern: /^\/friction\/explain$/,
    handler: async (req) => {
      const q = new URL(req.url, `http://${HOST}`).searchParams;
      const { type, target } = frictionTargetFromBody({ type: q.get('type'), selector: q.get('selector') ?? undefined, store: q.get('store') ?? undefined }, { allowScopes: false });
      const params = target.kind === 'page' ? {} : target.kind === 'store' ? { store: target.value } : { selector: target.value };
      const sessionId = Number(q.get('session')) || dbApi.getCurrentSession()?.id || -1;
      const facts = frictionFactsFor(sessionId, type, params, q.get('agent') || DEFAULT_AGENT, target.kind === 'page' ? target.value : undefined);
      const e = facts.entry;
      return {
        type: friction.typeFamily(type),
        target: facts.target,
        key: facts.key,
        sessionId: sessionId === -1 ? null : sessionId,
        origin: facts.origin,
        wouldWarn: Boolean(facts.evaluation.assessment),
        decision: facts.evaluation.reason,
        ...(facts.evaluation.assessment ? { message: facts.evaluation.assessment.message, level: facts.evaluation.assessment.level } : {}),
        numbers: facts.evaluation.facts,
        history: e ? {
          failCount: e.failCount, sessionCount: e.sessionCount, retries: e.retries, wastedMs: e.wastedMs, score: e.score,
          lastFailedAt: e.lastFailedAt, lastSuccessAt: e.lastSuccessAt, errorClasses: e.errorClasses, lastError: e.lastError,
          perOrigin: e.origins, recoveries: e.recoveries, knownIssues: e.knownIssues,
        } : null,
        thisSession: facts.live ? { ...facts.live } : null,
        resolution: facts.resolution ? { resolvedAt: facts.resolution.resolved_at, note: facts.resolution.note } : null,
        failureContext: facts.context,
        trend: (() => { try { const t = friction.buildFrictionTrend(allActionsIncremental().actions, { key: facts.key, resolutions: resolutionMap() }); return t[0] ? { direction: t[0].direction, sparkline: t[0].sparkline, points: t[0].points } : null; } catch { return null; } })(),
        next: [
          ...(facts.resolution ? [] : [notices.fixedCommand(type, target.value)]),
          notices.trendCommand(type, target.value),
        ],
        cluster: (() => { try { return getAnalytics().frictionClusters.find((c) => c.targets.some((t) => t.key === facts.key)) ?? null; } catch { return null; } })(),
        config: friction.frictionConfig(),
      };
    },
  },
  // ---- Retention: sweep orphaned "already said" state and (with days) drop the stored result BODIES of
  // old actions. History, rankings and "mark fixed" declarations are kept. Dry run unless confirm:true.
  {
    method: 'POST',
    pattern: /^\/friction\/prune$/,
    handler: async (req) => {
      const body = await readJsonBody(req);
      const confirm = body.confirm === true;
      const orphanState = confirm ? dbApi.pruneOrphanFrictionState() : null;
      if (confirm) d.dropActionsMemo(); // rows and bodies are about to change under the memo
      let oldResults = null;
      let oldNotices = null;
      let oldReads = null;
      const given = (v) => v !== undefined && v !== null;
      try {
        if (given(body.days)) oldResults = dbApi.pruneOldResults({ days: body.days, dryRun: !confirm });
        if (given(body.noticeDays)) oldNotices = dbApi.pruneOldNotices({ days: body.noticeDays, dryRun: !confirm });
        if (given(body.readDays)) oldReads = dbApi.pruneOldReadRows({ days: body.readDays, types: Object.entries(COMMAND_TYPES).filter(([, meta]) => !meta.mutating).map(([t]) => t), dryRun: !confirm });
      } catch (err) { throw new HttpError(400, err.message); }
      return {
        dryRun: !confirm,
        ...(orphanState !== null ? { orphanStateRowsRemoved: orphanState } : {}),
        ...(oldResults ? { oldResults } : {}),
        ...(oldNotices ? { oldNotices } : {}),
        ...(oldReads ? { oldReads } : {}),
        ...(!oldResults && !oldNotices && !oldReads ? { note: 'pass days (>= 7: result bodies), noticeDays (>= 7: what agents were told) and/or readDays (>= 90: old successful reads that no friction target, snapshot or diff depends on)' } : {}),
        ...(confirm ? {} : { hint: 'dry run - repeat with confirm:true to apply' }),
      };
    },
  },
  // ---- The ranked target list with the same filter / sort / limit everywhere. ?q= filters (target, type,
  // origin, error class, last error), ?sort= is cost|fails|wasted|tokens|recent|oldest, ?limit= caps.
  {
    method: 'GET',
    pattern: /^\/friction\/targets$/,
    handler: async (req) => {
      const q = new URL(req.url, `http://${HOST}`).searchParams;
      const sort = q.get('sort') || 'cost';
      if (!friction.TARGET_SORTS[sort]) throw new HttpError(400, `sort must be one of ${Object.keys(friction.TARGET_SORTS).join('|')}`);
      const all = allFrictionTargets();
      const targets = friction.viewFrictionTargets(all, { q: q.get('q') ?? '', sort, limit: Number(q.get('limit')) || 0 });
      return { total: all.length, shown: targets.length, sort, q: q.get('q') ?? '', targets };
    },
  },

  // ---- Better or worse? One target (?type=&selector= | &store=): its failure rate per session, newest last, with the
  // direction and a sparkline. Without a target: what is getting worse and what is getting better, project-wide.
  // ?sessions=<n> is how many recent sessions to look at (default 8).
  {
    method: 'GET',
    pattern: /^\/friction\/trend$/,
    handler: async (req) => {
      const q = new URL(req.url, `http://${HOST}`).searchParams;
      const sessions = Math.min(50, Math.max(2, Number(q.get('sessions')) || friction.TREND_SESSIONS));
      const { actions } = allActionsIncremental();
      if (!q.get('type')) return { sessions, ...friction.summarizeTrends(friction.buildFrictionTrend(actions, { resolutions: resolutionMap(), sessions })) };
      const { type, key } = frictionTargetFromBody({ type: q.get('type'), selector: q.get('selector') ?? undefined, store: q.get('store') ?? undefined }, { allowScopes: false });
      const found = friction.buildFrictionTrend(actions, { key, resolutions: resolutionMap(), sessions })[0];
      if (!found) throw new HttpError(404, `no recorded calls for ${type} ${q.get('selector') ?? q.get('store')} - nothing to trend`);
      return found;
    },
  },

  // ---- What agents were told: the kept notices (notices.mjs), newest last. ?session=<id>|all (default: the
  // active session, else all), ?since=<last id seen> makes it a cursor, ?limit=.
  {
    method: 'GET',
    pattern: /^\/friction\/notices$/,
    handler: async (req) => {
      const q = new URL(req.url, `http://${HOST}`).searchParams;
      const wanted = q.get('session');
      const sessionId = wanted === 'all' ? null : wanted ? Number(wanted) : (dbApi.getCurrentSession()?.id ?? null);
      const list = dbApi.listNotices({ sessionId, sinceId: Number(q.get('since')) || 0, limit: Number(q.get('limit')) || 200 });
      return { sessionId, notices: list, next: list.length ? list[list.length - 1].id : (Number(q.get('since')) || 0) };
    },
  },

  // ---- Do what a notice suggested. GET lists the steps of one notice (?notice=<id>, default the newest that has any;
  // ?session=<id>|all like /friction/notices); POST {notice?, step? (1-based, default 1), confirm?} runs one. A GET step
  // runs at once; anything that writes is only described until confirm:true - the same dry-run rule as everywhere else.
  {
    method: 'GET',
    pattern: /^\/friction\/next$/,
    handler: async (req) => describeNext(new URL(req.url, `http://${HOST}`).searchParams.get('notice'), new URL(req.url, `http://${HOST}`).searchParams.get('session')),
  },
  {
    method: 'POST',
    pattern: /^\/friction\/next$/,
    handler: async (req) => {
      const body = await readJsonBody(req);
      const { notice, steps } = describeNext(body.notice ?? null, body.session ?? null);
      const n = Number.isInteger(Number(body.step)) && Number(body.step) > 0 ? Number(body.step) : 1;
      const step = steps[n - 1];
      if (!step) throw new HttpError(400, `step ${n} does not exist - that notice has ${steps.length} step(s): ${steps.map((s) => `${s.n} ${s.label}`).join(', ')}`);
      const parsed = notices.parseHttpStep(notice.next[n - 1]);
      if (!parsed) throw new HttpError(400, `step ${n} (${step.label}) has no runnable HTTP form - run it yourself: ${step.cli}`);
      if (parsed.mutating && body.confirm !== true) return { ran: false, notice: { id: notice.id, kind: notice.kind, message: notice.message }, step, wouldRun: { method: parsed.method, path: parsed.path, body: parsed.body }, note: 'dry run - this step writes; repeat with confirm:true (CLI: --confirm) to run it' };
      const res = await fetch(`http://${HOST}:${PORT}${parsed.path}`, { method: parsed.method, ...(parsed.method === 'GET' ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parsed.body) }) });
      const json = await res.json();
      return { ran: true, notice: { id: notice.id, kind: notice.kind, message: notice.message }, step, ok: json.ok === true, ...(json.ok ? { result: json.result } : { error: json.error }) };
    },
  },

  // ---- Declared fixed, failing again.
  { method: 'GET', pattern: /^\/friction\/regressions$/, handler: async () => { const list = friction.buildRelapses(dbApi.listFrictionResolutions(), allActionsIncremental().actions).map((x) => ({ ...x, changedBetween: commitsBetween(x.resolvedAt, x.firstFailedAt) })); return { count: list.length, relapses: list }; } },

  { method: 'GET', pattern: /^\/friction\/config$/, handler: async () => friction.frictionConfig() },

  // ---- What THIS session has run into so far, from the same live tracker the pre-action warning reads
  // (so a human watching sees what the agent was told). Targets that never failed are left out.
  {
    method: 'GET',
    pattern: /^\/friction\/session$/,
    handler: async () => {
      const session = dbApi.getCurrentSession();
      if (!session) return { session: null, targets: [] };
      ensureFrictionSession(session.id);
      const targets = frictionTracker.keys(session.id)
        .map((key) => ({ key, e: frictionTracker.get(session.id, key), warned: frictionTracker.warnState(session.id, key) }))
        .filter(({ e }) => e && e.fails > 0)
        .map(({ key, e, warned }) => ({
          key, ...(e.target ?? {}), fails: e.fails, unresolved: e.unresolved, errorClass: e.errorClass, lastError: e.lastError,
          lastFailedAt: e.lastFailedAt, lastOkAt: e.lastOkAt, wastedMs: e.wastedMs, warned: warned ? { atLive: warned.atLive, count: warned.count } : null,
        }))
        .sort((a, b) => b.unresolved - a.unresolved || b.fails - a.fails);
      return { session: { id: session.id, goal: session.goal }, targets };
    },
  },

  // ---- The registry as written, for sharing between checkouts. Import merges by id: an id already present is
  // reported and left alone, an invalid entry (no id/signature, a signature that does not compile) is refused
  // with the reason; nothing is written unless confirm:true.
  { method: 'GET', pattern: /^\/known-issues$/, handler: async () => ({ file: KNOWN_ISSUES_PATH, entries: readKnownIssuesRaw(), shared: readSharedKnownIssues() }) },
  {
    method: 'POST',
    pattern: /^\/known-issues\/import$/,
    handler: async (req) => {
      const body = await readJsonBody(req);
      if (!Array.isArray(body.entries)) throw new HttpError(400, 'entries (an array of { id, signature, description, remediation }) is required - e.g. the output of "known-issues export"');
      const current = readKnownIssuesRaw();
      const have = new Set(current.map((e) => e?.id));
      const add = [];
      const skipped = [];
      for (const entry of body.entries) {
        if (!entry || typeof entry.id !== 'string' || !entry.id || typeof entry.signature !== 'string' || !entry.signature) { skipped.push({ id: entry?.id ?? null, reason: 'needs a string id and a non-empty string signature' }); continue; }
        if (have.has(entry.id)) { skipped.push({ id: entry.id, reason: 'an entry with this id already exists (left unchanged)' }); continue; }
        try { compileSignature(entry.signature); } catch (err) { skipped.push({ id: entry.id, reason: `signature does not compile: ${err.message}` }); continue; }
        if (entry.remediation === undefined || entry.remediation === null || entry.remediation === '') { skipped.push({ id: entry.id, reason: 'remediation is required - an entry without a fix is not worth sharing' }); continue; }
        have.add(entry.id);
        add.push({ id: entry.id, signature: entry.signature, description: entry.description ?? null, remediation: entry.remediation });
      }
      if (body.confirm !== true) return { written: false, wouldAdd: add, skipped, file: KNOWN_ISSUES_PATH, note: 'dry run - repeat with confirm:true (CLI: --confirm) to append them' };
      if (add.length) {
        fs.writeFileSync(KNOWN_ISSUES_PATH, `${JSON.stringify([...current, ...add], null, 2)}\n`);
        d.dropAnalyticsCache();
        broadcastUpdate('analytics', null);
      }
      return { written: add.length > 0, added: add, skipped, file: KNOWN_ISSUES_PATH };
    },
  },

  // ---- Promote a known-issue candidate (analytics.knownIssueCandidates) into known-issues.json.
  // Without confirm:true this only returns the entry it WOULD write (a review step); with it, the
  // entry is appended - never overwriting an existing id, and never with a "TODO" remediation, so a
  // draft cannot be promoted without a human supplying the one thing a draft cannot know.
  {
    method: 'POST',
    pattern: /^\/known-issues\/promote$/,
    handler: async (req) => {
      const body = await readJsonBody(req);
      if (typeof body.id !== 'string' || !body.id) throw new HttpError(400, 'id is required: a candidate id from analytics.knownIssueCandidates[].draft.id');
      const candidate = computeAnalytics().knownIssueCandidates.find((c) => c.draft.id === body.id);
      if (!candidate) throw new HttpError(404, `no known-issue candidate "${body.id}" (candidates are listed by "analytics")`);
      const text = (v, fallback) => (typeof v === 'string' && v.trim() ? v.trim() : fallback);
      const entry = {
        id: text(body.newId, candidate.draft.id),
        signature: text(body.signature, candidate.draft.signature),
        description: text(body.description, candidate.draft.description),
        remediation: text(body.remediation, ''),
      };
      if (!entry.remediation) {
        const suggested = candidate.suggestedRemediation;
        if (suggested && body.confirm !== true) {
          return { written: false, needsRemediation: true, wouldWrite: { ...entry, remediation: suggested }, suggestedFrom: candidate.suggestedFrom, file: KNOWN_ISSUES_PATH, note: 'dry run - the remediation is a SUGGESTION drawn from this project\'s own history; confirm it by repeating with --remediation "<text>" --confirm' };
        }
        throw new HttpError(400, `remediation is required - a candidate does not know the fix. Review it, then promote with e.g. --remediation "..." (draft: ${JSON.stringify(entry)}${suggested ? `, suggested: ${JSON.stringify(suggested)}` : ''})`);
      }
      if (/^TODO/i.test(entry.description)) throw new HttpError(400, `description still starts with TODO - say what the root cause is (--description "...")`);
      let existing = [];
      try { existing = loadKnownIssues()?.issues ?? []; } catch (err) { throw new HttpError(409, `known-issues.json is unreadable, refusing to touch it: ${err.message}`); }
      if (existing.some((i) => i.id === entry.id)) throw new HttpError(409, `known-issues.json already has an entry with id "${entry.id}"`);
      if (body.confirm !== true) return { written: false, wouldWrite: entry, file: KNOWN_ISSUES_PATH, note: 'dry run - repeat with confirm:true (CLI: --confirm) to append it' };
      let current = [];
      try { current = JSON.parse(fs.readFileSync(KNOWN_ISSUES_PATH, 'utf8')); } catch (err) { if (err.code !== 'ENOENT') throw new HttpError(409, `known-issues.json could not be read: ${err.message}`); }
      fs.writeFileSync(KNOWN_ISSUES_PATH, `${JSON.stringify([...current, entry], null, 2)}\n`);
      d.dropAnalyticsCache();
      broadcastUpdate('analytics', null);
      return { written: true, entry, file: KNOWN_ISSUES_PATH };
    },
  },
  ];
}
