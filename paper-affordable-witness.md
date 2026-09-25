# Affordable Witness: Live Control, Causal Evidence, and Economized Reads as a Load-Bearing Triad for Long-Horizon Browser Agents

**Author:** [to be filled]
**Artifact:** `tools/web-scout/` (agent-os monorepo; standalone mirror published as the `web-scout` repository)
**Status:** working draft. Every quantitative claim below is either reproducible from a committed test or file (Appendix A) or is explicitly labelled observational. Nothing here comes from a controlled user study or from a run against a model-in-the-loop benchmark.

---

## Abstract

A coding agent that edits a web front end cannot, by reading source alone, know whether its change worked. The usual remedy is to give the agent a browser. We argue that a browser handle is necessary but not sufficient for *long-horizon* work, and that three properties must hold together: **live control** (the agent acts on the real, already-open, authenticated tab, not a fresh synthetic one), **causal evidence** (what it did and what changed is recorded as durable, diffable state, so that a claim of success is replaced by a checkable diff), and **economized reads** (the cost, in model tokens, of reading the evidence back is measured, budgeted and driven down, so that the loop can run for many iterations before the context or the bill runs out). We call the combination an *affordable witness*.

We present Web-scout, a dependency-free local relay, in-page agent, SQLite store and dashboard that implements all three, and we report what is measurable about it today. On a deterministic scripted verify-loop fixture, a read strategy built from scoped reads, deltas and a warm-start briefing delivers 6,916 bytes against 151,901 bytes for an unguided caller (a ratio of 0.046). A calibration fitted from 38 real agent transcripts shows the tool's own chars/4 token unit understates true token cost for JSON replies by a factor of about 1.7, which changes absolute budgets but not the ratio. We then show that the triad extends into a fail-closed *self-repair loop* in which the agent that reads the evidence may patch a scoped example application, re-run the same check to confirm its patch, and leave behind *recorded* (not inferred) causal edges linking the failure, the patch and the confirmation.

We do not claim an ablation proves the triad is minimal. We claim instead that each leg is independently motivated by a failure mode we observed and encoded as a regression test, that the legs interact (economy is what makes causal evidence affordable to re-read; causal evidence is what makes economized reads safe to trust), and we give a protocol for the ablation we have not run.

**Keywords:** browser agents, agent observability, verification loops, token economy, causal provenance, self-repair, fail-closed design.

---

## 1. Introduction

Language-model coding agents now routinely edit web applications. A recurrent weakness is that "I fixed it" is a *claim*: the agent can read the source but cannot see the rendered page, the rows in IndexedDB, or the requests that actually fired. Tooling that closes this gap exists in two broad families. Browser drivers (Playwright and similar) launch and script a fresh browser context. Accessibility-tree or DevTools-protocol bridges expose a page's structure to an agent. Both are valuable. Neither is designed around the constraint that dominates long agent sessions in practice: *the evidence must be re-read by the model, and every re-read is paid for in context.*

This paper starts from an engineering observation that later became a thesis. The project's earliest workflow, nicknamed CRV (Declare a goal, Act, Capture state before and after, Diff), made the *diff* the unit of evidence instead of the agent's narration. That worked, but every subsequent development round in the repository's own roadmap (Section 3.3) turned out to be about one of two things: making the *action* more faithful to what a real user session does, or making the *reading back* of the evidence cheaper. The self-repair loop (Section 7) then showed a third dependency: once an agent can both read evidence and write code, the evidence itself needs a provenance structure, so the reader can tell what was observed from what was inferred.

**Thesis.** For a browser agent expected to run many verify-fix iterations against a real application, three properties are jointly load-bearing:

1. **Live control (A).** Acts on the operator's own tab, with real state and real origin, under an explicit session goal.
2. **Causal evidence (B).** Every action, before/after snapshot, diff, network and console entry is persisted, content-addressed and attributable; causal links between actions are distinguished by whether they were *recorded* or *inferred*.
3. **Economized reads (C).** The token cost of consuming the evidence is measured, calibrated with a stated error band, warned about before it is paid, and reduced by mechanisms that are themselves measured.

The word *affordable* in the title is the claim that (C) is not a nice-to-have optimisation but the constraint that lets (A) and (B) be used at the depth long tasks require.

**Contributions.**

