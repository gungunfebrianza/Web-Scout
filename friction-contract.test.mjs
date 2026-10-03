// Contract: every surface that talks about a selector's friction derives from ONE set of facts, so
// they cannot drift apart again. Round 1/2 grew a header, an error body, an analytics list and two
// hand-written printers (CLI + MCP) that each computed their own version; this pins the seams:
//   - the pre-action header, the failure's error body, `friction explain` and the analytics row
//     all report the same numbers for the same target,
//   - the dashboard panel reads that same analytics list,
//   - the CLI and the MCP server print a failure's friction through one shared formatter.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestRelay, connectFakeAgent } from './test-relay.mjs';
import { describeFailureContext } from './friction.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const source = (file) => fs.readFileSync(path.join(dir, file), 'utf8');

test('header, error body, explain and analytics agree about one target', async () => {
  const relay = await startTestRelay({ env: { WEBSCOUT_ANALYTICS_CACHE_MS: '0' } });
  const tab = await connectFakeAgent(relay.port, { 'dom.click': () => { throw new Error('command timed out after 15000ms'); } });
  const call = async (method, route, body) => {
    const res = await fetch(`http://127.0.0.1:${relay.port}${route}`, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
    return { res, json: await res.json() };
  };
  try {
    await call('POST', '/sessions', { goal: 'contract', context: 'friction-contract.test.mjs', briefing: false });
    const click = () => call('POST', '/command', { type: 'dom.click', params: { selector: '#contract' } });
    await click(); await click();
    const third = await click();
    const header = third.res.headers.get('x-webscout-selector-risk');
    const bodyContext = third.json.extra.selectorFriction;
    assert.ok(header, 'the third attempt is warned');

    const explain = (await call('GET', `/friction/explain?type=dom.click&selector=${encodeURIComponent('#contract')}`)).json.result;
    assert.deepEqual(explain.failureContext, bodyContext, 'explain and the error body are the same object');
    assert.equal(explain.thisSession.fails, bodyContext.failuresThisSession);
    assert.equal(explain.thisSession.errorClass, bodyContext.errorClass);
    assert.match(header, new RegExp(`failed ${bodyContext.failuresThisSession - 1}x already this session`), 'the header was judged on the failures before the call that then failed');
    assert.match(header, new RegExp(`\\[${bodyContext.errorClass}\\]`));

    const analytics = (await call('GET', '/analytics')).json.result;
    const row = analytics.selectorFriction.find((f) => f.selector === '#contract');
    assert.equal(row.failCount, (explain.history?.failCount ?? 0) + explain.thisSession.fails, 'analytics counts what explain splits into history + this session');
    assert.equal(row.key, explain.key);
    assert.equal(analytics.topFailedSelectors, undefined, 'the legacy alias is retired: one name for one list');
  } finally {
    await tab.close();
    await relay.stop();
  }
});

test('the CLI and the MCP server print a failure\'s friction through the shared formatter', () => {
  for (const file of ['cli.mjs', 'mcp-server.mjs']) {
    const text = source(file);
    assert.match(text, /import \{ describeFailureContext \} from '\.\/friction\.mjs'/, `${file} imports the shared formatter`);
    assert.match(text, /describeFailureContext\(err\.selectorFriction\)/, `${file} prints through it`);
    assert.doesNotMatch(text, /Friction: \$\{/, `${file} must not hand-roll the line again`);
  }
  assert.match(describeFailureContext({ errorClass: 'timeout', failuresThisSession: 2, priorFailures: 1 }), /^Friction: timeout failure, 2x this session, 1x in earlier sessions/);
});

test('the dashboard panel and its counters read selectorFriction, the list the warning is built from', () => {
  const html = source('dashboard.html');
  const graph = html.slice(html.indexOf('function renderSelectorGraph'), html.indexOf('function renderSelectorGraph') + 400);
  assert.match(graph, /a\.selectorFriction/);
  assert.match(html, /selectorsSection: \{[^\n]*lastAnalyticsData\?\.selectorFriction\?\.length/);
  assert.match(html, /function renderFrictionDetail/, 'the detail table with the mark-fixed controls exists');
  assert.match(html, /data-friction-act="resolve"/);
});

test('nothing friction-related is frozen per session any more, and every resolve scope shares one writer', () => {
  const relay = source('relay.mjs');
  assert.doesNotMatch(relay, /sessionFrictionSnapshot/, 'the macro nudge reads macroCandidates() on demand');
  assert.equal((relay.match(/dbApi\.markFrictionResolved\(/g) ?? []).length, 2, 'declareFrictionResolved is the only caller (its scope branch + its target branch)');
  assert.match(relay, /declareFrictionResolved\(type, target\.value, target\.kind, body\.note\)/, '/friction/resolve goes through it');
  assert.match(relay, /declareFrictionResolved\(s\.type, s\.selector, s\.targetKind/, 'session end --apply-suggestions goes through it');
});
