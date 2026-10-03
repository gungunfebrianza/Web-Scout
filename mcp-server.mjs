#!/usr/bin/env node
// Web-scout MCP server - a thin, hand-rolled Model Context Protocol server
// (stdio transport, JSON-RPC 2.0 - no @modelcontextprotocol/sdk dependency,
// matching this repo's existing zero-npm-dependency convention, the same
// reason relay.mjs hand-rolls its WebSocket framing instead of using `ws`)
// exposing the same relay HTTP API tools/web-scout/cli.mjs already talks
// to. This file adds ZERO new business logic - every tool handler below is
// a direct translation of an existing cli.mjs call site (same route, same
// params, same shared helpers from client.mjs) into an MCP tool schema, so
// an MCP-capable agent (Claude Code, Codex CLI, ...) gets structured,
// schema-validated calls instead of composing shell/CLI argv by hand.
//
// Requires the relay to already be running (`node tools/web-scout/relay.mjs`)
// - this process does not spawn or manage it, matching cli.mjs's own
// behavior: a background process an MCP client silently launched and never
// cleaned up is a worse failure mode than a clear "relay unreachable" error.
//
// Session model: dom.*/idb.*(except snapshot/diff/restore)/net.*(except
// history)/console.*(except history)/eval/page.* all dispatch through the relay's single
// server-side "active session" (POST /command's requireActiveSession() -
// see relay.mjs) - there is no per-call session routing for these at the
// relay level, so no `sessionId` param exists on those tool actions either;
// inventing one that's silently ignored would be worse than not having it.
// Only actions backed by a relay route that itself takes an explicit id
// (session show/report/cleanup/assert/ask/verity_import, net history, console
// history) take one here.
//
// Registration:
//   claude mcp add --transport stdio web-scout -- node tools/web-scout/mcp-server.mjs
//   codex mcp add web-scout -- node tools/web-scout/mcp-server.mjs
// See tools/web-scout/README.md's "MCP server" section for both, including
// project- vs. user-scoped registration.

import fs from 'node:fs';
import readline from 'node:readline';
import {
  request, BASE, setNoteStyle, netHistory, consoleHistory, verityHistory, pageFresh, buildVerityScenarioStub, runSuite, dbVersionCheck, waitForReconnect, snapshotSince, collectNotes, ensureFreshRelayForNewSession,
  manifestPath, readManifest, writeManifest,
} from './client.mjs';
import { describeFailureContext } from './friction.mjs';
import { CLI_SPEC } from './cli-spec.mjs';
import { parseUsage, helpTopic } from './help.mjs';

const SERVER_NAME = 'web-scout';
const SERVER_VERSION = '0.27.0'; // bumped alongside docs/web-scout-roadmap.md's V39 entry

// ---------- stdio JSON-RPC framing ----------
//
// One JSON object per line, both directions (the transport MCP's stdio
// spec uses) - never write anything else to stdout, since any stray byte
// there (a stray console.log, an uncaught exception's default printer)
// corrupts the framing for whatever's still waiting on a response. All
// diagnostic/startup logging goes to stderr instead, which MCP clients
// surface as server logs without it touching the protocol stream.
function logErr(...args) {
  process.stderr.write(`[web-scout-mcp] ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`);
}

