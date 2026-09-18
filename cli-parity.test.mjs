// CLI <-> MCP parity. Every CLI command either has a mirroring MCP action or
// carries an explicit, reasoned exemption in cli-spec.mjs, and every CLI flag
// either maps to a documented MCP param or is declared CLI-only. Found by
// this test when it was first written (all were real gaps, now closed):
// MCP had no token_report, ping, debug_state, idb patch, dom click_wait,
// console wait; idb dump could not be scoped (where/fields/limit); dom query
// had no full/meta; idb snapshot had no since; session start had no tokenBudget.
//
// Reads the LIVE tool list from a spawned mcp-server.mjs over real JSON-RPC,
// so it checks what an agent would actually see, not the source text.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLI_SPEC } from './cli-spec.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
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
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'parity', version: '0' } } })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
  tools = await reply;
});

after(() => { child?.stdin.end(); child?.kill(); });

// "  click {selector, nth?} - ..." -> { click: ['selector', 'nth'] }
function documentedParams(tool) {
  const out = {};
  for (const m of tool.description.matchAll(/^ {2}(\w+) \{([^}]*)\}/gm)) {
    out[m[1]] = m[2].split(',').map((p) => p.trim().match(/^\w+/)?.[0]).filter(Boolean);
  }
  return out;
}

test('every CLI command with an MCP mapping points at a real tool action', () => {
  for (const row of CLI_SPEC.filter((r) => r.mcp)) {
    const [toolName, action] = row.mcp.split('.');
    const tool = tools.find((t) => t.name === toolName);
    assert.ok(tool, `${row.cmd}: MCP tool ${toolName} does not exist`);
    if (action) assert.ok(tool.inputSchema.properties.action.enum.includes(action), `${row.cmd}: ${toolName} has no action '${action}'`);
  }
});

test('every CLI command without an MCP mapping states why', () => {
  for (const row of CLI_SPEC.filter((r) => !r.mcp)) {
    assert.ok(typeof row.mcpExempt === 'string' && row.mcpExempt.length > 20, `${row.cmd}: mcp is null but mcpExempt has no real reason`);
  }
});

test('every CLI flag maps to a documented MCP param or is declared CLI-only', () => {
  const problems = [];
  for (const row of CLI_SPEC.filter((r) => r.mcp)) {
    const [toolName, action] = row.mcp.split('.');
    const tool = tools.find((t) => t.name === toolName);
    const documented = action ? documentedParams(tool)[action] ?? [] : Object.keys(tool.inputSchema.properties);
    for (const flag of [...(row.bool ?? []), ...(row.val ?? [])]) {
      if (flag === '--agent') continue;
      const param = row.params?.[flag];
      if (param) {
        if (!documented.includes(param)) problems.push(`${row.cmd} ${flag} -> MCP param '${param}' is not in ${row.mcp}'s documented params [${documented.join(', ')}]`);
      } else if (!row.cliOnly?.[flag]) {
        problems.push(`${row.cmd} ${flag} has neither an MCP param mapping nor a cliOnly reason`);
      }
    }
    for (const flag of [...Object.keys(row.params ?? {}), ...Object.keys(row.cliOnly ?? {})]) {
      if (![...(row.bool ?? []), ...(row.val ?? [])].includes(flag)) problems.push(`${row.cmd}: params/cliOnly names ${flag}, which is not a declared flag`);
    }
  }
  assert.deepEqual(problems, []);
});

test('every MCP action is mirrored by a CLI command (no MCP-only drift)', () => {
  const mapped = new Set(CLI_SPEC.filter((r) => r.mcp).map((r) => r.mcp));
  const unmapped = [];
  for (const tool of tools) {
    if (tool.name === 'webscout_eval') { if (!mapped.has('webscout_eval')) unmapped.push('webscout_eval'); continue; }
    for (const action of tool.inputSchema.properties.action.enum) {
      if (!mapped.has(`${tool.name}.${action}`)) unmapped.push(`${tool.name}.${action}`);
    }
  }
  assert.deepEqual(unmapped, [], 'add these to cli-spec.mjs (or give the CLI the command)');
});
