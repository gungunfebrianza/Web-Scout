# Web-scout

Web-scout is a local browser-instrumentation relay for AI coding agents and
operators. It injects an in-page agent into a target app's own entry HTML
(dormant unless explicitly activated), relays full DOM/IndexedDB/network
access through a dependency-free local WebSocket+HTTP server, persists
everything it records to a local SQLite database, and serves a realtime
dashboard for a human to watch the same data.

The name reflects the boundary: **Web** because it operates on the raw web
page - DOM, IndexedDB, network, console - not an accessibility abstraction
of it; **scout** because its default posture is observation and evidence-
gathering (declare a goal, then act, then record what changed), not silent
control. It is not a browser extension distributed separately, not a
production feature, and not a replacement for direct backend/API
verification.

The reusable implementation lives in [`tools/web-scout/`](../tools/web-scout/README.md).

## Why this exists

An AI coding agent (or a human) saying "I made the change and it works" is
not evidence - it's a claim. Web-scout exists to make the actual check
cheap and durable: declare what you're checking, take an action against a
real, already-open browser tab, capture the DOM/IndexedDB/network state
before and after, diff it, and treat that diff (not the agent's own
narration) as the evidence. That evidence is persisted to a local SQLite
file and visible live in a dashboard - not printed once to a terminal that
scrolls away.

