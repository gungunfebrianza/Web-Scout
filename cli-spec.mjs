// Declarative spec of every CLI command: how many positional args it takes,
// which flags it understands, and which MCP tool action (if any) mirrors it.
// Three things read this:
//   1. cli.mjs's validateArgs() - rejects an unknown flag or an extra
//      positional BEFORE dispatch. A silently ignored argument was a real bug:
//      `token-report --session 206` dropped the flag and returned the
//      all-time report; a typo'd `--dryrun` on `idb put` would have WRITTEN.
//   2. cli-parity.test.mjs - every command has an MCP action or an explicit
//      exemption, and every flag maps to an MCP param or is declared CLI-only.
//   3. docs-drift.test.mjs - every command appears in usage.txt and README.md.
//
// pos: [min, max] positional args after the command path (flags excluded).
// bool / val: flags without / with a value. `--agent` is universal for
// page-dispatched commands and is never parity-checked.
// mcp: 'tool.action' | null. mcpExempt (required when mcp is null): why.
// params: { '--flag': 'mcpParamName' }. cliOnly: { '--flag': 'why' }.
// lenient: true = an unknown --flag is treated as data (eval's expression).

// Reply shaping every cacheable read accepts (see read-pipeline.mjs): rows as
// {columns, rows}, a pointer/delta instead of a repeat body, a shape-only peek, and
// the override for the session-budget guard.
const SHAPE_BOOL = ['--table', '--if-changed', '--delta', '--peek', '--no-guard'];
const SHAPE_PARAMS = { '--table': 'table', '--if-changed': 'ifChanged', '--delta': 'delta', '--peek': 'peek', '--no-guard': 'noGuard' };

const NOMCP_PROCESS = 'process control of the relay itself - not something an MCP tool call should be able to do to its own backend';

