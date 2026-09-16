#!/usr/bin/env node
// Web-scout CLI - thin wrapper Claude Code (or an operator) invokes via
// Bash. Talks to the relay's local HTTP endpoint (tools/web-scout/relay.mjs,
// must already be running - `node tools/web-scout/relay.mjs`), which
// forwards commands over an already-open WebSocket to the in-page agent(s)
// (tools/web-scout/inject.js), and persists sessions/actions/snapshots/
// diffs/console/net/Q&A to tools/web-scout/webscout.db. See
// tools/web-scout/README.md for the full command list, security model, and
// non-goals.

import fs from 'node:fs';
import http from 'node:http';
import { request, BASE, netHistory, pageFresh, buildVerityScenarioStub, runSuite } from './client.mjs';

// Set once near the top of main() from a `--agent <name>` flag found
// anywhere in the subcommand's own arguments; every dom/idb(snapshot)/eval
// dispatch below includes it as a top-level `agent` field on the request
// body (never nested inside `params`) - see tools/web-scout/relay.mjs.
let agentFlag;

function send(type, params) {
  return request('POST', '/command', { type, params, agent: agentFlag });
}

function printResult(result) {
  console.log(JSON.stringify(result, null, 2));
}

// Extracts `--name <value>` anywhere in `args`, returning the remaining
// args and the value (undefined if the flag wasn't present).
function extractFlag(args, name) {
  const idx = args.indexOf(name);
  if (idx === -1) return { args, value: undefined };
  return { args: [...args.slice(0, idx), ...args.slice(idx + 2)], value: args[idx + 1] };
}

// Extracts a boolean `--name` flag (no value) anywhere in `args`.
function extractBooleanFlag(args, name) {
  const idx = args.indexOf(name);
  if (idx === -1) return { args, value: false };
  return { args: [...args.slice(0, idx), ...args.slice(idx + 1)], value: true };
}

