# Contributing to Web-scout

Fork ideas, bug reports, and PRs are welcome - this tool was built
organically against one private project's own verification needs (see
`docs/web-scout-roadmap.md` for the version-by-version history), and its
session/action/snapshot/diff model is meant to generalize well beyond that.
If you're not sure whether an idea fits, open an issue describing the
problem you hit rather than guessing at the "right" design - that's
usually a faster path to a change that actually lands.

## Ground rules

- **Zero npm dependencies.** This is the single convention enforced
  hardest throughout the codebase - `relay.mjs` hand-rolls its own
  WebSocket framing, `mcp-server.mjs` hand-rolls its own JSON-RPC/MCP
  stdio protocol, `db.mjs` uses `node:sqlite` (built into Node), not an ORM.
  A PR that adds a `package.json` dependency needs to justify why hand-
  rolling it isn't reasonable - "it would be less code" alone isn't enough;
  that trade was made deliberately, repeatedly, elsewhere in this codebase.
- **Real verification, not simulated.** Every test file in this directory
  spawns a real process and talks to the real, running relay (and, where
  relevant, a real connected browser tab) rather than mocking the relay's
  HTTP API or the page's DOM. Match that pattern for new tests. If a test
  needs a browser tab that might not be connected in CI, skip it
  gracefully (`if (!agents_connected.length) return;`) rather than failing
  - see `cli.test.mjs`/`mcp-server.test.mjs` for the pattern.
- **Comments explain WHY, not WHAT.** The codebase's existing comments
  consistently record a non-obvious reason (a real bug a naive
  implementation had, a browser quirk, a design trade-off that isn't
  visible from the code alone) - not a restatement of what the next line
  does. Match that; delete a comment that's just narrating the code below
  it.
- **`path.join`, never string-concatenated file paths.** This tool runs on
  Windows as often as POSIX (its primary development environment is
  Windows) - a hardcoded `/` in a *filesystem* path breaks there. (URL
  paths are the opposite: always `/`, regardless of platform - see
  `client.mjs`'s `pageFresh` for a place that deliberately normalizes a
  possibly-backslashed local path before turning it into a URL path.)
- **Validate at the boundary, throw plain `Error`s with a specific
  message.** `db.mjs`, `relay.mjs` (via `HttpError`), and every command
  handler in `inject.js` all follow this - no silent fallback to a default
  that masks a caller's mistake.

## Adding a new `dom.*`/`idb.*`/etc. command

Start with `node tools/web-scout/scaffold-command.mjs dom.hover --params selector,nth`
(add `--mutating` for a write, `--dry-run` to preview): it stubs the handler,
registry row, CLI entry, `cli-spec` row, help text and MCP action, each marked
`SCAFFOLD(dom.hover)`. `command-coverage.test.mjs` fails until every marker is
replaced. The steps below say what each stub has to become. A new leaf command
(say, `dom.hover`) touches up to 6 files, in this order:

1. **`inject.js`** - add the actual implementation to the `handlers` object
   (`const handlers = { 'dom.query': (...) => {...}, ... }`). This is the
   only file that touches the real DOM/IndexedDB - everything downstream
   just relays `{type, params}` to this object and returns whatever it
   returns.
2. **`command-registry.mjs`** - add ONE row for the new type declaring what
   it is (`mutating`, `strictCrv`, `macroDefault`, `readCacheable`,
   `longPoll`, ... and, for a write to IndexedDB, its `cleanup` kind). The
   relay derives all its behavior from this row, and
   `command-registry.test.mjs` fails if you skip it or half-fill it.
3. **`relay.mjs`** - usually **no change needed**. Any command dispatched
   through the generic `POST /command` route is forwarded to `inject.js`
   verbatim and its result persisted as an `actions` row automatically.
   Only add a relay-side route if the command needs its own persistence
   shape beyond one logged action row (the precedent: `idb.snapshot`/
   `idb.diff`/`idb.restore` get dedicated `/state/*` routes because a
   snapshot/diff is its own durable, independently-fetchable record, not
   just an action's result blob).
4. **`cli.mjs`** - add an entry to the `table` object in `main()` (or a
   dedicated function like `handleSession`/`handleMacro` for something
   with its own subcommands), calling `send('dom.hover', {...})`. Add the
   new command to `usage()`'s help text - every existing command has an
   inline explanation of ambiguous behavior, not just a one-line
   description.
5. **`mcp-server.mjs`** - add the action to the relevant namespace tool's
   `actions` map (e.g. `webscout_dom.actions.hover = (p) => sendCmd('dom.hover', {...}, p?.agent)`), and add it to that tool's `description` string (the MCP
   client's only source of truth for what params it takes - keep it
   accurate, not aspirational).
   Also add a row to `cli-spec.mjs` (its arity, its flags, and the MCP action
   it maps to - or a reasoned `mcpExempt`); the CLI rejects any flag not listed
   there, and `cli-parity.test.mjs` fails when the two surfaces drift.
