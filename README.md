# Web-scout

See [`docs/web-scout.md`](./docs/web-scout.md) for the full mechanism,
security model, and evidence-hierarchy guidance, and
[`docs/web-scout-roadmap.md`](./docs/web-scout-roadmap.md) for the
version-by-version rationale behind each round of additions. This file is
the command reference and quickstart - see ["Using this on your own
project"](#using-this-on-your-own-project) below to skip straight to
setup on a project that isn't this repo.

**Terminology - "CRV":** this README and the CLI's own flags (`--strict-crv`,
`session assert`, ...) use "CRV" throughout as this tool's own shorthand for
its core discipline - **declare** a goal, **act**, **capture** state
before/after, **diff** it, treat the diff as the evidence. It is not an
industry-standard term; it started as one private project's internal name
for the workflow and stuck. Wherever you see it below, mentally substitute
"the capture/diff verification discipline."

Dependency-free local relay that gives Codex/Claude Code (or any coding
agent with shell access) full DOM, IndexedDB, and network read/write access
to an already-open, already-activated tab of **any web app you point it
at** - plus a session/action/state log persisted to a local SQLite file, a
**realtime dashboard** (Server-Sent Events push, no
manual refresh needed), console/network capture, an opt-in "strict-CRV"
mode that auto-snapshots/diffs every mutating command, session tags,
Markdown/JSON session reports, named multi-tab support, a click-to-pick
selector helper, best-effort DOM screenshots, a session write-cleanup
ledger, named macros to record + replay a sequence of actions (with a
dashboard step inspector to reorder/remove/resume-from a step), a merged
cross-panel timeline, in-dashboard action filtering, live in-flight action
indicators, cross-session search, an evidence-bundling integration with
`tools/ui-verifier` (Verity UI Relay) for importing its own scenario
results, cross-session Friction Analytics that surface recurring failure
patterns proactively instead of waiting for a human to hit them again, and
safety hardening on both of the tool's most-privileged paths - a
cross-context replay guard on macro run, and a page-side `eval` timeout
with a non-lossy fallback for non-serializable results - a Service-Worker-
aware hard reload plus a through-the-page file freshness check (so a
just-shipped fix is never mistaken for "didn't work" when it's actually
just stale-cached), a snapshot-diff cleanup mode that catches real
UI-driven writes (not just `idb.*` command writes), an `eval` fallback that
accepts a multi-statement body instead of only a single expression, an
`idb.put` response that returns the full stored row so a caller never has
to assume an id `autoIncrement` didn't actually assign, named golden
regression-baseline snapshots diffable from ANY future session, declarative
`session assert` checks against live state (no more re-typing the same
`idb.dump`-and-eyeball check by hand every later phase), a best-effort
`DB_VERSION` drift warning at session start (the connected tab hasn't
re-opened the DB since a migration bump), an automatic failure
screenshot on a failed `dom.click`/`dom.fill`/`dom.wait` (logged as its own
action, so the broken state is on record even after it's gone from the
live tab), CI-safe nonzero exit codes on a failing `session assert`/`macro
run`, a `suite run` command bundling macro/assert/diff-golden steps into
one named, repeatable checklist with a single pass/fail summary, and
`idb restore` to write a persisted snapshot's rows back into IndexedDB (the
write-back half golden snapshots/`idb diff` never had - they could only
ever detect drift, never correct it), and an MCP server (`mcp-server.mjs`)
exposing the same commands as structured, schema-validated tools for any
MCP-capable client (see "MCP server" below), alongside the CLI. It exists
to close a gap every AI-
assisted verification workflow eventually hits: no way to confirm a
before/after IndexedDB mutation, or the actual rendered DOM, without asking
a human to check DevTools by hand - and to make "declare a goal, act,
snapshot before/after, diff, treat the diff as the evidence" a durable,
first-class feature instead of a throwaway script re-invented per project.
(This particular build was hardened against one real private app's own
verification needs, referenced by name in some examples below - the
mechanism itself has no dependency on that app. See "Using this on your own
project" just below.)

**Web-scout is the deliberate opposite of [`tools/ui-verifier`](../ui-verifier/README.md) (Verity UI Relay).**
Verity's own docs state, repeatedly, as explicit non-goals: no application
code injection, no cookies/local storage/JavaScript variables/network
payloads, no raw DOM access, no arbitrary JavaScript execution. Web-scout
does all of those things on purpose. They are separate tools with opposite
trust models - do not assume Verity's safety guarantees apply here, and do
not fold this into Verity's roadmap. Prefer Verity whenever its narrower
observation-only accessibility-tree surface is enough; reach for Web-scout
only when you specifically need DOM internals, IndexedDB state, or network
traffic.

**License:** [MIT](./LICENSE). Built organically against one real app's
verification needs (see `docs/web-scout-roadmap.md` for the version-by-
version reasoning), but its session/action/snapshot/diff model, safety
hardening, and dashboard are meant to generalize - forks and issues welcome,
see [`CONTRIBUTING.md`](./CONTRIBUTING.md) for how to propose one, code
style, and how to add a new command. The dashboard's Settings dialog (About
tab) surfaces the same repo/version info from inside the running tool.

## Using this on your own project

The core mechanism (session -> dispatch DOM/IndexedDB/network commands ->
snapshot/diff -> dashboard) has exactly one real requirement: **a web page
you can add one `<script>` tag to.** Everything else is optional.

1. **Vendor the tool.** Copy `tools/web-scout/` into your repo (it's
   zero-dependency Node - no `npm install` step). A proper installable
   package is on the roadmap; for now, copy-and-commit is the supported
   path.
2. **Load the in-page agent, dormant by default.** Add to your app's entry
   HTML:
   ```html
   <script src="/tools/web-scout/inject.js"></script>
   ```
   It does nothing unless the page was opened with `?webscout=1` (or
   `localStorage.webscout_enabled` is already set from a prior visit) - see
   `inject.js`'s own top-of-file comment for the exact activation check. No
   framework assumption: it talks to the DOM and `window.indexedDB`
   directly, so it works whether your app is React, vanilla JS, or anything
   else that ends up with a real DOM and (optionally) IndexedDB in the
   browser.
3. **Start the relay and declare a session** - see "Starting it" below.
   `session start "<goal>" "<context>"` is the only required step before any
   `dom.*`/`idb.*`/`net.*`/`eval` command will be accepted.
4. **Everything past that is opt-in:**
   - No IndexedDB at all? Every `idb.*` command and snapshot/diff feature
     simply has nothing to operate on - skip them, `dom.*`/`net.*`/`eval`
     still work standalone.
   - `--strict-crv` (auto-snapshot/diff around every mutation) is a
     discipline you can turn on or just never mention.
   - The `DB_VERSION` drift banner silently no-ops if there's no
     `js/db.js` exporting a `DB_VERSION` constant at your repo's root-level
     `js/` directory - it's a convenience for one specific project layout,
     not a requirement (see "Configuration" below for the exact path it
     looks for).
   - `POST /ask` (Ask AI) needs a backend implementing one trivial contract
     - see "Ask AI" below - or just don't use that one feature.
   - Friction Analytics, `session assert`, golden snapshots, and macros all
     activate the moment you use them and stay silent otherwise.
5. **Any coding agent with a shell tool can drive it** by invoking
   `node tools/web-scout/cli.mjs <command>` - this works with Claude Code,
   Codex CLI, Cursor, Aider, or a human at a terminal identically, since
   it's plain argv/stdout, not a Claude-specific integration. An MCP server
   (below) is the structured-schema alternative for MCP-capable clients.

## MCP server

`tools/web-scout/mcp-server.mjs` exposes the same relay API as
`cli.mjs`, over stdio JSON-RPC (Model Context Protocol) instead of shell
argv - an MCP-capable client gets a typed tool list via `tools/list`
instead of having to compose CLI flags correctly from this README. It's a
thin translation layer with no new logic: every tool handler calls the same
relay routes, and the same shared helpers from `client.mjs`, that `cli.mjs`
already does.

**Register it:**

```bash
# Claude Code (project-scoped - lands in .mcp.json, shared with your team)
claude mcp add --transport stdio web-scout -- node tools/web-scout/mcp-server.mjs

# Codex CLI
codex mcp add web-scout -- node tools/web-scout/mcp-server.mjs
```