function usage() {
  console.log(`Usage: node tools/web-scout/cli.mjs <command> [args...]

  status                          relay health, connected agents, and active session
  session start "<goal>" ["<context>"] [--strict-crv] [--tags a,b,c] [--agent <name>]
                                   declare context/goal - REQUIRED before any action.
                                   --strict-crv auto-snapshots+diffs before/after every
                                   dom.click/dom.fill/eval/idb.put/idb.delete in this session.
                                   Best-effort: if js/db.js is readable and a tab is already
                                   connected, warns (does not block) when the tab's LIVE
                                   IndexedDB version != js/db.js's own DB_VERSION - the tab
                                   has not re-opened the DB since a migration bump.
  session assert <id> '<checks-json>' [--agent <name>]
                                   declarative regression checks against LIVE state - a single
                                   check object or a JSON array of them, each:
                                   {"store":"x","where":{"id":3},"count":1,"field":"status","equals":"Y"}
                                   (where/count/countGte/countLte/field+equals all optional,
                                   at least one of count/countGte/countLte/field required).
                                   Dispatches one idb.dump per distinct store, cached - logged
                                   as its own 'session.assert' action. Replaces re-typing the
                                   same idb.dump-and-eyeball checks by hand every later phase.
                                   Exits 1 (not 0) if any check fails - scriptable/CI-safe.
  session end [id]                 end the given session, or the active one if omitted
  session current                  show the active session (if any)
  session list                     list every session, newest first
  session show <id>                session detail + actions + snapshots + diffs + qa
  session report <id> [--format md|json] [--out <path>] [--verity <result.json>]
                                   export a session as a Markdown/JSON report -
                                   printed to stdout, or written to --out. --verity
                                   imports that Verity scenario-result file into the
                                   session first, so it appears in the report's own
                                   "Verity UI checks" section (see "verity import" below)
  session cleanup <id> [--confirm]
                                   list (or, with --confirm, delete) every row this session's
                                   own idb.put/idb.delete/idb.deleteMany/idb.clear actions left
                                   live - dry-run by default. BLIND to writes made via eval or
                                   via a real UI button click (most CRV writes are this shape) -
                                   the response flags how many eval actions looked like writes,
                                   but UI-driven writes get no signal at all here. Prefer
                                   --since-snapshot for those.
  session cleanup <id> --since-snapshot <snapshotId> [--confirm]
                                   catches EVERY new row added to ANY store since that
                                   snapshot - however it was written (button click, eval,
                                   idb.put, doesn't matter) - by re-snapshotting the same
                                   stores and diffing. Rows merely CHANGED (not added) since
                                   the baseline are listed but never auto-deleted. Dry-run by
                                   default; needs a real, still-persisted snapshot id ('idb
                                   snapshot --stores ...' before you start mutating).

  dom query <selector>            outerHTML + basic attrs for the first match
                                   (dom.click/dom.fill/dom.wait: a FAILURE auto-captures a
                                   dom.screenshot of the target selector as its own separate
                                   logged action - the broken state is often gone by the time
                                   a human goes looking for it by hand)
  dom click <selector> [--nth N]  dispatch a real click - errors (with a preview of every
                                   match) if the selector is ambiguous; pass --nth to pick one
  dom fill <selector> <value> [--nth N]   set a form field's value + dispatch input/change
  dom rect <selector>             bounding box (getBoundingClientRect)
  dom style <selector> [prop,prop,...]   computed style (curated defaults, or a given list)
  dom wait <selector> [--text <substr>] [--timeout <ms>]
                                   poll until the selector matches (and, if given, its text
                                   contains <substr>) or timeout (default 10000ms) elapses
  dom pick [--timeout <ms>]       arm a one-time click listener and BLOCK until a HUMAN clicks
                                   something in the real browser tab - not a programmatic
                                   selector finder, there is no way to feed it a target
                                   yourself. Returns a robust, scoped, already-unique selector
                                   for whatever was clicked; the click never reaches the app
                                   (preventDefault'd). Use this BEFORE writing a dom.click/
                                   dom.fill selector by hand, with a human actually there to
                                   click - if no human is available, use dom.query + eyeball
                                   the outerHTML to hand-write a selector instead.
  dom settle [selector] [--quiet-ms <ms>] [--timeout <ms>]
                                   waits until the DOM under selector (default: document.body)
                                   has had NO mutations for --quiet-ms (default 300) - use after
                                   a click/rebuild and before the next dom.query/dom.click
                                   instead of a guessed sleep (guessing wrong returns stale,
                                   pre-rebuild content indistinguishable from a real bug).
  dom screenshot [selector] [--out <path>]
                                   best-effort DOM rasterization (SVG foreignObject technique,
                                   zero deps - no CDP/puppeteer available, this is a normal page
                                   script). Cross-origin images/fonts/iframes may not render.
                                   Whole page if selector omitted. --out saves a PNG file;
                                   without it, prints dimensions only (the data URL is large).

  idb list                        list IndexedDB object store names
  idb dump <store>                dump every row (+ real keyPath) in one store
  idb snapshot [--stores a,b,c] [--golden <name>]
                                   capture + PERSIST a DB snapshot -> { id, counts } -
                                   scope to specific stores to avoid the full-DB timeout.
                                   --golden tags it as a named regression baseline, diffable
                                   from ANY future session via "idb diff-golden" (re-tagging
                                   the same name just makes the latest one win - no delete
                                   needed to re-baseline).
  idb diff <idA> <idB>            compute + PERSIST the diff between two persisted snapshots
  idb diff-golden <name> <idB>    diff a named golden snapshot (from any session) against
                                   snapshot <idB> - "did this later phase touch anything
                                   <name> already proved untouched", without hunting down
                                   an old snapshot id by hand
  idb restore <snapshotId>        replay a persisted snapshot's rows back into IndexedDB via
  idb restore --golden <name>     one idb.put per row per store - resets LIVE state to a known-
                                   good point instead of only detecting drift from it (which is
                                   all idb diff/diff-golden do). Only PUTS - never deletes rows
                                   added since the snapshot; run idb clear first per store if you
                                   need an exact replace, not a merge. Every put is individually
                                   logged (via: "restore"), so a partial failure still shows
                                   exactly which rows did/didn't make it back.
  idb put <store> <json-row>      write one row (validated against the store's real keyPath) -
                                   response includes the full stored row (key merged in), not
                                   just the key, so a caller never has to assume/re-dump to
                                   learn what autoIncrement actually assigned
  idb delete <store> <json-key>   delete one row by key
  idb delete-many <store> <json-array-of-keys>   delete many rows by key, one transaction
  idb clear <store>                delete every row in a store
  idb wait <store> --count-gte <n> [--timeout <ms>]
                                   poll a store's row count until >= n or timeout (default 10000ms)
  idb watch <store> [--count-gte <n>] [--timeout <ms>]
                                   live: re-checks the store's row count whenever the relay's SSE
                                   feed signals ANY change (push-triggered, not interval-polled),
                                   printing a line per change. Stops at --count-gte (if given) or
                                   --timeout (default 30000ms), whichever first, or Ctrl+C.

  net log                         captured fetch/XHR request/response entries since last clear -
                                   LIVE in-page ring buffer, capped at 500, evicted by background
                                   traffic (e.g. sync polling) within minutes in a busy session.
                                   Use "net history" for the durable equivalent.
  net wait <url-substring> [--timeout <ms>] [--grace <ms>]
                                   attach-and-wait for a request whose URL contains the given
                                   substring, instead of a blind sleep+"net log"-poll loop.
                                   Resolves on the first matching entry finished within --grace
                                   ms (default 3000, covers the normal click-then-wait race) of
                                   this call, or finishing while it's outstanding (--timeout,
                                   default 15000ms).
  net history [--filter <substr>] [--min-duration <ms>] [--sort duration] [--limit <n>] [--session <id>]
                                   queries the DURABLE, already-persisted net_entries table
                                   (survives past 500 entries / a page reload) instead of the
                                   live ring buffer above - defaults to the active session.
                                   Every entry already carries started_at/ended_at, so
                                   --min-duration/--sort duration work with no schema change.
  net clear                       clear the captured (live) network log

  console log                     captured console.error/warn + uncaught error entries
  console clear                   clear the captured console log

  page reload                     true location.reload() - re-activates + reconnects
                                   automatically (activation flag survives via localStorage/URL).
                                   Prefer this over re-invoking a page module's init function via
                                   eval - repeated init re-calls can stack duplicate document-level
                                   event listeners and cause duplicate writes.
  page reload --hard              location.reload() PLUS unregisters every Service Worker and
                                   clears every Cache Storage entry first. Use this - not plain
                                   reload - whenever the app has a SW (this one does, sw.js) and
                                   you just edited a file: a stale-while-revalidate SW can keep
                                   serving OLD cached bytes across several plain reloads while
                                   silently refreshing its cache in the background, making a real
                                   fix look like it "didn't take" for no visible reason.
  page fresh <local-file-path> [--url </served/path>]
                                   fetches that path THROUGH THE PAGE (its real cache/SW stack,
                                   not a plain disk read) and hashes it, then hashes the same
                                   file on disk, and reports fresh:true/false - answers "is the
                                   tab actually running what's on disk" in one call, instead of
                                   the fetch-and-grep-for-a-marker-string dance this used to take.
                                   --url defaults to "/" + the local path as given.

  eval <expr> [--timeout <ms>]    evaluate raw JS in the page (escape hatch - see README
  eval --file <path> [--timeout <ms>]
                                   non-goals). Tries expr as a single EXPRESSION first; if that's
                                   a SyntaxError (e.g. multiple ;-separated statements), retries
                                   it as a function BODY instead (statements, with an explicit
                                   'return' if you want a value back) - no need to hand-wrap in
                                   an IIFE for a multi-statement snippet anymore. If the fallback
                                   ran and the result came back undefined with no 'return' in
                                   expr, the response includes a {"__note": ...} explaining that
                                   ambiguity instead of a bare, easy-to-misread undefined. --file
                                   reads expr from a local file instead of the shell arg string -
                                   use it for any multi-line payload; shell-quoting one inline
                                   (nested quotes, heredoc-to-var, "unexpected EOF") is the
                                   single biggest time-sink a real session hit with this command.
                                   Races a page-side timeout (default 10000ms) - if expr contains
                                   an unresolved 'await', you get a diagnostic message instead of
                                   a generic relay timeout. Cannot interrupt a SYNCHRONOUS
                                   infinite loop (JS is single-threaded) - that freezes the tab;
                                   reload it. A non-JSON-safe result (DOM element, Map, circular,
                                   ...) comes back as {"__unserializable": true, ...} instead of a
                                   silently lossy string.

  macro record "<name>" <sessionId> [--all]
                                   save that session's own replayable actions (dom.click/fill/
                                   wait, idb.put/delete/deleteMany/clear/wait, page.reload, eval)
                                   as a named macro. --all also includes read-only actions.
  macro list                      list saved macros (id, name, step count, source session)
  macro show <id>                 full macro detail, including every step
  macro run <id> [--continue-on-error] [--from-step N] [--confirm]
                                   replay a macro's steps against the CURRENTLY active session -
                                   start one first. Stops at the first failing step unless
                                   --continue-on-error. --from-step (0-based) skips earlier steps,
                                   to resume after fixing whatever made an earlier step fail.
                                   Refused (409) if the target session's goal looks unrelated to
                                   the macro's own recorded-from session's goal - a cross-context
                                   replay guard, since a macro can mutate real data. --confirm
                                   overrides it once you've checked "macro show <id>" is right.
  macro delete <id>               delete a saved macro
  macro export-verity <id> [--out <path>]
                                   best-effort skeleton Verity scenario JSON from a
                                   macro's dom.click/dom.wait steps (selectors left as
                                   TODO - Verity's UIA selector model has no reliable
                                   mapping from a CSS selector). dom.fill/idb.*/eval/
                                   page.reload steps have no Verity equivalent and are
                                   skipped, listed in the output.

  suite run <path-to-suite.json> [--continue-on-error]
                                   run a named, repeatable checklist bundling macro/assert/
                                   diff-golden steps into ONE pass/fail summary, instead of
                                   several manual calls re-typed by hand every phase. Suite
                                   file is a plain JSON array, each step one of:
                                   {"type":"macro","id":N}
                                   {"type":"assert","checks":{...}|[...]}
                                   {"type":"diff-golden","name":"<golden>","idB":N,"expectClean":false}
                                   (diff-golden defaults to expecting a CLEAN diff - i.e. proving
                                   nothing changed - pass "expectClean":false if drift is the
                                   expected/desired outcome for that step). Stops at the first
                                   failing step unless --continue-on-error. Exits 1 if any step,
                                   or the whole suite, didn't pass - CI-safe.

  verity import <sessionId> <path-to-scenario-result.json> [--label <text>]
                                   fold a saved tools/ui-verifier "-Command scenario"
                                   result into that session's own evidence trail (shows
                                   up in the dashboard timeline + session report) -
                                   Verity itself persists nothing on its own.

  search "<query>"                cross-session search over every session's own action log
                                   (type/params/result/error) - which session/action touched X

  analytics                       "Friction Analytics" - recurring failure patterns across
                                   EVERY session: failure rate by action type, selectors that
                                   failed more than once, macros never run or never succeeding,
                                   Verity labels whose latest import is still FAIL. Run this
                                   before starting new work, not only after hitting a wall.

  ask [--session <id>] "<question>"   ask the AI backend about the (current, or given) session's
                                       recorded actions/snapshots/diffs - persisted to the session's Q&A log

  agents                          list currently connected agent (tab) names
  dashboard                       print the dashboard URL (open it in a browser)

Global flag (any dom/idb/eval subcommand, anywhere in its own arguments):
  --agent <name>                  target a specific tab (see ?webscout_name= in the README) -
                                   omit to use the default single-tab agent.

Every dom/idb/net/eval action requires an active session - start one first.
In a --strict-crv session, /command's response shape becomes
{ data: <actual result>, crv: { before_snapshot_id, after_snapshot_id, diff_id, diff_summary } }
instead of the flat result - printed as-is either way.
Requires tools/web-scout/relay.mjs already running, and the target page
loaded with the activation flag (?webscout=1 or localStorage.webscout_enabled=1).`);
}