export const CLI_SPEC = [
  { cmd: 'help', pos: [0, 2], mcp: null, mcpExempt: 'slices usage.txt for a CLI caller; an MCP caller already has each action documented in its tool description' },
  { cmd: 'status', pos: [0, 0], mcp: 'webscout_meta.status' },
  { cmd: 'agents', pos: [0, 0], mcp: 'webscout_meta.agents' },
  { cmd: 'ping', pos: [0, 0], val: ['--agent'], mcp: 'webscout_meta.ping' },
  { cmd: 'dashboard', pos: [0, 0], mcp: 'webscout_meta.dashboard_url' },
  { cmd: 'analytics', pos: [0, 0], mcp: 'webscout_meta.analytics' },
  { cmd: 'search', pos: [1, Infinity], mcp: 'webscout_meta.search' },
  { cmd: 'token-report', pos: [0, 0], val: ['--session'], mcp: 'webscout_meta.token_report', params: { '--session': 'sessionId' } },
  { cmd: 'ask', pos: [1, Infinity], val: ['--session', '--agent'], mcp: 'webscout_session.ask', params: { '--session': 'sessionId' } },
  { cmd: 'db version-check', pos: [0, 0], val: ['--agent'], mcp: 'webscout_meta.db_version_check' },

  { cmd: 'relay start', pos: [0, 0], mcp: null, mcpExempt: NOMCP_PROCESS },
  { cmd: 'relay stop', pos: [0, 0], mcp: null, mcpExempt: NOMCP_PROCESS },
  { cmd: 'relay restart', pos: [0, 0], mcp: null, mcpExempt: NOMCP_PROCESS },
  { cmd: 'relay status', pos: [0, 0], mcp: null, mcpExempt: NOMCP_PROCESS },

  {
    cmd: 'session start', pos: [1, 2], bool: ['--strict-crv', '--auto-snapshot', '--no-briefing', '--lean', '--crv-compact'], val: ['--tags', '--stores', '--token-budget', '--agent'],
    mcp: 'webscout_session.start',
    params: { '--strict-crv': 'strictCrv', '--stores': 'strictCrvStores', '--tags': 'tags', '--token-budget': 'tokenBudget', '--no-briefing': 'noBriefing', '--lean': 'lean', '--crv-compact': 'crvCompact' },
    cliOnly: { '--auto-snapshot': 'convenience wrapper - an MCP caller takes an explicit webscout_idb snapshot action' },
  },
  { cmd: 'session end', pos: [0, 1], bool: ['--trace'], mcp: 'webscout_session.end', params: { '--trace': 'trace' } },
  { cmd: 'session current', pos: [0, 0], mcp: 'webscout_session.current' },
  { cmd: 'session list', pos: [0, 0], mcp: 'webscout_session.list' },
  { cmd: 'session show', pos: [1, 1], mcp: 'webscout_session.show' },
  {
    cmd: 'session report', pos: [1, 1], val: ['--format', '--out', '--verity'], mcp: 'webscout_session.report',
    params: { '--format': 'format', '--out': 'out', '--verity': 'verityPath' },
  },
  {
    cmd: 'session cleanup', pos: [1, 1], bool: ['--confirm', '--summary'], val: ['--since-snapshot'], mcp: 'webscout_session.cleanup',
    params: { '--confirm': 'confirm', '--summary': 'summary', '--since-snapshot': 'sinceSnapshotId' },
  },
  { cmd: 'session assert', pos: [2, 2], val: ['--agent'], mcp: 'webscout_session.assert' },
  {
    cmd: 'session intents', pos: [1, 1], val: ['--transcript', '--format'], mcp: null,
    mcpExempt: 'reads the calling agent\'s own transcript file off disk after the fact - an agent already knows why it acted, and an MCP tool that took a transcript path would only be a way to make it read one',
  },
  { cmd: 'verity import', pos: [2, 2], val: ['--label'], mcp: 'webscout_session.verity_import', params: { '--label': 'label' } },

  {
    cmd: 'dom query', pos: [0, 1], bool: ['--full', '--meta', ...SHAPE_BOOL], val: ['--pick', '--selector-file', '--agent'], mcp: 'webscout_dom.query',
    params: { '--full': 'full', '--meta': 'meta', '--pick': 'pick', ...SHAPE_PARAMS }, cliOnly: { '--selector-file': 'shell-quoting workaround - an MCP caller passes the selector as a JSON string' },
  },
  { cmd: 'dom click', pos: [0, 1], val: ['--nth', '--selector-file', '--agent'], mcp: 'webscout_dom.click', params: { '--nth': 'nth' }, cliOnly: { '--selector-file': 'shell-quoting workaround' } },
  { cmd: 'dom fill', pos: [1, 2], val: ['--nth', '--selector-file', '--agent'], mcp: 'webscout_dom.fill', params: { '--nth': 'nth' }, cliOnly: { '--selector-file': 'shell-quoting workaround' } },
  { cmd: 'dom rect', pos: [0, 1], bool: SHAPE_BOOL, val: ['--selector-file', '--agent'], mcp: 'webscout_dom.rect', params: SHAPE_PARAMS, cliOnly: { '--selector-file': 'shell-quoting workaround' } },
  { cmd: 'react inspect', pos: [0, 1], bool: SHAPE_BOOL, val: ['--nth', '--pick', '--selector-file', '--agent'], mcp: 'webscout_react.inspect', params: { '--nth': 'nth', '--pick': 'pick', ...SHAPE_PARAMS }, cliOnly: { '--selector-file': 'shell-quoting workaround' } },
  { cmd: 'react tree', pos: [0, 2], bool: SHAPE_BOOL, val: ['--nth', '--selector-file', '--agent'], mcp: 'webscout_react.tree', params: { '--nth': 'nth', ...SHAPE_PARAMS }, cliOnly: { '--selector-file': 'shell-quoting workaround' } },
  { cmd: 'dom style', pos: [0, 2], bool: SHAPE_BOOL, val: ['--selector-file', '--agent'], mcp: 'webscout_dom.style', params: SHAPE_PARAMS, cliOnly: { '--selector-file': 'shell-quoting workaround' } },
  {
    cmd: 'dom wait', pos: [0, 1], bool: ['--changed', '--stable'], val: ['--text', '--timeout', '--stable-count', '--selector-file', '--agent'], mcp: 'webscout_dom.wait',
    params: { '--changed': 'changed', '--stable': 'stable', '--text': 'text', '--timeout': 'timeoutMs', '--stable-count': 'stableCount' }, cliOnly: { '--selector-file': 'shell-quoting workaround' },
  },
  {
    cmd: 'dom click-wait', pos: [0, 1], bool: ['--changed', '--stable'], val: ['--wait-selector', '--text', '--timeout', '--stable-count', '--nth', '--selector-file', '--agent'], mcp: 'webscout_dom.click_wait',
    params: { '--changed': 'changed', '--stable': 'stable', '--wait-selector': 'waitSelector', '--text': 'text', '--timeout': 'timeoutMs', '--stable-count': 'stableCount', '--nth': 'nth' }, cliOnly: { '--selector-file': 'shell-quoting workaround' },
  },
  { cmd: 'dom pick', pos: [0, 0], val: ['--timeout', '--agent'], mcp: 'webscout_dom.pick', params: { '--timeout': 'timeoutMs' } },
  { cmd: 'dom settle', pos: [0, 1], val: ['--quiet-ms', '--timeout', '--agent'], mcp: 'webscout_dom.settle', params: { '--quiet-ms': 'quietMs', '--timeout': 'timeoutMs' } },
  { cmd: 'dom screenshot', pos: [0, 1], val: ['--out', '--agent'], mcp: 'webscout_dom.screenshot', params: { '--out': 'outPath' } },

  { cmd: 'idb list', pos: [0, 0], bool: ['--non-empty', ...SHAPE_BOOL], val: ['--stores', '--agent'], mcp: 'webscout_idb.list', params: { '--stores': 'stores', '--non-empty': 'nonEmpty', ...SHAPE_PARAMS } },
  { cmd: 'idb dump', pos: [1, 1], bool: ['--count', ...SHAPE_BOOL], val: ['--where', '--fields', '--limit', '--agent'], mcp: 'webscout_idb.dump', params: { '--where': 'where', '--fields': 'fields', '--limit': 'limit', '--count': 'countOnly', ...SHAPE_PARAMS } },
  { cmd: 'idb get', pos: [2, 2], bool: SHAPE_BOOL, val: ['--fields', '--agent'], mcp: 'webscout_idb.get', params: { '--fields': 'fields', ...SHAPE_PARAMS } },
  {
    cmd: 'idb snapshot', pos: [0, 0], val: ['--stores', '--where', '--golden', '--since', '--agent'], mcp: 'webscout_idb.snapshot',
    params: { '--stores': 'stores', '--where': 'where', '--golden': 'golden', '--since': 'since' },
  },
  {
    cmd: 'idb verify', pos: [0, 1], bool: ['--allow-extra', '--verbose'], val: ['--stores', '--expect', '--expect-file', '--samples', '--agent'], mcp: 'webscout_idb.verify',
    params: { '--stores': 'stores', '--expect': 'expect', '--allow-extra': 'allowExtra', '--samples': 'samples', '--verbose': 'verbose' },
    cliOnly: { '--expect-file': 'shell-quoting workaround - an MCP caller passes expect inline as a string or JSON' },
  },
  {
    cmd: 'crv run', pos: [0, 0], bool: ['--allow-extra', '--verbose'], val: ['--stores', '--type', '--params', '--expect', '--expect-file', '--samples', '--agent'], mcp: 'webscout_idb.crv_run',
    params: { '--stores': 'stores', '--type': 'type', '--params': 'params', '--expect': 'expect', '--allow-extra': 'allowExtra', '--samples': 'samples', '--verbose': 'verbose' },
    cliOnly: { '--expect-file': 'shell-quoting workaround - an MCP caller passes expect inline as a string or JSON' },
  },
  { cmd: 'idb diff', pos: [2, 2], mcp: 'webscout_idb.diff' },
  { cmd: 'idb diff-golden', pos: [2, 2], mcp: 'webscout_idb.diff_golden' },
  { cmd: 'idb restore', pos: [0, 1], val: ['--golden', '--agent'], mcp: 'webscout_idb.restore', params: { '--golden': 'golden' } },
  { cmd: 'idb put', pos: [2, 2], bool: ['--dry-run'], val: ['--agent'], mcp: 'webscout_idb.put', params: { '--dry-run': 'dryRun' } },
  { cmd: 'idb put-many', pos: [2, 2], bool: ['--dry-run'], val: ['--agent'], mcp: 'webscout_idb.put_many', params: { '--dry-run': 'dryRun' } },
  { cmd: 'idb patch', pos: [3, 3], val: ['--agent'], mcp: 'webscout_idb.patch' },
  { cmd: 'idb delete', pos: [2, 2], val: ['--agent'], mcp: 'webscout_idb.delete' },
  { cmd: 'idb delete-many', pos: [2, 2], val: ['--agent'], mcp: 'webscout_idb.delete_many' },
  { cmd: 'idb clear', pos: [1, 1], val: ['--agent'], mcp: 'webscout_idb.clear' },
  { cmd: 'idb wait', pos: [1, 1], val: ['--count-gte', '--timeout', '--agent'], mcp: 'webscout_idb.wait', params: { '--count-gte': 'countGte', '--timeout': 'timeoutMs' } },
  { cmd: 'idb watch', pos: [1, 1], val: ['--count-gte', '--timeout', '--agent'], mcp: null, mcpExempt: 'an indefinite streaming poll with no single request/response mapping - MCP callers use "idb wait" for a bounded check' },

  { cmd: 'net log', pos: [0, 0], bool: ['--failed', ...SHAPE_BOOL], val: ['--limit', '--url', '--fields', '--agent'], mcp: 'webscout_net.log', params: { '--limit': 'limit', '--url': 'urlContains', '--fields': 'fields', '--failed': 'failed', ...SHAPE_PARAMS } },
  { cmd: 'net wait', pos: [1, 1], val: ['--timeout', '--grace', '--agent'], mcp: 'webscout_net.wait', params: { '--timeout': 'timeoutMs', '--grace': 'graceMs' } },
  {
    cmd: 'net history', pos: [0, 0], val: ['--filter', '--min-duration', '--sort', '--limit', '--session'], mcp: 'webscout_net.history',
    params: { '--filter': 'filter', '--min-duration': 'minDuration', '--sort': 'sort', '--limit': 'limit', '--session': 'sessionId' },
  },
  { cmd: 'net capture', pos: [0, 1], bool: ['--off'], val: ['--agent'], mcp: 'webscout_net.capture', params: { '--off': 'off' } },
  { cmd: 'net clear', pos: [0, 0], val: ['--agent'], mcp: 'webscout_net.clear' },
  { cmd: 'console log', pos: [0, 0], bool: SHAPE_BOOL, val: ['--limit', '--level', '--contains', '--fields', '--agent'], mcp: 'webscout_console.log', params: { '--limit': 'limit', '--level': 'level', '--contains': 'contains', '--fields': 'fields', ...SHAPE_PARAMS } },
  { cmd: 'console wait', pos: [1, 1], val: ['--timeout', '--grace', '--agent'], mcp: 'webscout_console.wait', params: { '--timeout': 'timeoutMs', '--grace': 'graceMs' } },
  { cmd: 'console clear', pos: [0, 0], val: ['--agent'], mcp: 'webscout_console.clear' },

  { cmd: 'debug state', pos: [0, 0], val: ['--agent'], mcp: 'webscout_meta.debug_state' },
  { cmd: 'debug sweep', pos: [1, 1], mcp: null, mcpExempt: 'greps the CLI process\'s own working directory for a leftover debug tag - the MCP server has no stable cwd contract' },
  { cmd: 'dev bump-reload', pos: [1, 1], bool: ['--no-reload'], val: ['--agent'], mcp: null, mcpExempt: 'walks and rewrites files under the CLI\'s working directory - the MCP server has no stable cwd contract' },

  { cmd: 'page reload', pos: [0, 0], bool: ['--hard', '--wait-reconnect'], val: ['--timeout', '--agent'], mcp: 'webscout_page.reload', params: { '--hard': 'hard', '--wait-reconnect': 'waitReconnect', '--timeout': 'timeoutMs' } },
  { cmd: 'page fresh', pos: [1, 1], val: ['--url', '--agent'], mcp: 'webscout_page.fresh', params: { '--url': 'urlPath' } },
  { cmd: 'eval', pos: [0, Infinity], val: ['--file', '--timeout', '--agent'], lenient: true, mcp: 'webscout_eval', params: { '--file': 'filePath', '--timeout': 'timeoutMs' } },

  { cmd: 'macro record', pos: [2, 2], bool: ['--all'], mcp: 'webscout_macro.record', params: { '--all': 'all' } },
  { cmd: 'macro list', pos: [0, 0], mcp: 'webscout_macro.list' },
  { cmd: 'macro show', pos: [1, 1], mcp: 'webscout_macro.show' },
  {
    cmd: 'macro run', pos: [1, 1], bool: ['--continue-on-error', '--confirm', '--full'], val: ['--from-step'], mcp: 'webscout_macro.run',
    params: { '--continue-on-error': 'continueOnError', '--confirm': 'confirm', '--full': 'full', '--from-step': 'fromStep' },
  },
  { cmd: 'macro delete', pos: [1, 1], mcp: 'webscout_macro.delete' },
  { cmd: 'macro export-verity', pos: [1, 1], val: ['--out'], mcp: 'webscout_macro.export_verity', params: { '--out': 'outPath' } },
  { cmd: 'suite run', pos: [1, 1], bool: ['--continue-on-error'], mcp: 'webscout_suite.run', params: { '--continue-on-error': 'continueOnError' } },
];