function sendMessage(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function sendResult(id, result) {
  if (id === undefined) return; // a notification never gets a response
  sendMessage({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message) {
  if (id === undefined) return;
  sendMessage({ jsonrpc: '2.0', id, error: { code, message } });
}

// ---------- Tool registry ----------
//
// Each tool takes {action, params} (grouped-by-namespace, not one MCP tool
// per CLI subcommand - ~45 individually-schema'd tools would bloat every
// session's context; a loose `params` object per action trades some
// schema strictness for a small, stable tool list). `agent` (optional,
// inside `params`) targets a specific named multi-tab connection - see
// README "Multi-tab" - omit it for the default single-tab agent. Handlers
// throw a plain Error on bad input or a relay failure alike; the top-level
// dispatcher below turns that into an MCP tool error (isError: true), not
// a JSON-RPC protocol error - a failed dom.click is a normal tool RESULT,
// not a broken connection.
function requireField(params, name) {
  const v = params?.[name];
  if (v === undefined || v === null || v === '') throw new Error(`params.${name} is required`);
  return v;
}

const TOOLS = [
  {
    name: 'webscout_meta',
    description: 'Relay/session status and cross-session utilities.\n'
      + 'Actions:\n'
      + '  status {} - relay health, agents, active session, DB_VERSION drift\n'
      + '  describe {tool?, action?} - the full help for one action (or a whole tool): usage text and the flag-to-param mapping\n'
      + '  agents {} - connected multi-tab agent names\n'
      + '  analytics {} - Friction Analytics: recurring failure patterns across ALL sessions\n'
      + '  friction {sub, type?, selector?, store?, note?, id?, remediation?, description?, confirm?, days?, noticeDays?, readDays?, filter?, sort?, limit?, session?, since?, entries?, notice?, step?, sessions?} - sub: explain (why it warns), resolve|unresolve (mark fixed; type may also be macro|verity|type|cluster, selector = its id/label/command), list, session, targets (ranked; filter text, sort cost|fails|wasted|tokens|recent|oldest), notices (what agents were told; since = last id seen), next (a notice's steps; step runs one, a write needs confirm), trend (type+selector: its rate per session; none: worse/better project-wide), regressions (fixed, failing again), issues (known-issues.json; entries imports, confirm writes), config, prune (days: result bodies; noticeDays; readDays; confirm applies), promote (candidate id; confirm writes). Page commands (page.reload...): selector = origin or origin+path\n'
      + '  search {q} - full-text search across every session\'s actions\n'
      + '  db_version_check {agent?, dbJsPath?} - js/db.js\'s DB_VERSION vs the tab\'s LIVE IndexedDB version; on drift also probes whether opening at the source version is blocked\n'
      + '  dashboard_url {} - the realtime dashboard URL (does not open a browser)\n'
      + '  ping {agent?} - fast liveness probe (no DOM/IDB work) -> {alive, ...}\n'
      + '  token_report {sessionId?} - est. tokens per command type (+ byTarget/byIntent/loops/redundantCalls/byMacro with sessionId); without it the ALL-TIME report\n'
      + '  debug_state {agent?} - the in-page runtime\'s live state (WebSocket, queues, reconnect backoff)',
    actions: {
      status: () => request('GET', '/health', undefined, { autostart: false }),
      ping: (p) => request('POST', '/ping', { agent: p?.agent }),
      token_report: (p) => request('GET', p?.sessionId ? `/sessions/${p.sessionId}/token-report` : '/token-report'),
      debug_state: (p) => sendCmd('debug.state', {}, p?.agent),
      describe: (p) => describeAction(p),
      agents: () => request('GET', '/agents'),
      analytics: () => request('GET', '/analytics'),
      search: (p) => request('GET', `/search?q=${encodeURIComponent(requireField(p, 'q'))}`),
      friction: (p) => {
        const sub = requireField(p, 'sub');
        if (sub === 'list') return request('GET', '/friction/resolutions');
        if (sub === 'config') return request('GET', '/friction/config');
        if (sub === 'session') return request('GET', '/friction/session');
        if (sub === 'targets') return request('GET', `/friction/targets?${new URLSearchParams({ ...(p.filter ? { q: p.filter } : {}), ...(p.sort ? { sort: p.sort } : {}), ...(p.limit ? { limit: String(p.limit) } : {}) })}`);
        if (sub === 'notices') return request('GET', `/friction/notices?${new URLSearchParams({ ...(p.session !== undefined ? { session: String(p.session) } : {}), ...(p.since !== undefined ? { since: String(p.since) } : {}) })}`);
        if (sub === 'regressions') return request('GET', '/friction/regressions');
        if (sub === 'next') return p.step === undefined ? request('GET', `/friction/next${p.notice !== undefined ? `?notice=${encodeURIComponent(String(p.notice))}` : ''}`) : request('POST', '/friction/next', { notice: p.notice, step: Number(p.step), confirm: p.confirm === true });
        if (sub === 'trend' && !p.type) return request('GET', `/friction/trend?${new URLSearchParams({ ...(p.sessions ? { sessions: String(p.sessions) } : {}) })}`);
        if (sub === 'trend') return request('GET', `/friction/trend?${new URLSearchParams({ type: p.type, ...(p.selector ? { selector: p.selector } : {}), ...(p.store ? { store: p.store } : {}), ...(p.sessions ? { sessions: String(p.sessions) } : {}) })}`);
        if (sub === 'issues') return Array.isArray(p.entries) ? request('POST', '/known-issues/import', { entries: p.entries, confirm: p.confirm === true }) : request('GET', '/known-issues');
        if (sub === 'prune') return request('POST', '/friction/prune', { days: p.days, noticeDays: p.noticeDays, readDays: p.readDays, confirm: p.confirm === true });
        if (sub === 'promote') {
          return request('POST', '/known-issues/promote', { id: requireField(p, 'id'), remediation: p.remediation, description: p.description, signature: p.signature, confirm: p.confirm === true });
        }
        if (sub !== 'explain' && sub !== 'resolve' && sub !== 'unresolve') throw new Error('params.sub must be explain|resolve|unresolve|list|session|targets|notices|next|trend|regressions|issues|config|prune|promote');
        const target = { type: requireField(p, 'type'), selector: p.selector, store: p.store };
        if (sub !== 'explain') return request('POST', `/friction/${sub}`, { ...target, note: p.note });
        const q = new URLSearchParams({ type: target.type });
        if (p.selector) q.set('selector', p.selector);
        if (p.store) q.set('store', p.store);
        if (p.agent) q.set('agent', p.agent);
        return request('GET', `/friction/explain?${q}`);
      },
      db_version_check: (p) => dbVersionCheck({ agent: p?.agent, dbJsPath: p?.dbJsPath }),
      dashboard_url: () => ({ url: `${BASE}/dashboard` }),
    },
  },
  {
    name: 'webscout_session',
    description: 'Session lifecycle and evidence. A goal MUST be declared (start) before any dom/idb/net/console/eval/page action is accepted; exactly one session is active at a time.\n'
      + 'Actions:\n'
      + '  start {goal, context?, strictCrv?, strictCrvStores?, crvCompact?, tags?, tokenBudget?, noBriefing?, lean?, allowRemote?, autoRecover?, ifStaleMin?} - declare a session; becomes the active one. ifStaleMin: ends a conflicting active session at least that old (minutes) first; younger still refuses. strictCrvStores scopes strictCrv auto-snapshots (omitted on a real-size db it WILL time out). crvCompact adds a change preview to each strictCrv reply. tokenBudget arms a read guard (past 60% reads over ~3000 tokens return their shape, past 85% ~1000; noGuard overrides). lean makes shaping the DEFAULT (tables; pointer/delta for repeats; shape of bodies over ~4000 tokens). The reply carries a `briefing` (stores + counts, DB version, tab freshness) unless noBriefing. Pinned to its origin: a later write/eval refuses if that changed or is non-local, unless allowRemote\n'
      + '  end {id?, trace?, applySuggestions?} - end a session (default: the active one); trace also exports it (anonymised) to grow the trace.mjs replay corpus; applySuggestions marks the "probably fixed" friction targets fixed\n'
      + '  current {} - the active session, or {active:false}\n'
      + '  list {} - every session, newest first\n'
      + '  replay {id, all?, confirm?, agent?} - re-run a session to its first failure in the active one (does it still reproduce?); dry run unless confirm:true\n'
      + '  show {id} - full detail: actions, snapshots, diffs, qa, console, net\n'
      + '  report {id, format?: "md"|"json", out?, verityPath?} - export a report; out writes a local file instead of returning it\n'
      + '  cleanup {id, confirm?, sinceSnapshotId?, summary?, agent?} - list (confirm:true deletes) rows this session\'s writes left live; dry-run by default; summary: per-store counts, not row bodies\n'
      + '  assert {id, checks, agent?} - declarative checks against LIVE state (one check object or an array)\n'
      + '  ask {question, sessionId?} - ask the configured AI backend about a session\'s evidence (optional, see README "Ask AI")\n'
      + '  verity_import {sessionId, label?, path?, result?} - fold a Verity UI Relay scenario-result into the evidence trail (path: local file; result: inline JSON; one required)\n'
      + '  verity_history {sessionId?, label?, limit?} - the DURABLE, already-persisted verity_runs table (defaults to the active session) - metadata + pass/fail counts, not each run\'s full result (verity_show for that)\n'
      + '  verity_show {id} - one imported Verity run\'s full result (every step, pass/fail), by id',
    actions: {
      start: async (p) => {
        await ensureFreshRelayForNewSession();
        const session = await request('POST', '/sessions', {
          goal: requireField(p, 'goal'), context: p.context, strictCrv: !!p.strictCrv,
          strictCrvStores: Array.isArray(p.strictCrvStores) ? p.strictCrvStores : undefined,
          crvCompact: !!p.crvCompact,
          tags: p.tags ?? [],
          tokenBudget: p.tokenBudget !== undefined ? Number(p.tokenBudget) : undefined,
          briefing: p.noBriefing ? false : undefined,
          lean: p.lean || undefined,
          agent: p.agent,
          allowRemote: p.allowRemote || undefined,
          autoRecover: p.autoRecover || undefined,
          ifStaleMin: p.ifStaleMin !== undefined && p.ifStaleMin !== null ? Number(p.ifStaleMin) : undefined,
        });
        // Folds the CLI's separate stderr-only warnOnDbVersionDrift() into
        // the returned result instead - an MCP client has no equivalent of
        // a terminal's visible stderr line by default.
        let dbVersionDrift;
        try { dbVersionDrift = (await request('GET', '/health')).db_version_drift; } catch { /* best-effort */ }
        return { ...session, dbVersionDrift };
      },
      end: async (p) => {
        let id = p?.id;
        if (!id) {
          const health = await request('GET', '/health');
          if (!health.active_session) throw new Error('no active session to end - pass params.id');
          id = health.active_session.id;
        }
        const ended = await request('POST', `/sessions/${id}/end`, p?.applySuggestions ? { applySuggestions: true } : undefined);
        if (p?.trace) {
          try { ended.trace = await request('POST', `/sessions/${ended.id}/trace`); } catch (err) { ended.trace = { error: err.message }; }
        }
        return ended;
      },
      current: async () => (await request('GET', '/health')).active_session ?? { active: false },
      list: () => request('GET', '/sessions'),
      replay: (p) => request('POST', `/sessions/${requireField(p, 'id')}/replay`, { all: p.all === true, confirm: p.confirm === true, agent: p.agent }),
      show: async (p) => {
        const id = requireField(p, 'id');
        const [session, actions, snapshots, diffs, qa, consoleEntries, net] = await Promise.all([
          request('GET', `/sessions/${id}`),
          request('GET', `/sessions/${id}/actions?full=1`),
          request('GET', `/sessions/${id}/snapshots`),
          request('GET', `/sessions/${id}/diffs`),
          request('GET', `/sessions/${id}/qa`),
          request('GET', `/sessions/${id}/console`),
          request('GET', `/sessions/${id}/net`),
        ]);
        return { session, actions, snapshots, diffs, qa, console: consoleEntries, net };
      },
      report: async (p) => {
        const id = requireField(p, 'id');
        if (p.verityPath) {
          const result = JSON.parse(fs.readFileSync(p.verityPath, 'utf8'));
          await request('POST', '/verity/import', { sessionId: Number(id), label: p.verityPath, result });
        }
        const { content } = await request('GET', `/sessions/${id}/report?format=${p.format === 'json' ? 'json' : 'md'}`);
        if (p.out) { fs.writeFileSync(p.out, content, 'utf8'); return { wrote: p.out }; }
        return { content };
      },
      cleanup: (p) => request('POST', `/sessions/${requireField(p, 'id')}/cleanup`, {
        confirm: !!p.confirm, sinceSnapshotId: p.sinceSnapshotId !== undefined ? Number(p.sinceSnapshotId) : undefined, summary: !!p.summary, agent: p.agent,
      }),
      assert: (p) => {
        const id = requireField(p, 'id');
        let checks = requireField(p, 'checks');
        if (!Array.isArray(checks)) checks = [checks];
        return request('POST', `/sessions/${id}/assert`, { checks, agent: p.agent });
      },
      ask: (p) => request('POST', '/ask', { sessionId: p?.sessionId, question: requireField(p, 'question') }),
      verity_import: (p) => {
        const sessionId = requireField(p, 'sessionId');
        const result = p.result ?? (p.path ? JSON.parse(fs.readFileSync(p.path, 'utf8')) : undefined);
        if (!result) throw new Error('params.result (inline JSON) or params.path (local file) is required');
        return request('POST', '/verity/import', { sessionId: Number(sessionId), label: p.label ?? p.path, result });
      },
      verity_history: (p) => verityHistory({ sessionId: p?.sessionId, label: p?.label, limit: p?.limit }),
      verity_show: (p) => request('GET', `/verity-runs/${requireField(p, 'id')}`),
    },
  },
  {
    name: 'webscout_dom',
    description: 'DOM read/write against the active session\'s connected tab.\n'
      + 'Actions:\n'
      + '  query {selector, full?, meta?, pick?, +shape} - outerHTML + basic attrs of the first match, truncated (full lifts that); meta: only tag/id/class/matchCount; pick: array of tag|id|class|text|html|value|attr:<name> returns just those; a whole-page selector (body/html/#app/#root/main/*) returns a depth-limited outline unless full\n'
      + '  click {selector, nth?} - dispatch a real click (native .click())\n'
      + '  drag {selector, to, nth?, toNth?} - simulate drag-and-drop (dragstart/dragenter/dragover/drop/dragend via a synthetic DataTransfer) from selector onto to; reply carries dropAccepted (target\'s dragover called preventDefault()?) - drop only dispatches when true, same gating a real drag applies\n'
      + '  fill {selector, value, nth?} - set a form field + dispatch input/change\n'
      + '  rect {selector, +shape} - getBoundingClientRect\n'
      + '  style {selector, properties?, +shape} - computed style (curated defaults, or a given array of property names)\n'
      + '  wait {selector, text?, timeoutMs?, changed?, stable?, stableCount?} - poll until selector matches (and, if text given, contains it), '
      + 'or - with changed:true - until its textContent differs from what it was at call time (a placeholder swapped '
      + 'for a real result); stable:true waits until the match count holds for stableCount polls\n'
      + '  click_wait {selector, nth?, waitSelector?, text?, timeoutMs?, changed?, stable?, stableCount?} - click, then wait for a (possibly different) waitSelector, in ONE round trip\n'
      + '  pick {timeoutMs?} - BLOCKS until a HUMAN clicks something in the tab; returns its selector\n'
      + '  settle {selector?, quietMs?, timeoutMs?} - wait until the DOM under selector (default body) has no mutations for quietMs (default 300)\n'
      + '  screenshot {selector?, outPath?} - best-effort DOM rasterization; outPath saves a PNG, else dimensions only\n'
      + '  extract_all {selector, fields?, +shape} - one row per matched element; each field is "text" (trimmed textContent), "html" (innerHTML), or an attribute name (getAttribute); default [\"text\"]. Replaces a hand-rolled querySelectorAll(...).map(...) eval walk. Capped at 50 rows (truncated:true past that).\n'
      + 'Every action takes optional `agent` (multi-tab target name); click/fill/wait also take tryRecovery:true (retry once on the selector that reliably worked after this failure) and ackRisk:true.\n'
      + '+shape (every read action of dom/react/idb/net/console) = table?, ifChanged?, delta?, peek?, noGuard?: table: rows as {columns, rows:[[...]]}; ifChanged: {unchanged, sameAs} instead of an unchanged body; delta: that, or only what changed; peek: shape, size and a sample (full result stays cached); noGuard: bypass the token-budget guard and a lean session. ifChanged/delta only while the earlier result is still in your context.',
    actions: {
      query: (p) => sendCmd('dom.query', { selector: requireField(p, 'selector'), full: !!p?.full, meta: !!p?.meta, pick: p?.pick }, p?.agent, readOpts(p)),
      click: (p) => sendCmd('dom.click', { selector: requireField(p, 'selector'), nth: numOrUndef(p?.nth) }, p?.agent),
      drag: (p) => sendCmd('dom.drag', { selector: requireField(p, 'selector'), to: requireField(p, 'to'), nth: numOrUndef(p?.nth), toNth: numOrUndef(p?.toNth) }, p?.agent),
      fill: (p) => sendCmd('dom.fill', { selector: requireField(p, 'selector'), value: requireField(p, 'value'), nth: numOrUndef(p?.nth) }, p?.agent),
      rect: (p) => sendCmd('dom.rect', { selector: requireField(p, 'selector') }, p?.agent, readOpts(p)),
      style: (p) => sendCmd('dom.computedStyle', { selector: requireField(p, 'selector'), properties: p?.properties }, p?.agent, readOpts(p)),
      wait: (p) => sendCmd('dom.wait', { selector: requireField(p, 'selector'), text: p?.text, timeoutMs: numOrUndef(p?.timeoutMs), changed: !!p?.changed, stable: !!p?.stable, stableCount: numOrUndef(p?.stableCount) }, p?.agent),
      click_wait: (p) => sendCmd('dom.clickWait', {
        selector: requireField(p, 'selector'), nth: numOrUndef(p?.nth), waitSelector: p?.waitSelector, text: p?.text,
        timeoutMs: numOrUndef(p?.timeoutMs), changed: !!p?.changed, stable: !!p?.stable, stableCount: numOrUndef(p?.stableCount),
      }, p?.agent),
      pick: (p) => sendCmd('dom.pick', { timeoutMs: numOrUndef(p?.timeoutMs) }, p?.agent),
      settle: (p) => sendCmd('dom.settle', { selector: p?.selector, quietMs: numOrUndef(p?.quietMs), timeoutMs: numOrUndef(p?.timeoutMs) }, p?.agent),
      screenshot: async (p) => {
        const result = await sendCmd('dom.screenshot', { selector: p?.selector }, p?.agent);
        if (p?.outPath) {
          const base64 = result.dataUrl.split(',')[1] ?? '';
          fs.writeFileSync(p.outPath, Buffer.from(base64, 'base64'));
          return { wrote: p.outPath, width: result.width, height: result.height };
        }
        return { width: result.width, height: result.height, dataUrlLength: result.dataUrl.length, note: 'pass params.outPath to save as a PNG file' };
      },
      extract_all: (p) => sendCmd('dom.extractAll', { selector: requireField(p, 'selector'), fields: p?.fields }, p?.agent, readOpts(p)),
    },
  },
  {
    name: 'webscout_react',
    description: 'React fiber inspection (props/state/hooks), against the active session\'s connected tab. '
      + 'Works only on a React-managed DOM node (throws otherwise); no dependency on the React DevTools extension.\n'
      + 'Actions:\n'
      + '  inspect {selector, nth?, pick?, +shape} - props (+ state for a class component, or positional hooks for a function component) '
      + 'of the nearest enclosing component walking up from selector; pick: "props"|"state"|"hooks" or a dotted path ("props.user.id", "hooks.0") returns just that\n'
      + '  tree {selector, nth?, maxDepth?, +shape} - ancestor chain of enclosing component names (default maxDepth 20), for orienting '
      + 'before drilling into one level with inspect\n'
      + 'Both take optional `agent` (multi-tab target name).',
    actions: {
      inspect: (p) => sendCmd('react.inspect', { selector: requireField(p, 'selector'), nth: numOrUndef(p?.nth), pick: p?.pick }, p?.agent, readOpts(p)),
      tree: (p) => sendCmd('react.tree', { selector: requireField(p, 'selector'), nth: numOrUndef(p?.nth), maxDepth: numOrUndef(p?.maxDepth) }, p?.agent, readOpts(p)),
    },
  },
  {
    name: 'webscout_idb',
    description: 'IndexedDB read/write plus persisted snapshot/diff/verify/restore, against the active session\'s tab. Every action takes optional agent.\n'
      + 'Actions:\n'
      + '  seed_template {store} - keyPath/indexes + a row\'s field-name/type shape, no values\n'
      + '  list {stores?, nonEmpty?, +shape} - store names + cheap row counts (not a dump) - check before an unscoped snapshot; stores: only those (unknown ones come back as missing), nonEmpty: skip empty stores\n'
      + '  dump {store, where?, fields?, limit?, countOnly?, +shape} - rows + real keyPath. where (exact-equality map), fields, limit filter IN THE PAGE - use on any large store; countOnly: counts, no rows\n'
      + '  get {store, key, fields?, +shape} - single-key lookup (store.get), not a scan; fields: keep only those keys\n'
      + '  snapshot {stores?, golden?, where?, since?} - capture + PERSIST -> {id, counts}; golden names it a regression baseline; where scopes every store to matching rows (partial by construction). since: a baseline id - fresh snapshot of that baseline\'s stores returning ONLY what changed\n'
      + '  verify {baseline?, stores?, expect?, allowExtra?, samples?, verbose?} - the verify step of baseline -> action -> verify in ONE call: re-snapshots the baseline\'s stores, diffs, checks expect, replies pass/fail + rows only for failures. expect: "notes:+1,tags:same" (+N added, +N+ at least N, -N removed, ~N changed, same) or a JSON array; an unnamed changed store is "unexpected" and fails unless allowExtra; no expect = nothing may change. baseline: snapshot id, golden name, or omitted for the session\'s newest snapshot\n'
      + '  crv_run {stores, type, params?, expect?, allowExtra?, samples?, verbose?} - snapshot, dispatch {type,params} (not idb.snapshot), verify (above) in one call; action failure fails the call\n'
      + '  crv_preflight {stores?, selector?, plan?} - pre-CRV check: origin/staleness, DB drift, stores/selector exist, console errors (+ knownIssueMatches), agents[] with tabCollision; plan [{type,params}] -> planRisk: steps that will draw a friction warning\n'
      + '  crv_seed {store, rows, manifest?} - put_many + records stored keys in a manifest (default: dotfile in CWD) for crv_cleanup\n'
      + '  crv_cleanup {manifest?} - delete_many every id crv_seed recorded; clears the manifest\n'
      + '  diff {idA, idB} - persisted diff of two snapshots\n'
      + '  diff_golden {name, idB} - diff a named golden snapshot (any session) against idB\n'
      + '  restore {snapshotId?, golden?} - PUT a snapshot\'s rows back (never deletes)\n'
      + '  put {store, row, dryRun?} - write one row by the store\'s keyPath, returns the stored row; dryRun validates without writing -> {valid, problems}\n'
      + '  put_many {store, rows, dryRun?} - batch write in ONE transaction; a failed row (e.g. unique-index conflict) lands in `failed`; dryRun validates every row\n'
      + '  patch {store, key, patch} - shallow-merge onto the EXISTING row; errors if none (never inserts)\n'
      + '  delete {store, key} - delete one row\n'
      + '  delete_many {store, keys} - one transaction; returns deletedKeys/failedKeys\n'
      + '  clear {store} - delete every row in a store\n'
      + '  wait {store, countGte?, timeoutMs?} - poll the row count until >= countGte or timeout (default 10000)\n'
      + '(No watch action: use wait for a bounded check.)',
    actions: {
      seed_template: (p) => sendCmd('idb.seedTemplate', { store: requireField(p, 'store') }, p?.agent),
      list: (p) => sendCmd('idb.list', { stores: p?.stores, nonEmpty: p?.nonEmpty || undefined }, p?.agent, readOpts(p)),
      dump: (p) => sendCmd('idb.dump', { store: requireField(p, 'store'), where: p?.where, fields: p?.fields, limit: numOrUndef(p?.limit), countOnly: p?.countOnly || undefined }, p?.agent, readOpts(p)),
      get: (p) => sendCmd('idb.get', { store: requireField(p, 'store'), key: requireField(p, 'key'), fields: p?.fields }, p?.agent, readOpts(p)),
      snapshot: (p) => (p?.since !== undefined
        ? snapshotSince({ baselineId: p.since, stores: p?.stores, golden: p?.golden, agent: p?.agent })
        : request('POST', '/state/snapshot', { agent: p?.agent, stores: p?.stores, golden: p?.golden, where: p?.where })),
      verify: (p) => request('POST', '/state/verify', {
        agent: p?.agent, baseline: p?.baseline, stores: p?.stores, expect: p?.expect, allowExtra: p?.allowExtra || undefined,
        verbose: p?.verbose || undefined, samples: numOrUndef(p?.samples),
      }),
      crv_run: (p) => request('POST', '/crv/run', {
        agent: p?.agent, stores: requireField(p, 'stores'), type: requireField(p, 'type'), params: p?.params ?? {},
        expect: p?.expect, allowExtra: p?.allowExtra || undefined, verbose: p?.verbose || undefined, samples: numOrUndef(p?.samples),
        ackRisk: p?.ackRisk === true || undefined,
      }),
      crv_preflight: (p) => request('POST', '/crv/preflight', { agent: p?.agent, stores: p?.stores, selector: p?.selector, plan: typeof p?.plan === 'string' ? JSON.parse(p.plan) : p?.plan }),
      crv_seed: async (p) => {
        const store = requireField(p, 'store');
        const result = await sendCmd('idb.putMany', { store, rows: requireField(p, 'rows') }, p?.agent);
        const file = manifestPath(p?.manifest);
        const manifest = readManifest(file);
        const ids = (result.rows || []).map((row) => (Array.isArray(result.keyPath) ? result.keyPath.map((k) => row?.[k]) : row?.[result.keyPath]));
        let entry = manifest.entries.find((e) => e.store === store);
        if (!entry) { entry = { store, ids: [] }; manifest.entries.push(entry); }
        entry.ids.push(...ids);
        writeManifest(file, manifest);
        return { ...result, manifest: file, manifestIds: ids };
      },
      crv_cleanup: async (p) => {
        const file = manifestPath(p?.manifest);
        const manifest = readManifest(file);
        if (!manifest.entries.length) return { cleaned: [], note: `no manifest entries at ${file} - nothing to clean up` };
        const cleaned = [];
        for (const entry of manifest.entries) {
          if (!entry.ids.length) continue;
          const result = await sendCmd('idb.deleteMany', { store: entry.store, keys: entry.ids }, p?.agent);
          cleaned.push({ store: entry.store, ...result });
        }
        try { fs.unlinkSync(file); } catch { /* already gone, or never written */ }
        return { cleaned, manifest: file };
      },
      diff: (p) => request('POST', '/state/diff', { idA: Number(requireField(p, 'idA')), idB: Number(requireField(p, 'idB')) }),
      diff_golden: (p) => request('POST', '/state/diff', { golden: requireField(p, 'name'), idB: Number(requireField(p, 'idB')) }),
      restore: (p) => request('POST', '/state/restore', { agent: p?.agent, snapshotId: p?.snapshotId !== undefined ? Number(p.snapshotId) : undefined, golden: p?.golden }),
      put: (p) => sendCmd('idb.put', { store: requireField(p, 'store'), row: requireField(p, 'row'), dryRun: !!p?.dryRun }, p?.agent),
      put_many: (p) => sendCmd('idb.putMany', { store: requireField(p, 'store'), rows: requireField(p, 'rows'), dryRun: !!p?.dryRun }, p?.agent),
      patch: (p) => sendCmd('idb.patch', { store: requireField(p, 'store'), key: requireField(p, 'key'), patch: requireField(p, 'patch') }, p?.agent),
      delete: (p) => sendCmd('idb.delete', { store: requireField(p, 'store'), key: requireField(p, 'key') }, p?.agent),
      delete_many: (p) => sendCmd('idb.deleteMany', { store: requireField(p, 'store'), keys: requireField(p, 'keys') }, p?.agent),
      clear: (p) => sendCmd('idb.clear', { store: requireField(p, 'store') }, p?.agent),
      wait: (p) => sendCmd('idb.wait', { store: requireField(p, 'store'), countGte: numOrUndef(p?.countGte), timeoutMs: numOrUndef(p?.timeoutMs) }, p?.agent),
    },
  },
  {
    name: 'webscout_net',
    description: 'Captured network traffic.\n'
      + 'Actions:\n'
      + '  log {limit?, urlContains?, failed?, fields?, +shape} - LIVE in-page ring buffer since last clear, capped at 500 entries (background traffic evicts within minutes). urlContains, failed (errors and 4xx/5xx only), fields (keys to keep per entry) and limit (N most recent) filter IN THE PAGE (unfiltered ~55KB)\n'
      + '  wait {urlPattern, timeoutMs?, graceMs?} - attach-and-wait for a request whose URL contains urlPattern\n'
      + '  history {sessionId?, filter?, minDuration?, sort?: "duration", limit?} - the DURABLE, already-persisted net_entries table (defaults to the active session)\n'
      + '  clear {} - clear the live ring buffer\n'
      + '  capture {filter?, off?} - ADDS filter to the armed response-BODY capture set (fetch/XHR) for requests whose URL contains it - call again with a different filter to watch a second endpoint too; log/wait/history entries then gain a bodyPreview. off:true clears every armed filter (off by default)\n'
      + 'log/wait/clear/capture take optional `agent` (multi-tab target name); history does not (it queries by sessionId, not by live agent connection).',
    actions: {
      log: (p) => sendCmd('net.log', { limit: numOrUndef(p?.limit), urlContains: p?.urlContains, fields: p?.fields, failed: p?.failed || undefined }, p?.agent, readOpts(p)),
      wait: (p) => sendCmd('net.wait', { urlPattern: requireField(p, 'urlPattern'), timeoutMs: numOrUndef(p?.timeoutMs), graceMs: numOrUndef(p?.graceMs) }, p?.agent),
      history: (p) => netHistory({ sessionId: p?.sessionId, filter: p?.filter, minDuration: p?.minDuration, sort: p?.sort, limit: p?.limit }),
      clear: (p) => sendCmd('net.clear', {}, p?.agent),
      capture: (p) => sendCmd('net.setBodyCapture', p?.off ? { off: true } : { filter: p?.filter }, p?.agent),
    },
  },
  {
    name: 'webscout_console',
    description: 'Captured console.error/warn + uncaught error entries.\n'
      + 'Actions:\n'
      + '  log {limit?, level?, contains?, fields?, +shape} - LIVE in-page ring buffer since last clear, evicted by page noise within minutes; level (error|warn|uncaught|unhandledrejection, comma list ok) and contains filter, fields keeps only those keys per entry (drop stack), limit keeps the N most recent\n'
      + '  wait {substr, timeoutMs?, graceMs?} - attach-and-wait for an entry whose message contains substr, instead of a sleep+poll loop\n'
      + '  history {sessionId?, contains?, level?, limit?} - the DURABLE, already-persisted console_entries table (defaults to the active session)\n'
      + '  clear {}\n'
      + 'log/wait/clear take optional `agent` (multi-tab target name); history does not (it queries by sessionId, not by live agent connection).',
    actions: {
      log: (p) => sendCmd('console.log', { limit: numOrUndef(p?.limit), level: p?.level, contains: p?.contains, fields: p?.fields }, p?.agent, readOpts(p)),
      wait: (p) => sendCmd('console.wait', { substr: requireField(p, 'substr'), timeoutMs: numOrUndef(p?.timeoutMs), graceMs: numOrUndef(p?.graceMs) }, p?.agent),
      history: (p) => consoleHistory({ sessionId: p?.sessionId, contains: p?.contains, level: p?.level, limit: p?.limit }),
      clear: (p) => sendCmd('console.clear', {}, p?.agent),
    },
  },
  {
    name: 'webscout_css',
    description: 'Loaded stylesheets (document.styleSheets), read-only.\n'
      + 'Actions:\n'
      + '  has_rule {selector, sheet?, +shape} - does any loaded stylesheet have a rule whose selectorText contains selector (plain substring)? sheet optionally scopes to stylesheets whose href contains it. Recurses into @media/@supports nesting. Replaces hand-walking document.styleSheets via eval to check whether a CSS edit landed after a cache-bust reload.\n'
      + 'Takes optional `agent` (multi-tab target name).',
    actions: {
      has_rule: (p) => sendCmd('css.hasRule', { selector: requireField(p, 'selector'), sheet: p?.sheet }, p?.agent, readOpts(p)),
    },
  },
  {
    name: 'webscout_page',
    description: 'Whole-page operations. Both take optional agent.\n'
      + 'Actions:\n'
      + '  reload {hard?, waitReconnect?, timeoutMs?} - location.reload(); hard also unregisters Service Workers and clears Cache Storage first (for a stale-while-revalidate SW). Replies BEFORE the navigation fires; waitReconnect blocks until the agent disconnects and reconnects (default 15000ms)\n'
      + '  fresh {localPath, urlPath?} - fetches localPath THROUGH THE PAGE (its real cache/SW stack) and compares its hash to the file on disk: "is the tab running what is on disk"',
    actions: {
      reload: async (p) => {
        const result = await sendCmd(p?.hard ? 'page.hardReload' : 'page.reload', {}, p?.agent);
        if (p?.waitReconnect) {
          // Same reasoning as cli.mjs: a hard reload additionally clears
          // Cache Storage before navigating, which can take noticeably
          // longer than a plain reload's default 15000ms wait - previously
          // a false-negative reconnected:false even on a healthy reconnect.
          const defaultTimeout = p?.hard ? 30000 : 15000;
          result.reconnect = await waitForReconnect({ agent: p?.agent, timeoutMs: numOrUndef(p?.timeoutMs) ?? defaultTimeout });
        }
        return result;
      },
      fresh: (p) => pageFresh({ localPath: requireField(p, 'localPath'), urlPath: p?.urlPath, agent: p?.agent }),
    },
  },
  {
    name: 'webscout_macro',
    description: 'Named, replayable sequences of a session\'s recorded actions.\n'
      + 'Actions:\n'
      + '  record {name, sessionId, all?} - save that session\'s replayable actions (dom.click/fill/wait, idb.put/delete/deleteMany/clear/wait, page.reload, eval) as a macro\n'
      + '  list {risk?} - id, name, step count, source session per macro; risk adds steps that would draw a friction warning now\n'
      + '  show {id} - full detail incl. every step\n'
      + '  run {id, continueOnError?, fromStep?, confirm?, full?} - replay against the ACTIVE session (409 if its goal looks unrelated to the macro\'s source session unless confirm:true); full:true returns every step\'s complete result instead of the compact summary\n'
      + '  update {id, steps} - replace the whole step array (fix/reorder/remove a step without deleting and re-recording)\n'
      + '  delete {id}\n'
      + '  export_verity {id, outPath?} - skeleton Verity scenario JSON from dom.click/dom.wait steps (selectors left as TODO)',
    actions: {
      record: (p) => request('POST', '/macros', { name: requireField(p, 'name'), sessionId: Number(requireField(p, 'sessionId')), all: !!p.all }),
      list: (p) => request('GET', p?.risk ? '/macros?risk=1' : '/macros'),
      show: (p) => request('GET', `/macros/${requireField(p, 'id')}`),
      run: (p) => request('POST', `/macros/${requireField(p, 'id')}/run`, {
        continueOnError: !!p.continueOnError, confirm: !!p.confirm, full: !!p.full, fromStep: p.fromStep !== undefined ? Number(p.fromStep) : undefined,
      }),
      update: (p) => request('PUT', `/macros/${requireField(p, 'id')}/steps`, { steps: requireField(p, 'steps') }),
      delete: (p) => request('DELETE', `/macros/${requireField(p, 'id')}`),
      export_verity: async (p) => {
        const macro = await request('GET', `/macros/${requireField(p, 'id')}`);
        const { scenario, skipped } = buildVerityScenarioStub(macro);
        if (p.outPath) { fs.writeFileSync(p.outPath, JSON.stringify(scenario, null, 2), 'utf8'); return { wrote: p.outPath, stepCount: scenario.steps.length, skipped }; }
        return { scenario, skipped };
      },
    },
  },
  {
    name: 'webscout_suite',
    description: 'Runs a named, repeatable checklist bundling macro/assert/diff-golden steps into ONE pass/fail summary.\n'
      + 'Actions:\n'
      + '  run {path?, steps?, continueOnError?} - path: local suite JSON file; steps: the same array given inline instead. Exactly one of path/steps is required.\n'
      + 'Step shapes: {"type":"macro","id":N}, {"type":"assert","checks":{...}|[...]}, {"type":"diff-golden","name":"<golden>","idB":N,"expectClean":false}.',
    actions: {
      run: (p) => {
        const steps = p?.steps ?? (p?.path ? JSON.parse(fs.readFileSync(p.path, 'utf8')) : undefined);
        if (!steps) throw new Error('params.path or params.steps is required');
        return runSuite(steps, { continueOnError: !!p?.continueOnError });
      },
    },
  },
  {
    name: 'webscout_repair',
    description: 'Self-repair loop: source-write + confirm-fix, scoped to the example app under self-repair.mjs\'s scope dir ONLY (see webscout2.md). Disabled by default (fail-closed); enable/disable is a server-side flag.\n'
      + 'Actions:\n'
      + '  status {} - enabled/scopeDir + recent enable/disable history\n'
      + '  enable {by?} - flip the kill-switch on (logged with who flipped it)\n'
      + '  disable {by?} - flip it off\n'
      + '  patch {file, find, replace, fixesActionId?} - literal find/replace, ONE file, in scope only; refuses an ambiguous/missing match or out-of-scope path. fixesActionId -> a RECORDED (not inferred) causal edge\n'
      + '  verify {stores, type, params?, expect?, patchActionId?, allowExtra?, samples?, verbose?} - same shape as webscout_idb.crv_run, replayed against the patched app; patchActionId -> another RECORDED edge. {pass:false,...} is a normal result, not an error\n'
      + '  causal_diff {sessionA, sessionB} - two sessions\' causality trees diffed, plus each session\'s RECORDED fixed_by/confirmed_by edges - see webscout2.md\'s "recorded vs inferred" gap',
    actions: {
      status: () => request('GET', '/repair/config'),
      enable: (p) => request('PUT', '/repair/config', { enabled: true, by: p?.by }),
      disable: (p) => request('PUT', '/repair/config', { enabled: false, by: p?.by }),
      patch: (p) => {
        if (p?.replace === undefined || p?.replace === null) throw new Error('params.replace is required (use "" to delete the matched text)');
        return request('POST', '/repair/patch', { file: requireField(p, 'file'), find: requireField(p, 'find'), replace: p.replace, fixesActionId: p?.fixesActionId });
      },
      verify: (p) => request('POST', '/repair/verify', {
        agent: p?.agent, stores: requireField(p, 'stores'), type: requireField(p, 'type'), params: p?.params ?? {}, expect: p?.expect,
        patchActionId: p?.patchActionId, allowExtra: p?.allowExtra || undefined, verbose: p?.verbose || undefined, samples: numOrUndef(p?.samples),
      }),
      causal_diff: (p) => request('GET', `/repair/causal-diff?a=${encodeURIComponent(requireField(p, 'sessionA'))}&b=${encodeURIComponent(requireField(p, 'sessionB'))}`),
    },
  },
];

// eval has no sub-actions (a single free-form expression, not a fixed verb
// set) - kept outside the action-dispatch pattern above rather than forced
// into a one-action namespace.
const EVAL_TOOL = {
  name: 'webscout_eval',
  description: 'Evaluate raw JavaScript in the active session\'s connected tab (escape hatch - see README "Security model / non-goals"). '
    + 'Tries expr as a single EXPRESSION first; on a SyntaxError, retries it as a function BODY (statements, with an explicit "return" for a value back). '
    + 'params: {expr?, filePath?, timeoutMs?, agent?} - filePath reads the script from a local file instead of inlining it (use for any multi-line payload). '
    + 'Exactly one of expr/filePath is required. Cannot interrupt a synchronous infinite loop (JS is single-threaded) - that freezes the tab; reload it.',
  inputSchema: {
    type: 'object',
    properties: {
      expr: { type: 'string', description: 'JS expression or statement(s) to evaluate' },
      filePath: { type: 'string', description: 'local file to read the script from instead of expr' },
      timeoutMs: { type: 'number', description: 'default 10000' },
      agent: { type: 'string', description: 'multi-tab target name, default the single-tab agent' },
    },
    additionalProperties: false,
  },
  call: (args) => {
    const expr = args?.filePath ? fs.readFileSync(args.filePath, 'utf8') : args?.expr;
    if (!expr) throw new Error('exactly one of "expr" or "filePath" is required');
    return sendCmd('eval', { expr, timeoutMs: numOrUndef(args?.timeoutMs) }, args?.agent);
  },
};

function numOrUndef(v) { return v === undefined || v === null ? undefined : Number(v); }

// The read-shaping params any cacheable read accepts (see read-pipeline.mjs).
function readOpts(p) {
  const opts = {};
  for (const k of ['table', 'ifChanged', 'delta', 'peek', 'noGuard']) if (p?.[k]) opts[k] = true;
  return Object.keys(opts).length ? opts : undefined;
}

function sendCmd(type, params, agent, opts) {
  // `ackRisk:true` in an action's params acknowledges an ESCALATED selector-risk warning on a
  // relay running with WEBSCOUT_RISKY_BLOCK=1; it is a relay-level flag, never forwarded to the page.
  // `tryRecovery:true` likewise: after a click/fill/wait fails, run once on the alternative selector that has repeatedly worked.
  const { ackRisk, tryRecovery, ...pageParams } = params ?? {};
  return request('POST', '/command', { type, params: params === undefined ? undefined : pageParams, agent, opts, ...(ackRisk === true ? { ackRisk: true } : {}), ...(tryRecovery === true ? { tryRecovery: true } : {}) });
}

function toolInputSchema(tool) {
  return {
    type: 'object',
    properties: {
      action: { type: 'string', enum: Object.keys(tool.actions), description: 'see the tool description' },
      params: { type: 'object', description: 'fields per the tool description', additionalProperties: true },
    },
    required: ['action'],
    additionalProperties: false,
  };
}

// The tool list is paid for at every session start, so each action line is cut to its signature and the first clause of
// what it does; everything longer is one call away ("webscout_meta describe {tool, action}"), which serves the CLI usage
// text for that action. Non-action lines (the tool intro, shared notes) are kept, capped.
function firstClause(text, max = 90) {
  let cut = max > 200 ? text : text.split(/;\s|\.\s| - | \(/)[0].trim();
  if (cut.length < 25) cut = text; // split at an abbreviation ("est. tokens") or an opening bracket: take the plain text instead
  return cut.length <= max ? cut : `${cut.slice(0, max).replace(/\s+\S*$/, '')}...`;
}
export function terseDescription(full) {
  const lines = full.split('\n').map((line) => {
    const m = /^( {2}\w+ \{[^}]*\})(?: - (.*))?$/.exec(line);
    if (!m) return line.length > 240 ? `${line.slice(0, 237)}...` : line;
    // friction's sub list IS its documentation (one action, a dozen verbs), so it keeps a longer cut.
    return m[2] ? `${m[1]} - ${firstClause(m[2], /^ {2}friction /.test(line) ? 480 : 90)}` : m[1];
  });
  return lines.join('\n');
}

let usageParsed = null;
function describeAction(p) {
  const tool = p?.tool ? String(p.tool) : '';
  const action = p?.action ? String(p.action) : '';
  const all = [...TOOLS, EVAL_TOOL];
  if (!tool) return { tools: all.map((t) => ({ tool: t.name, actions: [...t.description.matchAll(/^ {2}(\w+) \{/gm)].map((m) => m[1]) })), usage: 'describe {tool} for the full long-form text of a tool, describe {tool, action} for one action' };
  const found = all.find((t) => t.name === tool || t.name === `webscout_${tool}`);
  if (!found) throw new Error(`unknown tool "${tool}" - one of: ${all.map((t) => t.name).join(', ')}`);
  if (!action) return { tool: found.name, description: found.description };
  const line = found.description.split('\n').find((l) => new RegExp(`^ {2}${action} \\{`).test(l));
  const key = found.name === EVAL_TOOL.name ? found.name : `${found.name}.${action}`;
  const rows = CLI_SPEC.filter((r) => r.mcp === key);
  if (!line && !rows.length) throw new Error(`unknown action "${action}" on ${found.name}`);
  usageParsed ??= parseUsage(fs.readFileSync(new URL('./usage.txt', import.meta.url), 'utf8'));
  return {
    tool: found.name, action, signature: line?.trim() ?? null,
    commands: rows.map((r) => {
      const [topic, sub] = r.cmd.split(' ');
      return { cli: r.cmd, flagToParam: r.params ?? {}, help: helpTopic(usageParsed, topic, sub) };
    }),
  };
}

function listToolDescriptors() {
  const grouped = TOOLS.map((t) => ({ name: t.name, description: terseDescription(t.description), inputSchema: toolInputSchema(t) }));
  return [...grouped, { name: EVAL_TOOL.name, description: terseDescription(EVAL_TOOL.description), inputSchema: EVAL_TOOL.inputSchema }];
}

// ---------- resources: what agents were told, readable without a tool call ----------
const RESOURCES = [
  { uri: 'webscout://notices', name: 'Friction notices', description: 'what agents were told this session (warnings and nudges, each with its next steps), newest last', mimeType: 'application/json', route: '/friction/notices' },
  { uri: 'webscout://regressions', name: 'Regressions', description: 'targets declared fixed that have failed again', mimeType: 'application/json', route: '/friction/regressions' },
  { uri: 'webscout://targets', name: 'Friction targets', description: 'the ranked list of recurring failures', mimeType: 'application/json', route: '/friction/targets?limit=20' },
];

async function callTool(name, args) {
  if (name === EVAL_TOOL.name) return EVAL_TOOL.call(args ?? {});
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`unknown tool '${name}'`);
  const action = args?.action;
  const handler = action && tool.actions[action];
  if (!handler) throw new Error(`unknown action '${action}' for ${name} - valid actions: ${Object.keys(tool.actions).join(', ')}`);
  return handler(args?.params ?? {});
}

// ---------- JSON-RPC method handlers ----------

function handleInitialize(msg) {
  // Trust the client's own requested protocolVersion rather than asserting
  // a specific one is "latest" - a minimal, permissive negotiation that
  // works with any client speaking JSON-RPC-over-stdio MCP.
  const protocolVersion = msg.params?.protocolVersion || '2025-06-18';
  sendResult(msg.id, {
    protocolVersion,
    capabilities: { tools: {}, resources: {} },
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
  });
}

function handleToolsList(msg) {
  sendResult(msg.id, { tools: listToolDescriptors() });
}

async function handleToolsCall(msg) {
  const { name, arguments: args } = msg.params ?? {};
  try {
    // Nudges, the running token total and the stale-relay warning are carried
    // as relay response headers and normally printed to stderr - which an MCP
    // host routes to its logs, never to the model. collectNotes() captures
    // them per tool call so they ride along as extra text content the agent
    // actually reads. The first content item is always the tool's own JSON
    // result, unchanged.
    const { value: result, notes } = await collectNotes(() => callTool(name, args));
    sendResult(msg.id, { content: [{ type: 'text', text: JSON.stringify(result) }, ...notes.map((n) => ({ type: 'text', text: `[web-scout] ${n}` }))] });
  } catch (err) {
    // A failed tool call (bad params, relay says no, dom.click found no
    // match) is a normal MCP tool RESULT with isError:true, not a
    // JSON-RPC protocol-level error - the agent gets the actual message
    // back and can react to it, rather than the call looking like a
    // broken connection.
    const extraText = [];
    // client.mjs already copies relay.mjs's err.extra onto the thrown Error (see request()) -
    // the CLI front end already prints these (cli.mjs's main().catch()); this front end was
    // dropping both silently, so the same failure gave an MCP agent strictly less information
    // than a CLI agent got for the identical failure.
    if (err.postTimeoutVerification) extraText.push(`[web-scout] Post-timeout verification (best-effort): ${JSON.stringify(err.postTimeoutVerification)}`);
    if (err.knownIssue) extraText.push(`[web-scout] Known issue: ${err.knownIssue.id}${err.knownIssue.description ? ` - ${err.knownIssue.description}` : ''}${err.knownIssue.remediation ? ` (remediation: ${err.knownIssue.remediation})` : ''}`);
    if (err.selectorFriction) extraText.push(`[web-scout] ${describeFailureContext(err.selectorFriction)}`);
    for (const line of err.emergentFriction ?? []) extraText.push(`[web-scout] Emergent friction: ${line}`);
    if (err.knownIssuesCheckError) extraText.push(`[web-scout] known-issues.json could not be checked: ${err.knownIssuesCheckError}`);
    sendResult(msg.id, { content: [{ type: 'text', text: err.message }, ...extraText.map((t) => ({ type: 'text', text: t })), ...(err.notes ?? []).map((n) => ({ type: 'text', text: `[web-scout] ${n}` }))], isError: true });
  }
}

async function handleMessage(msg) {
  if (msg.method === 'initialize') { handleInitialize(msg); return; }
  if (msg.method === 'notifications/initialized') return; // no response for a notification
  if (msg.method === 'tools/list') { handleToolsList(msg); return; }
  if (msg.method === 'tools/call') { await handleToolsCall(msg); return; }
  if (msg.method === 'resources/list') { sendResult(msg.id, { resources: RESOURCES.map(({ route, ...r }) => r) }); return; }
  if (msg.method === 'resources/read') {
    const res = RESOURCES.find((r) => r.uri === msg.params?.uri);
    if (!res) { sendError(msg.id, -32602, `unknown resource: ${msg.params?.uri}`); return; }
    try {
      const body = await request('GET', res.route);
      sendResult(msg.id, { contents: [{ uri: res.uri, mimeType: res.mimeType, text: JSON.stringify(body) }] });
    } catch (err) { sendError(msg.id, -32603, err.message); }
    return;
  }
  if (msg.method === 'ping') { sendResult(msg.id, {}); return; }
  sendError(msg.id, -32601, `method not found: ${msg.method}`);
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    sendError(undefined, -32700, 'parse error');
    return;
  }
  handleMessage(msg).catch((err) => {
    logErr('unhandled error handling', msg.method, err.message);
    sendError(msg.id, -32603, `internal error: ${err.message}`);
  });
});

setNoteStyle('mcp'); // notices tell an MCP caller what to CALL, not what to type
logErr(`${SERVER_NAME} MCP server ${SERVER_VERSION} ready (stdio) - relay expected at ${BASE}`);