// Best-effort startup health check: compares the LIVE connected tab's real
// IndexedDB version (db.version handler in inject.js) against js/db.js's
// own DB_VERSION constant on disk. A mismatch means the tab has not
// re-opened the DB since a migration bump landed in source - a whole CRV
// pass run against that stale schema previously wasted real time before
// anyone noticed why a "new" store looked missing. Never fatal: no
// js/db.js at this relative path, no agent connected yet, or any other
// read/parse failure is swallowed silently - this is a warning, not a gate.
async function warnOnDbVersionDrift() {
  try {
    const src = fs.readFileSync('js/db.js', 'utf8');
    const match = src.match(/DB_VERSION\s*=\s*(\d+)/);
    if (!match) return;
    const sourceVersion = Number(match[1]);
    const live = await send('db.version', {});
    if (live.version !== sourceVersion) {
      console.error(`WARNING: live IndexedDB version (${live.version}) != js/db.js DB_VERSION (${sourceVersion}) - the connected tab has not re-opened the DB since a migration bump. Run "page reload" (or "page reload --hard") before trusting any new-store check.`);
    }
  } catch { /* best-effort - no js/db.js here, no agent connected, etc. */ }
}

async function handleSession(sub, rawArgs) {
  if (sub === 'start') {
    let args = rawArgs;
    let tagsValue;
    let strictCrv;
    ({ args, value: tagsValue } = extractFlag(args, '--tags'));
    ({ args, value: strictCrv } = extractBooleanFlag(args, '--strict-crv'));
    ({ args, value: agentFlag } = extractFlag(args, '--agent'));
    const tags = tagsValue ? tagsValue.split(',').map((t) => t.trim()).filter(Boolean) : [];
    printResult(await request('POST', '/sessions', { goal: args[0], context: args[1], strict_crv: strictCrv, tags }));
    await warnOnDbVersionDrift();
    return;
  }
  if (sub === 'end') {
    let id = rawArgs[0];
    if (!id) {
      const health = await request('GET', '/health');
      if (!health.active_session) throw new Error('no active session to end');
      id = health.active_session.id;
    }
    printResult(await request('POST', `/sessions/${id}/end`));
    return;
  }
  if (sub === 'current') {
    const health = await request('GET', '/health');
    printResult(health.active_session ?? { active: false });
    return;
  }
  if (sub === 'list') {
    printResult(await request('GET', '/sessions'));
    return;
  }
  if (sub === 'show') {
    const id = rawArgs[0];
    if (!id) throw new Error('session show requires an id');
    const [session, actions, snapshots, diffs, qa, consoleEntries, net] = await Promise.all([
      request('GET', `/sessions/${id}`),
      request('GET', `/sessions/${id}/actions?full=1`),
      request('GET', `/sessions/${id}/snapshots`),
      request('GET', `/sessions/${id}/diffs`),
      request('GET', `/sessions/${id}/qa`),
      request('GET', `/sessions/${id}/console`),
      request('GET', `/sessions/${id}/net`),
    ]);
    printResult({ session, actions, snapshots, diffs, qa, console: consoleEntries, net });
    return;
  }
  if (sub === 'report') {
    let args = rawArgs;
    let format;
    let out;
    let verityPath;
    ({ args, value: format } = extractFlag(args, '--format'));
    ({ args, value: out } = extractFlag(args, '--out'));
    ({ args, value: verityPath } = extractFlag(args, '--verity'));
    const id = args[0];
    if (!id) throw new Error('session report requires an id');
    if (verityPath) {
      // Folds a Verity scenario-result JSON file straight into this
      // session's evidence trail before exporting - see "verity import"
      // below for the standalone form (same underlying POST).
      const result = JSON.parse(fs.readFileSync(verityPath, 'utf8'));
      await request('POST', '/verity/import', { sessionId: Number(id), label: verityPath, result });
    }
    const { content } = await request('GET', `/sessions/${id}/report?format=${format === 'json' ? 'json' : 'md'}`);
    if (out) {
      fs.writeFileSync(out, content, 'utf8');
      console.log(`wrote ${out}`);
    } else {
      console.log(content);
    }
    return;
  }
  if (sub === 'cleanup') {
    let args = rawArgs;
    let confirm;
    let sinceSnapshotId;
    ({ args, value: confirm } = extractBooleanFlag(args, '--confirm'));
    ({ args, value: sinceSnapshotId } = extractFlag(args, '--since-snapshot'));
    const id = args[0];
    if (!id) throw new Error('session cleanup requires an id');
    printResult(await request('POST', `/sessions/${id}/cleanup`, { confirm, sinceSnapshotId: sinceSnapshotId !== undefined ? Number(sinceSnapshotId) : undefined }));
    return;
  }
  if (sub === 'assert') {
    let args = rawArgs;
    ({ args, value: agentFlag } = extractFlag(args, '--agent'));
    const [id, checksJson] = args;
    if (!id || !checksJson) throw new Error('session assert requires <id> \'<checks-json>\' - a single check object or an array of them');
    let checks = JSON.parse(checksJson);
    if (!Array.isArray(checks)) checks = [checks];
    const result = await request('POST', `/sessions/${id}/assert`, { checks, agent: agentFlag });
    printResult(result);
    // A regression check that silently exits 0 on failure is not a
    // regression check a script/CI step can trust - confirmed gap: this
    // previously always exited 0 even with passed:false, so a caller had
    // to parse stdout itself to notice a failure.
    if (!result.passed) process.exitCode = 1;
    return;
  }
  throw new Error(`unknown 'session ${sub || ''}'`);
}

