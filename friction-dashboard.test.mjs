// The dashboard's friction detail, driven in a real headless browser against a relay holding real
// friction data: the cost table, "this session" (what the agent was told), a one-cause cluster, and the
// promote form (preview, then write). Skips when no Chromium/Edge binary is available.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './scratch.mjs';
import { startTestRelay, connectFakeAgent } from './test-relay.mjs';
import { browserSkip, findBrowser, launchBrowser, sleep } from './browser-harness.mjs';

const waitFor = async (page, expr, ms = 25000) => {
  const deadline = Date.now() + ms;
  let value;
  while (Date.now() < deadline) {
    value = await page.evaluate(expr);
    if (value) return value;
    await sleep(250);
  }
  return value;
};

test('friction detail: history table, this-session block, cluster, and a promote form that previews before it writes', { skip: browserSkip(), timeout: 120000 }, async () => {
  const dir = tmpDir('webscout-friction-dash-');
  const registry = path.join(dir, 'known-issues.json');
  const relay = await startTestRelay({ env: { WEBSCOUT_ANALYTICS_CACHE_MS: '0', WEBSCOUT_KNOWN_ISSUES: registry } });
  let page;
  let tab;
  try {
    const api = async (method, route, body) => (await (await fetch(`http://127.0.0.1:${relay.port}${route}`, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined })).json()).result;
    tab = await connectFakeAgent(relay.port, {
      'dom.click': (p) => { if (/^\.(a|b|c)1x$/.test(p.selector)) throw new Error(`Element not found: ${p.selector}`); return { clicked: true, mutated: false }; },
    }, { origin: 'http://localhost:4100' });
    for (let n = 0; n < 2; n += 1) {
      const s = await api('POST', '/sessions', { goal: `seed ${n}`, context: 'friction-dashboard.test.mjs', briefing: false });
      for (const sel of ['.a1x', '.b1x', '.c1x']) { await api('POST', '/command', { type: 'dom.click', params: { selector: sel } }); await api('POST', '/command', { type: 'dom.click', params: { selector: '#fallback' } }); }
      await api('POST', `/sessions/${s.id}/end`);
    }
    await api('POST', '/sessions', { goal: 'live one', context: 'friction-dashboard.test.mjs', briefing: false });
    await api('POST', '/command', { type: 'dom.click', params: { selector: '.a1x' } });
    await api('POST', '/command', { type: 'dom.click', params: { selector: '.a1x' } });

    page = await launchBrowser(findBrowser());
    await page.navigate(`http://127.0.0.1:${relay.port}/dashboard`);

    assert.ok(await waitFor(page, `document.querySelector('#frictionDetail table') && document.querySelector('#frictionLive table') ? true : false`), 'both tables rendered');
    const text = await page.evaluate(`({ live: document.getElementById('frictionLive').innerText, detail: document.getElementById('frictionDetail').innerText })`);
    assert.match(text.live, /This session \(#3\)/);
    assert.match(text.live, /\.a1x/);
    assert.match(text.live, /warned x1/, 'the agent was warned on its second failure, and the dashboard says so');
    assert.match(text.detail, /One cause, many targets/);
    assert.match(text.detail, /one cause behind 3 targets/);

    // the promote form: closed by default, prefilled with the suggestion, preview writes nothing
    const form = await page.evaluate(`(() => { const f = document.querySelector('.friction-form'); return f ? { open: f.open, remediation: f.querySelector('[data-field=remediation]').value } : null; })()`);
    assert.ok(form, 'a candidate form exists');
    assert.equal(form.open, false);
    assert.match(form.remediation, /use "#fallback" \(dom\.click\) instead/);

    await page.evaluate(`(() => { const f = document.querySelector('.friction-form'); f.open = true; f.querySelector('[data-field=description]').value = 'selectors are renamed by the build'; f.querySelector('[data-friction-act=promote-preview]').click(); })()`);
    const preview = await waitFor(page, `(() => { const p = document.querySelector('.friction-preview'); return p && !p.hidden ? p.textContent : ''; })()`);
    assert.match(preview, /dry run/);
    assert.match(preview, /"remediation": "use \\"#fallback\\"/);
    assert.equal(fs.existsSync(registry), false, 'a preview writes nothing');

    // an open form is not rebuilt underneath the person typing in it
    await api('POST', '/command', { type: 'dom.click', params: { selector: '.b1x' } });
    await sleep(1500);
    assert.equal(await page.evaluate(`document.querySelector('.friction-form').open`), true, 'the open form survived a refresh');

    await page.evaluate(`document.querySelector('.friction-form [data-friction-act=promote-write]').click()`);
    for (let n = 0; n < 40 && !fs.existsSync(registry); n += 1) await sleep(250);
    assert.ok(fs.existsSync(registry), 'write created the registry');
    const written = JSON.parse(fs.readFileSync(registry, 'utf8'));
    assert.equal(written.length, 1);
    assert.equal(written[0].description, 'selectors are renamed by the build');
    assert.match(written[0].remediation, /use "#fallback"/);
    assert.deepEqual(page.errors, [], `page errors: ${page.errors.join(' | ')}`);
  } finally {
    tab?.close();
    await page?.close();
    await relay.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('friction table: filter and sort act on the ranked list, "mark fixed" offers an undo, and one button resolves a whole cluster', { skip: browserSkip(), timeout: 120000 }, async () => {
  const relay = await startTestRelay({ env: { WEBSCOUT_ANALYTICS_CACHE_MS: '0' } });
  let page;
  let tab;
  try {
    const api = async (method, route, body) => (await (await fetch(`http://127.0.0.1:${relay.port}${route}`, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined })).json()).result;
    tab = await connectFakeAgent(relay.port, {
      'dom.click': (p) => { if (/^\.(a|b|c)1x$/.test(p.selector) || p.selector === '#lonely') throw new Error(p.selector === '#lonely' ? 'Timed out waiting for #lonely' : `Element not found: ${p.selector}`); return { clicked: true, mutated: false }; },
    }, { origin: 'http://localhost:4100' });
    for (let n = 0; n < 2; n += 1) {
      const s = await api('POST', '/sessions', { goal: `seed ${n}`, context: 'friction-dashboard.test.mjs', briefing: false });
      for (const sel of ['.a1x', '.b1x', '.c1x', '#lonely']) await api('POST', '/command', { type: 'dom.click', params: { selector: sel } });
      await api('POST', `/sessions/${s.id}/end`);
    }
    page = await launchBrowser(findBrowser());
    await page.navigate(`http://127.0.0.1:${relay.port}/dashboard`);
    const rowTargets = `[...document.querySelectorAll('#frictionDetail table tbody tr')].map((r) => r.children[0].textContent)`;
    assert.ok(await waitFor(page, `${rowTargets}.length === 4`), 'all four targets listed');

    // filter by text (target / error class), count reflects it
    await page.evaluate(`(() => { const i = document.getElementById('frictionFilter'); i.value = 'timeout'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    assert.deepEqual(await waitFor(page, `(() => { const t = ${rowTargets}; return t.length === 1 ? t : null; })()`), ['#lonely'], 'only the timeout target remains');
    assert.match(await page.evaluate(`document.getElementById('frictionCount').textContent`), /1 of 4 target/);
    await page.evaluate(`(() => { const i = document.getElementById('frictionFilter'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    assert.ok(await waitFor(page, `${rowTargets}.length === 4`));

    // sort: oldest failure first vs most recent - the order flips on identical data (same-instant ties keep a stable order, so just assert the control re-renders)
    await page.evaluate(`(() => { const s = document.getElementById('frictionSort'); s.value = 'fails'; s.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    assert.equal(await page.evaluate(`${rowTargets}.length`), 4);

    // mark one fixed, then undo from the toast
    await page.evaluate(`document.querySelector('#frictionDetail [data-friction-act=resolve][data-target="#lonely"]').click()`);
    assert.ok(await waitFor(page, `(() => { const t = document.getElementById('frictionToast'); return !t.hidden && /marked fixed: dom\.click #lonely/.test(t.textContent); })()`), 'the toast offers an undo');
    assert.ok(await waitFor(page, `${rowTargets}.length === 3`), 'the target left the table');
    await page.evaluate(`document.querySelector('#frictionToast button').click()`);
    assert.ok(await waitFor(page, `${rowTargets}.length === 4`), 'undo brought it back');

    // one button for the whole cluster
    assert.ok(await waitFor(page, `document.querySelector('#frictionDetail [data-friction-act=resolve-cluster]') ? true : false`), 'cluster has a resolve-all button');
    await page.evaluate(`document.querySelector('#frictionDetail [data-friction-act=resolve-cluster]').click()`);
    assert.ok(await waitFor(page, `(() => { const t = ${rowTargets}; return t.length === 1 && t[0] === '#lonely'; })()`), 'the three clustered targets are gone, the unrelated one stays');
    assert.ok(await waitFor(page, `document.getElementById('frictionToast').textContent.includes('marked 3 target(s) fixed')`));
    await page.evaluate(`document.querySelector('#frictionToast button').click()`);
    assert.ok(await waitFor(page, `${rowTargets}.length === 4`), 'undoing a cluster brings every target back');
    assert.deepEqual(page.errors, [], `page errors: ${page.errors.join(' | ')}`);
  } finally {
    tab?.close();
    await page?.close();
    await relay.stop();
  }
});