6. **Docs** - add the command to `tools/web-scout/README.md`'s
   `## Everyday commands` cheat sheet, its full rationale to
   `docs/web-scout-architecture.md`, and a `docs/web-scout-roadmap.md`
   entry explaining *why* (what real gap it closes), following the
   existing `## VN - <name> (implemented)` format. A roadmap entry with no
   "why" is not useful to a future reader - see any existing entry for the
   expected depth.

A new `readCacheable` command gets reply shaping (`--peek`, `--table`, `--if-changed`,
`--delta`, `--no-guard`) for free on the relay side (`read-pipeline.mjs`); the CLI spec
row spreads `SHAPE_BOOL`/`SHAPE_PARAMS` (see `dom rect`), and the MCP handler passes
`readOpts(p)` as `sendCmd`'s fourth argument and lists the five params in its
description (`cli-parity.test.mjs` fails otherwise). Add its scoping params to
`SCOPING_PARAM_KEYS` in `read-pipeline.mjs` if it has any. Never make a command
shape a reply by default: shaping is opt-in or budget-driven, and the default reply
size is pinned by `token-benchmark.test.mjs` - if a change legitimately moves it,
raise `NAIVE_BUDGET_BYTES` in the same commit and say why. An in-page command must not
leave state behind that the app did not create: `openDb()` in `inject.js` rolls back
the database creation a version-less `indexedDB.open` would otherwise cause.
`read-only-contract.test.mjs` enforces this against a real browser for every non-mutating
command in the registry: a new read command must be added to its `COVERED` list (or
`EXEMPT`, with a reason) or its registry cross-check fails. A read that narrows what it
returns (a filter, a projection, a count) is a new in-page param: list it in
`SCOPING_PARAM_KEYS`, call `noteAvoided` with the unscoped size, and give it a case in
`inject-browser.test.mjs`.

Every byte in an MCP tool description or in `usage.txt` is paid for by callers before
they read anything: `schema-budget.test.mjs` caps the MCP tool list, one tool, and the
biggest help slice. Write the shaping params as `+shape` (defined once under
`webscout_dom`), keep new usage entries at the start-of-line shape `help.mjs` slices by
(two spaces, then the command), and raise a cap only in the commit that adds the text.
Ship a claim about token savings with a number from `trace.mjs replay` on real traces,
not only the scripted benchmark, which is a best case.

Run the full test suite before opening a PR (see "Testing" in the README):

```bash
node --test --test-force-exit tools/web-scout/*.test.mjs
```

A read handler that narrows what it returns (a filter, a limit, a projection)
should report what it left out: take the second `ctx` argument and call
`noteAvoided(ctx, unscopedBytes, deliveredBytes)` (see `idb.dump` in `inject.js`),
so the saving reaches the `scopedReads` ledger.

After ANY edit to `inject.js` run `node tools/web-scout/build-id.mjs --stamp`.
`inject.js` carries a hash of itself (`AGENT_BUILD`) that a tab reports on connect,
so the relay can warn about a tab still running an older copy; `agent-build.test.mjs`
fails while the stamp is out of date. `scaffold-command.mjs` restamps for you. In
the app that loads it, bump the `?v=` on the script tag too - the stamp tells you a
tab is stale, the query string is what makes the browser fetch the new file.

