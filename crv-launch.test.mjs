// "crv launch <url> --agent <name>" (cli.mjs's crv.launch + browser-harness.mjs's
// buildLaunchUrl/launchTab). The pure URL-merge logic and flag validation run always, with
// no process spawn; the actual open-a-tab-and-wait-for-it-to-connect path is real-browser-only
// and skips itself like every other connected-tab test in this repo (browserSkip()) rather
// than mocking the browser launch - a fake "the tab connected" would prove nothing about the
// one thing this command actually exists to get right (the query params a real tab needs).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestRelay, freePort, spawnAsync } from './test-relay.mjs';
import { buildLaunchUrl, browserSkip } from './browser-harness.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const relay = await startTestRelay();
const BASE = `http://127.0.0.1:${relay.port}`;
const skipLive = relay.live ? 'skipped under WEBSCOUT_TEST_LIVE=1' : false;
const skipBrowser = process.env.WEBSCOUT_TEST_LIVE === '1' ? skipLive : browserSkip();

after(async () => { await relay.stop(); });

test('buildLaunchUrl sets the activation params without clobbering an existing query string or hash', () => {
  const url = buildLaunchUrl('http://127.0.0.1:9100/?tab=admin#capital-flow', 'p410');
  assert.equal(url.searchParams.get('webscout'), '1');
  assert.equal(url.searchParams.get('webscout_name'), 'p410');
  assert.equal(url.searchParams.get('tab'), 'admin', 'the URL\'s own existing param must survive the merge');
  assert.equal(url.hash, '#capital-flow');
});

test('buildLaunchUrl overwrites a stale webscout_name rather than appending a duplicate', () => {
  const url = buildLaunchUrl('http://127.0.0.1:9100/?webscout_name=old', 'new');
  assert.deepEqual(url.searchParams.getAll('webscout_name'), ['new']);
});

test('buildLaunchUrl rejects a target that is not a valid absolute URL', () => {
  assert.throws(() => buildLaunchUrl('not-a-url', 'p410'));
});

test('buildLaunchUrl stamps webscout_port so a launched tab connects to a non-default relay, not silently 8973', () => {
  const url = buildLaunchUrl('http://127.0.0.1:9100/', 'p410', 54321);
  assert.equal(url.searchParams.get('webscout_port'), '54321');
  const withoutPort = buildLaunchUrl('http://127.0.0.1:9100/', 'p410');
  assert.equal(withoutPort.searchParams.has('webscout_port'), false);
});

test('CLI: "crv launch" requires a URL', async () => {
  const r = await spawnAsync([path.join(dir, 'cli.mjs'), 'crv', 'launch', '--agent', 'p410'], { env: relay.env, cwd: dir });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /requires a URL/);
});

test('CLI: "crv launch" requires --agent, naming the tab-collision incident it exists to avoid', async () => {
  const r = await spawnAsync([path.join(dir, 'cli.mjs'), 'crv', 'launch', 'http://127.0.0.1:9100/'], { env: relay.env, cwd: dir });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /requires --agent/);
  assert.match(r.stderr, /tab-collision/);
});

// ---------- real browser: launches a real tab, waits for it to actually connect ----------

let pageServer;
let pagePort;
const PAGE = `<!doctype html><html><head><title>fixture</title></head><body>ok<script src="/inject.js"></script></body></html>`;

before(async () => {
  if (skipBrowser) return;
  const injectSource = fs.readFileSync(path.join(dir, 'inject.js'));
  pageServer = http.createServer((req, res) => {
    if (req.url.startsWith('/inject.js')) { res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end(injectSource); return; }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(PAGE);
  });
  pagePort = await freePort();
  await new Promise((resolve) => pageServer.listen(pagePort, '127.0.0.1', resolve));
});

after(async () => { await new Promise((resolve) => (pageServer ? pageServer.close(resolve) : resolve())); });

test('CLI: "crv launch" opens a real tab with the activation params and the relay sees it connect', { skip: skipBrowser }, async () => {
  const r = await spawnAsync([
    path.join(dir, 'cli.mjs'), 'crv', 'launch', `http://127.0.0.1:${pagePort}/`, '--agent', 'crv-launch-tab', '--headless',
  ], { env: relay.env, cwd: dir, timeoutMs: 20000 });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.connected, true, JSON.stringify(out));
  assert.equal(out.agent, 'crv-launch-tab');
  assert.match(out.origin, new RegExp(`127\\.0\\.0\\.1:${pagePort}$`));
});
