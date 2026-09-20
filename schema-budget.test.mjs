// What a caller pays before doing anything: the MCP tool list is sent to the model on every
// session start, and usage.txt is what `help` slices from. Both are tokens spent whether or not
// the feature they describe is ever used, so they have a budget like any other read - a change
// that grows them fails here and has to say why. Raise a cap deliberately, in the same commit
// that adds the text, not by accident.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseUsage, helpIndex, helpTopic } from './help.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));

// Measured 16,296 bytes (~4,070 tokens) when V33 added verify/pick/lean and compressed the rest;
// the V32 list was 17,973. Measured 16,613 when V34 added crv_run (one-call baseline -> action ->
// verify; see [[web-scout-v34-round]]) - raised deliberately, same commit as the text. Measured
// 17,230 when V38 added crv_preflight/crv_seed/crv_cleanup (webscout_idb) and session start's
// allowRemote/origin-pin text (webscout_session) - the real CRV-tooling gaps that round's own
// real-browser incident named directly; raised again, same commit, same convention.
// Measured 17,437 when V39 added session start's ifStaleMin (webscout_session) and named preflight's
// agents[]/knownIssueMatches in crv_preflight (webscout_idb) - raised to 17450, same commit, same convention.
// Measured 18,863 when the self-repair loop added webscout_repair (status/enable/disable/patch/
// verify/causal_diff - see self-repair.mjs, webscout2.md) - raised to 18900, same commit, same convention.
const MCP_TOTAL_MAX_BYTES = 18900;
// Raised to 3550 when V38 added crv_preflight/crv_seed/crv_cleanup to webscout_idb (already the
// biggest single tool, from crv_run) - same commit-with-the-text convention as above.
// Raised to 3650 when V39 extended crv_preflight's one-line description (webscout_idb measured 3,606).
const MCP_TOOL_MAX_BYTES = 3650;
// The biggest slice of help (a whole group) and the index a bare `cli.mjs` prints.
// Raised to 14300 when "session viz" (round-2 session-viz.mjs's own CLI access) was added to the
// already-tightest group - same commit as the text, same convention as MCP_TOTAL_MAX_BYTES above.
// Raised to 15500 when V38's origin-pin/--allow-remote/--agent text landed in the same
// already-tightest ("session") group - same convention, same commit as the text.
// Raised to 15800 when V39's "session start --if-stale-min" text landed in the same group (measured
// 15,774) - same convention, same commit as the text.
const HELP_GROUP_MAX_CHARS = 15800;
const HELP_INDEX_MAX_CHARS = 2200;

let child;
let tools;

before(async () => {
  child = spawn(process.execPath, [path.join(dir, 'mcp-server.mjs')], { stdio: ['pipe', 'pipe', 'ignore'] });
  const rl = readline.createInterface({ input: child.stdout, terminal: false });
  const reply = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('mcp-server never answered tools/list')), 10000);
    rl.on('line', (line) => {
      const msg = JSON.parse(line);
      if (msg.id === 2) { clearTimeout(timer); resolve(msg.result.tools); }
    });
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'budget', version: '0' } } })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
  tools = await reply;
});

after(() => { child?.stdin.end(); child?.kill(); });

test('the MCP tool list stays under its byte budget, in total and per tool', () => {
  const sizes = tools.map((t) => [t.name, JSON.stringify(t).length]);
  const total = sizes.reduce((sum, [, n]) => sum + n, 0);
  assert.ok(total <= MCP_TOTAL_MAX_BYTES, `tools/list is ${total} bytes (~${Math.round(total / 4)} tokens), cap ${MCP_TOTAL_MAX_BYTES}; per tool: ${sizes.map(([n, b]) => `${n} ${b}`).join(', ')}`);
  const big = sizes.filter(([, n]) => n > MCP_TOOL_MAX_BYTES);
  assert.deepEqual(big, [], `a single tool over ${MCP_TOOL_MAX_BYTES} bytes - split it or trim its text`);
});

test('the read-shaping params are described once, not per action', () => {
  const outside = tools.filter((t) => t.name !== 'webscout_dom' && /\bifChanged\b/.test(t.description)).map((t) => t.name);
  assert.deepEqual(outside, [], 'define the shape params once (under webscout_dom) and write "+shape" in the other tools');
  const dom = tools.find((t) => t.name === 'webscout_dom').description;
  assert.equal((dom.match(/\+shape \(/g) ?? []).length, 1, 'exactly one definition');
});

test('the property descriptions every tool schema repeats stay short', () => {
  for (const t of tools.filter((x) => x.inputSchema.properties.action)) {
    const { action, params } = t.inputSchema.properties;
    assert.ok(action.description.length <= 40 && params.description.length <= 40, `${t.name}: keep the shared property descriptions short`);
  }
});

test('help never makes a caller read the whole of usage.txt by accident', () => {
  const parsed = parseUsage(fs.readFileSync(path.join(dir, 'usage.txt'), 'utf8'));
  assert.ok(helpIndex(parsed).length <= HELP_INDEX_MAX_CHARS, 'the index grew');
  const topics = [...new Set(parsed.blocks.map((b) => b.topic))];
  const over = topics.map((t) => [t, helpTopic(parsed, t).length]).filter(([, n]) => n > HELP_GROUP_MAX_CHARS);
  assert.deepEqual(over, [], `help groups over ${HELP_GROUP_MAX_CHARS} chars - split the group or trim it`);
});
