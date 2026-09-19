// The read-only contract, checked against a real page: a command that only reads must leave
// the app exactly as it found it. The automatic call at `session start` (the briefing) made
// this a hard requirement - an early inject.js created an empty IndexedDB on a read, which the
// app's own first open then tripped over. This fingerprints everything a read could touch
// (every IndexedDB database with its stores, indexes and rows, localStorage, sessionStorage,
// cookies, the DOM) before and after every non-mutating command in the registry, and after the
// routes that read on the caller's behalf (snapshot, verify, briefing).
//
// A new non-mutating command must be added to COVERED (or EXEMPT, with a reason) here: the
// registry cross-check below fails until it is, so a new read cannot ship untested.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestRelay, freePort } from './test-relay.mjs';
import { browserSkip, findBrowser, launchBrowser, sleep } from './browser-harness.mjs';
import { COMMAND_TYPES } from './command-registry.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Every registry type that is not `mutating`, with params that make it do real work.
// `expectOk: false` = the command legitimately fails on this fixture (still must not write).
const COVERED = {
  ping: {},
  'page.epoch': {},
  'dom.query': { selector: '#list' },
  'dom.rect': { selector: '#list' },
  'dom.computedStyle': { selector: '#list' },
  'react.inspect': { selector: '#list', expectOk: false }, // no React on the fixture page
  'react.tree': { selector: '#list', expectOk: false },
  'dom.wait': { selector: '#list', timeoutMs: 400 },
  'dom.settle': { timeoutMs: 800, quietMs: 100 },
  'dom.screenshot': { selector: '#list', expectOk: null },
  'idb.list': {},
  'idb.dump': { store: 'notes' },
  'idb.get': { store: 'notes', key: 1 },
  'idb.wait': { store: 'notes', countGte: 1, timeoutMs: 400 },
  'db.version': {},
  'db.probeUpgrade': { targetVersion: 'current+1' },
  'net.log': {},
  'net.wait': { urlPattern: '/inject.js', timeoutMs: 300, expectOk: null },
  'console.log': {},
  'console.wait': { substr: 'never-logged', timeoutMs: 300, expectOk: null },
  'debug.state': {},
  'page.fileHash': { path: '/inject.js' },
};
const EXEMPT = {
  'dom.pick': 'blocks until a human clicks and installs a click-capturing overlay by design - it is an interaction, not a read',
  'idb.snapshot': 'dispatched only through POST /state/snapshot, which is covered below',
};

test('every non-mutating registry command is covered by the read-only contract or exempt with a reason', () => {
  const nonMutating = Object.entries(COMMAND_TYPES).filter(([, meta]) => !meta.mutating).map(([type]) => type).sort();
  const known = [...Object.keys(COVERED), ...Object.keys(EXEMPT)].sort();
  assert.deepEqual(nonMutating.filter((t) => !known.includes(t)), [], 'a new read command: add it to COVERED (params that do real work) so this test proves it writes nothing');
  assert.deepEqual(known.filter((t) => !nonMutating.includes(t)), [], 'listed here as a read but the registry says it mutates (or it no longer exists)');
  for (const [type, reason] of Object.entries(EXEMPT)) assert.ok(reason.length > 20, `${type}: say why it is exempt`);
});

const skip = process.env.WEBSCOUT_TEST_LIVE === '1' ? 'skipped under WEBSCOUT_TEST_LIVE=1 (this test drives its own tab)' : browserSkip();

const PAGE = `<!doctype html><html><head><title>fixture</title></head><body>
<div id="app"><header><nav><a href="/x">a</a></nav></header>
<main><ul id="list"><li>one</li><li>two</li></ul><input id="name" value="kept"></main></div>
<script src="/inject.js"></script></body></html>`;

// Everything a read could change, as one comparable string. Opens each database version-less,
// so it cannot itself upgrade or create anything.
const FINGERPRINT = `(async () => {
  const hash = (s) => { let h = 5381; for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(16) + ':' + s.length; };
  const dbs = await indexedDB.databases();
  const out = { databases: dbs.map((d) => d.name + '@' + d.version).sort() };
  for (const d of dbs) {
    const db = await new Promise((resolve, reject) => { const r = indexedDB.open(d.name); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const names = [...db.objectStoreNames];
    const tx = names.length ? db.transaction(names, 'readonly') : null;
    out[d.name] = { version: db.version, stores: tx ? await Promise.all(names.map((n) => new Promise((resolve) => {
      const os = tx.objectStore(n);
      const req = os.getAll();
      req.onsuccess = () => resolve({ n, keyPath: os.keyPath, auto: os.autoIncrement, indexes: [...os.indexNames].sort(), rows: hash(JSON.stringify(req.result)) });
    }))) : [] };
    db.close();
  }
  out.local = hash(JSON.stringify(Object.entries(localStorage).sort()));
  out.session = hash(JSON.stringify(Object.entries(sessionStorage).sort()));
  out.cookie = document.cookie;
  out.dom = hash(document.documentElement.outerHTML);
  out.field = document.getElementById('name').value;
  out.url = location.href;
  return JSON.stringify(out);
})()`;

