// Recovers "why did the agent run this" from the agent's own transcript, after the fact.
//
// A web-scout call carries no reasoning - it is `dom click .save`, nothing more - and asking the
// agent to type a reason on every call would spend output tokens on every action. But the agent
// already narrates ("checking the save wrote a row") in the turn that contains the call, and
// its tool host (Claude Code, Codex) already writes that turn to a JSONL transcript on disk.
// This module reads that file and lines each web-scout tool call up with the actions the relay
// logged while the call was in flight. Cost to the agent: zero tokens.
//
// Matching is by TIME, not by parsing the command: a tool call owns the window from its own
// timestamp to its result's, and any action the relay started inside that window belongs to it.
// That is what lets one CLI call that logs several actions (a strict-CRV click writes a before
// snapshot, the click, an after snapshot and a diff) share a single why.
//
// Claude Code's format is documented behaviour of its transcript; the Codex reader follows the
// rollout format as observed and is deliberately tolerant - a line it does not recognise is
// skipped, never an error.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const MAX_WHY_CHARS = 280;
// A call with no narration of its own inherits the agent's last words if it is at most this many
// tool calls after them ("let me check the store and the form", then two calls). Further out the
// note has stopped describing what is being done, so the call is left to the inferred why.
export const MAX_CARRY_CALLS = 2;
const MAX_TRANSCRIPT_BYTES = 200 * 1024 * 1024;
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

// The narration right before a call is usually one short sentence; when it is a paragraph, the end
// of it is the part that says what is about to happen.
export function condenseWhy(text, max = MAX_WHY_CHARS) {
  const paragraphs = String(text ?? '').replace(/\r\n/g, '\n').split(/\n\s*\n/).map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const s = paragraphs[paragraphs.length - 1] ?? '';
  if (s.length <= max) return s;
  const tail = s.slice(-max);
  const boundary = tail.search(/[.!?]\s+\S/);
  return boundary >= 0 && boundary < max * 0.5 ? tail.slice(boundary + 2).trim() : `…${tail.trimStart()}`;
}

// A web-scout invocation, or null. Two ways an agent reaches it: the CLI through a shell tool, or
// the MCP server's webscout_* tools. `sig` is the normalized text a call is matched against an
// action's type with ("dom click" and dom.click both normalize to "domclick").
function scoutInfo(tool, input) {
  if (/^mcp__/i.test(tool) || /^webscout_/i.test(tool)) {
    const family = /webscout_(\w+)/i.exec(tool)?.[1];
    if (!family) return null;
    const action = typeof input?.action === 'string' ? input.action : '';
    return { sig: norm(family + action), command: `${tool} ${action}`.trim() };
  }
  const raw = input?.command;
  const command = Array.isArray(raw) ? raw.join(' ') : (typeof raw === 'string' ? raw : '');
  if (command && /\bcli\.mjs\b/.test(command)) return { sig: norm(command), command: command.slice(0, 300) };
  return null;
}

// ---------------------------------------------------------------- parsing