async function handleMacro(sub, rawArgs) {
  if (sub === 'record') {
    let args = rawArgs;
    let all;
    ({ args, value: all } = extractBooleanFlag(args, '--all'));
    const [name, sessionId] = args;
    if (!name || !sessionId) throw new Error('macro record requires "<name>" <sessionId>');
    printResult(await request('POST', '/macros', { name, sessionId: Number(sessionId), all }));
    return;
  }
  if (sub === 'list') {
    printResult(await request('GET', '/macros'));
    return;
  }
  if (sub === 'show') {
    const id = rawArgs[0];
    if (!id) throw new Error('macro show requires an id');
    printResult(await request('GET', `/macros/${id}`));
    return;
  }
  if (sub === 'run') {
    let args = rawArgs;
    let continueOnError;
    let fromStep;
    let confirm;
    ({ args, value: continueOnError } = extractBooleanFlag(args, '--continue-on-error'));
    ({ args, value: fromStep } = extractFlag(args, '--from-step'));
    ({ args, value: confirm } = extractBooleanFlag(args, '--confirm'));
    const id = args[0];
    if (!id) throw new Error('macro run requires an id');
    const result = await request('POST', `/macros/${id}/run`, { continueOnError, confirm, fromStep: fromStep !== undefined ? Number(fromStep) : undefined });
    printResult(result);
    // Same exit-code gap as session assert: the relay's own route never
    // throws on a failing step (only on the cross-context guard), so a
    // partial/failed replay used to print results and still exit 0.
    if (result.results.some((r) => !r.ok)) process.exitCode = 1;
    return;
  }
  if (sub === 'delete') {
    const id = rawArgs[0];
    if (!id) throw new Error('macro delete requires an id');
    printResult(await request('DELETE', `/macros/${id}`));
    return;
  }
  if (sub === 'export-verity') {
    let args = rawArgs;
    let outPath;
    ({ args, value: outPath } = extractFlag(args, '--out'));
    const id = args[0];
    if (!id) throw new Error('macro export-verity requires an id');
    const macro = await request('GET', `/macros/${id}`);
    const { scenario, skipped } = buildVerityScenarioStub(macro);
    const text = JSON.stringify(scenario, null, 2);
    if (outPath) {
      fs.writeFileSync(outPath, text, 'utf8');
      console.log(`wrote ${outPath} (${scenario.steps.length} step(s); ${skipped.length} skipped - see "_skipped_steps" note below)`);
    } else {
      console.log(text);
    }
    if (skipped.length) console.error(`Skipped ${skipped.length} step(s) with no Verity equivalent: ${skipped.join(', ')}`);
    return;
  }
  throw new Error(`unknown 'macro ${sub || ''}'`);
}