let relay;
let pageServer;
let page;
let BASE;

async function api(method, route, body) {
  const res = await fetch(`${BASE}${route}`, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  return res.json();
}
const command = (type, params) => api('POST', '/command', { type, params });
const fingerprint = async () => page.evaluate(FINGERPRINT);

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
  page = await launchBrowser(findBrowser());
  await page.navigate(`http://127.0.0.1:${pagePort}/?webscout=1&webscout_port=${relay.port}`);
  for (let i = 0; i < 100; i += 1) {
    const health = (await api('GET', '/health')).result;
    if (health.agents_connected?.includes('default')) break;
    await sleep(100);
  }
});

after(async () => {
  await page?.close();
  await new Promise((resolve) => (pageServer ? pageServer.close(resolve) : resolve()));
  await relay?.stop();
});

test('the automatic briefing at session start creates nothing, even when the app has no database yet', { skip }, async () => {
  const before = await fingerprint();
  assert.deepEqual(JSON.parse(before).databases, [], 'the fixture starts with no database');
  const started = (await api('POST', '/sessions', { goal: 'read-only-contract.test.mjs no db', context: 'automated' })).result;
  assert.equal(started.briefing.available, false, 'nothing to brief on yet');
  assert.match(started.briefing.reason, /does not exist yet/, 'and it says why, instead of creating the database to have something to report');
  assert.equal(await fingerprint(), before, 'session start left the page exactly as it was');
  await api('POST', `/sessions/${started.id}/end`);
});

test('every read command leaves IndexedDB, storage, cookies and the DOM exactly as it found them', { skip }, async () => {
  await page.evaluate(`new Promise((resolve, reject) => {
    localStorage.setItem('theme', 'dark'); sessionStorage.setItem('draft', 'unsent'); document.cookie = 'visit=1';
    const req = indexedDB.open('AgentCapitalOS', 3);
    req.onupgradeneeded = () => {
      const notes = req.result.createObjectStore('notes', { keyPath: 'id', autoIncrement: true });
      notes.createIndex('by_tag', 'tag');
      req.result.createObjectStore('tags', { keyPath: 'name' });
    };
    req.onsuccess = () => {
      const tx = req.result.transaction(['notes', 'tags'], 'readwrite');
      for (let i = 1; i <= 3; i += 1) tx.objectStore('notes').put({ id: i, tag: 't' + i, body: 'body ' + i });
      tx.objectStore('tags').put({ name: 'alpha' });
      tx.oncomplete = () => { req.result.close(); resolve(true); };
    };
    req.onerror = () => reject(req.error);
  })`);
  await api('POST', '/sessions', { goal: 'read-only-contract.test.mjs reads', context: 'automated', briefing: false });
  await command('ping', {}); // let the agent settle any start-up work before the baseline
  const changed = [];
  const version = (await command('db.version', {})).result.version;
  for (const [type, { expectOk = true, ...raw }] of Object.entries(COVERED)) {
    const params = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, v === 'current+1' ? version + 1 : v]));
    const before = await fingerprint();
    const reply = await command(type, params);
    if (expectOk === true) assert.equal(reply.ok, true, `${type} should succeed on the fixture: ${reply.error}`);
    if (expectOk === false) assert.equal(reply.ok, false, `${type} is expected to fail on the fixture`);
    const after = await fingerprint();
    if (after !== before) changed.push(type);
  }
  assert.deepEqual(changed, [], 'these read commands changed the page');
  assert.deepEqual(page.errors, [], 'and raised no page errors');
});

test('the routes that read on the caller behalf (snapshot, verify) write nothing to the page either', { skip }, async () => {
  const before = await fingerprint();
  const snap = (await api('POST', '/state/snapshot', { stores: ['notes', 'tags'] })).result;
  assert.ok(snap.id);
  const verify = (await api('POST', '/state/verify', { baseline: String(snap.id), expect: 'notes:same,tags:same' })).result;
  assert.equal(verify.passed, true);
  assert.equal(await fingerprint(), before);
});

test('the fingerprint would notice a write (the checks above are not vacuous)', { skip }, async () => {
  const before = await fingerprint();
  assert.equal((await command('idb.put', { store: 'notes', row: { id: 77, tag: 'w', body: 'written' } })).ok, true);
  const afterWrite = await fingerprint();
  assert.notEqual(afterWrite, before, 'an IndexedDB write changes the fingerprint');
  await command('idb.delete', { store: 'notes', key: 77 });
  const beforeDom = await fingerprint();
  await page.evaluate(`document.getElementById('list').insertAdjacentHTML('beforeend', '<li>three</li>')`);
  assert.notEqual(await fingerprint(), beforeDom, 'and so does a DOM change');
});
