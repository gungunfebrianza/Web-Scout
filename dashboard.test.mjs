// Guards the dashboard's panel shell. Part A is static and always runs: every
// <section class="hud-section"> needs a PANELS registry entry (a bare section
// gets no head, collapse, freshness or export chrome, and nothing errors), and
// the inline scripts must parse. Part B loads the real dashboard from an
// ephemeral relay in a headless Chromium/Edge over CDP and asserts the shell
// actually wrapped every panel with no page errors; it skips itself when no
// browser binary is available, like the connected-tab tests.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { connectFakeAgent, startTestRelay } from './test-relay.mjs';
import { browserSkip, findBrowser, launchBrowser, sleep } from './browser-harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8');

// Panels without an `exportRows` on purpose. A new entry here needs a reason.
const NO_EXPORT_REASON = {
  timelineSection: 'derived view merged from the other panels; each source panel exports its own rows',
  actionsSection: 'has its own richer export (action log toolbar), not the generic row exporter',
};

function sectionIds() {
  const ids = [];
  for (const m of html.matchAll(/<section\b([^>]*)>/g)) {
    const attrs = m[1];
    const cls = /\bclass\s*=\s*"([^"]*)"/.exec(attrs)?.[1] ?? '';
    const id = /\bid\s*=\s*"([^"]*)"/.exec(attrs)?.[1];
    if (id && cls.split(/\s+/).includes('hud-section')) ids.push(id);
  }
  return ids;
}

// One registry entry per line: `  someSection: { group: ..., ... },`
function panelEntries() {
  const start = html.indexOf('const PANELS = {');
  assert.ok(start !== -1, 'const PANELS registry not found in dashboard.html');
  const end = html.indexOf('\n};', start);
  const entries = {};
  for (const line of html.slice(start, end).split('\n').slice(1)) {
    const m = /^ {2}(\w+): \{(.*)\},?\s*$/.exec(line);
    if (m) entries[m[1]] = m[2];
  }
  return entries;
}

describe('dashboard panel registry (static)', () => {
  const sections = sectionIds();
  const entries = panelEntries();

  test('finds sections and registry entries', () => {
    assert.ok(sections.length >= 15, `only ${sections.length} hud-section(s) found`);
    assert.ok(Object.keys(entries).length >= 15, `only ${Object.keys(entries).length} PANELS entries parsed`);
  });

  test('every hud-section has a PANELS entry (else it gets no shell chrome)', () => {
    const missing = sections.filter((id) => !(id in entries));
    assert.deepEqual(missing, [], `section(s) with no PANELS entry: ${missing.join(', ')}`);
  });

  test('every PANELS entry has a matching hud-section', () => {
    const orphans = Object.keys(entries).filter((id) => !sections.includes(id));
    assert.deepEqual(orphans, [], `PANELS entr(ies) with no <section class="hud-section" id=...>: ${orphans.join(', ')}`);
  });

  test('section ids are unique', () => {
    const dupes = sections.filter((id, i) => sections.indexOf(id) !== i);
    assert.deepEqual(dupes, []);
  });

  test('every entry declares group, label, count and refresh; exportRows or a documented reason', () => {
    const problems = [];
    for (const [id, body] of Object.entries(entries)) {
      if (!/\bgroup: '(global|session)'/.test(body)) problems.push(`${id}: group must be 'global' or 'session'`);
      if (!/\blabel: '[^']+'/.test(body)) problems.push(`${id}: no label`);
      if (!/\bcount: /.test(body)) problems.push(`${id}: no count`);
      if (!/\brefresh: /.test(body)) problems.push(`${id}: no refresh`);
      if (!/\bexportRows: /.test(body) && !NO_EXPORT_REASON[id]) problems.push(`${id}: no exportRows and no entry in NO_EXPORT_REASON`);
    }
    assert.deepEqual(problems, []);
  });

  test('NO_EXPORT_REASON only lists panels that really lack exportRows', () => {
    const stale = Object.keys(NO_EXPORT_REASON).filter((id) => !(id in entries) || /\bexportRows: /.test(entries[id]));
    assert.deepEqual(stale, []);
  });

  test('every hud-section has an <h2> child (the shell builds the head around it)', () => {
    const missing = [];
    for (const id of sections) {
      const open = html.search(new RegExp(`<section\\b[^>]*\\bid="${id}"`));
      const chunk = html.slice(open, open + 600);
      if (!/<h2\b/.test(chunk)) missing.push(id);
    }
    assert.deepEqual(missing, []);
  });

  test('inline <script> blocks parse', () => {
    let n = 0;
    for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
      if (/\bsrc\s*=/.test(m[1]) || /type\s*=\s*"module"/.test(m[1])) continue;
      n += 1;
      assert.doesNotThrow(() => new vm.Script(m[2], { filename: `dashboard.html <script #${n}>` }));
    }
    assert.ok(n >= 1, 'no inline script found');
  });
});

