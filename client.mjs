// Also home to a handful of small pieces of REAL logic (net-history client-
// side filtering, page-freshness hashing, the Verity-scenario-stub builder,
// the suite step-runner) that both cli.mjs and mcp-server.mjs need
// byte-identical - none of these are relay routes, they're client-side
// composition on top of the routes above, so they live here once instead
// of being copy-pasted (and inevitably drifting) into two CLIs.
//
// Shared HTTP client for talking to the already-running relay
// (tools/web-scout/relay.mjs, must already be running -
// `node tools/web-scout/relay.mjs`). Extracted from cli.mjs so a second
// caller - tools/web-scout/mcp-server.mjs - doesn't reimplement (and
// potentially drift on) how a relay error response becomes a thrown Error.
// Both files import `request` from here; each still defines its own thin
// `send(type, params)` wrapper around it, since they differ on how the
// optional `agent` (multi-tab target) field is supplied - cli.mjs threads a
// single process-lifetime `--agent` flag through a module-level variable,
// while mcp-server.mjs takes it per tool-call (a stdio server process can
// outlive many independent calls, so no such global is safe there).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { startRelay, restartRelay, recordRelayEvent } from './relay-control.mjs';

// "crv seed"/"crv cleanup" convenience (both cli.mjs and mcp-server.mjs use
// these): a manifest of {store, ids} entries tracking synthetic rows written
// across separate calls - a real CRV pass is many separate invocations, not
// one long-lived process, so ids can't just live in a variable. Default path
// is a dotfile next to the CWD, same "no npm dependency, no extra service"
// choice as the rest of this tool - an explicit path overrides it when more
// than one CRV pass needs to run concurrently without colliding.
export function manifestPath(explicit) {
  return explicit || path.join(process.cwd(), '.webscout-crv-manifest.json');
}
export function readManifest(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { entries: [] }; }
}
export function writeManifest(file, manifest) {
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2));
}

export const HOST = process.env.WEBSCOUT_HOST || '127.0.0.1';
export const PORT = Number(process.env.WEBSCOUT_PORT || 8973);
export const BASE = `http://${HOST}:${PORT}`;

// Same rough chars/4 estimate as everywhere else in this tool - only worth
// printing once a session's real cumulative spend is large enough to think
// about; on every trivial "idb list"/"ping" call this would be pure noise.
// Overridable via WEBSCOUT_TOKEN_THRESHOLD - a hardcoded 5000 meant a token-
// sensitive CRV (want to know the moment it's getting expensive) couldn't
// lower it, and a deliberately heavy session (bulk-seeding fixtures) couldn't
// raise it to cut the noise. Invalid/non-positive values fall back to 5000.
const envThreshold = Number(process.env.WEBSCOUT_TOKEN_THRESHOLD);
const SESSION_TOKENS_SOFAR_PRINT_THRESHOLD = Number.isFinite(envThreshold) && envThreshold > 0 ? envThreshold : 5000;

// Side-channel notes (nudges, running token total, stale-relay warning) never
// change a command's own result shape - they travel as response HEADERS (see
// relay.mjs) and are surfaced HERE. Default sink is stderr, which a CLI
// caller sees. An MCP host does not put a server's stderr in front of the
// model (it goes to host logs), so mcp-server.mjs wraps each tool call in
// collectNotes() and appends the notes to that call's reply content instead.
// `key` lets a repeated note (the running token total, once per request)
// replace its earlier value rather than pile up.
const noteStore = new AsyncLocalStorage();

export async function collectNotes(fn) {
  const notes = new Map();
  try {
    const value = await noteStore.run(notes, fn);
    return { value, notes: [...notes.values()] };
  } catch (err) {
    err.notes = [...notes.values()];
    throw err;
  }
}

function emitNote(text, key = text) {
  const sink = noteStore.getStore();
  if (sink) sink.set(key, text);
  else console.error(`[web-scout] ${text}`);
}

const staleRelayWarned = new Set();
const staleAgentWarned = new Set();

// A relay that died (another session's blanket `relay.mjs` kill did this
// twice) used to be noticed only when a call failed, then restarted by hand.
// On ECONNREFUSED against a loopback relay the client now starts one and
// retries once. Not more than once per 30s per process, so a relay that
// crashes on boot cannot turn every call into a spawn; WEBSCOUT_NO_AUTOSTART=1
// opts out. Sessions live in the DB, and open tabs reconnect by themselves.
const AUTOSTART_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const AUTOSTART_COOLDOWN_MS = 30000;
let lastAutostartAt = 0;

