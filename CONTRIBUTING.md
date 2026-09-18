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

A new leaf command (say, `dom.hover`) touches up to 6 files, in this order:

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

Run the full test suite before opening a PR (see "Testing" in the README):

```bash
node --test --test-force-exit tools/web-scout/*.test.mjs
```

Nothing needs to be running: each relay-touching test file starts its own
ephemeral relay on a free port with a throwaway database, so a green run
always validates the code on disk and files run in parallel. Tests that need
a real connected browser tab skip themselves; set `WEBSCOUT_TEST_LIVE=1` to
run them against a relay that has one. `docs-drift.test.mjs` requires your
new command and flags to appear in `usage.txt` (and the command in the README).

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
