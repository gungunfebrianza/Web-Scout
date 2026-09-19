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

test('dom.query pick returns only the named parts, and says what it left out', { skip }, async () => {
  await page.evaluate(`document.getElementById('content').insertAdjacentHTML('beforeend', '<a id="lnk" href="/somewhere" class="nav big">link text <b>' + 'y'.repeat(900) + '</b></a>')`);
  const before = (await ledger('scopedReads')).bytesSaved;
  const picked = (await command('dom.query', { selector: '#lnk', pick: ['attr:href', 'tag'] })).json.result;
  assert.deepEqual(picked, { found: true, matchCount: 1, tag: 'A', attrs: { href: '/somewhere' } });
  assert.ok((await ledger('scopedReads')).bytesSaved > before, 'the markup a pick left out counts as avoided');
  const text = (await command('dom.query', { selector: '#lnk', pick: ['text', 'class'] })).json.result;
  assert.match(text.text, /^link text /);
  assert.equal(text.className, 'nav big');
  assert.equal(text.outerHTML, undefined);
  const bad = await command('dom.query', { selector: '#lnk', pick: ['nope'] });
  assert.equal(bad.json.ok, false);
  assert.match(bad.json.error, /unknown item 'nope'/);
});

test('idb reads can be narrowed to counts, named stores, non-empty stores and a few fields', { skip }, async () => {
  const counted = (await command('idb.dump', { store: 'kv', countOnly: true })).json.result;
  assert.equal(counted.countOnly, true);
  assert.deepEqual(counted.rows, []);
  assert.equal(counted.totalCount, 2);
  assert.equal(counted.matchedCount, 2);

  await page.evaluate(`new Promise((resolve, reject) => {
    const req = indexedDB.open('AgentCapitalOS');
    req.onsuccess = () => { const db = req.result; const v = db.version + 1; db.close();
      const up = indexedDB.open('AgentCapitalOS', v);
      up.onupgradeneeded = () => { up.result.createObjectStore('empty_one', { keyPath: 'id' }); };
      up.onsuccess = () => { const tx = up.result.transaction('kv', 'readwrite'); tx.objectStore('kv').put({ id: 9, title: 'nine', body: 'b'.repeat(500), tag: 't' }); tx.oncomplete = () => { up.result.close(); resolve(true); }; };
      up.onerror = () => reject(up.error); };
    req.onerror = () => reject(req.error);
  })`);
  const all = (await command('idb.list', {})).json.result;
  assert.ok(all.stores.includes('empty_one') && all.stores.includes('kv'));
  const nonEmpty = (await command('idb.list', { nonEmpty: true })).json.result;
  assert.ok(!nonEmpty.stores.includes('empty_one'));
  assert.equal(nonEmpty.emptyStores, 1);
  const named = (await command('idb.list', { stores: ['kv', 'ghost'] })).json.result;
  assert.deepEqual(named.stores, ['kv']);
  assert.deepEqual(named.missing, ['ghost']);

  const row = (await command('idb.get', { store: 'kv', key: 9, fields: ['title', 'tag'] })).json.result;
  assert.deepEqual(row.row, { title: 'nine', tag: 't' });
  assert.deepEqual(row.fields, ['title', 'tag']);
  const whole = (await command('idb.get', { store: 'kv', key: 9 })).json.result;
  assert.equal(whole.row.body.length, 500);
});

test('net.log and console.log filter by failure, level, text and field in the page', { skip }, async () => {
  await page.evaluate(`fetch('http://127.0.0.1:1/unreachable').catch(() => true)`);
  await page.evaluate(`fetch('/inject.js?ok=1').then((r) => r.text())`);
  const failed = (await command('net.log', { failed: true, fields: ['url', 'error'] })).json.result;
  assert.ok(failed.count >= 1 && failed.total > failed.count, 'only the failing request, out of a larger log');
  assert.ok(failed.entries.every((e) => Object.keys(e).every((k) => ['url', 'error'].includes(k))));
  assert.match(failed.entries.at(-1).url, /unreachable/);

  await page.evaluate(`console.warn('careful-1'); console.error('boom-2'); console.warn('careful-3')`);
  const warns = (await command('console.log', { level: 'warn', fields: ['level', 'message'] })).json.result;
  assert.deepEqual(warns.entries.map((e) => e.message), ['careful-1', 'careful-3']);
  assert.ok(warns.entries.every((e) => e.stack === undefined && e.at === undefined));
  const both = (await command('console.log', { level: 'warn,error' })).json.result;
  assert.equal(both.count, 3);
  const text = (await command('console.log', { contains: 'boom' })).json.result;
  assert.equal(text.count, 1);
  assert.equal(text.total, 3);
  page.errors.length = 0; // the console.error above is this test's own doing
});

test('react.inspect pick returns one path instead of the whole component', { skip }, async () => {
  await page.evaluate(`(function () {
    function Widget() {}
    const el = document.getElementById('lnk');
    el['__reactFiber$test'] = { type: Widget, key: null, memoizedProps: { user: { id: 7, name: 'ann' }, big: 'z'.repeat(400) }, memoizedState: { memoizedState: 'open', next: { memoizedState: 5, next: null } }, return: null };
  })()`);
  const picked = (await command('react.inspect', { selector: '#lnk', pick: ['props.user.id', 'hooks.1.value'] })).json.result;
  assert.deepEqual(picked, { componentName: 'Widget', picked: { 'props.user.id': 7, 'hooks.1.value': 5 } });
  const whole = (await command('react.inspect', { selector: '#lnk' })).json.result;
  assert.equal(whole.props.big.length, 400);
  assert.deepEqual((await command('react.inspect', { selector: '#lnk', pick: ['state'] })).json.result, { componentName: 'Widget' }, 'a function component has no state to pick');
});

test('the page produced no errors', { skip }, () => {
  assert.deepEqual(page.errors, []);
});