export function parseTranscript(text, { format = 'auto' } = {}) {
  const calls = [];
  const byId = new Map();
  const streams = new Map();
  const stats = { lines: 0, unparsable: 0, toolCalls: 0, scoutCalls: 0, narrated: 0, carried: 0 };
  let detected = null;

  // `last` outlives a tool result (unlike `texts`, which is one turn's own narration): the most
  // recent thing the agent said and how many tool calls it has made since. It only dies with a real
  // user prompt - a new task says nothing about the old narration.
  const streamFor = (key) => {
    if (!streams.has(key)) streams.set(key, { texts: [], thinking: '', last: '', since: 0 });
    return streams.get(key);
  };
  const addCall = ({ callId, tool, input, at, stream }) => {
    stats.toolCalls += 1;
    const info = scoutInfo(tool, input);
    const atMs = Date.parse(at);
    const narration = stream.texts.length ? condenseWhy(stream.texts[stream.texts.length - 1]) : '';
    const carried = !narration && stream.last && stream.since <= MAX_CARRY_CALLS ? condenseWhy(stream.last) : '';
    const thinking = !narration && !carried && stream.thinking ? condenseWhy(stream.thinking) : '';
    stream.since += 1; // every tool call counts, not just web-scout ones: distance is in agent steps
    if (!info || !Number.isFinite(atMs)) return;
    stats.scoutCalls += 1;
    const why = narration || carried || thinking;
    if (why) stats.narrated += 1;
    if (carried) stats.carried += 1;
    const source = narration ? 'transcript' : (carried ? 'transcript-carried' : (thinking ? 'transcript-thinking' : null));
    const call = { callId: String(callId ?? `call-${calls.length}`), at: atMs, endAt: null, sig: info.sig, command: info.command, why, source };
    calls.push(call);
    byId.set(call.callId, call);
  };
  const closeCall = (callId, at) => {
    const call = byId.get(String(callId));
    const t = Date.parse(at);
    if (call && Number.isFinite(t)) call.endAt = t;
  };

  const consumeClaude = (obj) => {
    const stream = streamFor(obj.isSidechain ? (obj.agentId ?? 'side') : 'main');
    const content = obj.message?.content;
    const blocks = Array.isArray(content) ? content : (typeof content === 'string' ? [{ type: 'text', text: content }] : []);
    if (obj.type === 'assistant') {
      for (const b of blocks) {
        if (b?.type === 'text' && b.text?.trim()) { stream.texts.push(b.text); stream.last = b.text; stream.since = 0; }
        else if (b?.type === 'thinking' && b.thinking?.trim()) stream.thinking = b.thinking;
        else if (b?.type === 'tool_use') addCall({ callId: b.id, tool: String(b.name ?? ''), input: b.input, at: obj.timestamp, stream });
      }
    } else if (obj.type === 'user') {
      let onlyResults = blocks.length > 0;
      for (const b of blocks) { if (b?.type === 'tool_result') closeCall(b.tool_use_id, obj.timestamp); else onlyResults = false; }
      // A result ends the turn's own narration; only a real prompt also forgets what was said.
      stream.texts = [];
      stream.thinking = '';
      if (!onlyResults) { stream.last = ''; stream.since = 0; }
    }
  };

  const consumeCodex = (obj) => {
    const p = obj.payload ?? obj;
    const stream = streamFor('main');
    const t = p?.type;
    if (t === 'message') {
      if (p.role === 'assistant') {
        for (const b of Array.isArray(p.content) ? p.content : []) if ((b?.type === 'output_text' || b?.type === 'text') && b.text?.trim()) { stream.texts.push(b.text); stream.last = b.text; stream.since = 0; }
      } else if (p.role === 'user') { stream.texts = []; stream.thinking = ''; stream.last = ''; stream.since = 0; }
    } else if (t === 'reasoning') {
      const summary = (Array.isArray(p.summary) ? p.summary : []).map((s) => s?.text).filter(Boolean).join('\n\n');
      if (summary.trim()) stream.thinking = summary;
    } else if (t === 'function_call' || t === 'local_shell_call' || t === 'custom_tool_call') {
      let input = p.action ?? {};
      if (typeof p.arguments === 'string') { try { input = JSON.parse(p.arguments); } catch { input = { command: p.arguments }; } } else if (p.input && typeof p.input === 'string') input = { command: p.input };
      addCall({ callId: p.call_id ?? p.id, tool: String(p.name ?? 'shell'), input, at: obj.timestamp, stream });
    } else if (t === 'function_call_output' || t === 'custom_tool_call_output') {
      closeCall(p.call_id, obj.timestamp);
      stream.texts = [];
      stream.thinking = '';
    }
  };

  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim();
    if (!line || line[0] !== '{') continue;
    let obj;
    try { obj = JSON.parse(line); } catch { stats.unparsable += 1; continue; }
    stats.lines += 1;
    const kind = format !== 'auto' ? format : ((obj.message && (obj.type === 'assistant' || obj.type === 'user')) ? 'claude' : (obj.payload || obj.type === 'message' || obj.type === 'function_call' ? 'codex' : null));
    if (!kind) continue;
    detected ??= kind;
    if (kind === 'claude') consumeClaude(obj); else if (kind === 'codex') consumeCodex(obj);
  }
  return { format: detected, calls, stats };
}

// ---------------------------------------------------------------- matching