- A design in which an evidentiary gate (no action without a declared goal) rather than a safety gate is the core control, and in which strictness can be made structural (`--strict-crv`) instead of a matter of agent discipline (Sections 4-5).
- A causal model over recorded sessions with two edge classes, inferred and recorded, deliberately kept in separate identifier spaces (Section 5.3).
- A token-economy subsystem whose savings are themselves ledgered, whose unit is calibrated against real transcripts, and whose budgets are enforced by tests that fail when replies or the tool schema grow (Section 6).
- A fail-closed self-repair loop reusing the same primitives (Section 7).
- An honest account of what is and is not measured (Sections 8 and 10), and an ablation protocol (Section 11).

---

## 2. Background and Related Work

*Note on citations: the works below are cited from memory to place the design; verify bibliographic details against the primary sources before any submission.*

**Agents that act in browsers.** Web-navigation benchmarks such as WebArena (Zhou et al., 2023) and Mind2Web (Deng et al., 2023) evaluate agents on task completion against controlled or recorded sites. Their object of study is the agent's policy; the evidence problem (how does anyone, human or agent, later verify what happened) is largely out of scope. The reasoning-and-acting pattern (ReAct; Yao et al., 2022) and self-reflection (Reflexion; Shinn et al., 2023) supply the loop structure such agents follow, but not the instrumentation that makes each iteration's outcome checkable.

**Agents that edit code.** SWE-bench (Jimenez et al., 2023) evaluates patches by running a project's tests. That is a strong oracle when tests exist. For interactive front ends, the deciding evidence is often runtime state (a store's rows, a network call, a console error) that no unit test asserts. Web-scout supplies an oracle of that kind: an `expect` expression over store deltas checked by re-snapshotting.

**Browser automation and protocols.** Driver frameworks and the Chrome DevTools Protocol give programmatic control of a browser. Web-scout differs in two deliberate ways. It attaches to an *already-open, already-activated* tab through an in-page script (so authenticated, stateful sessions are usable without recreating them), and it treats persistence of the interaction record as a first-class feature rather than a by-product. It is explicitly *not* a real browser driver; its screenshot is a best-effort DOM rasterisation and it cannot reproduce real input timing (Section 10).

**Tool interfaces for models.** The Model Context Protocol (Anthropic, 2024) exposes tools to models; the *tool list itself* is sent to the model on session start and therefore has a token cost paid whether or not any tool is used. Section 6.4 treats that as a budgeted quantity.

**Context length and reading cost.** Long-context degradation (Liu et al., 2023, "Lost in the Middle") motivates keeping returned evidence small even when a window could hold more. The argument in this paper does not depend on that finding; it depends only on the arithmetic that cost scales with delivered bytes.