const isConnectionRefused = (err) => (err?.cause?.code ?? err?.code) === 'ECONNREFUSED';

async function autostartRelay() {
  if (process.env.WEBSCOUT_NO_AUTOSTART === '1' || !AUTOSTART_HOSTS.has(HOST)) return null;
  if (Date.now() - lastAutostartAt < AUTOSTART_COOLDOWN_MS) return null;
  lastAutostartAt = Date.now();
  try {
    const started = await startRelay({ port: PORT, host: HOST, env: { WEBSCOUT_AUTO_CALIBRATE: '1' } });
    if (started.started) {
      recordRelayEvent(PORT, { kind: 'autostart', pid: started.pid ?? null });
      return started;
    }
  } catch { /* fall through to the ordinary unreachable error */ }
  return null;
}

// A relay runs the code it booted with: an edit to relay.mjs, db.mjs or the reply pipeline is
// invisible until it restarts, and V32's behaviour was not live for exactly that reason. A session
// boundary is the one moment nothing is in flight (no active session, no cached reads or shaping
// state worth keeping, open tabs reconnect by themselves), so `session start` restarts a stale relay
// there instead of only warning about it. Mid-session it never restarts - it would drop the read
// cache and what each caller holds - and a warning is all it gets. WEBSCOUT_NO_AUTORESTART=1 opts out.
const RECONNECT_WAIT_MS = 8000;

// What /health says about the relay's code. A relay too old to have a `relay` block predates stale
// reporting altogether, so it cannot say it is stale - and is by definition running old code.
export function staleFilesFromHealth(health) {
  if (!health) return [];
  if (!health.relay) return ['(this relay predates stale-code reporting)'];
  return Array.isArray(health.relay.stale_source_files) ? health.relay.stale_source_files : [];
}

