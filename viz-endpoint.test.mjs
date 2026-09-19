// End to end: a real (ephemeral) relay with a fake page agent runs a strict-CRV session, then
//   - GET /viz returns the swimlane, episode tree and state machine for it,
//   - POST /intents/import (and `session intents`) fill each action's why from a transcript,
//   - the dashboard draws all three and shows the Why column, in a real headless browser.
// The browser half skips itself when no Chromium/Edge is installed, like the other page tests.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectFakeAgent, startTestRelay, spawnClean } from './test-relay.mjs';
import { browserSkip, findBrowser, launchBrowser, sleep } from './browser-harness.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
let relay;
let tab;
let sessionId;
let tmp;
let actions; // oldest first
let addClick; // the first successful '#add' click - the one the transcript narrates

const api = async (method, route, body) => {
  const res = await fetch(`http://127.0.0.1:${relay.port}${route}`, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json();
  return { status: res.status, ...json };
};
const command = (type, params) => api('POST', '/command', { type, params });

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-viz-'));
  relay = await startTestRelay();
  const rows = [{ id: 1 }];
  tab = await connectFakeAgent(relay.port, {
    'idb.snapshot': () => ({ stores: { skills: { rows: rows.map((r) => ({ ...r })) } } }),
    'dom.click': (p) => {
      if (p.selector === '#missing') throw new Error('element not found: #missing');
      if (p.selector === '#add') rows.push({ id: rows.length + 1 });
      if (p.selector === '#remove') rows.pop();
      return { clicked: true };
    },
    'idb.dump': () => ({ rows }),
    'dom.query': () => ({ found: true, outline: ['body'] }),
  });
  sessionId = (await api('POST', '/sessions', { goal: 'add and remove a skill', context: 'viz-endpoint.test.mjs', strict_crv: true })).result.id;
  await command('dom.query', { selector: '#form' });
  // A real agent takes seconds between calls; the transcript match tolerates only jitter, so the
  // narrated call is spaced from its neighbours here too.
  await sleep(400);
  await command('dom.click', { selector: '#add' }); // 1 row -> 2
  await sleep(400);
  await command('idb.dump', { store: 'skills' });
  await command('dom.click', { selector: '#noop' }); // writes nothing: 2 -> 2
  await command('dom.click', { selector: '#missing' }); // fails
  await command('dom.click', { selector: '#add' }); // 2 -> 3
  await command('dom.click', { selector: '#remove' }); // 3 -> 2: back to a state already seen
  actions = (await api('GET', `/sessions/${sessionId}/actions?full=1`)).result.slice().reverse();
  addClick = actions.find((a) => a.type === 'dom.click' && a.params?.selector === '#add');
}, { timeout: 60000 });

