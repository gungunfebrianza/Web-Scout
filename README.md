# Web-scout

![web-scout](img/web-scout.png)

**Give your AI coding agent eyes and hands in a real browser tab.**

Web-scout is a small, dependency-free tool that lets Claude Code, Codex CLI,
or any other coding agent with shell access read and write the DOM,
IndexedDB, and network traffic of a real, already-open browser tab - and
prove what actually happened, instead of just claiming it worked.

> Deep technical detail (how it works internally, every command's design
> rationale, dashboard implementation history) lives in
> [`docs/web-scout-architecture.md`](./docs/web-scout-architecture.md). This
> file is the quickstart and everyday command reference.

## The problem this solves

An AI agent editing your frontend code has no real way to check its own
work. It can read the source, but it can't see the rendered page, poke at
IndexedDB, or check what network requests actually fired - so "I fixed it"
is often just a guess. Web-scout closes that gap: the agent runs a CLI
command (or calls an MCP tool), gets back real evidence from the real page,
and you get a durable log of what it checked and what it found.

The core discipline, nicknamed **"CRV"** in this codebase:

1. **Declare** a goal (`session start "<what you're trying to verify>"`)
2. **Act** (click a button, fill a field, run a script)
3. **Capture** state before and after
4. **Diff** it - the diff is the evidence, not a claim

## Features

**Browser control**
- Query, click, and fill real DOM elements (with ambiguous-selector
  protection - it refuses to guess which element you meant)
- Read and write IndexedDB directly (`dump`, `put`, `put-many`, `patch`,
  `delete`, `clear`) - `put`/`put-many` support `--dry-run` to validate a
  row's shape against the store's real keyPath/autoIncrement with zero
  mutation
- Run arbitrary JavaScript in the page (`eval`), with a timeout and a safe
  fallback for values that can't be JSON-serialized
- Read captured console errors/warnings and network requests - optionally
  arm response-BODY capture for requests matching one or more URL
  substrings (`net capture <substr>`, repeatable to watch several endpoints
  at once)
- Reload the page, including a "hard reload" that clears Service Worker
  caches when a plain reload isn't enough
- Take a best-effort DOM screenshot
- Inspect a **React** component's props/state/hooks directly off the DOM
  fiber - no React DevTools extension required

**Evidence and safety**
- Every action requires a declared session goal first - no anonymous
  mutation
- Snapshot + diff any set of IndexedDB stores, before and after a change
- "Strict-CRV" mode automatically wraps every mutating command in a
  before/after snapshot and diff, so you never forget to check
- Named **golden snapshots** - a permanent regression baseline you can diff
  against from any future session
