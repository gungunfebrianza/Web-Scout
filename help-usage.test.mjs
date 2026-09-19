// Does "help all" (~16k tokens) still get called, against the sliced forms it exists to
// replace? cli.mjs's noteHelpUsage fires a best-effort POST /help-used on every "help" call;
// relay.mjs bumps a counter; db.mjs's getHelpUsage totals it for token-report.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestRelay, spawnClean } from './test-relay.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const relay = await startTestRelay();
const BASE = `http://127.0.0.1:${relay.port}`;
const skip = relay.live ? 'skipped under WEBSCOUT_TEST_LIVE=1' : false;

async function api(method, route, body) {
  const res = await fetch(`${BASE}${route}`, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: (await res.json()) };
}

after(async () => { await relay.stop(); });

test('POST /help-used bumps the right counter, and rejects a bad kind', { skip }, async () => {
  const before = (await api('GET', '/token-report')).json.result.helpUsage;
  assert.equal((await api('POST', '/help-used', { kind: 'all' })).status, 200);
  assert.equal((await api('POST', '/help-used', { kind: 'sliced' })).status, 200);
  assert.equal((await api('POST', '/help-used', { kind: 'sliced' })).status, 200);
  const bad = await api('POST', '/help-used', { kind: 'nope' });
  assert.equal(bad.status, 400);
  const after = (await api('GET', '/token-report')).json.result.helpUsage;
  assert.equal(after.all - before.all, 1);
  assert.equal(after.sliced - before.sliced, 2);
});

test('CLI: "help idb dump" and "help all" each report themselves, best-effort', { skip }, async () => {
  const before = (await api('GET', '/token-report')).json.result.helpUsage;
  const sliced = spawnClean([path.join(dir, 'cli.mjs'), 'help', 'idb', 'dump'], { env: relay.env, cwd: dir });
  assert.equal(sliced.status, 0, sliced.stderr);
  const all = spawnClean([path.join(dir, 'cli.mjs'), 'help', 'all'], { env: relay.env, cwd: dir });
  assert.equal(all.status, 0, all.stderr);
  // best-effort and fire-and-forget (never awaited by the CLI) - the process can exit before the
  // POST lands, so this polls briefly instead of asserting on the very next read.
  const deadline = Date.now() + 3000;
  let after;
  do { after = (await api('GET', '/token-report')).json.result.helpUsage; if (after.all > before.all && after.sliced > before.sliced) break; } while (Date.now() < deadline);
  assert.ok(after.all > before.all, 'help all was counted');
  assert.ok(after.sliced > before.sliced, 'the sliced help call was counted');
});

test('CLI: "help" never fails, and stays fast, when no relay is reachable', { skip }, async () => {
  const r = spawnClean([path.join(dir, 'cli.mjs'), 'help'], { env: { WEBSCOUT_PORT: '1' } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Usage:/);
});
