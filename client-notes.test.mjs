// The side-channel notes (nudge, running token total with a per-call delta,
// stale-relay warning) arrive as response HEADERS. A CLI caller sees them on
// stderr; an MCP caller never sees a server's stderr, so collectNotes()
// captures them per tool call instead. A tiny fake relay serves the headers.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort, spawnAsync } from './test-relay.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
let headers = {};
// client.mjs reads WEBSCOUT_PORT once at import, so the fake relay must be up
// and the env set BEFORE the dynamic import below (a `before()` hook runs too late).
const port = await freePort();
const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify({ ok: true, result: { hello: 'world' } }));
});
await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
process.env.WEBSCOUT_PORT = String(port);
after(() => server.close());

const { request, collectNotes } = await import('./client.mjs');

test('collectNotes captures the running total with its per-call delta, keeping only the latest', async () => {
  headers = { 'x-webscout-session-tokens': '9000', 'x-webscout-call-tokens': '66' };
  const { value, notes } = await collectNotes(async () => {
    await request('GET', '/x');
    headers = { 'x-webscout-session-tokens': '9100', 'x-webscout-call-tokens': '100' };
    return request('GET', '/x');
  });
  assert.deepEqual(value, { hello: 'world' });
  assert.equal(notes.length, 1, 'the running total replaces its earlier value instead of piling up');
  assert.match(notes[0], /~9100 estimated tokens so far \(\+100 this call\)/);
});

test('below the threshold nothing is reported', async () => {
  headers = { 'x-webscout-session-tokens': '10', 'x-webscout-call-tokens': '10' };
  const { notes } = await collectNotes(() => request('GET', '/x'));
  assert.deepEqual(notes, []);
});

test('no per-call header (a relay with no baseline yet) means no bogus delta', async () => {
  headers = { 'x-webscout-session-tokens': '9000' };
  const { notes } = await collectNotes(() => request('GET', '/x'));
  assert.match(notes[0], /~9000 estimated tokens so far\.$/);
  assert.doesNotMatch(notes[0], /this call/);
});

test('nudges and the stale-relay warning are captured too', async () => {
  headers = { 'x-webscout-nudge': 'consider macro record', 'x-webscout-relay-stale': 'db.mjs,relay.mjs' };
  const { notes } = await collectNotes(() => request('GET', '/x'));
  assert.ok(notes.includes('consider macro record'));
  assert.ok(notes.some((n) => /db\.mjs,relay\.mjs changed since it started/.test(n)));
});

test('notes survive a failing call (attached to the error)', async () => {
  headers = { 'x-webscout-nudge': 'a nudge on a failing call' };
  await assert.rejects(collectNotes(async () => {
    await request('GET', '/x');
    throw new Error('boom');
  }), (err) => err.message === 'boom' && err.notes.includes('a nudge on a failing call'));
});

test('without a collector, notes go to stderr (the CLI behavior)', async () => {
  headers = { 'x-webscout-nudge': 'plain stderr nudge' };
  const seen = [];
  const original = console.error;
  console.error = (...a) => seen.push(a.join(' '));
  try { await request('GET', '/x'); } finally { console.error = original; }
  assert.ok(seen.some((l) => l.includes('[web-scout] plain stderr nudge')));
});