- `idb restore` writes a snapshot's data back into IndexedDB
- Declarative `session assert` checks against live state (e.g. "store X
  has at least 1 row where field Y equals Z")
- Session cleanup tools that find and remove synthetic/test data you wrote
  during a session - `--summary` collapses a large diff to per-store counts
  plus an estBytes/estTokens size estimate, instead of a full row dump

**Automation**
- Record a session's actions as a reusable **macro**, then replay it later
  (consecutive duplicate steps auto-compacted out at record time)
- Bundle macros + assertions + golden-diffs into a repeatable **test suite**
  with one pass/fail result - CI-friendly exit codes included
- Named multi-tab support - drive more than one browser tab at once

**Token cost & waste prevention**
- `token-report` ranks every action TYPE, TARGET (store/selector), and now
  MACRO (which replayed macro/CRV phase actually cost the tokens, ad-hoc
  calls bucket separately) by estimated tokens spent reading its result
  back, cross-session or scoped to one session - plus repeated-call loops,
  redundant re-checks, and a `savings` block proving what the mechanisms
  below actually saved
- A running per-session token total on every reply
  (`x-webscout-session-tokens` header, printed past a threshold - override
  with `WEBSCOUT_TOKEN_THRESHOLD=<n>`) - correctly counts same-session
  cache hits too, not just freshly-dispatched calls
- Same-session read-result cache (identical read, nothing mutated since ->
  answered from cache, never re-dispatched), wired into both `/command` and
  `macro run`'s own replay loop
- Content-addressed dedup, at seven different granularities: whole action
  results, params, individual snapshot rows, individual macro steps, console
  messages/stacks, net URLs, and verity/diff results - each stored physically
  once, ever, regardless of how many rows/sessions/macros reference it
- Column-dictionary snapshot compaction (a repeated field value across one
  store's rows folds into a small per-store dictionary) and macro step
  templating (a run of near-duplicate steps folds into one template + value
  list) - both transparent on read, invisible to any caller
- Golden-diff memoization by content (not snapshot id) - a repeat
  `diff-golden` check against unchanged data skips re-sending AND
  re-storing the full diff; matching snapshot-level dedup for `idb.snapshot`
  itself
- Macro `idb.put` no-op skip (a replayed write that changes nothing is never
  dispatched) and a compact-by-default `macro run` response
- Pre-call cost hints: a whole-page selector, or a store with real
  historical cost, warns BEFORE you pay for it - with a learned number, not
  a guess

**Dashboard**
- A realtime, no-refresh-needed web dashboard showing every session's
  actions, snapshots, diffs, console/network activity, and a merged
  timeline
- "Known friction" banner that surfaces recurring failure patterns across
  every session automatically
- Cross-session search

**Two ways to drive it**
- A plain **CLI** (`node tools/web-scout/cli.mjs <command>`) - works with
  any agent that has a shell, or a human at a terminal
- An **MCP server** (`mcp-server.mjs`) for MCP-capable clients like Claude
  Code and Codex CLI, exposing the same functionality as structured,
  schema-validated tools

**Zero dependencies.** No `npm install`. Everything (including SQLite
storage, the WebSocket server, and the MCP/JSON-RPC protocol) is hand-built
on top of what Node already ships with.

## Quick start

```bash
# 1. Copy the tool into your project (no npm install needed)
cp -r tools/web-scout /path/to/your-project/tools/web-scout

# 2. Add one script tag to your app's entry HTML - it does nothing until activated
echo '<script src="/tools/web-scout/inject.js"></script>' # add this to index.html

# 3. Start the relay (leave it running in its own terminal)
node tools/web-scout/relay.mjs

# 4. Open your app with the activation flag (once - it persists via localStorage)
#    http://localhost:<your-dev-port>/index.html?webscout=1

# 5. Confirm the browser tab connected
node tools/web-scout/cli.mjs status

# 6. Declare a goal - required before any command that touches the page
node tools/web-scout/cli.mjs session start "check that clicking save updates the list" "manual verification"

# 7. Now go check something
node tools/web-scout/cli.mjs dom click "#save-button"
node tools/web-scout/cli.mjs idb dump my_store
```

That's it - no build step, no IndexedDB required (skip anything `idb.*` if
your app doesn't use it), no AI backend required (that's an optional
feature, see below).

To turn it off: don't pass `?webscout=1`, or run
`localStorage.removeItem('webscout_enabled')` in the page console.

## Everyday commands

A quick cheat sheet - run `node tools/web-scout/cli.mjs <command> --help`-
style usage text, or see
[`docs/web-scout-architecture.md`](./docs/web-scout-architecture.md) for
the full explanation behind any of these.

**Sessions** (required before anything else)
```bash
session start "<goal>" ["<context>"] [--strict-crv] [--stores a,b,c] [--tags a,b,c] [--auto-snapshot] [--token-budget N]
                               # --stores scopes every strict-crv auto-snapshot to those
                               # stores - omitting it against a real-size db WILL time out.
                               # --auto-snapshot (needs --stores) takes+persists a snapshot
                               # right at start, so "session cleanup --since-snapshot" has a
                               # baseline without a separate manual "idb snapshot" call first
                               # --token-budget is advisory only - warns once crossed, never blocks
session end [id]              # defaults to the active session; nudges "macro record" if the
                               # session logged 5+ replayable actions and never saved one
session current
session list
session show <id>             # everything for one session
session report <id> [--format md|json] [--out <path>]
session assert <id> '[{"store":"skills","countGte":1}]'
session cleanup <id> [--confirm]
```

**DOM**
```bash
dom query "#some-element"
dom query "#some-element" --meta   # skip outerHTML/text entirely - just tag/id/className/matchCount
dom pick                      # click any element in the browser -> get its selector back
dom click "#some-button"
dom fill "#some-input" "value"
dom wait "#result" --text "DONE" --timeout 20000
dom wait "#result" --changed --timeout 20000   # resolves once content DIFFERS from its call-time baseline -
                               # match --timeout to a known real provider budget, not a guess
dom settle --quiet-ms 300     # wait for the page to stop mutating
dom screenshot "#some-panel" --out ./shot.png
dom query --selector-file ./selector.txt   # reads the selector from a file - sidesteps shell
                               # quoting for a selector with nested quotes/brackets/attrs
                               # (also works on click/fill/rect/style/wait)
```

**IndexedDB**
```bash
idb list                      # store names + a cheap per-store row count (check before an
                               # unscoped snapshot on a store you suspect is large)
idb dump my_store
idb dump my_store --where '{"status":"OK"}'   # client-side exact-match filter; "count" is the
                               # filtered count, "totalCount" is the whole store's real count
idb get my_store 1            # single-key lookup (store.get), not a full-store scan
idb put my_store '{"id":1,"status":"OK"}'
idb delete my_store 1
idb delete-many my_store '[1,2,3]'   # one transaction; response includes deletedKeys/failedKeys
idb clear my_store
idb wait my_store --count-gte 4 --timeout 15000
idb snapshot --stores my_store --golden my-baseline   # named regression baseline
idb snapshot --since 12        # fresh snapshot, prints ONLY the delta vs. snapshot 12
idb diff 1 2                  # or: idb diff-golden my-baseline 2 - both cache-aware: identical
                               # content to an already-computed diff skips re-sending the full body
idb restore --golden my-baseline
```

**React**
```bash
react inspect "#some-component" --nth 0   # props (+ state for a class component, or positional
                               # hooks for a function component) of the nearest enclosing
                               # React component walking up from selector. Throws if selector
                               # isn't inside React's managed tree.
react tree "#some-component" --nth 0 200  # ancestor chain of enclosing component names only
                               # (default maxDepth 20) - orient first, then "react inspect" a
                               # more specific selector.
```

**Network & console**
```bash
net log
net history --min-duration 5000 --sort duration --limit 20
net wait "/api/save" --timeout 15000
console log
```

**Page**
```bash
page reload                   # does NOT bust a Service Worker's cache - can keep serving
                               # OLD JS for several reloads after a real edit; CLI warns if
                               # this repo has a sw.js
page reload --hard            # also unregisters Service Workers + clears Cache Storage -
                               # use this after editing any file the app precaches
page reload --hard --wait-reconnect   # blocks until the agent disconnects then reconnects
                               # (default wait: 45000ms plain, 60000ms --hard - a real
                               # unbundled-module app can legitimately take 45-60s+ to
                               # reboot; --timeout overrides). reconnected:false doesn't
                               # always mean frozen - it may still be mid-boot; a genuine
                               # freeze shows as EVERY command (reload/ping/eval) timing out
page fresh path/to/file.js    # is the tab actually running what's on disk?
```

**Liveness**
```bash
ping                          # fast, cheap round trip (default timeout 3000ms) - answers
                               # "is the page thread responding" without paying a full
                               # reload/idb/eval timeout just to find out. {alive:false} on
                               # failure, never throws. Can't prove liveness against a truly
                               # blocked synchronous loop - only faster than the alternatives
                               # when the page IS still responsive
status                         # also reports agents_detail: {name, connectedAt, lastAckAt} -
                               # lastAckAt is the honest "page thread alive" signal; raw
                               # socket presence (agents_connected) alone can be misleading
```

**DB version**
```bash
db version-check              # compares js/db.js's DB_VERSION to the live tab; on drift, probes
                               # whether the upgrade is blocked right now (and by what)
```

**Scripting**
```bash
eval "document.title"
eval --file ./script.js       # Windows/Git Bash: --file /dev/stdin does NOT work - write a real temp file
```

**Macros & suites**
```bash
macro record "my-flow" <sessionId>   # consecutive duplicate steps auto-compacted; cost stamped
macro run <id>                # prints an estimated-cost NOTE (from the macro's own stamped cost)
                               # before replaying, no live lookup needed
suite run ./checks/my-suite.json
```

**Token cost & waste prevention**
```bash
token-report                  # all-time byType/byTarget cost ranking + a "savings" block proving
                               # what dedup/cache/compaction/diff-cache actually saved
token-report --session <id>   # one session's own cost, plus repeated-call loops, redundant
                               # (same-result) re-checks, and byMacro (which replayed macro/CRV
                               # phase actually cost the tokens - ad-hoc calls bucket separately)
```
Read calls (`idb dump/get/list`, `dom query/rect/style`, `net log`,
`console log`, `react inspect/tree`) are answered from an in-relay cache
when called twice IN A ROW with identical args and nothing mutating in
between
(`__cacheHit:true`); any result byte-identical to one already seen -
even in a different session - is stored once at the DB level either way,
no flag needed for either. A cache hit still counts toward the running
`x-webscout-session-tokens` total on every reply (see below) - it skips
the DB action log, but the result bytes still land in your terminal and
still get read.

Every reply also carries a running per-session token total, printed to
stderr once it crosses a threshold (default ~5000, override with
`WEBSCOUT_TOKEN_THRESHOLD=<n>`).

**Other**
```bash
ask "what changed between snapshot 1 and 2?"   # optional, needs an AI backend
analytics                     # recurring failure patterns across every session
agents                        # which browser tabs are connected
dashboard                     # prints the dashboard URL
```

Every `dom`/`idb`/`eval`/`page` command also accepts `--agent <name>` to
target a specific tab when more than one is connected. Everything returns
JSON on stdout; failures go to stderr with a non-zero exit code.

## Using this on your own project

The only real requirement is **a web page you can add one `<script>` tag
to.** Everything else is optional:

1. **Copy `tools/web-scout/`** into your repo - zero dependencies, no
   install step.
2. **Add the script tag** to your entry HTML:
   ```html
   <script src="/tools/web-scout/inject.js"></script>
   ```
   It's dormant unless the page is loaded with `?webscout=1` (or
   `localStorage.webscout_enabled` is already set). Works with React,
   vanilla JS, or anything else with a real DOM.
