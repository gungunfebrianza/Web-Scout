// One map of every capability across the four ways to reach it: the HTTP route, the CLI command(s) (whose
// MCP action comes from cli-spec.mjs - CLI and MCP are already kept in lockstep by cli-parity.test.mjs),
// and the dashboard. surfaces.test.mjs reads this and fails when:
//   - a relay route is claimed by no capability (add it here, or to INTERNAL_ROUTES with a reason),
//   - a claim names a route / CLI command / dashboard call that does not exist,
//   - a capability leaves a surface empty without saying why (`why` strings are the review trail),
//   - a capability marked family:'friction' is missing any surface at all.
// Adding a feature therefore forces the question "and where does the person reach it from?" at test time
// instead of three rounds later.
//
// Route strings are "METHOD /path" with :n for a numeric segment, exactly as the relay's patterns read.
// `dashboard` lists the routes the dashboard actually calls for the capability.

export const SURFACES = [
  { id: 'health', http: ['GET /health'], cli: ['status'], dashboard: ['GET /health'] },
  { id: 'config', http: ['GET /config', 'PUT /config'], cli: null, cliWhy: 'dashboard display settings, not something a caller scripts', dashboard: ['GET /config', 'PUT /config'] },
  { id: 'agents', http: ['GET /agents'], cli: ['agents'], dashboard: ['GET /agents'] },
  { id: 'ping', http: ['POST /ping'], cli: ['ping'], dashboard: null, dashboardWhy: 'the dashboard shows liveness from /health and /agents' },
  { id: 'dashboard-page', http: ['GET /dashboard'], cli: ['dashboard'], dashboard: null, dashboardWhy: 'it IS the dashboard' },
  { id: 'ask', http: ['POST /ask'], cli: ['ask'], dashboard: ['POST /ask'] },
  { id: 'search', http: ['GET /search'], cli: ['search'], dashboard: ['GET /search'] },

  { id: 'session-lifecycle', http: ['POST /sessions', 'POST /sessions/:n/end', 'GET /sessions', 'GET /sessions/:n'], cli: ['session start', 'session end', 'session current', 'session list', 'session show'], dashboard: ['POST /sessions/:n/end', 'GET /sessions', 'GET /sessions/:n'] },
  { id: 'session-trace', http: ['POST /sessions/:n/trace'], cli: ['session end'], dashboard: null, dashboardWhy: 'trace export is a corpus-building step for a developer, run from "session end --trace"' },
  { id: 'session-actions', http: ['GET /sessions/:n/actions', 'GET /sessions/:n/actions/:n'], cli: ['session show'], dashboard: ['GET /sessions/:n/actions', 'GET /sessions/:n/actions/:n'] },
  { id: 'session-evidence', http: ['GET /sessions/:n/snapshots', 'GET /sessions/:n/diffs', 'GET /state/snapshots/:n', 'GET /state/diffs/:n', 'GET /sessions/:n/console', 'GET /sessions/:n/net', 'GET /sessions/:n/qa'], cli: ['session show'], dashboard: ['GET /sessions/:n/snapshots', 'GET /sessions/:n/diffs', 'GET /state/snapshots/:n', 'GET /state/diffs/:n', 'GET /sessions/:n/console', 'GET /sessions/:n/net', 'GET /sessions/:n/qa'] },
  { id: 'session-report', http: ['GET /sessions/:n/report'], cli: ['session report'], dashboard: ['GET /sessions/:n/report'] },
  { id: 'session-viz', http: ['GET /sessions/:n/viz'], cli: ['session viz'], dashboard: ['GET /sessions/:n/viz'] },
  { id: 'session-intents', http: ['POST /sessions/:n/intents/import'], cli: ['session intents'], dashboard: ['POST /sessions/:n/intents/import'] },
  { id: 'session-cleanup', http: ['POST /sessions/:n/cleanup'], cli: ['session cleanup'], dashboard: null, dashboardWhy: 'deleting rows a session wrote is a deliberate CLI step with a dry run' },
  { id: 'session-assert', http: ['POST /sessions/:n/assert'], cli: ['session assert'], dashboard: null, dashboardWhy: 'assertions are evaluated by the agent driving the page' },
  { id: 'session-replay', http: ['POST /sessions/:n/replay'], cli: ['session replay'], dashboard: ['POST /sessions/:n/replay'] },
  { id: 'token-report', http: ['GET /sessions/:n/token-report', 'GET /token-report'], cli: ['token-report'], dashboard: ['GET /sessions/:n/token-report', 'GET /token-report'] },

  { id: 'verity', http: ['GET /sessions/:n/verity-runs', 'GET /verity-runs/:n', 'POST /verity/import'], cli: ['verity import', 'verity history', 'verity show'], dashboard: ['GET /sessions/:n/verity-runs', 'GET /verity-runs/:n', 'POST /verity/import'] },
  { id: 'macros', http: ['POST /macros', 'GET /macros', 'GET /macros/:n', 'PUT /macros/:n/steps', 'DELETE /macros/:n', 'POST /macros/:n/run'], cli: ['macro record', 'macro list', 'macro show', 'macro update', 'macro delete', 'macro run'], dashboard: ['POST /macros', 'GET /macros', 'PUT /macros/:n/steps', 'DELETE /macros/:n', 'POST /macros/:n/run'] },
  { id: 'command', http: ['POST /command'], cli: ['dom query', 'dom click', 'dom fill', 'idb dump', 'net log', 'console log', 'eval', 'page reload'], dashboard: ['POST /command'] },
  { id: 'state', http: ['POST /state/snapshot', 'POST /state/diff', 'POST /state/verify', 'POST /state/restore'], cli: ['idb snapshot', 'idb diff', 'idb diff-golden', 'idb verify', 'idb restore'], dashboard: ['POST /state/snapshot', 'POST /state/diff'] },
  { id: 'crv', http: ['POST /crv/preflight', 'POST /crv/run'], cli: ['crv preflight', 'crv run'], dashboard: null, dashboardWhy: 'a CRV pass is driven by an agent; its outcome shows in the session views' },
  { id: 'repair', http: ['GET /repair/config', 'PUT /repair/config', 'GET /repair/activity', 'GET /repair/causal-diff', 'POST /repair/patch', 'POST /repair/verify'], cli: ['repair status', 'repair enable', 'repair disable', 'repair patch', 'repair verify', 'repair causal-diff'], dashboard: ['GET /repair/config', 'PUT /repair/config', 'GET /repair/activity', 'GET /repair/causal-diff'] },
  { id: 'surfacemap', http: null, httpWhy: 'a maintainer tool run on the checkout, not served by the relay', cli: ['surfacemap build', 'surfacemap check', 'surfacemap serve'], dashboard: null, dashboardWhy: 'it is a separate page (docs/surfacemap.html), generated from the code' },
  { id: 'host', http: ['GET /host/health', 'GET /host/trend', 'GET /host/sessions', 'GET /host/footprint', 'GET /host/test-run', 'POST /host/cleanup', 'POST /host/kill-orphans'], cli: ['scratch status', 'scratch cleanup'], dashboard: ['GET /host/health', 'POST /host/cleanup', 'POST /host/kill-orphans'] },
  { id: 'analytics', http: ['GET /analytics'], cli: ['analytics'], dashboard: ['GET /analytics'] },

  // ---- friction awareness: every capability reachable from all four ----
  { id: 'friction-resolve', family: 'friction', http: ['POST /friction/resolve', 'POST /friction/unresolve', 'GET /friction/resolutions'], cli: ['friction resolve', 'friction unresolve', 'friction list'], dashboard: ['POST /friction/resolve', 'POST /friction/unresolve'] },
  { id: 'friction-explain', family: 'friction', http: ['GET /friction/explain'], cli: ['friction explain'], dashboard: ['GET /friction/explain'] },
  { id: 'friction-session', family: 'friction', http: ['GET /friction/session'], cli: ['friction session'], dashboard: ['GET /friction/session'] },
  { id: 'friction-config', family: 'friction', http: ['GET /friction/config'], cli: ['friction config'], dashboard: ['GET /friction/config'] },
  { id: 'friction-targets', family: 'friction', http: ['GET /friction/targets'], cli: ['friction targets'], dashboard: ['GET /friction/targets'] },
  { id: 'friction-notices', family: 'friction', http: ['GET /friction/notices'], cli: ['friction notices', 'friction watch'], dashboard: ['GET /friction/notices'] },
  { id: 'friction-next', family: 'friction', http: ['GET /friction/next', 'POST /friction/next'], cli: ['friction next'], dashboard: ['POST /friction/next'] },
  { id: 'friction-trend', family: 'friction', http: ['GET /friction/trend'], cli: ['friction trend'], dashboard: ['GET /friction/trend'] },
  { id: 'friction-regressions', family: 'friction', http: ['GET /friction/regressions'], cli: ['friction regressions'], dashboard: ['GET /friction/regressions'] },
  { id: 'friction-snooze', family: 'friction', http: ['POST /friction/snooze', 'POST /friction/unsnooze', 'GET /friction/snoozes'], cli: ['friction snooze', 'friction unsnooze', 'friction snoozes'], dashboard: ['GET /friction/snoozes'] },
  { id: 'friction-check', family: 'friction', http: ['GET /friction/check'], cli: ['friction check'], dashboard: ['GET /friction/check'] },
  { id: 'friction-state', family: 'friction', http: ['GET /friction/export', 'POST /friction/import'], cli: ['friction export', 'friction import'], dashboard: ['GET /friction/export', 'POST /friction/import'] },
  { id: 'known-issues-review', family: 'friction', http: ['GET /known-issues/review', 'POST /known-issues/renew', 'POST /known-issues/retire'], cli: ['known-issues review', 'known-issues renew', 'known-issues retire'], dashboard: ['GET /known-issues/review'] },
  { id: 'friction-prune', family: 'friction', http: ['POST /friction/prune'], cli: ['friction prune'], dashboard: ['POST /friction/prune'] },
  { id: 'known-issues', family: 'friction', http: ['POST /known-issues/promote', 'GET /known-issues', 'POST /known-issues/import'], cli: ['known-issues promote', 'known-issues export', 'known-issues import'], dashboard: ['POST /known-issues/promote', 'GET /known-issues', 'POST /known-issues/import'] },
];