The relay (`node tools/web-scout/relay.mjs`) must already be running -
this process does not spawn or manage it; a clear "cannot reach the relay"
tool error is what you get instead of a silent hang or a background
process nobody remembers to kill.

**Tool shape:** grouped by namespace, not one MCP tool per CLI subcommand -
`webscout_dom {action, params}`, `webscout_idb {action, params}`, etc. (9
namespace tools, plus `webscout_eval` which takes `{expr|filePath,
timeoutMs}` directly with no `action`, since it isn't a fixed verb set) -
~45 individual commands as ~45 individual MCP tool schemas would put a lot
of tool-selection weight on every session's context; each tool's
`description` documents every one of its actions and their exact params,
so a client can call it correctly without a second lookup. `tools/list`
is the authoritative source - the list above may drift from the code, the
running server's own response won't.

**Session model, same constraint as the relay itself:** there is exactly
one "active" session at a time, server-side (`POST /command`'s
`requireActiveSession()`) - `dom.*`/`idb.*` (except snapshot/diff/restore)/
`net.*` (except history)/`console.*`/`eval`/`page.*` all operate against
whichever session is currently active, with no per-call `sessionId`
parameter, because the relay itself has no per-call session routing for
these. Only actions backed by a route that already takes an explicit id
(`webscout_session`'s show/report/cleanup/assert/ask/verity_import,
`webscout_net`'s history) take one.

**Error shape:** a failed tool call (bad params, a `dom.click` that found
no match, the relay saying no) comes back as a normal `tools/call` result
with `isError: true` and the real message in `content` - never a JSON-RPC
protocol-level error, which is reserved for an actually malformed call
(unknown tool/action, bad JSON). The agent gets to see and react to what
actually went wrong, the same as reading a CLI's stderr.

**Not wrapped:** `idb watch` (an indefinite streaming poll with no clean
single request/response mapping - use `idb wait` for a bounded check
instead; a real streaming form would be an MCP `resources/subscribe`
feature, a separate future addition).

Verify it yourself: `mcp-server.test.mjs` spawns the server as a real
child process and speaks real JSON-RPC over its stdio against the real,
already-running relay - see "Testing" below for the full command (it needs
`--test-concurrency=1` when run alongside `cli.test.mjs`).

## Mechanism

```text
tools/web-scout/inject.js (loaded from your app's entry HTML, DORMANT by default)
        |  activates only with ?webscout=1 or localStorage.webscout_enabled=1
        |  optional ?webscout_name=NAME for a second/third concurrent tab
        v
WebSocket -> tools/web-scout/relay.mjs (Node, binds 127.0.0.1 only)
        |         |
        |         +--> tools/web-scout/db.mjs (node:sqlite, webscout.db)
        |         +--> tools/web-scout/ai.mjs (POST to a pluggable AI backend, optional)
        |         +--> tools/web-scout/report.mjs (Markdown/JSON session reports)
        |         +--> GET /dashboard (dashboard.html, realtime via GET /events SSE)
        ^
        |  HTTP: POST /command, /sessions, /state/*, /ask ...
        |
tools/web-scout/client.mjs (shared request/session-history/suite helpers)
        ^                    ^
        |                    |
tools/web-scout/cli.mjs      tools/web-scout/mcp-server.mjs
  <-- shell argv/stdout        <-- stdio JSON-RPC (MCP) - see "MCP server" above
  (any agent's Bash tool)      (an MCP-capable client's native tool-call)
```

1. Your entry HTML unconditionally loads `inject.js`, but every line below
   its activation check is skipped unless the page was loaded with the flag.
2. When active, `inject.js` opens a WebSocket to `relay.mjs`, installs
   `fetch`/`XMLHttpRequest` wrappers and `console.error`/`console.warn`/
   `window.onerror`/`unhandledrejection` listeners to capture network and
   console activity from that point forward, and batches captured entries
   (flushed every 250ms or at a 25-entry cap) as fire-and-forget WebSocket
   `event` messages - batched at both ends deliberately, since `node:sqlite`
   is synchronous and one `INSERT` per entry would block the relay's whole
   event loop during a bursty page.
3. `relay.mjs` is a hand-rolled (no `ws` package) WebSocket server on top of
   `node:http`, plus an HTTP API and a Server-Sent Events endpoint
   (`GET /events`) that pushes a live "something changed" signal to every
   open dashboard tab after every write. It can hold multiple named agent
   connections at once (one per browser tab, see "Multi-tab" below). Every
   dispatched command, state snapshot, state diff, console/net capture
   batch, and AI question is persisted via `db.mjs` (`node:sqlite`, zero npm
   dependency, built into Node) to `tools/web-scout/webscout.db` - none of
   it lives only in process/page memory, so it survives a relay restart or
   a tab reload.
4. `cli.mjs` is the command-line entry point Claude Code uses via Bash.
   `dashboard.html`, served at `GET /dashboard`, is a self-contained vanilla
   JS/CSS page (no build step) for a human to watch the same data update
   live.

## Required workflow: goal before action

**Every `dom.*`/`idb.*`/`net.*`/`console.*`/`eval` action requires an active
session.** This is not `ui-verifier`'s safety-gate model (which exists to
stop accidental mutation) - it's an evidentiary-discipline gate: every
recorded action must be interpretable later against a stated goal, so there
is no exemption for read-only commands. Calling any action command before a
session exists returns a 409 with a hint to start one.

```bash
node tools/web-scout/cli.mjs session start "confirm P3.7 dynamics run persists a cfi_cognitive_runs row" "verifying the CFI_REGIME layer's write path"
```

### Auto-opening the dashboard

Every `POST /sessions` (i.e. every `session start`) opens
`GET /dashboard` in the OS default browser - so an operator watching over
Claude Code/Codex's shoulder notices Web-scout is in use the moment a
session begins, not only by reading a report afterward. Best-effort: a
headless/CI environment with no browser just logs a warning and continues,
never blocks the session from starting. Set `WEBSCOUT_NO_AUTOOPEN=1` before
starting the relay to disable it (e.g. a long-lived shared relay serving
many short sessions where a new tab per session would be noise).

### Strict-CRV mode

`session start --strict-crv` makes the "goal → act → snapshot before/after
→ diff" discipline automatic and impossible to forget, instead of relying
on remembering to call `idb snapshot` yourself: every `dom.click`/
`dom.fill`/`eval`/`idb.put`/`idb.delete` dispatched in that session is
automatically wrapped in its own before-snapshot, the command, an
after-snapshot, and a diff - each gets its own row in the action log (the
auto-snapshot/auto-diff actions carry `{"auto":true, "triggered_by_action_id": ...}`
in their params, visible in the dashboard's expandable action detail). In a
strict-CRV session, `/command`'s response shape changes from the flat
result to `{data: <actual result>, crv: {before_snapshot_id,
after_snapshot_id, diff_id, diff_summary}}` - non-CRV sessions (the
default) are unaffected.

### Selector picker

`dom click`/`dom fill` resolve via `querySelectorAll`, not
`querySelector`'s silent first match - an ambiguous selector is refused
with a preview of every element it matched, rather than silently acting on
the wrong one (confirmed to happen in practice: a same-shaped button in an
unrelated page section absorbed a click meant for a different one). `dom
pick` attacks this at the source: it arms a one-time, capture-phase click
listener in the real browser and resolves with a robust selector (id, then
`data-*` attributes, then class, then a guaranteed-unique ancestor
`nth-child` path - whichever candidate first resolves to exactly that one
element) for whatever you click next. The click is `preventDefault`'d and
never reaches the app, so picking never triggers real app behavior. Use it
before hand-writing a selector, not after guessing wrong.

**`dom pick` is not a programmatic selector finder - it blocks on a real
human click.** There is no way to feed it a target from a script; it exists
for an operator sitting at the browser to hand a selector to Claude Code/
Codex interactively. In an unattended or scripted pass with no human
present, use `dom query <a-guessed-selector>` and read the returned
`outerHTML` to hand-write a selector instead.

### `dom.click` uses native `.click()`

`dom click` calls the element's real `.click()` method, not a synthetic
`dispatchEvent(new MouseEvent('click'))`. The two are not equivalent: a
synthetic dispatch does not trigger a browser's native "activation
behavior", which matters for elements gated by it (confirmed live - a
button inside a `<dialog>` failed to open the dialog via synthetic dispatch
every time, while `element.click()` via `eval` on the identical element
worked every single time). If a click "does nothing" even though the
selector clearly resolved, this is no longer the cause - it was fixed at
the source rather than worked around per-selector.

### Waiting for quiet, instead of a fixed sleep

Two settle primitives exist for the two different things "wait for it to
be done" can mean:

- `dom settle [selector] [--quiet-ms <ms>] [--timeout <ms>]` waits for a
  `MutationObserver`-detected quiet period under `selector` (default:
  `document.body`) - no mutation for `--quiet-ms` (default 300ms) - generic
  completion detection, distinct from `dom wait`'s specific-selector-
  appears semantics. Use it after an action whose completion has no
  reliable selector to poll for (a re-render, a batch of DOM writes)
  instead of a guessed fixed sleep.
- `net wait <url-substring> [--grace <ms>] [--timeout <ms>]` waits for a
  network request whose URL contains the given substring, resolving on the
  first match that finishes within `--grace` (default 3000ms) of the call
  or while still outstanding (`--timeout`, default 15000ms). Use it after
  triggering an action that fires an async fetch before asserting on its
  result.

Both reject with a diagnostic message (not a bare timeout) if nothing
settles/matches in time.

### Reload, not re-init

`page reload` calls a real `location.reload()`. The activation flag
(`?webscout=1` or `localStorage.webscout_enabled=1`) survives the reload,
so `inject.js` re-activates and reconnects to the relay on its own - no
extra step needed. Prefer this over using `eval` to re-invoke a page
module's own init/render function as a way to force a re-render: repeated
init-function re-calls have been confirmed, in a real session, to stack
duplicate `document`-level event listeners (no removal/dedup guard exists
in the app for this), causing a single real click to fire a handler 3-4x
and write duplicate rows. A true reload doesn't have that failure mode.

### Hard reload (Service Worker + Cache Storage busting)

`page reload --hard` is `page reload` plus, first, unregistering every
Service Worker registration and deleting every Cache Storage entry the page
can see. A plain reload is **not** enough on a page served behind a
stale-while-revalidate Service Worker (this repo's own `sw.js` is one
example - the same problem hits any app using that caching pattern): such a
worker answers `fetch` from its own Cache Storage before the request ever
reaches the network/HTTP-cache layer, so it can keep serving OLD bytes for
a just-edited file across several plain reloads while silently refreshing
its cache in the background - confirmed live in a real session, where a
genuine timeout-constant fix stayed invisible for multiple reload attempts
until an explicit `serviceWorker.getRegistrations()` unregister +
`caches.delete()` pass (exactly what this command now automates) was run
by hand. Reach for `page reload --hard` any time you've just edited a file
this app's Service Worker might have cached and a plain reload doesn't
appear to reflect it.

### Freshness check

`page fresh <local-file-path> [--url </served/path>]` answers "is the tab
actually running what's on disk" directly, instead of the fetch-a-URL-and-
grep-the-response-for-a-marker-string dance that question used to take.
It fetches the given path **through the page** (`fetch(path, {cache:
'no-store'})` - the page's own real cache/Service-Worker stack, not a bare
disk read) and SHA-256s the bytes, then does the same for the local file on
disk, and reports both hashes plus `fresh: true/false`. A `false` result on
a file the Service Worker precaches is the signal to run `page reload
--hard` before continuing - see "Hard reload" above.

```bash
node tools/web-scout/cli.mjs page fresh js/capital-cognitive-provider-ai-council.js
```

### Golden snapshots (regression baseline)

`idb snapshot --stores a,b,c --golden <name>` tags a persisted snapshot
with a name instead of just an id - diffable from **any future session**,
not only two ids captured within the same one. Re-tagging the same name
just makes the latest-by-id snapshot win (no delete needed to re-baseline).
`idb diff-golden <name> <idB>` resolves the golden snapshot by name and
diffs it against snapshot `<idB>`, answering "did this later phase touch
anything `<name>` already proved untouched" without hunting down an old
snapshot id by hand - a durable regression baseline for the same
byte-identity discipline this project's own test suite already leans on
hard (see `js/capital-ontology-rules.test.js`'s own byte-identity block).

```bash
node tools/web-scout/cli.mjs idb snapshot --stores capital_flow_interventions,cfi_state_history --golden p4-baseline
# ...later, in a different session, after more work...
node tools/web-scout/cli.mjs idb snapshot --stores capital_flow_interventions,cfi_state_history
node tools/web-scout/cli.mjs idb diff-golden p4-baseline 42
```

### Regression assertions

`session assert <id> '<checks-json>'` runs declarative checks against
**live** state - a single check object or a JSON array of them:

```json
{"store": "cfi_variable_registry", "where": {"id": 3}, "count": 1, "field": "integration_status", "equals": "MEASUREMENT_ONLY"}
```

`where` (exact-equality field map, optional) filters which rows count;
`count`/`countGte`/`countLte` check the matched-row count; `field`+`equals`
checks a field on the first matched row. Dispatches exactly one `idb.dump`
per distinct store named across all checks (cached, not re-dumped per
check), and is logged as its own `session.assert` action - a real, replayable
proof-of-state instead of a human re-typing the same `idb.dump`-and-eyeball
check by hand every later phase.

### Snapshot restore

`idb restore <snapshotId>` (or `idb restore --golden <name>`) is the
write-back half golden snapshots/`idb diff` never had - both of those only
ever **detect** drift, neither can **correct** it. Restore replays every
row in the snapshot's stores back into IndexedDB via one `idb.put` per row
(each individually logged, `via: "restore"`, so a partial failure still
shows exactly which rows did and didn't make it back). Deliberately
**additive-only**: it never deletes a row added since the snapshot was
taken - a real replace, not a merge, needs an explicit `idb.clear` per
store first.

```bash
node tools/web-scout/cli.mjs idb snapshot --stores skills --golden p4-baseline
# ...later, after some rows got mutated by a bad run...
node tools/web-scout/cli.mjs idb restore --golden p4-baseline   # resets skills back to the baseline
```

### Suite runner

`suite run <path-to-suite.json>` bundles a checklist of already-existing
primitives - `macro run`, `session assert`, `idb diff-golden` - into one
named, repeatable sequence with a **single pass/fail summary**, instead of
several manual calls re-typed by hand every phase. The suite file is a
plain JSON array (no relay-side storage, unlike a macro - it's a checklist
written by hand once, not drawn from a session's own action log):

```json
[
  {"type": "macro", "id": 7},
  {"type": "assert", "checks": {"store": "cfi_variable_registry", "countGte": 1}},
  {"type": "diff-golden", "name": "p4-baseline", "idB": 42}
]
```

A `diff-golden` step defaults to expecting a **clean** diff (proving
nothing else moved); pass `"expectClean": false` when drift is the actual,
desired outcome of that step. Stops at the first failing step unless
`--continue-on-error`. Exits 1 if any step - or the whole suite - didn't
pass.

```bash
node tools/web-scout/cli.mjs suite run ./checks/p4-shadow-trial.suite.json
```

### Exit codes (scripting/CI)

`session assert` and `macro run` now exit **1** (not 0) when the result's
own `passed:false`/a failing step is present - previously both always
printed their result and exited 0 regardless, so a script or CI step had
to parse stdout itself to notice a failure. `suite run` follows the same
convention. Every other command's existing behavior (a thrown error exits
1, e.g. a 409 from no active session) is unchanged.

### Startup health check (`DB_VERSION` drift)

`session start` now does a **best-effort, non-blocking** check: if
`js/db.js` is readable from the current working directory and a tab is
already connected, it compares the tab's LIVE `IndexedDB` connection
version against `js/db.js`'s own `DB_VERSION` constant, and warns (never
blocks) on a mismatch. Catches "the migration was bumped in source but this
tab never re-opened the DB" before a whole CRV pass gets run against a
stale schema - the schema-level sibling of the freshness check above (which
answers the same question for a source *file* instead of the DB connection
version). Fix: `page reload` (or `page reload --hard`).

### Screenshots

`dom screenshot [selector]` is a **best-effort**, zero-dependency DOM
rasterization (the SVG-`foreignObject` technique: clone the target,
inline every element's `getComputedStyle().cssText` onto the clone since a
`foreignObject` does not inherit the host document's stylesheets once
serialized standalone, serialize to an SVG data URL, draw it to a canvas,
export PNG). This is a normal page-side script, not a browser-automation
process - there is no CDP/compositor screenshot API available here the way
Playwright/Puppeteer has one. Known limitations, stated plainly: cross-
origin images/fonts can taint or fail to rasterize the canvas, iframes are
not captured, and some CSS won't round-trip through `cssText` perfectly.
Good enough for "does this look roughly right" and for attaching visual
evidence to a session report; not a pixel-perfect visual-regression tool.
Confirmed live against this repo's own app: its real page fails this
rasterization (`Tainted canvases may not be exported`, likely a webfont) -
so `dom.click`/`dom.fill`/`dom.wait`'s auto-screenshot-on-failure (next
paragraph) can itself legitimately come back `ok:false` here; that's still
useful signal, not a bug in the capture attempt.

A **failed** `dom.click`/`dom.fill`/`dom.wait` auto-captures a
`dom.screenshot` of the target selector as its own separate logged action
(not attached to the failed row - the action log is append-only) -
previously this was a manual, opt-in-after-the-fact step, and the broken
state is often gone by the time a human goes looking for it by hand. Logged
either way (success or failure of the capture itself), so a tainted-canvas
failure like the one above is still visible evidence, not silence.

### Network history (durable, vs. the in-page ring buffer)

`net log` reads `inject.js`'s in-page ring buffer, capped at 500 entries -
under a background-noisy page (polling, analytics beacons) that buffer can
evict a request you actually cared about before you ever call `net log`.
`net history [--filter <substr>] [--min-duration <ms>] [--sort duration]
[--limit N] [--session <id>]` instead reads the durable `net_entries` table
(already persisted+realtime for the dashboard's Network panel, but not
previously exposed to the CLI) - every captured request for a session,
survives the ring buffer's eviction, filterable/sortable/limited without a
separate `jq` pass. Defaults to the active session; pass `--session` to
inspect a past one.

### Live watch

`idb watch <store>` re-checks a store's row count every time the relay's
own `GET /events` (SSE) feed signals that *something* changed, instead of
polling on a fixed interval - genuinely push-triggered, even though the
recheck itself is still a normal `idb.dump` call. Prefer `idb wait` (a
single poll-until-condition round trip) when you know what you're waiting
for and want one result back; prefer `idb watch` when you want to observe
a store live across several unrelated actions (e.g. while manually
clicking around in the browser).

### Macros (record/replay)

A macro is a named, saved subset of one session's own already-logged
actions - nothing new is recorded specially; every `dom`/`idb`/`page`/
`eval` action was already persisted to that session's action log the
moment it ran. `macro record "<name>" <sessionId>` pulls that session's
`ok:true` actions, keeps only the replayable types (`dom.click`,
`dom.fill`, `dom.wait`, `idb.wait`, `idb.put`, `idb.delete`,
`idb.deleteMany`, `idb.clear`, `page.reload`, `eval` - pass `--all` to
include read-only ones too), and saves them as an ordered step list.
`macro run <id>` replays those steps, in order, against the **currently
active session** (not the one it was recorded from - macros don't
implicitly create or reuse a session, matching the same "context before
action" discipline as every other command); it stops at the first failing
step unless `--continue-on-error`. A macro replay does **not** get
strict-CRV's automatic before/after snapshot+diff wrapping even in a
strict-CRV session - each step dispatches directly, not through
`/command`'s strict-CRV branch. See the benefit write-up in
`docs/web-scout-roadmap.md`'s V4 entry for why this exists.

### Verity UI Relay integration

Web-scout and [`tools/ui-verifier`](../ui-verifier/README.md) (Verity UI
Relay) stay deliberately separate tools with opposite trust models (see
"Relationship to Verity UI Relay" in `docs/web-scout.md`) - this is evidence
*bundling*, not a merge. Verity's own `scenario` command persists nothing on
its own; `verity import <sessionId> <path-to-result.json>` folds a saved
result into a web-scout session's own evidence trail (visible in the
dashboard's **Timeline** and **Verity UI checks** panel, and in the
session's exported report's own "Verity UI checks" section) - `sessionId`
is explicit, not "the active session," since importing evidence to finish
an already-ended session's report is a real, expected use.
`session report <id> --verity <path>` is shorthand for import-then-export
in one call. `macro export-verity <id>` emits a **best-effort skeleton**
Verity scenario JSON from a macro's `dom.click`/`dom.wait` steps (selectors
left as `TODO`, with the original CSS selector kept as a `_web_scout_hint`
- there is no reliable CSS-selector-to-UIA-selector translator, so this
saves retyping the step skeleton, not the judgment call of picking a real
selector); `dom.fill`/`idb.*`/`eval`/`page.reload` steps have no Verity
equivalent (Verity has no generic "set a field's value" action at all) and
are skipped, listed in the output rather than silently dropped.

