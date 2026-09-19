# Web-scout roadmap

This roadmap tracks Web-scout's rounds of additions the way
`docs/verity-ui-relay-roadmap.md` tracks Verity's - not because the two
tools share a trust model (they are deliberately opposite, see
`docs/web-scout.md`), but because this project's own convention is to make
each tool's evolution and rationale legible to a future reader, not just
its current state.

## Product principles

1. Context before action: no `dom.*`/`idb.*`/`net.*`/`console.*`/`eval`
   dispatch without a declared session goal first - an evidentiary gate,
   never bypassable per-command.
2. A recorded mutation is evidence, not a claim - a diff is computed from
   two real captured snapshots, keyed by each store's actual primary key,
   never assumed to be `id`.
3. High-frequency capture is always batched, never allowed to block
   synchronous persistence or concurrent command handling.
4. Full capability (DOM/IndexedDB/network/eval) is available once a session
   is active - Web-scout does not pretend to be a narrower, safer tool than
   it is; the discipline is in the session gate and the audit trail, not in
   withholding capability.
5. Nothing recorded lives only in page or process memory - a relay restart
   or tab reload must not lose the record of what happened.
6. The tool records observable truth; it never becomes application
   authority, and never silently changes the page's own behavior while
   observing it (no suppressing default error logging, no synthetic DOM
   writes disguised as user input).

## V0 - scaffold (implemented)

- Dependency-free Node relay (`tools/web-scout/relay.mjs`): hand-rolled
  WebSocket server (no `ws` package) over `node:http`, single agent
  connection, `POST /command` request/reply dispatch.
- In-page agent (`tools/web-scout/inject.js`): dormant unless
  `?webscout=1`/`localStorage.webscout_enabled=1`; `dom.query/click/fill`,
  `idb.list/dump/snapshot`, `net.log/clear`, `eval`.
- CLI (`tools/web-scout/cli.mjs`) invoked via Bash.
- Relay-side diffing keyed by each IndexedDB store's real `keyPath` (not
  assumed to be `id` - caught during design review against `js/db.js`'s
  real store definitions before this shipped).

Exit criteria:

- the relay binds `127.0.0.1` only;
- the in-page agent changes nothing about a normal page load when the
  activation flag is absent;
- a diff across two snapshots is correct for a non-`id`-keyed store.

## V1 - session persistence, dashboard, ask-AI (implemented)

Driven by the tool's own first real gap, named the moment V0 shipped: every
recorded action lived only in relay-process memory or the page's own
memory, lost on a relay restart or tab reload, with no way to attribute an
action to why it was taken.

