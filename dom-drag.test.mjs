// dom.drag in a real headless browser: the DataTransfer/DragEvent shim this needs (there is no
// way to generate real OS-level drag input from a page-side script), exercised against a real
// page implementing the standard HTML5 drag-and-drop contract (dragover must call
// preventDefault() for drop to fire) - not a mock of the DOM API. Skips itself when no
// Chromium/Edge binary is found, like the other connected-tab tests.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestRelay, freePort } from './test-relay.mjs';
import { browserSkip, findBrowser, launchBrowser, sleep } from './browser-harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const skip = process.env.WEBSCOUT_TEST_LIVE === '1' ? 'skipped under WEBSCOUT_TEST_LIVE=1 (this test drives its own tab)' : browserSkip();

// A real, minimal implementation of the HTML5 drag-and-drop contract - the target's own dragover
// listener calls preventDefault() (without it, "drop" never fires, by spec), and drop moves the
// dragged element into the target. This is exactly the app-side logic dom.drag's own doc says it
// exercises rather than fakes.
const PAGE = `<!doctype html><html><head><title>fixture</title></head><body>
<div id="source" draggable="true">card</div>
<div id="target"></div>
<div id="locked-target"></div>
<script>
  const source = document.getElementById('source');
  source.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/plain', 'source'));
  for (const id of ['target', 'locked-target']) {
    const el = document.getElementById(id);
    if (id === 'target') el.addEventListener('dragover', (e) => e.preventDefault());
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.appendChild(document.getElementById('source'));
      window.__dropCount = (window.__dropCount || 0) + 1;
    });
  }
</script>
<script src="/inject.js"></script></body></html>`;

let relay;
let pageServer;
let page;
let BASE;

async function api(method, route, body) {
  const res = await fetch(`${BASE}${route}`, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  return res.json();
}
const command = (type, params) => api('POST', '/command', { type, params });

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
  await api('POST', '/sessions', { goal: 'dom-drag.test.mjs', context: 'automated' });
});

after(async () => {
  await page?.close();
  await new Promise((resolve) => (pageServer ? pageServer.close(resolve) : resolve()));
  await relay?.stop();
});

test('dom.drag fires a real dragstart/dragenter/dragover/drop/dragend sequence a listening app can act on', { skip }, async () => {
  const before = await page.evaluate('document.getElementById("target").contains(document.getElementById("source"))');
  assert.equal(before, false, 'source starts outside target');
  const result = (await command('dom.drag', { selector: '#source', to: '#target' })).result;
  assert.equal(result.dragged, true);
  assert.equal(result.dropAccepted, true, 'the target\'s dragover listener called preventDefault()');
  assert.equal(result.mutated, true, 'the drop handler moved a real DOM node');
  const after = await page.evaluate('document.getElementById("target").contains(document.getElementById("source"))');
  assert.equal(after, true, 'the drop handler actually ran and moved the source element into the target');
  const dropCount = await page.evaluate('window.__dropCount');
  assert.equal(dropCount, 1);
});

test('a target whose dragover never calls preventDefault() never receives the drop (real HTML5 contract, not faked)', { skip }, async () => {
  await page.evaluate('document.getElementById("target").appendChild(document.getElementById("source"))'); // reset position
  const before = await page.evaluate('window.__dropCount');
  const result = (await command('dom.drag', { selector: '#source', to: '#locked-target' })).result;
  assert.equal(result.dropAccepted, false, 'no dragover listener means nothing ever called preventDefault()');
  const inLocked = await page.evaluate('document.getElementById("locked-target").contains(document.getElementById("source"))');
  assert.equal(inLocked, false, 'no preventDefault() on dragover means the spec never fires drop, so the element never moved');
  const after = await page.evaluate('window.__dropCount');
  assert.equal(after, before, 'drop handler never ran');
});

test('dom.drag with a nonexistent source or target selector fails clearly, drags nothing', { skip }, async () => {
  const missingSource = await command('dom.drag', { selector: '#does-not-exist', to: '#target' });
  assert.equal(missingSource.ok, false);
  assert.match(missingSource.error, /no element matches selector/);

  const missingTarget = await command('dom.drag', { selector: '#source', to: '#also-missing' });
  assert.equal(missingTarget.ok, false);
  assert.match(missingTarget.error, /no element matches selector/);
});