### Safety hardening (macro replay, eval)

Five fixes closing gaps found by auditing the tool's own recent rounds
(full rationale in `docs/web-scout-roadmap.md`'s V8 entry):

- **Macro cross-context replay guard.** `macro run`/"Run" in the dashboard
  now refuses (409) when the currently active session's goal has low
  word-overlap with the macro's own recorded-from session's goal - a macro
  recorded for "delete synthetic test rows" no longer silently runs against
  an unrelated real session just because that session happens to be active.
  Pass `--confirm` (CLI) or confirm the dashboard's prompt to override once
  you've checked `macro show <id>`.
- **`eval` page-side timeout.** `timeoutMs` (default 10000ms) races the
  expression - an unresolved `await` now produces a clear diagnostic
  instead of masquerading as the relay's own generic "command timed out"
  with nothing pointing back at `eval`. This cannot and does not claim to
  interrupt a genuine synchronous infinite loop (`while(true){}`) - JS is
  single-threaded, so that freezes the tab regardless; the timeout message
  itself says so when it *can* fire.
- **`eval` accepts a statement body, not just a single expression.** `expr`
  is first tried as a bare expression (`1+1`, `document.title`); multiple
  `;`-separated statements are not valid there (`(a; b)` is a
  `SyntaxError`), which previously surfaced as a bare "Unexpected token
  ';'" with no hint, forcing a hand-wrapped IIFE every time. A
  `SyntaxError` now triggers a fallback attempt treating `expr` as a
  function **body** instead (ordinary statements, with an explicit
  `return` if you want a value back) - the IIFE-wrapping is now automatic.
  A statement body has no implicit return, so one with no explicit
  `return` silently yields `undefined` - indistinguishable from a real bug
  without a hint. When that fallback path produced `undefined` and `expr`
  contains no `return`, the response now carries an extra `__note` field
  saying so, rather than leaving you to guess whether the expression was
  wrong or just missing a `return`.
- **`eval --file <path>`** reads `expr` from a local file instead of the
  shell argument - avoids hand-escaping quotes/newlines for a multi-line
  script through the shell's own quoting rules.
- **`eval`'s non-JSON-safe fallback is no longer silently lossy.** A DOM
  element, `Map`/`Set`, circular reference, or `BigInt` used to come back
  as a bare `String(result)` - indistinguishable from real evidence. Now
  returns `{"__unserializable": true, typeofResult, constructorName,
  stringified}` so the caller knows a substitution happened.
- **Friction Analytics is now cache-backed** (server-side, 5s TTL) instead
  of a full table scan on every open dashboard tab's every 3-second poll -
  the exact "invisible until the dataset grows" shape this tool has seen
  before.
- **One malformed action row no longer breaks Friction Analytics
  globally.** `listAllActions()` now parses each row's JSON independently
  and skips (never throws on) a corrupted one; the response's
  `malformedActionsSkipped` count is surfaced in the dashboard's "Known
  friction" banner instead of the whole banner just silently disappearing.

### Friction Analytics

Every prior improvement round (see `docs/web-scout-roadmap.md`) got built
the same reactive way: a human hit friction in one session, reported it,
and a fix shipped for that one thing. `GET /analytics`/`cli.mjs analytics`
instead reads the data this tool has already been recording since V1 -
`ok`/`error` per action, macro-run tags, Verity pass/fail - across **every**
session at once (the one deliberate exception to every other route's
session-scoped evidentiary gate), and surfaces recurring patterns: failure
rate by action type, selectors that failed more than once (a one-off miss
is normal; a repeat is the "hit the same wall again" pattern this exists
to catch), macros recorded but never replayed, macros replayed but never
once succeeding (a real, otherwise invisible rot mode for "record once,
replay forever"), and Verity labels whose latest import is still FAIL. The
dashboard renders the top 3 of each as a dismissible "Known friction"
banner above the session picker, loaded on page load and refreshed on the
existing 3-second poll - global, not scoped to whichever session happens
to be selected. Run `analytics` before starting new work, not only after
hitting a wall - see the V7 entry in the roadmap for why this exists.

### Session cleanup

Two independent modes, since neither alone is complete:

- `session cleanup <id>` (dry-run by default; `--confirm` to actually
  delete) walks a session's own logged `idb.put`/`idb.delete`/
  `idb.deleteMany`/`idb.clear` actions and computes exactly which rows are
  still live and were written by that session - so cleaning up synthetic
  test data doesn't mean hand-tracking every key you wrote (confirmed
  tedious in a real session: 12 rows deleted one CLI call each). It is
  **blind to any write made outside those 4 command types** - both `eval`
  (opaque expression, no structured store/key to recover - flagged as a
  count, not tracked) and, more consequentially, **every write made by
  clicking a real UI button** (a promote/observe/create-trial button that
  runs `someCrud.add(...)` inside the page's own code gets no signal at
  all here). Most real writes in a CRV pass are exactly that second shape.
- `session cleanup <id> --since-snapshot <snapshotId> [--confirm]` instead
  takes a fresh snapshot scoped to the same stores as that earlier
  persisted snapshot, diffs it, and treats every row **added** to **any**
  of those stores since then - however it was written, button click or
  `eval` or `idb.put`, it doesn't matter - as a pending delete. This is
  what actually catches UI-driven writes. Rows merely **changed** (not
  added) since the baseline are reported separately and never
  auto-deleted, since a changed row is an edit to pre-existing data, not
  something cleanup should guess at reverting. Needs a real snapshot id
  taken *before* the writes you want to clean up (`idb snapshot --stores
  ...`), and only covers the stores that snapshot covered.

## Starting it

```bash
# 1. Start the relay (leave running in its own terminal)
node tools/web-scout/relay.mjs

# 2. Load the app with the activation flag (once per session is enough -
#    it persists across reloads via localStorage)
#    http://localhost:<your-dev-port>/index.html?webscout=1

# 3. Confirm the agent connected
node tools/web-scout/cli.mjs status

# 4. Declare a goal - required before any action command
node tools/web-scout/cli.mjs session start "<goal>" "<context>"
```

To turn Web-scout itself off (the page-side agent): `localStorage.removeItem('webscout_enabled')` in the page console, or just don't pass the flag - `inject.js` still loads but does nothing.

### Configuration (env vars)

All server-side configuration is env-driven, read once at process start
(except where noted) - there is no config file:

| Var | Default | Effect |
| --- | --- | --- |
| `WEBSCOUT_PORT` | `8973` | Relay's HTTP/WebSocket port. Fixed for the process's lifetime - changing it requires a restart. |
| `WEBSCOUT_HOST` | `127.0.0.1` | Used by `cli.mjs` to reach the relay; the relay itself always binds `127.0.0.1` only (see Security model below), never configurable to `0.0.0.0`. |
| `WEBSCOUT_NO_AUTOOPEN` | unset | Set to `1` to stop `session start` from auto-opening the dashboard in a browser tab. |
| `WEBSCOUT_AI_BACKEND_URL` | `http://127.0.0.1:8000/api/cfi/cognitive/analyze` | Where `POST /ask` (Ask AI) sends its prompt. Unlike the others, this one is re-read on every call - it can also be changed live, with no restart, from the dashboard's **Settings > Server config** tab (`GET`/`PUT /config`), which is a session-only override (it doesn't persist past a relay restart unless you also set the env var). |
| `WEBSCOUT_DB_PATH` | `tools/web-scout/webscout.db` | Relocates the SQLite file `db.mjs` opens. Mainly for `db.mjs.test.mjs` (points it at a throwaway file instead of your real session history), but works for any deployment that wants the DB elsewhere. |

