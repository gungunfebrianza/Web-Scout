// Web-scout ask-AI - Node-side reimplementation of
// js/capital-cognitive-provider-ai-council.js's invokeCognitiveModel
// contract (same request/response/error shape, same 30s timeout), since
// that file is browser-only and this runs in a Node process. The backend
// route (/api/cfi/cognitive/analyze) is a thin, schema-agnostic passthrough
// - any {system_prompt, user_prompt} pair of strings is accepted, so this
// completely unrelated dev-tool feature can safely reuse it with its own
// custom prompts.
//
// The backend's actual host:port is NOT fixed anywhere in this repo's code
// (README documents --port 8000 as a default; a live dev instance may run
// on a different port) - always configurable via WEBSCOUT_AI_BACKEND_URL,
// never hardcoded.

export const DEFAULT_BACKEND_URL = 'http://127.0.0.1:8000/api/cfi/cognitive/analyze';
const TIMEOUT_MS = 30000;

const MAX_ACTIONS = 20;
const MAX_FIELD_CHARS = 800;
const MAX_DIFF_JSON_CHARS = 4000;
const MAX_TOTAL_PROMPT_CHARS = 12000;

function truncate(str, max) {
  if (str == null) return str;
  const s = typeof str === 'string' ? str : JSON.stringify(str);
  if (s.length <= max) return s;
  return `${s.slice(0, max)}...[truncated, ${s.length - max} more chars]`;
}

const SYSTEM_PROMPT = `You are helping a developer understand what happened during a local browser-instrumentation session called "Web-scout". Every observation and mutation was made through a deterministic tool, never invented - you are explaining REAL recorded evidence, not guessing.

You will be given, as JSON in the user message: the session's stated goal and context, a chronological list of recorded actions (each with its type, parameters, and result), a list of IndexedDB state snapshots (row counts per store, not full dumps), a list of state diffs between two snapshots (added/removed/changed rows per store), and the developer's question.

Frame your answer explicitly in these terms: GOAL (what the session was trying to establish) -> ACTIONS (what was actually done, in order) -> BEFORE/AFTER STATE (what the snapshots show) -> DIFF (what concretely changed, per store). Never claim a mutation happened unless a diff or snapshot in the supplied evidence actually shows it. If the supplied evidence does not answer the question, say so plainly rather than speculating.

Respond in plain prose, not JSON.`;

// Builds the user_prompt payload, applying the truncation/size caps
// described in tools/web-scout/README.md, so a long session's action log
// can never blow past the backend's context budget.
function buildUserPrompt({ session, actions, snapshots, diffs, question }) {
  // actions arrives most-recent-first (DB default order); take the most
  // recent MAX_ACTIONS, then present them chronologically (oldest first)
  // since that reads naturally as a narrative.
  let actionSlice = actions.slice(0, MAX_ACTIONS).slice().reverse();

  const buildPayload = () => ({
    goal: session.goal,
    context: session.context,
    actions: actionSlice.map((a) => ({
      id: a.id, type: a.type, ok: !!a.ok, error: a.error,
      params: truncate(a.params, MAX_FIELD_CHARS),
      result: truncate(a.result, MAX_FIELD_CHARS),
      started_at: a.started_at, duration_ms: a.duration_ms,
    })),
    snapshots: snapshots.map((s) => ({ id: s.id, taken_at: s.taken_at, counts: s.counts, byte_size: s.byte_size })),
    diffs: diffs.map((d) => {
      const summaryOnly = { id: d.id, from_snapshot_id: d.snapshot_from_id, to_snapshot_id: d.snapshot_to_id, computed_at: d.computed_at, summary: d.summary };
      if (d.diff !== undefined) {
        const diffStr = JSON.stringify(d.diff);
        if (diffStr.length < MAX_DIFF_JSON_CHARS) return { ...summaryOnly, diff: d.diff };
        return { ...summaryOnly, diff_omitted: `full diff is ${diffStr.length} chars - see the dashboard for detail` };
      }
      return summaryOnly;
    }),
    question,
  });

  let payload = buildPayload();
  let serialized = JSON.stringify(payload);
  while (serialized.length > MAX_TOTAL_PROMPT_CHARS && actionSlice.length > 0) {
    actionSlice = actionSlice.slice(1); // drop oldest first
    payload = buildPayload();
    serialized = JSON.stringify(payload);
  }
  return serialized;
}

export function buildPrompt({ session, actions, snapshots, diffs, question }) {
  return {
    system_prompt: SYSTEM_PROMPT,
    user_prompt: buildUserPrompt({ session, actions, snapshots, diffs, question }),
  };
}

export async function askAI({ system_prompt, user_prompt }) {
  const backendUrl = process.env.WEBSCOUT_AI_BACKEND_URL || DEFAULT_BACKEND_URL;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(backendUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ system_prompt, user_prompt }),
      signal: controller.signal,
    });
  } catch (err) {
    throw new Error(err?.name === 'AbortError' ? 'AI backend request timed out.' : `AI backend unreachable at ${backendUrl}: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    throw new Error(`AI backend returned HTTP ${res.status}.`);
  }
  const body = await res.json();
  if (body.status === 'error') {
    throw new Error(body.error || 'AI backend reported an error.');
  }
  return body.text;
}