export async function ensureFreshRelayForNewSession() {
  if (process.env.WEBSCOUT_NO_AUTORESTART === '1' || !AUTOSTART_HOSTS.has(HOST)) return { checked: false };
  let health;
  try { health = await request('GET', '/health'); } catch { return { checked: false }; }
  const stale = staleFilesFromHealth(health);
  if (!stale.length) return { checked: true, restarted: false };
  if (health.active_session) return { checked: true, restarted: false, stale, reason: 'a session is active - restarting now would drop its read cache' };
  const tabs = health.agents_connected ?? [];
  // Real incident this round: an unrelated read (no session active yet)
  // auto-restarted the relay while a SECOND agent's tab was connected,
  // dropping its WebSocket mid-CRV-run with no warning. The existing
  // active_session guard above doesn't cover this - restarting is only
  // harmless when at most the caller's own single tab would be affected.
  if (tabs.length > 1) return { checked: true, restarted: false, stale, reason: `other tab(s) are connected (${tabs.join(', ')}) - restarting now would drop their connection too; pass WEBSCOUT_NO_AUTORESTART=1 or run "relay restart" once nothing else is using it` };
  const result = await restartRelay({ port: PORT, host: HOST, env: { WEBSCOUT_AUTO_CALIBRATE: '1' } });
  if (!result.restarted) {
    emitNote(`WARNING: the relay is running code older than what is on disk (${stale.join(', ')}) and restarting it failed (${result.start?.reason ?? result.stop?.reason ?? 'unknown'}). Run: node tools/web-scout/cli.mjs relay restart`, 'relay-autorestart');
    return { checked: true, restarted: false, stale };
  }
  recordRelayEvent(PORT, { kind: 'auto-restart', files: stale, pid: result.start?.pid ?? null });
  // the tabs that were connected reconnect on their own; give them a moment so the briefing finds them
  const deadline = Date.now() + RECONNECT_WAIT_MS;
  while (tabs.length && Date.now() < deadline) {
    try {
      const now = await request('GET', '/agents', undefined, { autostart: false });
      const names = Array.isArray(now) ? now.map((a) => a.name ?? a) : Object.keys(now ?? {});
      if (tabs.every((t) => names.includes(t))) break;
    } catch { /* the relay is still coming up */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  emitNote(`the relay was running code older than what is on disk (${stale.join(', ')}) - restarted it before this session (pid ${result.start?.pid}). Set WEBSCOUT_NO_AUTORESTART=1 to disable this.`, 'relay-autorestart');
  return { checked: true, restarted: true, stale, pid: result.start?.pid };
}

export async function request(method, pathName, body, { autostart = true } = {}) {
  const opts = { method };
  if (body !== undefined) {
    opts.headers = { 'Content-Type': 'application/json' };
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(`${BASE}${pathName}`, opts);
  } catch (err) {
    const started = isConnectionRefused(err) && autostart ? await autostartRelay() : null;
    if (!started) throw new Error(`cannot reach the web-scout relay at ${BASE} - is it running? Start it with "node tools/web-scout/cli.mjs relay start". (${err.message})`);
    emitNote(`the relay was not running - started a fresh one (pid ${started.pid}, log ${started.log}). Open tabs reconnect within a few seconds; the active session is kept in the database. Set WEBSCOUT_NO_AUTOSTART=1 to disable this.`, 'relay-autostart');
    try {
      res = await fetch(`${BASE}${pathName}`, opts);
    } catch (retryErr) {
      throw new Error(`started a relay at ${BASE} but it still cannot be reached (${retryErr.message}) - see ${started.log}`);
    }
  }
  // Mid-session macro nudge (see relay.mjs's /command handler): carried as a
  // response HEADER, not folded into the JSON body, because /command's body
  // is the dispatched command's own real result (dom.click's {clicked,
  // mutated, ...}, idb.put's {stored, key, row}, ...) - every existing
  // caller (dashboard, mcp-server.mjs, macro replay) reads that shape
  // directly, so injecting an extra field into it would silently change
  // what `result.<field>` means for everyone. console.error (stderr) is
  // safe from BOTH callers of this shared client: cli.mjs already nudges
  // this way at session end, and mcp-server.mjs's stdio JSON-RPC channel is
  // stdout-only, so a stderr line here can never corrupt a JSON-RPC reply.
  const nudge = res.headers.get('x-webscout-nudge');
  if (nudge) emitNote(nudge);
  // Pre-action risky-selector warn and proactive macro-match nudge (see relay.mjs's
  // maybeRiskySelectorWarn/maybeMacroMatchNudge) - same header-not-body convention as the
  // nudge above, for the same reason (never change the shape of a command's own real result).
  const selectorRisk = res.headers.get('x-webscout-selector-risk');
  if (selectorRisk) emitNote(selectorRisk);
  const macroMatch = res.headers.get('x-webscout-macro-match');
  if (macroMatch) emitNote(macroMatch);
  // The relay process is running OLDER code than what is on disk (an edit to
  // relay.mjs/db.mjs/... is invisible to it until restart) - once per process
  // is enough, and CLI/MCP results are otherwise trustworthy-looking.
  const staleFiles = res.headers.get('x-webscout-relay-stale');
  if (staleFiles && !staleRelayWarned.has(staleFiles)) {
    staleRelayWarned.add(staleFiles);
    emitNote(`WARNING: the relay is running code older than what is on disk (${staleFiles} changed since it started) - results may not reflect your edits. Restart it: node tools/web-scout/cli.mjs relay restart`, 'relay-stale');
  }
  // Same idea one level down: a TAB still running an older inject.js than the one
  // on disk (a tab keeps its script until it navigates). Tabs the relay names here
  // either predate build stamps or reported a different hash.
  const staleAgents = res.headers.get('x-webscout-agent-stale');
  if (staleAgents && !staleAgentWarned.has(staleAgents)) {
    staleAgentWarned.add(staleAgents);
    emitNote(`WARNING: tab(s) ${staleAgents} run an older in-page agent than tools/web-scout/inject.js on disk - new commands may be missing or behave differently. Reload the tab ("page reload --hard"); if index.html pins the script with ?v=, bump it first.`, 'agent-stale');
  }
  // What the relay noticed about HOW this session reads (a re-read after scoping,
  // an identical full re-delivery) and its token-budget level: both are one-liners
  // the caller can act on next call, so they ride as notes like the rest.
  const hint = res.headers.get('x-webscout-hint');
  if (hint) emitNote(`hint: ${hint}`, 'read-hint');
  const budgetNote = res.headers.get('x-webscout-budget');
  if (budgetNote) emitNote(budgetNote, 'token-budget');
  // Running session token total (see relay.mjs's generic response wrapper) -
  // same header-not-body convention as the nudge above, for the same reason
  // (never change the shape of a command's own real result). Printed on
  // stderr only past a threshold - a running total after every single cheap
  // "idb list"/"ping" call would be pure noise; it matters once a session's
  // real spend is getting large enough to think about.
  const tokensSoFar = Number(res.headers.get('x-webscout-session-tokens'));
  // The relay marks a total not worth printing (this call added little and no milestone was
  // crossed) with x-webscout-tokens-quiet; a relay that predates it sends no mark and is printed as before.
  const quiet = res.headers.get('x-webscout-tokens-quiet') === '1';
  if (Number.isFinite(tokensSoFar) && tokensSoFar > SESSION_TOKENS_SOFAR_PRINT_THRESHOLD && !quiet) {
    // Header is absent (not "0") when the relay has no baseline yet for this
    // session, e.g. right after a relay restart - so no bogus per-call delta.
    const callHeader = res.headers.get('x-webscout-call-tokens');
    const callTokens = callHeader === null ? NaN : Number(callHeader);
    emitNote(`session running total: ~${tokensSoFar} estimated tokens so far${Number.isFinite(callTokens) ? ` (+${callTokens} this call)` : ''}.`, 'session-tokens');
  }
  const json = await res.json();
  if (!json.ok) {
    const err = new Error(json.error || `request to ${pathName} failed`);
    err.status = res.status;
    // A failed dom.click/dom.fill/idb.put/idb.patch TIMEOUT (504) is not
    // necessarily a failed ACTION - the page may have received and even
    // finished processing the command; only the reply never made it back in
    // time. relay.mjs's dispatchTracked best-effort re-checks live state
    // right after a timeout on one of those types and returns it as
    // `postTimeoutVerification` in the error body - surfaced here on the
    // thrown Error so cli.mjs's top-level catch (and any MCP caller
    // inspecting the error) can print it alongside the bare timeout message
    // instead of the timeout reading as a flat, uninformative failure.
    if (json.extra) Object.assign(err, json.extra);
    throw err;
  }
  return json.result;
}

// ---------- Net history (durable net_entries, client-side filter/sort) ----------
//
// Queries the DURABLE, already-persisted net_entries table (via the
// relay's GET /sessions/:id/net) instead of the in-page live ring buffer
// (net.log, capped at 500 - evicted by background sync noise within
// minutes in a real session). The relay's list route has no filter/sort
// query params of its own, so those are applied here, client-side, after
// the fetch - identical logic for cli.mjs's `net history` and
// mcp-server.mjs's `webscout_net {action:"history"}`.
export async function netHistory({ sessionId, filter, minDuration, sort, limit } = {}) {
  let id = sessionId;
  if (!id) {
    const health = await request('GET', '/health');
    if (!health.active_session) throw new Error('no active session - pass sessionId, or start one');
    id = health.active_session.id;
  }
  let entries = await request('GET', `/sessions/${id}/net`);
  entries = entries.map((e) => ({ ...e, durationMs: (Date.parse(e.ended_at) - Date.parse(e.started_at)) || null }));
  if (filter) entries = entries.filter((e) => (e.url ?? '').includes(filter));
  if (minDuration !== undefined) entries = entries.filter((e) => (e.durationMs ?? 0) >= Number(minDuration));
  if (sort === 'duration') entries = entries.slice().sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0));
  if (limit !== undefined) entries = entries.slice(0, Number(limit));
  return { sessionId: id, count: entries.length, entries };
}