The dashboard's **Settings** menu (gear/"Settings" button, top-right of the
header) surfaces all of the above as a read-only view, plus the live-editable
`WEBSCOUT_AI_BACKEND_URL` override - see "Settings" under Dashboard below.

## Commands

```bash
node tools/web-scout/cli.mjs session start "<goal>" ["<context>"] [--strict-crv] [--tags a,b,c]
node tools/web-scout/cli.mjs session end [id]         # defaults to the active session
node tools/web-scout/cli.mjs session current
node tools/web-scout/cli.mjs session list
node tools/web-scout/cli.mjs session show <id>         # session + actions + snapshots + diffs + console + net + qa
node tools/web-scout/cli.mjs session report <id> [--format md|json] [--out <path>]
node tools/web-scout/cli.mjs session cleanup <id> [--confirm]                      # action-log mode
node tools/web-scout/cli.mjs session cleanup <id> --since-snapshot <id> [--confirm] # snapshot-diff mode - also catches UI-driven writes, see "Session cleanup" below
node tools/web-scout/cli.mjs session assert <id> '[{"store":"skills","countGte":1}]'  # declarative live-state checks, see "Regression assertions" above

node tools/web-scout/cli.mjs dom query "#cflow-superior-move"
node tools/web-scout/cli.mjs dom pick [--timeout 15000]        # click any real element -> get its selector back, see "Selector picker" below
node tools/web-scout/cli.mjs dom click ".cflow-cognitive-role-btn[data-cognitive-layer=CFI_ONTOLOGY][data-cognitive-role=CRITIC]"   # native el.click(), see "dom.click uses native .click()" below
node tools/web-scout/cli.mjs dom click ".some-ambiguous-selector" --nth 1   # selector matched >1 element - error lists a preview of each, pick one
node tools/web-scout/cli.mjs dom fill "#some-input" "value"
node tools/web-scout/cli.mjs dom rect "#some-panel"                # bounding box
node tools/web-scout/cli.mjs dom style "#some-panel" display,width  # computed style (curated defaults, or a given list)
node tools/web-scout/cli.mjs dom wait "#cflow-ontology-result" --text "ELIGIBLE" --timeout 20000  # poll until a SPECIFIC selector/text appears
node tools/web-scout/cli.mjs dom settle --quiet-ms 300 --timeout 10000   # poll until the whole document goes quiet - see "Waiting for quiet" below
node tools/web-scout/cli.mjs dom screenshot "#cflow-ontology-candidates" --out /tmp/candidates.png  # best-effort DOM rasterization, see "Screenshots" below

node tools/web-scout/cli.mjs idb list
node tools/web-scout/cli.mjs idb dump cfi_cognitive_runs
node tools/web-scout/cli.mjs idb put cfi_cognitive_runs '{"id":1,"status":"OK"}'   # scoped write - response includes the full stored row (key merged in)
node tools/web-scout/cli.mjs idb delete cfi_cognitive_runs 1                        # scoped delete by key
node tools/web-scout/cli.mjs idb delete-many cfi_cognitive_runs '[1,2,3]'           # bulk delete, one transaction
node tools/web-scout/cli.mjs idb clear cfi_cognitive_runs                           # delete every row in a store
node tools/web-scout/cli.mjs idb wait cfi_cognitive_runs --count-gte 4 --timeout 15000   # poll a row count instead of a hand-rolled bash loop
node tools/web-scout/cli.mjs idb watch cfi_cognitive_runs --count-gte 4             # push-triggered (via SSE), not interval-polled - see "Live watch" below

# The mutation-check pattern this tool exists for - now durable, not
# ephemeral: every snapshot/diff below is persisted to webscout.db. In a
# --strict-crv session this happens automatically around every dom.click/
# dom.fill/eval/idb.put/idb.delete/idb.deleteMany/idb.clear - the manual
# form below is still useful for a non-CRV session or a custom checkpoint.
node tools/web-scout/cli.mjs idb snapshot             # -> { id: 1, counts, byteSize } - every store
node tools/web-scout/cli.mjs idb snapshot --stores cfi_ontology_candidates,cfi_variable_registry   # scoped - avoids the full-DB timeout on a large real app (100+ stores)
# ... trigger the action under test (a button click, a page action) ...
node tools/web-scout/cli.mjs idb snapshot             # -> { id: 2, ... }
node tools/web-scout/cli.mjs idb diff 1 2             # -> per-store added/removed/changed rows, keyed by each store's REAL keyPath (not every store uses 'id' - see js/db.js)
node tools/web-scout/cli.mjs idb snapshot --stores skills --golden p4-baseline  # named regression baseline, diffable from ANY future session
node tools/web-scout/cli.mjs idb diff-golden p4-baseline 2                     # -> same diff shape, resolved by name instead of an id you'd have to remember
node tools/web-scout/cli.mjs idb restore --golden p4-baseline                  # write the baseline's rows back into IndexedDB - see "Snapshot restore" below

node tools/web-scout/cli.mjs net log                  # in-page ring buffer (500 cap) - also persisted+realtime, see below
node tools/web-scout/cli.mjs net wait "/api/cfi/" --grace 3000 --timeout 15000   # poll until a matching request lands, see "Waiting for quiet" below
node tools/web-scout/cli.mjs net history --min-duration 5000 --sort duration --limit 20   # durable net_entries, survives the ring buffer's eviction - see "Network history" below
node tools/web-scout/cli.mjs net clear

node tools/web-scout/cli.mjs console log               # captured console.error/warn + uncaught error/rejection entries
node tools/web-scout/cli.mjs console clear

node tools/web-scout/cli.mjs page reload                # true location.reload() - prefer this over re-invoking a page module's own init function via eval, see "Reload, not re-init" below
node tools/web-scout/cli.mjs page reload --hard          # also unregisters every Service Worker + clears Cache Storage first - see "Hard reload" below
node tools/web-scout/cli.mjs page fresh js/capital-cognitive-provider-ai-council.js   # is the tab running what's on disk? see "Freshness check" below

node tools/web-scout/cli.mjs eval "document.title"
node tools/web-scout/cli.mjs eval "new Promise(() => {})" --timeout 3000   # demonstrates the page-side timeout diagnostic
node tools/web-scout/cli.mjs eval "const a = 1; const b = 2; return a + b;"   # multi-statement - no IIFE-wrapping needed, see "Safety hardening" below
node tools/web-scout/cli.mjs eval --file ./scripts/probe.js   # read expr from disk instead of shell-quoting a multi-line script

# Ask an AI about the session's recorded actions/snapshots/diffs - answer
# and the exact prompt sent are persisted to the session's Q&A log.
node tools/web-scout/cli.mjs ask "what changed between snapshot 1 and 2, and does that satisfy the session's goal?"
node tools/web-scout/cli.mjs ask --session 3 "..."     # ask about a past (possibly ended) session instead of the active one

node tools/web-scout/cli.mjs macro record "propose-review-promote" 7   # save session #7's replayable actions as a named macro
node tools/web-scout/cli.mjs macro list
node tools/web-scout/cli.mjs macro run 1                # replay against the CURRENTLY active session - see "Macros" below
node tools/web-scout/cli.mjs macro run 1 --from-step 3  # resume after fixing whatever made step 3 fail - skips steps 0-2
node tools/web-scout/cli.mjs macro run 1 --confirm      # override the cross-context replay guard - see "Safety hardening" below
node tools/web-scout/cli.mjs macro delete 1

node tools/web-scout/cli.mjs search "cfi_ontology_candidates"   # cross-session: which session/action touched this - see "Dashboard" below

node tools/web-scout/cli.mjs verity import 7 ./run1-result.json --label "post-promote check"   # fold a Verity scenario result into session #7 - see "Verity UI Relay integration" below
node tools/web-scout/cli.mjs session report 4 --verity ./run1-result.json   # shorthand: import, then export in one call
node tools/web-scout/cli.mjs macro export-verity 2 --out ./scenario-stub.json   # best-effort Verity scenario skeleton from a macro's dom.click/dom.wait steps

node tools/web-scout/cli.mjs suite run ./checks/p4-shadow-trial.suite.json     # bundled macro/assert/diff-golden checklist, one pass/fail summary - see "Suite runner" below

node tools/web-scout/cli.mjs analytics                 # "Friction Analytics" across EVERY session - see "Friction Analytics" below

node tools/web-scout/cli.mjs agents                    # list currently connected agent (tab) names
node tools/web-scout/cli.mjs dashboard                 # prints the dashboard URL - open it in a browser
```