3. **Start the relay, then start a session** - see Quick start above.
4. **Everything past that is opt-in:**
   - No IndexedDB? All `idb.*` commands simply have nothing to act on -
     `dom.*`/`net.*`/`eval` still work fine on their own.
   - `--strict-crv` is a discipline you can turn on, or never mention.
   - The `DB_VERSION` drift banner is a convenience for one specific
     project layout (a `js/db.js` exporting a `DB_VERSION` constant) - it
     silently does nothing if that file isn't there.
   - The Ask AI feature needs a backend of your own (see "Configuration"
     below) - or just don't use it.
5. **Any coding agent with a shell** can drive it via
   `node tools/web-scout/cli.mjs <command>` - Claude Code, Codex CLI,
   Cursor, Aider, or a human at a terminal, identically. The MCP server
   (next section) is the structured-schema alternative for MCP-capable
   clients.

## MCP server

For agents that support [MCP](https://modelcontextprotocol.io) (Model
Context Protocol), `mcp-server.mjs` exposes the same functionality as
`cli.mjs` as typed tools instead of shell commands.

```bash
# Claude Code
claude mcp add --transport stdio web-scout -- node tools/web-scout/mcp-server.mjs

# Codex CLI
codex mcp add web-scout -- node tools/web-scout/mcp-server.mjs
```

