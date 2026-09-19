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
- **Session visualizations** in the dashboard, built from rows already stored:
  an agent **swimlane** (one lane per agent, bar per action, think time between
  calls made visible), a **state machine** (nodes are distinct snapshot content,
  edges are the writes between two snapshots, so a return to an earlier state is
  a loop and a write that changed nothing is flagged), and an **episode tree**
  (goal > episode > step > action: explore, change, verify, recover)
- A **Why** column on the Action log, filled from the agent's own transcript by
  `session intents <id>` (Claude Code and Codex JSONL, matched by time - the
  agent spends no tokens on it). Actions with no narration get an inferred why,
  always labelled as inferred
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
- `token-report`'s all-time form also carries `neverCalled`: dispatchable action
  types this relay has never logged a single call for - real usage evidence for
  which MCP actions are candidates to trim from the always-sent tool list; and
  `helpUsage`: whether `help all` (~16k tokens) still gets called, against the
  sliced forms it exists to replace
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
- Same-session read-result cache (identical read on the same tab, nothing
  mutated since -> answered from cache, never re-dispatched), wired into both
  `/command` and `macro run`'s own replay loop. A hit is first checked against
  the page's own change counter (DOM mutations, fetch/XHR and console entries,
  IndexedDB writes), so a page that changed by itself is re-read, not served stale
- Scoped reads are measured: `--where`/`--fields`/`--limit`/`--url-contains`/
  `--meta` and whole-page outlines report what they left out (a `scopedReads`
  ledger plus a 14-day trend in `token-report` and the dashboard), and
  `session end` prints a per-session savings line
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
- Reply shaping for reads: `--peek` (shape + size instead of the body),
  `--table` (keys stated once), `--if-changed` / `--delta` (a pointer or only
  what changed instead of a repeat body), all tracked against what the caller
  actually holds; a `--token-budget` arms a guard that turns large reads into
  peeks as the budget burns; `session start` returns a warm-start briefing;
  replies are compact JSON when piped
- The relay watches HOW a session reads (scoped then unscoped, identical full
  re-deliveries) and says one line when it sees waste, then measures whether the
  hint was followed; peeks are measured the same way (narrowed next, or read in
  full anyway)
- `idb verify --expect "notes:+1,tags:same"` is the verify step of baseline -> action
  -> verify in one call: it re-snapshots, diffs and checks the expectations, and
  answers in a few lines when it passed (rows only for what failed); `crv run --stores
  a,b --type dom.click --params '{"selector":"#save"}' --expect "notes:+1"` is the
  WHOLE loop in one call - baseline snapshot, the action, verify - instead of three
  separate round trips each with their own full-body reply