Every `dom`/`idb`(non-snapshot)/`eval`/`page` subcommand also accepts a
global `--agent <name>` flag (anywhere in its own arguments) to target a
specific tab - see "Multi-tab" below. All commands return JSON on stdout; a
failure prints to stderr (with a "start a session first" hint on a 409) and
exits nonzero.

## Dashboard (realtime)

`node tools/web-scout/cli.mjs dashboard` prints `http://127.0.0.1:8973/dashboard`
(served directly by the relay, no separate process). Open it in a browser
to see: a dismissible **DB_VERSION drift** banner (top of the page - see
below), a dismissible **Known friction** banner (top of the page, global
across every session - see "Friction Analytics" above), connected-agent
status, a session picker with a tag filter, the
selected session's goal/context/tags, a **Timeline** merging actions/
snapshots/diffs/console/net into one chronological lane, its full action
log (filterable by type/ok-fail/text search, expandable params/result per
row including auto-CRV rows, with a live "running..." row for an in-flight
`dom.wait`/`idb.wait`/`dom.pick` instead of a dead-looking screen during its
poll), a **Regression checks** panel (every `session assert` run for the
selected session, rendered as a dedicated pass/fail card per run with each
check's own detail line - previously this only showed up as a generic
Action-log row of raw JSON, no dedicated view for a feature whose whole
point is regression-checking), its state-snapshot timeline (row counts by
default - a large snapshot warns before rendering the full dump inline, a
golden-tagged snapshot's `taken_at` cell carries a `golden: <name>` badge so
a regression baseline is visible without opening every row), its diffs
(summary counts color-coded added/removed/changed, expandable to the full
per-store rows), live **Console** and **Network** panels, a **Macros**
panel (record the selected session's replayable actions by name, run or
delete any saved macro, expand a macro to reorder/remove a step or replay
from a chosen step), a **Verity UI checks** panel (import a saved Verity
`scenario` result JSON file, per-session - see "Verity UI Relay
integration" above), a global **cross-session search** box (top of the
page - searches every session's own action log by type/params/result/
error, click a hit to jump to that session), a report-export button, and
an Ask-AI box with that session's running Q&A history. A `dom.screenshot`
action's result renders as an inline thumbnail in the action log instead
of dumping its (large) base64 data URL as raw JSON.