// A suite is a plain JSON file (no relay-side storage - unlike a macro,
// there's no replayable "actions a session already logged" to draw from
// here, it's an ordered checklist the caller writes by hand once) listing
// steps of 3 shapes:
//   {"type": "macro", "id": N, "continueOnError"?, "confirm"?, "fromStep"?}
//   {"type": "assert", "checks": {...} | [...]}
//   {"type": "diff-golden", "name": "<golden>", "idB": N, "expectClean"?: false}
// Bundles what today takes several manual CLI calls (run a macro, assert
// state, diff-golden to prove nothing else moved) into one named,
// repeatable sequence with ONE pass/fail summary - the CI-shaped wrapper
// around already-existing primitives, not a new execution engine.
async function handleSuite(sub, rawArgs) {
  if (sub === 'run') {
    let args = rawArgs;
    let continueOnError;
    ({ args, value: continueOnError } = extractBooleanFlag(args, '--continue-on-error'));
    const suitePath = args[0];
    if (!suitePath) throw new Error('suite run requires a path to a suite JSON file');
    const steps = JSON.parse(fs.readFileSync(suitePath, 'utf8'));
    const result = await runSuite(steps, { continueOnError });
    printResult(result);
    if (!result.passed) process.exitCode = 1;
    return;
  }
  throw new Error(`unknown 'suite ${sub || ''}'`);
}