- `session start --strict-crv --crv-compact` adds a sampled preview of what changed
  (the same shape `idb verify`'s pass branch returns) to every triggering call's own
  reply, alongside the existing counts - sparing the separate `idb diff <idA> <idB>`
  full-body fetch a caller otherwise makes by hand to see what a count alone did not
  explain. Off by default: an ordinary `--strict-crv` session's reply is unchanged
- `session start --lean` makes shaping the default for a whole session instead of a
  flag on every call; reads can also be narrowed in the page itself (`dom query --pick`,
  `idb dump --count`, `net log --failed --fields ...`, `console log --level ...`, ...)
- One delivered-bytes number: the running total, the budget, the per-type report and
  the session receipt all count what the caller was handed, not what was logged
- Quiet by default: hints are capped per session and go silent for a kind you keep
  ignoring (and are costed against what following them saved); the running-total note
  prints only when a call was big or the total crossed a doubling; `help` prints an
  index or one command instead of ~16k tokens of usage text; the MCP tool list has a
  byte budget in CI
- `trace.mjs` exports a real session anonymised and replays it through the reply
  pipeline, so the read strategy is benchmarked on what callers actually read (not only
  the scripted fixture) and the lean guard threshold is tuned from a sweep;
  `session end --trace` exports the session that just ended the same way, into
  `traces/auto/` (gitignored) - the corpus grows on its own instead of staying at
  four traces from one project, without anything being auto-promoted into the
  committed, benchmarked `traces/*.json.gz`; `trace.mjs rank-auto` ranks that pile by
  the same leanWorst distrust rate the dashboard shows, so promoting one is picking
  off a short list instead of eyeballing a folder - `session end --trace` also runs
  this ranking itself and only speaks up when the trace it just wrote lands in the
  top 3, so a real candidate gets flagged without a nudge on every export
- A relay running older code than disk is restarted at `session start` (never
  mid-session); `read-only-contract.test.mjs` proves every read command leaves
  IndexedDB, storage and the DOM exactly as it found them
- Token estimates carry a labelled error band (`savings.estimator`, with a status:
  uncalibrated / partial / stale / calibrated and `calibrate-tokens.mjs --check`), and
  `token-benchmark.test.mjs` runs a scripted CRV session against a fixture in CI so
  a change that makes replies bigger fails there. `transcript-tokens.mjs --write`
  measures the same ratios from a Claude Code transcript's own token counts instead of
  the Anthropic `count_tokens` endpoint, needing no API key; a relay with nothing
  calibrated yet tries this itself, once, the first time a session starts
  (`WEBSCOUT_AUTO_CALIBRATE=1`, set automatically by `relay start`/`restart` and the
  client's own autostart - never by a plain `node relay.mjs`, and never overwriting an
  existing calibration even a stale one); while still uncalibrated, `token-report`'s
  `savings.estimator.note` says WHY - flag not set on this relay, set but not run yet,
  still running, or already ran and found nothing (with the reason) - instead of the
  same generic line regardless of which of those is actually true

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

# Help is sliced (the full text is ~16k tokens): the index, one group, or one command
node tools/web-scout/cli.mjs help                 # topics and their commands
node tools/web-scout/cli.mjs help idb dump        # one command (also: idb dump --help; help all = everything)

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

**Relay lifecycle**
```bash
relay status                  # works even when the relay is down; reports pid, start time and
                               # staleSourceFiles - non-empty means the running relay is OLDER than
                               # relay.mjs/db.mjs/... on disk (an edit is invisible until restart);
                               # staleAgents names tabs still running an older inject.js (reload them);
                               # events24h counts client autostarts and unclean exits - a non-zero
                               # uncleanExits means something killed the relay from outside
relay restart                 # stop + start (also: relay start, relay stop). Replaces `pkill` -
                               # which silently does nothing against a Windows-native node process
```
Every reply also warns once on stderr when the relay is running code older
than what is on disk, so a green run can't quietly be validating stale code.

**Sessions** (required before anything else)
```bash
session start "<goal>" ["<context>"] [--strict-crv] [--stores a,b,c] [--tags a,b,c] [--auto-snapshot] [--token-budget N] [--no-briefing]
                               # --stores scopes every strict-crv auto-snapshot to those
                               # stores - omitting it against a real-size db WILL time out.
                               # --auto-snapshot (needs --stores) takes+persists a snapshot
                               # right at start, so "session cleanup --since-snapshot" has a
                               # baseline without a separate manual "idb snapshot" call first
                               # --token-budget never blocks, but arms the read guard (see "Reading
                               # with fewer tokens") and warns at the end when the DELIVERED total crossed it
                               # --no-briefing skips the warm-start briefing in the reply
session end [id]              # defaults to the active session; nudges "macro record" if the
                               # session logged 5+ replayable actions and never saved one
session current
session list
session show <id>             # everything for one session
session report <id> [--format md|json] [--out <path>]
session assert <id> '[{"store":"skills","countGte":1}]'
session cleanup <id> [--confirm] [--summary] [--since-snapshot <snapshotId>]
                               # --summary: per-store counts + a size estimate instead of full rows
```

**DOM**
```bash
dom query "#some-element"
dom query "#some-element" --meta   # skip outerHTML/text entirely - just tag/id/className/matchCount
dom pick                      # click any element in the browser -> get its selector back
dom click "#some-button" [--nth N]
dom click-wait "#save" --wait-selector ".toast" --text "Saved"   # click, then wait, ONE round trip
dom fill "#some-input" "value"
dom rect "#some-panel"        # bounding box
dom style "#some-panel" color,margin   # computed style (curated defaults if no list given)
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
idb dump my_store --where '{"status":"OK"}'   # exact-match filter, applied IN THE PAGE; "count" is the
                               # filtered count, "totalCount" is the whole store's real count
idb dump my_store --fields id,status --limit 20   # project + cap rows in the page too
idb get my_store 1            # single-key lookup (store.get), not a full-store scan
idb put my_store '{"id":1,"status":"OK"}' [--dry-run]   # --dry-run validates the row's shape, writes nothing
idb put-many my_store '[{"id":1},{"id":2}]' [--dry-run]  # one transaction; a bad row is reported per-row
idb patch my_store 1 '{"status":"DONE"}'   # merge onto the EXISTING row (errors if none exists)
idb delete my_store 1
idb delete-many my_store '[1,2,3]'   # one transaction; response includes deletedKeys/failedKeys
idb clear my_store
idb wait my_store --count-gte 4 --timeout 15000
idb snapshot --stores my_store --golden my-baseline   # named regression baseline
idb snapshot --since 12        # fresh snapshot, prints ONLY the delta vs. snapshot 12
idb verify --expect "notes:+1,tags:same"  # verify step of baseline -> action -> verify in ONE call: re-snapshots, diffs, checks, prints pass/fail (rows only for what failed)
idb diff 1 2                  # or: idb diff-golden my-baseline 2 - both cache-aware: identical
                               # content to an already-computed diff skips re-sending the full body
idb restore --golden my-baseline
idb watch my_store --count-gte 4   # streams row-count changes (CLI-only; MCP uses "idb wait")
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
net log --limit 5 --url "/api/save"   # filtered IN THE PAGE - an unfiltered log is ~55KB in a busy session
net history --min-duration 5000 --sort duration --limit 20
net wait "/api/save" --timeout 15000   # Git Bash on Windows rewrites a leading "/" into a Windows path -
                               # prefix the command with MSYS_NO_PATHCONV=1 (the CLI warns when it sees this)
net capture "/api/ai"         # ADDS a response-body capture filter (call again to watch a second endpoint)
net capture --off             # clears every armed filter
net clear
console log --limit 20
console wait "Saved" --timeout 5000   # attach-and-wait instead of a sleep+poll loop
console clear
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

**Debugging the tool and your own leftovers**
```bash
debug state                   # this tool's own live in-page state (WebSocket readyState, queues, backoff)
debug sweep P46DEBUG          # CLI-only: greps the working directory for a leftover debug tag; exits 1 on any hit
dev bump-reload js/db.js      # bumps every "<file>?v=N" importer, then hard-reloads + waits for reconnect
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
macro list                    # id, name, step count, source session, stamped cost
macro show <id>               # every step
macro delete <id>
macro export-verity <id> --out ./scenario.json   # skeleton Verity scenario from the click/wait steps
suite run ./checks/my-suite.json
```

**Token cost & waste prevention**
```bash
token-report                  # all-time byType/byTarget cost ranking + a "savings" block proving
                               # what dedup/cache/compaction/diff-cache actually saved
token-report --session <id>   # one session's own cost, plus repeated-call loops, redundant
                               # (same-result) re-checks, byMacro (which replayed macro/CRV
                               # phase actually cost the tokens - ad-hoc calls bucket separately),
                               # and byIntent (which narrated REASON cost the tokens, from the
                               # agent's own transcript - see "session intents")
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

Every reply also carries a running per-session token total plus what that
call added, printed once it crosses a threshold (default ~5000, override with
`WEBSCOUT_TOKEN_THRESHOLD=<n>`): `session running total: ~60024 estimated
tokens so far (+66 this call).` The CLI prints it on stderr; over MCP it is
appended to the tool reply as an extra text item, because an MCP host does
not show a server's stderr to the model.

**Reading with fewer tokens** - what a call *returns* is what you pay for, so
cacheable reads take flags that change only the reply (the relay still logs and
caches the full result):
```bash
idb dump my_store --peek      # the SHAPE: counts, columns, one sample row, byte size, an
                               # estimated-token band. The full result is cached - repeating the
                               # call without --peek is answered with no page round trip
idb dump my_store --table     # rows as {columns, rows:[[...]]}: each key said once
idb dump my_store --if-changed  # unchanged since you last RECEIVED it? -> {unchanged, sameAs}
idb dump my_store --delta     # ... and when it did change, only what changed (rows added /
                               # changed / removed by id; net.log and console.log by content)
dom query "#panel" --peek --no-guard   # (--no-guard overrides the budget guard below)
```
`--if-changed` and `--delta` are only correct while the earlier result is still in
your context - after a context compaction, repeat the call without them. The relay
tracks what you were actually handed, so it never offers a pointer or delta against
a result you only saw a `--peek` of. A session started with `--token-budget N` arms a
**read guard**: past 60% of N, a read over ~3000 estimated tokens returns its shape
and rows come back tabular; past 85% the limit drops to ~1000 (a one-time stderr note
announces each level; `WEBSCOUT_READ_GUARD_TOKENS=<n>` arms it without a budget). The
running total, the budget and the end-of-session receipt count bytes *delivered*,
not bytes logged. `session start` also returns a **briefing** (row count per store,
DB version, whether the tab and the relay are current) so the exploratory `idb list`
/ `db version-check` opening most sessions is not needed - `--no-briefing` skips it.
The relay also watches how you read and says one line when it sees waste (a full read
right after scoping the same target, repeated full reads, an identical read
re-delivered in full from cache); `token-report` counts whether you then acted on it.
Output is compact JSON when piped; a terminal, `--pretty` or `WEBSCOUT_PRETTY=1` gets
the indented form.

`session start --lean` turns the shaping above into the session default: rows as
tables, a repeat of a result you hold as a pointer or delta, and a body over ~4000
tokens as its shape (repeat the call for the body; `--no-guard` gives it as it is).
`token-report` (`readStrategy.adoption`) counts reads by who chose the shaping. On
four real CRV sessions replayed with `trace.mjs` a lean session delivered 0.40-0.58 of
the default's read bytes on three (0.05 on one dominated by a few huge reads) if every
shape sufficed - much less than the scripted benchmark below, which is a best case. If
callers instead distrust every shaped reply and re-ask for the raw body, it costs 1.01-1.08
of the default (a small premium, not a saving - the shape is a paid round trip before the
retry): `readStrategy.shaping.pointer/delta` reports `followedByFull`/`followedByNarrowed`
live, the same way a distrusted peek already was, so this is measurable in a real session,
not only in replay. Reads can also be narrowed **in the page**, before anything crosses the
wire:
```bash
dom query "a.next" --pick attr:href,text    # the href and text, not the markup around them
react inspect ".row" --pick props.user.id   # one path, not the whole component
idb list --stores notes,tags --non-empty
idb dump notes --count                      # did 3 rows land? counts, no rows
idb get notes 7 --fields title,tag
net log --failed --fields method,url,status
console log --level error,warn --fields level,message
node tools/web-scout/cli.mjs help idb dump  # sliced help (also: idb dump --help)
node tools/web-scout/trace.mjs export 87 --out traces/mine.json.gz   # anonymised real session
node tools/web-scout/trace.mjs replay traces/*.json.gz --sweep       # lean band + guard sweep
```

Token figures everywhere are chars/4 - one ratio for JSON, markup and prose, which
tokenize very differently. `token-report` labels them: `savings.estimator` gives a
low..high band per kind and `spend.estTokensBand` brackets the total. The band is a
rule of thumb until `node tools/web-scout/calibrate-tokens.mjs --write` (needs
`ANTHROPIC_API_KEY`) measures real ratios from your own sessions;
`calibrate-tokens.mjs --check` says offline whether the committed file is complete and
fresh (this repository has not been measured yet, so the band is still a rule of thumb).

> **Open item:** the calibration run is pending Anthropic API credits. When available:
> run `calibrate-tokens.mjs --write`, check with `--check`, commit `token-calibration.json`,
> then set `WEBSCOUT_REQUIRE_CALIBRATION=1` in CI. The key must be an Anthropic one: the
> estimator predicts Claude tokens, and another provider's tokenizer would give ratios
> that are wrong for it. Details in `docs/web-scout-roadmap.md` (V33, item 10).

The dashboard's **Token savings** panel shows the all-time ledgers behind
`token-report`, split into what they actually measure: bytes never stored
twice on disk (dedup) versus bytes never sent to the caller.

**Other**
```bash
ask "what changed between snapshot 1 and 2?"   # optional, needs an AI backend
analytics                     # recurring failure patterns across every session
search "cfi_ontology"         # full-text search across every session's actions
verity import <sessionId> ./scenario-result.json   # fold a Verity result into a session's evidence
agents                        # which browser tabs are connected
dashboard                     # prints the dashboard URL
```

**Arguments are checked before anything runs.** An unknown flag or an extra
positional argument exits 1 immediately, naming what it rejected and listing
the flags that command does take. (A silently ignored argument used to mean
`token-report --session 206` returned the all-time report, and a typo'd
`--dryrun` on `idb put` would have written the row.) The per-command spec is
`cli-spec.mjs`; `eval` is exempt for flags, since its expression may start with `--`.

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

CLI and MCP stay in step: `cli-spec.mjs` lists every CLI command and flag
with its MCP counterpart (or a reasoned exemption - e.g. `relay restart` is
deliberately not exposed over MCP), and `cli-parity.test.mjs` fails when they
drift. Nudges, the running token total and the stale-relay warning are
appended to each tool reply as extra text content.

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
| `WEBSCOUT_TOKEN_THRESHOLD` | `5000` | Running-total token ticker prints only once a session's total passes this (read by the CLI/MCP client). |
| `WEBSCOUT_READ_GUARD_TOKENS` | unset | Arms the read guard without a session budget: a read over this many estimated tokens returns its shape (`--no-guard` per call overrides). Read by the relay. |
| `WEBSCOUT_PRETTY` / `WEBSCOUT_COMPACT` | unset | The CLI prints compact JSON when piped and indented JSON on a terminal; `WEBSCOUT_PRETTY=1` (or `--pretty`) forces indented, `WEBSCOUT_COMPACT=1` forces compact even on a terminal. |
| `WEBSCOUT_TOKEN_CALIBRATION` | `tools/web-scout/token-calibration.json` | Where measured chars-per-token ratios (written by `calibrate-tokens.mjs --write`) are read from. |
| `WEBSCOUT_NO_AUTORESTART` | unset | Set to `1` to stop `session start` restarting a relay that is running older code than what is on disk (it only ever restarts between sessions, never during one). |
| `WEBSCOUT_REQUIRE_CALIBRATION` | unset | Set to `1` (CI) to make the suite fail unless `token-calibration.json` is complete and fresh. |
| `WEBSCOUT_NO_AUTOSTART` | unset | Set to `1` to stop the CLI/MCP client from starting a relay when the port refuses connections (it retries the call once after starting one, at most once per 30s). |
| `WEBSCOUT_REQUIRE_BROWSER` | unset | Set to `1` (CI does) to make the headless-browser tests fail instead of skip when no Chromium/Edge is found. |
| `WEBSCOUT_PID_PATH` | `<tmpdir>/webscout-relay-<port>.pid` | Where the relay writes its pidfile, used by `relay stop/restart`. |
| `WEBSCOUT_TEST_LIVE` | unset | Set to `1` to run the relay-touching tests against the already-running relay (needed only for tests that require a connected browser tab). |
| `WEBSCOUT_AUTO_CALIBRATE` | unset | Opt-in: set to `1` to let a relay with no calibration file try `transcript-tokens.mjs`'s no-key method once, the first time a session starts. Set automatically by `relay start`/`restart` and the client's own autostart - never by a plain `node relay.mjs`, and a test relay never sets it. |
| `WEBSCOUT_TRANSCRIPT_HOME` | the OS home dir | Where `transcript-tokens.mjs` (and `WEBSCOUT_AUTO_CALIBRATE`) looks for `.claude/projects/` transcripts to calibrate from. |
| `WEBSCOUT_RELAY_REGISTRY` | `<tmpdir>/webscout-relays.jsonl` | The leaked-relay registry `reapLeakedRelays()` reads/writes - every relay, test or real, registers here on startup. Only a test isolating this behavior should ever need to override it. |

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
trend, a Waste Radar banner for the session's single worst-cost type), a
Token savings panel (all-time: what each dedup/cache/compaction mechanism
saved, split by what it actually measures, plus the biggest remaining spend
and the flag that shrinks each), and an Ask-AI box. Updates arrive over Server-Sent Events - no manual refresh.

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

Every dashboard panel shares one header, so these work the same everywhere:

- **Collapse** a panel by clicking its title (remembered per browser); empty
  panels fold themselves down to a title row and reopen when data arrives
  (Settings > Panels turns this off)
- **Count and failure badges** in the title ("Console 42, 3 errors"), a
  **freshness stamp** ("2s", "stale 40s" if the relay stops answering,
  "frozen" once a session has ended) and corner brackets that turn red for a
  failure you have not scrolled to yet
- A sticky **jump bar** with a chip per panel: red failure count, `+N` for
  new rows while the panel is offscreen, click to jump (the URL hash is a
  deep link, e.g. `/dashboard#netSection`), plus **Collapse all**
- Per-panel tools: **height** cycle (compact/normal/tall/auto), **maximize**
  (Esc closes), **pause** (Timeline, Snapshots, Diffs, Console, Network,
  Verity), **refresh now**, and **export** (Markdown/JSON copy, JSON download)
- **Settings > Panels** shows, hides and reorders panels
- **Print** (or the browser's save-as-PDF) gives a light, fully expanded report

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
node --test --test-force-exit tools/web-scout/*.test.mjs
```

The relay-touching tests (`cli.test.mjs`, `mcp-server.test.mjs`,
`relay-behavior.test.mjs`) each start their **own ephemeral relay** on a free
port with a throwaway database (`test-relay.mjs`), so a green run always
validates the code on disk - never a relay left running on older code - and
files can run in parallel. `relay-behavior.test.mjs` drives that relay
through a fake in-page agent that speaks the real WebSocket protocol, so
dispatch, the read cache, cleanup tracking and the token headers are tested
without a browser.

Tests that need a real connected browser tab skip themselves. To run them,
start a relay with a tab connected and set `WEBSCOUT_TEST_LIVE=1` (and
`WEBSCOUT_PORT` if it is not 8973). Static checks that need no relay at all:
`command-registry.test.mjs` (every `inject.js` handler is classified),
`cli-spec.test.mjs` (argument validation), `cli-parity.test.mjs` (CLI <-> MCP)
`docs-drift.test.mjs` (every command and flag is documented) and
`command-coverage.test.mjs` (one report of every surface a command is still
missing, and a refusal of unfinished `scaffold-command.mjs` stubs).
`inject-browser.test.mjs` and `dashboard.test.mjs` drive a real headless
Chromium/Edge (`browser-harness.mjs`; set `WEBSCOUT_BROWSER` if none is found -
they skip themselves without one, unless `WEBSCOUT_REQUIRE_BROWSER=1`) to check the
page-change counter, the whole-page outline, the scoped-read accounting, the build
stamp and the dashboard's panel shell. `agent-build.test.mjs` (the build stamp),
`read-strategy.test.mjs` (re-read and outline rates), `relay-events.test.mjs`
(autostart and unclean-exit log) and `text-hygiene.test.mjs` (no CR, control
characters or U+FFFD in any tracked text file) need no browser, and neither do
the read-shaping ones: `read-shape.test.mjs` and `read-pipeline.test.mjs` (pure
reshaping and the state machine around it), `read-shaping.test.mjs` (the same
through a real relay and a stand-in tab) and `token-estimate.test.mjs`.
`token-benchmark.test.mjs` runs a scripted baseline -> action -> verify session
against a fixture twice - default reads and the documented read strategy - and
prints the delivered bytes per phase; it fails if default replies grow past a
budget or the strategy stops beating them by its margin (the fixture is a best
case for the strategy, so read the ratio as a ceiling on the effect, not a forecast).
`crv-verify.test.mjs` covers `idb verify` (the expectation syntax, and the whole call
through a real relay). `read-only-contract.test.mjs` fingerprints IndexedDB, storage,
cookies and the DOM in a real browser before and after **every non-mutating command in
the registry** and after the briefing, snapshot and verify routes - a new read command
must be added to it or the registry cross-check fails. `schema-budget.test.mjs` caps the
MCP tool list (bytes sent to the model on every session) and the size of a help slice;
`help.test.mjs` checks every command slices out of `usage.txt`. `trace-replay.test.mjs`
replays the committed anonymised traces in `traces/` and holds their measured lean bands;
`auto-restart.test.mjs` covers the session-start restart; `token-calibration.test.mjs`
covers the estimator's status (its last test skips until a measured calibration is
committed); `transcript-tokens.test.mjs` covers calibrating from a Claude Code transcript
(no API key). `reply-budget.test.mjs` caps actual runtime replies for a few deterministic
fixtures (an `idb verify` pass, a `session start` briefing, a `--table` dump) - `schema-budget.test.mjs`
only covers what is static (the tool list, help text); `session-trace-export.test.mjs` covers
`session end --trace`; `crv-run.test.mjs` covers `crv run` (the action actually running between the
two snapshots, a failing action failing the whole call, `idb.snapshot` refused as the action).
`crv-compact.test.mjs` covers `--crv-compact` (a sampled preview alongside strict-crv's counts, and
that an ordinary strict-crv reply's shape is unchanged without it). `trace-rank-auto.test.mjs`
covers `trace.mjs rank-auto` (ranking `traces/auto/` by distrust rate). `auto-calibrate.test.mjs`
covers `transcript-tokens.mjs`'s `autoCalibrateIfMissing` (never overwriting an existing
calibration, no-transcripts and too-few-samples outcomes, and a real `session start` producing one
live, plus what `savings.estimator.note` says while still uncalibrated). `relay-import-safety.test.mjs`
and `relay-self-register.test.mjs` cover `relay.mjs`'s `isMainModule` guard and its self-registration
into the leaked-relay registry. `token-estimate.test.mjs` also covers `estimatorInfo`'s `autoCalibrate`
clause (flag off / set but not run yet / running / ran and found nothing, each worded distinctly).
`viz-endpoint.test.mjs`'s transcript-import tests also cover `token-report`'s `byIntent` (the actions
one narrated call produced collapse to one row; un-narrated actions bucket separately). A `test()`
declared before a top-level `await startTestRelay()`, with more `test()` calls added once that
await resolves, was found to silently run only the pre-await tests under `--test-force-exit` (the
exact CI command below) - no failure, just tests missing from the count; `reply-budget.test.mjs`,
`crv-verify.test.mjs` and `trace-replay.test.mjs` had this and are fixed (the await now runs first,
before any `test()` call) - a new relay-touching test file should do the same.
See `.github/workflows/web-scout-tests.yml`.

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