// Which call each action belongs to. `actions` are rows with id/type/started_at. Returns the
// items db.setActionIntents takes, plus how many actions had no call around them (the dashboard's
// own clicks, another agent, a call that was never narrated).
//
// An action always starts between its tool call's timestamp and that call's result, on the same
// machine's clock - so the tolerance is only for timestamp jitter. A wide one would let a call
// claim the neighbouring actions of an agent that fires calls in quick succession.
export function matchCallsToActions(calls, actions, { skewMs = 250, openWindowMs = 90_000 } = {}) {
  const usable = calls.filter((c) => c.why);
  const items = [];
  let unmatched = 0;
  for (const a of [...actions].sort((x, y) => x.id - y.id)) {
    const t = Date.parse(a.started_at);
    if (!Number.isFinite(t)) { unmatched += 1; continue; }
    const windowEnd = (c) => c.endAt ?? c.at + openWindowMs;
    const candidates = usable.filter((c) => t >= c.at - skewMs && t <= windowEnd(c) + skewMs);
    if (!candidates.length) { unmatched += 1; continue; }
    const typeSig = norm(a.type);
    const familySig = norm(String(a.type).split('.')[0]);
    // Parallel calls overlap in time; the command text says which one this action came from, and
    // a call whose window really contains the action beats one that only reaches it by tolerance.
    const score = (c) => (c.sig.includes(typeSig) ? 2 : (c.sig.includes(familySig) ? 1 : 0)) * 10 + (t >= c.at && t <= windowEnd(c) ? 5 : 0);
    const best = candidates.sort((x, y) => score(y) - score(x) || y.at - x.at)[0];
    items.push({ actionId: a.id, text: best.why, source: best.source, callId: best.callId });
  }
  return { items, unmatched };
}

// ---------------------------------------------------------------- discovery

function safeList(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

// Transcript files written since `sinceMs`, newest first. Claude Code keeps one JSONL per
// conversation under ~/.claude/projects/<project>/; Codex keeps one per run under
// ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl.
export function discoverTranscripts({ sinceMs = 0, homeDir = os.homedir(), limit = 6 } = {}) {
  const found = [];
  const consider = (file, kind) => {
    try {
      const st = fs.statSync(file);
      if (st.isFile() && st.mtimeMs >= sinceMs) found.push({ path: file, kind, mtimeMs: st.mtimeMs, bytes: st.size });
    } catch { /* vanished between listing and stat */ }
  };
  const claudeRoot = path.join(homeDir, '.claude', 'projects');
  for (const proj of safeList(claudeRoot)) {
    if (!proj.isDirectory()) continue;
    for (const f of safeList(path.join(claudeRoot, proj.name))) if (f.isFile() && f.name.endsWith('.jsonl')) consider(path.join(claudeRoot, proj.name, f.name), 'claude');
  }
  const walk = (dir, depth) => {
    for (const e of safeList(dir)) {
      const full = path.join(dir, e.name);
      if (e.isDirectory() && depth < 4) walk(full, depth + 1);
      else if (e.isFile() && /^rollout-.*\.jsonl$/.test(e.name)) consider(full, 'codex');
    }
  };
  walk(path.join(homeDir, '.codex', 'sessions'), 0);
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit);
}

export function readTranscriptFile(file) {
  if (!/\.jsonl$/i.test(file)) throw new Error(`not a .jsonl transcript: ${file}`);
  const st = fs.statSync(file);
  if (!st.isFile()) throw new Error(`not a file: ${file}`);
  if (st.size > MAX_TRANSCRIPT_BYTES) throw new Error(`transcript is ${(st.size / 1048576).toFixed(0)} MB - over the ${MAX_TRANSCRIPT_BYTES / 1048576} MB import limit`);
  return fs.readFileSync(file, 'utf8');
}

// One entry point for the relay: parse each source, match against the session's actions, and
// merge. An action already matched by an earlier (newer) source keeps that match.
export function importIntents({ actions, sources, format = 'auto' }) {
  const taken = new Set();
  const items = [];
  const transcripts = [];
  for (const src of sources) {
    const parsed = parseTranscript(src.text, { format: src.format ?? format });
    const { items: matched, unmatched } = matchCallsToActions(parsed.calls, actions.filter((a) => !taken.has(a.id)));
    for (const it of matched) { taken.add(it.actionId); items.push(it); }
    transcripts.push({ label: src.label, format: parsed.format, ...parsed.stats, matchedActions: matched.length, unmatchedActions: unmatched });
  }
  return { items, transcripts, unmatchedActions: actions.length - items.length };
}