// Output formatting, accepted by every command and never sent to the relay.
export const UNIVERSAL_BOOL = new Set(['--pretty']);

const BY_CMD = new Map(CLI_SPEC.map((s) => [s.cmd, s]));

// Longest match first: "dom click-wait" before "dom click" is not an issue
// (exact string match), but "eval"/"status" are one token and "dom query" two.
export function findSpec(command, rest) {
  return BY_CMD.get(`${command} ${rest[0] ?? ''}`.trim()) ?? BY_CMD.get(command) ?? null;
}

// Returns null when the arguments are acceptable, else a one-line error.
export function validateArgs(command, rest) {
  const spec = findSpec(command, rest);
  if (!spec) return null; // unknown command - the dispatcher's own "Unknown command" path reports it
  const nameTokens = spec.cmd.split(' ').length;
  const args = rest.slice(nameTokens - 1);
  const bool = new Set(spec.bool ?? []);
  const val = new Set(spec.val ?? []);
  const positional = [];
  const unknown = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (bool.has(a) || UNIVERSAL_BOOL.has(a)) continue;
    if (val.has(a)) { i += 1; continue; }
    // Only a bare --word counts as a flag: a fill value like "-- Choose --" (has spaces) is data.
    if (!spec.lenient && /^--[a-z][a-z0-9-]*$/i.test(a)) unknown.push(a);
    else positional.push(a);
  }
  const known = [...bool, ...val];
  if (unknown.length) {
    return `'${spec.cmd}' does not take ${unknown.join(', ')}${known.length ? ` (valid flags: ${known.join(', ')})` : ' (it takes no flags)'} - nothing was run.`;
  }
  const [, max] = spec.pos;
  if (positional.length > max) {
    const extra = positional.slice(max);
    return `'${spec.cmd}' got ${positional.length} positional argument(s) but takes at most ${max} - extra: ${extra.map((e) => JSON.stringify(e)).join(', ')}. Quote a multi-word value, or check for a flag spelled without its leading "--". Nothing was run.`;
  }
  return null;
}

// Git Bash on Windows rewrites an argument that starts with "/" into a Windows
// path (`net wait /api/save` arrives as `C:/Program Files/Git/api/save`), so the
// command silently matches nothing. Returns the mangled args, empty if none.
export function findMsysMangledArgs(args) {
  return args.filter((a) => /^[A-Za-z]:[\/]Program Files[\/]Git[\/]/.test(a));
}
