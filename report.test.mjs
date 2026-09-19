// buildReportMarkdown is pure formatting - pinned here without a relay or a real DB. The
// "## Session visualizations" section (added alongside sequence/waste/cost/causality/route-FSM,
// see [[web-scout-session-viz-round]]) is the part under test: a report built before it existed had
// zero trace of any of session-viz.mjs's own output.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildReportMarkdown, buildReportJson } from './report.mjs';
import { buildSessionViz } from './session-viz.mjs';

const BASE = Date.parse('2026-09-19T10:00:00.000Z');
let nextId = 1;
function act(type, at, { dur = 200, ok = true, agent = 'default', params = null, id, resultHash = null, error = null, bytes = 0 } = {}) {
  return {
    id: id ?? nextId++, type, params, ok: ok ? 1 : 0, error: ok ? null : (error ?? 'boom'), agent_name: agent, result_hash: resultHash, params_hash: null,
    started_at: new Date(BASE + at * 1000).toISOString(), ended_at: new Date(BASE + at * 1000 + dur).toISOString(), duration_ms: dur,
    intent: null, intent_source: null, intent_call: null, bytes,
  };
}

function baseSession() { return { id: 1, goal: 'test the report', status: 'ended', started_at: new Date(BASE).toISOString(), ended_at: null, tags: [], context: null, strict_crv: false }; }

function baseBundle(viz) {
  return {
    session: baseSession(), actions: [], snapshots: [], diffs: [], qa: [], console: [], net: [], verityRuns: [],
    tokenReport: { totalCalls: 0, totalEstTokens: 0, byType: [] }, repeatedActionLoops: [], viz,
  };
}

describe('buildReportMarkdown', () => {
  test('omits "## Session visualizations" entirely when no viz is given (older caller / cached bundle)', () => {
    const md = buildReportMarkdown(baseBundle(undefined));
    assert.ok(!md.includes('## Session visualizations'));
    assert.ok(md.includes('# Web-scout Session Report'));
  });

  test('a session with a retried-then-recovered call and a page navigation reports every subsection with real content', () => {
    const rows = [
      act('dom.click', 0, { params: { selector: '#nav' }, resultHash: 'h1', bytes: 40 }),
      act('idb.dump', 1, { params: { store: 'todos' }, ok: false, error: 'timeout', bytes: 0 }),
      act('idb.dump', 2, { params: { store: 'todos' }, resultHash: 'h2', bytes: 500 }),
    ];
    const clicks = [{ id: rows[0].id, startedAt: rows[0].started_at, agentName: 'default', hrefChanged: true, hrefBefore: 'http://x/#/home', href: 'http://x/#/list' }];
    const viz = buildSessionViz({ session: baseSession(), actions: rows, snapshots: [], diffs: [], clicks });
    const md = buildReportMarkdown(baseBundle(viz));

    assert.ok(md.includes('## Session visualizations'));
    for (const heading of [
      '### State machine', '### Episodes', '### Causality', '### Sequence',
      '### Route / page FSM', '### Waste and retries', '### Cost breakdown', '### Failure heatmap',
    ]) assert.ok(md.includes(heading), `missing ${heading}`);

    // Real evidence, not just headings: the retry chain, the recovered outcome and the page nav
    // all show up as actual content, not "_none_"/"no navigation" placeholders.
    assert.match(md, /Retries:\n- idb\.dump todos - #\d+, #\d+ - recovered/);
    assert.ok(md.includes('| /#/home | 1 |') || md.includes('| /#/list | 1 |'), 'route table should list the two pages visited');
    assert.ok(!md.includes('_No page navigation detected'));
  });

  test('buildReportJson round-trips the viz field untouched (no markdown-only shaping leaks into JSON)', () => {
    const viz = buildSessionViz({ session: baseSession(), actions: [], snapshots: [], diffs: [], clicks: [] });
    const json = JSON.parse(buildReportJson(baseBundle(viz)));
    assert.deepEqual(json.viz.causality.roots, []);
    assert.equal(json.viz.routeMachine.nodes.length, 0);
  });
});