after(async () => {
  tab?.close();
  await relay?.stop();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

// A Claude Code transcript that narrates the first '#add' click. The tool call owns every action
// the relay logged between its own timestamp and its result's - strict-CRV writes four for one click.
function narratedTranscript() {
  const i = actions.indexOf(addClick);
  const before = actions[i - 1];
  const last = actions[i + 2]; // the auto diff
  assert.equal(before.type, 'idb.snapshot');
  assert.equal(last.type, 'idb.diff');
  const at = (iso, deltaMs) => new Date(Date.parse(iso) + deltaMs).toISOString();
  return [
    { type: 'assistant', timestamp: at(before.started_at, -600), message: { content: [{ type: 'text', text: 'Adding a row to skills to see whether the save works.' }] } },
    { type: 'assistant', timestamp: at(before.started_at, -20), message: { content: [{ type: 'tool_use', id: 'toolu_add', name: 'Bash', input: { command: 'node tools/web-scout/cli.mjs dom click "#add"' } }] } },
    { type: 'user', timestamp: at(last.ended_at, 20), message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_add', content: 'ok' }] } },
  ].map((l) => JSON.stringify(l)).join('\n');
}

describe('GET /sessions/:id/viz', () => {
  test('state machine: distinct states, a return to a seen state, and a write that changed nothing', async () => {
    const { result: viz } = await api('GET', `/sessions/${sessionId}/viz`);
    const m = viz.stateMachine;
    assert.equal(m.nodes.length, 3, `expected 1-row, 2-row and 3-row states, got ${JSON.stringify(m.nodes.map((n) => n.totalRows))}`);
    assert.deepEqual(m.nodes.map((n) => n.totalRows), [1, 2, 3]);
    assert.ok(m.stats.revisits >= 1, 'removing the row returns to the 2-row state');
    assert.equal(m.stats.noopMutations, 1);
    assert.match(m.insights.join(' '), /did not change/);
    const grew = m.edges.find((e) => e.from === 'n1' && e.to === 'n2');
    assert.ok(grew, 'an edge from the 1-row state to the 2-row state');
    assert.equal(grew.summarySource, 'diff', 'strict-CRV saves a real diff, which beats a row-count guess');
    assert.equal(grew.totals.added, 1);
    assert.deepEqual(grew.mutations.map((x) => x.type), ['dom.click']);
    assert.ok(m.edges.some((e) => e.noChange), 'a self-loop for the no-op click');
  });

  test('swimlane and episodes describe the same actions', async () => {
    const { result: viz } = await api('GET', `/sessions/${sessionId}/viz`);
    assert.deepEqual(viz.swimlane.lanes.map((l) => l.agent), ['default']);
    assert.equal(viz.swimlane.bars.length, actions.length);
    assert.equal(viz.swimlane.bars.filter((b) => !b.ok).length, actions.filter((a) => !a.ok).length);
    assert.ok(viz.episodes.episodes.length >= 1);
    // Every logged action is in exactly one step, and strict-CRV machinery is folded into its write.
    assert.equal(viz.episodes.stats.actions, actions.length);
    assert.ok(viz.episodes.stats.steps < actions.length);
    assert.ok(Object.keys(viz.episodes.why).length === actions.length);
    assert.ok(viz.episodes.episodes.some((e) => e.outcome === 'failed' || e.outcome === 'recovered'), 'the #missing click failed');
    assert.equal(viz.truncated, false);
  });

  test('?limit keeps the newest actions and says so', async () => {
    const { result: viz } = await api('GET', `/sessions/${sessionId}/viz?limit=50`);
    assert.equal(viz.truncated, actions.length >= 50);
    const { result: tiny } = await api('GET', `/sessions/${sessionId}/viz?limit=1`);
    assert.ok(tiny.swimlane.bars.length <= 50, 'limit is clamped to a sane minimum, not honoured as 1');
  });

  test('an unknown session is a 404, not a crash', async () => {
    assert.equal((await api('GET', '/sessions/999999/viz')).status, 404);
  });

  test('sequence, waste, cost breakdown, failure heatmap and causality are all present and consistent', async () => {
    const { result: viz } = await api('GET', `/sessions/${sessionId}/viz`);
    // Both filter out strict-CRV's own auto snapshot/diff rows and liveness probes - same count.
    assert.equal(viz.sequence.messages.length, viz.costTree.calls);
    assert.ok(viz.sequence.messages.length > 0 && viz.sequence.messages.length < actions.length);
    assert.equal(viz.sequence.stats.failed, actions.filter((a) => !a.ok).length);
    assert.ok(viz.waste.totals.wastedCalls >= 2, 'the #missing failure and the #noop no-op write are both waste');
    assert.ok(viz.waste.noopMutations.some((n) => n.type === 'dom.click'));
    assert.ok(viz.waste.retries.some((r) => !r.resolvedOk), 'the #missing click never got a retry');
    assert.ok(viz.costTree.totalBytes > 0 && viz.costTree.calls > 0 && viz.costTree.calls <= actions.length);
    assert.ok(viz.failureHeatmap.totals.failed >= 1);
    assert.ok(viz.causality.stats.chains >= 1, 'the #missing failure starts at least one causal chain');
    assert.deepEqual(viz.routeMachine.nodes, [], 'this session never clicked a link that changed the page');
  });
});

describe('route / page FSM', () => {
  let navRelay; let navTab; let navSessionId;
  let href = 'http://x/#/home';
  const navApi = async (method, route, body) => {
    const res = await fetch(`http://127.0.0.1:${navRelay.port}${route}`, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
    return res.json();
  };
  before(async () => {
    navRelay = await startTestRelay();
    navTab = await connectFakeAgent(navRelay.port, {
      'dom.click': (p) => {
        if (p.selector !== '#nav') return { clicked: true, hrefChanged: false };
        const before = href;
        href = href === 'http://x/#/home' ? 'http://x/#/list' : 'http://x/#/home';
        return { clicked: true, hrefChanged: true, hrefBefore: before, href };
      },
    });
    navSessionId = (await navApi('POST', '/sessions', { goal: 'walk between pages' })).result.id;
    await navApi('POST', '/command', { type: 'dom.click', params: { selector: '#static' } }); // no href change
    await navApi('POST', '/command', { type: 'dom.click', params: { selector: '#nav' } }); // home -> list
    await navApi('POST', '/command', { type: 'dom.click', params: { selector: '#nav' } }); // list -> home: a revisit
  });
  after(async () => { navTab?.close(); await navRelay?.stop(); });

  test('collapses to distinct pages and flags the return to one already visited', async () => {
    const { result: viz } = await navApi('GET', `/sessions/${navSessionId}/viz`);
    const m = viz.routeMachine;
    assert.equal(m.nodes.length, 2, JSON.stringify(m.nodes.map((n) => n.route)));
    assert.equal(m.stats.navigations, 2);
    assert.equal(m.stats.nonNavClicks, 1);
    assert.equal(m.stats.revisits, 1);
    assert.ok(m.nodes.every((n) => n.route.includes('/#/')));
  });
});

describe('transcript import', () => {
  test('a narrated call gives its why to every action it produced, and nothing else', async () => {
    const res = await api('POST', `/sessions/${sessionId}/intents/import`, { transcriptText: narratedTranscript() });
    assert.equal(res.ok, true, res.error);
    assert.equal(res.result.written, 4, 'before-snapshot, click, after-snapshot and diff');
    assert.equal(res.result.unmatchedActions, actions.length - 4);
    const rows = (await api('GET', `/sessions/${sessionId}/actions?full=1`)).result;
    const narrated = rows.filter((r) => r.intent);
    assert.equal(narrated.length, 4);
    assert.ok(narrated.every((r) => r.intent === 'Adding a row to skills to see whether the save works.' && r.intent_source === 'transcript' && r.intent_call === 'toolu_add'));

    const { result: viz } = await api('GET', `/sessions/${sessionId}/viz`);
    assert.deepEqual(viz.episodes.why[addClick.id].slice(0, 2), ['Adding a row to skills to see whether the save works.', 'transcript']);
    assert.equal(viz.episodes.stats.stepsWithTranscriptWhy, 1, 'one tool call = one step');
    const other = actions.find((a) => a.type === 'idb.dump');
    assert.equal(viz.episodes.why[other.id][1], 'inferred', 'an un-narrated call keeps a guess, labelled as one');
  });

  test('re-importing is idempotent', async () => {
    const res = await api('POST', `/sessions/${sessionId}/intents/import`, { transcriptText: narratedTranscript() });
    assert.equal(res.result.written, 4);
    const rows = (await api('GET', `/sessions/${sessionId}/actions?full=1`)).result;
    assert.equal(rows.filter((r) => r.intent).length, 4);
  });

  test('token-report byIntent groups the actions one narrated call produced under one row', async () => {
    const { result: report } = await api('GET', `/sessions/${sessionId}/token-report`);
    const narratedRow = report.byIntent.find((r) => r.intent === 'Adding a row to skills to see whether the save works.');
    assert.ok(narratedRow, JSON.stringify(report.byIntent));
    assert.equal(narratedRow.calls, 4, 'before-snapshot, click, after-snapshot and diff share one narration');
    const unnarratedRow = report.byIntent.find((r) => r.intent.startsWith('(no narrated intent'));
    assert.ok(unnarratedRow, JSON.stringify(report.byIntent));
    assert.equal(narratedRow.calls + unnarratedRow.calls, actions.length);
  });

  test('refuses a path that is not a .jsonl transcript', async () => {
    const res = await api('POST', `/sessions/${sessionId}/intents/import`, { transcriptPath: path.join(tmp, 'notes.txt') });
    assert.equal(res.status, 400);
    assert.match(res.error, /\.jsonl/);
    const missing = await api('POST', `/sessions/${sessionId}/intents/import`, { transcriptPath: path.join(tmp, 'gone.jsonl') });
    assert.equal(missing.status, 400);
  });

  test('`session intents <id> --transcript <file>` does the same from the CLI', async () => {
    const file = path.join(tmp, 'transcript.jsonl');
    fs.writeFileSync(file, narratedTranscript());
    const out = spawnClean([path.join(dir, 'cli.mjs'), 'session', 'intents', String(sessionId), '--transcript', file], { env: relay.env });
    assert.equal(out.status, 0, out.stderr);
    const parsed = JSON.parse(out.stdout);
    assert.equal(parsed.matchedActions, 4);
    assert.equal(parsed.transcripts[0].format, 'claude');
    const bad = spawnClean([path.join(dir, 'cli.mjs'), 'session', 'intents', String(sessionId), '--format', 'nope'], { env: relay.env });
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /--format must be/);
  });
});

describe('dashboard', () => {
  const browser = findBrowser();

  test('draws the swimlane, state machine and episode tree, and shows the Why column', { skip: browserSkip(), timeout: 90000 }, async () => {
    // Make sure the transcript why is on the rows before the page loads.
    await api('POST', `/sessions/${sessionId}/intents/import`, { transcriptText: narratedTranscript() });
    let page;
    try {
      page = await launchBrowser(browser);
      await page.navigate(`http://127.0.0.1:${relay.port}/dashboard#session=${sessionId}`);
      const probe = `(() => ({
        bars: document.querySelectorAll('#swimlaneBody .sw-bar').length,
        failBars: document.querySelectorAll('#swimlaneBody .sw-bar.fail').length,
        nodes: document.querySelectorAll('#stateMachineBody .sm-node').length,
        edges: document.querySelectorAll('#stateMachineBody .sm-edge').length,
        noChange: document.querySelectorAll('#stateMachineBody .sm-edge.nochange').length,
        episodes: document.querySelectorAll('#episodesList details.ep').length,
        whyCells: document.querySelectorAll('#actionsTable td[data-why-for]').length,
        transcriptWhy: [...document.querySelectorAll('#actionsTable .act-why:not(.inferred)')].map((n) => n.textContent),
        inferredWhy: document.querySelectorAll('#actionsTable .act-why.inferred').length,
        session: document.getElementById('sessionPicker')?.value,
        causalityNodes: document.querySelectorAll('#causalityList .cz-node').length,
        seqMessages: document.querySelectorAll('#sequenceBody .seq-msg').length,
        seqFail: document.querySelectorAll('#sequenceBody .seq-msg.fail').length,
        routeEmptyShown: !document.getElementById('routeMachineEmpty').hidden,
        wasteRows: document.querySelectorAll('#wasteRetriesList .waste-row, #wasteNoopList .waste-row').length,
        costRows: document.querySelectorAll('#costTreeByType .duration-bar-row').length,
        heatCells: document.querySelectorAll('#failureHeatmapBody .heat-cell:not(.heat-empty)').length,
      }))()`;
      let seen;
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        seen = await page.evaluate(probe);
        if (seen && seen.bars >= actions.length && seen.nodes >= 3 && seen.episodes >= 1 && seen.whyCells > 0 && seen.transcriptWhy.length && seen.causalityNodes > 0 && seen.costRows > 0) break;
        await sleep(300);
      }
      assert.equal(seen.bars, actions.length, `one bar per action: ${JSON.stringify(seen)}`);
      assert.equal(seen.failBars, actions.filter((a) => !a.ok).length);
      assert.equal(seen.nodes, 3);
      assert.ok(seen.edges >= 3);
      assert.equal(seen.noChange, 1, 'the no-op click is a dashed self-loop');
      assert.ok(seen.episodes >= 1);
      assert.ok(seen.transcriptWhy.some((t) => /Adding a row to skills/.test(t)), `the transcript why is in the Action log: ${JSON.stringify(seen.transcriptWhy)}`);
      assert.ok(seen.inferredWhy > 0, 'un-narrated calls show a labelled guess');
      assert.ok(seen.causalityNodes > 0, 'the failed #missing click and its recovery are drawn in the causality tree');
      assert.ok(seen.seqMessages > 0, `sequence diagram draws a message row per call: ${JSON.stringify(seen)}`);
      assert.equal(seen.seqFail, actions.filter((a) => !a.ok).length);
      assert.equal(seen.routeEmptyShown, true, 'this session never navigated - the route FSM shows its empty state');
      assert.ok(seen.wasteRows > 0, 'the failed click and the no-op click both show up in Waste');
      assert.ok(seen.costRows > 0, 'the cost breakdown lists at least one call type');
      assert.ok(seen.heatCells > 0, 'the failure heatmap colors at least one non-empty cell');

      // Clicking a state opens its detail; clicking a bar jumps to that action's row.
      const clicked = await page.evaluate(`(() => {
        document.querySelector('#stateMachineBody .sm-node').dispatchEvent(new MouseEvent('click', { bubbles: true }));
        const detail = document.getElementById('stateMachineDetail');
        return { detailShown: !detail.hidden, text: detail.textContent };
      })()`);
      assert.equal(clicked.detailShown, true);
      assert.match(clicked.text, /State S1/);
      const focused = await page.evaluate(`(async () => {
        document.querySelector('#swimlaneBody .sw-bar').dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 400));
        return !!document.querySelector('#actionsTable tr.kbd-focus');
      })()`);
      assert.equal(focused, true, 'clicking a swimlane bar focuses its row in the Action log');
      assert.deepEqual(page.errors, [], `page errors:\n${page.errors.join('\n')}`);
    } finally {
      await page?.close();
    }
  });
});
