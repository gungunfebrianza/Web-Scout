// Real, not simulated: spawns mcp-server.mjs as an actual child process and
// speaks real JSON-RPC over its real stdio, against a real ephemeral relay
// (see test-relay.mjs; WEBSCOUT_TEST_LIVE=1 uses the already-running one).
// Run with: node --test tools/web-scout/mcp-server.test.mjs

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { startTestRelay, connectFakeAgent } from './test-relay.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const relay = await startTestRelay();
after(() => relay.stop());
// client.mjs reads WEBSCOUT_PORT once at import, so set it first. The spawned
// mcp-server child inherits process.env, so it targets the same relay.
process.env.WEBSCOUT_PORT = String(relay.port);
const { request } = await import('./client.mjs');

// Each test file owns its own relay, so files can run in parallel. The
// cleanup only matters under WEBSCOUT_TEST_LIVE=1, where a crashed earlier
// run may have left a dangling active session.
before(async () => {
  try {
    const health = await request('GET', '/health');
    if (health.active_session) await request('POST', `/sessions/${health.active_session.id}/end`);
  } catch { /* relay unreachable - every test below will fail with a clear message anyway */ }
});

function startServer(envOverride) {
  const child = spawn('node', [path.join(__dirname, 'mcp-server.mjs')], { stdio: ['pipe', 'pipe', 'pipe'], env: envOverride ? { ...process.env, ...envOverride } : process.env });
  const rl = readline.createInterface({ input: child.stdout, terminal: false });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  let id = 0;
  const pending = new Map();
  rl.on('line', (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  });
  function call(method, params, { timeoutMs = 10000 } = {}) {
    const msgId = ++id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(msgId); reject(new Error(`timed out waiting for ${method} response - relay running? stderr: ${stderr}`)); }, timeoutMs);
      pending.set(msgId, (msg) => { clearTimeout(timer); resolve(msg); });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: msgId, method, params })}\n`);
    });
  }
  function notify(method, params) {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }
  function close() { child.stdin.end(); child.kill(); }
  return { call, notify, close, getStderr: () => stderr };
}

async function withServer(fn, envOverride) {
  const server = startServer(envOverride);
  try {
    const init = await server.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    assert.equal(init.result.serverInfo.name, 'web-scout');
    server.notify('notifications/initialized', {});
    await fn(server);
  } finally {
    server.close();
  }
}

test('initialize handshake and tools/list shape', async () => {
  await withServer(async (server) => {
    const list = await server.call('tools/list', {});
    const names = list.result.tools.map((t) => t.name);
    for (const expected of ['webscout_meta', 'webscout_session', 'webscout_dom', 'webscout_idb', 'webscout_net', 'webscout_console', 'webscout_page', 'webscout_macro', 'webscout_suite', 'webscout_eval']) {
      assert.ok(names.includes(expected), `missing tool ${expected}`);
    }
    for (const tool of list.result.tools) {
      assert.equal(tool.inputSchema.type, 'object');
      assert.ok(tool.description && tool.description.length > 0, `${tool.name} has no description`);
    }
  });
});

test('unknown JSON-RPC method returns a protocol error, not a tool error', async () => {
  await withServer(async (server) => {
    const res = await server.call('bogus/method', {});
    assert.equal(res.error.code, -32601);
  });
});

test('webscout_meta status reaches the real relay', async () => {
  await withServer(async (server) => {
    const res = await server.call('tools/call', { name: 'webscout_meta', arguments: { action: 'status' } });
    assert.equal(res.result.isError, undefined);
    const status = JSON.parse(res.result.content[0].text);
    assert.equal(status.status, 'ok');
  });
});

test('a missing required param comes back as isError:true, not a crash', async () => {
  await withServer(async (server) => {
    const res = await server.call('tools/call', { name: 'webscout_dom', arguments: { action: 'click', params: {} } });
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /selector/);
  });
});

test('an unknown action for a real tool is rejected with the valid-action list', async () => {
  await withServer(async (server) => {
    const res = await server.call('tools/call', { name: 'webscout_idb', arguments: { action: 'nope', params: {} } });
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /unknown action/);
  });
});

test('an unknown tool name is rejected', async () => {
  await withServer(async (server) => {
    const res = await server.call('tools/call', { name: 'webscout_nonexistent', arguments: { action: 'x' } });
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /unknown tool/);
  });
});

test('session start -> dom/idb/eval against the active session -> session end (real relay + real connected tab)', async (t) => {
  await withServer(async (server) => {
    const health = await server.call('tools/call', { name: 'webscout_meta', arguments: { action: 'status' } });
    const { agents_connected } = JSON.parse(health.result.content[0].text);
    if (!agents_connected.length) return t.skip('no browser tab connected to this relay - run with WEBSCOUT_TEST_LIVE=1 against a relay that has one');

    const start = await server.call('tools/call', { name: 'webscout_session', arguments: { action: 'start', params: { goal: 'mcp-server.test.mjs run', context: 'automated' } } });
    assert.equal(start.result.isError, undefined);
    const session = JSON.parse(start.result.content[0].text);
    assert.equal(session.status, 'active');

    const evalRes = await server.call('tools/call', { name: 'webscout_eval', arguments: { expr: '1+1' } });
    assert.equal(evalRes.result.isError, undefined);
    assert.equal(JSON.parse(evalRes.result.content[0].text), 2);

    const idbList = await server.call('tools/call', { name: 'webscout_idb', arguments: { action: 'list', params: {} } });
    assert.equal(idbList.result.isError, undefined);
    assert.ok(Array.isArray(JSON.parse(idbList.result.content[0].text).stores));

    const end = await server.call('tools/call', { name: 'webscout_session', arguments: { action: 'end', params: { id: session.id } } });
    assert.equal(end.result.isError, undefined);
    assert.equal(JSON.parse(end.result.content[0].text).status, 'ended');
  });
});

// relay.mjs's dispatchTracked already attaches err.extra.knownIssue to a failed /command
// (see friction-awareness.test.mjs) and client.mjs already copies err.extra onto the thrown
// Error - cli.mjs already prints it, but handleToolsCall's catch previously dropped it, so an
// MCP agent got strictly less diagnostic information than a CLI agent for the identical
// failure. Own relay + own fake tab (this file's shared module-level relay has none connected).
test('an MCP tool failure carries the same knownIssue info the CLI already prints', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webscout-mcp-known-issue-'));
  const registryPath = path.join(dir, 'known-issues.json');
  fs.writeFileSync(registryPath, JSON.stringify([{ id: 'mcp-flaky-el', signature: 'detached from DOM', description: 'stale DOM reference after a rerender', remediation: 'use dom.click-wait instead of a bare click' }]));
  const localRelay = await startTestRelay({ env: { WEBSCOUT_KNOWN_ISSUES: registryPath } });
  const tab = await connectFakeAgent(localRelay.port, {
    'dom.click': (params) => { if (params.selector === '#broken') throw new Error('Element not found: #broken (detached from DOM)'); return { clicked: true }; },
  });
  try {
    await withServer(async (server) => {
      const start = await server.call('tools/call', { name: 'webscout_session', arguments: { action: 'start', params: { goal: 'mcp known-issue parity test', context: 'mcp-server.test.mjs' } } });
      assert.equal(start.result.isError, undefined);

      const click = await server.call('tools/call', { name: 'webscout_dom', arguments: { action: 'click', params: { selector: '#broken' } } });
      assert.equal(click.result.isError, true);
      const texts = click.result.content.map((c) => c.text).join('\n');
      assert.match(texts, /Known issue: mcp-flaky-el/);
      assert.match(texts, /use dom.click-wait instead of a bare click/);
    }, { WEBSCOUT_PORT: String(localRelay.port) });
  } finally {
    await tab.close();
    await localRelay.stop();
  }
});