describe('dashboard in a headless browser', () => {
  const browser = findBrowser();

  test('shell wraps every panel with no page errors', { skip: browserSkip(), timeout: 90000 }, async () => {
    const panelIds = Object.keys(panelEntries());
    const relay = await startTestRelay();
    let page;
    try {
      page = await launchBrowser(browser);
      const { evaluate, errors } = page;
      await page.navigate(`http://127.0.0.1:${relay.port}/dashboard`);

      const probeExpr = `(() => {
        const ids = ${JSON.stringify(panelIds)};
        const wrapped = {};
        for (const id of ids) {
          const s = document.getElementById(id);
          wrapped[id] = !!s && !!s.querySelector(':scope > .hud-section-head') && !!s.querySelector(':scope > .hud-section-body');
        }
        const sv = document.getElementById('savingsSection');
        const pill = sv && sv.querySelector('.hud-count');
        return { wrapped, savingsCount: pill ? { hidden: pill.hidden, text: pill.textContent } : null };
      })()`;
      let probe;
      const deadline = Date.now() + 25000;
      while (Date.now() < deadline) {
        probe = await evaluate(probeExpr);
        if (probe && Object.values(probe.wrapped).every(Boolean) && probe.savingsCount && !probe.savingsCount.hidden) break;
        await sleep(300);
      }

      const unwrapped = Object.entries(probe?.wrapped ?? {}).filter(([, ok]) => !ok).map(([k]) => k);
      assert.deepEqual(unwrapped, [], `panel(s) not wrapped by the shell (need .hud-section-head + .hud-section-body): ${unwrapped.join(', ')}`);
      assert.ok(probe.savingsCount, 'savingsSection has no .hud-count pill');
      assert.equal(probe.savingsCount.hidden, false, 'savingsSection count pill never became visible');
      assert.ok(probe.savingsCount.text.trim().length > 0, 'savingsSection count pill is empty');
      assert.deepEqual(errors, [], `page errors:\n${errors.join('\n')}`);
    } finally {
      await page?.close();
      await relay.stop();
    }
  });

  test('the savings panel shows whether scoping is working (re-read and outline rates)', { skip: browserSkip() || (process.env.WEBSCOUT_TEST_LIVE === '1' ? 'needs its own relay' : false), timeout: 90000 }, async () => {
    const relay = await startTestRelay();
    let page;
    let tab;
    try {
      const api = async (method, route, body) => (await (await fetch(`http://127.0.0.1:${relay.port}${route}`, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined })).json()).result;
      tab = await connectFakeAgent(relay.port, {
        'idb.dump': (p) => (p.store === 'big' ? { rows: Array.from({ length: 60 }, (_, i) => ({ id: i, pad: 'x'.repeat(50) })) } : { rows: p.where ? [1] : [1, 2, 3] }),
        'dom.query': (p) => (p.full ? { found: true, outerHTML: '<x/>' } : { found: true, outline: ['body [1 children]'] }),
      }, { name: 'default', epoch: 0 });
      await api('POST', '/sessions', { goal: 'dashboard.test.mjs', context: 'automated' });
      tab.state.avoided = 2000;
      await api('POST', '/command', { type: 'idb.dump', params: { store: 's', where: { id: 1 } } });
      await api('POST', '/command', { type: 'idb.dump', params: { store: 's' } });
      tab.state.outlineOld = 3000;
      await api('POST', '/command', { type: 'dom.query', params: { selector: 'body' } });
      await api('POST', '/command', { type: 'dom.query', params: { selector: 'body', full: true } });
      await api('POST', '/command', { type: 'idb.dump', params: { store: 'big' }, opts: { table: true } });

      page = await launchBrowser(browser);
      await page.navigate(`http://127.0.0.1:${relay.port}/dashboard`);
      let text = '';
      const deadline = Date.now() + 25000;
      while (Date.now() < deadline && !/whole-page outlines/.test(text)) {
        text = (await page.evaluate(`(() => { const n = document.getElementById('readStrategyNote'); return n && !n.hidden ? n.textContent : ''; })()`)) || '';
        if (!/whole-page outlines/.test(text)) await sleep(300);
      }
      assert.match(text, /100% of 1 scoped reads were followed by the same read unscoped/);
      assert.match(text, /1 whole-page outlines: 0% drilled into a child, 100% needed --full/);
      assert.match(text, /0 pointers, 0 deltas, 1 tables, 0 peeks/);
      assert.match(text, /kept off the caller's screen/);
      assert.match(text, /token figures are chars\/4/);
      assert.deepEqual(page.errors, [], `page errors: ${page.errors.join(' | ')}`);
    } finally {
      tab?.close();
      await page?.close();
      await relay.stop();
    }
  });
});