// Routes that are plumbing, not capabilities a person reaches.
export const INTERNAL_ROUTES = {
  'POST /help-used': 'usage telemetry the CLI posts when a caller reads help',
};

// ---- the map as a document ----
// docs/web-scout-capabilities.md is generated from SURFACES + cli-spec.mjs (the MCP action of a capability is the
// mcp field of its CLI commands), and surfaces.test.mjs fails when the file is out of date. Regenerate with
//   node surfaces.mjs --write
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLI_SPEC } from './cli-spec.mjs';

export const CAPABILITIES_DOC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'docs', 'web-scout-capabilities.md');

export function renderCapabilitiesMarkdown() {
  const cell = (list) => (list?.length ? list.map((x) => `\`${x}\``).join('<br>') : '-');
  const mcpOf = (s) => [...new Set((s.cli ?? []).map((c) => CLI_SPEC.find((r) => r.cmd === c)?.mcp).filter(Boolean))];
  const lines = [
    '# Capabilities and where each is reachable',
    '',
    'Generated from `surfaces.mjs` and `cli-spec.mjs` by `node surfaces.mjs --write`; `surfaces.test.mjs` fails when this file is stale.',
    'A `-` in the CLI or Dashboard column carries a reason in `surfaces.mjs` (`cliWhy` / `dashboardWhy`). MCP actions are those of the CLI commands.',
    '',
    '| Capability | HTTP | CLI | MCP | Dashboard |',
    '|---|---|---|---|---|',
  ];
  for (const s of SURFACES) {
    lines.push(`| ${s.id}${s.family ? ` _(${s.family})_` : ''} | ${cell(s.http)} | ${cell(s.cli)} | ${cell(mcpOf(s))} | ${cell(s.dashboard)} |`);
  }
  lines.push('');
  const why = SURFACES.filter((s) => s.cliWhy || s.dashboardWhy);
  if (why.length) {
    lines.push('## Why a surface is empty', '');
    for (const s of why) {
      if (s.cliWhy) lines.push(`- **${s.id}** - no CLI command: ${s.cliWhy}`);
      if (s.dashboardWhy) lines.push(`- **${s.id}** - no dashboard control: ${s.dashboardWhy}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

export const README_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'README.md');
export const REF_START = '<!-- command-reference:start (generated by `node surfaces.mjs --write`; do not edit by hand) -->';
export const REF_END = '<!-- command-reference:end -->';

// Every CLI command with its flags and the MCP action that mirrors it, straight from cli-spec.mjs. usage.txt keeps the
// prose; this is the list that cannot drift, because a test compares it with the spec.
export function renderCommandReference() {
  const flags = (r) => [...(r.bool ?? []), ...(r.val ?? []).map((f) => `${f} <v>`)];
  const lines = [REF_START, '', '| Command | Flags | MCP action |', '|---|---|---|'];
  for (const r of CLI_SPEC) {
    lines.push(`| \`${r.cmd}\` | ${flags(r).map((f) => `\`${f}\``).join(' ') || '-'} | ${r.mcp ? `\`${r.mcp}\`` : '-'} |`);
  }
  lines.push('', REF_END);
  return lines.join('\n');
}

// The README with its generated block (re)placed; the block lives under "## Command reference", before "## Learn more".
export function readmeWithReference(readme) {
  const block = renderCommandReference();
  const start = readme.indexOf(REF_START);
  const end = readme.indexOf(REF_END);
  if (start !== -1 && end > start) return readme.slice(0, start) + block + readme.slice(end + REF_END.length);
  return readme.replace('## Learn more', `## Command reference\n\nEvery command, its flags and the MCP action that mirrors it. \`usage.txt\` (or \`help <command>\`) explains each.\n\n${block}\n\n## Learn more`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv.includes('--write')) {
  fs.writeFileSync(CAPABILITIES_DOC, renderCapabilitiesMarkdown());
  console.log(`wrote ${CAPABILITIES_DOC}`);
  fs.writeFileSync(README_PATH, readmeWithReference(fs.readFileSync(README_PATH, 'utf8')));
  console.log(`wrote the command reference in ${README_PATH}`);
}
