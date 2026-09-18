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