- `tools/web-scout/db.mjs`: `node:sqlite` (zero npm dependency, confirmed
  available on the installed Node build) persistence for sessions,
  actions, state snapshots/diffs, and Q&A - WAL mode (mirroring
  `backend/database.py`'s own convention) so an external SQLite viewer can
  safely read `webscout.db` while the relay runs.
- Every `dom.*`/`idb.*`/`net.*`/`eval` dispatch now requires an active,
  goal-declared session (`POST /sessions {goal, context}`) - an
  evidentiary gate, explicitly not `ui-verifier`'s safety-gate model.
- `idb.snapshot`/`idb.diff` moved off an ephemeral in-page `Map` onto the
  relay + SQLite, so a snapshot/diff survives a tab reload.
- `tools/web-scout/ai.mjs`: reimplements
  `js/capital-cognitive-provider-ai-council.js`'s exact
  `{system_prompt,user_prompt}` -> `{status,text}` contract in Node (that
  file is browser-only) against a configurable backend URL - the backend's
  host:port is not fixed anywhere in this repo's code, confirmed during
  design review, so this was built configurable from the start rather than
  hardcoded to whatever port happened to be live in any one dev session.
- `tools/web-scout/dashboard.html`: self-contained vanilla JS/CSS page
  (no build step), served by the relay at `GET /dashboard`.

Exit criteria:

- a command dispatched with no active session is rejected, not silently
  recorded;
- a relay restart preserves every prior session's actions/snapshots/diffs;
- the ask-AI backend URL is read from configuration, never hardcoded to a
  specific port.

## V2 - seven features + realtime dashboard (implemented)

Driven by a direct request to close the remaining named v0/v1 gaps and make
the dashboard genuinely live rather than polling. A validation pass before
implementation (reading all six then-current files plus two empirical
checks against the installed Node/SQLite build) corrected several
assumptions before they shipped as bugs - documented here because the
corrections are as load-bearing as the features themselves:

- **`ALTER TABLE ... ADD COLUMN IF NOT EXISTS` is not supported** by this
  repo's bundled SQLite (confirmed by direct test: `near "EXISTS": syntax
  error`) - migrations use a `PRAGMA table_info`-based `ensureColumn`
  helper instead, the only working approach, not merely the cautious one.
- **The real head-of-line risk for high-frequency console/net capture is
  `node:sqlite`'s synchronous `DatabaseSync`, not WebSocket framing** - one
  `INSERT` per entry would block the whole relay during a bursty page.
  Fixed by batching at both ends (client flush every 250ms/25-entry cap,
  one transaction per server-side flush) before this shipped, not after.
- **Strict-CRV auto-snapshots get their own action/snapshot/diff rows**,
  consistent with how a manual snapshot/diff already worked - the
  cross-reference to what triggered them lives in the auto-rows' own
  `params_json` (`triggered_by_action_id`), never by repurposing the
  existing `action_id` foreign key's established meaning.
- **`idb.put`/`idb.delete` are included in strict-CRV's auto-snapshot
  trigger set** - excluding the tool's first real write path from the
  feature that exists to audit mutations would have defeated the feature.

Features shipped:

1. `idb.put`/`idb.delete` - scoped IndexedDB writes, validated against each
   store's real `keyPath`.
2. Console/error capture - `console.error`/`warn` wrapped with call-through
   preserved, `window.onerror`/`unhandledrejection` listened without
   `preventDefault()`, batched and persisted like network capture.
3. `dom.rect`/`dom.computedStyle` - layout inspection (bounding box,
   curated or caller-specified computed-style properties).
4. Strict-CRV session mode (`session start --strict-crv`) - automatic
   before/after snapshot + diff around every `dom.click`/`dom.fill`/`eval`/
   `idb.put`/`idb.delete`.
5. Session tags + dashboard filter.
6. Session report export (`tools/web-scout/report.mjs`, Markdown/JSON,
   `GET /sessions/:id/report`) - does not require an active session, since
   reviewing an already-ended session is the entire point.
7. Named multi-tab support (`?webscout_name=`, `--agent <name>`,
   `GET /agents`) - fully backward compatible with the single-tab default;
   `agent_name` recorded on actions/snapshots is advisory only, never a
   diff-blocking constraint.

Realtime: `GET /events` (Server-Sent Events, no new dependency, no second
WebSocket connection needed) pushes a "something changed" signal - never
the full row payload - after every write; the dashboard re-fetches only the
affected panel. The existing 3-second poll stays on as a lower-frequency
fallback for a dropped SSE connection.

Exit criteria:

- a diff across two snapshots is correct for every store's real `keyPath`,
  including a compound array key;
- a bursty page's console/network activity never blocks a concurrent
  `/command` dispatch;
- a strict-CRV session's auto-snapshot/diff rows are individually visible
  in the action log with a discoverable link to what triggered them;
- `idb.put`/`idb.delete` are covered by strict-CRV's auto-snapshot set;
- the dashboard reflects a change made from a second terminal without a
  manual page refresh;
- a session started under the default (unnamed) agent behaves identically
  to before named multi-tab support existed.

## V3 - auto-open dashboard on session start (implemented)

Driven by a direct gap: a long-running relay is easy to forget is even
capturing anything, and the dashboard's own realtime push (V2) only helps an
operator who already has it open. `POST /sessions` now best-effort opens
`GET /dashboard` in the OS default browser (`start`/`open`/`xdg-open` by
platform) every time a session starts - the discrete "a human should be
watching now" moment, not relay startup itself, since a relay can sit idle
for a long time before its first session. A failure to open (headless/CI,
no browser installed) logs and continues; it never blocks or fails the
session-start request. `WEBSCOUT_NO_AUTOOPEN=1` opts out, for a long-lived
relay shared by many short sessions where a new tab per session is noise
rather than signal.

Exit criteria:

- starting a session opens the dashboard without a manual step;
- a missing browser/`xdg-open` on the host does not fail session start;
- `WEBSCOUT_NO_AUTOOPEN=1` suppresses the open with no other behavior
  change.

## V4 - lessons from a real P3.8 verification pass (implemented)

Driven by using the tool for real, not hypothetically: a live-browser CRV
pass closing a P3.8 ontology-promotion report's own named gap (see
`docs/web-scout.md`'s "Why this exists") surfaced five concrete friction
points, each traced to a specific incident during that session rather than
guessed in the abstract:

- **A selector that matched more than one element was silently acted on
  via its first match** - a CRITIC-review click landed on an unrelated
  section's same-shaped button instead of the intended one, confirmed only
  by cross-checking `app_cognitive_runs` afterward and finding the wrong
  `layer` value. `dom.click`/`dom.fill` now resolve via `querySelectorAll`
  and refuse an ambiguous match (with a preview of every element it hit)
  instead of guessing; `dom.pick` (a real click-to-select helper, capture-
  phase + `preventDefault`'d so it never reaches the app) attacks the same
  problem at its source - get a correct, scoped selector before ever
  dispatching a mutating command.
- **No safe way to force a re-render** led to re-invoking a page module's
  own init function via `eval` as a workaround - confirmed to stack
  duplicate `document`-level click listeners each time (no removal/dedup
  guard exists for this in the app), causing a single real click to fire a
  handler 3-4x and write duplicate rows. `page.reload` (a true
  `location.reload()` - the activation flag survives via localStorage, so
  the agent reconnects on its own) removes the reason to reach for that
  workaround.
- **No poll-until-condition primitive** meant hand-rolling bash `until`
  loops to wait on an async AI-review render or a debounced write.
  `dom.wait`/`idb.wait` (poll inside the page, not the CLI) and `idb.watch`
  (re-checks on the relay's own SSE "something changed" push, not a fixed
  interval) replace that pattern.
- **`idb.snapshot` timed out (60s) against the real app's 100+-store
  IndexedDB database** when only a handful of stores mattered for the
  question at hand. `idb.snapshot`/`POST /state/snapshot` now accept a
  `stores` filter.
- **Cleaning up synthetic test data meant hand-tracking every row written**
  and deleting them one `idb.delete` CLI call at a time (12 rows, one
  session). `idb.deleteMany`/`idb.clear` (bulk delete) and
  `POST /sessions/:id/cleanup` (dry-run ledger, built from the session's
  own logged `idb.put`/`delete`/`deleteMany`/`clear` actions - explicitly
  does not track `eval` writes, flagged as a separate count instead of
  silently missed) replace it.

Two features shipped alongside the direct fixes, each earning its place by
removing a repeated multi-step manual sequence rather than adding
capability for its own sake:

- **`dom.screenshot`** - best-effort, zero-dependency DOM rasterization
  (SVG-`foreignObject` technique: clone the target, inline every element's
  computed style onto the clone since a `foreignObject` doesn't inherit the
  host document's stylesheets once serialized standalone, rasterize via
  canvas). Not real compositor access (no CDP available to a normal
  page-side script) - a documented best-effort, not a claimed pixel-perfect
  one. Revises the V0-era "no screenshot" non-goal below: the non-goal was
  never rasterization itself, it was becoming a full browser-automation
  driver, and this doesn't cross that line.
- **Macros (record/replay)** - `POST /macros` saves a named, ordered subset
  of a session's own already-logged replayable actions (nothing new is
  captured; every action was already persisted the moment it ran);
  `POST /macros/:id/run` replays them against the currently active session.
  Directly targets the propose -> attach-evidence -> review -> promote
  sequence re-typed by hand, once per candidate, across that same P3.8
  verification pass - record it once, replay it per candidate afterward.
  Deliberately does not inherit strict-CRV's auto-snapshot wrapping (each
  step dispatches directly); documented as a known limitation rather than
  silently assumed.

Exit criteria:

- an ambiguous `dom.click`/`dom.fill` selector is refused, listing a
  preview of every element it matched, rather than silently acting on the
  first;
- `dom.pick`'s click never reaches the app (verified via a click on a
  real interactive element producing no application side effect);
- `page.reload` results in `inject.js` reconnecting to the relay on its
  own, with no manual re-activation step;
- `idb.snapshot --stores a,b` returns only the requested stores and
  completes well under the full-DB 60s timeout;
- `session cleanup --confirm` leaves zero live rows behind for a session
  whose only writes were `idb.put`/`idb.delete`/`idb.deleteMany`/
  `idb.clear`, and correctly reports a nonzero `eval`-write count without
  attempting to delete anything for those;
- a macro recorded from one session replays successfully against a
  different, currently active session.

## V5 - dashboard UI-facing improvements (implemented)

Driven by a request scoped specifically to `dashboard.html`'s own UI/UX,
distinct from V4's backend/CLI features - answering "the dashboard has all
this data now, but finding/correlating/managing it still means scrolling
five separate tables by eye."

- **Action log filter/search bar** - type dropdown (populated from the
  session's own action types), ok/fail toggle, and a free-text search over
  type/params/result/error, all client-side re-renders of the already-
  fetched action list (no extra round trip per keystroke).
- **Live in-flight indicator** - the relay now broadcasts a new SSE kind,
  `action_start`, the instant `withLoggedAction` begins (before the command
  resolves), carrying `{type, agentName, startedAt}`. The dashboard renders
  a pending row with a spinner and a ticking elapsed-time counter for the
  duration of a `dom.wait`/`idb.wait`/`dom.pick` (which can legitimately
  take 10-15s) instead of looking dead; the pending set for a session is
  cleared the moment that session's next `action` (finished) event arrives.
- **Unified session timeline** - merges the already-fetched actions/
  snapshots/diffs/console/net arrays into one chronological, color-dotted
  lane (reusing each panel's own cached last-rendered rows, no new fetch),
  so "which diff came from that click, right after that console error" is
  one glance instead of cross-referencing five tables.
- **Macro step inspector** - expanding a macro row now renders its steps as
  a reorderable/removable list (`PUT /macros/:id/steps`, a full-array
  replace rather than an index-based PATCH, since a macro's step list is
  small and this can't drift out of sync with a stale index) with a
  per-step "Run from here" (`POST /macros/:id/run {"fromStep": n}`) so a
  partial failure can be resumed without replaying already-succeeded steps.
- **Cross-session search** - a new `GET /search?q=...` route does a linear
  scan of every session's own action log (type/params/result/error,
  stringified; capped at 200 hits - a local dev tool's data volume doesn't
  justify an FTS index) and the dashboard's top-bar search box surfaces
  hits with a session/goal/snippet, clicking one jumps the session picker
  there. `cli.mjs search "<query>"` is the CLI equivalent.

Exit criteria:

- typing in the action-log search box narrows the visible rows without a
  network request;
- a `dom.wait` with a 10s timeout shows a spinner+elapsed row in the
  dashboard for its duration, which disappears once the real result lands;
- the timeline's items are in correct chronological order across all five
  source panels;
- reordering a macro's steps via the inspector persists (`macro show`
  reflects the new order) and `macro run --from-step N` (CLI) / "Run from
  here" (dashboard) skip exactly the steps before `N`;
- `search "<term-known-to-be-in-session-A-only>"` returns a hit scoped to
  session A, and clicking it in the dashboard switches the session picker
  there.

## V6 - Verity UI Relay evidence-bundling integration (implemented)

Driven by a direct request to propose, then build, an integration with
`tools/ui-verifier` (Verity UI Relay) - the two tools' own documented
trust-model split (see `docs/web-scout.md`'s "Relationship to Verity UI
Relay") ruled out a merge; what's actually missing is that Verity's own
`scenario` command persists nothing at all (its stdout goes nowhere unless
a human redirects it to a file), so a verification pass using both tools
leaves two separate artifacts a human reconciles by eye. This closes that
specific gap - bundling, not blurring the trust-model line.

- **`POST /verity/import`** (`verity_runs` table in `db.mjs`) - folds a
  saved Verity `scenario` result JSON into an explicit session's evidence
  trail. Takes an explicit `sessionId`, not `requireActiveSession()` -
  importing evidence to finish an already-ended session's report is a real,
  expected use, matching `/sessions/:id/report`'s own precedent for the
  same reason.
- **Dashboard**: a new **Verity UI checks** panel (file-picker import,
  pass/fail badge, expandable full result JSON via `GET
  /verity-runs/:id`), and a 6th color-dot kind in V5's Timeline.
- **Session report**: `buildReportMarkdown` (`report.mjs`) gained a
  "## Verity UI checks" section; `session report <id> --verity <path>` is
  shorthand for import-then-export in one CLI call.
- **`macro export-verity <id>`** - a **best-effort skeleton**, explicitly
  not a translator: Verity's UIA selector model (`automation_id`/`name`/
  `class_name` against the accessibility tree) has no reliable mapping from
  a web-scout CSS selector, so generated `invoke`/`wait_present`/
  `wait_text_contains` steps leave `selector: {name_regex: "TODO"}` and
  carry the original CSS selector as `_web_scout_hint` for a human to
  translate by hand. `dom.fill`/`idb.*`/`eval`/`page.reload` steps have no
  Verity action to map to at all (confirmed against Verity's own action
  list - it has no generic "set a field's value" action) and are skipped,
  listed in the output rather than silently dropped.

Considered and explicitly rejected: automatic CSS-selector-to-UIA-selector
translation. Too fragile to trust for an `invoke` action that can activate
a real control - the skeleton leaves that judgment call to a human on
purpose, consistent with V4's non-goal framing ("not becoming a general-
purpose browser automation framework").

Exit criteria:

- `POST /verity/import` against a nonexistent session id fails with a clear
  error and writes nothing;
- an imported run's `passed_count`/`failed_count` are computed correctly
  from its `steps[].passed` array, independent of the run's own top-level
  `passed` field;
- the dashboard's Verity panel and Timeline update via the existing SSE
  push (`kind: 'verity'`), no manual refresh;
- a session report generated with `--verity <path>` includes that run in
  its own "Verity UI checks" section;
- `macro export-verity` on a macro with a mix of `dom.click`/`dom.wait`/
  `idb.put`/`eval` steps emits stubs for only the first two, and reports
  the rest as skipped rather than guessing a mapping for them.

## V7 - Friction Analytics (implemented)

Driven by naming the pattern behind V4/V5/V6 themselves: every one of them
got built the same reactive way - a human hit friction in one session,
reported it, a fix shipped for that one thing. Meanwhile this tool has been
recording `ok`/`error` per action, macro-run outcomes, and Verity pass/fail
since V1/V6 without ever reading that data back. The single biggest
downstream problem identified from that pattern: friction gets
rediscovered per-session instead of surfaced proactively - the same
selector can fail across five separate sessions and nothing connects them
until a human happens to notice again.

- **`GET /analytics`** (`db.mjs` gained `listAllActions()`/
  `listAllVerityRuns()`, the one deliberate exception to every other
  query's session-scoped shape) computes, across every session at once:
  failure rate by action type (only types with at least one failure -
  a 100%-ok type isn't friction); selectors that failed more than once
  (a one-off miss is normal, a repeat is the actual pattern); macros
  recorded but never replayed, and macros replayed but never once
  succeeding on any step (a real, otherwise invisible rot mode - the page
  changed under a recorded macro and nothing ever surfaced that); Verity
  labels whose most recent import is still FAIL with no later passing
  re-import.
- **`cli.mjs analytics`** - the CLI equivalent, meant to be run before
  starting new work, not only after hitting a wall.
- **Dashboard**: a dismissible "Known friction" banner above the session
  picker, global (not scoped to whichever session is selected), populated
  on load and refreshed on the existing 3-second poll.

Verified live against this tool's own accumulated `webscout.db` (real data
from V4-V6's own smoke-testing already exercised the failure-rate and
Verity-still-failing cases without any synthetic setup) plus synthetic rows
covering the two macro cases and a repeated-selector-failure case - all
five categories confirmed correct before shipping.

Exit criteria:

- `failureRateByType` excludes any action type with zero failures;
- `topFailedSelectors` excludes a selector that failed exactly once;
- a macro with zero actions tagged `params.macroId` appears in
  `macrosNeverRun`, never in `macrosNeverSucceeding`;
- a macro with at least one tagged action, none `ok:true`, appears in
  `macrosNeverSucceeding`, never `macrosNeverRun`;
- a Verity label's presence in `verityLabelsStillFailing` is decided by
  its LATEST import only, not any earlier one under the same label;
- the dashboard banner reflects `GET /analytics`'s real output and stays
  hidden once dismissed for the rest of that page session.

## V8 - safety hardening from an audit, not an incident (implemented)

Driven by a direct request to audit the tool itself for missing features
and invisible gaps, rather than waiting for the next verification pass to
hit one - a departure from V4-V7's own pattern (each driven by friction
already hit). Five findings, all confirmed by re-reading `inject.js`/
`relay.mjs`/`db.mjs` fresh rather than guessed, ranked by how much damage
each does before anyone notices:

1. **Macro cross-context replay guard.** `macro run` explicitly replays
   against whatever session is CURRENTLY active, not the one it was
   recorded from (by design, since V6) - but nothing checked whether that
   target session's goal even resembled the macro's origin. A macro
   recorded for "delete synthetic test rows" could be replayed, unwarned,
   against an unrelated real session just because it happened to be
   active. Fixed with a cheap, deliberately non-semantic Jaccard-
   similarity-of-goal-words check (`MACRO_CONTEXT_SIMILARITY_THRESHOLD =
   0.15` in `relay.mjs`) - low overlap refuses the run (409) unless
   `{"confirm": true}`; the dashboard turns that specific error into a real
   confirm() prompt instead of a dead-end alert.
2. **`GET /analytics` (V7) had no cache** - a full scan of every action
   ever recorded, on every open dashboard tab's every 3-second poll,
   unbounded as the dataset grows. Named as its own likely future
   bottleneck the same round it shipped; fixed with a 5-second server-side
   TTL cache (`ANALYTICS_CACHE_MS` in `relay.mjs`) - at most one full scan
   per window, shared across every open tab.
3. **`eval` had no page-side execution timeout.** The relay's own 15s
   round-trip timeout only killed the HTTP response; an unresolved `await`
   inside `eval` hung silently, and every subsequent command's timeout
   carried no hint the real cause was three commands back. Fixed with a
   page-side `Promise.race` timeout (`timeoutMs`, default 10000ms) that
   produces a specific diagnostic - explicitly, honestly scoped: this
   cannot and does not claim to interrupt a genuine synchronous infinite
   loop (`while(true){}`), since JS is single-threaded and that freezes the
   tab regardless of any timer. The message says so when it *can* fire.
4. **One malformed row anywhere in `actions` silently broke Friction
   Analytics globally.** `listAllActions()` used one unconditional
   `JSON.parse` per row across the ENTIRE table; a single bad row threw for
   every session's data, and the dashboard's own best-effort `catch {}`
   swallowed the error with no visible sign anything was wrong. Fixed by
   parsing each row inside its own try/catch and skipping (not failing) a
   bad one; the skipped count (`malformedActionsSkipped`) is now a real
   field in the response, surfaced in the dashboard's friction banner.
5. **`eval`'s non-JSON-safe fallback silently substituted `String(result)`**
   for a DOM element, `Map`/`Set`, circular reference, or `BigInt` - reading
   as real evidence ("just a generic object") when the actual value had
   been discarded. Now returns `{"__unserializable": true, typeofResult,
   constructorName, stringified}`, an explicit marker instead of a lossy
   guess.

Verified: the macro guard's three cases (blocked without confirm, override
via confirm, and a genuinely related goal passing without needing confirm
at all) against a live relay; the analytics cache via two back-to-back
calls (13x faster on the second, matching cache hit); the eval-handler
fixes by extracting the exact handler source from `inject.js` and running
it in isolated Node (normal eval, a hung-promise timeout producing the
exact diagnostic, and a circular-reference eval producing the
`__unserializable` marker) - `eval`'s dependencies (Promise/setTimeout/
JSON) needed no DOM, so this tested the real shipped code, not a
reimplementation.

Exit criteria:

- `macro run` against an unrelated active session is refused with a 409
  naming both sessions' goals and the measured overlap;
- `{"confirm": true}` runs it anyway; a macro run against a session whose
  goal is a genuine continuation of the source session's needs no confirm;
- two `GET /analytics` calls within 5 seconds return identical data without
  a second full table scan;
- a hung (never-resolving) `eval` expression produces the page-side timeout
  message, not the relay's generic one;
- a corrupted `params_json`/`result_json` row is excluded from
  `/analytics`'s aggregates (via `malformedActionsSkipped`) rather than
  breaking the whole endpoint;
- `eval` on a circular-reference/DOM-element/BigInt result returns the
  `__unserializable` marker object, never a bare lossy string.

## V9 - lessons from a real P4.1 CRV pass (implemented)

Driven by real friction hit live-verifying P4.1 (Measurement Activation &
Shadow Integration) - each item below cost real back-and-forth in that one
session, not a hypothetical:

1. **Service Worker staleness had no tool-side answer.** A genuine fix to
   `js/capital-cognitive-provider-ai-council.js`'s request timeout stayed
   invisible across several plain `page reload` calls, because this app's
   `sw.js` runs a stale-while-revalidate strategy - it answers `fetch` from
   its own Cache Storage before the network request ever reaches the HTTP
   cache, so a plain reload has nothing to bypass. The session's actual fix
   was manually calling `navigator.serviceWorker.getRegistrations()` ->
   `unregister()` plus `caches.keys()` -> `caches.delete()` via raw `eval`,
   then reloading - discovered by trial and error, not by any tool
   telling the operator this was the cause. Two additions follow:
   - `page.hardReload` (new command type) / `page reload --hard` (CLI) runs
     exactly that unregister-and-clear sequence, then reloads, as one call.
   - `page.fileHash` (new command type) / `page fresh <local-path>` (CLI)
     fetches a path through the page and SHA-256s it, comparing against the
     same file's hash on disk - answers "is the tab actually running what's
     on disk" directly, instead of the fetch-and-grep-a-marker-string
     detective work the session resorted to (roughly 10 round trips to
     diagnose one stale file).
2. **`session cleanup`'s write ledger was blind to UI-driven writes.**
   Every real write in that CRV pass - promoting a candidate, recording an
   observation, creating a shadow trial - happened by clicking a real
   button, which runs `someCrud.add(...)` inside the page's own code, not
   through `idb.put`/`idb.delete`/etc. `session cleanup` only ever tracked
   those four command types, so it had nothing to say about the actual
   writes made; cleanup meant a full manual store dump and hand-picked ids,
   twice. New `{"sinceSnapshotId": N}` mode instead re-snapshots the same
   stores a given persisted snapshot covered, diffs against it, and treats
   every row *added* since then - regardless of how it was written - as a
   pending delete; rows merely *changed* since the baseline are reported
   but never auto-deleted, since an edit to pre-existing data is not
   something cleanup should guess at reverting.
3. **IndexedDB `autoIncrement` doesn't reset on delete.** Cleaning up the
   first CRV pass's rows, then re-seeding "the same" fixture for a second
   pass, silently produced a new, higher id (id 2, not 1) - `idb.put`'s
   response returned only the bare key, so nothing surfaced this until a
   later command failed against the assumed-stale id. `idb.put`'s response
   now includes the full stored row (the given row merged with the real
   key under the store's own `keyPath`), so a caller never has to assume.
4. **`eval` rejected multi-statement expressions with an unhelpful error.**
   `expr` was always compiled as a single expression (`return (${expr})`);
   several `;`-separated statements are not valid there, so every such call
   failed with a bare "Unexpected token ';'" and no hint - forcing a
   hand-wrapped IIFE every time, confirmed to be hit repeatedly in the same
   session. A `SyntaxError` from the expression attempt now triggers a
   fallback compiling `expr` as a function **body** instead (ordinary
   statements, with an explicit `return` for a value) - ordinary multi-
   statement snippets now just work, no IIFE-wrapping needed by hand.
5. **`dom pick`'s docs read as if it might be a programmatic selector
   finder.** It isn't - it blocks on a real human clicking something in the
   browser, with no way for a script to feed it a target. Confirmed as a
   real mis-expectation in the P4.1 session (it was tried as an
   unattended selector-discovery step and just hung to its timeout).
   Clarified in both the CLI's own `--help` text and this README - no
   behavior change, a documentation-only fix, but a repeat-friction one.

Verified live against a real connected tab (not simulated): `page fresh`
correctly reported `fresh: true` for `inject.js` (excluded from the SW
precache list) both before and after a real `page reload --hard`, which
itself round-tripped and reconnected cleanly; `idb.put` against
`app_variable_observations` returned the full row including the real
assigned id; `eval` with a `const a=1; const b=2; return a+b;` body
returned `3` where it previously threw; `session cleanup --since-snapshot`
correctly flagged and deleted both a `idb.put`-written row AND a
same-shaped `eval`-written row (simulating a real UI write) in one pass,
where the default action-log mode caught only the former and flagged the
latter as merely "not tracked."

Exit criteria:

- `page reload --hard` unregisters every Service Worker + clears every
  Cache Storage entry before reloading, and the tab reconnects afterward;
- `page fresh <path>` reports matching hashes for an unmodified file and
  would report `fresh: false` for one the SW is serving stale (verified by
  code path; the connected tab's own files were already fresh);
- `session cleanup --since-snapshot <id>` deletes every row added to any
  snapshotted store since that snapshot, regardless of write mechanism,
  and never auto-deletes a merely-changed row;
- `idb.put`'s response includes the full stored row, key included;
- `eval` accepts an ordinary multi-statement body with an explicit
  `return`, without requiring a hand-written IIFE;
- `dom pick`'s CLI help and README both state plainly that it blocks on a
  human click and is not a scripted selector finder.

See `docs/verity-ui-relay.md`'s V0.2.7 entry for the equivalent Service-
Worker-staleness lesson applied to Verity UI Relay (a `hard_reload_document`
scenario action, keyboard-only since Verity has no JS-execution
capability - explicitly documented there as a narrower fix than this
tool's `page.hardReload`, since Ctrl+Shift+R bypasses the HTTP cache but
cannot unregister a Service Worker or clear its Cache Storage).

## V10 - forward-looking feature proposals, not a retrospective (implemented)

Unlike V9, none of these were triggered by a specific failure in one
session - they're what was judged genuinely valuable to add next, given the
tool's mature-enough state after V9. Each was verified live against a real
connected tab.

1. **Golden regression-baseline snapshots.** Before V10, diffing required
   two snapshot ids captured within the SAME session - there was no way to
   ask "did this later phase touch anything an earlier phase already proved
   untouched" without hunting down an old snapshot id by hand. `idb snapshot
   --golden <name>` tags a persisted snapshot by name (latest-by-id wins on
   re-tag, no delete needed to re-baseline); `idb diff-golden <name> <idB>`
   resolves it from **any** future session and diffs. `state_snapshots`
   gained a nullable `golden_name` column (migrated via the existing
   `ensureColumn` helper, matching every other post-hoc column addition in
   `db.mjs`).
2. **Declarative regression assertions (`session assert`).** Every
   prior verification pass ended the same way: dispatch `idb.dump`,
   eyeball the JSON, decide pass/fail by hand, re-do that by hand again
   next phase. `session assert <id> '<checks-json>'` runs a JSON array of
   `{store, where?, count?, countGte?, countLte?, field?, equals?}` checks
   against LIVE state (one `idb.dump` per distinct store, cached), logged
   as its own `session.assert` action - a durable, replayable proof
   instead of a transcript of eyeballing.
3. **`DB_VERSION` drift warning at `session start`.** The exact same
   staleness shape V9 fixed for a *file* (`page.fileHash`/`page fresh`) can
   also happen at the *schema* level: `js/db.js`'s `DB_VERSION` gets bumped
   in source, but a tab that hasn't reloaded is still on the old IndexedDB
   version, and any new-store check against it silently looks wrong for the
   wrong reason. `session start` now best-effort compares the two (new
   `db.version` command type reads `indexedDB`'s own live connection
   version) and warns - never blocks - on a mismatch.
4. **Auto-screenshot on `dom.click`/`dom.fill`/`dom.wait` failure.**
   Previously a screenshot was a manual, opt-in-after-the-fact step - by
   the time a human went looking for the broken state, it was often
   already gone. A failure of one of these three types now auto-captures a
   `dom.screenshot` of the target selector as its own separate logged
   action (append-only action log, never attached to the failed row), on
   both a successful AND a failed capture attempt - a silent swallow on a
   failed capture would have hidden a real, common case (see the live
   verification note below).

Verified live against a real connected tab: `idb snapshot --golden
smoke-test-skills` on the `skills` store, then a synthetic `idb.put` row, a
fresh (non-golden) snapshot, and `idb diff-golden smoke-test-skills <id>`
correctly reported exactly the one added row by name, with no id to
remember or hunt down. `session assert` against `skills` correctly passed a
`countGte` check, correctly failed both a wrong `count` check and a `field`
check against a non-matching `where`, and correctly passed a real
`field`+`equals` check against a real row. `db.version` returned the tab's
live version (105) matching `js/db.js`'s own `DB_VERSION` (105) - the drift
warning correctly stayed silent on a genuine match (no false positive).
Auto-screenshot-on-failure was first found to log NOTHING on a
`dom.screenshot` capture failure (a real, non-hypothetical case against
this exact app: `dom.screenshot body` throws `Tainted canvases may not be
exported`, a cross-origin-content limitation the tool already documents) -
fixed in the same pass so the capture attempt is logged as its own action
either way, then re-verified: a `dom.wait` timeout against a real,
present-in-the-DOM selector correctly auto-logged a `dom.screenshot` action
row (`ok:false`, with the tainted-canvas error preserved) immediately after
the triggering failure, without masking or altering the original
`dom.wait` error. The relay had to be restarted mid-session for both the
route changes (a persistent Node process, unlike `inject.js` which
reconnects on its own via a page reload) and this follow-up fix to take
effect - the running relay from before this round's edits was still
serving pre-V10 route code, confirmed by a `session assert` request coming
back `not found` until the restart.

Exit criteria:

- `idb snapshot --golden <name>` persists a `golden_name`-tagged snapshot;
  `idb diff-golden <name> <idB>` resolves it by name from any session and
  diffs correctly;
- `session assert` evaluates `count`/`countGte`/`countLte`/`field`+`equals`
  checks against live state and reports a clear `pass`/`detail` per check;
- `session start` warns (never blocks) on a live-vs-source `DB_VERSION`
  mismatch, and stays silent on a match;
- a failed `dom.click`/`dom.fill`/`dom.wait` auto-logs a `dom.screenshot`
  action for the same selector, on both a successful and a failed capture.

## V11 - CI-safe exit codes, suite runner, snapshot restore (implemented)

Another forward-looking round, not a retrospective - the same "what's next"
review this time surfaced one confirmed gap and two genuinely new
capabilities.

1. **`session assert`/`macro run` now exit 1 on failure.** Both routes
   always returned HTTP 200 (a `passed:false` result, or a step's own
   `ok:false`, is a normal successful response shape, not an HTTP error) -
   but the CLI printed that result and exited 0 regardless, so a script or
   CI step had to parse stdout itself to notice a failure. The CLI now
   inspects its own result (`result.passed` for assert, `results.some(r =>
   !r.ok)` for macro run) and sets `process.exitCode = 1` - a one-line fix
   per command, no relay change needed.
2. **`suite run <path-to-suite.json>`.** A full check was already several
   manual calls - run a macro, `session assert`, `idb diff-golden` to prove
   nothing else moved - re-typed by hand every phase. A suite is a plain
   JSON array of `{type: "macro"|"assert"|"diff-golden", ...}` steps,
   deliberately CLI-side only (no relay route, no new DB table): it's the
   CI-shaped wrapper around already-existing primitives, not a new
   execution engine. Stops at the first failing step unless
   `--continue-on-error`; exits 1 if any step (or the whole suite) didn't
   pass, same convention as item 1.
3. **`idb restore <snapshotId>` / `idb restore --golden <name>`.** Golden
   snapshots and `idb diff` could only ever DETECT drift, never correct it -
   there was no way to write a snapshot's rows back into IndexedDB. New
   `POST /state/restore` resolves the target snapshot (by id or golden
   name, same latest-tagged-wins resolution `/state/diff`'s golden form
   already uses) and issues one `idb.put` per row per store, each
   individually logged (`via: "restore"`) so a partial failure still shows
   exactly which rows did and didn't make it back. Deliberately
   additive-only - it never deletes a row added since the snapshot, since a
   blind delete-everything-first could destroy real data restore was never
   asked to touch; an exact replace needs an explicit `idb.clear` per store
   first.

Verified live against a real connected tab (session #14): `session assert`
against `skills` correctly exited 1 on a deliberately-failing `countGte`
check and exited 0 on a passing one. `macro run` against a pre-existing
`always-fails-macro` (a `dom.click` on a nonexistent `#b`) correctly exited
1. For restore: took a golden snapshot of `skills` (`restore-test-baseline`,
id 18), mutated one row's `practice_minutes` from 638 to 9999 via `idb put`,
ran `idb restore --golden restore-test-baseline`, and confirmed via a fresh
`idb dump` that the field was back to 638 - a genuine mutate-then-recover
round trip, not just an API smoke test. For the suite runner: a suite with
an `assert` step and a `diff-golden` step (diffed against itself,
deliberately) correctly reported `passed:true`/exit 0; a suite with a
deliberately-failing `assert` step correctly reported `passed:false`/exit 1
and stopped after the one step (no `--continue-on-error` passed). The relay
needed one restart for the new `/state/restore` route to take effect,
matching V10's own confirmed restart requirement.

Exit criteria:

- `session assert`/`macro run` exit 1 on any failure, 0 when everything
  passes - confirmed both directions live;
- `suite run` executes `macro`/`assert`/`diff-golden` steps in order,
  reports one pass/fail summary, and exits accordingly;
- `idb restore` writes a snapshot's rows back into IndexedDB without
  deleting rows added since, confirmed via a real mutate-then-restore round
  trip that recovered the original field value.

## V12 - dashboard visibility for existing backend features (implemented)

A "propose valuable feature for the web-scout **dashboard**" round -
narrower scope than usual, deliberately: a fresh read of `dashboard.html`
in full found three backend capabilities (two from V10/V11, one always
possible) with genuinely zero dashboard-side visibility, not missing
backend capability.

1. **`DB_VERSION` drift banner.** The drift check `cli.mjs`'s
   `warnOnDbVersionDrift` already ran at `session start` only ever printed
   to the CLI's own stderr - invisible to whoever is actually watching the
   dashboard (the discrete "a human should be watching now" moment this
   tool auto-opens a browser tab for). `GET /health` now carries
   `db_version_drift` (best-effort, cached 5s same as Friction Analytics -
   `readSourceDbVersion()` resolves `js/db.js` relative to `relay.mjs`'s own
   `__dirname`, not `process.cwd()`, so it's correct regardless of the
   directory the relay was started from), and the dashboard renders it as a
   dismissible banner. Dismissal is keyed to the specific
   `sourceVersion:liveVersion` pair, so a genuinely NEW drift re-shows
   instead of staying silently dismissed forever.
2. **Regression-checks panel.** `session.assert` results (V9) previously
   rendered only as a generic Action-log row (raw JSON dump) - no dedicated
   pass/fail view for a feature whose entire point is regression-checking.
   New dashboard panel renders every `session.assert` run for the selected
   session as its own card: overall PASS/FAIL badge (recomputed client-side
   from the row's own per-check array, since the relay never persists the
   overall boolean on the action row itself - only returns it to the
   immediate caller) plus one line per check with its own pass/fail badge
   and detail text.
3. **Golden-snapshot badge.** `golden_name` (V10) existed in the backend
   since its introduction but was never rendered anywhere in the Snapshots
   table - a human browsing snapshots had no way to tell which ones were
   tagged regression baselines without opening `GET
   /state/snapshots/:id` by hand. The snapshot table's `taken_at` cell now
   carries a `golden: <name>` badge when present.

Verified: `db_version_drift`'s `sourceVersion` resolution confirmed live
against the relay's real `/health` response (`{"checked":false,
"sourceVersion":105}` with no agent connected - correctly matches
`js/db.js`'s real `DB_VERSION` on disk). The exact data shapes the new
panels consume (`state_snapshots.golden_name` surfacing through
`listSnapshots`; a `session.assert` action row's `result` being the raw
per-check array with `pass`/`detail` fields) were verified directly against
real `db.mjs` writes/reads (no browser tab was connected to the relay this
round to dispatch through) - both confirmed to match exactly what
`dashboard.html`'s new `renderAssertRuns`/`renderSnapshots` code expects.
The relay was restarted for `/health`'s new field to take effect, same
restart requirement as every prior relay-side change.

Exit criteria:

- `GET /health` reports `db_version_drift`, dashboard renders it as a
  dismissible banner that re-shows on a genuinely new drift;
- Regression-checks panel renders every `session.assert` run with an
  accurate overall badge and per-check detail, distinct from the generic
  Action log;
- Snapshot table shows a `golden: <name>` badge for any golden-tagged
  snapshot.

## V13 - CLI tooling lessons + dashboard payload/churn fixes (implemented)

Two batches from the same stretch of real use: seven CLI/tooling gaps found
verifying P4.2, then two dashboard bugs (action table going unclickable,
tab memory climbing) hit live during that same testing.

**CLI tooling (7 items):**

1. **`dom.click` unreliability on activation-gated elements.** Root-caused
   to a synthetic `dispatchEvent(new MouseEvent('click'))` not triggering a
   browser's native "activation behavior" - confirmed by the user's own
   repeated observation that `element.click()` via raw `eval` worked every
   time on the identical element a `dom.click` call intermittently missed
   (a button inside a `<dialog>`). `dom.click` now calls the element's real
   `.click()` method directly, falling back to synthetic dispatch only if
   `.click` isn't a function.
2. **No generic "wait until quiet" primitive.** `dom.wait` only answers
   "has this specific selector/text appeared" - nothing answered "has the
   page stopped mutating" for a re-render with no reliable selector to poll.
   New `dom.settle` (`MutationObserver`-based, configurable quiet period and
   timeout).
3. **No wait primitive for an async network request.** New `net.wait`
   (URL-substring match, configurable grace period after the match for a
   chained follow-up request, configurable timeout).
4. **`eval`'s statement-fallback `undefined` was indistinguishable from a
   real bug.** The fallback path (see V9 item 4) has no implicit return; a
   body with no explicit `return` now attaches `__note` to the response
   explaining why the result came back `undefined`, instead of leaving the
   caller to guess.
5. **`net log`'s ring buffer (500 cap) could evict evidence before it was
   read**, under a background-noisy page. New `net history` reads the
   already-durable, already-persisted `net_entries` table instead (existed
   for the dashboard's Network panel, never exposed to the CLI) -
   filterable, sortable by duration, limited, survives the ring buffer's
   eviction entirely.
6. **`eval --file <path>`** reads the expression from a local file, instead
   of hand-escaping a multi-line script through the shell's own quoting.
7. **JS-payload shell-quoting fragility** for `idb.put`/`eval` is the same
   root cause as item 6 - `--file` is the fix for both.

**Dashboard net-table (3 items):** a sortable **Duration** column, a
slow-request highlight (red, at or above 10s), both on the Network panel.

**Action table going unclickable during an active session.** Diagnosed as
rebuild-churn, not a threading problem (the DOM is single-threaded
regardless; a Web Worker cannot touch it either way) - three independent
refresh triggers (SSE push per action, a 500ms pending-row elapsed-time
tick, a 3s fallback poll) could each rebuild the *entire* table within the
same few hundred milliseconds, and a click could land on a `<tr>` mid-
teardown. Fixed with three complementary changes: the SSE/console/net
refresh triggers are now debounced (100-250ms trailing-call coalescing);
the elapsed-time tick now patches only the pending rows' own cell in place
instead of rebuilding the table; the table caps DOM construction at the
most recent 500 rows (`ACTIONS_RENDER_CAP`) regardless of how large the
session's full action log has grown.

**Tab memory climbing during a long session (reported ~1GB in the browser
tab).** The debounce/cap fix above addresses rebuild *frequency*; this
addresses payload *size* - the actions list was still shipping and
re-parsing the session's entire action history, full `params`/`result`
JSON included, on every refresh. Measured directly against a real
`webscout.db`: three result shapes (`dom.screenshot`'s base64 `dataUrl`,
`idb.snapshot`'s full multi-store dump, `net.log`'s captured-entries array)
run 50-90KB per row and dominate every other action's result by roughly two
orders of magnitude. `GET /sessions/:id/actions` now redacts just those
three fields in its default (list) response, with the full row available
lazily from a new `GET /sessions/:id/actions/:actionId` - fetched only when
a redacted row is actually expanded, cached client-side per session so a
repeat expand doesn't re-fetch. `?full=1` opts back into the untouched rows
(the CLI's `session show` uses this, since a terminal dump has no
lazy-expand step). `?limit=N` caps row count server-side on the actions/
console/net list endpoints, instead of fetching everything and discarding
the rest client-side; the dashboard now requests the console/net panels
capped at 2000 rows. None of this prunes or size-limits the underlying
persisted tables themselves - that remains the documented non-goal below;
this is entirely about what a single HTTP response carries.

Verified live against the real, running relay + its actual `webscout.db`
(not simulated): the redacted list response for a real `net.log` row
(id 587, 86KB stored) came back as `{count, entries: null, entryCount:
500, redacted: true}`; the corresponding `GET .../actions/587` returned the
full 500-entry array; the same redaction confirmed for a real `idb.snapshot`
row (`stores: null, redacted: true}`); the session-mismatch guard on the
single-action route correctly refused (404) fetching a real action id
under the wrong session id; `?limit=` confirmed capping row count on both
the console and net list endpoints. All four touched files
(`db.mjs`/`relay.mjs`/`cli.mjs`/`dashboard.html`) passed `node --check`
before this verification pass.

Exit criteria:

- `dom.click` uses native `.click()`, `dom.settle`/`net.wait` exist and
  reject with a diagnostic on timeout, `eval --file`/`net history` work as
  documented above, and `eval`'s statement-fallback `undefined` carries an
  explanatory `__note`;
- Network panel's Duration column sorts and flags slow (>=10s) requests;
- rapid-fire refreshes during an active session no longer rebuild the
  action table faster than a click can land on a stable row;
- the actions list response no longer carries the 3 heaviest known result
  shapes by default, a redacted row's full detail is still reachable on
  demand, and `session show`/`?full=1` still return the complete,
  unredacted rows.

## V14 - dashboard render architecture: stop rebuilding what hasn't changed (implemented)

V13 fixed payload size and rebuild-churn *symptoms* (table unclickable,
memory growth). This round found and fixed the shared root cause after a
real report: a past, ended session (#19, 75 actions) was still visibly
laggy just being viewed, and an open detail-row's result kept losing its
scroll position and closing on its own even after V13. Tracing both showed
`renderActions()` (and every other panel's render function) unconditionally
tears down and rebuilds its entire table on *every* trigger - the 3s
fallback poll, and every debounced SSE push - with zero memory of whether
anything actually changed or whether a row's DOM node needed to survive.
Three of these ("detail row closes on its own", "closes even after the
first fix", "scroll resets to top") were fixed reactively in the same
session before this entry; this entry is the structural fix underneath all
of them, not a fourth patch.

Two changes, prioritized as the highest-leverage/lowest-risk fixes over a
full incremental-DOM-patch rewrite (deferred - see below):

- **Ended sessions stop polling.** `session.status` was previously read
  only for the status badge and the "End Session" button's disabled state -
  nothing gated refresh frequency on it. An ended session's rows are
  immutable (nothing can append to a session that's already ended), so
  `refreshSessionDetail()` now fetches its 7 panels exactly once (on
  switch) and skips them on every subsequent 3s tick. `refreshSessionMeta`
  (cheap, single row) still runs every tick so an active session ending
  from another tab/client is still picked up promptly.
- **Fingerprint-gated re-render for every panel, active sessions included.**
  Every panel row type carries an autoincrement `id` and is append-only
  (never mutated/deleted server-side), so `row count + max id` is a cheap,
  sufficient proof that a fresh fetch is identical to what's already
  rendered. Each of the 7 panel refresh functions now short-circuits (no
  fetch-triggered DOM rebuild, no Timeline re-merge) when its fingerprint
  is unchanged from the last render, instead of the 3s poll unconditionally
  re-rendering idle panels forever.

A smaller follow-on in the same pass: an action row's detail HTML (its
params/result, `JSON.stringify`+escaped) is now cached per action id after
first render - a persisted action row never changes, so re-expanding it (or
having it survive a rebuild via the earlier detail-row fixes) no longer
redoes that stringify/escape work.

**Deferred, not built this round:** true incremental DOM patching (append-
only new `<tr>`s instead of any teardown at all, which would structurally
retire `expandedActionIds`/scroll-preservation rather than working around
churn) and having the SSE push carry the new row's own data so the
dashboard never round-trips to fetch it. Both are larger, riskier contract
changes (the second touches the relay's SSE payload shape); the two changes
above target the exact reported complaint (a *past* session still laggy,
scroll still fighting re-renders) with a much smaller diff, and are the
right next step only if a live/active session's poll-driven-but-real-change
case still shows the same lag.

Verified live against the real, running relay: `GET /sessions/19` confirmed
`status: 'ended'` on the real 75-action session named in the report;
`GET /sessions/19/actions` measured at 328337 bytes (`curl -w
"%{size_download} bytes"`) - the exact payload the unmodified poll was
re-fetching and re-rendering every 3s before this fix, for data that cannot
change. `node --check` passed on the extracted `<script>` block after the
edit.

Exit criteria:

- Opening a past/ended session's detail panels fetches each exactly once,
  not every 3s;
- an active session with no new events between poll ticks performs zero
  panel re-renders (verified by the fingerprint short-circuit, not by
  inspection alone);
- expanding a detail-row, scrolling its result, and waiting through several
  poll/SSE cycles leaves both the open state and the scroll position
  intact (already true after the earlier reactive fixes; this entry did not
  regress them - the fingerprint gate makes the common case not even reach
  the rebuild path that those fixes protect).

## V15 - Settings menu, server config, open-source prep (implemented)

Prompted directly by an intent to open-source Web-scout so other people can
use it and fork it: a first-time visitor to the dashboard had no way to see
what the tool even was, no license, and every display/behavior knob
(`ACTIONS_RENDER_CAP`, `CONSOLE_NET_FETCH_LIMIT`, `NET_SLOW_MS`, the 3s poll
interval) was a hardcoded constant a fork would have to edit source to
change.

Added a **Settings** dialog (button in the dashboard header) with three
tabs, each independently scoped:

- **Display** - the four constants above are now `settings.*` values
  persisted to `localStorage` (`webscoutDashboardSettings`), editable from
  the dialog and applied immediately (Apply forces an immediate re-fetch of
  actions/console/net by nulling their change-fingerprints from V14, rather
  than waiting for the next poll tick or a real data change to notice the
  new cap/threshold). Per-browser-tab, never sent to the relay.
- **Server config** - `GET /config` (new route) surfaces the relay's actual
  running configuration: host/port, DB file path, Node version, platform,
  auto-open state, web-scout version, and the effective AI backend URL.
  Deliberately read-only for everything except the AI backend URL: host/
  port/DB-path/auto-open are read once at process start (`relay.mjs`'s
  `HOST`/`PORT` consts, `WEBSCOUT_NO_AUTOOPEN` only checked at the one
  auto-open moment) - genuinely not live-editable without a process
  restart, and showing a fake "Save" on them would be dishonest. The AI
  backend URL is different: `ai.mjs`'s `askAI()` already re-reads
  `process.env.WEBSCOUT_AI_BACKEND_URL` on every call (confirmed by
  reading the function, not assumed), so a new `PUT /config
  {"aiBackendUrl": "..." | null}` route can mutate `process.env` directly
  and have it take effect on the very next Ask AI call, no restart -
  verified live: set to a probe URL, confirmed `aiBackendUrlIsOverridden:
  true` on a follow-up `GET /config`, reset with `null`, confirmed it fell
  back to the compiled-in default, and confirmed an invalid URL string is
  rejected with 400 rather than silently stored.
- **About / Project** - what the tool is, its license, doc file locations,
  and (best-effort via `git remote get-url origin` /
  `branch --show-current` / `rev-parse HEAD`, cached 30s, never throwing if
  run outside a git checkout) the actual repo URL/branch/commit - verified
  live against this repo's real remote
  (`<your-private-app-repo>.git`, branch `distribution-backend-migration`).

Also added **`tools/web-scout/LICENSE`** (MIT) - scoped to the `tools/
web-scout/` subtree specifically, since the containing repo has no
repo-wide license of its own; the dashboard's About tab and the README both
point at it. `WEBSCOUT_VERSION` (currently `0.15.0`, informational only,
bumped alongside this file's own version entries) is now surfaced via
`GET /config`.

Every server-side config field's *actual* source of truth (env var vs.
live-mutable `process.env` vs. hardcoded default) is documented in the new
README "Configuration (env vars)" section, matching what the Settings
dialog itself says field-by-field - so a forker reading either one gets the
same, accurate picture of what can and can't change without a restart.

Exit criteria:

- Display settings persist across a reload and visibly change behavior
  (render cap, fetch cap, slow-highlight threshold, poll cadence) without
  editing `dashboard.html`;
- `GET /config` returns real, live process state (not stale/cached env
  snapshotted at import time) for every field;
- `PUT /config` can change the AI backend URL with no relay restart, reset
  it back to default, and rejects a malformed URL;
- the About tab's repo info matches `git remote -v`/`git branch
  --show-current`/`git rev-parse HEAD` run directly against the same
  checkout;
- `tools/web-scout/LICENSE` exists and is referenced from both the README
  and the dashboard.

## V16 - MCP server, and doc generalization for open-sourcing (implemented)

Prompted by the same open-source push as V15, plus a direct question: how
should a coding agent (Claude Code, Codex CLI, others) actually invoke this
tool - is CLI-via-shell the real best practice, or is there something
better? Researched live rather than assumed: both Claude Code
(`claude mcp add --transport stdio ...`, project-scoped `.mcp.json`) and
Codex CLI (`codex mcp add`, `~/.codex/config.toml`) have solid native MCP
(Model Context Protocol) support as of 2026 - a genuine cross-vendor
standard now, not Claude-specific. Decision, with the user picking both
defaults explicitly: keep the CLI as the universal, zero-setup fallback
(works with any agent that has a shell, and with a human at a terminal),
and add an MCP server as a thin adapter over the *same* relay HTTP API -
same session/action model, same DB, zero new business logic - for clients
that support it, because structured schemas cut down the "agent guessed a
CLI flag wrong" failure class.

**Refactor first, to make the wrapper actually thin:** extracted
`tools/web-scout/client.mjs` from `cli.mjs` - the shared `request()` HTTP
helper, plus 4 pieces of real (not just HTTP-passthrough) client-side logic
that both a CLI and an MCP server need byte-identical: `netHistory`
(durable net_entries filter/sort), `pageFresh` (hash-through-the-page vs.
on-disk), `buildVerityScenarioStub` (macro -> Verity scenario skeleton),
`runSuite` (the macro/assert/diff-golden step loop). `cli.mjs` now imports
all of these instead of defining its own copies - verified live
post-refactor (`session start`, `net history --limit 3`, `page fresh
README.md` all still worked against the real relay + a real connected tab)
before building anything new on top.

**`tools/web-scout/mcp-server.mjs`** (new): hand-rolled stdio JSON-RPC 2.0
(no `@modelcontextprotocol/sdk` dependency - the user explicitly chose
this over the official SDK, to keep the project's zero-npm-dependency
convention, the same reason `relay.mjs` hand-rolls its WebSocket framing
instead of using `ws`). Implements `initialize`/`notifications/initialized`/
`tools/list`/`tools/call` per the confirmed JSON-RPC-over-stdio MCP shape.
10 tools, grouped by namespace rather than one per CLI subcommand (the
user's explicit choice over ~45 individually-schema'd tools, trading some
schema strictness for a small, stable tool list): `webscout_meta`,
`webscout_session`, `webscout_dom`, `webscout_idb`, `webscout_net`,
`webscout_console`, `webscout_page`, `webscout_macro`, `webscout_suite`
(each `{action, params}`), plus `webscout_eval` (no action - a single
free-form expression, not a fixed verb set).

Two design points found and corrected *during* the build, not scoped
correctly in the original proposal - worth recording since they reversed
an explicit prior decision:

- The original scope called for "explicit `sessionId` everywhere, no
  implicit active session" as a deliberate improvement over the CLI. Reading
  `relay.mjs`'s actual dispatch code (`requireActiveSession()` on
  `POST /command`) showed this isn't implementable honestly: the relay
  itself has exactly one server-side "active" session for
  `dom.*`/`idb.*`/`net.*`/`console.*`/`eval`/`page.*` dispatch, with no
  per-call session routing at all. Adding a `sessionId` param to those
  tool actions that the relay would just silently ignore would be worse
  than not having it. Corrected design: those actions have no `sessionId`
  param and operate on the single active session, same as the CLI; only
  actions backed by a route that already takes an explicit id (session
  show/report/cleanup/assert/ask/verity_import, net history) take one.
- `idb watch` (an indefinite SSE-driven streaming poll) has no clean
  `tools/call` (single request/response) mapping - explicitly not wrapped.
  `idb wait` (bounded, resolves once) covers the same need; a real
  streaming form would be a `resources/subscribe`-shaped MCP feature, out
  of scope here.

Error mapping: a failed tool call (bad params, a `dom.click` finding no
match, the relay refusing) returns a normal `tools/call` result with
`isError: true` and the real message - never a JSON-RPC protocol-level
error, which is reserved for an actually malformed call (unknown
tool/action, unparseable JSON). `initialize` trusts whatever
`protocolVersion` the client requests rather than asserting a specific one
is "latest."

**`tools/web-scout/mcp-server.test.mjs`** (new): spawns the server as a
real child process, speaks real JSON-RPC over its real stdio, against the
real running relay - initialize/tools-list shape, the unknown-method and
missing-required-param and unknown-action/unknown-tool error paths, and a
full session-start -> eval -> idb.list -> session-end round trip (skipped,
not failed, if no browser tab happens to be connected in the environment
running the test). All 7 passed live in this session
(`node --test tools/web-scout/mcp-server.test.mjs`).

**Doc generalization** (separate but related ask - this build was
hardened against one private app's own needs, and its docs read that way):
`docs/web-scout.md`'s "Why this exists" and `tools/web-scout/README.md`'s
intro no longer require that private project's own context to make sense -
led with the generic claim/evidence problem instead, demoted the
project-specific origin story to a clearly-marked aside, generalized
"this app"/`index.html` references to "the target app"/"your entry HTML",
and reframed Ask AI explicitly as an optional feature needing the caller's
own backend (this build's default URL happens to point at this repo's own
existing route, not a hard dependency). New `tools/web-scout/README.md`
section, "Using this on your own project", is the single place a forker
reads first.

Exit criteria:

- `cli.mjs` behaves identically after the `client.mjs` extraction (verified
  live against the real relay, not just `node --check`);
- `mcp-server.mjs` passes `initialize` -> `tools/list` -> `tools/call` for
  at least one action per namespace against the real relay, and its own
  test file passes;
- a tool-call failure (bad params, relay error) never crashes the server
  process or corrupts stdio framing - confirmed via the missing-param and
  unknown-action/unknown-tool test cases;
- README/roadmap document the session-model and `idb watch` exclusion
  honestly, matching what the code actually does, not the original (looser)
  scope text.

## V17 - tests + CI, CONTRIBUTING.md, glossary, Windows path fix (implemented)

Closed 4 concrete pre-open-source blockers, identified in a self-audit:
zero tests despite the main app having 1797, a README that assumed the
context of the private app this was built against from its first
sentence, no contribution guide despite explicitly wanting fork
proposals, and an unaudited claim of Windows portability.

**Tests (new):**
- `db.mjs.test.mjs` - 6 unit tests directly against `db.mjs`, using a new
  `WEBSCOUT_DB_PATH` env override (also added to `relay.mjs`'s `/config`
  display, so the two stay consistent) to point at a throwaway SQLite file
  instead of the real `webscout.db` - covers session lifecycle (including
  the one-active-session unique-index constraint), action logging +
  `listActionsSummary` redaction, snapshots/diffs, QA/console/net entries
  + limit capping, macros, and Verity run import.
- `cli.test.mjs` - 7 tests spawning `cli.mjs` as a real child process
  against the real relay: exit codes for unknown commands and validation
  errors, a full session start/current/list/end round trip, and a dom/idb/
  eval pass that skips (not fails) with no browser tab connected.
- Both new integration-style test files needed a **found-live fix**, not
  just new code: running `cli.test.mjs` and `mcp-server.test.mjs` together
  with `node --test`'s default parallelism produced a real, reproduced
  failure (`dom.query timed out after 15000ms`, then a cascading "session
  already active" on the next run) - the relay has exactly one server-side
  active session, and node runs test *files* concurrently by default, so
  two files' `session start`/`session end` calls raced each other.
  Confirmed the fix (`--test-concurrency=1`) by reproducing the failure,
  then reproducing a clean 20/20 pass with the flag added, twice. Also
  added a defensive `before()` hook to both files that best-effort ends
  any dangling active session before their own tests start - reproduced
  the scenario directly (a session left active by a deliberately-crashed
  test run) and confirmed the next run self-heals instead of cascading
  failures across every subsequent local run.

**CI (new):** `.github/workflows/web-scout-tests.yml` - path-filtered to
`tools/web-scout/**`, no install step (zero dependencies), starts the
relay, polls `/health` until ready, runs all 3 test files with
`--test-concurrency=1`, stops the relay in an `if: always()` step. No
browser tab is connected in the runner, so the tab-dependent assertions
skip themselves there rather than being flaky or requiring a headless-
browser setup this tool doesn't otherwise need.

**Windows path-portability audit:** grepped every `.mjs` file in
`tools/web-scout` for hardcoded path separators or string-concatenated
paths; every filesystem path already used `path.join` correctly. Found one
real bug outside that pattern: `client.mjs`'s `pageFresh` derived a URL
path from a local file path via simple string concatenation, so a
PowerShell/cmd caller passing a backslashed path (`js\db.js`, the natural
form outside Git Bash) produced an invalid `/js\db.js` URL. Fixed by
normalizing backslashes before deriving the URL path (URL paths are always
forward-slash, filesystem paths are platform-dependent - these are
different things that happened to look similar). Verified via PowerShell
directly (not just reasoning about it): `page fresh` against a real path
now derives a correct forward-slash served path.

**README generalization, round 2:** the intro's very first mention of the
project's own "CRV" shorthand (sentence one of the feature list) had no
definition anywhere before it - added a **Terminology** callout right after
the file's opening paragraph, before CRV's first use, defining it
operationally (declare/act/capture/diff) rather than asserting an
"official" expansion that was never actually spelled out anywhere in this
codebase (checked - it genuinely isn't). Added a link from the file's
opening line straight to "Using this on your own project" for a reader who
wants to skip past the reference-manual framing entirely. Concrete
example command lines from the private app this was built against (goal
strings, selectors) were left as-is, not sanitized - already clearly
framed as this build's own examples, not required reading, per V16's
framing work.

**`CONTRIBUTING.md`** (new): ground rules mined from the codebase's own
actual, repeated conventions (zero-dependency, `path.join` always, comments
explain WHY not WHAT, validate-at-the-boundary) rather than a generic
template; a concrete numbered walkthrough of the up-to-4 files a new
`dom.*`/`idb.*` command touches (`inject.js` always, `relay.mjs` only if it
needs its own persistence shape, `cli.mjs`, `mcp-server.mjs`, docs) written
by tracing a real example end to end, not guessed at.

Exit criteria:

- `node --test --test-concurrency=1` on all 3 test files passes cleanly,
  twice in a row, including immediately after a simulated crashed-test
  dangling session;
- the GitHub Actions workflow's exact test command was run locally first
  and confirmed passing before being committed to the workflow file;
- `page fresh` with a backslashed local path produces a correct
  forward-slash served path (verified in real PowerShell, not just Git
  Bash);
- a reader hits a definition of "CRV" before its first use in the README,
  not 250 lines after.

## V18 - CRV friction fixes from a real P4.3 session (implemented)

Not a self-audit this time - every item here traces to a specific, named
friction point hit during one real CRV pass (Shadow Model Integration
Readiness, P4.3), reviewed and turned into proposals immediately afterward
rather than guessed at in the abstract.

- **`db version-check` (new CLI command) + `db.probeUpgrade` (new inject.js
  command):** `db.version` already reported the live tab's IndexedDB
  version, but nothing answered *why* a version-bump upgrade wasn't taking -
  that CRV pass stalled on exactly this (`indexedDB.open` returned
  `blocked`, diagnosed only by hand-rolling an `onblocked` probe via `eval`).
  `db.probeUpgrade` is that probe made reusable: opens at a target version,
  aborts its own `upgradeneeded` transaction immediately (never commits a
  real migration), and resolves fast with `blocked:true/false` instead of
  waiting out the blocking tab's own close. `db version-check` wraps it:
  reads `js/db.js`'s `DB_VERSION` off disk, compares to the live version,
  and on drift runs the probe automatically - one command instead of a
  session-start-only passive warning plus a manual `eval` fallback.
- **`dom wait --changed` (new mode on an existing command):** every
  AI-review button in the app this was built against swaps a loading
  placeholder for a real result - the placeholder element already exists,
  so a bare selector-exists `dom.wait` resolves instantly and proves
  nothing; the caller previously had to predict the eventual result text
  ahead of time just to wait correctly. `--changed` snapshots the
  selector's `textContent` at call time and resolves as soon as it differs,
  with no prediction required.
- **`page reload [--hard] --wait-reconnect` (new flag):** both reload
  primitives reply *before* the real navigation fires, by design (so the
  reply isn't dropped mid-reload) - but that left no signal for "the reload
  actually finished." A real session hit `no web-scout agent named
  'default' connected` on the very next command, on a guessed sleep that
  was too short. `--wait-reconnect` polls `GET /agents` client-side (in
  `client.mjs`, shared by both `cli.mjs` and `mcp-server.mjs`) until the
  target agent is seen to *disconnect* then *reconnect* - not just
  "present," which could still be the pre-reload connection, not yet torn
  down.
- **`idb.deleteMany` response detail:** was `{deleted, failed}` (counts
  only); a real session grepped for a count field that didn't match what it
  expected and fell back to a follow-up `idb snapshot` just to confirm the
  delete actually happened. Now returns `deletedKeys`/`failedKeys` arrays
  alongside the counts, so a caller can confirm exactly which rows went
  away without a second round trip.
- **`eval` timeout message fix:** the message already suggested "pass a
  larger timeoutMs" but named the internal param (`timeoutMs`), not the
  actual CLI flag (`--timeout`) or MCP param path a caller would type -
  reworded to name both, and to state plainly that the default (10000ms)
  is unrelated to any server/provider-side timeout, since a real
  ~180-second AI-provider call hit this twice before the flag was found.
- **Windows `/dev/stdin` gotcha, documented (not fixed - it's a Git Bash
  limitation, not a bug in this tool):** `eval --file /dev/stdin` with a
  heredoc fails with `ENOENT ... open 'D:\proc\self\fd\0'` on Windows -
  `/dev/stdin` doesn't resolve correctly for this CLI's file read there.
  Added directly next to the `eval --file` usage text and the README's
  scripting example: write the payload to a real temp file instead.
- **MCP parity:** `webscout_dom.wait` gained `changed`, `webscout_page.reload`
  gained `waitReconnect`/`timeoutMs`, and `webscout_meta` gained
  `db_version_check` - all three implemented as calls into the same
  `client.mjs` helpers (`dbVersionCheck`, `waitForReconnect`) `cli.mjs`
  uses, per this file's own stated reason for `client.mjs`'s existence
  (shared logic, not copy-pasted-and-drifting). `SERVER_VERSION` bumped to
  `0.17.0`.

**Considered and explicitly not done:** capturing response bodies in `net
history`/`net log` (the original motivating gap - diagnosing an
`AI_RESPONSE_INVALID` failure needed the raw provider response text, which
net capture doesn't store, forcing a second, real ~180s provider call by
hand via `eval` just to see it). Rejected because the only way to read a
response body is `res.clone().text()`, which must fully drain the body
before resolving - doing that before returning `res` to the real page code
delays every real fetch, including a long-running or streaming one,
directly violating this tool's own stated invariant (Product principle 6,
above): never silently change the page's own behavior while observing it.
No fire-and-forget variant was found that avoids this without either
racing the real response or requiring `net log`/`net history` entries to be
mutated after the fact. Left as a known, documented gap rather than shipped
half-safe.

Exit criteria:

- `node --test --test-concurrency=1` on all 3 test files: 20/20 pass, no
  regressions from any of the above;
- `db version-check` correctly reports `blocked:true` against a real
  cross-tab version lock (the exact scenario that motivated it) and
  `blocked:false` once the blocking tab is closed;
- `dom wait --changed` resolves on a real placeholder-swap render without
  the caller supplying an expected substring;
- `page reload --wait-reconnect` returns only after the agent is
  genuinely back, not on the first (possibly stale) `GET /agents` poll.

## V19 - CLI + dashboard lessons from a real P4.4 CRV session (implemented)

Every item here traces to a specific friction point hit during one real CRV
pass (Deterministic Component Integration Trial, P4.4) against a real,
large, production-data IndexedDB - not a self-audit.

- **`session start --stores` (new flag) + `sessions.strict_crv_stores`
  (new column):** `--strict-crv` auto-snapshots the WHOLE db before/after
  every `dom.click`/`dom.fill`/`eval`/`idb.put`/`idb.delete` - against a
  real-size app db this hits `SNAPSHOT_TIMEOUT_MS` (60s) and is unusable.
  A real session had to abandon `--strict-crv` entirely mid-CRV (end the
  session, start a fresh one without it) for exactly this reason.
  `--stores a,b,c` at session-start time scopes every one of those
  auto-snapshots to just the given stores, the same way `idb snapshot
  --stores` already scopes a manual one - persisted per-session so the
  relay doesn't need it re-passed on every dispatch. A `--strict-crv`
  session started with no `--stores` prints a warning up front instead of
  silently timing out later.
- **`dom.click` gains `mutated`/`hrefChanged` in its response:** a nav
  link whose target hash already equals `location.hash` reported
  `{clicked:true}` and nothing else - the SPA's hashchange-driven router
  never fires (no `hashchange` event on a same-value assignment), so the
  page never re-renders, previously indistinguishable from a genuine
  successful no-visible-effect click. A short (200ms) `MutationObserver`
  window around the click now reports whether the DOM actually mutated and
  whether `location.href` changed - a real signal instead of none.
- **`page reload --hard` reconnect timeout, and a plain-reload warning:**
  a hard reload additionally unregisters every Service Worker and clears
  Cache Storage before navigating, which can genuinely take longer than a
  plain reload's default 15000ms `--wait-reconnect` wait - a real session
  hit a `reconnected:false` false-negative on a hard reload that had, in
  fact, finished cleanly moments later. The default wait is now 30000ms
  for `--hard` specifically (still overridable via `--timeout`). Separately,
  a plain `page reload` does NOT bust a Service Worker's cache at all - a
  stale-while-revalidate SW can keep serving old cached JS across several
  plain reloads after a real edit, which cost a real session a genuine
  `VersionError` (stale-cached JS still declaring an old `DB_VERSION`,
  racing a DB a properly-fresh tab had already bumped). `page reload`
  (without `--hard`) now warns once, up front, whenever the repo has a
  `sw.js` at its root.
- **`eval --file` fails loud on an empty read:** the known Windows/Git
  Bash `--file /dev/stdin` gotcha (documented in V18) has a quieter
  sibling - a POSIX-style temp path (e.g. `/tmp/...`) that doesn't throw
  but also doesn't resolve the way the caller expects, silently reading as
  an empty string, which then evals as a no-op and returns `{}` with zero
  signal anything was wrong. `--file` now throws immediately if the read
  content is empty/whitespace-only, naming the likely cause.
- **`idb get <store> <key>` (new command) + `idb.get` (new inject.js
  handler):** `idb dump` only ever does a whole-store scan
  (`store.getAll()`) - finding one already-known-key row in a large real
  store (confirmed: `cfi_cognitive_runs`) previously meant either a slow
  full dump or a hand-rolled `eval` reaching for the app's own
  `db.getRecord` directly. `idb get` is a real indexed `store.get(key)`
  lookup exposed as a first-class command.
- **`idb list` gains per-store row `counts`:** cheap (`store.count()`, no
  row payload transferred) - lets a caller check a store's real size
  BEFORE requesting a snapshot, instead of only discovering it's huge after
  a 60-second timeout. `idb snapshot` (CLI) now checks this automatically
  when called unscoped and warns if the total row count looks large,
  before attempting it.
- **Dashboard: "hard reload now" button on the existing IndexedDB-drift
  banner** - the banner already named the fix (`page reload --hard`) as
  text; a caller without the CLI open had no way to act on it from the
  dashboard itself. One button dispatches `page.hardReload` directly
  (requires an active session + connected agent, same as any other
  `/command` dispatch - failures shown inline, not thrown).
- **Dashboard: "diff vs now" button per snapshot row** - `idb
  diff`/`diff-golden` already existed CLI-side and diffs were already
  viewable once computed, but there was no one-click "what's changed since
  THIS snapshot, right now" from the dashboard itself (the CLI-side
  equivalent, `session cleanup --since-snapshot`, has no dashboard
  counterpart). Takes a fresh snapshot of the same stores and diffs it
  against the row clicked, rendered inline.
- **MCP parity:** `webscout_idb` gained `get`; `webscout_session.start`
  gained `strictCrvStores`; `webscout_page.reload`'s `waitReconnect`
  inherits the same hard-reload-aware default timeout as the CLI.
  `SERVER_VERSION` bumped to `0.18.0`.

**Considered and not done this round:** dashboard-side surfacing of
`idb.list`'s new per-store `counts` before a snapshot is triggered FROM the
dashboard itself (the CLI-side warning exists; the dashboard's own
snapshot-taking paths - golden-baseline capture, "diff vs now" above - are
comparatively rare/deliberate actions rather than an easy-to-mis-scope
default, so the same size warning was judged lower-value there for now).

## V20 - liveness/diagnostic lessons from a real P4.5 CRV session (implemented)

Every item here traces to a specific friction point hit during one real CRV
pass (Comparative Decision Utility, P4.5) against a real, large,
production-data IndexedDB and a real, slow-booting (hundreds of unbundled ES
module files) tab - not a self-audit.

- **`eval` statement-body `__note` now checks for a TOP-LEVEL `return`, not
  any `return`:** the old check was a bare `/\breturn\b/.test(expr)` - it
  matched a `return` nested inside an inner function/arrow (e.g. a hand-
  wrapped `(async () => { ... return x; })();`), which never reaches the
  outer statement body and still yields `undefined` - so the `__note`
  existing specifically to explain that case silently failed to fire for
  it, twice, in a real session, before the real cause (a trailing `;`
  pushing expr into the statement-body fallback) was found by hand.
  `hasTopLevelReturn` now tracks brace depth (skipping string/template-
  literal contents) and only counts a `return` at depth 0 - best-effort,
  not a real parser, but a real improvement over a substring search.
- **`eval` warns (stderr, not blocking) when `expr` looks like a hand-
  wrapped IIFE:** `(async () => { ... })();` is unnecessary now (the
  statement-body fallback already handles multi-statement input) and is
  exactly the shape that caused the `__note` miss above - flagged up front
  instead of relying on a caller noticing after the fact.
- **`page reload` / `--hard --wait-reconnect` default timeouts raised
  (15000->45000 plain, 30000->60000 `--hard`):** confirmed live against a
  real unbundled-module app that a full reboot legitimately takes 45-60s+ -
  well past V19's already-once-raised `--hard` default, and past the plain
  default too. `--timeout` still overrides either.
- **`ping` (new CLI command) + `POST /ping` (new route) + `ping` (new
  inject.js handler):** a deliberately trivial round trip (no DOM/
  IndexedDB work at all) with its own short budget (`PING_TIMEOUT_MS`,
  3000ms) - confirmed real friction diagnosing a stuck tab: every other
  diagnostic (`page reload`, `idb list`, `eval "1+1"`) paid its own full
  ~15-20s timeout in serial while answering the same underlying "is the
  page thread even responding" question. Does not require an active
  session. Still routes through the same page-side message queue as every
  other command, so it cannot prove liveness against a genuinely blocked
  synchronous loop - only answers faster than the alternatives when the
  page IS still responsive.
- **`agents_detail` (new field on `GET /health` and `GET /agents`):**
  `agents_connected`/`agents` only ever reported socket-level presence -
  confirmed actively misleading during a real stuck-tab episode, where it
  kept reporting the agent "connected" for several minutes while the page's
  JS thread was not responding to anything. Each connected agent now also
  reports `connectedAt` and `lastAckAt` (stamped on ANY reply, success or
  failure, `ping` included) - the one honest "is the page thread itself
  still alive" signal, additive so no existing caller's shape changes.
- **`GET /health`'s `db_version_drift` check gets its own short timeout**
  (`DB_VERSION_DRIFT_TIMEOUT_MS`, 3000ms, was `COMMAND_TIMEOUT_MS`,
  15000ms): confirmed live to drag `/health` itself - meant to be a cheap
  status read the dashboard polls every few seconds - down to a full 15s
  whenever the connected tab was slow/unresponsive, exactly when a fast
  `/health` reply mattered most for diagnosing that.
- **`session start --auto-snapshot --stores a,b,c` (new flag):** takes and
  persists a scoped `idb.snapshot` right at session start and prints its
  id. Closes a real gap in `session cleanup --since-snapshot <id>` (the one
  cleanup mode that catches eval/UI-button writes, not just `idb.put`/
  `idb.delete`): it needs a snapshot taken BEFORE mutating, and that step
  was confirmed easy to forget until after the writes already happened, at
  which point there is no way to retroactively recover a "before" state.
  Unscoped is refused (same 60s risk as an unscoped `idb snapshot`).
- **`session end` prints a "consider macro record" nudge** when the ended
  session logged 5+ replayable actions and was never saved as a macro -
  `macro record` already existed, but a real repeatable shape (seed/verify/
  cleanup) was confirmed hand-rolled from scratch again the next phase with
  no prompt pointing at the feature that already solves it.
- **`idb dump <store> --where '<json>'` (new flag):** client-side post-
  filter, same exact-equality semantics as `session assert`'s own `where` -
  every inspection needing a filtered view previously required a full dump
  piped to `node -e ...` and hand-written JSON filtering. Response's
  `count` is the filtered count; `totalCount` is always the real whole-
  store count.
- **`dom query/click/fill/rect/style/wait --selector-file <path>` (new
  flag):** reads the selector from a file (trimmed) instead of the shell
  arg - same fix, same reason, as `eval --file`: shell-quoting a selector
  with nested quotes/brackets/attribute-value strings through bash was
  confirmed real, repeated friction, not hypothetical.
- **Doc fix: `eval`'s "reload it" advice for a synchronous infinite loop**
  now says plainly that `page reload` is itself a dispatched command
  needing the SAME blocked page thread, so it is not always a working
  escape hatch from that state - if reload (and `ping`) also time out
  repeatedly, that needs a manual, browser-side tab refresh the CLI cannot
  force. The old text implied `page reload` always worked as the fix.
- **Doc tips (no behavior change):** `eval`'s help text now reminds a
  caller that `*Crud.add()` returns a raw key, not the row - capture and
  return created ids explicitly for later cleanup/tagging. `dom wait
  --changed`'s help text now says to match `--timeout` to a known real
  provider/backend budget (confirmed as high as 180000ms in one real
  provider path in this app) rather than guessing a value shorter than
  what it's actually waiting on.

**Considered and not done this round:** MCP server parity for `ping`/
`--where`/`--selector-file`/`--auto-snapshot` (this round's friction was
hit entirely through the CLI in the real session that produced it; MCP
parity is deferred until a real MCP-driven session hits the same gaps, per
this project's own repeated-friction-first convention rather than
speculative surface growth). Dashboard-side surfacing of `agents_detail`
(a "last responded Ns ago" badge next to the connected-agent indicator) -
real value, but the CLI-side `status`/`ping` already answer the same
question and no real dashboard-only session has hit this gap yet.

## V21 - CLI/dashboard lessons from a real P4.6 CRV session (implemented)

Every item here traces to a specific friction point hit during one real CRV
pass (Controlled Decision Admission, P4.6) - not a self-audit.

- **Timeout != failure: `dom.click`/`dom.clickWait`/`dom.fill`/`idb.put`/
  `idb.patch` now auto-verify against live state after a genuine 504
  timeout** (`verifyAfterTimeout` in `relay.mjs`, run from `dispatchTracked`,
  logged as its own `timeout.verify` action). A timeout only proves the
  RELAY never got a reply in time - not that the page never received or
  even finished the command. Confirmed live: a `dom.click` that timed out
  was treated as "the click failed" and retried, when `idb.dump` ground
  truth later showed it had actually landed. The verification result is
  attached to the thrown error as `postTimeoutVerification` (via a new
  `extra` field on `HttpError`, surfaced through `POST /command`'s error
  body and `client.mjs`'s `request()`) and printed by the CLI's top-level
  catch instead of a bare, uninformative timeout message.
- **`dom wait --stable [--stable-count <n>]` (new mode):** resolves once a
  selector's textContent reads IDENTICAL on `n` (default 3) consecutive
  polls, for this app's own confirmed fire-and-forget concurrent-render race
  (several unawaited `renderAll()` calls landing on the same DOM node after
  a navigation/click). `--changed` fires the INSTANT the first of several
  in-flight renders lands, which can still be a mid-race, about-to-be-
  overwritten intermediate state - a live `eval` poll was the only way to
  confirm the real settle point before this existed.
- **`page reload --wait-reconnect` false-negative fix:** the old
  disconnect-then-reconnect check only proved reconnection if a poll
  happened to land during the (often sub-150ms) window the agent was
  actually absent - a fast reload could tear down and re-establish the
  WebSocket between two polls, so `present` read true on every single poll
  and the wait fell through to a false `reconnected:false` even though the
  tab genuinely came back. `waitForReconnect` (`client.mjs`) now also
  compares `connectedAt` (already-existing per-connection timestamp from
  V20's `agents_detail`) against its value at call time - a strictly LATER
  `connectedAt` is proof of a fresh connection regardless of whether the gap
  was ever directly observed.
- **`console wait "<substr>"` (new command) + `console.wait` (new
  inject.js handler):** same shape, same reason, as `net.wait` - a bare
  `console log` poll called immediately after triggering an action can race
  the app's own (often async) `console.error` call, reading as "nothing
  logged" even though the entry lands a moment later. `graceMs` (default
  3000) also matches an entry already recorded just before the call arrives.
- **Ambiguous-selector auto-pick for `dom.click`/`dom.fill`/`dom.query`:**
  when a selector matches multiple elements and exactly one is actually
  rendered (`offsetParent !== null`), that one is now used automatically
  (`autoPickedFromAmbiguous`/`filteredHiddenCount` in the response) instead
  of always hard-erroring. Confirmed live, twice: an unscoped
  `[data-id="26"]` silently matched an unrelated table row on a different,
  currently-hidden page/tab before the intended (visible) row - a single,
  silently WRONG match with no ambiguity error at all, worse than the
  already-guarded multi-match case. `dom.query` applies the same bias
  (never throws, read-only) and reports `matchCount`/`renderedMatchCount`.
  `--nth` always overrides and is never filtered.
- **`debug state` (new CLI command) + `debug.state` (new inject.js
  handler) + `window.__webscoutDebug.state`:** live introspection of this
  tool's own runtime state (WebSocket readyState, pending event-batch
  sizes, reconnect backoff) plus an app-declared `window.__appDebug` object
  if the app sets one - shrinks the manual "add a `console.error`, bump the
  importer's `?v=`, reload, read the log, remove it, bump again" debugging
  cycle confirmed as this session's single biggest time sink. Also directly
  `eval`-reachable with no relay round trip.
- **`idb patch <store> <json-key> <json-patch>` (new command) + `idb.patch`
  (new inject.js handler):** reads the existing row, shallow-merges the
  patch onto it, writes the merged row back - `idb put`'s real REPLACE
  semantics forced re-typing an entire row (copy-pasted from a prior `idb
  get`) for every small mutation (maturing an execution window, flipping
  `outcome_status`), with a real risk of silently dropping an untouched
  field along the way. Errors (rather than silently inserting a sparse row)
  if no existing row is found at the given key.
- **`dom click-wait <selector> [--wait-selector <sel>]` (new command) +
  `dom.clickWait` (new inject.js handler):** click, then wait for a
  (possibly different) selector to reach a state, in one round trip -
  closes a real gap in `dom.click`'s own `mutated:true`, which only proves
  SOME DOM change happened synchronously within its 200ms grace window, not
  that an async handler (dialog open, dispatch commit) is actually done.
  Confirmed live: a dialog-opening click reported `mutated:true`
  immediately while the dialog's own async logic was still running.
- **`GET /health`'s new `pending_command_count` field:** when several
  commands timed out back-to-back, there was no way to tell whether they
  were genuinely failing or simply queued behind a growing backlog. Exposes
  `pending.size` (in-flight, awaiting-reply command count) directly, so a
  string of timeouts reads as "stop retrying, something is jammed" instead
  of blind repeated retries making a real backlog worse.
- **Mid-session "consider macro record" nudge:** V20's nudge only ever
  fired at `session end` - too late to save the re-typing it exists to
  prevent, for a session that hand-rolls a repeatable shape and keeps going.
  `POST /command` now nudges (via a new `x-webscout-nudge` response header,
  read by `client.mjs`'s `request()` and printed to stderr - deliberately
  NOT folded into the JSON body, which is a command's own real result
  shape) the moment a session crosses 5 replayable actions, then again
  every 8 actions after that - never more than once per threshold.
- **`dev bump-reload <file>` (new CLI-only command):** finds every
  `<basename>?v=N` reference to a file anywhere in the repo and bumps each
  by +1, then runs `page reload --hard --wait-reconnect` - automates the
  manual half of this repo's own cache-busting convention (editing a file
  needs its version bumped at every importer, confirmed real, repeated,
  error-prone friction across an iterative debugging session). Warns
  (without silently "fixing") if importers disagreed on the version before
  the bump ran.
- **`debug sweep <tag>` (new CLI-only command, no session needed):** greps
  the whole repo for a tag string (e.g. a temporary debug marker like
  `P46DEBUG`) and reports every remaining hit - replaces the manual `grep
  -c ... && echo clean` check a caller previously had to remember and run
  by hand to confirm hand-added debug instrumentation was fully removed
  before shipping. Exits 1 if anything is still found.
- **Doc note (no behavior change): the post-`page reload --hard` slow-ack
  window.** The first ~5-10s after a hard reload is measurably flakier for
  writes/clicks than steady state, because the app's own concurrent init/
  render passes are still settling - not a bug in web-scout or the app,
  just a real timing characteristic worth knowing before reading an early
  post-reload failure as a genuine regression.

**Considered and not done this round:** MCP server parity for
`click-wait`/`idb.patch`/`console.wait`/`debug.state`/`dom.wait --stable`
(this round's friction was hit entirely through the CLI in the real session
that produced it, matching V20's own precedent for deferring MCP parity
until a real MCP-driven session hits the same gaps). A cleanup-verification
convention baked into the session-cleanup flow itself (auto-tagging/
sweeping debug instrumentation) - `debug sweep` covers the manual case for
now; folding it into `session end` was considered but deferred as
speculative without a second real session confirming the same gap.

## V22 - token-cost monitoring and waste-prevention dashboard (implemented)

Every prior version measured Web-scout's own *correctness*; nothing yet
measured what a session actually COSTS the agent reading its output back -
`result_json` on every logged action is the same substrate the CLI prints to
stdout, so a large/redundant result is real, spent tokens, not just DB rows.
This round adds an estimate-and-surface layer on top of the existing
`actions` table, with no new dependency and no change to what any command
returns by default.

- **`token-report [--session <id>]` (new CLI/relay command + `GET
  /token-report`, `GET /sessions/:id/token-report`):** ranks action TYPES by
  `chars/4`-estimated tokens (`resultBytes`/`paramsBytes`, a pure SQL
  `SUM(LENGTH(...))` aggregate - running the report never pays anything
  close to the bytes it measures). Session-scoped form also flags
  **repeated-call loops** (`findRepeatedActionLoops` - 3+ identical
  type+params calls within 5s, the confirmed real "eval 1+1 while waiting
  for boot" poll shape) and **redundant calls** (`findRedundantCalls` -
  `idb.dump`/`dom.query` calls spaced further apart whose result never
  actually changed - "did I already know this" re-checking, detected by
  comparing each call's result hash against the last call to the same
  store/selector).
- **Printed automatically, no flag needed:** `printResult` (`cli.mjs`) warns
  on stderr the moment a single result exceeds a token threshold, naming the
  scoping flag (`--where`/`--fields`/`--limit` for `idb dump`) that would
  have avoided it. `session end`/`session show` print a one-line cost
  receipt (`session #N cost: X call(s), ~Y estimated tokens`) and a
  budget-exceeded warning when the session declared one.
- **`session start --token-budget N` (new flag) + `sessions.token_budget`
  (new nullable column):** a purely advisory cost cap - nothing blocks a
  command from running over it, it only changes what gets printed/rendered
  once crossed. `DB_VERSION`-equivalent concept doesn't apply here (no
  schema-drift gate in this tool) - just a plain migration via the existing
  `ensureColumn` helper.
- **Same-session read-result cache (`relay.mjs`):** a read call
  (`idb.dump`/`get`/`list`, `dom.query`/`rect`/`computedStyle`, `net.log`,
  `console.log`) with identical type+params, with no mutating command
  (`dom.click`/`fill`/`eval`/`idb.put`/`patch`/`delete`/`clear`/
  `page.reload`) dispatched in between, is answered from an in-relay cache
  instead of re-dispatched to the page and re-logged as a new action -
  `sessionMutationCounters` (bumped on every mutating dispatch) invalidates
  the whole session's cache the instant anything could have changed. A hit
  returns the identical result plus `__cacheHit:true`/`__cachedAt`, never a
  reshaped response.
- **Dashboard "Token cost (estimated)" section (new):** budget burn-rate
  bar, per-type cost table, loop/redundant-call lists, and a cross-session
  cost trend grouped by any tag shared with the open session
  (`getSessionTokenTotals` - one `LEFT JOIN` so a zero-action session still
  appears at 0 rather than vanishing). A **Waste Radar banner** auto-surfaces
  the single worst-cost type when it's over 30% of the session's total AND
  the total exceeds 3000 estimated tokens (dismissible per type, same
  pattern as the existing friction/DB-version banners). The action log now
  **collapses runs of 3+ consecutive identical type+params rows** into one
  togglable summary row instead of rendering each individually - purely a
  client-side render optimization on top of the already-fetched list, no
  server change.
- **`idb snapshot --since <snapshotId>` (new flag):** takes a fresh
  snapshot scoped to the baseline's own stores, then prints ONLY the
  add/remove/change delta (via the existing `/state/diff` route) instead of
  a full dump - `idb.snapshot` is a top-3 all-time cost offender precisely
  because a full dump prints every unchanged row alongside whatever actually
  changed.
- **`dom query <selector> [--full]` selector-shape warning:** warns on
  stderr BEFORE dispatch when the selector looks like a whole-page/root
  container (`body`, `html`, `#app`, `#root`, `main`, `#main`, `*`) - a
  pre-call heuristic, cheaper than the existing post-call size warning,
  since it costs nothing to check the selector string itself.

## V23 - token-cost round 2: per-target ranking, dedup, and macro/suite cost awareness (implemented)

V22 answered "which command TYPE costs the most"; this round answers "which
SPECIFIC store/selector, macro, or repeat diff" - and, for the first time,
actually reduces bytes stored/re-sent instead of only measuring them.

- **`token-report`'s new `byTarget` field:** the same estTokens ranking as
  `byType`, but grouped by the actual store (`idb.dump`) or selector
  (`dom.query`) inside it - "`idb.dump` costs 90K tokens total" doesn't say
  WHICH store; `byTarget` does (`getActionCostByTarget` in `db.mjs`, reusing
  `findRedundantCalls`'s own target-extraction key).
- **`idb dump <store>` historical pre-call hint:** when called unscoped (no
  `--where`/`--fields`/`--limit`), the CLI checks that store's own `byTarget`
  history before dispatching and warns with a REAL learned number ("store X
  dumped 40x before, averaging ~Y estimated tokens/call") instead of a
  static heuristic - the same historical-average machinery `macro run`
  below reuses.
- **`dom query --meta` (new flag):** skips `outerHTML`/`text` entirely -
  just `tag`/`id`/`className`/`matchCount` (~50 bytes) - for the common
  "does this exist / how many matched" check that never reads markup at
  all. Stronger than the existing default cap (V21-era 2000/1000 chars):
  opts OUT of paying for content, rather than paying a capped amount by
  default.
- **`macro run`/`suite run` pre-replay cost estimate:** prints an
  estimated-tokens NOTE on stderr before replaying, summing each step's own
  action type's historical average `estTokens`/call - a caller can trim a
  macro/suite before paying for it, not discover the cost after the fact.
- **Content-addressed result dedup (new `result_blobs` table,
  `actions.result_hash` column):** a result byte-identical to one already
  seen - even in a DIFFERENT session, e.g. the same fixture store dumped
  every CRV round - is now physically stored ONCE; every later occurrence
  just bumps a `ref_count` and leaves its own `actions.result_json` NULL.
  Read-side `resolveResultJson` falls back to the blob by hash transparently
  everywhere a result is read; every cost-report SQL aggregate `LEFT JOIN`s
  `result_blobs` so LOGICAL byte counts (what a caller actually receives)
  stay exact regardless of physical dedup. `getResultDedupSavings()` reports
  real bytes never duplicated on disk, not an estimate.
- **Macro step compaction at record/update time:** `compactMacroSteps`
  collapses consecutive identical type+params steps (a retried click, a
  double-submit) before persisting - `compacted_steps_removed` on the
  response says how many. `steps_cost_est` (new `macros` column) stamps
  each macro's own historical-average cost ONCE at record time, so `macro
  list`/`macro run` read it back with zero live lookup.
- **Golden-diff memoization by content, not id:** `state_snapshots` gained
  a `content_hash` column (hash of its own `stores_json`) - two DIFFERENT
  snapshot ids whose content is byte-identical (every `idb.snapshot` takes a
  fresh id even when nothing changed) now produce the SAME diff. When
  `idb diff`/`idb diff-golden` recognizes this (`findCachedDiff`), the full
  diff body is NOT recomputed or re-sent - the response carries
  `fromCache:true`/`cachedFromDiffId`/`diffOmitted` and only the (already
  tiny) summary, with the full diff still persisted and fetchable by id for
  data-integrity/audit purposes.
- **`token-report`'s new `savings` block (no `--session`):** combines every
  mechanism above's own REAL, measured numbers - `resultDedup`,
  `goldenDiffCache`, `macroCompaction` (from real DB rows, survives a relay
  restart) plus `runtimeReadCache` (V22's read-result cache's own hit
  count/bytes saved - in-memory only, resets on restart, labeled as such).
  Deliberately four separate real ledgers, not one fabricated composite
  score.
- **First-cache-hit awareness nudge:** the FIRST time in a session a call
  is actually served from the read-result cache, a one-time
  `x-webscout-nudge` header (same mechanism as V21's mid-session macro
  nudge) tells the caller right then - a just-in-time teaching moment tied
  to a real event, not a passive doc a caller has to already know to read -
  and points at `token-report`'s `savings` block for the aggregate proof.

**Considered and not done this round:** a real tokenizer replacing the
`chars/4` estimate (ranking command types against each other doesn't need
exact-token precision, and every number here is already labeled as an
estimate); MCP server parity for `--meta`/`--since`/the pre-call hints (CLI-
only friction this round, matching V20/V21's own precedent of deferring MCP
parity until a real MCP-driven session hits the same gaps).

## V24 - token-cost round 3: row-level snapshot dedup, macro no-op skip, cross-macro step dedup (implemented)

V23 deduped a whole action RESULT; this round goes one level finer -
individual snapshot ROWS and individual macro STEPS - plus stops a macro
from paying for a write that changes nothing.

- **Row-level snapshot dedup (new `snapshot_rows` table):** `idb.snapshot`
  previously stored a full `stores_json` blob every time, even though most
  rows in a real store don't change between two consecutive snapshots (V23's
  whole-store `content_hash` cache only helped when the ENTIRE store was
  unchanged). `internSnapshotRow`/`resolveSnapshotRow` (`db.mjs`) hash and
  store each row's own JSON once, ever - a snapshot's `stores_json` becomes
  `{storeName: {rowHashes: [...]}}`, expanded back transparently on every
  read (`resolveStores`). Deliberately content-only (no store+key in the
  hash) - two different stores holding byte-identical rows legitimately
  share one physical copy. `getSnapshotRowDedupSavings()` is the proof.
- **Macro `idb.put` no-op skip:** a replayed `idb.put` whose row (identified
  by an explicit `id` field) is already byte-identical to what's stored is
  skipped entirely - no dispatch, no logged action - instead of paying a
  full round trip to write back the same data. The `idb.get` pre-check
  itself is never logged (would eat into the very savings this produces).
  Only safe for a row carrying an explicit `id`; autoIncrement-keyed inserts
  always dispatch normally (heuristic, not a general keyPath resolver).
- **`macro run` compact-by-default response:** a step's full result was
  previously echoed back in FULL on every replay forever, even though a
  caller almost never needs it (it already has each step's result from
  recording time). Default response now keeps only
  `{type,ok,skipped,reason,durationMs}` per step; a FAILED step always keeps
  full detail (the one case debugging actually needs it); `{"full": true}`
  opts back into everything.
- **Cross-macro step dedup (new `step_blobs` table):** two macros sharing an
  identical prefix (navigate-to-page, log-in) previously each stored that
  step's full `{type,params}` JSON separately. `internStep` (`db.mjs`) hashes
  and stores each step's content once, ever, regardless of how many macros -
  or how many times within one macro, post-compaction - reference it.
  `getStepBlobDedupSavings()` is the proof.

## V25 - token-cost round 4: macro read-cache wiring, column-dictionary compaction, macro templating, within-suite diff memoization (implemented)

- **Macro run wired into the same-session read-result cache:** V22's
  same-session read-result cache previously only applied inside `POST
  /command` - a macro replaying a read step (`idb.dump`/`dom.query`/...)
  dispatched to the page every single time, even right after an earlier step
  (this replay, or an earlier `/command` call this session) already asked
  the identical question with nothing mutating in between. Wired through
  `macro run`'s own replay loop now too - a hit skips dispatch entirely,
  response carries `skipped:true, reason: "read result served from
  same-session cache"`. Fixed a real correctness gap in the same change: a
  macro's own MUTATING steps (`idb.put`/`idb.delete`/...) were never bumping
  the session's mutation counter, meaning a stale cached read from before a
  macro's mutation could still be served afterward - `macro run` now calls
  `bumpMutationCounter` for every mutating step it dispatches, same as
  `POST /command` always has.
- **Column-dictionary snapshot compaction:** `buildColumnDictionary` (V24
  runs BEFORE row-hashing, complementary to it) factors a field VALUE
  repeating `>=2` times across one store's rows in a single snapshot (e.g.
  500 rows sharing `status:"active"`) into a small per-store dictionary,
  rewriting matching fields to a `{$d: index}` reference - shrinks storage
  even the FIRST time a store is ever snapshotted, on top of (not instead
  of) row-level dedup. Only applied when a real net-byte-savings check
  passes (`buildColumnDictionary` returns `null` otherwise) - a short,
  low-cardinality value's reference can cost MORE bytes than the value
  itself, caught live during this round's own verification (a 3-row
  synthetic fixture reported zero savings until the net-byte check was
  added) and fixed before shipping. `expandColumnDictionary` is the
  transparent read-side inverse. `column_dict_savings` table /
  `getColumnDictSavings()` is the proof.
- **Macro step templating:** `templatizeMacroSteps` (`db.mjs`) collapses a
  run of 3+ CONSECUTIVE steps sharing a type and param shape but differing
  by value only (bulk fixture-seeding `idb.put` calls, most commonly) into
  one `{template: true, paramsTemplate, varyingKeys, values}` entry;
  `expandTemplateSteps` transparently expands it back to the full concrete
  step list on every read (`hydrateMacro`) - invisible to every downstream
  consumer (relay routes, cost estimates, the suite runner, tests). A group
  with no varying keys (byte-identical steps) is left alone - V23's
  `compactMacroSteps` already handles that case. New
  `macros.templated_steps_removed` column, surfaced as
  `savings.macroTemplating`.
- **Within-suite diff-golden memoization:** `suite run` (`client.mjs`) now
  keeps a local `Map` scoped to one `runSuite` call, keyed by
  `${name}::${idB}` - a repeated LITERAL `diff-golden` step is answered from
  this map without issuing the `POST /state/diff` HTTP request at all,
  distinct from (and additive to) the DB-level content-hash cache (V23),
  which still pays the full request/response round trip even on a cache
  hit.

**Considered and not done this round:** suite-level snapshot reuse (the
original 4th idea for this round) - discovered mid-implementation to be
non-viable as conceived (the suite runner never dispatches `idb.snapshot`
itself, so there is no snapshot-taking step to intercept) and, more
importantly, fully redundant with the already-shipped V23 golden-diff
content-hash cache even in the case it was meant to help (two diffs with
identical CONTENT already reuse regardless of snapshot id). Replaced with
within-suite diff-golden memoization above rather than ship something
non-functional or duplicative.

## V26 - token-cost round 5: params/console/net/verity dedup, Friction Analytics redaction (implemented)

Closes the one real asymmetry left in the content-addressing pattern
(`actions.result_json` was deduped since V23; `actions.params_json` -
the very field loop/redundancy detection already groups calls BY - was
not) and extends the same pattern to the two highest-volume, explicitly
never-pruned tables (`console_entries`/`net_entries`, the latter confirmed
live at 60K+ real rows) plus `verity_runs`.

- **`actions.params_json` dedup (new `params_blobs` table):** same
  intern-on-write/resolve-on-read/`ref_count` shape as `result_blobs`,
  applied to params. Exposed (and fixed, in the same change) 5 real
  correctness landmines: `findRepeatedActionLoops`, `findRedundantCalls`,
  and 3 byte-counting SQL aggregates (`getActionCostReport`,
  `getActionCostByTarget`, `getSessionTokenTotals`) all read raw
  `params_json` directly and would have silently broken or undercounted the
  moment a row got deduped - all patched to resolve through the hash
  (`resolveParamsJson` in JS, `LEFT JOIN params_blobs` in SQL) before use.
  `getParamsDedupSavings()` is the proof.
- **Console/net text dedup (new `text_blobs` table):** `console_entries.
  message`/`stack` and `net_entries.url` now intern each repeated value
  once - a page logging the same warning, or hitting the same failing
  endpoint, on every poll no longer pays full bytes past the first
  occurrence. `console_entries.message` is `NOT NULL` (pre-existing schema,
  real production rows) - rather than a risky live rebuild of a
  60K-row-scale table, a deduped message is stored as `''` (satisfies
  `NOT NULL`) instead of `NULL`, resolved back via the hash exactly the
  same way; `stack`/`url` (already nullable) use a real `NULL` sentinel.
  `getTextDedupSavings()` is the proof.
- **`verity_runs.result_json` dedup:** reuses `result_blobs` directly (same
  content domain as an action result - no reason for a third table). Same
  `''`-sentinel convention as console messages (`result_json` is
  `NOT NULL`). A repeat CRV import of a mostly-unchanged scenario now
  stores that result JSON physically once.
- **Friction Analytics redaction (`GET /analytics`):** `listAllActions`
  (the one table-wide, cross-session action fetch in the whole codebase)
  now applies the same `HEAVY_ACTION_RESULT_REDACTORS` `listActionsSummary`
  already used - `computeAnalytics` only ever reasons about
  type/timing/loop patterns, never result content, so parsing and holding
  `dom.screenshot` dataUrls / `idb.snapshot` dumps / `net.log` entries in
  memory on every 5s server-side rescan (polled by every open dashboard
  tab) was pure waste with no consumer.

## V27 - token-cost round 6: snapshot-level dedup, diff content dedup (implemented)

Two structural gaps found on a fresh scan, one of them a real
self-inconsistency in an already-shipped mechanism rather than a new
feature.

- **Snapshot-level dedup (new `state_snapshots.served_from_snapshot_id`
  column):** row-level dedup (V24) already makes individual row content
  free on repeat, but the ORDERED REFERENCE LIST of row hashes per store
  (`stores_json` itself) was still written full-size on every single
  `idb.snapshot`, even when a store had zero changes since the last one -
  confirmed live at ~20KB/snapshot average across this project's own
  `webscout.db`. `saveSnapshot` now checks for an existing snapshot with
  the same `content_hash` (same cross-session-by-design lookup V23's
  golden-diff cache already uses) before doing any row-interning work at
  all; a match stores `stores_json` as `''` and points
  `served_from_snapshot_id` at the original, resolved back transparently by
  `getSnapshot`/`getGoldenSnapshot`. `getSnapshotDedupSavings()` is the
  proof.
- **Diff content dedup (new `state_diffs.diff_hash` column, reuses
  `result_blobs`):** the V23 golden-diff CACHE only ever skipped
  *recomputing* a diff on a content-hash match - `saveDiff` still wrote the
  full `summary_json`/`diff_json` payload into a brand new row every single
  cache hit, meaning `getGoldenDiffCacheSavings()`'s `bytesSaved` was
  reporting a number that was never actually saved on disk. `diff_json`
  (`NOT NULL`) now interns through `result_blobs` with the same
  `''`-sentinel convention as V26's verity fix; a cache-served diff
  physically stores nothing new. `getGoldenDiffCacheSavings()` rewritten to
  report the REAL bytes not re-stored (via the interned blob's own size),
  and deliberately EXCLUDED from `totalBytesSaved`/`totalEstTokensSaved` -
  since diff content now shares storage with `result_blobs`, a cache hit's
  bytes are counted by `resultDedup` already; summing both would double-
  count the same physical bytes (caught and fixed in this same round,
  before shipping).

## V28 - CRV tooling lessons from a real P4.8 session, plus a fresh-scan follow-up (implemented)

Two passes. The first turned 12 proposed lessons from a real P4.8 CRV into
work; a fresh scan afterward found 6 more. Six of the first 12 (durable
sessions across hard reload, DB-version-drift reload guidance, ambiguous
`dom.click` candidate list, `session assert`, golden-diff cache keying, and
the page-level-cache staleness gotcha) were checked against source and were
either already implemented or documentation-only - no code change, and the
golden-diff cache in particular was confirmed correct (keyed on content
hash, not snapshot id).

Pass 1 - new:
- **`net capture <substr>` / `--off`:** opt-in response-BODY capture for
  fetch/XHR entries whose URL matches, capped at 4000 chars, persisted to
  `net_entries` (new `body_preview_hash`/`body_truncated` columns, body
  deduped through `text_blobs`). Replaces hand-patching `window.fetch` via
  `eval` to see a raw response a validator discards on failure.
- **`session cleanup --summary`:** per-store counts instead of full row
  bodies.
- **`idb put-many`:** one transaction, per-row failure reporting (a bad row
  calls `preventDefault()` on its own request so it does not abort the
  batch). Also recognized by cleanup's action-log tracker - caught live, a
  put-many-seeded write was initially invisible to cleanup.
- **Running session token total:** `x-webscout-session-tokens` response
  header (same header-not-body convention as the macro nudge, so it can
  never change a command's own result shape), printed to stderr past a
  threshold.
- **`idb snapshot --where`:** exact-equality row filter applied in-page
  before the WebSocket; the saved snapshot carries `where_json`.
- **`idb put --dry-run`:** validates shape against the store's real
  keyPath/autoIncrement in a readonly transaction; skips strict-CRV's
  auto-snapshot wrapping since nothing can change.

Pass 2 - fresh scan:
- **Multi-filter `net capture`:** filters are a set; each call adds one,
  `--off` clears all. The single-string version lost the first arm the
  moment a second endpoint was armed.
- **`idb put-many --dry-run`:** the one bulk-write path with no validation
  mode after `idb put` got one.
- **`session cleanup --summary` size estimate:** `estBytes`/`estTokens` per
  store, from row content already in memory. `--since-snapshot` mode only -
  action-log mode never reads rows back, so it reports 0 bytes.
- **`WEBSCOUT_TOKEN_THRESHOLD`:** env override for the hardcoded 5000-token
  print threshold.
- **Ticker undercount fix:** a same-session read-cache hit skips
  `withLoggedAction`, so no `actions` row is written and the DB-side running
  total never counted those bytes - even though the cached result is still
  returned in the reply and read by the agent. A per-session
  `sessionCacheHitBytes` counter is now added into the header. (The
  originally proposed framing - "ticker overstates on cache hits" - was
  backwards; checking the code before implementing showed it undercounts.)
- **`token-report` `byMacro`:** groups a session's cost by `params.macroId`
  (ad-hoc calls bucket under `macroId: null`), answering "which CRV phase
  cost what" instead of only "which command type." Session-scoped only.
- **Pre-existing bug found while verifying:** `token-report --session <id>`
  sliced off its own `--session` flag (`rest.slice(1)` on an already-
  stripped arg list) and silently queried the all-time endpoint every time,
  so per-session scoping never actually worked from the CLI. Fixed.

`inject.js` cache-bust bumped to `?v=3` in the host app's `index.html`.

## V29 - relay lifecycle, self-contained tests, one command registry, MCP parity, and an honest savings dashboard (implemented)

Ten lessons from the V28 session, each grounded in friction that session
actually hit, plus a dashboard panel for the token-savings numbers. Several
turned out to be real bugs rather than conveniences; those are called out.

**Relay lifecycle (lesson 1).** `relay start|stop|restart|status` (new
`relay-control.mjs`) replaces `pkill` - which silently does nothing against a
Windows-native node process - and the netstat + taskkill dance. The relay
writes a pidfile on listen; a relay started before pidfiles existed is found by
asking the OS which process LISTENS on the port, and `stop` refuses to kill a
port owner that does not answer `/health` like a relay. The relay also records
the mtime of `relay.mjs`/`db.mjs`/`ai.mjs`/`report.mjs`/`command-registry.mjs`
at boot: `/health` reports `relay.stale_source_files`, every reply carries an
`x-webscout-relay-stale` header that the CLI turns into a one-time stderr
warning, and the dashboard header shows a badge. A green test run can no longer
quietly be validating stale code.

**Self-contained tests (lesson 2).** `test-relay.mjs` starts an ephemeral relay
on a free port with a throwaway database (auto-open off), so `cli.test.mjs`,
`mcp-server.test.mjs` and the new `relay-behavior.test.mjs` always exercise the
code on disk and can run in parallel (`--test-concurrency=1` is gone; CI no
longer starts a relay). `relay-behavior.test.mjs` uses a fake in-page agent
speaking the real WebSocket protocol, so dispatch, the read cache, cleanup
tracking and the token headers are tested without a browser. Tests that need a
real tab now `t.skip()` visibly (they used to pass silently) and run under
`WEBSCOUT_TEST_LIVE=1`.

**One command registry (lesson 6).** `command-registry.mjs` declares, per
command type, whether it is mutating / strict-CRV / macro-default / long-poll /
read-cacheable / timeout-verifiable / auto-screenshotted, and how session
cleanup tracks its writes. `relay.mjs` derives its seven Sets (and the cleanup
tracker's branches) from it. `command-registry.test.mjs` fails when `inject.js`
grows a handler the registry does not classify, or a write is half-classified.
Writing it found a real bug: `net.clear`/`console.clear` were not in the
mutating set, so a cached `net log` kept being served after `net clear`
(mutation-tested: the new behavior test fails without the fix).

**Per-call token delta and MCP delivery (lessons 4, 5).** The ticker now reads
`session running total: ~60024 estimated tokens so far (+66 this call)`
(`x-webscout-call-tokens`, omitted right after a relay restart, which has no
baseline). The earlier claim that stderr reaches both callers was wrong: an MCP
host routes a server's stderr to its logs, never the model. `client.mjs` now
routes notes through `collectNotes()` (an AsyncLocalStorage collector) and
`mcp-server.mjs` appends them to each tool reply as extra text content; the
first content item is always the tool's own result, unchanged.

**`net log --limit N --url <substr>` and `console log --limit N` (lesson 3).**
Filtered in the page (`inject.js`, `?v=4`), so the 500-entry ring buffer never
crosses the wire. The old `net log --limit 3` silently ignored the flag and
printed all 236 entries (~55KB).

**Arguments are checked before dispatch (lesson 9).** `cli-spec.mjs` declares
every command's positional arity and flags; an unknown flag or extra positional
exits 1 with what was rejected and what the command does take. This is the
class behind the V28 `token-report --session` bug, and a typo'd `--dryrun` on
`idb put` would have written the row. `usage()` moved out of a ~600-line
template literal into `usage.txt` - which exposed a live bug in the old help
text: an unescaped `D:\proc\self\fd\0` had been printing as `D:procself` plus
a form-feed and a NUL byte. Git Bash rewriting a leading `/` argument into a
Windows path (`net wait /api/save`) is now detected and warned about.

**CLI/MCP parity and docs drift (lessons 7, 8).** `cli-spec.mjs` also maps each
CLI command and flag to its MCP counterpart or a reasoned exemption;
`cli-parity.test.mjs` reads the live tool list from a spawned MCP server.
Writing it found real gaps, all now closed: MCP had no `token_report`, `ping`,
`debug_state`, `idb patch`, `dom click_wait` or `console wait`; `idb dump` could
not be scoped (`where`/`fields`/`limit`); `dom query` had no `full`/`meta`;
`idb snapshot` had no `since` (now shared as `snapshotSince()` in
`client.mjs`); `session start` had no `tokenBudget`; `macro run` had no `full`.
`docs-drift.test.mjs` requires every command and flag in `usage.txt` and every
command in the README (which had none of the last round's additions).

**Monorepo <-> standalone sync (lesson 10).** `scripts/sync-web-scout.mjs`
reports divergence and, on request, replays missing commits either way as
patches (`--push` at the remote's tip in a temp worktree, tested, plain
fast-forward; `--pull` re-rooted under `tools/web-scout` via `git am`). Missing
commits are decided by subject, not patch-id: a replayed commit keeps its
subject but gets a new patch-id, so `git cherry` reported the same commit as
both ahead and behind. It also avoids `git subtree split` (~110s here vs ~2s).
At the time of writing the standalone repo is 5 commits ahead of the monorepo
(React fiber inspection, an Action log UX pass, a shared panel shell for every
dashboard panel) - none pulled yet.

**Token savings dashboard panel.** A new all-time panel renders
`GET /token-report`: what callers actually READ next to what each mechanism
saved, one row per mechanism with a `kind`, a reduction percentage, and
evidence (`337 results -> 133 stored`), plus where the spend still is (top
command types and single targets, each with the flag that shrinks it). Building
it required being precise about what the ledgers measure, and they measure
DISK: every DB ledger (result/text/snapshot-row/snapshot/params/step/column
dedup) counts bytes not stored a second time in `webscout.db`. Dividing by 4
gives a token-EQUIVALENT, not tokens a caller avoided - dedup makes the
database smaller, it does not shrink what a call returns. Measured on the live
database: callers read ~1.21M estimated tokens over 1,980 calls; dedup kept
~673 KB (172K tokens-equivalent) off disk, 2.9% of a 23 MB database. Bytes a
caller avoided by scoping a call (`--where`, `--fields`, `--limit`, `--since`,
`--meta`) are never incurred, so no ledger sees them. `savings.ledgers` carries
`kind` (storage / delivery / roundtrip / workflow) and `countedInTotal` (the
golden-diff cache overlaps result dedup, so it is shown, not added);
`savings.storageContext` and `savings.spend` sit beside it. The read-cache
counters, which reset on every relay restart, are now persisted
(`read_cache_savings`) - restarts are routine now.

**Known gap, closed in V30.** The same-session read cache invalidates only on a
mutating command. A page can change on its own (background traffic,
async renders), so an identical `net log`/`console log`/`dom query` repeated with no
command in between can return a stale cached result. `__cacheHit:true` and
`__cachedAt` in the reply say so; a short TTL on the volatile types would close it.

## V30 - measured scoping, a cache that notices page changes, and sync/relay recovery (implemented)

Ten lessons from merging V29 with the standalone repo's five commits, each
closing a gap that session left visible.

**Scoped reads are measured (lesson 1).** The V29 savings panel said what
scoping (`--where`, `--fields`, `--limit`, `--url-contains`, `--meta`) saves was
"unmeasured", yet that is the saving a caller actually feels. The page knows the
unscoped size, so each scoping handler in `inject.js` reports `avoided` bytes on
its reply (exact up to 2000 rows, a 200-row sample above); the relay records it
in a new `savings_daily` table. It shows as a `delivery` ledger (`scopedReads`)
and a tile. It is an upper bound - the caller may never have made the unscoped
call - and the ledger says so.

**The read cache validates against the page (lesson 2).** Invalidating only on
our own mutating commands served a stale `net log`/`dom query`/`idb dump` from a
page that changed by itself. `inject.js` keeps a change counter (a
MutationObserver on the document, every fetch/XHR and console entry, and
`IDBObjectStore`/`IDBCursor` writes, counted again when their transaction
commits); each reply carries it as it was BEFORE the handler ran, and a cache
hit costs one tiny `page.epoch` probe. A changed counter is a miss. This beats a
TTL, which is either too short to help or too long to be safe. The cache key now
includes the tab: the same query on two tabs used to share an entry.

**Whole-page selectors return an outline (lesson 3).** `dom query body|html|main|
#app|#root|*` used to answer with the first 2000 characters of markup - almost
always `<head>`/nav boilerplate - so the caller paid and asked again. It now
returns a depth-limited outline (`tag#id.class [children, text chars]`, at most
60 lines) unless `--full`. Checking the history first: the 50 broad calls that
made this look like a 237K-token hotspot ran before the default caps existed,
so the outline is about making the first answer useful, not a demonstrated
size cut. The CLI's pre-call warning is gone; the outline is the warning.

**Dashboard smoke test (lesson 4).** `dashboard.test.mjs` fails when a
`<section class="hud-section">` has no `PANELS` entry (it silently gets no
chrome) or the reverse, and loads the real dashboard in headless Chromium/Edge
(`browser-harness.mjs`) asserting every panel is wrapped and there are no page
errors. `inject-browser.test.mjs` does the same for the in-page agent.

**Sync script (lessons 5 and 6).** `scripts/sync-web-scout.mjs --check` predicts
conflicts for pending work in both directions without touching the tree;
`--pull` sets uncommitted `tools/web-scout` work aside and restores it, listing
conflicts if the restore collides (a `git stash pop` that prints "FAILED" has
still applied - it is never popped twice). Replayed commits carry a
`Synced-From: <sha>` trailer and matching prefers it over the subject, which
breaks on a reworded or squashed commit. The script now has tests against local
bare repositories; it shipped with an untested crash after a successful push.

**Line endings (lesson 7).** `tools/web-scout/.gitattributes` (`* text=auto
eol=lf`) keeps the index and every checkout LF. The "mixed endings" that forced
byte-level patch scripts were mostly Windows tooling: a Python text-mode write
turns `\n` into `\r\n`.

**Relay recovery (lesson 8).** A blanket `relay.mjs` kill by another session
took the relay down twice and nothing noticed until a call failed. On
ECONNREFUSED against a loopback relay the client now starts one, says so, and
retries once (at most once per 30s; `WEBSCOUT_NO_AUTOSTART=1` opts out; `relay
status` and `status` never start one). Sessions live in the database and tabs
reconnect on their own.

**Add-a-command scaffold (lesson 9).** `scaffold-command.mjs <ns.action>` stubs
the six files a command touches, each marked `SCAFFOLD(type)`;
`command-coverage.test.mjs` reports every surface a command is missing in one
failure and refuses unfinished markers.

**Savings over time (lesson 10).** `token-report` carries a 14-day `trend` (per
day: tokens delivered, tokens left out, `avoidedPct`, cache hits) and the panel
draws it, so "is the strategy improving" has an answer. Storage-dedup ledgers
cannot be bucketed by day (they derive from ref counts), so the trend covers
delivery only. `session end` prints its own line (scoped reads, cache hits).

## V31 - visible staleness, measured scoping, and test hygiene (implemented)

Ten lessons from V30, each a gap it left open or exposed.

**A tab that runs old code says so (lesson 1).** V30 changed `inject.js`, but the
app pins the script with `?v=4`, so a tab would keep running the old agent and every
new behaviour would silently be missing. `inject.js` now carries `AGENT_BUILD`, a
hash of the file with the stamp blanked (`build-id.mjs --stamp` writes it,
`agent-build.test.mjs` fails while it is out of date, the scaffold restamps). A tab
sends it on connect; `/health` lists `stale_agents`, every reply carries
`x-webscout-agent-stale`, the CLI/MCP client prints a one-time reload warning, and the
dashboard marks the tab. A tab that sent no build predates stamps and counts as stale.
The `?v=` bump in the app is still manual: the stamp says a tab is stale, the query
string is what makes a browser fetch the new file.

**The relay already knew (lesson 2).** Stale relay code was detected in V21
(`stale_source_files`, a header, a dashboard badge). What was missing was breadth:
`build-id.mjs` and `relay-control.mjs` are now on the watch list, and `relay status`
reports stale tabs next to stale files.

**A kill loop shows (lesson 3).** Autostart recovered from another session's blanket
`relay.mjs` kill so quietly that the kills went unnoticed. A relay that boots and finds
the previous one's pidfile left behind records an `unclean-exit` (`relay stop` removes
the pidfile, so an intentional stop never counts); the client records each
`autostart`. Both sit in a small log next to the pidfile and surface as
`events_24h` in `/health`, in `relay status`, and as a dashboard badge.

**Sync script (lessons 4 and 5).** The temp worktree delete retries and never fails
a run, and a run sweeps stale `web-scout-sync-*` directories first. `--hint` prints
one line when commits are unpushed (local refs only) and `--install-hook` wires it
into a post-commit hook that fires only for commits touching `tools/web-scout`.

**Skips are visible (lesson 6).** `WEBSCOUT_REQUIRE_BROWSER=1` (set in CI) turns a
missing browser into a failure. A skipped test proves nothing, and a runner that lost
its browser would keep reporting green.

**Encoding traps are tests (lesson 7).** `text-hygiene.test.mjs` fails on any CR,
control character or U+FFFD in a source, doc or help file - the accidents that used
to surface through manual byte checks.

**Test traps live in helpers (lesson 8).** `spawnClean` (strips `NODE_TEST_CONTEXT`)
and `isUp` (a raw-socket probe) in `test-relay.mjs`; the autostart and scaffold tests
use them.

**Scoping is judged by what the caller does next (lesson 9).** The scoped-read figure
is an upper bound: the caller may never have made the unscoped call, or may have made
it right after. A scoped read followed within 90s by the same read on the same tab
without the narrowing params is now counted as a re-read; `token-report`
`savings.readStrategy.reRead` gives the rate and the dashboard prints it under the
trend. A high rate means the bytes were "saved" and then spent.

**The outline is measured, not assumed (lesson 10).** For each whole-page outline the
page reports the size of the reply it replaced; the relay records both sizes and what
the caller did next: a different selector (the outline worked as a map) or the same
selector with `--full` (it was not enough). The storage-dedup total, which cannot be
bucketed by event, is now sampled (token-report, session end, every six hours) so the
14-day trend can show its day-to-day change.

## V32 - the ledgers measured disk and round trips; these measure what the caller reads (implemented)

V31 ended on an uncomfortable fact: every saving ledger except scoped reads counts
bytes not stored or a page trip not made. The figure that is the real spend - what a
caller's context actually receives - barely moved. V32 is ten changes aimed at
delivery, built on one rule: the relay logs and caches the FULL result, and only the
reply changes, and only when the caller asked or the session budget forced it.
Default replies are unchanged.

**A repeat read can be a pointer (1) or a delta (2).** A cache hit used to re-send the
whole body, so it saved a page round trip and no tokens. `--if-changed` answers an
unchanged repeat with `{unchanged:true, sameAs:<action id>, omittedBytes}`; `--delta`
also answers a changed page with only what changed (per array: rows added, changed and
removed by id; `net.log`/`console.log` entries have no id, so they are matched by
content and removed ones are counted, not listed). Both are opt-in because they are only
correct while the earlier result is still in the caller's context. The relay tracks what
was actually DELIVERED per session and call, by object identity, so a pointer is never
offered against a body the caller only saw a peek of, and a delta falls back to the
full body unless it is at least 30% smaller.

**No indentation (3), keys once (4).** stdout was `JSON.stringify(result, null, 2)`:
indentation and newlines are tokens on every call. It is compact when piped now (a
terminal, `--pretty` or `WEBSCOUT_PRETTY=1` keeps the indented form; MCP text is
compact). `--table` returns rows as `{columns, rows:[[...]]}`; it is presentation only
(the ledger, cache and DB keep objects), applies to 3+ row-objects that share keys, is
lossless (`sparse:true` marks a missing column) and is only used when smaller.

**Ask for the shape first (5).** `--peek` returns counts, columns, one sample row, the
byte size and an estimated-token band instead of the body. The full result is cached,
so the follow-up read costs the caller the body and the page nothing. What the caller
does next is measured: a narrowed read (the peek worked as a map) or the whole body
anyway (`peekThenFull`, whose bytes are taken back out of the peek's saving).

**The budget acts (6).** `--token-budget` only warned when a session ended over it. It
now arms a guard: past 60% of the budget a read over ~3000 estimated tokens returns its
shape (`guarded:true`, `--no-guard` forces the body) and rows come back tabular; past
85% the limit is ~1000. One stderr note per level. The running total the budget follows
counts bytes delivered after shaping, not bytes logged. `WEBSCOUT_READ_GUARD_TOKENS`
arms the same guard with no budget.

**Hints from behaviour, and whether they worked (7).** The relay watches how a session
reads and says one line: a full read right after the same target was scoped (naming the
scope the caller used), repeated full reads after scoping (use `--delta`/`--table`),
an identical read re-delivered in full from cache twice (add `--if-changed`). Each once
per target per session. `readStrategy.hints.adopted` counts the ones followed, so a
hint that nobody acts on shows up as noise instead of staying in the product.

**CI catches a change that makes replies bigger (8).** `token-benchmark.test.mjs` runs a
scripted baseline -> action -> verify session twice against a fixture: default reads and
the documented strategy. Default replies are pinned to a byte budget; the strategy has to
stay under a fraction of them. The fixture is a best case for the strategy, so the ratio is
a ceiling on the effect, not a forecast for real sessions. Doing this exposed a real bug
first: `inject.js`'s `openDb()` created an empty database when the app had not, so the
new automatic briefing would have left the app's own first `open(name, 1)` without its
upgrade. It now rolls the creation back, and the briefing skips a tab on an older agent.

**The estimator says how sure it is (9).** chars/4 remains the ledger unit (every past
number stays comparable) but is one ratio for JSON, markup and prose. `savings.estimator`
carries a low..high band per kind and `spend.estTokensBand` brackets the total. The band
is a rule of thumb until `calibrate-tokens.mjs --write` measures real ratios with the
token-counting endpoint (needs `ANTHROPIC_API_KEY`; it was not run for this release, so the
shipped bands are labelled uncalibrated).

**A briefing at session start (10).** `session start` returns store row counts, the DB
version and whether the tab and relay are current, from one bounded read - the 5-8
exploratory `idb list` / `db version-check` calls that open most sessions. Best-effort:
no tab, a slow page or a stale agent yields `{available:false, reason}`, never a failed
start; not a logged action; `--no-briefing` skips it.

**Honest limits.** Shaping savings are measured against the full result the same call
would have returned, so unlike scoped reads they are not an upper bound, but they are
still not "tokens saved" (V33 note: the per-session `token-report` "Read by callers"
now counts delivered bytes too - see V33 - so a shaped reply is no longer counted at its
logged size); the `deliveryShaping` ledger and the receipt carry the difference. A pointer or delta trusts the caller's word that it still holds the earlier
result. The tight thresholds (60% / 85%, 3000 / 1000 tokens, 30% delta margin) are
judgement, not measured optima.

## V33 - fewer tokens before the first read, one honest number, and a benchmark on real sessions (implemented)

V32 made a read cheaper when the caller asked for it. Using it showed where the tokens
still went: a CRV run reads the same state three times to prove one change; every
shaping option needed a flag on every call; the ledgers disagreed about what "read"
meant; the tool list and the help text were paid for before any read; the only benchmark
was a script that cannot lose; and V32 itself sat unused behind a relay nobody restarted.
Ten changes, same rule as V32 (log and cache the FULL result, change only the reply).

**`idb verify` (1).** `POST /state/verify` is the verify step of baseline -> action ->
verify in one call: re-snapshot the baseline's stores, diff, check `--expect
"notes:+1,tags:same"` (`+N` added, `+N+` at least, `-N` removed, `~N` changed,
`same`; JSON accepted), and answer in a few lines when it passed. A changed store you did
not name is "unexpected" and fails; no expectations means nothing may change. Rows come
back only for the stores that failed, changed rows as `{field: [before, after]}`, and the
snapshot and full diff are still saved, so the evidence trail is as complete as by hand.
The default baseline is the session's newest snapshot, so consecutive verifies each
measure one step. Pure logic in `crv-verify.mjs`.

**Lean sessions (2) and a measured adoption rate.** `session start --lean` makes tables,
pointer/delta and a shape for any body over ~4000 tokens the default for the session
(`--no-guard` on a call gives the body). `readStrategy.adoption` counts cacheable reads
by who chose the shaping - a flag, `--lean`, or nobody - with the bytes that flowed
unshaped, so the size of the opportunity is measured rather than assumed.

**Projection in the page (3).** The reads that return a lot now cut it in `inject.js`,
before it crosses the wire, and count what they cut in the scoped-reads ledger:
`dom query --pick`, `react inspect --pick` (dotted paths), `idb list --stores/--non-empty`,
`idb dump --count`, `idb get --fields`, `net log --failed/--fields`, `console log
--level/--contains/--fields`. All are in `SCOPING_PARAM_KEYS`, so a scoped read followed
by the unscoped one is still noticed.

**One delivered-bytes number (4).** `actions.delivered_bytes` records what the caller was
handed when that is less than the logged result. The running total, the budget, the
receipt and the per-type token report (`deliveredBytes`, `withheldBytes`, `estTokens`
following delivered) all read it; V32's separate `sessionDeliveryAdjust` correction is gone.
The logged result is still complete.

**A benchmark from real sessions (5).** `trace.mjs` exports a session anonymised (every
string becomes a same-length, same-equality stand-in; only `keyPath` values are kept) and
replays it through the reply pipeline under `default`, `leanBest` (every shape sufficed)
and `leanWorst` (callers always re-asked for the body). Four committed traces of real CRV
sessions gave read-byte ratios of 0.40-0.58 best case on three and 0.05 on one dominated by
a few huge reads - against 0.046 for the scripted fixture, which is a best case by
construction. The guard sweep moved the lean guard from 2500 (judgement) to 4000 tokens.
Four traces from one project are a small sample; `trace-replay.test.mjs` holds each band
with a margin so a regression fails, and says so.
**Corrected in V34** ([[web-scout-v34-round]]): the original worst-case figure here (0.52-0.75)
undercounted, because `leanWorst` only ever retried a `peek`/`guard` reply - a `pointer` or
`delta` reply (the default lean shape for a repeat/changed read) was never retried even though
"callers always re-ask" is supposed to mean exactly that. Once `leanWorst` also retries a
distrusted pointer/delta, the real worst case on these four traces is 1.01-1.08: a fully
distrusted lean session costs a *little more* than never shaping at all (the shape itself is a
paid round trip before the retry), not less. `read-pipeline.mjs` also now measures this live,
not just in replay: a `pointer`/`delta` reply followed within the window by a raw full re-read
of the same target bumps `pointerThenFull`/`deltaThenFull` (or `...ThenNarrowed`), the same way
a distrusted peek already did - see `getReadStrategyStats().shaping.pointer/delta`.

**A cheaper tool list and help (6).** `usage.txt` is ~16k tokens and every unknown command
printed all of it; the MCP tool list is sent on every session. `help.mjs` slices `usage.txt`
by its own structure (`help`, `help idb`, `help idb dump`, `idb dump --help`, `help all`); the
tool list was compressed from 17,973 to 16,296 bytes while gaining verify, pick and lean
(`+shape` names the five shaping params once); `schema-budget.test.mjs` fails a change that
grows either.

**Quiet by default (7).** At most 4 hints a session; a kind ignored twice goes quiet;
hint bytes are booked and set against what the adopting calls saved
(`hints.sentBytes/adoptedBytesSaved/netBytes`, first-order). The running-total note prints
only when a call added 1000+ tokens or the total crossed a doubling (the relay sets
`x-webscout-tokens-quiet`).

**A read-only contract (8).** `read-only-contract.test.mjs` fingerprints every IndexedDB
database, localStorage, sessionStorage, cookies and the DOM in a real browser around every
non-mutating registry command and around the briefing, snapshot and verify routes; the
registry cross-check fails until a new read command is added. Mutation-checked: making
`db.probeUpgrade` commit its upgrade fails it.

**A stale relay restarts itself at a session boundary (9).** `session start` restarts a
relay running older code than disk (nothing is in flight; tabs reconnect; the event is in
the relay log as `auto-restart`). Never mid-session, where it would drop the read cache and
what each caller holds - a warning only. `WEBSCOUT_NO_AUTORESTART=1` opts out.

**The estimator says how old its measurement is (10).** `savings.estimator.status` is
uncalibrated / partial / stale (over 90 days) / calibrated; `calibrate-tokens.mjs --check`
is the offline exit-code form, and `WEBSCOUT_REQUIRE_CALIBRATION=1` makes CI enforce it.
**The calibration itself was not produced**: it needs `ANTHROPIC_API_KEY`, none was
available, and a measured file is not something to invent. The bands stay labelled
uncalibrated until someone runs `calibrate-tokens.mjs --write` and commits the result.

**OPEN - item 10 is not finished (waiting on Anthropic credits).** To close it:
1. `ANTHROPIC_API_KEY=... node tools/web-scout/calibrate-tokens.mjs --write` (uses the free
   `count_tokens` endpoint; sample sessions come from the local relay DB), then
   `calibrate-tokens.mjs --check` must exit 0.
2. Commit `tools/web-scout/token-calibration.json`; the last test in
   `token-calibration.test.mjs` then stops skipping.
3. Set `WEBSCOUT_REQUIRE_CALIBRATION=1` in `.github/workflows/web-scout-tests.yml`.
4. Replace the "uncalibrated" wording in README, usage.txt and this entry with the measured
   bands and date.

Another provider's key does not substitute. The estimator predicts Claude tokens, and a
DeepSeek (or any other) tokenizer counts differently, so its ratios would be filed under a
`calibrated` status that describes the wrong model. If a proxy is ever wanted it needs its own
status (recording the tokenizer used) that CI does not accept as `calibrated`.

**Honest limits.** The lean numbers are a replay of four sessions from one project with a
two-point model of caller behaviour (always satisfied / always re-asks); real callers sit
between and the width of the band is the risk of turning lean on (V34 also now measures this
live, not just in replay - see below). The hint costing credits
only the adopting call. Thresholds (60%/85%, 3000/1000, the 30% delta margin, the 1000-token
and doubling note rule, 4 hints) are judgement except the lean guard, which the sweep chose.

## V34 - a real worst case, a corpus that grows itself, and the whole CRV loop in one call (implemented)

Asked the same question again ("what's the lesson on token-saving methodology") after V33
shipped. The honest answer: V33's OWN worst-case number was wrong (measured, not estimated -
`leanWorst` never actually retried a distrusted pointer/delta), the trace corpus was four
sessions and stayed four sessions, a CRV step still cost three round trips even with `idb
verify`, and calibration was blocked entirely on an API key nobody had yet. Eight changes.

**Calibrate from the agent's own transcript, no API key (1).** `transcript-tokens.mjs`
measures chars-per-token from Claude Code's OWN transcript `usage` deltas (input + cache-read +
cache-creation tokens before and after a tool call, minus that call's output tokens) instead of
the `count_tokens` endpoint - a line fit over many clean gaps (one tool call, one result, nothing
else in between) separates the per-character cost from the constant every reply carries.
`node tools/web-scout/transcript-tokens.mjs --write` (auto-discovers this machine's own
transcripts) or `calibrate-tokens.mjs --write` (exact, needs `ANTHROPIC_API_KEY`) both write the
same `token-calibration.json`; `estimatorInfo().method` and `source` say which one measured it.
An estimate, not the exact count - labelled as such.

**The lean worst case was undercounted, and is now measured live too (2).** `trace.mjs`'s
`leanWorst` strategy only ever retried a distrusted `peek`/`guard` reply - a `pointer` or
`delta` reply (the DEFAULT lean shape for a repeat/changed read) was never retried even though
"callers always re-ask" is supposed to mean exactly that. Fixed: on these same four traces the
real worst case is 1.01-1.08 (a small premium over the default, not the 0.52-0.75 saving
previously reported), because the shape itself is a paid round trip before the retry.
`read-pipeline.mjs` now measures the same thing live, per call, not just in replay:
`pointerThenFull`/`deltaThenFull` (or `...ThenNarrowed`) bump the same way a distrusted peek
already did, surfaced as `readStrategy.shaping.pointer/delta.followedByFull`.

**The trace corpus grows on its own (3).** `session end --trace` (also `webscout_session.end
{trace:true}`) exports the session that just ended, anonymised the same way `trace.mjs export`
already was, into `traces/auto/` (gitignored - `WEBSCOUT_TRACE_DIR` overrides it, used by the
test harness so a test run never writes into the real project tree). Nothing here is
auto-promoted into the committed, benchmarked `traces/*.json.gz` - that stays a human choosing
a good session and adding a `MEASURED` entry in `trace-replay.test.mjs`.

**Byte budgets on real replies, not just the static tool list (4).** `schema-budget.test.mjs`
only ever capped what is sent before anything happens (the MCP tool list, help slices).
`reply-budget.test.mjs` caps actual RUNTIME replies against fixed, deterministic fixtures: an
`idb verify` PASS, a `session start` briefing at its own `BRIEFING_MAX_STORES` worst case, and a
`--table` dump - so a field quietly added to a default reply fails the build.

**The whole CRV loop in one call (5).** `crv run --stores a,b --type dom.click --params
'{"selector":"#x"}' --expect "notes:+1"` (relay: `POST /crv/run`; MCP:
`webscout_idb.crv_run`) takes its own baseline snapshot, dispatches the action, then runs the
same `verifyAgainstBaseline` `idb verify` already uses (now a shared helper) - baseline -> action
-> verify in one reply instead of three round trips, each its own full-body reply, done by hand.
`idb.snapshot` is refused as the action (take the baseline with `idb snapshot` instead); the
action failing fails the whole call, same as a bare action would. Scoped deliberately: strict-CRV
sessions' own reply shape (full diff, not a verify report) was left alone - a larger, separate
change with its own blast radius across existing tests and docs, not folded into this one.
Found and fixed while building this: `saveSnapshot`'s own return value carries no store content
(a summary only, same as `/state/snapshot`'s reply) - the first draft of `/crv/run` passed that
straight to the verify step, silently comparing against an empty baseline every time.
`crv-run.test.mjs`'s pass/fail-expectation/action-fails cases caught it immediately.

**Real usage evidence for the tool list (6, scoped down).** The lesson asked for splitting the
MCP tool list into a small core plus a secondary `webscout_more`-style tool, chosen by real
usage. That split was NOT done - there is no usage history yet to base it on, and guessing which
actions to hide would be exactly the kind of unmeasured claim this whole series argues against.
What shipped instead: `token-report`'s `neverCalled` - every dispatchable action type this relay
has never logged a single call for, all-time (excludes the internal `ping`/`page.epoch`), with a
`sampleSizeCalls` and a note when the sample is still too small to trust "never". The evidence a
future round would need before touching the schema.

**Does `help all` still get called (7)?** `help` is served locally from `usage.txt` and never
otherwise reaches the relay, so there was no way to know. `cli.mjs`'s `noteHelpUsage` now fires a
best-effort, un-awaited `POST /help-used` on every `help` call (never blocks, never affects the
exit code even with no relay reachable); `token-report.helpUsage` totals `all` against `sliced`.

**A reaper for leaked test relays (8, not token-related, but the same round's own housekeeping
cost).** A hard-killed test run (Ctrl-C twice, a crashed CI runner) leaves an orphaned relay
process and its temp dir behind - confirmed real again this round: 15 orphaned relays and 48 temp
dirs found and cleaned by hand. `startTestRelay()` now registers every relay it starts in a small
JSONL registry and runs `reapLeakedRelays()` once automatically per run (only entries older than
30 minutes, never port 8973); `node tools/web-scout/reap-test-relays.mjs` runs it on demand.
Found and fixed while building this: a CLI test using `spawnClean` (synchronous `spawnSync`) to
run a command that needed a same-process `connectFakeAgent()` tab to answer deadlocked outright -
`spawnSync` blocks the caller's whole event loop, which is exactly what the fake agent's
WebSocket `onmessage` needs to fire. `spawnAsync` (non-blocking) is the fix, and the trap is now
documented on `spawnClean` itself. Separately: the reaper CLI could not live as a block inside
`test-relay.mjs` - Node's test runner's default file discovery also matches `test-*.mjs`, so a
bare `node --test` (no explicit glob) started picking up `test-relay.mjs` itself as a pseudo test
file and failing on it; it is its own file, `reap-test-relays.mjs`, instead.

Versions: relay 0.21.0, MCP server 0.22.0. Full suite: 332 pass, 3 skipped (2 need a live tab,
1 - `token-calibration.test.mjs`'s committed-file check - waits on a measured calibration, still
true this round; `transcript-tokens.mjs --write` closes that without a key whenever someone runs
it, but nobody has yet).

## V35 - the estimator calibrates itself, a real reply gets smaller, and two repeat incidents get closed for good (implemented)

User re-asked the "lesson to improve token saving" question again (same ask as V32/V33/V34), got a
fresh 6-item list scanned against the CURRENT tree (V34 and the session-viz round both already
shipped by then), said "implement all". All six done in `tools/web-scout`.

**`relay.mjs` no longer binds a port on a bare import (1).** `server.listen()` (and the
pidfile/registry/signal-handler setup around it) now only runs when this file is the actual
process entry point (`isMainModule`, checked with `import.meta.url` against
`pathToFileURL(path.resolve(process.argv[1])).href` - the same technique `transcript-tokens.mjs`
and `trace.mjs` already used for their own CLI guards). This is a direct fix for a repeat incident:
V34's own roadmap entry already recorded a `node -e "import('./relay.mjs')..."` syntax-check
accidentally binding the real port with no env override, and the exact same mistake happened AGAIN
in this round before the fix landed - confirmed via `relay-import-safety.test.mjs` (a plain import
never binds a port and the process exits on its own; the real entry point still does).

**A relay with nothing calibrated tries to fix that itself (2).** `transcript-tokens.mjs` gained
`autoCalibrateIfMissing()`: on a relay with `estimatorInfo().status === 'uncalibrated'`, discover
this machine's own Claude Code transcripts, calibrate from them (no API key), and write
`token-calibration.json` - never touching a calibration that already exists, even a stale one.
Wired into `POST /sessions` (`session start`), deferred past the response with `setImmediate` so
the scan never delays the caller. Gated behind `WEBSCOUT_AUTO_CALIBRATE=1`, **opt-in, not
opt-out**, and that flip is itself the story: the first version defaulted this ON and skipped it
only via an opt-out env var the test harness was supposed to set - and a test run immediately wrote
a REAL `token-calibration.json` from this machine's real transcripts into the project tree, because
four other test files (`relay-control.test.mjs`, `auto-restart.test.mjs`, `autostart.test.mjs`,
`relay-events.test.mjs`) spawn a genuine `node relay.mjs` for their own reasons and none of them
knew about the new flag. Fixed by inverting it: off by default, and set to `1` only at the two real
call sites that start a relay for actual use (`client.mjs`'s `autostartRelay`/
`ensureFreshRelayForNewSession`, `cli.mjs`'s `relay start`/`restart`) - every test-spawned relay,
by construction, never sets it. The four sibling test files also got `WEBSCOUT_TOKEN_CALIBRATION`
(and, for the two that exercise the real restart/autostart path and therefore DO get the flag,
`WEBSCOUT_TRANSCRIPT_HOME` pointed at an empty fixture dir) as defense in depth. The accidentally
written file was deleted, untracked, before it ever reached git status.

**`--crv-compact` (3).** `session start --strict-crv --crv-compact` adds a sampled preview of what
changed (the same shape `idb verify`'s pass branch already returns) to the strict-crv auto-block's
own reply, alongside the existing counts - sparing the separate `idb diff <idA> <idB>` full-body
fetch a caller otherwise makes by hand once a bare count is not enough to tell whether the right
rows changed. New `sessions.strict_crv_compact` column, off by default (NULL): an ordinary
`--strict-crv` session's reply is provably byte-shape-identical to before this round
(`crv-compact.test.mjs`'s first test). Deliberately scoped smaller than V34's punted "make
strict-crv use the compact verify shape" idea - this ADDS a field, it does not change the existing
`diff_summary`/`diff_id` shape at all, so nothing that depends on the current reply breaks.

**Real usage evidence gets somewhere to be seen (4).** V34 shipped `token-report.neverCalled` and
`.helpUsage` as measurement; nothing ever rendered either one - `dashboard.html` had zero
references to both fields. `renderUsageEvidence()` now shows them in the savings panel (a new
`#usageEvidenceNote` block): which action types this relay has never logged a call for (with the
small-sample caveat), and what fraction of `help` calls were `help all` vs a sliced command.
Verified in a real headless browser (`dashboard.test.mjs`'s new browser test), not just unit-tested
against the JSON.

**The `traces/auto/` pile gets ranked, not just grown (5).** `trace.mjs rank-auto [dir] [--top N]`
replays every trace in the auto-export pile and ranks it by the same leanWorst distrust-rate signal
`read-pipeline.mjs`/the dashboard already surface - the trace where shaped replies got re-asked for
most often is the one that would actually stress-test the committed benchmark, not an arbitrary
recent session. Promoting one into `traces/*.json.gz` is still a human's call, unchanged from V34's
own decision on this - `rank-auto` only turns a folder into a short list.

**The leaked-relay reaper covers real relays too, not just test ones (6).** The registry +
`reapLeakedRelays()` (previously private to `test-relay.mjs`) moved to `relay-control.mjs`, the
shared module both `relay.mjs` and `test-relay.mjs` already import from. `relay.mjs`'s own
`isMainModule` startup block now registers itself (`dir: null`, since a real relay has no
throwaway temp dir of its own) and runs the reaper once, so a hand-started or autostarted relay
that gets killed outside any test run is found and cleaned up the next time ANYONE starts a relay,
not only the next `node --test`. `WEBSCOUT_RELAY_REGISTRY` (read fresh per call, same convention as
`pidfilePath()`) lets a test isolate this without ever touching the real, shared default -
`relay-self-register.test.mjs` proves a real spawned relay registers itself and that a hard-killed
one is still reaped, never against port 8973 regardless.

**Why:** V33/V34 both attacked read shape and round-trip cost; this round closes what was left
unattended around the edges - a calibration nobody ever produces, a repeat process-safety incident
(twice now, same mistake), measurement with no viewer, and a benchmark corpus that grows but is
never curated. **How to apply:** `WEBSCOUT_AUTO_CALIBRATE=1` is the flag to know about if
calibration still is not appearing after several real sessions - check it is actually set (autostart
and `relay start`/`restart` set it; a hand-run `node relay.mjs` does not, on purpose).
`node tools/web-scout/trace.mjs rank-auto` before manually picking through `traces/auto/`. Never
`node -e "import('./relay.mjs')..."` for a syntax check, even now that it is safe to do so by
accident - `node --check relay.mjs` is still the right tool and does not run the module at all.

Versions: relay 0.22.0, MCP server 0.23.0. Full suite: 350 pass, 3 skipped (2 need a live tab, 1 -
the committed-calibration check - same as every prior round, still open pending either a real
`transcript-tokens.mjs --write`/`calibrate-tokens.mjs --write` run or enough real sessions for
`WEBSCOUT_AUTO_CALIBRATE` to produce one on its own).

## V36 - ranking by WHY instead of just WHAT, a nudge instead of a silent pile, an honest "still uncalibrated" reason, and a test-runner bug that was silently eating tests (implemented)

User re-asked the "lesson to improve token saving, especially methodology/mechanism" question again
(same ask as V32-V35), got a fresh 4-item list scanned against the CURRENT tree (V35 already
shipped by then), said "implement all". All four done, plus one unplanned but load-bearing fix
found mid-implementation, in `tools/web-scout`.

**`token-report` ranks by intent, not just by command (1).** `byType`/`byTarget`/`byMacro` all
answer "what was called"; nothing answered "why". `intent-import.mjs` already recovers the agent's
own narrated reason from its transcript and writes it onto every action a narrated call produced
(`actions.intent`) - unused for cost ranking until now. `db.mjs`'s new `getActionCostByIntent`
groups by the exact intent text (one narrated call's window can cover several logged actions - a
strict-CRV click logs four - so this collapses them to one row, and collapses a repeated
verification narration back to one line too), bucketing anything with no intent under a labelled
null row, same shape as `byMacro`'s null-macroId bucket. Session-scoped only, wired into
`GET /sessions/:id/token-report` as `byIntent`. `viz-endpoint.test.mjs`'s existing narrated-session
fixture proved the grouping directly: the 4 actions one narration produced land in one row, the
rest bucket separately.

**`--crv-compact`'s new `samples` field had zero byte-cap coverage (2).** V35 added a `samples`
block to the strict-crv reply; `reply-budget.test.mjs` (the file whose whole job is catching an
unbounded field before it ships) never got a case for it. Added one at a fixture near the field's
own worst case (3 stores, each hitting `sampleStoreDiff`'s 3-rows-per-bucket cap on all 3 buckets
at once - measured 3697 bytes, capped at 4400).

**A top-ranked auto-exported trace gets a nudge, not silence (3).** `trace.mjs rank-auto` (V35)
was fully manual - the `traces/auto/` pile could grow indefinitely with nobody ever told a good
promotion candidate was sitting in it. `session end --trace` now runs the same ranking against the
trace it just wrote; if that trace lands in the top 3 by distrust rate, an extra stderr line names
its rank and points at `rank-auto` - quiet otherwise, so an ordinary export does not get a nudge
every time. Same "consider macro record" pattern `session end` already uses for a different signal.

**`estimatorInfo()` now says WHY a relay is still uncalibrated, not just THAT it is (4).**
"no usable token-calibration.json" read identically whether `WEBSCOUT_AUTO_CALIBRATE` was never set
on this relay, was set but had not run yet, was still running, or had already run and found
nothing - four different situations an operator would act on differently, reported as one generic
line. `token-estimate.mjs` gained an optional `autoCalibrate` param (`{enabled, scheduled,
outcome}`) - passed in by `relay.mjs` only, since a pure estimator module has no way to know a
relay's own runtime state by itself - and appends the specific reason to `savings.estimator.note`
while `status === 'uncalibrated'`. `relay.mjs`'s `maybeAutoCalibrate()` now records its own outcome
in a module-level variable instead of discarding it after logging.

**Unplanned: a test-runner ordering bug was silently dropping tests from three files, in CI's own
invocation (5, found verifying item 2, not proposed).** While measuring item 2's fixture,
`reply-budget.test.mjs` ran its FULL 4 tests under a plain `node file.mjs` but only 1 under
`node --test --test-force-exit file.mjs` - the exact command `CONTRIBUTING.md`'s "Testing" section
and CI both use - with no failure or skip reported anywhere, just tests missing from the run's own
count. Root cause: the file declared one `test()` synchronously, THEN did
`const relay = await startTestRelay()` at module top level, THEN declared three more `test()`
calls once that await resolved - `--test-force-exit` was found to exit as soon as the pre-await
test finished, before the post-await ones ever registered. A repo-wide scan for the same shape
(a `test()` before a top-level `= await start...`) found two MORE files already shipped with it:
`crv-verify.test.mjs` (silently running 6 of 10) and `trace-replay.test.mjs` (silently running 2
of 11 - losing its four `replay:`/guard-sweep tests AND all four of the committed real-trace band
checks). All three fixed by moving the relay-startup await (and everything it gates - `BASE`,
`before`/`after`, fixtures) above the file's first `test()` call; verified by diffing plain-node
vs `--test-force-exit` counts per file (now identical everywhere). This was never on the proposed
list - it surfaced because measuring item 2's actual worst-case byte count meant literally running
the file both ways and noticing the counts disagreed.

**Why:** V33-V35 each closed a specific token-cost or process-safety gap; this round is aimed at
the tooling built to CATCH the next one - a cost ranking that answered "what" but never "why", a
corpus-growth signal nobody was nudged to look at, a diagnostic message that collapsed four
different root causes into one line, and (found along the way, not proposed) three test files
whose own byte-budget and replay-correctness guarantees were not actually running in CI at all,
silently. The V35 auto-calibrate incident was caught BECAUSE the full suite was run as a matter of
course; this round is a reminder that "the suite passed" and "the suite ran everything it claims
to" are not the same fact, and are worth checking directly once in a while, not assumed.
**How to apply:** run a new or edited relay-touching test file BOTH plain (`node file.test.mjs`)
and with `--test-force-exit` at least once and diff the test counts if anything about its
top-level structure looks unusual (a `test()` before an `await`, in particular) - `CONTRIBUTING.md`
now says this explicitly. `token-report --session <id>`'s new `byIntent` is only informative once
`session intents`/transcript import has actually run for that session - an unnarrated session still
gets exactly one row, the null-intent bucket.

Versions: relay 0.23.0, MCP server 0.24.0. Full suite: 373 tests (up from 350 - the 3 recovered
files plus new coverage), 3 skipped (2 need a live tab, 1 - committed calibration - still open,
same as every prior round). One pre-existing, documented Windows-only flake remains
(`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` at process exit, landing on whichever
file happens to finish near the full run's end - not new this round, not caused by anything here,
and already named in `CONTRIBUTING.md`'s own `spawnClean`/`isUp` paragraph).

## Explicit non-goals

- Becoming a general-purpose browser automation/testing framework (a
  Playwright/Puppeteer replacement) - Web-scout is a local evidence-capture
  and mutation-verification relay for this app specifically, not a
  cross-site automation tool. `dom.screenshot` (V4) is a best-effort DOM
  rasterization, not a step toward compositor-level automation.
- Pixel-perfect, compositor-level visual capture (no CDP access from a
  normal page-side script) - `dom.screenshot`'s SVG-`foreignObject`
  technique is a documented best-effort approximation, not this.
- An authorization boundary between multiple named agents sharing one
  relay, or between the relay's operator and its own recorded data.
- Pruning or size-limiting the persisted console/network tables - accepted
  as a known, documented trade-off, not silently inherited.
- Replacing `tools/ui-verifier` for any question its narrower accessibility
  surface can already answer.