// ---------- Snapshot delta (idb snapshot --since) ----------
//
// Takes a fresh snapshot scoped to the baseline's own stores, diffs it
// against the baseline, and returns only the delta. idb.snapshot is the #2
// all-time token cost offender precisely because a full dump prints every
// unchanged row alongside whatever changed. The fresh full snapshot is still
// persisted (its id is in the response). Shared by cli.mjs and mcp-server.mjs
// so an MCP caller gets the same cheap "what changed" view the CLI has.
export async function snapshotSince({ baselineId, stores, golden, agent }) {
  const baseline = await request('GET', `/state/snapshots/${baselineId}`);
  const scopeStores = stores || Object.keys(baseline.stores || {});
  const fresh = await request('POST', '/state/snapshot', { agent, stores: scopeStores, golden });
  const diff = await request('POST', '/state/diff', { idA: Number(baselineId), idB: fresh.id });
  return {
    mode: 'since', baselineSnapshotId: Number(baselineId), freshSnapshotId: fresh.id,
    summary: diff.summary, diff: diff.diff,
    note: 'only rows added/removed/changed since the baseline are shown - pass no since (or use idb dump) for a full read.',
  };
}

// ---------- page fresh (hash-through-the-page vs. hash-on-disk) ----------
//
// Fetches `localPath` THROUGH THE PAGE (its real cache/Service-Worker
// stack, not a plain disk read) and hashes it, then hashes the same file
// on disk, and reports fresh:true/false - answers "is the tab actually
// running what's on disk" in one call.
export async function pageFresh({ localPath, urlPath, agent }) {
  if (!localPath) throw new Error('localPath is required');
  // A URL path is always forward-slash, regardless of platform - localPath
  // itself may not be (a Windows PowerShell/cmd caller passing js\db.js,
  // not js/db.js) - normalized before deriving the served path so this
  // doesn't silently request an invalid /js\db.js URL.
  const served = urlPath || `/${localPath.replace(/\\/g, '/').replace(/^\/+/, '')}`;
  const diskBuf = fs.readFileSync(localPath);
  const diskSha256 = crypto.createHash('sha256').update(diskBuf).digest('hex');
  const remote = await request('POST', '/command', { type: 'page.fileHash', params: { path: served }, agent });
  return {
    localPath, servedPath: served, diskByteLength: diskBuf.length, diskSha256,
    pageStatus: remote.status, pageByteLength: remote.byteLength, pageSha256: remote.sha256,
    fresh: remote.sha256 === diskSha256,
  };
}

