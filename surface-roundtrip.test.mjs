// One question, three askers: the HTTP route, the CLI command and the MCP action must return the SAME answer, and
// every parameter the spec maps from a CLI flag must be named in the MCP tool's text and read by the CLI. cli-parity
// checks the declarations; this runs them. Real relay + fake tab, real CLI child process, real MCP child process.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CLI_SPEC } from './cli-spec.mjs';
import { startTestRelay, connectFakeAgent } from './test-relay.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const SHAPE_PARAMS = new Set(['table', 'ifChanged', 'delta', 'peek', 'noGuard']);
const source = (file) => fs.readFileSync(path.join(dir, file), 'utf8');

async function withMcp(relay, fn) {
  const child = spawn(process.execPath, [path.join(dir, 'mcp-server.mjs')], { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, ...relay.env, WEBSCOUT_NO_AUTOSTART: '1' } });
  const rl = readline.createInterface({ input: child.stdout, terminal: false });
  const pending = new Map();
  let seq = 0;
  rl.on('line', (line) => { try { const m = JSON.parse(line); if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } catch { /* not a reply */ } });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = (seq += 1);
    const timer = setTimeout(() => reject(new Error(`mcp ${method} timed out`)), 20000);
    pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  try {
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'roundtrip', version: '0' } });
    await fn({ rpc, tool: async (name, args) => JSON.parse(((await rpc('tools/call', { name, arguments: args })).result.content[0]).text) });
  } finally { child.stdin.end(); child.kill(); }
}

test('every parameter the spec maps from a flag is read by the CLI and named in the MCP tool\'s text', async () => {
  const cli = source('cli.mjs');
  const relay = await startTestRelay({ env: { WEBSCOUT_NO_AUTOSTART: '1' } });
  try {
    await withMcp(relay, async ({ rpc }) => {
      const tools = (await rpc('tools/list', {})).result.tools;
      const problems = [];
      for (const row of CLI_SPEC.filter((r) => r.mcp && r.params)) {
        const toolName = row.mcp.split('.')[0];
        const tool = tools.find((t) => t.name === toolName);
        for (const [flag, param] of Object.entries(row.params)) {
          if (!cli.includes(`'${flag}'`)) problems.push(`${row.cmd}: cli.mjs never reads ${flag}`);
          // the read-shaping params are defined once under webscout_dom and written "+shape" elsewhere (schema-budget.test.mjs)
          if (SHAPE_PARAMS.has(param)) continue;
          if (tool && !new RegExp(`\\b${param}\\b`).test(JSON.stringify(tool))) problems.push(`${row.cmd}: ${param} (from ${flag}) is not named in ${toolName}'s description or schema`);
        }
      }
      assert.deepEqual(problems, []);
    });
  } finally { await relay.stop(); }
});

test('the friction reads return the same answer over HTTP, the CLI and MCP', async () => {
  const relay = await startTestRelay({ env: { WEBSCOUT_ANALYTICS_CACHE_MS: '0', WEBSCOUT_NO_AUTOSTART: '1' } });
  let broken = true;
  const tab = await connectFakeAgent(relay.port, { 'dom.click': (p) => { if (broken && p.selector === '.rt1x') throw new Error('Element not found: .rt1x'); return { clicked: true, mutated: false }; } }, { origin: 'http://localhost:4100' });
  try {
    const http = async (method, route, body) => (await (await fetch(`http://127.0.0.1:${relay.port}${route}`, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined })).json()).result;
    const first = await http('POST', '/sessions', { goal: 'roundtrip one', context: 'surface-roundtrip.test.mjs', briefing: false });
    for (let n = 0; n < 3; n += 1) await http('POST', '/command', { type: 'dom.click', params: { selector: '.rt1x' } });
    await http('POST', `/sessions/${first.id}/end`);
    broken = false;
    await http('POST', '/sessions', { goal: 'roundtrip two', context: 'surface-roundtrip.test.mjs', briefing: false });
    await http('POST', '/command', { type: 'dom.click', params: { selector: '.rt1x' } });
    await http('POST', '/command', { type: 'dom.click', params: { selector: '#other' } });
    await http('POST', '/macros', { name: 'rt', sessionId: (await http('GET', '/sessions')).find((s) => s.goal === 'roundtrip two').id });

    const viaCli = (...args) => {
      const r = spawnSync(process.execPath, [path.join(dir, 'cli.mjs'), ...args], { encoding: 'utf8', env: { ...process.env, ...relay.env, WEBSCOUT_NO_AUTOSTART: '1' }, timeout: 30000 });
      assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}`);
      return JSON.parse(r.stdout);
    };
    await withMcp(relay, async ({ tool }) => {
      const meta = (params) => tool('webscout_meta', { action: 'friction', params });
      const cases = [
        ['targets', ['friction', 'targets', '--sort', 'fails', '--limit', '5'], { sub: 'targets', sort: 'fails', limit: 5 }, '/friction/targets?sort=fails&limit=5'],
        ['trend (project-wide)', ['friction', 'trend'], { sub: 'trend' }, '/friction/trend'],
        ['trend (one target)', ['friction', 'trend', 'dom.click', '.rt1x'], { sub: 'trend', type: 'dom.click', selector: '.rt1x' }, `/friction/trend?type=dom.click&selector=${encodeURIComponent('.rt1x')}`],
        ['regressions', ['friction', 'regressions'], { sub: 'regressions' }, '/friction/regressions'],
        ['next (list)', ['friction', 'next'], { sub: 'next' }, '/friction/next'],
        ['explain', ['friction', 'explain', 'dom.click', '.rt1x'], { sub: 'explain', type: 'dom.click', selector: '.rt1x' }, `/friction/explain?type=dom.click&selector=${encodeURIComponent('.rt1x')}`],
      ];
      for (const [label, cliArgs, mcpParams, route] of cases) {
        let direct;
        try { direct = await http('GET', route); } catch { direct = undefined; }
        if (direct === undefined) continue; // e.g. "next" before any notice: an error is the same error everywhere, not a result
        assert.deepEqual(viaCli(...cliArgs), direct, `${label}: CLI equals HTTP`);
        assert.deepEqual(await meta(mcpParams), direct, `${label}: MCP equals HTTP`);
      }
      const macros = await http('GET', '/macros?health=1');
      assert.deepEqual(viaCli('macro', 'list', '--health'), macros, 'macro list --health: CLI equals HTTP');
      assert.deepEqual(await tool('webscout_macro', { action: 'list', params: { health: true } }), macros, 'macro list health: MCP equals HTTP');
    });
  } finally { await tab.close(); await relay.stop(); }
});