This works against **any** web app with a page you can attach a `<script>`
to - there is no framework, backend, or database requirement baked into the
core session/action/snapshot/diff model. See ["Using this on your own
project"](../tools/web-scout/README.md#using-this-on-your-own-project) in
the command reference for the generic setup; the rest of this document
occasionally references this repo's own app as a running example, called
out explicitly where it does.

Web-scout makes that discipline a first-class, persisted, and optionally
*enforced* feature of a real tool instead of ad-hoc script boilerplate:

- declare a session's goal/context before any action is permitted;
- dispatch DOM/IndexedDB/network/console operations against an already-open
  tab, each one logged;
- capture full before/after IndexedDB state and compute a diff keyed by
  each store's real primary key - never assuming every store uses `id`;
- optionally (`--strict-crv`) make the before-snapshot/act/after-snapshot/
  diff sequence automatic around every mutating command, so the discipline
  cannot be silently skipped;
- ask an AI to explain a session's recorded evidence, with the exact prompt
  sent persisted alongside the answer;
- watch all of it update live in a dashboard, and export a finished session
  as a shareable report.

## Relationship to Verity UI Relay

Web-scout and [`tools/ui-verifier`](../tools/ui-verifier/README.md) (Verity
UI Relay) are deliberately opposite tools, not two versions of the same
idea:

|  | Verity UI Relay | Web-scout |
|---|---|---|
| Surface | Windows UI Automation accessibility tree | Raw DOM, IndexedDB, network, console |
| Default posture | Observation; interaction is double-gated per action | Full read/write once a session is active |
| Code injection | None - no extension, no application code | An in-page agent script, always |
| Arbitrary JS | Explicitly refused | An explicit, labeled escape hatch (`eval`) |
| Platform | Windows only (UIA) | Any browser the target app runs in |
| Threat model | Safety gate - stop an accidental production side effect | Evidentiary gate - require a stated goal before any record |

Neither supersedes the other. Prefer Verity whenever the accessible UI
surface is enough to answer the question - it needs no application
instrumentation and cannot itself become an XSS-equivalent surface. Reach
for Web-scout specifically when the question is about DOM internals,
IndexedDB row-level state, network traffic, or console/error output that
Verity's accessibility-tree view cannot see.

Where the two do meet, deliberately, is evidence *bundling*, not a merged
trust model: Verity's own `scenario` command persists nothing on its own
(stdout only, unless a human redirects it), so `POST /verity/import` (and
`cli.mjs verity import`/`session report --verity`) lets a saved Verity
result join a web-scout session's own evidence trail - visible in the
dashboard's Timeline/Verity panel and in the exported session report. See
`docs/web-scout-roadmap.md`'s V6 entry for the full rationale, including
why automatic selector translation between the two tools was rejected.

## Mechanism

```text
Already-open, already-activated browser tab
        |
        v
tools/web-scout/inject.js (in-page agent, dormant by default)
        |
        v
WebSocket -> tools/web-scout/relay.mjs (Node, 127.0.0.1 only)
        |
        +--> tools/web-scout/db.mjs        (node:sqlite - sessions/actions/
        |                                    snapshots/diffs/console/net/qa/
        |                                    macros/verity_runs)
        +--> tools/web-scout/ai.mjs        (ask AI about recorded evidence)
        +--> tools/web-scout/report.mjs    (Markdown/JSON session export)
        +--> GET /dashboard + GET /events  (realtime dashboard, SSE push)
        ^
        |
tools/web-scout/cli.mjs (invoked by Claude Code or an operator via Bash)
```

Activation is per-page (`?webscout=1` or `localStorage.webscout_enabled=1`)
and, for a second or third concurrent tab, per-name (`?webscout_name=NAME`).
Every action-dispatching command requires an active session (see "Required
workflow" in the README) - the relay rejects a command with no session
declared, rather than silently recording an unattributed action. Starting a
session also best-effort opens the dashboard in the OS default browser
(`WEBSCOUT_NO_AUTOOPEN=1` to disable) - so an operator notices Claude Code/
Codex actively using Web-scout, not only by reading a report afterward.

Console and network capture are batched at both ends before crossing the
wire or hitting SQLite: `node:sqlite`'s `DatabaseSync` is synchronous, so
one `INSERT` per captured entry would block the relay's entire event loop
(including concurrent command handling) during a bursty page. The in-page
agent accumulates entries and flushes a batch every 250ms or at a 25-entry
cap, whichever comes first; the relay inserts each flushed batch inside one
transaction.

## Security model

Full detail lives in the README's own "Security model / non-goals"
section - summarized here:

- The relay binds `127.0.0.1` only, never the network.
- The in-page agent is dormant by default; nothing changes for a normal
  page load unless explicitly activated.
- Every action requires a declared session (evidentiary gate, not a safety
  gate - see "Relationship to Verity UI Relay" above).
- `eval` is a deliberate, separately labeled escape hatch with full page
  access - treat it as equivalent to an open DevTools console on an
  authenticated session.
- Console/error capture never suppresses the page's own default error
  logging (`preventDefault()`/returning `true` from an error listener is
  never used) - the tool observes, it does not change page behavior.
- `webscout.db` is gitignored and holds whatever was actually captured,
  including anything reached via `eval` or asked about via `ask` - treat it
  with the same care as the page data it came from.
- No authentication beyond binding to localhost. Do not run this on a
  shared or remotely-accessible machine, and never leave the activation
  flag set for a real (non-dev) session.

## Trade-offs

### Advantages

- Sees exactly what a real browser session sees - raw DOM, real IndexedDB
  rows with real keys, real network/console activity - not an accessibility
  projection of it.
- Durable: every session/action/snapshot/diff/console/net/Q&A record
  survives a relay restart or a tab reload, not just process memory.
- Realtime: a human watching the dashboard sees every recorded event as it
  happens, not on a fixed poll.
- The "declare goal, act, diff" discipline can be made structurally
  automatic (`--strict-crv`) instead of relying on remembering to run it.
- Zero npm dependencies - consistent with this repo's existing tooling
  convention, no supply-chain surface added.

### Costs and limitations

- Full DOM/IndexedDB/network/eval access is a real, standing capability
  once activated - there is no narrower "read-only" activation mode the way
  Verity has for its own surface.
- Not a real browser driver: `dom.screenshot` is a best-effort, zero-
  dependency DOM rasterization (SVG-`foreignObject` technique), not real
  compositor/paint access - no ability to simulate real user input
  timing/pressure the way a tool like Playwright can.
- Single active session at a time (DB-enforced); multiple concurrent
  investigations must be sequenced, not run in parallel sessions.
- `console_entries`/`net_entries` are never pruned - a long session on a
  chatty or broken page can accumulate a large number of rows.
- No authentication boundary between multiple named agents (tabs) sharing
  one relay - `--agent` selects a routing target, not a permission boundary.

## Evidence hierarchy

Use the narrowest authority appropriate to the claim, consistent with this
project's existing convention (see `docs/verity-ui-relay.md`'s own section
of the same name):

- direct read-only API/server evidence for backend truth;
- Web-scout for raw DOM/IndexedDB/network/console truth in an already-open
  tab, especially anything requiring row-level state or a before/after
  diff;
- Verity UI Relay for observable authenticated UI truth via the
  accessibility tree, when that narrower surface is enough;
- source inspection for implementation boundaries;
- Web-scout's `dom.screenshot` only as supplemental, best-effort visual
  evidence (see `docs/web-scout-roadmap.md`'s V4 entry) - not a substitute
  for the diff-based evidence above when a claim is about state, not
  appearance.

Do not use Web-scout's `eval` output as a substitute for reading the actual
source when the question is about implementation structure rather than
runtime behavior - `eval` shows what the page does right now, not why.