// ---------- DB version check (drift + live-blocked probe) ----------
//
// Reads dbJsPath's own DB_VERSION constant off disk and compares it to the
// connected tab's LIVE IndexedDB version - the same comparison "session
// start" already makes as a best-effort warning, but callable standalone,
// any time, not just at session-start. On drift, additionally dispatches
// db.probeUpgrade so the caller learns WHY a "page reload" hasn't picked up
// the new version, not just THAT it hasn't: a version-bump open() call
// hangs indefinitely if any other tab (web-scout-connected or not) still
// holds a connection at the old version - confirmed live in a real session,
// diagnosed only by hand-rolling an indexedDB.open + onblocked probe via
// `eval`. This is that probe, as a real command.
export async function dbVersionCheck({ agent, dbJsPath = 'js/db.js' } = {}) {
  let sourceVersion;
  try {
    const src = fs.readFileSync(dbJsPath, 'utf8');
    const match = src.match(/DB_VERSION\s*=\s*(\d+)/);
    if (match) sourceVersion = Number(match[1]);
  } catch { /* no js/db.js at this relative path - report live version only */ }
  const live = await request('POST', '/command', { type: 'db.version', params: {}, agent });
  const result = {
    name: live.name,
    liveVersion: live.version,
    sourceVersion,
    drift: sourceVersion !== undefined && live.version !== sourceVersion,
  };
  if (result.drift) {
    const probe = await request('POST', '/command', { type: 'db.probeUpgrade', params: { targetVersion: sourceVersion }, agent });
    result.probe = probe;
    result.hint = probe.blocked
      ? 'Blocked right now - another connection (likely another open tab on this origin) is holding IndexedDB at an older version. Close other tabs, then "page reload" (or "page reload --hard") to complete the upgrade.'
      : `Not currently blocked - "page reload" (or "page reload --hard") should complete the upgrade to v${sourceVersion} cleanly.`;
  }
  return result;
}

