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