**Provenance and content addressing.** Content-addressed storage (as in Git's object model) and event-sourced logs supply the storage discipline used in Section 6.3. The distinction between *recorded* and *inferred* provenance edges follows a familiar separation in provenance systems between what a process declared and what an analyst reconstructed.

---

## 3. System Overview

### 3.1 Architecture

```text
Already-open, already-activated browser tab
        |
        v
inject.js (in-page agent, dormant by default)
        |  WebSocket
        v
relay.mjs (Node, binds 127.0.0.1 only)
        |
        +--> db.mjs         (node:sqlite: sessions, actions, snapshots, diffs,
        |                    console, net, Q&A, macros, verity runs, blob tables)
        +--> ai.mjs         (ask a model about recorded evidence)
        +--> report.mjs     (Markdown/JSON session export)
        +--> GET /dashboard, GET /events (realtime dashboard over SSE)
        ^
        |
cli.mjs / mcp-server.mjs  (invoked by an agent through a shell or MCP)
```

The implementation has no npm dependencies. At the commit this paper was written against, the relay is about 3,700 lines, the store about 2,300, and the in-page agent about 100 KB; the CLI's command surface is declared once in `cli-spec.mjs` and both the CLI and the MCP tool list are checked against it by tests. The repository contains 59 test files.

### 3.2 The evidentiary gate

Every action-dispatching command requires an active session with a declared goal; the relay rejects a command with no session rather than recording it unattributed. This is an *evidentiary* gate, not a *safety* gate: it makes actions attributable, it does not make them harmless. The project's own documentation is explicit that, once activated, the agent has standing full DOM/IndexedDB/network/`eval` access equivalent to an open DevTools console on an authenticated session, and that the relay's only network defence is binding to loopback.

### 3.3 Development method as evidence

The roadmap (`docs/web-scout-roadmap.md`, over 190 KB) records numbered rounds, V0 onward, each motivated by a concrete friction observed in a real verification pass against a host application, from lessons of a real verification pass (V4) through Verity evidence bundling (V6), Friction Analytics (V7), audit-driven hardening (V8), and token-cost rounds (V22 onward). We do not treat this history as validation. We treat it as the source of the failure modes that each leg of the triad answers, and as an existence proof that the tool was used, and repaired, against real work.

---

## 4. Leg A: Live Control

**Attach to the real tab.** The in-page agent is injected into the target app's own entry HTML, dormant unless activated by `?webscout=1` or a local-storage flag; additional tabs are addressed by name (`?webscout_name=NAME`). The agent can query, click and fill the DOM; read and write IndexedDB (`dump`, `put`, `put-many`, `patch`, `delete`, `clear`); run arbitrary JavaScript (`eval`, a deliberately labelled escape hatch); read console and network capture; hard-reload past Service Worker caches; and inspect React fibre state without a DevTools extension.

**Refuse to guess.** A selector matching several elements is refused rather than resolved to the first; `dom.click` uses the native `.click()`. These choices trade convenience for the guarantee that the recorded action is the action the agent named.

**Origin pinning.** A session pins itself to its agent's current origin. A later call is refused if the same agent name now reports from a different origin, and a mutating command or `eval` against a non-localhost origin is refused without `--allow-remote`. The project notes a real incident in which one agent name silently served two different origins and databases across a session; the check exists because nothing else caught it for dozens of calls.

**Waiting on the page, not the clock.** `dom settle`, `dom wait --changed/--stable` and `dom click-wait --wait-selector` replace fixed sleeps with waits on observable quiescence or change, and `crv launch` opens a tab with the activation parameters and polls for the agent to connect, avoiding the tab-name collision failure.

**Boundary of the claim.** Live control is *full-fidelity to DOM and storage state*, not to input physics. Section 10 lists what this excludes.

---

## 5. Leg B: Causal Evidence

### 5.1 What is recorded

Sessions, actions (type, params, result, ok flag, error, timestamps), full before/after IndexedDB snapshots, diffs keyed by each store's *real* primary key (never assuming `id`), console entries, network entries, question-and-answer records against an AI, macros, and imported UI-verifier runs are persisted to SQLite. The store survives relay restarts and tab reloads; the dashboard receives each event live over SSE.

### 5.2 Making the check one call

The CRV primitive composes into `crv run`: baseline snapshot, dispatch, verify in a single call, with an expectation grammar over store deltas (`store:+N` added, `-N` removed, `~N` changed, a trailing `+` for "at least", `same`). `--strict-crv` makes the snapshot/act/snapshot/diff sequence automatic around every mutating command, so the discipline cannot be silently skipped by an agent that forgets. The agent's *claim* is thereby replaced by a machine-checked expectation.

### 5.3 A causal model with two edge classes

`session-viz.mjs` builds ten views from rows already stored, among them a per-agent swimlane, a snapshot state machine, an episode tree, a sequence diagram, a route FSM, a waste view, a token-cost breakdown, two failure heatmaps and a **causality tree**. The causality tree links a retry to the failure it followed, a recovery to a failure, a verify to the write it checked (edge kinds `retried`, `recovered`, `verifies`, `follows-failure`). Every one of these edges is **inferred from patterns** in the action sequence; none is a ground-truth declaration by the agent.

The self-repair loop (Section 7) introduces a second edge class that is **recorded**: `fixed_by` links a failing action to the patch that addressed it, and `confirmed_by` links a patch to the verification that passed, using identifiers the agent itself supplied when it patched and verified. The two classes are deliberately kept in *separate identifier spaces* (inferred edges are keyed by episode step id; recorded edges by raw action id) and never merged into one list, so a reader can always tell observation from reconstruction. `diffCausality` compares two sessions by edge identity (added, removed, kept), and a dashboard panel renders the recorded edges as an overlay on the inferred tree.

### 5.4 Evidence about the tool's own failures

Friction Analytics aggregates, across sessions, failure rates by action type and selector (with trend and last-failed time), recorded-but-never-run macros, sessions that crossed the "record a macro" nudge threshold with none ever recorded, Verity labels and golden diffs whose latest result is still failing, top failing network URLs and console messages, and a ranked five-item `topFrictionItems` digest. A `known-issues.json` registry (an optional, untracked, per-checkout file) lets a matching failure carry a remediation inline. This reaches the agent *live*: a failed command's own reply carries `knownIssue`; a selector that failed three or more times before draws a risk warning before it fails again; `session end` reports `emergentFriction` (a type, selector, URL or message failing for the first time or first repeating). The per-session checks read a snapshot frozen at `session start`, not a live analytics call, so they cannot go stale mid-session or poison the shared analytics cache.

We regard this as the point where causal evidence and economized reads meet: evidence about failure is only useful to an agent if it arrives in the reply it is already reading, at a byte cost small enough that receiving it is not itself a new source of waste.

---

## 6. Leg C: Economized Reads

### 6.1 The cost model and its known bias

Every byte-to-token figure in the tool uses chars/4 as a *common unit*. The unit is kept because it makes numbers comparable across days and versions; reports carry a labelled error band beside it. Defaults (JSON 3.5 chars/token, HTML 3.2, prose 4.0) are rule-of-thumb and flagged uncalibrated until measured.

Two calibrators exist. One counts real tokens with a provider token-counting endpoint (requires a key). The other, `transcript-tokens.mjs`, needs no key: an agent's own transcript already records the prompt size for each call, so for a clean gap (one tool call, one result, nothing else appended) the reply's token count equals the growth in prompt tokens minus the previous output tokens, and the reply's text is in the same file. A line is fitted over many gaps per content kind; its slope is chars per token and its intercept the constant every tool result carries.

The committed calibration, sampled from 38 transcripts, gives:

| Kind | Fitted gaps | Chars fitted | Chars/token (band) | Per-reply constant |
|------|------------:|-------------:|--------------------|-------------------:|
| JSON | 350 (of 434 samples) | 711,249 | 2.37 (2.03-2.93) | 69.4 tokens |
| HTML | 94 (of 116 samples) | 239,562 | 2.19 (2.01-2.54) | 49.0 tokens |
| Prose | skipped: 3 samples, fewer than the 8 required | | | |

Against the chars/4 unit, this says the tool's headline token figures for JSON replies **understate real cost by about 1.7x** (4 / 2.37) and for HTML by about 1.8x. The ledgers' *ratios* are unaffected, since both sides of a comparison are the same kind, but absolute budgets must be read with the band. A calibration older than 90 days is reported as stale. The method is labelled `transcripts` (an estimate), not the exact count the endpoint gives, and it measures the model that actually ran the sessions.

### 6.2 Reducing what is delivered

The mechanisms, each individually tracked in a savings ledger:

- **Scoped reads.** `--where`, `--fields`, `--limit`, `--url-contains`, `--meta`, and whole-page outline limits report what they left out, aggregated in a `scopedReads` ledger with a 14-day trend.
- **Reply shaping.** `--peek` (shape and size, not the body), `--table` (keys stated once), `--if-changed` (a pointer instead of a repeat body), `--delta` (only what changed since what this caller already holds), and a `--token-budget` guard that turns large reads into peeks as the budget burns. `session start` returns a warm-start briefing that replaces exploratory reads; `--lean` makes shaping the session default.
- **Same-session read cache.** An identical read on the same tab with nothing mutated since is answered from cache, never re-dispatched. A hit is first checked against the page's own change counter (DOM mutations, fetch/XHR and console entries, IndexedDB writes), so a page that changed by itself is re-read, not served stale.
- **One-call verification.** `crv run` and `idb verify` answer in a few lines when the check passes and return rows only for what failed, replacing three round trips each with a full body.
- **Pre-call cost hints.** A whole-page selector, or a store with real historical cost, warns *before* it is paid, with a learned number.
- **Behavioural nudges, measured.** The relay watches how a session reads (scoped then unscoped; identical full re-deliveries), states one line when it sees waste, and then measures whether the hint was followed.

### 6.3 Reducing what is stored

Storage is content-addressed at seven granularities: whole action results, params, individual snapshot rows, macro steps, console messages and stacks, network URLs, and verity/diff results. Each distinct content is stored once regardless of how many rows, sessions or macros reference it (blob tables carry reference counts). Column-dictionary compaction folds repeated field values across one store's rows into a small dictionary; macro step templating folds near-duplicate steps into a template plus a value list; both are transparent to callers. Golden-diff results are memoised by content rather than snapshot id. Storage economy is not itself a token saving, but it is what keeps a never-pruned evidence log (Section 10) usable and what makes "read the diff, not the snapshots" cheap.

### 6.4 The fixed cost paid before anything is used

The MCP tool list is sent on session start; `usage.txt` is what `help` slices from. Both are tokens spent whether or not a feature is used, so `schema-budget.test.mjs` gives them explicit byte caps (total tool list, largest single tool, the largest help group, the help index) and fails when a change grows them, with the rule that a cap is raised only deliberately, in the same commit as the text and with the reason recorded in a comment. The recorded history is instructive: the tool list measured 17,973 bytes at V32, was compressed to 16,296 at V33, and had grown to 19,734 bytes (cap 19,750) after later coherence rounds, the self-repair tool group and a seed-template verb. That is +3,438 bytes (+21.1%) over the V33 low point, each step individually justified by a named gap and each visible in the diff. On the chars/4 unit the current list is roughly 4,900 tokens per session; on the JSON calibration above it would be closer to 8,300. We report both to keep the bias in view.

### 6.5 Economy as an enforced property, not an aspiration

`token-benchmark.test.mjs` runs a scripted CRV session against a fixture twice through a real relay and asserts two things: the default path stays under a byte budget (so a verbose field or a new envelope fails a test instead of appearing later as a bill), and the lean path stays under a ratio of the default (so the read strategy has to keep earning its place). When a change legitimately moves the numbers, the constant is raised in the same commit with the reason, and the printed table is the evidence.

---

## 7. Closing the Loop: A Fail-Closed Self-Repair Extension

An internal design note argued that live control plus causal evidence only become a *repair* loop, and not merely a dashboard, when the process that reads the evidence also holds write access to the code under test and re-runs the check to confirm its own patch. The extension implements that, and is a useful test of whether the triad composes.

**Fail-closed write access.** `self-repair.mjs` holds the boundary. The loop is disabled by default; a missing or unreadable config falls back to disabled, never to permissive. A patch to any path outside the configured scope directory is refused *regardless of the enabled flag*, with `..` collapsed by path resolution before the prefix check so traversal lands outside scope. In the shipped configuration the scope is a single example application directory: the loop cannot modify a real page of the host application. The kill switch is server-side, not a UI toggle, and each toggle is itself a logged, attributable entry (`by` is self-declared, an honest limit stated in code, not authentication).

**A deliberately weak patcher.** The patch action is a literal find/replace that *refuses* an ambiguous (two or more) or missing match rather than guessing, and returns before/after SHA-256 hashes. It is a normal logged action (`fs.patch`). We chose this over a diff engine because the aim is to make the *loop* trustworthy on a planted bug, not to claim general program repair.

**Confirmation reuses CRV.** `repair verify` re-runs the recorded check through the same snapshot, dispatch and verify path as `crv run`, with the original invariant as the expectation, and records the outcome as `repair.verify`. A failed verify means the patch is not treated as accepted.

**Recorded causal edges.** Patch and verify carry `fixesActionId` and `patchActionId` respectively, yielding the `fixed_by` and `confirmed_by` edges of Section 5.3. `GET /repair/causal-diff` diffs two sessions' trees: a failing session against a passing one shows exactly which recorded edges appeared.

**Cost attribution without a new subsystem.** The loop's own session is tagged `self-repair` through the existing tag mechanism; its cost is then a filtered view over the existing per-session token totals, and the dashboard can show tokens per confirmed fix by dividing that total by the count of passing verifies for the session. A cross-session feed of the loop's own actions (`GET /repair/activity`, capped at 300, best-effort) drives a patch ledger, a patched-to-confirmed funnel, and an enabled/disabled timeline strip from the kill switch's history.

**Study-case application.** `examples/self-repair-demo/` is a small ledger app over one IndexedDB store with one planted off-by-one (the "Clear all" loop stops one row early, so one entry always survives). The walkthrough: witness the failure with `crv run ... --expect "entries:-3"`, patch, reload, verify, then `repair causal-diff` between the failing and passing sessions. Reset uses the *existing* `session cleanup --since-snapshot` primitive; no bespoke reset mechanism was built.

**What the extension demonstrates, and does not.** It demonstrates that recorded edges, the CRV oracle, the token ledger and the dashboard compose without new storage or new cost tracking. It does not demonstrate autonomous repair of unseen bugs: the scope is one directory, the patcher is literal, the bug is planted, and there is no model-in-the-loop evaluation.

---

## 8. Evaluation: What Is Actually Measured

We separate three kinds of evidence, in decreasing strength.

### 8.1 Deterministic, reproducible: the read-strategy benchmark

`token-benchmark.test.mjs` scripts a baseline, action, verify session against a fixture: 40 stores, an `orders` store of 150 rows, a 120-entry request log and one panel. The action ships one order. The "default" caller looks around, dumps, acts, dumps again and re-checks (including one "did anything else change?" re-read of an unchanged store). The "lean" caller takes the warm-start briefing, peeks then scopes reads, and asks for deltas on the verify pass. Bytes are the compact-JSON size of what each caller would print. A run on this checkout produced:

| Session | Briefing | Baseline | Action | Verify | Total bytes | ~Tokens (chars/4) |
|---------|---------:|---------:|-------:|-------:|------------:|------------------:|
| default | 0 | 51,625 | 16 | 100,260 | 151,901 | 37,975 |
| lean | 724 | 3,527 | 16 | 2,649 | 6,916 | 1,729 |

The lean/default ratio is **0.046**, a 95.4% reduction. Two features of the table matter more than the headline. First, the default verify pass costs 1.9x its own baseline: re-reading to confirm is where an unguided loop spends most of its bytes, which is precisely the phase a long-horizon agent repeats most. Second, a companion test checks the lean run reads *the same facts*: the delta contains the changed order (id 12 now `shipped`) and the new requests. The saving is not bought by dropping the evidence.

Rescaling on the JSON calibration (2.37 chars/token), the same runs are about 64,100 and 2,900 tokens; the per-reply constant (about 59 tokens) is not applied. The ratio is unchanged and the absolute figures are larger than the chars/4 unit suggests.

### 8.2 Enforced budgets: the schema and reply caps

Section 6.4's tool-list history is committed and checked on every test run; it is a measurement of a fixed cost and its growth, not a benefit claim.

### 8.3 Regression and integration tests

The suite has 59 test files. Categories include CLI/MCP/usage parity (`cli-parity`, `docs-drift`, `command-registry`), read-shaping and cache behaviour, CRV verification and safety, friction analytics and its known-issue reach, dashboard registry and a real headless-browser render, session visualisations, and the 11-test self-repair suite (scope refusal, fail-closed default, verify pass and fail, causal diff, cost filter) which runs an ephemeral relay and a fake agent against an isolated temporary config so it never touches the committed config file. In the last full runs on the development branches, 421 to 442 tests ran, of which 14 failed on each run. All 14 were in four files (`auto-restart`, `relay-control`, `read-pipeline`'s `--peek` case, `token-calibration`) that spawn real relay processes on fixed OS ports and contend with each other under a concurrent run; one of them (`relay-control`) passes fully when run alone. We treat this as a documented pre-existing test-infrastructure weakness, not as evidence of correctness for those paths, and we did not resolve it for this paper.

### 8.4 Observational only: a development instance

The developer's local database (one instance, one operator, 2026-09-15 to 2026-09-20, including this project's own test and smoke sessions) holds 227 sessions and 2,154 actions, of which 215 (10.0%) were recorded as failed, plus 80,625 captured network entries and 76 console entries. The most frequent action types were `eval` (580), `dom.query` (202), `dom.click` (200), `idb.dump` (187) and `idb.put` (156). These figures show the store operates at non-trivial volume; they are **not** a usage study and support no generalisation, because they mix real verification work with development scaffolding.

---

## 9. Discussion: Why "Load-Bearing"?

We defend the thesis by showing, for each leg, what breaks without it, and then by showing the interactions.

**Without A (live control).** The agent verifies against a fresh or mocked context, not the operator's authenticated, stateful tab. Failures that depend on accumulated IndexedDB state, service-worker caches or the real origin cannot be reproduced. The origin-pinning incident (Section 4) is an example of A's *own* failure mode: silently talking to the wrong origin is worse than not having the tool.

**Without B (causal evidence).** The agent's "it works" is uncheckable, and, more subtly, a *second* agent or a human reviewer cannot audit it. Strict mode exists because forgetting to snapshot is a predictable failure of a forgetful actor. The recorded/inferred split exists because, once an agent can write code, a causal tree made only of pattern guesses is a weak basis for trusting "this patch fixed that failure".

**Without C (economized reads).** The loop is affordable for a handful of iterations and then not. The benchmark's verify pass is the concrete case: an unguided verify reads back what it already holds. Over N iterations the linear cost of re-reading dominates; a delta-based verify makes N a much larger number for the same budget. Economy also protects the *quality* of the reader: friction warnings that arrive inside a bloated reply are less likely to be acted on.

**Interactions.** (i) *C makes B affordable to consult.* Causal evidence that costs 100,000 bytes to re-read will be re-read once; at 2,649 bytes it can be re-read every iteration. (ii) *B makes C safe.* Deltas, caches and peeks trade completeness for size; that trade is only defensible because the full record exists in the store and a cache hit is guarded by the page's change counter. (iii) *A makes both worth having.* The evidence is only as good as the fidelity of the action that produced it. (iv) *The self-repair loop is the stress test of the triad:* it needs A to reproduce the bug, B to hold the recorded chain and C to keep repeated verify passes cheap, and it added no new storage and no new cost tracking to do so.

**Design stance shared by all three legs.** Each leg is enforced by a test rather than by documentation: strict-CRV structurally, cost budgets by failing assertions, tool-schema growth by byte caps, docs/CLI/MCP agreement by drift tests, self-repair scope by a fail-closed default plus a path-prefix check. The recurring pattern is to make the *cheap, dishonest* path fail a test, so honesty does not depend on a well-behaved caller.

---

## 10. Threats to Validity and Limitations

1. **No ablation.** "Load-bearing" is argued from design and from partial measurement, not demonstrated by removing each leg and measuring end-to-end task success. This is the paper's main gap (Section 11).
2. **The benchmark is a best case.** The fixture is synthetic, deterministic and built to exercise the strategy; the source itself labels the 0.046 ratio "a best case for the strategy, not a forecast for real sessions". Real sessions have less redundant re-reading, so real savings will be smaller.
3. **Bytes are a proxy for tokens, and the proxy is biased.** chars/4 understates JSON cost by about 1.7x on our calibration. The calibration is fitted from one model's transcripts (labelled "mixed"), covers no prose kind (too few samples), is an estimate and not an exact count, and ages (flagged stale at 90 days). Token counts also depend on the deployed tokenizer.
4. **No model-in-the-loop evaluation.** We do not measure whether an agent given this tool finishes tasks faster, cheaper or more correctly. The token benchmark scripts a *caller*, not a model.
5. **The self-repair extension is narrow by construction.** One directory, one planted bug, literal find/replace, self-declared operator names. It shows composition, not capability.
6. **Live control means real capability.** Once activated the agent has open-DevTools-equivalent access, including `eval`, with no read-only activation mode and no authentication beyond loopback binding. It must not run on a shared or remotely accessible machine or against a real production session.
7. **Not a real browser driver.** No real input timing or pressure; the screenshot is a DOM rasterisation. Bugs that depend on compositing, focus timing or true pointer events may be invisible to it.
8. **One active session at a time**, enforced by the database; parallel investigations must be sequenced. Named agents share a relay with no permission boundary between them.
9. **The evidence log is never pruned** for console and network entries, so a chatty page grows it without bound; content addressing mitigates duplicates, not volume.
10. **Test-infrastructure flakiness** (Section 8.3) means part of the suite cannot currently be read as a clean signal under concurrent execution.
11. **Single-team provenance.** The friction that shaped each round came from one host application and one operator's workflow; generality across applications is untested. The observational figures in Section 8.4 are contaminated by development activity.
12. **Circularity risk.** The roadmap's rounds and the tests that enforce them were written by the same team that designed the triad; that is a reason to want an independent replication.

---

## 11. Future Work: The Ablation We Have Not Run

**Design.** A within-task comparison on a fixed set of front-end repair tasks (a planted-bug corpus in the style of `self-repair-demo`, extended beyond one app), run with a fixed agent and model, under five conditions:

| Condition | Live control | Causal evidence | Economized reads |
|-----------|:---:|:---:|:---:|
| Full triad | on | on | on |
| No economy | on | on | off (unscoped, no cache, no deltas, no briefing) |
| No evidence | on | off (no snapshots, no diff, no recorded edges; agent's claim only) | on |
| Fresh context | off (isolated headless context, no persisted state) | on | on |
| Baseline | off | off | off |

**Measures.** Task success judged by an independent oracle (a held-out invariant, not the agent's own `expect`); tokens consumed to success, using the calibrated unit with its band; iterations to success; false-success rate (agent claims a fix that the oracle rejects); and, for the no-evidence arm, the rate at which a human reviewer can *audit* a claimed fix from the record.

**Predictions the design commits to.** Removing economy should not change success at small horizons but should reduce success or raise cost sharply as iterations grow; removing evidence should raise false-success rate; removing live control should fail specifically on stateful and origin-dependent bugs. If any prediction fails, the corresponding leg is not load-bearing in the sense claimed.

**Other work.** Sharing one friction history across checkouts is already possible by pointing relays at one database file (`WEBSCOUT_DB_PATH`); a multi-operator study is the natural extension. On the systems side: pruning policy for the evidence log, an authenticated multi-agent boundary, and a diff-capable (not literal-match) patcher whose fail-closed scope is retained.

---

## 12. Conclusion

An agent that can act on a real tab, leave behind evidence that distinguishes what was recorded from what was inferred, and read that evidence back at a cost that does not grow with every iteration can run a verify-fix loop far longer than one lacking any of the three. Web-scout is a working implementation of that combination, and the parts of the claim that can currently be measured hold up: a read strategy that delivers about 4.6% of the bytes of an unguided caller on a fixture while reading the same facts; a calibration that exposes the bias in its own unit; byte budgets that fail the build when fixed costs grow; and a fail-closed extension that closes the loop from failure to patch to confirmation with recorded edges and no new storage. What remains unproven is the causal claim in the title. The ablation in Section 11 is the test that could falsify it, and we state its predictions in advance so that it can.

---

## References

*Cited from memory; verify before submission.*

- Deng, X., et al. (2023). *Mind2Web: Towards a Generalist Agent for the Web.*
- Jimenez, C. E., et al. (2023). *SWE-bench: Can Language Models Resolve Real-World GitHub Issues?*
- Liu, N. F., et al. (2023). *Lost in the Middle: How Language Models Use Long Contexts.*
- Shinn, N., et al. (2023). *Reflexion: Language Agents with Verbal Reinforcement Learning.*
- Yao, S., et al. (2022). *ReAct: Synergizing Reasoning and Acting in Language Models.*
- Zhou, S., et al. (2023). *WebArena: A Realistic Web Environment for Building Autonomous Agents.*
- Anthropic (2024). *Model Context Protocol* specification.
- Git object model (content-addressed storage), as a reference design for Section 6.3.

---

## Appendix A: Reproducibility

Run from `tools/web-scout/` (Node with built-in `node:sqlite`; no `npm install`).

| Claim | How to reproduce |
|-------|------------------|
| Section 8.1 table | `node --test token-benchmark.test.mjs` (prints the per-phase table as a test diagnostic; deterministic) |
| Budget history and current tool-list size | `schema-budget.test.mjs` (constants and the comment history above them) |
| Calibration values (Section 6.1) | `token-calibration.json`; regenerate with `calibrate-tokens.mjs` (needs a key) or `transcript-tokens.mjs` (needs local agent transcripts) |
| Self-repair behaviour | `node --test self-repair.test.mjs`; walkthrough in `examples/self-repair-demo/README.md` |
| CLI/MCP/docs agreement | `node --test cli-parity.test.mjs docs-drift.test.mjs` |
| Dashboard panels | `node --test dashboard.test.mjs` (static registry checks plus a headless-browser render) |
| Section 8.4 counts | read-only queries over the developer's local `webscout.db` (gitignored, not reproducible elsewhere) |

Line counts and file sizes in Section 3.1 are from the `distribution-backend-migration` checkout at the time of writing and will drift.

## Appendix B: Glossary

- **CRV.** Declare a goal, Act, Capture before/after, Diff. The diff is the evidence.
- **Golden snapshot.** A named, permanent baseline that any later session can diff against.
- **Macro.** A recorded action sequence, replayable, with consecutive duplicates compacted.
- **Recorded edge / inferred edge.** A causal link the agent declared (`fixed_by`, `confirmed_by`) versus one reconstructed from an action-sequence pattern (`retried`, `recovered`, `verifies`, `follows-failure`).
- **Friction.** Repeated or first-time failure by type, selector, URL or console message, aggregated across sessions.
- **Lean read.** A read shaped by scope, peek, delta or cache so that it delivers changes, not repeated bodies.
