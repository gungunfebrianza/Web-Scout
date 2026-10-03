// One shape for "something the agent was just told", whatever carried it. The relay used to speak through a
// dozen separate x-webscout-* headers, each formatted and worded differently by the CLI, the MCP server and
// the dashboard, and none of them said what to DO about it. A notice carries the message and the next steps,
// each written once as a CLI line, an MCP call and an HTTP request, so every surface can render the same
// thing and the person can act on it from where they are.
//
//   notice  = { kind, level, message, key?, next: [command] }
//   command = { label, cli, mcp: { tool, action, params }, http }
//
// Pure: no I/O, so relay, client, MCP server and dashboard share it and the contract tests can pin it.

const quote = (v) => `"${String(v).replace(/(["\\])/g, '\\$1')}"`;
const enc = encodeURIComponent;

export const NOTICE_KINDS = ['selector-risk', 'macro-match', 'friction-broadcast', 'recovered', 'nudge', 'regression', 'error'];

// ---- the commands a notice can point at ----

export function whyCommand(type, value) {
  return {
    label: 'why',
    cli: `friction explain ${type} ${quote(value)}`,
    mcp: { tool: 'webscout_meta', action: 'friction', params: { sub: 'explain', type, selector: value } },
    http: `GET /friction/explain?type=${enc(type)}&selector=${enc(value)}`,
  };
}

export function fixedCommand(type, value) {
  return {
    label: 'mark fixed',
    cli: `friction resolve ${type} ${quote(value)}`,
    mcp: { tool: 'webscout_meta', action: 'friction', params: { sub: 'resolve', type, selector: value } },
    http: 'POST /friction/resolve',
    body: { type, selector: value },
  };
}

export function macroRunCommand(id) {
  return {
    label: 'run it',
    cli: `macro run ${id}`,
    mcp: { tool: 'webscout_macro', action: 'run', params: { id } },
    http: `POST /macros/${id}/run`,
  };
}

export function macroRecordCommand(sessionId) {
  return {
    label: 'record it',
    cli: `macro record ${quote('<name>')} ${sessionId}`,
    mcp: { tool: 'webscout_macro', action: 'record', params: { name: '<name>', sessionId } },
    http: 'POST /macros',
    body: { name: '<name>', sessionId },
  };
}

export function trendCommand(type, value) {
  return {
    label: 'trend',
    cli: `friction trend ${type} ${quote(value)}`,
    mcp: { tool: 'webscout_meta', action: 'friction', params: { sub: 'trend', type, selector: value } },
    http: `GET /friction/trend?type=${enc(type)}&selector=${enc(value)}`,
  };
}

export function regressionsCommand() {
  return {
    label: 'see them',
    cli: 'friction regressions',
    mcp: { tool: 'webscout_meta', action: 'friction', params: { sub: 'regressions' } },
    http: 'GET /friction/regressions',
  };
}

export function makeNotice({ kind, level = 'info', message, key = null, next = [] }) {
  return { kind, level, message: String(message), ...(key ? { key: String(key) } : {}), next: next.filter(Boolean) };
}

// ---- errors: the same shape, so a refusal says what to do next on every surface ----
// A failed request used to carry only a sentence. errorNotice() recognises the refusals callers hit most and attaches
// the way out as a notice (kind 'error', key = a stable code), rendered like any other. Unrecognised errors get null.

const sessionStart = () => ({
  label: 'start a session',
  cli: `session start ${quote('<goal>')}`,
  mcp: { tool: 'webscout_session', action: 'start', params: { goal: '<goal>' } },
  http: 'POST /sessions',
  body: { goal: '<goal>', context: '<context>' },
});
const listCommand = (label, cli, tool, action, http) => ({ label, cli, mcp: { tool, action, params: {} }, http });

export function errorNotice({ status = 500, message = '' } = {}) {
  const text = String(message);
  const make = (code, next) => makeNotice({ kind: 'error', level: 'error', message: text, key: code, next });
  if (/^no active session|no session specified and no active session/.test(text)) return make('no-session', [sessionStart()]);
  if (/no web-scout agent named/.test(text)) return make('no-agent', [listCommand('see agents', 'agents', 'webscout_meta', 'agents', 'GET /agents'), listCommand('relay status', 'status', 'webscout_meta', 'status', 'GET /health')]);
  if (/was pinned to .* at "session start"/.test(text)) return make('origin-moved', [sessionStart(), listCommand('current session', 'session current', 'webscout_session', 'current', 'GET /sessions')]);
  if (/cross-context replay guard/.test(text)) return make('cross-context', [listCommand('see macros', 'macro list', 'webscout_macro', 'list', 'GET /macros'), listCommand('current session', 'session current', 'webscout_session', 'current', 'GET /sessions')]);
  if (status === 404 && /^no such session/.test(text)) return make('no-such-session', [listCommand('list sessions', 'session list', 'webscout_session', 'list', 'GET /sessions')]);
  if (status === 404 && /^no such macro/.test(text)) return make('no-such-macro', [listCommand('list macros', 'macro list', 'webscout_macro', 'list', 'GET /macros')]);
  return null;
}

// ---- rendering ----

export const mcpText = (m) => `${m.tool}.${m.action} ${JSON.stringify(m.params)}`;

// style: 'cli' (a command line) | 'mcp' (a tool call) | 'http' (a request line).
export function renderNotice(n, style = 'cli') {
  const steps = (n.next ?? []).map((c) => {
    const how = style === 'mcp' ? (c.mcp ? mcpText(c.mcp) : null) : style === 'http' ? c.http : c.cli;
    return how ? `${c.label}: ${how}` : null;
  }).filter(Boolean);
  return steps.length ? `${n.message} [${steps.join('; ')}]` : n.message;
}

// Just the steps, for appending to an existing sentence (an error message, a drawer).
export function renderSteps(n, style = 'cli') {
  return (n.next ?? []).map((c) => {
    const how = style === 'mcp' ? (c.mcp ? mcpText(c.mcp) : null) : style === 'http' ? c.http : c.cli;
    return how ? `${c.label}: ${how}` : null;
  }).filter(Boolean).join('; ');
}

// ---- running a step: the one place "METHOD /path" + body becomes a request ----
// `friction next`, the dashboard buttons and the MCP `next` sub all execute a notice's http step through this, so
// they agree on what is safe to run unasked: a GET runs, anything else needs confirm.

export function parseHttpStep(step) {
  const m = /^(GET|POST|PUT|DELETE)\s+(\/\S*)$/.exec(String(step?.http ?? '').trim());
  return m ? { method: m[1], path: m[2], body: step.body ?? {}, mutating: m[1] !== 'GET' } : null;
}

// ---- transport: one response header ----

export const NOTICES_HEADER = 'x-webscout-notices';
const HEADER_MAX = 6000; // well under a typical 8 KB header block; extra notices are dropped, never truncated mid-JSON

// Header values must be latin1/ASCII-safe: escape everything outside printable ASCII as \uXXXX inside the JSON.
export function serializeNotices(list) {
  const kept = [];
  let size = 2;
  for (const n of list ?? []) {
    const piece = JSON.stringify(n).replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
    if (size + piece.length + 1 > HEADER_MAX) break;
    kept.push(piece);
    size += piece.length + 1;
  }
  return `[${kept.join(',')}]`;
}

export function parseNotices(value) {
  if (!value) return [];
  try {
    const list = JSON.parse(value);
    return Array.isArray(list) ? list.filter((n) => n && typeof n.kind === 'string' && typeof n.message === 'string') : [];
  } catch { return []; }
}
