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
// history)/console.*/eval/page.* all dispatch through the relay's single
// server-side "active session" (POST /command's requireActiveSession() -
// see relay.mjs) - there is no per-call session routing for these at the
// relay level, so no `sessionId` param exists on those tool actions either;
// inventing one that's silently ignored would be worse than not having it.
// Only actions backed by a relay route that itself takes an explicit id
// (session show/report/cleanup/assert/ask/verity_import, net history) take
// one here.
//
// Registration:
//   claude mcp add --transport stdio web-scout -- node tools/web-scout/mcp-server.mjs
//   codex mcp add web-scout -- node tools/web-scout/mcp-server.mjs
// See tools/web-scout/README.md's "MCP server" section for both, including
// project- vs. user-scoped registration.

import fs from 'node:fs';
import readline from 'node:readline';
import {
  request, BASE, netHistory, pageFresh, buildVerityScenarioStub, runSuite, dbVersionCheck, waitForReconnect, snapshotSince, collectNotes,
} from './client.mjs';

const SERVER_NAME = 'web-scout';
const SERVER_VERSION = '0.20.0'; // bumped alongside docs/web-scout-roadmap.md's V32 entry

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
    description: 'Read-only relay/session status and cross-session utilities.\n'
      + 'Actions:\n'
      + '  status {} - relay health, connected agents, active session, DB_VERSION drift\n'
      + '  agents {} - list connected multi-tab agent names\n'
      + '  analytics {} - cross-session Friction Analytics (recurring failure patterns across ALL sessions)\n'
      + '  search {q} - full-text search across every session\'s actions\n'
      + '  db_version_check {agent?, dbJsPath?} - compares js/db.js\'s own DB_VERSION (on disk, default "js/db.js") '
      + 'against the connected tab\'s LIVE IndexedDB version; on drift, also probes whether opening at the source '
      + 'version is blocked RIGHT NOW (another tab holding a connection at the older version) and by what\n'
      + '  dashboard_url {} - the realtime dashboard\'s URL (this does not open a browser itself)\n'
      + '  ping {agent?} - fast liveness probe of the connected tab (does no DOM/IndexedDB work) -> {alive, ...}\n'
      + '  token_report {sessionId?} - estimated tokens read per command type (+ byTarget/loops/redundantCalls/byMacro when sessionId is given); omit sessionId for the ALL-TIME report including the savings ledgers\n'
      + '  debug_state {agent?} - this tool\'s own live in-page runtime state (WebSocket readyState, queue sizes, reconnect backoff)',
    actions: {
      status: () => request('GET', '/health', undefined, { autostart: false }),
      ping: (p) => request('POST', '/ping', { agent: p?.agent }),
      token_report: (p) => request('GET', p?.sessionId ? `/sessions/${p.sessionId}/token-report` : '/token-report'),
      debug_state: (p) => sendCmd('debug.state', {}, p?.agent),
      agents: () => request('GET', '/agents'),
      analytics: () => request('GET', '/analytics'),
      search: (p) => request('GET', `/search?q=${encodeURIComponent(requireField(p, 'q'))}`),
      db_version_check: (p) => dbVersionCheck({ agent: p?.agent, dbJsPath: p?.dbJsPath }),
      dashboard_url: () => ({ url: `${BASE}/dashboard` }),
    },
  },
  {
    name: 'webscout_session',
    description: 'Session lifecycle and evidence. A session\'s goal/context MUST be declared '
      + '(action "start") before any dom/idb/net/console/eval/page action below will be accepted '
      + 'by the relay - there is exactly one "active" session at a time server-side.\n'
      + 'Actions:\n'
      + '  start {goal, context?, strictCrv?, strictCrvStores?, tags?, tokenBudget?, noBriefing?} - declare a session; becomes the active one. strictCrvStores scopes every strictCrv auto-snapshot to those stores - omitting it against a real-size db WILL time out. tokenBudget also arms a read guard: past 60% of it reads over ~3000 estimated tokens return their shape instead of the body (noGuard overrides), past 85% the limit drops to ~1000, and rows come back as {columns, rows}. The reply carries a `briefing` (stores + row counts, DB version, tab freshness) unless noBriefing:true\n'
      + '  end {id?} - end a session (defaults to the active one)\n'
      + '  current {} - the active session, or {active:false}\n'
      + '  list {} - every session, newest first\n'
      + '  show {id} - full session detail: actions, snapshots, diffs, qa, console, net\n'
      + '  report {id, format?: "md"|"json", out?, verityPath?} - export a session report; out writes to a local file instead of returning content inline\n'
      + '  cleanup {id, confirm?, sinceSnapshotId?, summary?} - list (or, with confirm:true, delete) rows this session\'s own writes left live; dry-run by default. summary:true collapses row lists down to a per-store count instead of full row bodies\n'
      + '  assert {id, checks, agent?} - declarative regression checks against LIVE state (checks: one check object or an array)\n'
      + '  ask {question, sessionId?} - ask the configured AI backend to explain a session\'s recorded evidence (optional feature - see README "Ask AI")\n'
      + '  verity_import {sessionId, label?, path?, result?} - fold a Verity UI Relay scenario-result into this session\'s evidence trail (path: local file; result: inline JSON, one of the two required)',
    actions: {
      start: async (p) => {
        const session = await request('POST', '/sessions', {
          goal: requireField(p, 'goal'), context: p.context, strict_crv: !!p.strictCrv,
          strict_crv_stores: Array.isArray(p.strictCrvStores) ? p.strictCrvStores : undefined,
          tags: p.tags ?? [],
          token_budget: p.tokenBudget !== undefined ? Number(p.tokenBudget) : undefined,
          briefing: p.noBriefing ? false : undefined,
          agent: p.agent,
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
        return request('POST', `/sessions/${id}/end`);
      },
      current: async () => (await request('GET', '/health')).active_session ?? { active: false },
      list: () => request('GET', '/sessions'),
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
        confirm: !!p.confirm, sinceSnapshotId: p.sinceSnapshotId !== undefined ? Number(p.sinceSnapshotId) : undefined, summary: !!p.summary,
      }),
      assert: (p) => {
        const id = requireField(p, 'id');
        let checks = requireField(p, 'checks');
        if (!Array.isArray(checks)) checks = [checks];
        return request('POST', `/sessions/${id}/assert`, { checks, agent: p.agent });
      },
      ask: (p) => request('POST', '/ask', { session_id: p?.sessionId, question: requireField(p, 'question') }),
      verity_import: (p) => {
        const sessionId = requireField(p, 'sessionId');
        const result = p.result ?? (p.path ? JSON.parse(fs.readFileSync(p.path, 'utf8')) : undefined);
        if (!result) throw new Error('params.result (inline JSON) or params.path (local file) is required');
        return request('POST', '/verity/import', { sessionId: Number(sessionId), label: p.label ?? p.path, result });
      },
    },
  },
  {
    name: 'webscout_dom',
    description: 'DOM read/write against the active session\'s connected tab.\n'
      + 'Actions:\n'
      + '  query {selector, full?, meta?, table?, ifChanged?, delta?, peek?, noGuard?} - outerHTML + basic attrs for the first match; outerHTML/text are truncated by default (full:true lifts that), meta:true returns only tag/id/class/matchCount; a whole-page selector (body/html/#app/#root/main/*) returns a depth-limited outline unless full:true\n'
      + '  click {selector, nth?} - dispatch a real click (native .click())\n'
      + '  fill {selector, value, nth?} - set a form field + dispatch input/change\n'
      + '  rect {selector, table?, ifChanged?, delta?, peek?, noGuard?} - getBoundingClientRect\n'
      + '  style {selector, properties?, table?, ifChanged?, delta?, peek?, noGuard?} - computed style (curated defaults, or a given array of property names)\n'
      + '  wait {selector, text?, timeoutMs?, changed?, stable?, stableCount?} - poll until selector matches (and, if text given, contains it), '
      + 'or - with changed:true - until its textContent differs from what it was at call time (use for a placeholder-swapped-'
      + 'for-a-real-result pattern, e.g. an AI-review button, instead of predicting the eventual text); stable:true waits until the match count holds for stableCount consecutive polls\n'
      + '  click_wait {selector, nth?, waitSelector?, text?, timeoutMs?, changed?, stable?, stableCount?} - click, then wait for a (possibly different) waitSelector to reach a state, in ONE round trip\n'
      + '  pick {timeoutMs?} - BLOCKS until a HUMAN clicks something in the real tab; returns a selector for it. No programmatic target.\n'
      + '  settle {selector?, quietMs?, timeoutMs?} - wait until the DOM under selector (default document.body) has had no mutations for quietMs (default 300)\n'
      + '  screenshot {selector?, outPath?} - best-effort DOM rasterization; outPath saves a PNG locally, else returns dimensions only\n'
      + 'Every action takes optional `agent` (multi-tab target name).\n'
      + 'READ SHAPING (query/rect/style here, and the read actions of react/idb/net/console): table:true returns rows as {columns, rows:[[...]]} (keys stated once); ifChanged:true answers {unchanged:true, sameAs} instead of the body when the identical read has not changed since you last received it; delta:true does that and, when it did change, returns only what changed; peek:true returns shape, size and one sample instead of the body (the full result stays cached, so the follow-up call needs no page round trip); noGuard:true overrides the token-budget guard. Use ifChanged/delta only while the earlier result is still in your context.',
    actions: {
      query: (p) => sendCmd('dom.query', { selector: requireField(p, 'selector'), full: !!p?.full, meta: !!p?.meta }, p?.agent, readOpts(p)),
      click: (p) => sendCmd('dom.click', { selector: requireField(p, 'selector'), nth: numOrUndef(p?.nth) }, p?.agent),
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
    },
  },
  {
    name: 'webscout_react',
    description: 'React fiber inspection (props/state/hooks), against the active session\'s connected tab. '
      + 'Works only on a React-managed DOM node (throws otherwise); no dependency on the React DevTools extension.\n'
      + 'Actions:\n'
      + '  inspect {selector, nth?, table?, ifChanged?, delta?, peek?, noGuard?} - props (+ state for a class component, or positional hooks for a function component) '
      + 'of the nearest enclosing component walking up from selector\n'
      + '  tree {selector, nth?, maxDepth?, table?, ifChanged?, delta?, peek?, noGuard?} - ancestor chain of enclosing component names (default maxDepth 20), for orienting '
      + 'before drilling into one level with inspect\n'
      + 'Both take optional `agent` (multi-tab target name).',
    actions: {
      inspect: (p) => sendCmd('react.inspect', { selector: requireField(p, 'selector'), nth: numOrUndef(p?.nth) }, p?.agent, readOpts(p)),
      tree: (p) => sendCmd('react.tree', { selector: requireField(p, 'selector'), nth: numOrUndef(p?.nth), maxDepth: numOrUndef(p?.maxDepth) }, p?.agent, readOpts(p)),
    },
  },
  {
    name: 'webscout_idb',
    description: 'IndexedDB read/write plus persisted snapshot/diff/restore, against the active session\'s connected tab.\n'
      + 'Actions:\n'
      + '  list {table?, ifChanged?, delta?, peek?, noGuard?} - object store names + a cheap per-store row count (store.count(), not a full dump) - check before an unscoped snapshot on a store you suspect is large\n'
      + '  dump {store, where?, fields?, limit?, table?, ifChanged?, delta?, peek?, noGuard?} - rows (+ real keyPath) in one store. where (exact-equality field map), fields (array of field names to keep) and limit filter/project IN THE PAGE - use them on any large store instead of paying for every row\n'
      + '  get {store, key, table?, ifChanged?, delta?, peek?, noGuard?} - single-key lookup (store.get), not a full-store scan - use when the store is large and you already know the key\n'
      + '  snapshot {stores?, golden?, where?, since?} - since: a baseline snapshot id - takes a fresh snapshot scoped to that baseline\'s stores and returns ONLY what changed since it (far cheaper than a full snapshot). Otherwise: capture + PERSIST a DB snapshot -> {id, counts}; golden tags it as a named regression baseline. where (exact-equality field map) scopes EVERY included store to just the matching rows - partial by construction, the saved snapshot carries `where` back on every later read (diff/restore included)\n'
      + '  diff {idA, idB} - compute + PERSIST the diff between two persisted snapshots\n'
      + '  diff_golden {name, idB} - diff a named golden snapshot (from ANY session) against snapshot idB\n'
      + '  restore {snapshotId?, golden?} - replay a persisted snapshot\'s rows back into IndexedDB (PUTs only, never deletes)\n'
      + '  put {store, row, dryRun?} - write one row, keyed by the store\'s real keyPath; response includes the full stored row. dryRun:true validates the row\'s shape (keyPath/autoIncrement) WITHOUT writing -> {valid, problems}\n'
      + '  put_many {store, rows, dryRun?} - batch write, ONE transaction; a single failed row (e.g. a unique-index conflict) is reported per-row in `failed`, not an all-or-nothing abort. dryRun validates every row\'s shape (readonly, no mutation) -> {results:[{index, valid, problems}], validCount, invalidCount}\n'
      + '  patch {store, key, patch} - shallow-merge `patch` onto the EXISTING row at `key` and write it back; errors if no row exists there (never inserts a sparse row)\n'
      + '  delete {store, key} - delete one row by key\n'
      + '  delete_many {store, keys} - delete many rows by key, one transaction; response includes deletedKeys/failedKeys '
      + '(not just counts), so a caller never has to re-dump/snapshot just to confirm which rows actually went away\n'
      + '  clear {store} - delete every row in a store\n'
      + '  wait {store, countGte?, timeoutMs?} - poll a store\'s row count until >= countGte or timeout (default 10000)\n'
      + '(No "watch" action - it\'s an indefinite streaming poll with no clean single request/response mapping; use "wait" for a bounded check.)\n'
      + 'Every action takes optional `agent` (multi-tab target name).',
    actions: {
      list: (p) => sendCmd('idb.list', {}, p?.agent, readOpts(p)),
      dump: (p) => sendCmd('idb.dump', { store: requireField(p, 'store'), where: p?.where, fields: p?.fields, limit: numOrUndef(p?.limit) }, p?.agent, readOpts(p)),
      get: (p) => sendCmd('idb.get', { store: requireField(p, 'store'), key: requireField(p, 'key') }, p?.agent, readOpts(p)),
      snapshot: (p) => (p?.since !== undefined
        ? snapshotSince({ baselineId: p.since, stores: p?.stores, golden: p?.golden, agent: p?.agent })
        : request('POST', '/state/snapshot', { agent: p?.agent, stores: p?.stores, golden: p?.golden, where: p?.where })),
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
      + '  log {limit?, urlContains?, table?, ifChanged?, delta?, peek?, noGuard?} - LIVE in-page ring buffer since last clear, capped at 500 entries, evicted by background traffic within minutes. urlContains keeps only entries whose URL contains it; limit keeps the N most recent - both filter IN THE PAGE (an unfiltered log is ~55KB)\n'
      + '  wait {urlPattern, timeoutMs?, graceMs?} - attach-and-wait for a request whose URL contains urlPattern\n'
      + '  history {sessionId?, filter?, minDuration?, sort?: "duration", limit?} - the DURABLE, already-persisted net_entries table (defaults to the active session)\n'
      + '  clear {} - clear the live ring buffer\n'
      + '  capture {filter?, off?} - ADDS filter to the armed response-BODY capture set (fetch/XHR) for requests whose URL contains it - call again with a different filter to watch a second endpoint too; log/wait/history entries then gain a bodyPreview. off:true clears every armed filter (off by default)\n'
      + 'log/wait/clear/capture take optional `agent` (multi-tab target name); history does not (it queries by sessionId, not by live agent connection).',
    actions: {
      log: (p) => sendCmd('net.log', { limit: numOrUndef(p?.limit), urlContains: p?.urlContains }, p?.agent, readOpts(p)),
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
      + '  log {limit?, table?, ifChanged?, delta?, peek?, noGuard?} - the captured entries; limit keeps the N most recent\n'
      + '  wait {substr, timeoutMs?, graceMs?} - attach-and-wait for an entry whose message contains substr, instead of a sleep+poll loop\n'
      + '  clear {}\n'
      + 'All take optional `agent` (multi-tab target name).',
    actions: {
      log: (p) => sendCmd('console.log', { limit: numOrUndef(p?.limit) }, p?.agent, readOpts(p)),
      wait: (p) => sendCmd('console.wait', { substr: requireField(p, 'substr'), timeoutMs: numOrUndef(p?.timeoutMs), graceMs: numOrUndef(p?.graceMs) }, p?.agent),
      clear: (p) => sendCmd('console.clear', {}, p?.agent),
    },
  },
  {
    name: 'webscout_page',
    description: 'Whole-page operations.\n'
      + 'Actions:\n'
      + '  reload {hard?, waitReconnect?, timeoutMs?} - location.reload(); hard also unregisters every Service Worker '
      + 'and clears Cache Storage first (use for a stale-while-revalidate SW after editing a file). Both reply BEFORE '
      + 'the real navigation fires - waitReconnect:true blocks until the agent is seen to disconnect then reconnect '
      + '(default timeout 15000ms) instead of the caller guessing a sleep and retrying on "no agent connected"\n'
      + '  fresh {localPath, urlPath?} - fetches localPath THROUGH THE PAGE (its real cache/SW stack) and compares its hash to the on-disk file - "is the tab actually running what\'s on disk"\n'
      + 'Both take optional `agent` (multi-tab target name).',
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
    description: 'Named, replayable sequences of a session\'s own recorded actions.\n'
      + 'Actions:\n'
      + '  record {name, sessionId, all?} - save that session\'s own replayable actions (dom.click/fill/wait, idb.put/delete/deleteMany/clear/wait, page.reload, eval) as a macro\n'
      + '  list {} - id, name, step count, source session for every saved macro\n'
      + '  show {id} - full macro detail, including every step\n'
      + '  run {id, continueOnError?, fromStep?, confirm?, full?} - full:true returns every step\'s complete result instead of the compact summary. Replay against the CURRENTLY active session; refused (409) if that session\'s goal looks unrelated to the macro\'s own recorded-from session (a cross-context replay guard) unless confirm:true\n'
      + '  delete {id}\n'
      + '  export_verity {id, outPath?} - best-effort skeleton Verity scenario JSON from a macro\'s dom.click/dom.wait steps (selectors left as TODO)',
    actions: {
      record: (p) => request('POST', '/macros', { name: requireField(p, 'name'), sessionId: Number(requireField(p, 'sessionId')), all: !!p.all }),
      list: () => request('GET', '/macros'),
      show: (p) => request('GET', `/macros/${requireField(p, 'id')}`),
      run: (p) => request('POST', `/macros/${requireField(p, 'id')}/run`, {
        continueOnError: !!p.continueOnError, confirm: !!p.confirm, full: !!p.full, fromStep: p.fromStep !== undefined ? Number(p.fromStep) : undefined,
      }),
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
  return request('POST', '/command', { type, params, agent, opts });
}

function toolInputSchema(tool) {
  return {
    type: 'object',
    properties: {
      action: { type: 'string', enum: Object.keys(tool.actions), description: 'see the tool description for each action\'s exact params' },
      params: { type: 'object', description: 'action-specific fields - see the tool description', additionalProperties: true },
    },
    required: ['action'],
    additionalProperties: false,
  };
}

function listToolDescriptors() {
  const grouped = TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: toolInputSchema(t) }));
  return [...grouped, { name: EVAL_TOOL.name, description: EVAL_TOOL.description, inputSchema: EVAL_TOOL.inputSchema }];
}

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
    capabilities: { tools: {} },
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
    sendResult(msg.id, { content: [{ type: 'text', text: err.message }, ...(err.notes ?? []).map((n) => ({ type: 'text', text: `[web-scout] ${n}` }))], isError: true });
  }
}

async function handleMessage(msg) {
  if (msg.method === 'initialize') { handleInitialize(msg); return; }
  if (msg.method === 'notifications/initialized') return; // no response for a notification
  if (msg.method === 'tools/list') { handleToolsList(msg); return; }
  if (msg.method === 'tools/call') { await handleToolsCall(msg); return; }
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

logErr(`${SERVER_NAME} MCP server ${SERVER_VERSION} ready (stdio) - relay expected at ${BASE}`);