Nothing needs to be running: each relay-touching test file starts its own
ephemeral relay on a free port with a throwaway database, so a green run
always validates the code on disk and files run in parallel. Tests that need
a real connected browser tab skip themselves; set `WEBSCOUT_TEST_LIVE=1` to
run them against a relay that has one. CI sets `WEBSCOUT_REQUIRE_BROWSER=1`, so
the headless-browser tests fail there instead of skipping. When you need a child
process or a liveness probe in a test, use `spawnClean` and `isUp` from
`test-relay.mjs` (they carry the two Windows/runner traps: nested `node --test` inheriting
`NODE_TEST_CONTEXT`, and a pending `fetch` tripping a libuv assertion at exit) - and
`spawnAsync` instead of `spawnClean` for a CLI command that needs a same-process
`connectFakeAgent()` tab to answer anything: `spawnClean` blocks the event loop the
fake agent's WebSocket callback needs to fire, which is a real deadlock, not just slow
(confirmed live writing `crv run`'s own CLI test). A live-relay test that polls with `fetch`
can hit that libuv assertion under `--test-force-exit` on Windows (`auto-calibrate.test.mjs`
did, in 7-10 of 10 runs) - use `node:http` with `agent: false` there (see its `httpJson`).
`docs-drift.test.mjs` requires your
new command and flags to appear in `usage.txt` (and the command in the README).

**Put a file's top-level `await startTestRelay()` before every `test()` call in the
file, never after one.** A `test()` declared, then a top-level `await` (relay startup),
then more `test()` calls once that await resolves, was found to silently run only the
pre-await test(s) under `node --test --test-force-exit` - the exact CI invocation -
with no failure or skip reported, just tests missing from the run's own count.
`reply-budget.test.mjs`, `crv-verify.test.mjs` and `trace-replay.test.mjs` all had this
shape (a handful of pure tests first, `= await startTestRelay()` partway down, more
tests after) and silently lost 3, 4 and 9 of their tests respectively before it was
caught and fixed by moving the await (and everything it gates - `BASE`, `before`/`after`,
fixtures) above the file's first `test()` call. Run a new or edited file both plain
(`node file.test.mjs`) and with the flag (`node --test --test-force-exit file.test.mjs`)
and diff the test counts if you are not sure.

A hard-killed run (Ctrl-C twice, a crashed CI runner) can leave an orphaned relay
process and its temp dir behind - confirmed real more than once, up to 15 orphaned
relays and 48 temp dirs found and cleaned by hand in one session, then another 10
relays and ~200 temp dirs predating the registry in a later one. `startTestRelay()`
registers every relay it starts in a small registry file (`relay-control.mjs`'s
`registerRelay`/`reapLeakedRelays`) and runs the reaper (only against entries older
than 30 minutes, never against port 8973) once automatically the first time a test in
the run calls it. **`relay.mjs` itself registers there too on real startup** (its
`isMainModule` block, not just `startTestRelay()`), so a hand-started or autostarted
relay that gets killed outside any test run is also found and cleaned up the next
time anyone starts one - not only the next `node --test`. Run
`node tools/web-scout/reap-test-relays.mjs` by hand for an immediate cleanup (e.g.
right after a Ctrl-C) without waiting for the next run.

`relay.mjs`'s own `server.listen()` only runs when the file is the actual process
entry point (`isMainModule`, checked against `process.argv[1]`) - a plain
`import('./relay.mjs')` never binds a port. This bit twice in the same round: a
`node -e "import('./relay.mjs')..."` meant as a syntax check actually ran the whole
relay and bound the real port with no env override. Use `node --check relay.mjs` for
a syntax check instead - it never executes the module.

## PR expectations

- Update the README and/or `docs/web-scout-roadmap.md` alongside the code
  change, in the same PR - not "docs to follow." A behavior change with no
  roadmap entry is much harder for the next person (agent or human) to
  understand the reasoning behind later.
- If your change touches `dashboard.html`, verify it in an actual browser
  tab against the real dashboard before opening the PR - `node --check` on
  the extracted `<script>` block only catches syntax errors, not "the
  Settings dialog doesn't open." A new panel also needs an entry in the
  `PANELS` registry in `dashboard.html` (group, label, `count`, `refresh`,
  `exportRows`) - that is what gives it the shared head, collapse, freshness
  and maximize chrome; a `<section class="hud-section" id=...>` alone gets none.
- Small, focused PRs over large ones - this codebase's own history (see
  the roadmap) is a long sequence of small, individually-justified
  changes, not big-bang rewrites.

## License

MIT - see [`LICENSE`](./LICENSE). By contributing, you agree your
contribution is licensed under the same terms.
