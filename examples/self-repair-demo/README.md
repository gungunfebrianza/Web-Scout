# self-repair-demo

A tiny study-case app for web-scout's self-repair loop (see `../../webscout2.md` and the
"Self-repair loop" section of `../../README.md`). One IndexedDB store (`entries`), one planted bug,
a defined invariant, and a reset via web-scout's own `session cleanup --since-snapshot` - no bespoke
reset mechanism.

## The planted bug

`app.js`'s "Clear all" button is supposed to empty the `entries` store. It has an off-by-one: the
delete loop stops one row early, so one entry always survives a "Clear all". Invariant: after
"Clear all", `entries` should be empty.

## Run it

```bash
node tools/web-scout/examples/self-repair-demo/server.mjs   # serves http://127.0.0.1:8975/
```
Open `http://127.0.0.1:8975/?webscout=1` in a real browser tab so the web-scout agent connects.

## Full walkthrough: witness -> patch -> verify -> causal-diff

```bash
# 0. one-time: the loop is disabled by default (fail-closed) - turn it on
node tools/web-scout/cli.mjs repair status
node tools/web-scout/cli.mjs repair enable --by "you"

# 1. witness the bug
node tools/web-scout/cli.mjs session start "find the clear-all bug" --tags self-repair
node tools/web-scout/cli.mjs idb put-many entries '[{"id":1,"amount":1,"label":"a"},{"id":2,"amount":2,"label":"b"},{"id":3,"amount":3,"label":"c"}]'
node tools/web-scout/cli.mjs crv run --stores entries --type dom.click --params '{"selector":"#clearAllBtn"}' --expect "entries:-3"
# -> fails: expected entries to drop by 3, only 2 rows were removed (one survivor) - note the
#    failing action's id from the reply (its "actionId")

# 2. patch the bug (loop must be enabled - see step 0)
node tools/web-scout/cli.mjs repair patch examples/self-repair-demo/app.js \
  "for (let i = 0; i < keys.length - 1; i++) {" \
  "for (let i = 0; i < keys.length; i++) {" \
  --fixes-action-id <the failing action's id from step 1>
# -> {actionId, file, beforeHash, afterHash} - a normal logged action

# 3. reload so the browser picks up the patched app.js, then confirm the fix
node tools/web-scout/cli.mjs page reload --wait-reconnect
node tools/web-scout/cli.mjs idb put-many entries '[{"id":1,"amount":1,"label":"a"},{"id":2,"amount":2,"label":"b"},{"id":3,"amount":3,"label":"c"}]'
node tools/web-scout/cli.mjs repair verify --stores entries --type dom.click \
  --params '{"selector":"#clearAllBtn"}' --expect "entries:-3" \
  --patch-action-id <the patch's actionId from step 2>
# -> {pass:true, ...} - all 3 rows gone this time

node tools/web-scout/cli.mjs session end

# 4. see the recorded evidence (not a guess): diff this session against an earlier failing one
node tools/web-scout/cli.mjs repair causal-diff <earlier-failing-session-id> <this-session-id>
# -> .recorded.b includes {kind:'fixed_by', ...} and {kind:'confirmed_by', ...} - edges the loop
#    itself declared, distinct from .inferred's pattern-matched edges (see session-viz.mjs's
#    buildRecordedRepairEdges)

# 5. reset the app back to empty, using web-scout's OWN existing primitive (no bespoke reset code)
node tools/web-scout/cli.mjs idb snapshot --stores entries   # take a baseline BEFORE seeding, in a
                                                              # fresh session, if you want a clean
                                                              # since-snapshot reset point
node tools/web-scout/cli.mjs session cleanup <sessionId> --since-snapshot <snapshotId> --confirm

# turn the loop back off when done
node tools/web-scout/cli.mjs repair disable --by "you"
```

## What this demo does and does not prove

Same honest-limits framing as the rest of this loop (see `../../README.md`'s "Self-repair loop"
section): `repair verify` proves the *replayed action's* recorded outcome now matches the
invariant, on the *current* state of the patched file - it does not prove the patch is the
*minimal* or *only* correct fix, and a `recorded` edge only ever means "the loop declared this
link," never "this is provably the true cause." Read `repair causal-diff`'s `inferred` vs
`recorded` sections with that distinction in mind.
