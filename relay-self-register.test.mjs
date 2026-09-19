// Before this round, only the test harness (test-relay.mjs's startTestRelay) registered relays
// into the leaked-relay registry - a real relay (hand-started, or one this test's own siblings
// hard-kill mid-run) was invisible to reapLeakedRelays entirely. relay.mjs's isMainModule startup
// block now registers itself too (relay-control.mjs's registerRelay/reapLeakedRelays), using the
// SAME shared registry a test relay uses, so either kind of leak is found by the other's next
// startup. WEBSCOUT_RELAY_REGISTRY isolates this test to its own file - see relay-control.mjs's
// own comment on why that env var exists at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort, isUp } from './test-relay.mjs';
import { reapLeakedRelays, REAL_RELAY_PORT } from './relay-control.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));

function readRegistry(registryPath) {
  try { return fs.readFileSync(registryPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
}

test('a real relay registers itself on startup, into the same registry a test relay uses', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'webscout-self-register-'));
  const registryPath = path.join(tmp, 'registry.jsonl');
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(dir, 'relay.mjs')], {
    cwd: dir,
    env: {
      ...process.env,
      WEBSCOUT_PORT: String(port),
      WEBSCOUT_DB_PATH: path.join(tmp, 'test.db'),
      WEBSCOUT_PID_PATH: path.join(tmp, 'relay.pid'),
      WEBSCOUT_NO_AUTOOPEN: '1',
      WEBSCOUT_TOKEN_CALIBRATION: path.join(tmp, 'token-calibration.json'),
      WEBSCOUT_RELAY_REGISTRY: registryPath,
    },
    stdio: 'ignore',
  });
  try {
    let up = false;
    for (let i = 0; i < 100 && !up; i += 1) { up = await isUp(port); if (!up) await new Promise((r) => setTimeout(r, 100)); }
    assert.ok(up, 'relay never came up');
    let entries;
    for (let i = 0; i < 20; i += 1) {
      entries = readRegistry(registryPath);
      if (entries.some((e) => e.pid === child.pid)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const mine = entries.find((e) => e.pid === child.pid);
    assert.ok(mine, `no registry entry for pid ${child.pid}: ${JSON.stringify(entries)}`);
    assert.equal(mine.port, port);
    assert.equal(mine.dir, null, 'a real relay has no throwaway temp dir of its own, unlike a test relay');

    // A hard kill (no SIGTERM handler runs) leaves the entry behind - exactly the scenario
    // reapLeakedRelays exists for. Confirm it is found and cleaned up like any other leak.
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));
    const r = reapLeakedRelays({ ageMs: 0, registryPath });
    assert.equal(r.killedRelays, 0, 'the process was already dead - nothing left to signal');
    assert.deepEqual(readRegistry(registryPath), [], 'the dead entry is still removed');
  } finally {
    try { child.kill(); } catch { /* already gone */ }
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('registerRelay never lets a real relay register against port 8973 get reaped, even forced stale', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'webscout-self-register-8973-'));
  const registryPath = path.join(tmp, 'registry.jsonl');
  fs.writeFileSync(registryPath, `${JSON.stringify({ pid: 999999999, port: REAL_RELAY_PORT, dir: null, startedAt: new Date(0).toISOString() })}\n`);
  try {
    const r = reapLeakedRelays({ ageMs: 1, registryPath });
    assert.equal(r.killedRelays, 0);
    const entries = readRegistry(registryPath);
    assert.ok(entries.some((e) => e.port === REAL_RELAY_PORT), 'the real relay entry must survive');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