The relay (`node tools/web-scout/relay.mjs`) must already be running - this
just talks to it, it doesn't start it for you. 11 tools, grouped by
namespace (`webscout_dom`, `webscout_idb`, `webscout_net`, `webscout_eval`,
`webscout_react`, etc.) rather than one tool per command - `tools/list` on a connected client
shows the full, current, authoritative list. See
[`docs/web-scout-architecture.md`](./docs/web-scout-architecture.md#mcp-server-internals)
for the session-model and error-handling details.

## Configuration (env vars)

No config file - everything is an environment variable, read once at relay
startup unless noted:

| Var | Default | Effect |
| --- | --- | --- |
| `WEBSCOUT_PORT` | `8973` | Relay's HTTP/WebSocket port. |
| `WEBSCOUT_HOST` | `127.0.0.1` | Used by the CLI to reach the relay; the relay itself always binds `127.0.0.1` only (never network-reachable). |
| `WEBSCOUT_NO_AUTOOPEN` | unset | Set to `1` to stop `session start` from auto-opening the dashboard in a browser tab. |
| `WEBSCOUT_AI_BACKEND_URL` | none | Where the optional `ask` command sends its prompt - see "Ask AI" in the architecture doc. Live-editable from the dashboard's Settings dialog with no restart. |
| `WEBSCOUT_DB_PATH` | `tools/web-scout/webscout.db` | Relocates the SQLite file that stores everything. |

The dashboard's **Settings** menu shows all of the above, plus a
live-editable AI backend URL.

## Dashboard

```bash
node tools/web-scout/cli.mjs dashboard   # prints the URL, e.g. http://127.0.0.1:8973/dashboard
```

Open it in a browser to watch sessions update live: connected-tab status, a
session picker, a merged action/snapshot/diff/console/network timeline,
regression-check results, a macros panel, cross-session search, a Token
cost panel (budget burn-rate, per-type/per-target cost, cross-session
trend, a Waste Radar banner for the session's single worst-cost type), and
an Ask-AI box. Updates arrive over Server-Sent Events - no manual refresh.

The **Action log** panel is built for fast debugging:

- Each row shows its target (selector, store/key, `eval` expression, or the
  error's first 60 characters on a failure), an idle gap since the previous
  action, a per-row token estimate, and a duration bar scaled to the
  session's p95 - so most rows never need expanding
- Expanded rows have **Copy CLI** (rebuilds the exact `cli.mjs` command),
  **Copy params/result/error**, and **Explain failure (Ask AI)** on a fail
- Filters (type/status/search) show an "N of M match" count with a one-click
  clear, highlight matches inside expanded params/results, and persist across
  reloads along with the sort order
- Click a red/green dot in the strip above the table to jump to that row
  (opens the collapsed run it lives in)
- **Pause live** freezes the table while you read a long result; a pill
  counts what arrived meanwhile
- **Export view...** downloads the filtered rows as JSON or Markdown
- Keyboard: `j`/`k` move, `Enter` expands, `c` copies the CLI command (only
  while the pointer is over the panel)
- Collapse threshold for runs of identical actions is configurable in
  Settings > Display

## Security model, in short

- The relay only ever binds to `127.0.0.1` - never reachable over the
  network.
- The in-page agent is dormant unless explicitly activated per page load.
- `eval` runs arbitrary JavaScript with full access to the page - treat it
  like having DevTools open on an authenticated session, because that's
  what it is.
- No authentication beyond localhost-binding. Don't run this on a shared or
  remotely-accessible machine.
- `webscout.db` (gitignored) stores everything captured, including
  anything seen via `eval` or an `ask` prompt - treat it like the page data
  it came from.

Full detail: [`docs/web-scout-architecture.md`](./docs/web-scout-architecture.md#known-gaps--scope).

## Testing

```bash
node tools/web-scout/relay.mjs &      # needed for cli.test.mjs / mcp-server.test.mjs
node --test --test-concurrency=1 tools/web-scout/db.mjs.test.mjs tools/web-scout/cli.test.mjs tools/web-scout/mcp-server.test.mjs
```

`--test-concurrency=1` is required when running more than one relay-touching
test file together - they share the relay's single active session. Any test
needing a connected browser tab skips itself (not a failure) when none is
connected, so the suite still runs meaningfully in CI. See
`.github/workflows/web-scout-tests.yml`.

## Relationship to Verity UI Relay

Web-scout is the deliberate opposite of
[`tools/ui-verifier`](../ui-verifier/README.md) (Verity UI Relay): Verity's
whole design is no code injection, no raw DOM, no arbitrary JS execution.
Web-scout does all of that on purpose. They're separate tools with opposite
trust models - prefer Verity when its narrower, safer surface is enough;
reach for Web-scout when you need DOM internals, IndexedDB state, or
network traffic. See [`docs/web-scout.md`](./docs/web-scout.md) for the
full comparison and evidence-hierarchy model.

## Learn more

- [`docs/web-scout.md`](./docs/web-scout.md) - the full mechanism, security
  model, and evidence-hierarchy reasoning
- [`docs/web-scout-architecture.md`](./docs/web-scout-architecture.md) -
  internals, every command's design rationale, dashboard implementation
  history, known gaps
- [`docs/web-scout-roadmap.md`](./docs/web-scout-roadmap.md) -
  version-by-version history of every round of changes
- [`CONTRIBUTING.md`](./CONTRIBUTING.md) - how to propose a fork idea, code
  style, how to add a new command

## License

[MIT](./LICENSE). Forks and issues welcome - see
[`CONTRIBUTING.md`](./CONTRIBUTING.md).
