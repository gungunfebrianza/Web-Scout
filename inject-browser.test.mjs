// inject.js in a real headless browser, talking to an ephemeral relay: the
// page-change counter that keeps the read cache honest, the whole-page outline,
// and the avoided-bytes accounting behind the scoped-reads ledger. Skips itself
// when no Chromium/Edge binary is found (set WEBSCOUT_BROWSER), like the other
// connected-tab tests.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestRelay, freePort } from './test-relay.mjs';
import { currentInjectBuild } from './build-id.mjs';
import { browserSkip, findBrowser, launchBrowser, sleep } from './browser-harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const browserPath = findBrowser();
const skip = process.env.WEBSCOUT_TEST_LIVE === '1'
  ? 'skipped under WEBSCOUT_TEST_LIVE=1 (this test drives its own tab)'
  : browserSkip();

const PAGE = `<!doctype html><html><head><title>fixture</title></head><body>
<div id="app"><header id="hd"><nav><a>a</a><a>b</a></nav></header>
<main id="content"><ul id="list"><li>one</li><li>two</li></ul></main></div>
<script src="/inject.js"></script></body></html>`;

let relay;
let pageServer;
let page;
let BASE;

async function api(method, route, body) {
  const res = await fetch(`${BASE}${route}`, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  return { json: await res.json(), headers: res.headers };
}
const command = (type, params) => api('POST', '/command', { type, params });
const ledger = async (key) => (await api('GET', '/token-report')).json.result.savings.ledgers.find((l) => l.key === key);

before(async () => {
  if (skip) return;
  relay = await startTestRelay();
  BASE = `http://127.0.0.1:${relay.port}`;
  const injectSource = fs.readFileSync(path.join(__dirname, 'inject.js'));
  pageServer = http.createServer((req, res) => {
    if (req.url.startsWith('/inject.js')) { res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end(injectSource); return; }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(PAGE);
  });
  const pagePort = await freePort();
  await new Promise((resolve) => pageServer.listen(pagePort, '127.0.0.1', resolve));
  page = await launchBrowser(browserPath);
  await page.navigate(`http://127.0.0.1:${pagePort}/?webscout=1&webscout_port=${relay.port}`);
  for (let i = 0; i < 100; i += 1) {
    const health = (await api('GET', '/health')).json.result;
    if (health.agents_connected?.includes('default')) break;
    await sleep(100);
  }
  await api('POST', '/sessions', { goal: 'inject-browser.test.mjs', context: 'automated' });
});

after(async () => {
  await page?.close();
  await new Promise((resolve) => (pageServer ? pageServer.close(resolve) : resolve()));
  await relay?.stop();
});

test('the real in-page agent reports the build stamp of the file it loaded, so it is not flagged stale', { skip }, async () => {
  const health = (await api('GET', '/health')).json.result;
  const tab = health.agents_detail.find((a) => a.name === 'default');
  assert.equal(tab.build, currentInjectBuild());
  assert.equal(tab.agentStale, false);
  assert.deepEqual(health.stale_agents, []);
});

test('a DOM change the page made on its own invalidates a cached dom.query', { skip }, async () => {
  const first = await command('dom.query', { selector: '#list' });
  const second = await command('dom.query', { selector: '#list' });
  assert.equal(second.json.result.__cacheHit, true, 'unchanged page - still a hit');
  assert.match(first.json.result.outerHTML, /two/);

  await page.evaluate(`document.getElementById('list').insertAdjacentHTML('beforeend', '<li>three</li>')`);
  const third = await command('dom.query', { selector: '#list' });
  assert.notEqual(third.json.result.__cacheHit, true);
  assert.match(third.json.result.outerHTML, /three/, 'the read must see the change the page made');
});

test('a fetch the page made on its own invalidates a cached net.log', { skip }, async () => {
  await page.evaluate(`fetch('/inject.js').then((r) => r.text()).then(() => true)`);
  const first = await command('net.log', {});
  const second = await command('net.log', {});
  assert.equal(second.json.result.__cacheHit, true);

  await page.evaluate(`fetch('/other.txt').then((r) => r.text()).then(() => true)`);
  const third = await command('net.log', {});
  assert.notEqual(third.json.result.__cacheHit, true);
  assert.equal(third.json.result.count, first.json.result.count + 1);
});

test('an idb command against a database the app has not created yet fails without creating it', { skip }, async () => {
  // Before this, a version-less open created an empty v1 database, and the app's own
  // open(name, 1) then never ran its upgrade - the next test creates the database
  // exactly the way an app does and would hang if this had left one behind.
  const list = await command('idb.list', {});
  assert.equal(list.json.ok, false);
  assert.match(list.json.error, /does not exist yet/);
  const version = await command('db.version', {});
  assert.equal(version.json.ok, false);
  const existing = await page.evaluate(`indexedDB.databases().then((dbs) => dbs.map((d) => d.name))`);
  assert.ok(!existing.includes('AgentCapitalOS'), 'no database was created');
});

test('an IndexedDB write the app made on its own invalidates a cached idb.dump', { skip }, async () => {
  await page.evaluate(`new Promise((resolve, reject) => {
    const req = indexedDB.open('AgentCapitalOS', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv', { keyPath: 'id' });
    req.onsuccess = () => { const tx = req.result.transaction('kv', 'readwrite'); tx.objectStore('kv').put({ id: 1 }); tx.oncomplete = () => { req.result.close(); resolve(true); }; };
    req.onerror = () => reject(req.error);
  })`);
  const first = await command('idb.dump', { store: 'kv' });
  const second = await command('idb.dump', { store: 'kv' });
  assert.equal(first.json.result.count, 1);
  assert.equal(second.json.result.__cacheHit, true);

  await page.evaluate(`new Promise((resolve, reject) => {
    const req = indexedDB.open('AgentCapitalOS');
    req.onsuccess = () => { const tx = req.result.transaction('kv', 'readwrite'); tx.objectStore('kv').put({ id: 2 }); tx.oncomplete = () => { req.result.close(); resolve(true); }; };
    req.onerror = () => reject(req.error);
  })`);
  const third = await command('idb.dump', { store: 'kv' });
  assert.notEqual(third.json.result.__cacheHit, true);
  assert.equal(third.json.result.count, 2);
});

test('a whole-page selector answers with an outline; full keeps the markup', { skip }, async () => {
  const outline = (await command('dom.query', { selector: 'body' })).json.result;
  assert.ok(Array.isArray(outline.outline) && outline.outline.length > 3);
  assert.match(outline.outline[0], /^body \[/);
  assert.ok(outline.outline.some((l) => /#content/.test(l)), 'the outline names the child worth drilling into');
  assert.equal(outline.outerHTML, undefined);
  assert.match(outline.outlineNote, /full/);

  const full = (await command('dom.query', { selector: 'body', full: true })).json.result;
  assert.equal(full.outline, undefined);
  assert.match(full.outerHTML, /<main id="content">/);

  // the full call right after the same selector's outline says the outline was not enough
  const strategy = (await api('GET', '/token-report')).json.result.savings.readStrategy.outline;
  assert.ok(strategy.calls >= 1 && strategy.deliveredBytes > 0);
  assert.ok(strategy.oldDefaultBytes > 0, 'the page told the relay what the outline replaced');
  assert.ok(strategy.followedByFull >= 1);
});

test('scoped reads report what they left out, and the ledger counts it', { skip }, async () => {
  await page.evaluate(`document.getElementById('content').insertAdjacentHTML('beforeend', '<p>' + 'x'.repeat(6000) + '</p>')`);
  const before = (await ledger('scopedReads')).bytesSaved;
  await command('dom.query', { selector: '#content', meta: true });
  const afterMeta = (await ledger('scopedReads')).bytesSaved;
  assert.ok(afterMeta - before >= 2000, `meta on a big element should avoid ~3000 default bytes, avoided ${afterMeta - before}`);

  await command('net.log', { limit: 1 });
  const afterLimit = (await ledger('scopedReads')).bytesSaved;
  assert.ok(afterLimit > afterMeta, 'a limited net.log avoids the entries it cut');

  await command('idb.dump', { store: 'kv', where: { id: 2 } });
  const afterWhere = (await ledger('scopedReads')).bytesSaved;
  assert.ok(afterWhere > afterLimit, 'a filtered idb.dump avoids the rows it cut');

  const trend = (await api('GET', '/token-report')).json.result.savings.trend;
  assert.ok(trend.at(-1).avoidedBytes >= afterWhere - before);
});

test('the page produced no errors', { skip }, () => {
  assert.deepEqual(page.errors, []);
});
