// Real, not simulated: spawns mcp-server.mjs as an actual child process and
// speaks real JSON-RPC over its real stdio, against the real, already-
// running relay (node tools/web-scout/relay.mjs) - same verification
// discipline as the rest of this tool. Run with:
//   node --test tools/web-scout/mcp-server.test.mjs
// Requires the relay to be running first; a clear failure message says so
// rather than hanging if it isn't.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { request } from './client.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// This file's tests share the relay's one mutable "active session" with
// cli.test.mjs's tests - MUST run with `node --test --test-concurrency=1`
// across both files (see README "Testing"), never in parallel. Defensive
// best-effort cleanup: a previous run that crashed mid-test leaves a
// dangling active session that would otherwise fail every `session start`
// in this run too.
before(async () => {
  try {
    const health = await request('GET', '/health');
    if (health.active_session) await request('POST', `/sessions/${health.active_session.id}/end`);
  } catch { /* relay unreachable - every test below will fail with a clear message anyway */ }
});

function startServer() {
  const child = spawn('node', [path.join(__dirname, 'mcp-server.mjs')], { stdio: ['pipe', 'pipe', 'pipe'] });
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

async function withServer(fn) {
  const server = startServer();
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

test('session start -> dom/idb/eval against the active session -> session end (real relay + real connected tab)', async () => {
  await withServer(async (server) => {
    const health = await server.call('tools/call', { name: 'webscout_meta', arguments: { action: 'status' } });
    const { agents_connected } = JSON.parse(health.result.content[0].text);
    if (!agents_connected.length) {
      // No browser tab connected in this environment - skip the
      // session-scoped assertions rather than fail on an environment gap
      // unrelated to the MCP wrapper itself.
      return;
    }

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
