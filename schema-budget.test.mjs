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
// the V32 list was 17,973. The cap leaves ~1% headroom.
const MCP_TOTAL_MAX_BYTES = 16500;
const MCP_TOOL_MAX_BYTES = 3200;
// The biggest slice of help (a whole group) and the index a bare `cli.mjs` prints.
const HELP_GROUP_MAX_CHARS = 14000;
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