The **DB_VERSION drift** banner is the dashboard-visible half of the same
check "Startup health check" (below) already runs at `session start` -
that CLI warning only ever reached whoever was watching the terminal, not
whoever was watching the dashboard (the discrete "a human should be
watching now" moment this tool auto-opens a browser tab for). `GET /health`
now carries `db_version_drift` (best-effort: `{checked: false}` with no
active session or connected agent; `{checked:true, sourceVersion,
liveVersion, drift}` once both exist), cached 5s server-side same as
Friction Analytics so every open tab's 3s poll doesn't force a real
`db.version` round trip that often. Dismissing it remembers the specific
`sourceVersion:liveVersion` pair - a genuinely NEW drift (a further
migration bump before the old one was ever fixed) re-shows the banner
instead of staying silently dismissed forever.

Updates arrive live via `GET /events` (Server-Sent Events) - the relay
pushes a "something changed" signal after every write (plus a separate
`action_start` signal the instant a command dispatches, before it resolves,
so the dashboard can render the in-flight row), and the dashboard re-fetches
only the affected panel, no manual refresh needed. A 3-second poll stays on
as a lower-frequency fallback in case the SSE connection drops for a while.

The **Network** panel has a sortable **Duration** column (click the header
to toggle newest-first vs. slowest-first) and flags any request at or above
10s in red - previously spotting a slow request meant scanning every row's
raw start/end timestamps by eye.

### Action log: churn and payload fixes for a long session

Two independent problems surfaced during real extended CRV sessions, fixed
separately since they were different bugs:

**The table became unclickable mid-session.** Three refresh triggers -
the SSE push after every action, a 500ms tick repainting the "running..."
row's elapsed time, and the 3s fallback poll - each independently rebuilt
the *entire* action table (every row, from scratch) any time they fired,
and could all fire within the same few hundred milliseconds. A click could
land mid-rebuild on a `<tr>` that had already been torn down and replaced
by a new DOM node, making the row appear unresponsive. This is not a
threading problem (the DOM is inherently single-threaded; a Web Worker
can't touch it regardless) - it's a scheduling/rebuild-churn problem, fixed
with three complementary changes: the SSE/console/net refresh triggers are
now debounced (100-250ms trailing-call coalescing) instead of each firing
its own immediate rebuild; the 500ms elapsed-time tick now patches only the
pending rows' own `<td>` in place instead of rebuilding the whole table;
and the table only ever builds DOM for the most recent 500 rows
(`ACTIONS_RENDER_CAP`), with a truncation notice for the rest - narrow with
the type/status/search filters to reach an older row.

**The tab's memory climbed far past what the table needed.** The action
log re-fetches and re-renders the session's *entire* action history on
every refresh, params/result JSON included - fine for most action types,
but three result shapes run 50-90KB per row in a real session
(`dom.screenshot`'s base64 `dataUrl`, `idb.snapshot`'s full multi-store
dump, `net.log`'s captured-entries array), and paying that cost on every
debounced refresh, repeatedly, compounds fast over a long session. `GET
/sessions/:id/actions` now strips just those three fields from the list
response (`{redacted: true}` in their place, plus a cheap count where one
exists) and serves them in full only from the new `GET
/sessions/:id/actions/:actionId`, fetched lazily the moment a redacted row
is actually expanded (and cached client-side per session, so re-expanding
the same row doesn't re-fetch it). Every other action type's result is
unaffected - this is a size-of-payload fix for 3 known-heavy shapes, not a
blanket "list view is summary-only" change. Pass `?full=1` to get the
untouched rows over HTTP (the CLI's `session show` does this, since a
terminal dump has no lazy-expand step); `?limit=N` caps row count
server-side on the actions/console/net list endpoints alike, instead of
fetching everything and discarding the rest client-side.

### Detail-row state survives a rebuild; ended sessions stop polling

Three more bugs traced to the same root cause during real use: expanding an
action row's detail, then having it silently close a few seconds later
(caused by the 3s poll's full table rebuild simply not knowing a row had
been opened); a fix for that which itself broke, because the "forget which
rows are open" reset was wired to fire on *every* `refreshSessionDetail()`
call, not just an actual session switch, so it kept firing every 3s anyway;
and an open detail-row's scrolled-down result jumping back to the top on
every rebuild even once the row correctly stayed open, because the rebuild
still destroyed and recreated its `<pre>` element. All three are fixed:
`expandedActionIds` (which rows are open) and `actionDetailCache` (fetched
full rows) are now cleared only on a genuine session switch
(`lastDetailSessionId` tracking), a rebuild re-opens any row still tracked
as expanded instead of leaving it collapsed, and each open row's `<pre>`
scroll position is captured immediately before the table wipe and restored
after the row's content lands back in the DOM.

Underneath all three was one architectural problem: `renderActions()`
unconditionally tears down and rebuilds every `<tr>` on every trigger - the
3s poll, *and* every debounced SSE push - with no memory of what was
already on screen. Two changes address that directly instead of patching
around more symptoms of it:

- **Ended sessions stop polling.** A session's rows are immutable once it
  has ended - no CLI/agent can add another action, console entry, snapshot,
  etc. to it. `refreshSessionDetail()` now fetches an ended session's 7
  panels exactly once (on switch) and skips them on every subsequent 3s
  tick, instead of re-fetching and re-rendering identical data forever. A
  real ended session in this repo's own `webscout.db` (75 actions) was
  costing a 328KB re-fetch + full rebuild every 3s for no reason before
  this fix, confirmed via `curl -w "%{size_download} bytes"` against `GET
  /sessions/:id/actions`.
- **Unchanged data skips the render entirely, for active sessions too.**
  Every row in every panel table has an autoincrement `id`, and rows are
  append-only (never mutated or deleted server-side) - so `row count + max
  id` is a cheap, sufficient fingerprint that a fresh fetch is identical to
  what's already rendered. Each panel's refresh function now compares
  fingerprints and returns early (no DOM touched, no Timeline re-merge) when
  nothing actually changed, instead of unconditionally rebuilding an idle
  panel every 3s.

A smaller follow-on: an action's detail-row HTML (its params/result,
JSON-stringified and escaped) is now cached per action id the first time
it's built. A finished action row never changes, so re-expanding it - or
having it survive a table rebuild via the fix above - no longer re-does that
stringify/escape work each time.

### Settings

The **Settings** button (top-right of the header) opens a dialog with three
tabs:

- **Display** - client-side, browser-only preferences persisted to
  `localStorage` (`webscoutDashboardSettings`), applied immediately, no
  relay restart: poll interval, action-log render cap, console/net fetch
  cap, and the net-panel slow-request highlight threshold. These are the
  same four numbers documented above (`ACTIONS_RENDER_CAP`,
  `CONSOLE_NET_FETCH_LIMIT`, `NET_SLOW_MS`, the 3s poll) - previously fixed
  constants in `dashboard.html`, now per-viewer-tunable so a fork or a user
  with a much longer/shorter session doesn't have to edit the file.
- **Server config** - a read-only view of the relay's actual running
  configuration (`GET /config`: host/port, DB file path, Node version,
  platform, auto-open state, web-scout version, current AI backend URL),
  plus one genuinely live-editable field: the AI backend URL
  (`PUT /config {"aiBackendUrl": "..." | null}`). Every other field is
  fixed at process start (changing the port the browser is talking
  *through*, from that same browser, obviously can't take effect without a
  restart) and shown for visibility, not editability.
- **About / Project** - what this tool is, its license, doc locations, and
  (best-effort, from `git`) the repo's remote URL, branch, and commit - for
  anyone opening the dashboard on a fork who wants to know what they're
  looking at and where to find the source.

## Ask AI (optional feature - needs a backend of your own)

`POST /ask` (and `cli.mjs ask`) assembles the session's goal/context plus a
capped summary of its actions/snapshots/diffs into a prompt, and POSTs it to
whatever URL `WEBSCOUT_AI_BACKEND_URL` points at. The contract is
deliberately trivial and framework-agnostic: `{system_prompt, user_prompt}`
in, `{status: 'ok', text}` or `{status: 'error', error}` out - any backend
you stand up (a one-route FastAPI/Express app calling whatever LLM API you
like) works. Everything else in web-scout functions with no AI backend at
all; this is the one feature that needs one.

This build's default URL (`http://127.0.0.1:8000/api/cfi/cognitive/analyze`)
happens to point at this specific repo's own existing backend route (which
this same schema-agnostic contract lets `ai.mjs` reuse safely, alongside
that backend's own unrelated CFI cognitive-layer callers, without touching
any of their evidence-envelope machinery) - it is not a dependency of the
feature itself, just this build's default. Point
`WEBSCOUT_AI_BACKEND_URL` at your own implementation, or don't use `/ask`.

**The backend's host:port is not fixed anywhere in this repo's code** - set
`WEBSCOUT_AI_BACKEND_URL` if the backend isn't on the README-documented
default (`http://127.0.0.1:8000/api/cfi/cognitive/analyze`, from
`uvicorn backend.main:app --reload --port 8000`); it may be running on a
different port during any given dev session.

Context caps (so a long session never blows the prompt budget): last 20
actions (oldest dropped first), each field capped at 800 chars, snapshot
counts only (never full dumps), diff summaries always included (full diff
JSON only under 4000 chars), 12000-char hard total cap. The exact assembled
`system_prompt`/`user_prompt` is persisted alongside the answer, so "why did
it say that" is itself answerable from the log later.

## Multi-tab

`?webscout_name=NAME` on the page URL connects that tab as a distinct named
agent instead of the default single-tab agent - omitting it (the default)
is fully backward compatible with a single tab. Multiple tabs can be
connected at once; `node tools/web-scout/cli.mjs agents` lists who's
connected, and every action-dispatching command accepts `--agent <name>` to
target one specifically. A second connection under the *same* name still
replaces the prior one (unchanged single-tab behavior). `state_snapshots`/
`actions` record which agent produced them (`agent_name`), purely
**advisory** - diffing two snapshots from different tabs is a legitimate
cross-tab comparison, never blocked.

## Security model / non-goals

- Relay binds `127.0.0.1` only - never reachable from the network.
- `inject.js` is dormant unless explicitly activated per-page - the default
  page load is unaffected.
- Every action requires an active session (see "Required workflow" above) -
  there is no way to dispatch `dom.*`/`idb.*`/`net.*`/`console.*`/`eval`
  without first declaring a goal via `POST /sessions`.
- `eval` is a deliberate, clearly-labeled escape hatch, not hidden inside a
  generic verb. It runs arbitrary JS in the page with full access to
  whatever that page's session can do. Treat it as equivalent to having a
  DevTools console open on an authenticated session, because that is
  exactly what it is.
- `idb.put`/`idb.delete` are a real, scoped write/delete path (validated
  only in the sense that IndexedDB itself rejects a malformed key/keyPath
  mismatch) - do not assume they're safe against production data merely
  because they're narrower than `eval`. `idb.put`'s response now includes
  the full stored `row` (the given row merged with whatever key
  `autoIncrement` actually assigned), not just the bare key - IndexedDB
  does **not** reset a store's `autoIncrement` counter when a row is
  deleted, so a caller that re-seeds "the same" fixture after a cleanup
  pass and assumes it got the same id back (e.g. `1` again) can silently
  be wrong; the full row removes the need to guess or re-dump.
- Console/error capture wraps `console.error`/`console.warn` preserving
  call-through (devtools output is unchanged) and listens for uncaught
  errors/rejections **without** `preventDefault()`/returning `true` - this
  tool must only ever observe the page, never change its actual behavior,
  including suppressing the browser's own default error logging.
- Multi-agent by name (see "Multi-tab" above) - a session's `--agent` gate
  is purely about routing which tab a command goes to, not an authorization
  boundary between tabs.
- Network/console capture only sees activity from *after* activation - the
  page's own initial load is never captured.
- `webscout.db` (and its `-wal`/`-shm` sidecars) is gitignored and holds
  whatever DOM/IndexedDB/network/console content was recorded, including
  anything captured via `eval` or an `ask` prompt - treat it with the same
  care as the page data it was captured from.
- **`console_entries`/`net_entries` are never pruned** (same no-pruning
  convention `actions`/`state_snapshots` already use, but a meaningfully
  higher volume profile since they're captured automatically, not only on
  explicit action) - accepted as consistent, not silently inherited; a long
  session on a chatty/broken page can accumulate a large number of rows.
- Not excluded from the service worker precache is a real question to
  revisit if this ever needs to work offline; today `inject.js` is
  deliberately **not** added to `sw.js`'s precache list, so it is always
  fetched fresh and never becomes a permanently cached artifact.
- No authentication on the relay itself beyond binding to localhost, and
  no authentication on `/ask` reaching whatever AI backend is configured -
  do not run this on a shared or remotely-accessible machine.

## Testing

Three test files, all real-not-simulated (real processes, real relay, no
mocked HTTP/DOM):

- `db.mjs.test.mjs` - unit tests against `db.mjs` directly, using a
  throwaway SQLite file (`WEBSCOUT_DB_PATH` override) instead of your real
  `webscout.db`. No relay needed.
- `cli.test.mjs` - spawns `cli.mjs` as a real child process against the
  real, running relay; asserts exit codes and stdout/stderr shape.
- `mcp-server.test.mjs` - spawns `mcp-server.mjs` and speaks real JSON-RPC
  over its real stdio, against the real running relay.

```bash
node tools/web-scout/relay.mjs &      # cli.test.mjs and mcp-server.test.mjs need it running
node --test --test-concurrency=1 tools/web-scout/db.mjs.test.mjs tools/web-scout/cli.test.mjs tools/web-scout/mcp-server.test.mjs
```

**`--test-concurrency=1` is required** when running `cli.test.mjs` and
`mcp-server.test.mjs` together (or alongside anything else that talks to
the relay): both share the relay's single server-side "active session," and
node's default parallel-file execution makes their `session start`/`session
end` calls race each other - confirmed directly in this project's own CI
setup work: the same two files pass reliably serialized and fail
intermittently under default parallelism. `db.mjs.test.mjs` alone needs no
such flag (its own isolated temp file).

Any test that needs a connected browser tab skips itself (not a failure)
when none is connected - true in a headless CI runner by default, so the
suite still runs meaningfully there; see `.github/workflows/web-scout-tests.yml`.

## Known gaps / scope

- `dom.screenshot` is best-effort (SVG-`foreignObject` rasterization, see
  "Screenshots" above), not a real browser driver's pixel-perfect
  compositor capture - cross-origin content and some CSS may not render.
- `macro run` does not get strict-CRV's automatic before/after snapshot+
  diff wrapping even in a strict-CRV session (see "Macros" above).
- `session cleanup`'s default (action-log) mode only tracks `idb.put`/
  `idb.delete`/`idb.deleteMany`/`idb.clear` - a write made via `eval` is
  flagged as a count but must still be reviewed by hand, and a write made
  by clicking a real UI button is invisible to it entirely. Use
  `--since-snapshot` for those (see "Session cleanup" above) - it still
  won't distinguish an intentional pre-existing-row edit from something
  that should be reverted (it reports changed rows but never auto-deletes
  them).
- `page reload --hard` and `hard_reload_document` (Verity UI Relay's
  equivalent, keyboard-only) both address the Service-Worker staleness gap
  from the client side; neither is a substitute for checking whether a
  newly-added file also needs adding to `sw.js`'s own precache list.
- `session end` with no id ends the currently active session; there is no
  bulk "end all sessions" - fine at the current scale.
- The WebSocket has no ping/pong keepalive - a long-idle connection may be
  dropped by an intermediary; reconnect logic in `inject.js` handles this
  with exponential backoff, but a command sent during the gap will time out
  and should simply be retried. Pending console/net capture entries survive
  a reconnect (buffered, capped) rather than being dropped.
- No size cap on the WS frame decoder or HTTP body reader - acceptable given
  the localhost-only, single-trusted-operator threat model, but a
  pathologically large `idb.snapshot` (a real app can have 150+ stores)
  could take a while; it has its own longer 60s timeout (`SNAPSHOT_TIMEOUT_MS`
  in `relay.mjs`), separate from the 15s interactive-command timeout.
- `session assert` checks (`count`/`countGte`/`countLte`/`field`+`equals`)
  are deliberately simple - no nested-field paths, no array-contains, no
  numeric comparison operators beyond count. Covers the "does this store
  look right" case a real CRV pass actually needed; reach for `eval` or a
  manual `idb.dump` for anything more structural.
- A golden snapshot's name has no uniqueness enforcement and no per-name
  history - `idb diff-golden` always resolves to the LATEST snapshot tagged
  with that name (across every session), by design (no delete-then-recreate
  needed to re-baseline), but there is no way to diff against an *older*
  tagged snapshot once a newer one under the same name exists.
- Auto-screenshot-on-failure only fires for `dom.click`/`dom.fill`/
  `dom.wait` (the types that carry a `selector`), and only when the capture
  itself succeeds well enough to be logged as *something* - confirmed live
  against this repo's own real app that `dom.screenshot`'s rasterization can
  itself fail (tainted canvas from cross-origin content); that failure is
  still logged as its own action (see "Screenshots" above), just without
  image data.
- The `DB_VERSION` drift check at `session start` is best-effort only: it
  silently does nothing if `js/db.js` isn't readable from the current
  working directory, or no agent is connected yet - it is a warning, never
  a gate, and a missed warning does not mean the versions actually match.
- `idb restore` only **PUTS** rows from the snapshot - it never deletes a
  row added since the snapshot was taken. A real replace (not a merge)
  needs an explicit `idb.clear` per store first; restoring blindly
  delete-everything-first was deliberately rejected (a snapshot scoped to
  fewer stores than the live DB could otherwise destroy real data restore
  was never asked to touch).
- `suite run` has no relay-side storage of its own - a suite is a plain
  JSON file the caller writes and versions by hand (unlike a macro, which
  is drawn from a session's own already-logged actions). It supports
  exactly 3 step types (`macro`/`assert`/`diff-golden`); anything more
  structural still needs a hand-written multi-command script.