// Manually parses the relay's SSE feed (GET /events) over a plain
// node:http request - re-checks `store`'s row count on every "something
// changed" push instead of polling on a fixed interval. Resolves once
// --count-gte is reached, --timeout elapses, or the process is
// interrupted (Ctrl+C, handled by the caller destroying the request).
function watchIdbStore(store, countGte, timeoutMs) {
  const limit = Number(timeoutMs) || 30000;
  const start = Date.now();
  let lastCount = null;
  return new Promise((resolve, reject) => {
    let settled = false;
    const req = http.get(`${BASE}/events`, (res) => {
      let buf = '';
      const check = async () => {
        try {
          const dump = await send('idb.dump', { store });
          if (dump.count !== lastCount) {
            console.log(JSON.stringify({ at: new Date().toISOString(), store, count: dump.count, delta: lastCount === null ? null : dump.count - lastCount }));
            lastCount = dump.count;
            if (countGte !== undefined && dump.count >= Number(countGte)) finish();
          }
        } catch (err) {
          console.error('watch check failed:', err.message);
        }
      };
      check();
      res.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          buf = buf.slice(idx + 2);
          check();
        }
      });
      res.on('error', (err) => { if (!settled) { settled = true; clearTimeout(timer); reject(err); } });
    });
    req.on('error', (err) => { if (!settled) { settled = true; clearTimeout(timer); reject(err); } });
    const timer = setTimeout(finish, limit);
    function finish() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      resolve({ finalCount: lastCount, watchedMs: Date.now() - start });
    }
  });
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === '-h' || command === '--help') {
    usage();
    process.exitCode = command ? 0 : 1;
    return;
  }

  if (command === 'status') {
    printResult(await request('GET', '/health'));
    return;
  }

  if (command === 'agents') {
    printResult(await request('GET', '/agents'));
    return;
  }

  if (command === 'session') {
    await handleSession(rest[0], rest.slice(1));
    return;
  }

  if (command === 'macro') {
    await handleMacro(rest[0], rest.slice(1));
    return;
  }

  if (command === 'suite') {
    await handleSuite(rest[0], rest.slice(1));
    return;
  }

  if (command === 'analytics') {
    printResult(await request('GET', '/analytics'));
    return;
  }

  if (command === 'search') {
    const q = rest.join(' ');
    if (!q) throw new Error('search requires a query, e.g. search "cfi_ontology_candidates"');
    printResult(await request('GET', `/search?q=${encodeURIComponent(q)}`));
    return;
  }

  if (command === 'verity' && rest[0] === 'import') {
    let args = rest.slice(1);
    let label;
    ({ args, value: label } = extractFlag(args, '--label'));
    const [sessionId, path] = args;
    if (!sessionId || !path) throw new Error('verity import requires <sessionId> <path-to-scenario-result.json>');
    const result = JSON.parse(fs.readFileSync(path, 'utf8'));
    printResult(await request('POST', '/verity/import', { sessionId: Number(sessionId), label: label ?? path, result }));
    return;
  }

  if (command === 'dashboard') {
    console.log(`${BASE}/dashboard`);
    return;
  }

  let args = rest;
  ({ args, value: agentFlag } = extractFlag(args, '--agent'));
  let nthValue;
  let textValue;
  let timeoutValue;
  let countGteValue;
  let storesValue;
  let goldenValue;
  let quietValue;
  let graceValue;
  let fileValue;
  let filterValue;
  let minDurationValue;
  let sortValue;
  let limitValue;
  let sessionValue;
  ({ args, value: nthValue } = extractFlag(args, '--nth'));
  ({ args, value: textValue } = extractFlag(args, '--text'));
  ({ args, value: timeoutValue } = extractFlag(args, '--timeout'));
  ({ args, value: countGteValue } = extractFlag(args, '--count-gte'));
  ({ args, value: storesValue } = extractFlag(args, '--stores'));
  ({ args, value: goldenValue } = extractFlag(args, '--golden'));
  ({ args, value: quietValue } = extractFlag(args, '--quiet-ms'));
  ({ args, value: graceValue } = extractFlag(args, '--grace'));
  ({ args, value: fileValue } = extractFlag(args, '--file'));
  ({ args, value: filterValue } = extractFlag(args, '--filter'));
  ({ args, value: minDurationValue } = extractFlag(args, '--min-duration'));
  ({ args, value: sortValue } = extractFlag(args, '--sort'));
  ({ args, value: limitValue } = extractFlag(args, '--limit'));
  ({ args, value: sessionValue } = extractFlag(args, '--session'));

  if (command === 'page' && args[0] === 'reload') {
    let a = args.slice(1);
    let hard;
    ({ args: a, value: hard } = extractBooleanFlag(a, '--hard'));
    printResult(await send(hard ? 'page.hardReload' : 'page.reload', {}));
    return;
  }

  if (command === 'page' && args[0] === 'fresh') {
    let a = args.slice(1);
    let urlPath;
    ({ args: a, value: urlPath } = extractFlag(a, '--url'));
    const localPath = a[0];
    if (!localPath) throw new Error('page fresh requires a local file path, e.g. js/capital-flow.js');
    printResult(await pageFresh({ localPath, urlPath, agent: agentFlag }));
    return;
  }

  if (command === 'dom' && args[0] === 'screenshot') {
    let a = args.slice(1);
    let outPath;
    ({ args: a, value: outPath } = extractFlag(a, '--out'));
    const result = await send('dom.screenshot', { selector: a[0] });
    if (outPath) {
      const base64 = result.dataUrl.split(',')[1] ?? '';
      fs.writeFileSync(outPath, Buffer.from(base64, 'base64'));
      console.log(`wrote ${outPath} (${result.width}x${result.height})`);
    } else {
      printResult({ width: result.width, height: result.height, dataUrlLength: result.dataUrl.length, note: 'pass --out <path> to save as a PNG file' });
    }
    return;
  }

  if (command === 'eval') {
    // --file <path> reads the expression/statement body from disk instead
    // of the CLI arg string - shell quoting a multi-line JS payload (nested
    // quotes, heredoc-to-var, "unexpected EOF" on any embedded newline) was
    // the single biggest time-sink in a real session; writing the script to
    // a file and passing --file sidesteps shell quoting entirely.
    const expr = fileValue ? fs.readFileSync(fileValue, 'utf8') : args.join(' ');
    printResult(await send('eval', { expr, timeoutMs: timeoutValue !== undefined ? Number(timeoutValue) : undefined }));
    return;
  }

  if (command === 'ask') {
    let a = args;
    let sessionId;
    if (a[0] === '--session') {
      sessionId = a[1];
      a = a.slice(2);
    }
    const question = a.join(' ');
    if (!question) throw new Error('ask requires a question');
    printResult(await request('POST', '/ask', { session_id: sessionId ?? undefined, question }));
    return;
  }

  const sub = args[0];
  const subArgs = args.slice(1);

  const table = {
    dom: {
      query: () => send('dom.query', { selector: subArgs[0] }),
      click: () => send('dom.click', { selector: subArgs[0], nth: nthValue !== undefined ? Number(nthValue) : undefined }),
      fill: () => send('dom.fill', { selector: subArgs[0], value: subArgs[1], nth: nthValue !== undefined ? Number(nthValue) : undefined }),
      rect: () => send('dom.rect', { selector: subArgs[0] }),
      style: () => send('dom.computedStyle', { selector: subArgs[0], properties: subArgs[1] ? subArgs[1].split(',').map((s) => s.trim()) : undefined }),
      wait: () => send('dom.wait', { selector: subArgs[0], text: textValue, timeoutMs: timeoutValue !== undefined ? Number(timeoutValue) : undefined }),
      pick: () => send('dom.pick', { timeoutMs: timeoutValue !== undefined ? Number(timeoutValue) : undefined }),
      // Generic "wait until quiet" - pass a selector to scope it (default:
      // document.body). Use after a click/rebuild and before the next
      // dom.query/dom.click instead of a guessed sleep.
      settle: () => send('dom.settle', { selector: subArgs[0], quietMs: quietValue !== undefined ? Number(quietValue) : undefined, timeoutMs: timeoutValue !== undefined ? Number(timeoutValue) : undefined }),
    },
    idb: {
      list: () => send('idb.list', {}),
      dump: () => send('idb.dump', { store: subArgs[0] }),
      snapshot: () => request('POST', '/state/snapshot', { agent: agentFlag, stores: storesValue ? storesValue.split(',').map((s) => s.trim()) : undefined, golden: goldenValue }),
      diff: () => request('POST', '/state/diff', { idA: Number(subArgs[0]), idB: Number(subArgs[1]) }),
      'diff-golden': () => request('POST', '/state/diff', { golden: subArgs[0], idB: Number(subArgs[1]) }),
      restore: () => request('POST', '/state/restore', { agent: agentFlag, snapshotId: subArgs[0] ? Number(subArgs[0]) : undefined, golden: goldenValue }),
      put: () => send('idb.put', { store: subArgs[0], row: JSON.parse(subArgs[1]) }),
      delete: () => send('idb.delete', { store: subArgs[0], key: JSON.parse(subArgs[1]) }),
      'delete-many': () => send('idb.deleteMany', { store: subArgs[0], keys: JSON.parse(subArgs[1]) }),
      clear: () => send('idb.clear', { store: subArgs[0] }),
      wait: () => send('idb.wait', { store: subArgs[0], countGte: countGteValue !== undefined ? Number(countGteValue) : undefined, timeoutMs: timeoutValue !== undefined ? Number(timeoutValue) : undefined }),
      watch: () => watchIdbStore(subArgs[0], countGteValue, timeoutValue),
    },
    net: {
      log: () => send('net.log', {}),
      clear: () => send('net.clear', {}),
      // Attach to a specific request by URL substring instead of a
      // blind sleep+`net log`-poll loop - resolves as soon as a matching
      // entry (already finished within --grace ms, or finishing while
      // this call is outstanding) is seen.
      wait: () => send('net.wait', {
        urlPattern: subArgs[0],
        timeoutMs: timeoutValue !== undefined ? Number(timeoutValue) : undefined,
        graceMs: graceValue !== undefined ? Number(graceValue) : undefined,
      }),
      // Queries the DURABLE, already-persisted net_entries table (via the
      // relay's /sessions/:id/net) instead of the in-page live ring buffer
      // (net.log, capped at 500 - evicted by background sync noise within
      // minutes in a real session). Every entry here already carries
      // started_at/ended_at, so --min-duration/--sort work without any
      // schema change. Defaults to the current active session.
      history: () => netHistory({ sessionId: sessionValue, filter: filterValue, minDuration: minDurationValue, sort: sortValue, limit: limitValue }),
    },
    console: {
      log: () => send('console.log', {}),
      clear: () => send('console.clear', {}),
    },
  };

  const group = table[command];
  if (!group) {
    console.error(`Unknown command '${command}'.\n`);
    usage();
    process.exitCode = 1;
    return;
  }
  const fn = group[sub];
  if (!fn) {
    console.error(`Unknown '${command} ${sub || ''}'.\n`);
    usage();
    process.exitCode = 1;
    return;
  }
  printResult(await fn());
}

main().catch((err) => {
  console.error('web-scout cli error:', err.message);
  if (err.status === 409) {
    console.error('Hint: start a session first - node tools/web-scout/cli.mjs session start "<goal>" ["<context>"]');
  }
  process.exitCode = 1;
});
