# Web-scout architecture & command internals

This is the deep-dive companion to [`../README.md`](../README.md). The
README is the newbie-friendly quickstart and command cheat sheet; this file
has the "how it actually works" and "why each feature exists" detail -
mechanism, every command's design rationale, dashboard implementation
history, security model detail, and known gaps. Read it when the README's
one-liner for a command isn't enough, or when you're about to modify one of
these files and want the reasoning behind its current shape.

See also [`web-scout.md`](./web-scout.md) (the evidence-hierarchy/trust
model this tool is built on) and [`web-scout-roadmap.md`](./web-scout-roadmap.md)
(version-by-version history of every round of changes).

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
  <-- shell argv/stdout        <-- stdio JSON-RPC (MCP) - see README's "MCP server" section
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

### Waiting for changed content, not predicted content

`dom wait <selector> --changed [--timeout <ms>]` is a third mode on the same
command as the plain `--text <substr>` form above, for a specific recurring
shape: an element that already exists in a "pending" state and later gets
its content replaced with a real result - every AI-review button in the app
this was built against does exactly this ("Asking AI to review..." ->
the real result). A bare `dom wait <selector>` resolves the instant it sees
the placeholder, since the placeholder element already exists - it proves
nothing about completion. The `--text` form works, but only if the caller
can predict the eventual substring ahead of time, which isn't always
possible. `--changed` snapshots the selector's `textContent` at call time
and resolves as soon as a later poll sees it differ - no prediction
required, at the cost of not being able to assert anything about what the
new content actually says (pair it with a follow-up `dom query` for that).

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

### Waiting for the reload itself (`--wait-reconnect`)

Both `page.reload` and `page.hardReload` resolve their own request
**before** the real navigation fires (`resolve({reloading:true})`, then
`location.reload()` on the next macrotask) - deliberately, so the relay
reply is sent while the WebSocket connection is still alive instead of
being dropped mid-navigation. That leaves a real gap for a caller: no
signal for "the reload actually finished and the agent is back." A real
session hit `no web-scout agent named 'default' connected` on the very
next command, on a guessed sleep that turned out too short. `page reload
[--hard] --wait-reconnect [--timeout <ms>]` (implemented client-side, in
`client.mjs`'s `waitForReconnect`, shared by `cli.mjs` and
`mcp-server.mjs` - no relay/inject.js change needed, since `GET /agents`
already existed) polls `GET /agents` until it has seen the target agent
name (default `'default'`) **disconnect, then reconnect** - not just
"present" on the first poll, which could still be the pre-reload
connection that hasn't torn down yet, giving a false-positive an instant
too early. Default timeout 15000ms; a hard reload clearing a large cache
can legitimately need longer, via `--timeout`.

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

### The post-hard-reload slow-ack window

The first ~5-10s after `page reload --hard` resolves `reconnected:true` is
measurably flakier for `dom.click`/`dom.fill`/`idb.put` than steady state -
not a bug in web-scout or a sign the app didn't actually reload, just a real
timing characteristic worth knowing about before reading an early post-
reload failure as a genuine regression. The app's own concurrent init/
render passes (module imports, first `renderAll()`, event-listener wiring)
are still settling during that window even though the WebSocket has already
reconnected and the page is technically responsive. If a command sent
immediately after a hard reload times out or reports unexpected DOM state,
retry once after a few seconds before concluding something is actually
broken - `dom settle`/`dom wait --stable` (see below) are a better bet than
a blind extra sleep for confirming the window has passed.

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
hard.

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

`session assert` and `macro run` exit **1** (not 0) when the result's own
`passed:false`/a failing step is present, so a script or CI step doesn't
have to parse stdout itself to notice a failure. `suite run` follows the
same convention. Every other command's existing behavior (a thrown error
exits 1, e.g. a 409 from no active session) is unchanged.

### Startup health check (`DB_VERSION` drift)