// ---------- Wait for reconnect (after page reload / hardReload) ----------
//
// `page.reload`/`page.hardReload` resolve immediately (before the actual
// navigation fires) - there was previously no signal for "the reload
// finished and the agent is back", so a caller had to guess a sleep
// duration and retry-on-error ("no web-scout agent named 'default'
// connected"). This polls GET /agents and reports done only after it has
// seen the target agent name DISCONNECT and then RECONNECT - not just
// "present" (which could still be the pre-reload connection, not yet torn
// down, giving a false-positive on the very first poll).
export async function waitForReconnect({ agent, timeoutMs } = {}) {
  const limit = Number(timeoutMs) || 15000;
  const target = agent || 'default';
  const start = Date.now();
  let sawDisconnect = false;
  // Confirmed false negative in real use: the "disconnect, THEN reconnect"
  // rule below only proves reconnection if a poll happens to land during the
  // (often sub-150ms) window the agent is actually absent - a fast
  // reload can tear down and re-establish the WebSocket between two polls,
  // so `present` reads true on every single poll and `sawDisconnect` never
  // flips, even though the tab genuinely reloaded and reconnected. Fixed by
  // also comparing `connectedAt` (relay.mjs's agentsDetail(), a real
  // per-connection timestamp) against its value at call time - a LATER
  // connectedAt for the same agent name is proof of a fresh connection
  // regardless of whether the gap was ever observed. Falls back to the
  // original disconnect-then-reconnect signal when no agent was connected
  // yet at call time (nothing to compare a "later" timestamp against).
  //
  // Confirmed live FALSE POSITIVE on top of that: connectedAt also bumps on
  // any WebSocket-level reconnect that has nothing to do with a real
  // reload - inject.js auto-reconnects on any socket close (network blip,
  // relay restart, page.hardReload's own SW-unregister/cache-clear step),
  // re-opening a WS inside the SAME still-running page. A window.__marker__
  // set before "page reload --hard --wait-reconnect" survived it, while
  // reconnected:true was still reported. loadId (stamped by inject.js at
  // <script> EVAL time, unique per real navigation, stable across that
  // page's own WS reconnects - see inject.js's RELAY_URL comment) is the
  // actual proof. When an initial loadId is known, reconnected now requires
  // it to have CHANGED - a later connectedAt with the SAME loadId is no
  // longer treated as a reload.
  const initialDetail = await request('GET', '/agents');
  const initialAgent = initialDetail.detail?.find((a) => a.name === target) ?? null;
  const initialConnectedAt = initialAgent?.connectedAt ?? null;
  const initialLoadId = initialAgent?.loadId ?? null;
  while (Date.now() - start < limit) {
    const { agents, detail } = await request('GET', '/agents');
    const present = agents.includes(target);
    const currentAgent = detail?.find((a) => a.name === target) ?? null;
    const connectedAtNow = currentAgent?.connectedAt ?? null;
    const loadIdNow = currentAgent?.loadId ?? null;
    if (!present) sawDisconnect = true;
    const connectionLooksFresh = sawDisconnect
      || (initialConnectedAt !== null && connectedAtNow !== null && connectedAtNow > initialConnectedAt);
    // A known initial loadId is authoritative: require it to have actually
    // changed. Only fall back to the connectedAt/disconnect signal when
    // there is no loadId to compare (older inject.js build, or no agent was
    // connected yet at call time).
    const reloadProven = initialLoadId !== null
      ? (loadIdNow !== null && loadIdNow !== initialLoadId)
      : connectionLooksFresh;
    if (present && reloadProven) {
      // loadId/initialLoadId echoed on the result (not just folded into the
      // boolean) so a human reading raw CLI/dashboard output - not just
      // trusting reconnected:true - can eyeball proof a real navigation
      // happened, same as the window.__marker__ check that first caught the
      // false-positive this replaces.
      return {
        reconnected: true,
        waitedMs: Date.now() - start,
        proofMethod: initialLoadId !== null ? 'loadId_changed' : 'connectedAt_fallback',
        initialLoadId,
        loadId: loadIdNow,
      };
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return {
    reconnected: false,
    waitedMs: Date.now() - start,
    initialLoadId,
    note: 'timed out waiting for reconnect - the tab may still be mid-reload (a hard reload with a large cache to clear can take longer than the default 15000ms), or it never re-activated (check the activation flag survived: ?webscout=1 in the URL, or localStorage.webscout_enabled)',
  };
}

// ---------- Verity scenario stub from a macro ----------
//
// Best-effort skeleton, not a translator - tools/ui-verifier's own selector
// model (automation_id/name/class_name against the UIA tree) has no
// reliable mapping from web-scout's CSS selectors, and Verity has no
// generic "set a field's value" action at all - so dom.fill/idb.*/eval/
// page.reload steps are skipped, not guessed at. What IS emitted are
// `invoke` stubs for dom.click (selector left as TODO, with the original
// CSS selector kept as a `_web_scout_hint` for a human to translate by
// hand) and `wait_present`/`wait_text_contains` stubs for dom.wait.
export function buildVerityScenarioStub(macro) {
  const steps = [];
  const skipped = [];
  macro.steps.forEach((step, i) => {
    const id = `step-${i}`;
    if (step.type === 'dom.click') {
      steps.push({ id, action: 'invoke', selector: { name_regex: 'TODO' }, _web_scout_hint: step.params?.selector });
    } else if (step.type === 'dom.wait') {
      if (step.params?.text) {
        steps.push({ id, action: 'wait_text_contains', selector: { name_regex: 'TODO' }, text_regex: step.params.text, _web_scout_hint: step.params?.selector });
      } else {
        steps.push({ id, action: 'wait_present', selector: { name_regex: 'TODO' }, _web_scout_hint: step.params?.selector });
      }
    } else {
      skipped.push(`${i}:${step.type}`);
    }
  });
  return {
    scenario: {
      target: { window_name_regex: 'TODO', document_name_regex: 'TODO' },
      policy: { interaction: true, allowed_actions: [...new Set(steps.map((s) => s.action))] },
      steps,
      _generated_from_macro: { id: macro.id, name: macro.name },
      _skipped_steps: skipped,
    },
    skipped,
  };
}

// ---------- Suite runner (macro/assert/diff-golden steps -> one pass/fail) ----------
//
// Bundles what otherwise takes several manual calls (run a macro, assert
// state, diff-golden to prove nothing else moved) into one named,
// repeatable sequence with ONE pass/fail summary - the CI-shaped wrapper
// around already-existing primitives, not a new execution engine. Takes an
// already-parsed steps array (the file-reading, for cli.mjs's `suite run
// <path>`, happens at the call site) so mcp-server.mjs can also pass steps
// inline without a temp file.
export async function runSuite(steps, { continueOnError = false } = {}) {
  if (!Array.isArray(steps) || !steps.length) throw new Error('steps must be a non-empty array');
  const results = [];
  // Memoizes a diff-golden step's own outcome by (name, idB) WITHIN this one
  // runSuite call - the DB-level golden-diff cache (see db.mjs's
  // findCachedDiff) already avoids recomputing/re-shipping the diff BODY for
  // a content-identical pair, but a suite JSON that lists the literal same
  // {name, idB} pair twice (e.g. re-checked after two different macro
  // phases that both happened to leave state clean) still pays a full HTTP
  // round trip for the second one. This skips that round trip entirely.
  const diffGoldenCache = new Map();
  for (const step of steps) {
    let outcome;
    try {
      if (step.type === 'macro') {
        if (!step.id) throw new Error('macro step requires "id"');
        const r = await request('POST', `/macros/${step.id}/run`, { continueOnError: !!step.continueOnError, confirm: !!step.confirm, fromStep: step.fromStep });
        outcome = { ok: r.results.every((s) => s.ok), detail: r };
      } else if (step.type === 'assert') {
        const health = await request('GET', '/health');
        if (!health.active_session) throw new Error('assert step requires an active session - start one first');
        let checks = step.checks;
        if (!Array.isArray(checks)) checks = [checks];
        const r = await request('POST', `/sessions/${health.active_session.id}/assert`, { checks });
        outcome = { ok: r.passed, detail: r };
      } else if (step.type === 'diff-golden') {
        if (!step.name || !step.idB) throw new Error('diff-golden step requires "name" and "idB"');
        const memoKey = `${step.name}::${step.idB}`;
        const memoized = diffGoldenCache.get(memoKey);
        if (memoized) {
          outcome = { ok: memoized.ok, detail: { ...memoized.detail, ranFromWithinSuiteCache: true } };
        } else {
          const r = await request('POST', '/state/diff', { golden: step.name, idB: Number(step.idB) });
          const clean = Object.keys(r.summary || {}).length === 0;
          outcome = { ok: step.expectClean === false ? true : clean, detail: r };
          diffGoldenCache.set(memoKey, outcome);
        }
      } else {
        outcome = { ok: false, detail: { error: `unknown suite step type '${step.type}' - expected macro/assert/diff-golden` } };
      }
    } catch (err) {
      outcome = { ok: false, detail: { error: err.message } };
    }
    results.push({ type: step.type, ok: outcome.ok, detail: outcome.detail });
    if (!outcome.ok && !continueOnError) break;
  }
  const passed = results.length === steps.length && results.every((r) => r.ok);
  return { passed, ranSteps: results.length, totalSteps: steps.length, results };
}
