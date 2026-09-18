// A tab keeps the inject.js it loaded until it navigates, so an edit to the file
// is invisible to it. inject.js carries a stamp of its own hash; the relay
// compares what a tab reports with the file on disk.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { injectBuildId, stampedBuildId, stampInject, currentInjectBuild, INJECT_PATH } from './build-id.mjs';
import { startTestRelay, connectFakeAgent } from './test-relay.mjs';

const relay = await startTestRelay();
const skipLive = relay.live ? 'skipped under WEBSCOUT_TEST_LIVE=1' : false;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'webscout-build-'));
after(async () => {
  await relay.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});
const health = async () => (await (await fetch(`http://127.0.0.1:${relay.port}/health`)).json()).result;

test('inject.js is stamped with its own hash (run `node tools/web-scout/build-id.mjs --stamp` after editing it)', () => {
  const source = fs.readFileSync(INJECT_PATH, 'utf8');
  assert.equal(stampedBuildId(source), injectBuildId(source));
  assert.equal(currentInjectBuild(), injectBuildId(source));
});

test('the hash ignores the stamp itself and line endings, and changes with any other edit', () => {
  const a = "const AGENT_BUILD = 'aaaa';\nlet x = 1;\n";
  assert.equal(injectBuildId(a), injectBuildId(a.replace('aaaa', 'bbbb')));
  assert.equal(injectBuildId(a), injectBuildId(a.replace(/\n/g, '\r\n')));
  assert.notEqual(injectBuildId(a), injectBuildId(a.replace('x = 1', 'x = 2')));
});

test('stampInject rewrites the stamp in place, and is a no-op the second time', () => {
  const file = path.join(tmp, 'inject.js');
  fs.writeFileSync(file, "const AGENT_BUILD = '';\nlet x = 1;\n");
  const first = stampInject(file);
  assert.equal(first.changed, true);
  assert.equal(stampedBuildId(fs.readFileSync(file, 'utf8')), first.build);
  assert.equal(stampInject(file).changed, false);
  fs.writeFileSync(file, 'no stamp here\n');
  assert.throws(() => stampInject(file), /no "const AGENT_BUILD/);
});

test('a tab reporting the current build is fresh; a stale or unstamped tab is named in /health and a header', { skip: skipLive }, async () => {
  const fresh = await connectFakeAgent(relay.port, {}, { name: 'fresh-tab' });
  const old = await connectFakeAgent(relay.port, {}, { name: 'old-tab', build: 'deadbeef0000' });
  const unstamped = await connectFakeAgent(relay.port, {}, { name: 'unstamped-tab', build: null });
  try {
    const h = await health();
    assert.deepEqual(h.stale_agents.sort(), ['old-tab', 'unstamped-tab']);
    const detail = Object.fromEntries(h.agents_detail.map((a) => [a.name, a]));
    assert.equal(detail['fresh-tab'].agentStale, false);
    assert.equal(detail['old-tab'].build, 'deadbeef0000');
    assert.equal(detail['old-tab'].expectedBuild, currentInjectBuild());
    assert.equal(detail['unstamped-tab'].build, null);
    const res = await fetch(`http://127.0.0.1:${relay.port}/agents`);
    assert.equal(res.headers.get('x-webscout-agent-stale'), 'old-tab,unstamped-tab');
  } finally {
    fresh.close(); old.close(); unstamped.close();
  }
});

test('with only fresh tabs there is no stale header', { skip: skipLive }, async () => {
  await new Promise((r) => setTimeout(r, 200)); // the previous test's sockets are still closing
  const fresh = await connectFakeAgent(relay.port, {}, { name: 'only-fresh' });
  try {
    const res = await fetch(`http://127.0.0.1:${relay.port}/agents`);
    assert.equal(res.headers.get('x-webscout-agent-stale'), null);
    assert.deepEqual((await health()).stale_agents.filter((n) => n === 'only-fresh'), []);
  } finally {
    fresh.close();
  }
});