`session start` does a **best-effort, non-blocking** check: if `js/db.js`
is readable from the current working directory and a tab is already
connected, it compares the tab's LIVE `IndexedDB` connection version
against `js/db.js`'s own `DB_VERSION` constant, and warns (never blocks) on
a mismatch. Catches "the migration was bumped in source but this tab never
re-opened the DB" before a whole CRV pass gets run against a stale schema -
the schema-level sibling of the freshness check above (which answers the
same question for a source *file* instead of the DB connection version).
Fix: `page reload` (or `page reload --hard`).

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
(not attached to the failed row - the action log is append-only) - the
broken state stays on record even after it's gone from the live tab.
Logged either way (success or failure of the capture itself), so a
tainted-canvas failure like the one above is still visible evidence, not
silence.

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
`/command`'s strict-CRV branch. See `web-scout-roadmap.md`'s V4 entry for
why this exists.

### Verity UI Relay integration

Web-scout and [`tools/ui-verifier`](../../ui-verifier/README.md) (Verity UI
Relay) stay deliberately separate tools with opposite trust models (see
"Relationship to Verity UI Relay" in [`web-scout.md`](./web-scout.md)) -
this is evidence *bundling*, not a merge. Verity's own `scenario` command
persists nothing on its own; `verity import <sessionId> <path-to-result.json>`
folds a saved result into a web-scout session's own evidence trail (visible
in the dashboard's **Timeline** and **Verity UI checks** panel, and in the
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
(full rationale in `web-scout-roadmap.md`'s V8 entry):

- **Macro cross-context replay guard.** `macro run`/"Run" in the dashboard
  refuses (409) when the currently active session's goal has low
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
  contains no `return`, the response carries an extra `__note` field
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
- **Friction Analytics is cache-backed** (server-side, 5s TTL) instead of a
  full table scan on every open dashboard tab's every 3-second poll.
- **One malformed action row no longer breaks Friction Analytics
  globally.** `listAllActions()` parses each row's JSON independently and
  skips (never throws on) a corrupted one; the response's
  `malformedActionsSkipped` count is surfaced in the dashboard's "Known
  friction" banner instead of the whole banner just silently disappearing.

### Friction Analytics

`GET /analytics`/`cli.mjs analytics` reads the data this tool has already
been recording - `ok`/`error` per action, macro-run tags, Verity pass/fail
- across **every** session at once (the one deliberate exception to every
other route's session-scoped evidentiary gate), and surfaces recurring
patterns: failure rate by action type, selectors that failed more than once
(a one-off miss is normal; a repeat is the "hit the same wall again"
pattern this exists to catch), macros recorded but never replayed, macros
replayed but never once succeeding (a real, otherwise invisible rot mode
for "record once, replay forever"), and Verity labels whose latest import
is still FAIL. The dashboard renders the top 3 of each as a dismissible
"Known friction" banner above the session picker, loaded on page load and
refreshed on the existing 3-second poll - global, not scoped to whichever
session happens to be selected. Run `analytics` before starting new work,
not only after hitting a wall.

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

## MCP server internals

See the README's "MCP server" section for how to register it. Detail:

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

## Dashboard internals

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
/sessions/:id/actions` strips just those three fields from the list
response (`{redacted: true}` in their place, plus a cheap count where one
exists) and serves them in full only from `GET
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
  etc. to it. `refreshSessionDetail()` fetches an ended session's 7 panels
  exactly once (on switch) and skips them on every subsequent 3s tick,
  instead of re-fetching and re-rendering identical data forever. A real
  ended session in this repo's own `webscout.db` (75 actions) was costing
  a 328KB re-fetch + full rebuild every 3s for no reason before this fix,
  confirmed via `curl -w "%{size_download} bytes"` against `GET
  /sessions/:id/actions`.
- **Unchanged data skips the render entirely, for active sessions too.**
  Every row in every panel table has an autoincrement `id`, and rows are
  append-only (never mutated or deleted server-side) - so `row count + max
  id` is a cheap, sufficient fingerprint that a fresh fetch is identical to
  what's already rendered. Each panel's refresh function compares
  fingerprints and returns early (no DOM touched, no Timeline re-merge) when
  nothing actually changed, instead of unconditionally rebuilding an idle
  panel every 3s.

A smaller follow-on: an action's detail-row HTML (its params/result,
JSON-stringified and escaped) is cached per action id the first time it's
built. A finished action row never changes, so re-expanding it - or having
it survive a table rebuild via the fix above - no longer re-does that
stringify/escape work each time.

### Settings

The **Settings** button (top-right of the header) opens a dialog with three
tabs:

- **Display** - client-side, browser-only preferences persisted to
  `localStorage` (`webscoutDashboardSettings`), applied immediately, no
  relay restart: poll interval, action-log render cap, console/net fetch
  cap, and the net-panel slow-request highlight threshold.
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

### `DB_VERSION` drift banner

The dashboard-visible half of the same check "Startup health check" (above)
already runs at `session start` - that CLI warning only ever reached
whoever was watching the terminal, not whoever was watching the dashboard.
`GET /health` carries `db_version_drift` (best-effort: `{checked: false}`
with no active session or connected agent; `{checked:true, sourceVersion,
liveVersion, drift}` once both exist), cached 5s server-side same as
Friction Analytics so every open tab's 3s poll doesn't force a real
`db.version` round trip that often. Dismissing it remembers the specific
`sourceVersion:liveVersion` pair - a genuinely NEW drift (a further
migration bump before the old one was ever fixed) re-shows the banner
instead of staying silently dismissed forever.

### `db version-check` and `db.probeUpgrade` - drift, plus WHY it's stuck

The startup warning and dashboard banner above both answer "is there
drift" - neither answers "why hasn't a `page reload` fixed it yet," which
matters because a version-bump `indexedDB.open` genuinely **hangs
indefinitely** if any other tab on the origin (web-scout-connected or not)
still holds a connection at the older version; this is standard IndexedDB
behavior, not a bug. A real session hit exactly this: `page reload --hard`
came back, `db.version` still reported the old version, and the only way
to learn *why* was hand-rolling `indexedDB.open(name, targetVersion)` with
an `onblocked` listener directly via `eval`.

`db.probeUpgrade({targetVersion})` (`inject.js`) is that probe made
reusable and safe to call any time: opens at `targetVersion`, and if
`onupgradeneeded` ever fires, immediately aborts its own versionchange
transaction (`req.transaction.abort()`) - this call can never actually
commit a real migration, diagnostics only. If `onblocked` fires, the
in-page agent does **not** wait for the blocking connection to eventually
close (which is precisely the hang this exists to diagnose, not
reproduce) - a 1500ms internal deadline resolves `{blocked:true, ...}` on
its own, independent of the underlying `open()` request's own eventual
settlement.

`db version-check` (`cli.mjs`, and `webscout_meta.db_version_check` on the
MCP server; both call the same `client.mjs` `dbVersionCheck` helper) is the
CLI-facing wrapper: reads `js/db.js`'s `DB_VERSION` off disk, compares to
the live `db.version`, and - only on drift - also calls `db.probeUpgrade`
and folds the result into one reply with a plain-English `hint` ("close
other tabs" vs. "should complete cleanly"), instead of the caller needing
to know to run a second, separate diagnostic command by hand.

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
happens to point at this specific repo's own existing backend route - it is
not a dependency of the feature itself, just this build's default. Point
`WEBSCOUT_AI_BACKEND_URL` at your own implementation, or don't use `/ask`.

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

## Token cost internals

See `docs/web-scout-roadmap.md`'s V22/V23 entries for the full history; this
section is the schema/data-flow summary.

Every estimate is `chars/4` over already-stored `result_json`/`params_json`
byte lengths (`CHARS_PER_TOKEN_ESTIMATE` in `db.mjs`) - a rough proxy for
ranking command types/targets against each other, never billed as exact.
`token-report`'s aggregates are pure SQL (`SUM(LENGTH(...))  GROUP BY`),
so running the report never itself pays anything close to the bytes it
measures.

- **`sessions.token_budget`** (nullable) - advisory only, set via `session
  start --token-budget N`. Nothing blocks a command from running over it;
  it only changes what `session end`/`session show`/the dashboard print
  once crossed.
- **`result_blobs` table + `actions.result_hash` column** - content-
  addressed dedup. `logAction` (`db.mjs`) hashes every result with sha256;
  a hash already in `result_blobs` means this row's own `result_json` is
  left `NULL` and `ref_count` is bumped instead of storing a second
  physical copy. `resolveResultJson(resultJson, resultHash)` is the read-
  side counterpart - falls back to the blob by hash - used everywhere a
  result is read (`listActions`, `getActionById`, `listActionsSummary`,
  `listAllActions`). Every cost-report SQL query `LEFT JOIN`s
  `result_blobs` (`COALESCE(a.result_json, rb.json, '')`) so LOGICAL byte
  counts stay exact regardless of physical dedup - a caller's own
  `printResult` output is unaffected either way.
- **Same-session read-result cache** (`relay.mjs`, in-memory, NOT the same
  mechanism as the DB-level dedup above) - `readResultCache: Map<sessionId,
  Map<cacheKey, {result, mutationCounter, cachedAt}>>`, invalidated whole-
  session by `sessionMutationCounters` bumping on any `MUTATING_TYPES`
  dispatch. A hit skips `withLoggedAction` entirely - zero new action row,
  zero page dispatch. Resets on relay restart (unlike everything else in
  this section, which is real DB state) - `runtimeCacheHitCount`/
  `runtimeCacheBytesSaved` are labeled as such in `token-report`'s
  `savings.runtimeReadCache`.
- **`state_snapshots.content_hash`** (sha256 of `stores_json`) +
  **`state_diffs.served_from_diff_id`** (nullable FK) - `findCachedDiff`
  looks up an existing, non-cached diff (`served_from_diff_id IS NULL`)
  whose own from/to snapshots' `content_hash`es match the pair just asked
  for. `POST /state/diff` still SAVES a new `state_diffs` row either way
  (audit trail, `GET /diffs/:id` always has the full detail) but omits the
  (possibly large) `diff` field from the immediate response when served
  from cache - `fromCache:true`/`cachedFromDiffId`/`diffOmitted` instead.
- **`macros.steps_cost_est`/`macros.compacted_steps_removed`** - both
  stamped once at `createMacro`/`updateMacroSteps` time (`db.mjs`), not
  computed live on every `macro run`. `compactMacroSteps` collapses
  consecutive identical type+params steps before persisting (never
  reorders or merges non-adjacent steps - a step's position can matter);
  `estimateStepsTokenCost` sums each remaining step's own type's all-time
  average `estTokens`/call from `getActionCostReport()`.
- **`getTokenSavingsReport()`** (`db.mjs`) combines `getResultDedupSavings`,
  `getGoldenDiffCacheSavings`, and a `SUM(compacted_steps_removed)` across
  `macros` into one object - deliberately three separate real numbers, not
  one fabricated composite score (same discipline as this project's other
  "never invent a single score out of unrelated measurements" precedent).
  `relay.mjs`'s `GET /token-report` (no `--session`) merges in the runtime
  cache counters above and returns the combined `savings` block.

## Testing internals

Three test files, all real-not-simulated (real processes, real relay, no
mocked HTTP/DOM):

- `db.mjs.test.mjs` - unit tests against `db.mjs` directly, using a
  throwaway SQLite file (`WEBSCOUT_DB_PATH` override) instead of your real
  `webscout.db`. No relay needed.
- `cli.test.mjs` - spawns `cli.mjs` as a real child process against the
  real, running relay; asserts exit codes and stdout/stderr shape.
- `mcp-server.test.mjs` - spawns `mcp-server.mjs` and speaks real JSON-RPC
  over its real stdio, against the real running relay.

`--test-concurrency=1` is required when running `cli.test.mjs` and
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
