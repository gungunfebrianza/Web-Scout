# Capabilities and where each is reachable

Generated from `surfaces.mjs` and `cli-spec.mjs` by `node surfaces.mjs --write`; `surfaces.test.mjs` fails when this file is stale.
A `-` in the CLI or Dashboard column carries a reason in `surfaces.mjs` (`cliWhy` / `dashboardWhy`). MCP actions are those of the CLI commands.

| Capability | HTTP | CLI | MCP | Dashboard |
|---|---|---|---|---|
| health | `GET /health` | `status` | `webscout_meta.status` | `GET /health` |
| config | `GET /config`<br>`PUT /config` | - | - | `GET /config`<br>`PUT /config` |
| agents | `GET /agents` | `agents` | `webscout_meta.agents` | `GET /agents` |
| ping | `POST /ping` | `ping` | `webscout_meta.ping` | - |
| dashboard-page | `GET /dashboard` | `dashboard` | `webscout_meta.dashboard_url` | - |
| ask | `POST /ask` | `ask` | `webscout_session.ask` | `POST /ask` |
| search | `GET /search` | `search` | `webscout_meta.search` | `GET /search` |
| session-lifecycle | `POST /sessions`<br>`POST /sessions/:n/end`<br>`GET /sessions`<br>`GET /sessions/:n` | `session start`<br>`session end`<br>`session current`<br>`session list`<br>`session show` | `webscout_session.start`<br>`webscout_session.end`<br>`webscout_session.current`<br>`webscout_session.list`<br>`webscout_session.show` | `POST /sessions/:n/end`<br>`GET /sessions`<br>`GET /sessions/:n` |
| session-trace | `POST /sessions/:n/trace` | `session end` | `webscout_session.end` | - |
| session-actions | `GET /sessions/:n/actions`<br>`GET /sessions/:n/actions/:n` | `session show` | `webscout_session.show` | `GET /sessions/:n/actions`<br>`GET /sessions/:n/actions/:n` |
| session-evidence | `GET /sessions/:n/snapshots`<br>`GET /sessions/:n/diffs`<br>`GET /state/snapshots/:n`<br>`GET /state/diffs/:n`<br>`GET /sessions/:n/console`<br>`GET /sessions/:n/net`<br>`GET /sessions/:n/qa` | `session show` | `webscout_session.show` | `GET /sessions/:n/snapshots`<br>`GET /sessions/:n/diffs`<br>`GET /state/snapshots/:n`<br>`GET /state/diffs/:n`<br>`GET /sessions/:n/console`<br>`GET /sessions/:n/net`<br>`GET /sessions/:n/qa` |
| session-report | `GET /sessions/:n/report` | `session report` | `webscout_session.report` | `GET /sessions/:n/report` |
| session-viz | `GET /sessions/:n/viz` | `session viz` | - | `GET /sessions/:n/viz` |
| session-intents | `POST /sessions/:n/intents/import` | `session intents` | - | `POST /sessions/:n/intents/import` |
| session-cleanup | `POST /sessions/:n/cleanup` | `session cleanup` | `webscout_session.cleanup` | - |
| session-assert | `POST /sessions/:n/assert` | `session assert` | `webscout_session.assert` | - |
| session-replay | `POST /sessions/:n/replay` | `session replay` | `webscout_session.replay` | `POST /sessions/:n/replay` |
| token-report | `GET /sessions/:n/token-report`<br>`GET /token-report` | `token-report` | `webscout_meta.token_report` | `GET /sessions/:n/token-report`<br>`GET /token-report` |
| verity | `GET /sessions/:n/verity-runs`<br>`GET /verity-runs/:n`<br>`POST /verity/import` | `verity import`<br>`verity history`<br>`verity show` | `webscout_session.verity_import`<br>`webscout_session.verity_history`<br>`webscout_session.verity_show` | `GET /sessions/:n/verity-runs`<br>`GET /verity-runs/:n`<br>`POST /verity/import` |
| macros | `POST /macros`<br>`GET /macros`<br>`GET /macros/:n`<br>`PUT /macros/:n/steps`<br>`DELETE /macros/:n`<br>`POST /macros/:n/run` | `macro record`<br>`macro list`<br>`macro show`<br>`macro update`<br>`macro delete`<br>`macro run` | `webscout_macro.record`<br>`webscout_macro.list`<br>`webscout_macro.show`<br>`webscout_macro.update`<br>`webscout_macro.delete`<br>`webscout_macro.run` | `POST /macros`<br>`GET /macros`<br>`PUT /macros/:n/steps`<br>`DELETE /macros/:n`<br>`POST /macros/:n/run` |
| command | `POST /command` | `dom query`<br>`dom click`<br>`dom fill`<br>`idb dump`<br>`net log`<br>`console log`<br>`eval`<br>`page reload` | `webscout_dom.query`<br>`webscout_dom.click`<br>`webscout_dom.fill`<br>`webscout_idb.dump`<br>`webscout_net.log`<br>`webscout_console.log`<br>`webscout_eval`<br>`webscout_page.reload` | `POST /command` |
| state | `POST /state/snapshot`<br>`POST /state/diff`<br>`POST /state/verify`<br>`POST /state/restore` | `idb snapshot`<br>`idb diff`<br>`idb diff-golden`<br>`idb verify`<br>`idb restore` | `webscout_idb.snapshot`<br>`webscout_idb.diff`<br>`webscout_idb.diff_golden`<br>`webscout_idb.verify`<br>`webscout_idb.restore` | `POST /state/snapshot`<br>`POST /state/diff` |
| crv | `POST /crv/preflight`<br>`POST /crv/run` | `crv preflight`<br>`crv run` | `webscout_idb.crv_preflight`<br>`webscout_idb.crv_run` | - |
| repair | `GET /repair/config`<br>`PUT /repair/config`<br>`GET /repair/activity`<br>`GET /repair/causal-diff`<br>`POST /repair/patch`<br>`POST /repair/verify` | `repair status`<br>`repair enable`<br>`repair disable`<br>`repair patch`<br>`repair verify`<br>`repair causal-diff` | `webscout_repair.status`<br>`webscout_repair.enable`<br>`webscout_repair.disable`<br>`webscout_repair.patch`<br>`webscout_repair.verify`<br>`webscout_repair.causal_diff` | `GET /repair/config`<br>`PUT /repair/config`<br>`GET /repair/activity`<br>`GET /repair/causal-diff` |
| host | `GET /host/health`<br>`GET /host/trend`<br>`GET /host/sessions`<br>`GET /host/footprint`<br>`GET /host/test-run`<br>`POST /host/cleanup`<br>`POST /host/kill-orphans` | `scratch status`<br>`scratch cleanup` | - | `GET /host/health`<br>`POST /host/cleanup`<br>`POST /host/kill-orphans` |
| analytics | `GET /analytics` | `analytics` | `webscout_meta.analytics` | `GET /analytics` |
| friction-resolve _(friction)_ | `POST /friction/resolve`<br>`POST /friction/unresolve`<br>`GET /friction/resolutions` | `friction resolve`<br>`friction unresolve`<br>`friction list` | `webscout_meta.friction` | `POST /friction/resolve`<br>`POST /friction/unresolve` |
| friction-explain _(friction)_ | `GET /friction/explain` | `friction explain` | `webscout_meta.friction` | `GET /friction/explain` |
| friction-session _(friction)_ | `GET /friction/session` | `friction session` | `webscout_meta.friction` | `GET /friction/session` |
| friction-config _(friction)_ | `GET /friction/config` | `friction config` | `webscout_meta.friction` | `GET /friction/config` |
| friction-targets _(friction)_ | `GET /friction/targets` | `friction targets` | `webscout_meta.friction` | `GET /friction/targets` |
| friction-notices _(friction)_ | `GET /friction/notices` | `friction notices`<br>`friction watch` | `webscout_meta.friction` | `GET /friction/notices` |
| friction-next _(friction)_ | `GET /friction/next`<br>`POST /friction/next` | `friction next` | `webscout_meta.friction` | `POST /friction/next` |
| friction-trend _(friction)_ | `GET /friction/trend` | `friction trend` | `webscout_meta.friction` | `GET /friction/trend` |
| friction-regressions _(friction)_ | `GET /friction/regressions` | `friction regressions` | `webscout_meta.friction` | `GET /friction/regressions` |
| friction-snooze _(friction)_ | `POST /friction/snooze`<br>`POST /friction/unsnooze`<br>`GET /friction/snoozes` | `friction snooze`<br>`friction unsnooze`<br>`friction snoozes` | `webscout_meta.friction` | `GET /friction/snoozes` |
| friction-check _(friction)_ | `GET /friction/check` | `friction check` | `webscout_meta.friction` | `GET /friction/check` |
| friction-state _(friction)_ | `GET /friction/export`<br>`POST /friction/import` | `friction export`<br>`friction import` | `webscout_meta.friction` | `GET /friction/export`<br>`POST /friction/import` |
| known-issues-review _(friction)_ | `GET /known-issues/review`<br>`POST /known-issues/renew`<br>`POST /known-issues/retire` | `known-issues review`<br>`known-issues renew`<br>`known-issues retire` | `webscout_meta.friction` | `GET /known-issues/review` |
| friction-prune _(friction)_ | `POST /friction/prune` | `friction prune` | `webscout_meta.friction` | `POST /friction/prune` |
| known-issues _(friction)_ | `POST /known-issues/promote`<br>`GET /known-issues`<br>`POST /known-issues/import` | `known-issues promote`<br>`known-issues export`<br>`known-issues import` | `webscout_meta.friction` | `POST /known-issues/promote`<br>`GET /known-issues`<br>`POST /known-issues/import` |

## Why a surface is empty

- **config** - no CLI command: dashboard display settings, not something a caller scripts
- **ping** - no dashboard control: the dashboard shows liveness from /health and /agents
- **dashboard-page** - no dashboard control: it IS the dashboard
- **session-trace** - no dashboard control: trace export is a corpus-building step for a developer, run from "session end --trace"
- **session-cleanup** - no dashboard control: deleting rows a session wrote is a deliberate CLI step with a dry run
- **session-assert** - no dashboard control: assertions are evaluated by the agent driving the page
- **crv** - no dashboard control: a CRV pass is driven by an agent; its outcome shows in the session views