test('an MCP tool call returns the notes as extra text content after the result', async () => {
  // A real mcp-server.mjs child against the fake relay: the FIRST content
  // item is the tool result untouched, the notes follow as text items.
  headers = { 'x-webscout-session-tokens': '9000', 'x-webscout-call-tokens': '66', 'x-webscout-nudge': 'mcp nudge' };
  const child = spawn(process.execPath, [path.join(dir, 'mcp-server.mjs')], { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, WEBSCOUT_PORT: String(port) } });
  const rl = readline.createInterface({ input: child.stdout, terminal: false });
  const answer = new Promise((resolve) => rl.on('line', (line) => { const m = JSON.parse(line); if (m.id === 2) resolve(m); }));
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'webscout_meta', arguments: { action: 'status' } } })}\n`);
  const msg = await answer;
  child.stdin.end();
  child.kill();
  const [first, ...rest] = msg.result.content;
  assert.deepEqual(JSON.parse(first.text), { hello: 'world' });
  const texts = rest.map((c) => c.text);
  assert.ok(texts.some((t) => t === '[web-scout] mcp nudge'));
  assert.ok(texts.some((t) => /session running total: ~9000 estimated tokens so far \(\+66 this call\)/.test(t)));
});

// The stale-relay/stale-agent warnings dedupe with an in-memory Set (see
// client.mjs) - correct for mcp-server.mjs (one long-lived process) but
// cli.mjs is a fresh process per command, the tool's dominant usage pattern.
// Confirmed live: a CRV session issuing dozens of separate CLI invocations
// against one known-stale tab got the identical warning on every single
// call. These two tests reproduce that with REAL separate processes (the
// in-memory Set alone cannot prove this - it never survives past one).
// Uses spawnAsync, not spawnClean: the fake relay these children fetch()
// against lives in THIS (parent) process's event loop. spawnClean's
// spawnSync blocks that event loop until the child exits - self-deadlock,
// the same class test-relay.mjs's own spawnClean comment already warns
// about (confirmed live: every run hung the full 60s timeout).
function warnScript() {
  // Explicit exit: undici's keep-alive socket pool would otherwise keep this
  // one-shot child's event loop alive past its single request.
  return `const { request, collectNotes } = await import(${JSON.stringify(new URL('./client.mjs', import.meta.url).href)}); const { notes } = await collectNotes(() => request('GET', '/x')); console.log(JSON.stringify(notes)); process.exit(0);`;
}

test('agent-stale warning is remembered across separate PROCESSES within the cooldown window', async () => {
  const cacheFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'webscout-warn-cache-')), 'cache.json');
  headers = { 'x-webscout-agent-stale': 'tabA,tabB' };
  const env = { WEBSCOUT_PORT: String(port), WEBSCOUT_WARN_CACHE_PATH: cacheFile };
  try {
    const first = await spawnAsync(['--input-type=module', '-e', warnScript()], { env });
    assert.equal(first.status, 0, first.stderr);
    assert.ok(JSON.parse(first.stdout).some((n) => /run an older in-page agent/.test(n)), 'first process (no cache yet) should warn');

    const second = await spawnAsync(['--input-type=module', '-e', warnScript()], { env });
    assert.equal(second.status, 0, second.stderr);
    assert.ok(!JSON.parse(second.stdout).some((n) => /run an older in-page agent/.test(n)), 'a second, separate process within the cooldown must NOT repeat the warning - this is the actual bug: one-shot CLI invocations printing the identical warning every single call');
  } finally {
    fs.rmSync(path.dirname(cacheFile), { recursive: true, force: true });
  }
});

test('agent-stale warning resurfaces once the persisted cooldown has elapsed (never silenced forever)', async () => {
  const cacheFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'webscout-warn-cache-')), 'cache.json');
  fs.writeFileSync(cacheFile, JSON.stringify({ 'agent-stale:tabA,tabB': Date.now() - 6 * 60 * 1000 }));
  headers = { 'x-webscout-agent-stale': 'tabA,tabB' };
  const env = { WEBSCOUT_PORT: String(port), WEBSCOUT_WARN_CACHE_PATH: cacheFile };
  try {
    const r = await spawnAsync(['--input-type=module', '-e', warnScript()], { env });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(JSON.parse(r.stdout).some((n) => /run an older in-page agent/.test(n)), 'the underlying condition is still real once the cooldown elapses, so it must warn again, not stay silenced forever');
  } finally {
    fs.rmSync(path.dirname(cacheFile), { recursive: true, force: true });
  }
});

test('a total the relay marked quiet is not printed; a marked-notable one still is', async () => {
  headers = { 'x-webscout-session-tokens': '9000', 'x-webscout-call-tokens': '40', 'x-webscout-tokens-quiet': '1' };
  assert.deepEqual((await collectNotes(() => request('GET', '/x'))).notes, []);
  headers = { 'x-webscout-session-tokens': '9000', 'x-webscout-call-tokens': '1500' };
  const { notes } = await collectNotes(() => request('GET', '/x'));
  assert.match(notes[0], /~9000 estimated tokens so far \(\+1500 this call\)/);
});
