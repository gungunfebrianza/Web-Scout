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
import path from 'node:path';
import http from 'node:http';
import {
  request, BASE, netHistory, pageFresh, buildVerityScenarioStub, runSuite, dbVersionCheck, waitForReconnect,
} from './client.mjs';

// Set once near the top of main() from a `--agent <name>` flag found
// anywhere in the subcommand's own arguments; every dom/idb(snapshot)/eval
// dispatch below includes it as a top-level `agent` field on the request
// body (never nested inside `params`) - see tools/web-scout/relay.mjs.
let agentFlag;

function send(type, params) {
  return request('POST', '/command', { type, params, agent: agentFlag });
}

// chars/4 - same rough estimate as db.mjs's getActionCostReport, applied
// here at print time so the cost is visible the moment a heavy call
// happens, not only after the fact via "token-report"/"session show".
// stderr, not stdout - a caller piping/parsing this JSON must never see it
// mixed in.
const PRINT_RESULT_TOKEN_WARN_THRESHOLD = 2000;
function printResult(result) {
  const json = JSON.stringify(result, null, 2);
  console.log(json);
  const estTokens = Math.round(json.length / 4);
  if (estTokens > PRINT_RESULT_TOKEN_WARN_THRESHOLD) {
    console.error(`NOTE: this result is ~${estTokens} estimated tokens (${json.length} chars). If this is idb.dump, try --where/--fields/--limit to scope it; if dom.query, note outerHTML/text are already truncated - "token-report" ranks which command types cost the most across a session.`);
  }
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
  ping [--agent <name>]           fast liveness probe (default timeout 3000ms, distinct from
                                   PING_TIMEOUT_MS = 3000) - does no DOM/IndexedDB work, so a
                                   caller trying to tell "the tab is slow" from "the tab is
                                   frozen" doesn't have to pay a full page.reload/idb.list/eval
                                   timeout (up to ~20s each, serially) just to ask that. Still
                                   routes through the same page-side message queue as every
                                   other command, so it CANNOT prove liveness if the JS thread
                                   is genuinely blocked in a synchronous loop - only answers
                                   faster than the alternatives when the page IS still responsive.
                                   {alive:false, error} on failure - never throws.
  db version-check [--agent <name>]
                                   compares js/db.js's own DB_VERSION (on disk) against the
                                   connected tab's LIVE IndexedDB version - same check "session
                                   start" makes as a warning, but callable standalone/on demand.
                                   On drift, also PROBES whether opening at the source version is
                                   blocked RIGHT NOW (another tab - web-scout-connected or not -
                                   holding a connection at the older version), and by what, instead
                                   of only reporting THAT a version-bump "page reload" hasn't taken.
  session start "<goal>" ["<context>"] [--strict-crv] [--stores a,b,c] [--tags a,b,c] [--token-budget N] [--agent <name>]
                                   declare context/goal - REQUIRED before any action.
                                   --strict-crv auto-snapshots+diffs before/after every
                                   dom.click/dom.fill/eval/idb.put/idb.delete in this session.
                                   Unscoped, this snapshots the WHOLE db every time and WILL
                                   TIME OUT (60s) against a real-size production IndexedDB -
                                   confirmed live. Pass --stores (same store names as
                                   "idb snapshot --stores") to scope every auto-snapshot to
                                   just the stores this session actually touches - strongly
                                   recommended for --strict-crv against a real app db; ignored
                                   without --strict-crv.
                                   Best-effort: if js/db.js is readable and a tab is already
                                   connected, warns (does not block) when the tab's LIVE
                                   IndexedDB version != js/db.js's own DB_VERSION - the tab
                                   has not re-opened the DB since a migration bump.
  session start ... --auto-snapshot --stores a,b,c
                                   also takes+persists a scoped idb.snapshot right at session
                                   start (unscoped is refused - same 60s timeout risk as an
                                   unscoped "idb snapshot") and prints its id. Closes a real
                                   gap in "session cleanup --since-snapshot <id>" (the one mode
                                   that catches eval/UI-button writes, not just idb.put/delete):
                                   it needs a snapshot taken BEFORE you start mutating, and
                                   that step was easy to forget until after the writes already
                                   happened, at which point there is no way to retroactively
                                   recover a "before" state.
                                   --token-budget N is purely advisory - nothing blocks a command from
                                   running over it, but "session end"/"session show"/dashboard's Token
                                   cost panel warn once the session's own estTokens total crosses it.
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
  session end [id]                 end the given session, or the active one if omitted -
                                   prints a one-line token-cost receipt (calls, estTokens, top
                                   offender type; also a --token-budget warning if declared and
                                   exceeded) and a "consider macro record" nudge when the
                                   session logged 5+ replayable actions (dom.click/fill/wait,
                                   idb.put/delete/deleteMany/clear/wait, page.reload, eval) and
                                   was never saved as one - real repeatable shapes (seed/verify/
                                   cleanup) were confirmed hand-rolled from scratch every later
                                   phase despite "macro record" already existing for this.
  session current                  show the active session (if any)
  session list                     list every session, newest first
  session show <id>                session detail + actions + snapshots + diffs + qa
  session report <id> [--format md|json] [--out <path>] [--verity <result.json>]
                                   export a session as a Markdown/JSON report -
                                   printed to stdout, or written to --out. --verity
                                   imports that Verity scenario-result file into the
                                   session first, so it appears in the report's own
                                   "Verity UI checks" section (see "verity import" below)
  session cleanup <id> [--confirm] [--summary]
                                   --summary collapses pendingDeletes/deleted/failed/changedNotDeleted
                                   down to a per-store row COUNT instead of full row bodies - a dry-run
                                   against a store with a large diff used to mean an 11K+-token wall of
                                   full rows just to see "6 rows in store X" before ever asking for detail.
                                   Each store also carries estBytes/estTokens (chars/4 over the same
                                   rows already in memory - no extra fetch) - a bare count didn't say
                                   whether "6 rows" was 200 bytes or 20KB. actionLog mode (no
                                   --since-snapshot) has no row content to size, so those entries show
                                   0 bytes - use --since-snapshot for a real size estimate.
  session cleanup <id> [--confirm]
                                   list (or, with --confirm, delete) every row this session's
                                   own idb.put/idb.putMany/idb.delete/idb.deleteMany/idb.clear actions left
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
                                   DANGEROUS against a busy/shared live app: confirmed live that a
                                   real app's own background writes (e.g. a periodic recompute
                                   cycle writing its own state-history rows) land in the same
                                   window as a long CRV session and get diffed in as "new since
                                   baseline" - a --confirm delete here would destroy real,
                                   non-synthetic data, not just your seeded rows. Prefer tagging:
                                   give every synthetic row your own boolean field (e.g.
                                   {"__crv":true}) at write time, then 'idb dump <store> --where
                                   {"__crv":true}' to enumerate exact ids and 'idb delete-many' by
                                   id - safe regardless of how much real traffic interleaves.

  dom query <selector> [--full] [--meta]
                                   warns on stderr BEFORE dispatching if selector looks like a
                                   whole-page/root container (body/html/#app/#root/main/#main/*) -
                                   likely a huge subtree, worth narrowing before paying for it.
                                   outerHTML + basic attrs for the first match. outerHTML/text
                                   default-capped at 2000/1000 chars (outerHTMLTruncated/
                                   textTruncated say whether anything was actually cut) -
                                   confirmed real waste paying full-subtree cost just to check
                                   an element exists/its class. --full raises the cap to 20000/
                                   5000 for when the whole subtree is genuinely needed. --meta
                                   skips outerHTML/text entirely - just tag/id/className/
                                   matchCount (~50 bytes) for "does this exist / how many
                                   matched" checks that never read the markup at all.
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
  dom wait <selector> --changed [--timeout <ms>]
                                   poll until the selector's textContent DIFFERS from what it was
                                   at call time - use this (not --text) for "a placeholder gets
                                   swapped for a real result" (e.g. every AI-review button in this
                                   app: "Asking AI to review..." -> the real result), where the
                                   placeholder element already exists so a bare selector-exists
                                   wait resolves instantly and tells you nothing, and predicting
                                   the eventual result text ahead of time isn't always possible.
                                   Default --timeout (10000ms) has no relation to any real
                                   provider/backend budget - a real AI call in this app can take
                                   up to that app's own TIMEOUT_MS (confirmed as high as 180000
                                   in one real provider path); a guessed --timeout shorter than
                                   the thing you're actually waiting on fails as a false
                                   "timed out", indistinguishable from a real hang. Match
                                   --timeout to a known real budget, not a guess.
  dom * --selector-file <path>    for query/click/fill/rect/style/wait: reads the selector from
                                   a local file instead of the shell arg (trimmed) - same fix as
                                   eval --file, for the same underlying problem: shell-quoting a
                                   selector with nested quotes/brackets/attribute values through
                                   bash was a real, repeated time-sink. Overrides the positional
                                   selector argument when both are given.
  dom click-wait <selector> [--wait-selector <sel>] [--text <substr>|--changed|--stable [--stable-count <n>]] [--timeout <ms>]
                                   click, then wait for a (possibly different) --wait-selector to
                                   reach a state - one round trip instead of separate click+wait
                                   calls, and a real "did the handler finish" answer where
                                   dom.click's own mutated:true is not one (it only proves SOME
                                   DOM change happened synchronously within its 200ms grace window
                                   - confirmed live: a dialog-opening click reported mutated:true
                                   immediately while the dialog's own async open logic was still
                                   running). --wait-selector defaults to the clicked selector.
  dom wait <selector> --stable [--stable-count <n>] [--timeout <ms>]
                                   poll until the selector's textContent reads IDENTICAL on
                                   <n> (default 3) consecutive polls - for this app's own
                                   confirmed fire-and-forget concurrent-render race (several
                                   unawaited renderAll() calls landing on the same DOM node after
                                   a navigation/click): --changed fires the INSTANT the first of
                                   several in-flight renders lands, which can still be a
                                   mid-race, about-to-be-overwritten intermediate state. Distinct
                                   from dom.settle (a generic MutationObserver quiet-period over a
                                   whole subtree) - this only tracks one selector's own text.
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

  react inspect <selector> [--nth N]
                                   props (+ state for a class component, or positional hooks for
                                   a function component) of the nearest enclosing React component
                                   walking up from selector. Throws if selector isn't inside
                                   React's managed tree.
  react tree <selector> [--nth N] [maxDepth]
                                   ancestor chain of enclosing component names only (default
                                   maxDepth 20) - orient first, then "react inspect" a more
                                   specific selector.

  idb list                        list IndexedDB object store names + a per-store row count
                                   (cheap store.count(), not a full dump) - check this before
                                   an unscoped "idb snapshot" on a store you suspect is large
  idb dump <store> [--where '<json-field-map>'] [--fields a,b,c] [--limit N]
                                   dump rows (+ real keyPath) in one store - --where filters by
                                   exact-equality field match (same semantics as "session
                                   assert"'s own where), e.g. --where '{"__synthetic_tag":"MY-TAG"}'.
                                   Filtering/projection/limiting all happen IN-PAGE now, before the
                                   result ever reaches the WebSocket - previously --where fetched
                                   the WHOLE store and filtered client-side after the fact, so a
                                   scoped dump of a huge store still paid full transfer+DB-storage+
                                   stdout-print cost for every unrelated row (confirmed real token
                                   waste feeding a coding agent). --fields projects each surviving
                                   row down to just those keys instead of every column. --limit
                                   caps rows AFTER filtering (adds truncated:true + a note; use
                                   "idb get" instead when you know the key on a large store).
                                   Response's "count" is rows actually returned; "matchedCount" is
                                   the real filtered total; "totalCount" is the whole store's count.
  idb get <store> <json-key>      real indexed lookup of ONE row by key (store.get, not a
                                   getAll()+filter) - use this instead of "idb dump" when you
                                   already know the key and the store is large (a full dump of
                                   a large real store can be slow/time out)
  idb snapshot [--stores a,b,c] [--where '<json-field-map>'] [--golden <name>]
                                   --where scopes EVERY included store to just the matching rows (same
                                   exact-equality semantics as "idb dump --where") - filtered IN-PAGE
                                   before capture, so a snapshot of just your own tagged/synthetic rows
                                   in an otherwise-large store doesn't pay full-store transfer+storage+
                                   diff cost. Partial by construction: the saved snapshot carries its own
                                   "where" back on every later read (diff/diff-golden/restore included) -
                                   a diff against a where-scoped snapshot only ever proves something about
                                   that subset, never the whole store.
  idb snapshot [--stores a,b,c] [--golden <name>]
                                   capture + PERSIST a DB snapshot -> { id, counts } -
                                   scope to specific stores to avoid the full-DB timeout.
                                   --golden tags it as a named regression baseline, diffable
                                   from ANY future session via "idb diff-golden" (re-tagging
                                   the same name just makes the latest one win - no delete
                                   needed to re-baseline).
  idb snapshot --since <snapshotId> [--stores a,b,c]
                                   takes a fresh snapshot (still persisted, scoped to the
                                   baseline's own stores unless --stores overrides) and prints
                                   ONLY the added/removed/changed rows since that baseline,
                                   instead of the full dump - idb.snapshot is the #2 all-time
                                   token-cost offender (see "token-report") precisely because a
                                   full dump prints every unchanged row too.
  idb diff <idA> <idB>            compute + PERSIST the diff between two persisted snapshots.
  idb diff-golden <name> <idB>    Both cache-aware: if <idB>'s own CONTENT (not id - a fresh
                                   snapshot always gets a new id even when nothing changed) matches
                                   a diff already computed for this golden/pair, the full diff body
                                   is NOT recomputed or re-sent - response carries fromCache:true,
                                   cachedFromDiffId:N, and diffOmitted instead (summary is still
                                   included; fetch diff #N directly if the full detail is genuinely
                                   needed). "did this later phase touch anything <name> already
                                   proved untouched", without hunting down an old snapshot id by
                                   hand.
  idb restore <snapshotId>        replay a persisted snapshot's rows back into IndexedDB via
  idb restore --golden <name>     one idb.put per row per store - resets LIVE state to a known-
                                   good point instead of only detecting drift from it (which is
                                   all idb diff/diff-golden do). Only PUTS - never deletes rows
                                   added since the snapshot; run idb clear first per store if you
                                   need an exact replace, not a merge. Every put is individually
                                   logged (via: "restore"), so a partial failure still shows
                                   exactly which rows did/didn't make it back.
  idb put <store> <json-row> [--dry-run]
                                   write one row (validated against the store's real keyPath) -
                                   response includes the full stored row (key merged in), not
                                   just the key, so a caller never has to assume/re-dump to
                                   learn what autoIncrement actually assigned.
                                   --dry-run validates the row's shape against the store's real
                                   keyPath/autoIncrement WITHOUT writing (readonly, no mutation at
                                   all) - {valid, problems:[...]} - catches a wrong-shaped seed row
                                   before it lands instead of only after, via a separate verify query.
  idb put-many <store> <json-array-of-rows> [--dry-run]
                                   batch write, ONE transaction - real value over a loop of separate
                                   "idb put" calls (each its own shell-quoted JSON arg, confirmed real
                                   friction seeding a handful of fixture rows by hand). A single bad
                                   row (e.g. a unique-index conflict) is reported per-row in "failed"
                                   (mirrors "idb delete-many"'s deletedKeys/failedKeys shape) instead
                                   of aborting the whole batch.
                                   --dry-run mirrors "idb put --dry-run" - same per-row keyPath/
                                   autoIncrement validation, zero mutation - {results:[{index, valid,
                                   problems}], validCount, invalidCount}. Bulk-seeding used to be the
                                   one write path with no way to catch a bad row before it landed.
  idb patch <store> <json-key> <json-patch>
                                   read the existing row, shallow-merge <json-patch> onto it,
                                   write the merged row back - replaces re-typing a whole row
                                   (idb.put's real REPLACE semantics) for a small mutation (e.g.
                                   maturing an execution window, flipping outcome_status).
                                   Requires an EXISTING row at <json-key> - errors rather than
                                   silently inserting a sparse row if the key doesn't exist yet.
  idb delete <store> <json-key>   delete one row by key
  idb delete-many <store> <json-array-of-keys>   delete many rows by key, one transaction -
                                   response includes deletedKeys/failedKeys (not just counts), so
                                   a caller never has to re-idb-dump/snapshot just to confirm which
                                   rows actually went away
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
  net capture <substr>             ADDS <substr> to the armed response-BODY capture set (fetch/XHR) -
                                   call it again with a different substring to watch a second
                                   endpoint too without losing the first arm. "net log"/"net wait"/
                                   "net history" entries gain a bodyPreview (capped 4000 chars,
                                   bodyTruncated says whether anything was cut) going forward,
                                   persisted durably too. Replaces hand-patching window.fetch via
                                   "eval" to see a raw response body a fail-closed validator discards
                                   with no trace on failure (e.g. this app's cfi_cognitive_runs.result:
                                   null on AI_RESPONSE_INVALID).
  net capture --off                disarms body capture entirely - clears EVERY armed substring at
                                   once (off by default; captures nothing until armed)
  net clear                       clear the captured (live) network log

  console log                     captured console.error/warn + uncaught error entries
  console wait "<substr>" [--timeout <ms>] [--grace <ms>]
                                   attach-and-wait for a console entry whose message contains
                                   the given substring, instead of a blind sleep+"console log"-
                                   poll loop that can race the app's own async console.error call.
  console clear                   clear the captured console log

  debug state                     THIS TOOL's own live runtime state (WebSocket readyState,
                                   pending event-batch sizes, reconnect backoff) plus an app-
                                   declared window.__appDebug object if the app sets one - shrinks
                                   the manual "add a console.error, bump ?v=, reload, read log,
                                   remove it, bump again" debugging cycle. Also reachable inline
                                   via "eval window.__webscoutDebug.state" with no relay round
                                   trip. Requires a session like every other action command.
  debug sweep <tag>                CLI-only, no session needed: greps the whole repo for <tag>
                                   (e.g. a temporary debug marker like "P46DEBUG") and reports
                                   every remaining hit (file:line) - verifies hand-added debug
                                   instrumentation was fully removed before shipping instead of a
                                   manual "grep -c" the caller has to remember and run themselves.
                                   Exits 1 if anything is still found - clean:true/hitCount:0 if not.

  dev bump-reload <file> [--no-reload] [--agent <name>]
                                   finds every "<basename>?v=N" reference to <file> ANYWHERE in
                                   the repo and bumps each by +1 (the manual half of this repo's
                                   own cache-busting convention - editing a file needs its version
                                   bumped at every importer, confirmed real repeated friction),
                                   then (unless --no-reload) runs "page reload --hard
                                   --wait-reconnect" - the step this convention always needs next
                                   anyway. Warns if importers disagreed on the version BEFORE this
                                   ran (each still bumped +1 from its own prior value, never
                                   silently normalized to one number).

  NOTE on page-level JS state (not IndexedDB itself): a page module's own
  in-memory cache populated only at init (e.g. an array filled once by a
  render function called from initPageX(), not re-run by a revisit hook)
  can read STALE after an idb.put/idb.snapshot restore even though the
  underlying IndexedDB row is genuinely current - confirmed real: a
  cross-case memory array only refreshed on a true fresh "page reload", not
  a same-tab navigation revisit. If a value looks unexpectedly stale right
  after a write, try a plain "page reload" before assuming a real bug.

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
  page reload [--hard] --wait-reconnect [--timeout <ms>]
                                   both forms above reply BEFORE the real navigation fires, with no
                                   signal for "the reload actually finished" - a click right after
                                   used to fail with "no web-scout agent named 'default' connected"
                                   on a guessed sleep that was too short. --wait-reconnect blocks
                                   until the agent is seen to DISCONNECT then RECONNECT (default
                                   timeout 45000ms plain, 60000ms --hard - bumped from 15000/30000
                                   after a real unbundled-ES-module app was confirmed to take
                                   45-60s to fully reboot, well past the old defaults; --timeout
                                   still overrides either). If reconnected:false comes back, this
                                   does NOT necessarily mean a genuine JS freeze - it may just
                                   still be mid-boot; a repeated eval "1+1" a bit later (own
                                   process, own timeout) can tell "still booting" from "truly
                                   stuck" apart without giving up after one wait. If EVERY
                                   command (reload, ping, eval) times out repeatedly, that IS the
                                   real freeze signal - see eval's own note below on why reload
                                   is not always an escape hatch from that state.
                                   reconnected:true is proof of a real navigation, not just a live
                                   socket - confirmed live that a plain WS-level reconnect (network
                                   blip, relay restart, page.hardReload's own SW-unregister step)
                                   used to false-positive this (a window.__marker__ set before
                                   reload survived it). inject.js now stamps a loadId at <script>
                                   EVAL time (unique per real navigation) and waitForReconnect
                                   requires it to actually change - see client.mjs.
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
                                   KNOWN GOTCHA (Windows/Git Bash): --file /dev/stdin with a
                                   heredoc fails with "ENOENT ... open 'D:\proc\self\fd\0'" -
                                   /dev/stdin does not resolve correctly for this CLI's file read
                                   on Windows. Write the script to a real temp file and pass THAT
                                   path instead.
                                   No need to hand-wrap a multi-statement snippet in an IIFE (e.g.
                                   "(async () => { ... })();") any more - the statement-body
                                   fallback above already handles that, and a trailing ';' on a
                                   hand-written IIFE can push expr past the single-expression
                                   parse into the fallback anyway, silently swallowing a 'return'
                                   nested inside the inner function (confirmed live - the CLI
                                   warns on stderr if expr looks IIFE-wrapped, see below).
                                   Races a page-side timeout (default 10000ms) - if expr contains
                                   an unresolved 'await', you get a diagnostic message instead of
                                   a generic relay timeout. Cannot interrupt a SYNCHRONOUS
                                   infinite loop (JS is single-threaded) - that freezes the tab.
                                   "reload it" is NOT always a working escape hatch from that
                                   state: "page reload" is itself a dispatched command needing the
                                   SAME blocked page thread to process it, and will time out right
                                   alongside eval if the loop is truly synchronous and unbroken.
                                   If reload (and ping) also time out repeatedly, this needs a
                                   manual, browser-side tab refresh - the CLI cannot force that.
                                   A non-JSON-safe result (DOM element, Map, circular,
                                   ...) comes back as {"__unserializable": true, ...} instead of a
                                   silently lossy string. TIP: an id returned by *Crud.add() is
                                   the raw numeric key, not the row - capture and return it
                                   explicitly (e.g. tag seeded rows with a distinct field and
                                   return the tag+ids together) so later cleanup doesn't need a
                                   full store dump to recover what this call created.

  macro record "<name>" <sessionId> [--all]
                                   save that session's own replayable actions (dom.click/fill/
                                   wait, idb.put/delete/deleteMany/clear/wait, page.reload, eval)
                                   as a named macro. --all also includes read-only actions.
                                   Consecutive duplicate steps (a retried click, a double-submit)
                                   are auto-compacted out (compacted_steps_removed on the response
                                   says how many); the macro's own historical estTokens cost is
                                   stamped once here too (steps_cost_est), read back with zero live
                                   lookup by "macro list"/"macro run".
  macro list                      list saved macros (id, name, step count, source session, and
                                   each one's own steps_cost_est/compacted_steps_removed)
  macro show <id>                 full macro detail, including every step
  macro run <id> [--continue-on-error] [--from-step N] [--confirm] [--full]
                                   replay a macro's steps against the CURRENTLY active session -
                                   start one first. Stops at the first failing step unless
                                   --continue-on-error. --from-step (0-based) skips earlier steps,
                                   to resume after fixing whatever made an earlier step fail.
                                   Refused (409) if the target session's goal looks unrelated to
                                   the macro's own recorded-from session's goal - a cross-context
                                   replay guard, since a macro can mutate real data. --confirm
                                   overrides it once you've checked "macro show <id>" is right.
                                   An idb.put step whose row (with an explicit "id" field) is
                                   already byte-identical to what's stored is SKIPPED (no
                                   dispatch, no logged action) - response marks it
                                   skipped:true. Response is compact by default (per step:
                                   type/ok/skipped/durationMs only) - a FAILED step still carries
                                   its full error/result; pass --full to get every step's full
                                   result back, same shape as before this existed.
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
  (read-only commands - idb dump/get/list, dom query/rect/style, net log, console log,
   react inspect/tree - are
   answered from an in-relay cache when called twice IN A ROW with identical args and no
   mutating command (click/fill/eval/idb.put/patch/delete/clear/page.reload) ran in between.
   Result carries __cacheHit:true when this happened - never dispatched to the page twice for
   nothing the page could possibly have changed. The FIRST time this fires in a session, a
   one-time stderr NOTE explains it and points at "token-report"'s savings block. Separately,
   any result byte-identical to one already seen - even in a DIFFERENT session - is physically
   stored only once at the DB level, no flag needed either way.)

  token-report [--session <id>]   rank command TYPES by estimated tokens read off stdout
                                   (chars/4 over result_json, a pure SQL aggregate - running this
                                   never pays anything close to the bytes it measures). Omit
                                   --session for an all-time cross-session ranking; pass it to
                                   audit one CRV session, which also flags repeated-call loops
                                   (3+ same-type+same-params calls within 5s - the confirmed real
                                   "eval 1+1 while waiting for boot" poll shape) and redundantCalls
                                   (idb.dump/dom.query calls spaced further apart whose result never
                                   actually changed - "did I already know this" re-checking), and
                                   byTarget - same estTokens ranking but grouped by store (idb.dump)
                                   or selector (dom.query) instead of just type, to pinpoint WHICH
                                   store/selector is the real hotspot - and byMacro, grouped by
                                   params.macroId (non-macro calls bucket under macroId: null), to
                                   pinpoint WHICH replayed macro/CRV phase actually cost the tokens
                                   instead of only the command type. The all-time form (no
                                   --session) ALSO carries a "savings" block - real, measured
                                   proof of what the mechanisms below actually saved: resultDedup
                                   (bytesSaved/estTokensSaved never physically duplicated on disk),
                                   goldenDiffCache (bytes never re-sent for a repeat diff-golden
                                   check), macroCompaction (steps removed at record time), and
                                   runtimeReadCache (this relay PROCESS's own cache hits/bytes -
                                   resets on restart, unlike the other three which are real DB rows
                                   and survive one). Check this after a long CRV session to see
                                   whether the waste-prevention machinery below is actually earning
                                   its keep, not just running.

  Every command reply also carries a running session token TOTAL (a
  cumulative estimate, not per-call) in the x-webscout-session-tokens
  response header - printed to stderr once it crosses ~5000 estimated
  tokens (override with WEBSCOUT_TOKEN_THRESHOLD=<n> env var - lower it for
  a token-sensitive CRV, raise it to cut noise on a deliberately heavy
  bulk-seed session). Answers "how much has this session cost so far"
  call-by-call, instead of only after the fact via "token-report" - a
  278K-token idb.snapshot used to surface only in a post-hoc audit, well
  after the session that paid for it was already over. Correctly INCLUDES
  same-session read-result cache hits (__cacheHit:true replies) in the
  running total - a cache hit skips the DB action log but the result bytes
  still land in this reply and still get read, so they still count.

  Waste-prevention machinery running AUTOMATICALLY, with no flag needed (mentioned here so you
  know it exists - "token-report"'s savings block above is the proof it's working):
   - same-session read-result cache: identical read call twice in a row with nothing mutating in
     between is answered from cache (__cacheHit:true), never re-dispatched to the page. The FIRST
     time this happens in a session, a one-time stderr NOTE points here.
   - DB-level result dedup: an identical result (even across DIFFERENT sessions - e.g. the same
     fixture store dumped every CRV round) is physically stored ONCE, ever, no flag needed.
   - macro compaction: "macro record"/"macro show" automatically drop consecutive duplicate steps
     (a retried click, a double-submit) and stamp the macro's own historical cost estimate at
     record time - "macro list"/"macro run" read it back with zero live lookup.
   - golden-diff cache: "idb diff-golden"/a suite's diff-golden step recognizes when two DIFFERENT
     snapshot ids hold byte-identical content to an already-computed diff, and omits re-sending the
     full (possibly large) diff body - response carries fromCache:true + cachedFromDiffId instead.
   - snapshot row dedup: "idb snapshot" stores each ROW's content once, ever, regardless of how
     many snapshots (across ANY session) contain an unchanged copy of it - most rows in a real
     store don't change between two consecutive snapshots, so only the rows that actually changed
     cost anything physically. "token-report" (no --session)'s savings.snapshotRowDedup is the proof.
   - macro step dedup: "macro record"/"macro update" store each STEP's own {type,params} content
     once, ever, so two macros sharing an identical prefix (login, navigate) share that storage
     instead of each paying for their own full copy. savings.stepBlobDedup is the proof.
   - macro no-op skip: "macro run" skips an idb.put step (with an "id" field on its row) whose row
     is already byte-identical to what's stored - no dispatch, no logged action.
   - macro read-cache wiring: "macro run"'s own read steps (idb.dump/idb.get/idb.list/dom.query/...)
     now hit the SAME same-session read-result cache "macro run"'s mutating steps also now correctly
     bump - a macro re-checking state it (or an earlier /command call) just asked about is served
     from cache like any other repeat read. Row shows skipped:true, reason "read result served from
     same-session cache".
   - column-dictionary snapshot compaction: "idb snapshot" factors a field VALUE repeating across
     rows of the SAME store in one snapshot (e.g. 500 rows sharing status:"active") into a small
     per-store dictionary before storing - shrinks storage even the FIRST time a store is ever
     snapshotted, on top of (not instead of) row-level dedup. savings.columnDictCompaction is the proof.
   - macro step templating: "macro record"/"macro update" fold a run of 3+ consecutive steps that
     share a type and param shape but differ by value (bulk fixture-seeding idb.put calls, most
     commonly) into one template entry + a value list - transparently expanded back on every read, so
     replay is unaffected; only storage/step-blob volume shrinks. savings.macroTemplating is the proof.
   - within-suite diff-golden memoization: "suite run" answers a literal repeat {name, idB}
     diff-golden step from its own in-memory cache for that one run, skipping even the HTTP round
     trip (not just the diff recompute) - response carries ranFromWithinSuiteCache:true.
   - params dedup: an identical params object (e.g. the same {store} in a tight idb.dump polling
     loop) is physically stored ONCE, ever, same mechanism as DB-level result dedup above but for
     the params side. savings.paramsDedup is the proof; loop/redundant-call detection and cost
     reports still see the real content transparently.
   - console/net text dedup: console_entries.message/stack and net_entries.url (both never pruned,
     net_entries alone real production volume in the tens of thousands of rows) intern each repeated
     value once - a page logging the same warning, or hitting the same failing endpoint, on every
     poll no longer pays full bytes past the first occurrence. savings.textDedup is the proof.
   - verity result dedup: "verity import" of a byte-identical scenario result (a re-run CRV round
     with no real change) reuses the same DB-level result_blobs storage as action results - no flag
     needed. savings.resultDedup covers it (shared table).
   - Friction Analytics redaction: GET /analytics's cross-session scan now redacts the same heavy
     result fields (dom.screenshot dataUrl, idb.snapshot stores, net.log entries) listActionsSummary
     already did - the dashboard's analytics panel never reasons about result content, only
     type/timing/loop shape, so holding those bytes parsed in memory on every 5s server-side rescan
     was pure waste.

  macro run / suite run           print an estimated token-cost NOTE on stderr before replaying -
                                   "macro run" reads the target macro's OWN stamped steps_cost_est
                                   (set once at record/update time, zero live lookup); "suite run"
                                   sums each referenced macro's own stamped estimate the same way.
                                   Falls back to a live historical-average lookup only for a
                                   pre-migration macro that predates steps_cost_est.

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
async function warnOnDbVersionDrift(hint) {
  try {
    const src = fs.readFileSync('js/db.js', 'utf8');
    const match = src.match(/DB_VERSION\s*=\s*(\d+)/);
    if (!match) return;
    const sourceVersion = Number(match[1]);
    const live = await send('db.version', {});
    if (live.version !== sourceVersion) {
      console.error(`WARNING: live IndexedDB version (${live.version}) != js/db.js DB_VERSION (${sourceVersion}) - the connected tab has not re-opened the DB since a migration bump. Run "page reload" (or "page reload --hard") before trusting any new-store check.${hint ? ` ${hint}` : ''}`);
    }
  } catch { /* best-effort - no js/db.js here, no agent connected, etc. */ }
}

async function handleSession(sub, rawArgs) {
  if (sub === 'start') {
    let args = rawArgs;
    let tagsValue;
    let strictCrv;
    let storesValue;
    let autoSnapshot;
    let tokenBudgetValue;
    ({ args, value: tagsValue } = extractFlag(args, '--tags'));
    ({ args, value: strictCrv } = extractBooleanFlag(args, '--strict-crv'));
    ({ args, value: storesValue } = extractFlag(args, '--stores'));
    ({ args, value: autoSnapshot } = extractBooleanFlag(args, '--auto-snapshot'));
    ({ args, value: tokenBudgetValue } = extractFlag(args, '--token-budget'));
    ({ args, value: agentFlag } = extractFlag(args, '--agent'));
    const tags = tagsValue ? tagsValue.split(',').map((t) => t.trim()).filter(Boolean) : [];
    const strictCrvStores = storesValue ? storesValue.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
    const session = await request('POST', '/sessions', { goal: args[0], context: args[1], strict_crv: strictCrv, strict_crv_stores: strictCrvStores, tags, token_budget: tokenBudgetValue !== undefined ? Number(tokenBudgetValue) : undefined });
    if (strictCrv && !storesValue) {
      console.error('WARNING: --strict-crv with no --stores auto-snapshots the WHOLE db on every dom.click/fill/eval/idb.put/idb.delete - this WILL time out (60s) against a real-size production IndexedDB. Pass --stores a,b,c to scope it.');
    }
    if (autoSnapshot) {
      // Requires --stores for the same reason "idb snapshot" itself warns
      // about unscoped snapshots - refused rather than silently attempting
      // a whole-db snapshot that risks the same 60s timeout right at
      // session start.
      if (!strictCrvStores) {
        console.error('WARNING: --auto-snapshot requires --stores a,b,c (unscoped risks the same 60s snapshot timeout as an unscoped "idb snapshot") - skipped.');
      } else {
        try {
          const snap = await request('POST', '/state/snapshot', { agent: agentFlag, stores: strictCrvStores });
          console.error(`auto-snapshot #${snap.id} taken (stores: ${strictCrvStores.join(', ')}) - "session cleanup ${session.id} --since-snapshot ${snap.id}" will catch every row added since now, however it was written.`);
        } catch (err) {
          console.error(`WARNING: --auto-snapshot failed: ${err.message}`);
        }
      }
    }
    printResult(session);
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
    const ended = await request('POST', `/sessions/${id}/end`);
    if (ended.replayableActionCount >= 5) {
      console.error(`${ended.replayableActionCount} replayable action(s) this session - consider "macro record \\"<name>\\" ${ended.id}" if this shape (seed/verify/cleanup, etc.) will repeat.`);
    }
    // One-line cost receipt at the natural end-of-session checkpoint -
    // catches waste the same day it happened instead of only on a later,
    // on-demand "token-report" call nobody remembered to run.
    try {
      const tokenReport = await request('GET', `/sessions/${ended.id}/token-report`);
      const top = tokenReport.byType[0];
      console.error(`session #${ended.id} cost: ${tokenReport.totalCalls} call(s), ~${tokenReport.totalEstTokens} estimated tokens${top ? ` (top: ${top.type} ~${top.estTokens})` : ''}.`);
      if (ended.token_budget && tokenReport.totalEstTokens > ended.token_budget) {
        console.error(`WARNING: session #${ended.id} used ~${tokenReport.totalEstTokens} estimated tokens, over its declared --token-budget of ${ended.token_budget}.`);
      }
    } catch { /* best-effort - never fail "session end" over the receipt */ }
    printResult(ended);
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
    const [session, actions, snapshots, diffs, qa, consoleEntries, net, tokenReport] = await Promise.all([
      request('GET', `/sessions/${id}`),
      request('GET', `/sessions/${id}/actions?full=1`),
      request('GET', `/sessions/${id}/snapshots`),
      request('GET', `/sessions/${id}/diffs`),
      request('GET', `/sessions/${id}/qa`),
      request('GET', `/sessions/${id}/console`),
      request('GET', `/sessions/${id}/net`),
      // Pure SQL aggregate (see db.mjs's getActionCostReport) - adds
      // essentially nothing to this call's own cost despite `actions`
      // above already being the full, unredacted dump.
      request('GET', `/sessions/${id}/token-report`),
    ]);
    if (session.token_budget && tokenReport.totalEstTokens > session.token_budget) {
      console.error(`WARNING: session #${id} has used ~${tokenReport.totalEstTokens} estimated tokens, over its declared --token-budget of ${session.token_budget}.`);
    }
    printResult({ session, actions, snapshots, diffs, qa, console: consoleEntries, net, tokenReport });
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
    let summary;
    ({ args, value: confirm } = extractBooleanFlag(args, '--confirm'));
    ({ args, value: sinceSnapshotId } = extractFlag(args, '--since-snapshot'));
    ({ args, value: summary } = extractBooleanFlag(args, '--summary'));
    const id = args[0];
    if (!id) throw new Error('session cleanup requires an id');
    printResult(await request('POST', `/sessions/${id}/cleanup`, { confirm, sinceSnapshotId: sinceSnapshotId !== undefined ? Number(sinceSnapshotId) : undefined, summary }));
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

// Walks the repo (skipping node_modules/.git/dist-style build output) and
// bumps EVERY `<basename>?v=N` reference to `targetFile` by 1, across every
// importer - the manual half of this repo's own cache-busting convention
// (editing a file requires bumping its version at every importer, often a
// bulk sed across dozens of files, confirmed real repeated friction across
// a real session). Matches on basename only (not the full relative path) -
// this repo's own import specifiers are written relative to each importing
// file, so the same target is referenced with different leading paths from
// different files; basename + `?v=` is the one thing every reference to a
// given file shares. Reports every file it touched and the old->new version
// per match (a target with inconsistent versions across importers - already
// a latent bug before this ran - is surfaced, not silently "fixed" to one
// arbitrary value). Then (unless --no-reload) issues a hard reload with
// --wait-reconnect, the exact next step this convention always needs
// anyway.
function walkFiles(dir, out, skipDirs) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch { return out; }
  for (const entry of entries) {
    if (skipDirs.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, out, skipDirs);
    else if (/\.(js|mjs|html|css)$/.test(entry.name)) out.push(full);
  }
  return out;
}

async function handleDev(sub, rawArgs) {
  if (sub === 'bump-reload') {
    let args = rawArgs;
    let noReload;
    let hard;
    ({ args, value: noReload } = extractBooleanFlag(args, '--no-reload'));
    ({ args, value: hard } = extractBooleanFlag(args, '--soft'));
    ({ args, value: agentFlag } = extractFlag(args, '--agent'));
    const targetFile = args[0];
    if (!targetFile) throw new Error('dev bump-reload requires a file path, e.g. js/pages/capital-flow.js');
    const basename = path.basename(targetFile);
    const escaped = basename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`(${escaped}\\?v=)(\\d+)`, 'g');
    const skipDirs = new Set(['node_modules', '.git', 'dist', 'build', '.claude']);
    const files = walkFiles(process.cwd(), [], skipDirs);
    const touched = [];
    for (const file of files) {
      let content;
      try {
        content = fs.readFileSync(file, 'utf8');
      } catch { continue; }
      if (!pattern.test(content)) continue;
      pattern.lastIndex = 0;
      const matches = [];
      const updated = content.replace(pattern, (whole, prefix, num) => {
        const oldV = Number(num);
        const newV = oldV + 1;
        matches.push({ from: oldV, to: newV });
        return `${prefix}${newV}`;
      });
      if (updated !== content) {
        fs.writeFileSync(file, updated, 'utf8');
        touched.push({ file: path.relative(process.cwd(), file), matches });
      }
    }
    if (!touched.length) {
      console.error(`WARNING: no "${basename}?v=N" reference found anywhere in the repo - nothing bumped. Check the basename is right and the referencing files use this exact "?v=" convention.`);
    }
    const distinctVersions = new Set(touched.flatMap((t) => t.matches.map((m) => m.from)));
    if (distinctVersions.size > 1) {
      console.error(`WARNING: found ${distinctVersions.size} DIFFERENT existing version numbers across importers before this bump (${[...distinctVersions].join(', ')}) - that inconsistency predates this command and every occurrence was still bumped by +1 from whatever it already was, not normalized to one value. Review the list below.`);
    }
    printResult({ basename, filesTouched: touched.length, touched });
    if (!noReload) {
      const result = await send('page.hardReload', {});
      result.reconnect = await waitForReconnect({ agent: agentFlag, timeoutMs: 60000 });
      printResult(result);
    }
    return;
  }
  throw new Error(`unknown 'dev ${sub || ''}'`);
}

async function handleDebugCli(sub, rawArgs) {
  if (sub === 'sweep') {
    const tag = rawArgs[0];
    if (!tag) throw new Error('debug sweep requires a tag string, e.g. debug sweep P46DEBUG');
    const skipDirs = new Set(['node_modules', '.git', 'dist', 'build', '.claude']);
    const files = walkFiles(process.cwd(), [], skipDirs);
    const hits = [];
    for (const file of files) {
      let content;
      try {
        content = fs.readFileSync(file, 'utf8');
      } catch { continue; }
      if (!content.includes(tag)) continue;
      const lines = content.split('\n');
      lines.forEach((line, i) => {
        if (line.includes(tag)) hits.push({ file: path.relative(process.cwd(), file), line: i + 1, text: line.trim().slice(0, 200) });
      });
    }
    printResult({ tag, hitCount: hits.length, hits, clean: hits.length === 0 });
    if (hits.length) process.exitCode = 1;
    return;
  }
  throw new Error(`unknown 'debug ${sub || ''}' (CLI-level - for the live in-page state, use "debug state")`);
}

async function handleDb(sub, rawArgs) {
  if (sub === 'version-check') {
    let args = rawArgs;
    ({ args, value: agentFlag } = extractFlag(args, '--agent'));
    printResult(await dbVersionCheck({ agent: agentFlag }));
    return;
  }
  throw new Error(`unknown 'db ${sub || ''}'`);
}

// Pre-run, not post-run: sums each step's OWN action type's historical
// average estTokens/call (from GET /token-report's byType, all sessions)
// across the steps about to replay - so a caller can decide to trim a
// macro/suite BEFORE paying for it, not discover the cost after the fact
// via "token-report"/"session end"'s receipt. Best-effort only (a type with
// zero prior history just contributes 0) - never blocks the run.
async function estimateActionsTokenCost(steps) {
  const report = await request('GET', '/token-report');
  const avgByType = new Map((report.byType || []).map((r) => [r.type, r.calls ? r.estTokens / r.calls : 0]));
  return Math.round(steps.reduce((sum, step) => sum + (avgByType.get(step.type) || 0), 0));
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
    let full;
    ({ args, value: continueOnError } = extractBooleanFlag(args, '--continue-on-error'));
    ({ args, value: fromStep } = extractFlag(args, '--from-step'));
    ({ args, value: confirm } = extractBooleanFlag(args, '--confirm'));
    ({ args, value: full } = extractBooleanFlag(args, '--full'));
    const id = args[0];
    if (!id) throw new Error('macro run requires an id');
    try {
      const macro = await request('GET', `/macros/${id}`);
      // steps_cost_est is stamped once at record/update time (db.mjs's
      // estimateStepsTokenCost) - reused here directly instead of a live
      // /token-report round trip. compacted_steps_removed (also stamped at
      // record time) is surfaced too, since it's real evidence this exact
      // macro is already cheaper than the raw session it was recorded from.
      const estTokens = Number.isFinite(macro.steps_cost_est) ? macro.steps_cost_est : await estimateActionsTokenCost(macro.steps);
      const compactNote = macro.compacted_steps_removed ? ` (${macro.compacted_steps_removed} duplicate step(s) already compacted out at record time)` : '';
      console.error(`NOTE: estimated cost of this replay ~${estTokens} tokens across ${macro.steps.length} step(s)${compactNote} (historical per-type averages - see "token-report").`);
    } catch { /* best-effort estimate only, never block the run */ }
    const result = await request('POST', `/macros/${id}/run`, { continueOnError, confirm, full, fromStep: fromStep !== undefined ? Number(fromStep) : undefined });
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
    try {
      // Sums each referenced macro's OWN stamped steps_cost_est (set once at
      // record time, see db.mjs) instead of a live /token-report call per
      // macro - zero extra HTTP round trips to print this estimate. Falls
      // back to a live estimate only for a pre-migration macro that predates
      // steps_cost_est (null).
      let totalEst = 0;
      let totalSteps = 0;
      let anyLiveFallback = false;
      for (const step of steps) {
        if (step.type !== 'macro' || !step.id) continue;
        const macro = await request('GET', `/macros/${step.id}`);
        totalSteps += macro.steps.length;
        if (Number.isFinite(macro.steps_cost_est)) {
          totalEst += macro.steps_cost_est;
        } else {
          anyLiveFallback = true;
          totalEst += await estimateActionsTokenCost(macro.steps);
        }
      }
      if (totalSteps) {
        console.error(`NOTE: estimated cost of this suite ~${totalEst} tokens across ${totalSteps} macro step(s)${anyLiveFallback ? '' : ' (from each macro\'s own stamped cost estimate, no live lookup needed)'} - see "token-report".`);
      }
    } catch { /* best-effort estimate only, never block the run */ }
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

  if (command === 'ping') {
    let a = rest;
    ({ args: a, value: agentFlag } = extractFlag(a, '--agent'));
    printResult(await request('POST', '/ping', { agent: agentFlag }));
    return;
  }

  if (command === 'session') {
    await handleSession(rest[0], rest.slice(1));
    return;
  }

  if (command === 'db') {
    await handleDb(rest[0], rest.slice(1));
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

  if (command === 'dev') {
    await handleDev(rest[0], rest.slice(1));
    return;
  }

  if (command === 'debug' && rest[0] === 'sweep') {
    await handleDebugCli(rest[0], rest.slice(1));
    return;
  }

  if (command === 'dashboard') {
    console.log(`${BASE}/dashboard`);
    return;
  }

  // Ranks command TYPES by estimated tokens a coding agent actually reads
  // off stdout for them (chars/4 over the SAME result_json every
  // printResult call already prints) - a pure SQL aggregate server-side
  // (db.mjs's getActionCostReport), so running this never itself pays
  // anything close to the bytes it measures. Omit --session for a
  // cross-session, all-time ranking (which type is worst overall); pass it
  // to audit one CRV session. `loops` (session-scoped only) flags
  // consecutive same-type+same-params calls within 5s of each other, 3+ in
  // a row - the confirmed real "eval 1+1 while waiting for boot" poll
  // shape, a waste class byType alone can't distinguish from one-off heavy
  // calls.
  if (command === 'token-report') {
    // NOT rest.slice(1) - rest here IS the flag list itself (no leading
    // subcommand token to skip), so slicing dropped "--session" outright
    // and silently sent every "--session <id>" call to the all-time (no
    // session scope) endpoint instead - found live while verifying byMacro.
    const { value: sessionIdArg } = extractFlag(rest, '--session');
    const report = sessionIdArg
      ? await request('GET', `/sessions/${sessionIdArg}/token-report`)
      : await request('GET', '/token-report');
    printResult(report);
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
  let sinceValue;
  let quietValue;
  let graceValue;
  let fileValue;
  let filterValue;
  let minDurationValue;
  let sortValue;
  let limitValue;
  let sessionValue;
  let changedValue;
  let waitReconnectValue;
  let whereValue;
  let fieldsValue;
  let selectorFileValue;
  let stableValue;
  let stableCountValue;
  let waitSelectorValue;
  let fullValue;
  ({ args, value: fullValue } = extractBooleanFlag(args, '--full'));
  let dryRunValue;
  ({ args, value: dryRunValue } = extractBooleanFlag(args, '--dry-run'));
  let offValue;
  ({ args, value: offValue } = extractBooleanFlag(args, '--off'));
  let metaValue;
  ({ args, value: metaValue } = extractBooleanFlag(args, '--meta'));
  ({ args, value: stableValue } = extractBooleanFlag(args, '--stable'));
  ({ args, value: stableCountValue } = extractFlag(args, '--stable-count'));
  ({ args, value: waitSelectorValue } = extractFlag(args, '--wait-selector'));
  ({ args, value: selectorFileValue } = extractFlag(args, '--selector-file'));
  ({ args, value: whereValue } = extractFlag(args, '--where'));
  ({ args, value: fieldsValue } = extractFlag(args, '--fields'));
  ({ args, value: changedValue } = extractBooleanFlag(args, '--changed'));
  ({ args, value: waitReconnectValue } = extractBooleanFlag(args, '--wait-reconnect'));
  ({ args, value: nthValue } = extractFlag(args, '--nth'));
  ({ args, value: textValue } = extractFlag(args, '--text'));
  ({ args, value: timeoutValue } = extractFlag(args, '--timeout'));
  ({ args, value: countGteValue } = extractFlag(args, '--count-gte'));
  ({ args, value: storesValue } = extractFlag(args, '--stores'));
  ({ args, value: goldenValue } = extractFlag(args, '--golden'));
  ({ args, value: sinceValue } = extractFlag(args, '--since'));
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
    // Plain reload does NOT bust a Service Worker's cache - confirmed live:
    // this cost a real session a genuine VersionError (stale-cached JS
    // still declaring the OLD DB_VERSION, racing a DB already bumped by a
    // properly-fresh tab). Warn up front, once, whenever this repo actually
    // has a sw.js at its root - not fatal, just visible before the caller
    // trusts a plain reload's result.
    if (!hard && fs.existsSync(path.join(process.cwd(), 'sw.js'))) {
      console.error('NOTE: this repo has a sw.js (Service Worker) - a plain "page reload" can keep serving OLD cached JS for several reloads (stale-while-revalidate) even after a real file edit. If you just edited js/db.js, sw.js, or any file this app precaches, use "page reload --hard" instead.');
    }
    const result = await send(hard ? 'page.hardReload' : 'page.reload', {});
    if (waitReconnectValue) {
      // A hard reload additionally unregisters the Service Worker and
      // clears Cache Storage before navigating - on a large cache this can
      // take noticeably longer than a plain reload's wait, which at the old
      // 15000/30000 defaults previously produced a false-negative
      // reconnected:false even though the tab came back healthy moments
      // later (confirmed live, twice, against a real app with hundreds of
      // unbundled ES module files - full boot took 45-60s+). Bumped to
      // 45000/60000; --timeout still overrides either.
      const defaultTimeout = hard ? 60000 : 45000;
      result.reconnect = await waitForReconnect({ agent: agentFlag, timeoutMs: timeoutValue !== undefined ? Number(timeoutValue) : defaultTimeout });
    }
    printResult(result);
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
    let expr;
    if (fileValue) {
      // fs.readFileSync throwing ENOENT is the easy case - the confirmed
      // real gotcha is a path that SEEMS to read (no throw) but is empty or
      // whitespace-only, e.g. a POSIX-style /tmp/... path that doesn't
      // resolve the way the caller expects on Windows/Git Bash, silently
      // producing an empty string instead of erroring - which then evals as
      // a no-op expression and returns {} with zero signal anything went
      // wrong. Fail loud here instead.
      expr = fs.readFileSync(fileValue, 'utf8');
      if (!expr.trim()) {
        throw new Error(`--file ${fileValue} read as empty/whitespace-only - on Windows/Git Bash a POSIX-style path (e.g. /tmp/...) may not resolve the way you expect; write the script to a real path under your scratchpad directory and pass that.`);
      }
    } else {
      expr = args.join(' ');
    }
    // A hand-written `(async () => { ... })();` wrapper is unnecessary
    // (the relay-side statement-body fallback already handles multiple
    // statements) and actively dangerous: the trailing `;` breaks the
    // single-EXPRESSION parse attempt, falling into that fallback anyway,
    // where a `return` nested inside THIS inner function never reaches the
    // outer one - silently yielding undefined (confirmed live, twice, in a
    // real session before the cause was found). Warn, don't block - a
    // caller with a real reason to nest an IIFE (rare) can ignore this.
    if (/^\s*\(\s*(async\s+)?\(\s*\)\s*=>\s*\{[\s\S]*\}\s*\)\s*\(\s*\)\s*;?\s*$/.test(expr)) {
      console.error('NOTE: expr looks like a hand-wrapped IIFE ("(async () => { ... })();"). This is usually unnecessary now (eval already falls back to a statement body for multi-statement input) and can silently swallow a `return` nested inside it. Consider writing expr as a plain statement body instead - see eval\'s help text.');
    }
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
  // --selector-file reads the selector from a file (trimmed) instead of the
  // shell arg - same fix, same reason, as eval --file: shell-quoting a
  // selector with nested quotes/brackets/attribute-value strings through
  // bash was a real, repeated time-sink. Only affects dom subcommands that
  // take a selector as their first positional arg.
  const domSelector = selectorFileValue ? fs.readFileSync(selectorFileValue, 'utf8').trim() : subArgs[0];

  // Pre-call, not post-call: warns BEFORE spend, based on the selector
  // string alone (no relay round trip needed) - a whole-page/root container
  // selector is very likely a huge subtree, worth flagging before paying
  // outerHTML cost for it (printResult's own token-warn note below only
  // fires AFTER the result is already back and paid for).
  const BROAD_DOM_QUERY_SELECTORS = new Set(['body', 'html', '#app', '#root', 'main', '#main', '*']);
  const table = {
    dom: {
      query: () => {
        if (!fullValue && !metaValue && BROAD_DOM_QUERY_SELECTORS.has(String(domSelector).trim().toLowerCase())) {
          console.error(`NOTE: selector "${domSelector}" looks like a whole-page/root container - likely a huge subtree. Consider a more specific selector (id/class/data-attribute), --meta if you only need tag/id/class/matchCount, or --full only if the whole subtree is genuinely needed.`);
        }
        return send('dom.query', { selector: domSelector, full: fullValue, meta: metaValue });
      },
      click: () => send('dom.click', { selector: domSelector, nth: nthValue !== undefined ? Number(nthValue) : undefined }),
      fill: () => send('dom.fill', { selector: domSelector, value: subArgs[1], nth: nthValue !== undefined ? Number(nthValue) : undefined }),
      rect: () => send('dom.rect', { selector: domSelector }),
      style: () => send('dom.computedStyle', { selector: domSelector, properties: subArgs[1] ? subArgs[1].split(',').map((s) => s.trim()) : undefined }),
      wait: () => send('dom.wait', { selector: domSelector, text: textValue, timeoutMs: timeoutValue !== undefined ? Number(timeoutValue) : undefined, changed: changedValue, stable: stableValue, stableCount: stableCountValue !== undefined ? Number(stableCountValue) : undefined }),
      pick: () => send('dom.pick', { timeoutMs: timeoutValue !== undefined ? Number(timeoutValue) : undefined }),
      // Click, then wait for a (possibly different) --wait-selector to reach
      // a state - one round trip instead of "dom click" then a separate
      // "dom wait", and a real answer to "did the handler actually finish"
      // instead of dom.click's own mutated:true (which only proves the
      // click's synchronous 200ms grace window saw SOME DOM change, not
      // that an async handler - dialog open, dispatch commit - is done).
      'click-wait': () => send('dom.clickWait', {
        selector: domSelector, nth: nthValue !== undefined ? Number(nthValue) : undefined,
        waitSelector: waitSelectorValue, text: textValue,
        timeoutMs: timeoutValue !== undefined ? Number(timeoutValue) : undefined,
        changed: changedValue, stable: stableValue, stableCount: stableCountValue !== undefined ? Number(stableCountValue) : undefined,
      }),
      // Generic "wait until quiet" - pass a selector to scope it (default:
      // document.body). Use after a click/rebuild and before the next
      // dom.query/dom.click instead of a guessed sleep.
      settle: () => send('dom.settle', { selector: subArgs[0], quietMs: quietValue !== undefined ? Number(quietValue) : undefined, timeoutMs: timeoutValue !== undefined ? Number(timeoutValue) : undefined }),
    },
    react: {
      // props (+ state for a class component, or positional hooks for a
      // function component) of the nearest enclosing React component,
      // walking up from domSelector - see inject.js's findComponentFiber.
      inspect: () => send('react.inspect', { selector: domSelector, nth: nthValue !== undefined ? Number(nthValue) : undefined }),
      // Ancestor chain of enclosing component names only (not full
      // props/state per level) - orient first, then `react inspect` a more
      // specific selector.
      tree: () => send('react.tree', { selector: domSelector, nth: nthValue !== undefined ? Number(nthValue) : undefined, maxDepth: subArgs[1] !== undefined ? Number(subArgs[1]) : undefined }),
    },
    idb: {
      list: () => send('idb.list', {}),
      // where/fields/limit are now filtered/projected IN-PAGE (inject.js) -
      // this dispatches them as params instead of re-filtering a full dump
      // client-side, so a scoped dump of a huge store no longer pays full
      // transfer+DB-storage+stdout-print cost for every unrelated row.
      // Pre-call, not post-call: checks this store's OWN historical average
      // cost (across all sessions, via GET /token-report's byTarget) before
      // dispatching - a real, learned number ("store X averaged ~N
      // tokens/call over M past dumps"), not the static whole-page-selector
      // heuristic "dom query" uses above. Only fires when the caller hasn't
      // already scoped the call (no --where/--fields/--limit).
      dump: async () => {
        const store = subArgs[0];
        if (store && !whereValue && !fieldsValue && !limitValue) {
          try {
            const report = await request('GET', '/token-report');
            const hist = (report.byTarget || []).find((t) => t.type === 'idb.dump' && t.target === store);
            if (hist && hist.calls >= 3) {
              console.error(`NOTE: store "${store}" dumped ${hist.calls}x before, averaging ~${hist.avgEstTokens} estimated tokens/call (~${hist.avgResultBytes} bytes). Consider --where/--fields/--limit to scope it.`);
            }
          } catch { /* best-effort historical hint only, never block the dump */ }
        }
        return send('idb.dump', {
          store,
          where: whereValue ? JSON.parse(whereValue) : undefined,
          fields: fieldsValue ? fieldsValue.split(',').map((f) => f.trim()) : undefined,
          limit: limitValue !== undefined ? Number(limitValue) : undefined,
        });
      },
      get: () => send('idb.get', { store: subArgs[0], key: JSON.parse(subArgs[1]) }),
      snapshot: async () => {
        const stores = storesValue ? storesValue.split(',').map((s) => s.trim()) : undefined;
        // --since <snapshotId>: sugar for "take a fresh snapshot scoped to
        // that baseline's own stores, diff against it, print only the
        // delta" - idb.snapshot is the #2 all-time token cost offender
        // (getActionCostReport) precisely because a full dump prints every
        // unchanged row alongside whatever actually changed. /state/diff
        // already only returns added/removed/changed rows per store (see
        // relay.mjs's computeDiff) - this just makes that the DEFAULT view
        // for "what changed" instead of a separate diff call after the fact.
        // The fresh full snapshot is still taken and persisted (its id is
        // in the response) for anyone who later needs the complete dump.
        if (sinceValue) {
          const baseline = await request('GET', `/state/snapshots/${sinceValue}`);
          const scopeStores = stores || Object.keys(baseline.stores || {});
          const fresh = await request('POST', '/state/snapshot', { agent: agentFlag, stores: scopeStores, golden: goldenValue });
          const diff = await request('POST', '/state/diff', { idA: Number(sinceValue), idB: fresh.id });
          return {
            mode: 'since', baselineSnapshotId: Number(sinceValue), freshSnapshotId: fresh.id,
            summary: diff.summary, diff: diff.diff,
            note: 'only rows added/removed/changed since the baseline are shown - pass no --since (or "idb dump") for a full read.',
          };
        }
        // Unscoped snapshot of a real-size db is the confirmed
        // SNAPSHOT_TIMEOUT_MS (60s) failure mode - warn with a real row-
        // count total (via the cheap idb.list counts, not a full dump)
        // BEFORE attempting it, instead of only discovering the size after
        // a minute-long timeout.
        if (!stores) {
          try {
            const { counts } = await send('idb.list', {});
            const total = Object.values(counts || {}).reduce((a, b) => a + b, 0);
            if (total > 5000) {
              console.error(`WARNING: unscoped snapshot of ~${total} rows across ${Object.keys(counts).length} stores - this may be slow or time out (${'60s'}). Pass --stores a,b,c to scope it to just what you need.`);
            }
          } catch { /* best-effort - don't block the real snapshot on this */ }
        }
        return request('POST', '/state/snapshot', { agent: agentFlag, stores, golden: goldenValue, where: whereValue ? JSON.parse(whereValue) : undefined });
      },
      diff: () => request('POST', '/state/diff', { idA: Number(subArgs[0]), idB: Number(subArgs[1]) }),
      'diff-golden': () => request('POST', '/state/diff', { golden: subArgs[0], idB: Number(subArgs[1]) }),
      restore: () => request('POST', '/state/restore', { agent: agentFlag, snapshotId: subArgs[0] ? Number(subArgs[0]) : undefined, golden: goldenValue }),
      put: () => send('idb.put', { store: subArgs[0], row: JSON.parse(subArgs[1]), dryRun: dryRunValue || undefined }),
      // Batch write, one transaction - a single failed row (e.g. a unique-
      // index conflict) is reported per-row (see idb.putMany's own
      // failed:[{index,row,error}]), not an all-or-nothing abort. Replaces
      // a shell loop of separate "idb put" calls, each its own shell-quoted
      // JSON arg - confirmed real friction seeding a handful of fixture rows
      // by hand, including a `for` loop whose overall exit code came back 1
      // from an unrelated `grep` pipeline despite every write succeeding.
      'put-many': () => send('idb.putMany', { store: subArgs[0], rows: JSON.parse(subArgs[1]), dryRun: dryRunValue || undefined }),
      // Merge-then-write: reads the existing row, shallow-merges the given
      // JSON patch onto it, writes the merged row back - replaces re-typing
      // a whole row (idb.put's real REPLACE semantics) for a 2-3 field
      // change (e.g. maturing an execution window, flipping outcome_status).
      // Requires an existing row at <json-key> - errors rather than
      // silently inserting a sparse row if the key doesn't already exist.
      patch: () => send('idb.patch', { store: subArgs[0], key: JSON.parse(subArgs[1]), patch: JSON.parse(subArgs[2]) }),
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
      // Arms response-BODY capture (fetch/XHR) for entries whose URL
      // contains <substr> - net.log/net.wait/net.history entries gain a
      // bodyPreview (capped 4000 chars, bodyTruncated says whether anything
      // was cut) going forward. Off by default; `--off` disarms it.
      // Replaces hand-patching window.fetch via `eval` to see a raw AI-
      // provider response body that fail-closed validation would otherwise
      // discard with no trace (e.g. cfi_cognitive_runs.result: null on
      // AI_RESPONSE_INVALID).
      capture: () => send('net.setBodyCapture', offValue ? { off: true } : { filter: subArgs[0] }),
    },
    console: {
      log: () => send('console.log', {}),
      clear: () => send('console.clear', {}),
      // Attach-and-wait for a console entry containing a substring, instead
      // of a blind sleep+"console log"-poll loop - the same fix, same
      // reason, as net.wait: a poll called right after triggering an action
      // can race the app's own (often async) console.error call, reading as
      // "nothing logged yet" even though the entry lands a moment later.
      wait: () => send('console.wait', { substr: subArgs[0], timeoutMs: timeoutValue !== undefined ? Number(timeoutValue) : undefined, graceMs: graceValue !== undefined ? Number(graceValue) : undefined }),
    },
    debug: {
      // Introspection shortcut for THIS tool's own runtime state (WebSocket
      // readyState, pending event-batch sizes, reconnect backoff) plus an
      // app-declared `window.__appDebug` object if the app itself sets one -
      // exists to shrink the manual "add a console.error, bump the
      // importer's ?v=, reload, read the log, remove it, bump again" cycle
      // that was the single biggest confirmed time-sink debugging a real
      // session's live state.
      state: () => send('debug.state', {}),
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
  // See relay.mjs's verifyAfterTimeout()/dispatchTracked - a 504 on
  // dom.click/dom.clickWait/dom.fill/idb.put/idb.patch does NOT prove the
  // command never ran, only that the reply didn't arrive in time. Surface
  // the best-effort re-check here so a timeout doesn't read as a flat,
  // uninformative failure that just gets retried blind.
  if (err.postTimeoutVerification) {
    console.error('Post-timeout verification (best-effort - does not prove the original command succeeded, only offers a second signal):');
    console.error(JSON.stringify(err.postTimeoutVerification, null, 2));
  }
  process.exitCode = 1;
});
