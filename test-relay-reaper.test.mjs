// The leaked-test-relay registry and reaper (test-relay.mjs): a hard-killed test run leaves an
// orphaned relay process and its temp dir behind; reapLeakedRelays (run automatically by the next
// startTestRelay(), or on demand via "node test-relay.mjs reap") finds and cleans those up - never
// touching a fresh entry (a run genuinely still in progress) or port 8973 (the real relay).
//
// Every call here passes its OWN isolated registryPath (never the real, shared default) - the
// default file is written to by every OTHER test file's concurrently-running real
// startTestRelay() in the same suite run, and this file's aggressive ageMs values must never risk
// treating one of those as a leak.
//
// Spawns real, throwaway child processes (real pids to kill) rather than faking the registry
// directly - a fake pid the reaper "kills" would prove nothing about a REAL orphan being cleaned.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { reapLeakedRelays } from './test-relay.mjs';

function isolatedRegistry() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'webscout-reaper-test-')), 'registry.jsonl');
}
function readRegistry(registryPath) {
  try { return fs.readFileSync(registryPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
}
function appendEntry(registryPath, e) { fs.appendFileSync(registryPath, `${JSON.stringify(e)}\n`); }

// A real, harmless, long-lived child process to stand in for an orphaned relay - real pid,
// nothing web-scout-specific about it (the reaper only ever checks pid liveness + age + port,
// never what the process actually is - see its own comment on why that is an accepted risk here).
function spawnDummy() {
  return spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
}

test('an old, alive entry is reaped: process killed, temp dir removed, registry entry gone', async () => {
  const registryPath = isolatedRegistry();
  const dummy = spawnDummy();
  await new Promise((r) => setTimeout(r, 100)); // let it actually start
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webscout-test-reaper-'));
  fs.writeFileSync(path.join(dir, 'marker.txt'), 'x');
  appendEntry(registryPath, { pid: dummy.pid, port: 54321, dir, startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() }); // 1h old

  const r = reapLeakedRelays({ ageMs: 30 * 60 * 1000, registryPath });
  assert.equal(r.killedRelays, 1);
  assert.equal(r.removedDirs, 1);
  assert.ok(!fs.existsSync(dir));
  assert.deepEqual(readRegistry(registryPath), []);
  await new Promise((resolve) => { dummy.once('exit', resolve); dummy.kill(); }); // in case the reap itself somehow missed it
  fs.rmSync(path.dirname(registryPath), { recursive: true, force: true });
});

test('a fresh entry (a run genuinely still in progress) is left alone', async () => {
  const registryPath = isolatedRegistry();
  const dummy = spawnDummy();
  try {
    await new Promise((r) => setTimeout(r, 100));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webscout-test-reaper-'));
    appendEntry(registryPath, { pid: dummy.pid, port: 54322, dir, startedAt: new Date().toISOString() }); // just started

    const r = reapLeakedRelays({ ageMs: 30 * 60 * 1000, registryPath });
    assert.equal(r.killedRelays, 0);
    assert.ok(fs.existsSync(dir), 'not reaped - too fresh');
    assert.ok(readRegistry(registryPath).some((e) => e.pid === dummy.pid && e.dir === dir));
    fs.rmSync(dir, { recursive: true, force: true });
  } finally {
    dummy.kill();
    fs.rmSync(path.dirname(registryPath), { recursive: true, force: true });
  }
});

test('port 8973 is never reaped, no matter how old or dead the entry looks', () => {
  const registryPath = isolatedRegistry();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webscout-test-reaper-'));
  appendEntry(registryPath, { pid: 999999999, port: 8973, dir, startedAt: new Date(0).toISOString() }); // ancient, a pid that (almost certainly) does not exist

  const r = reapLeakedRelays({ ageMs: 1, registryPath });
  assert.equal(r.killedRelays, 0, 'never signals a pid recorded against 8973');
  assert.ok(readRegistry(registryPath).some((e) => e.port === 8973 && e.dir === dir), 'the 8973 entry survives untouched');
  fs.rmSync(path.dirname(registryPath), { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an already-dead pid, once past the age window, is cleaned up (Ctrl-C mid-test scenario)', async () => {
  const registryPath = isolatedRegistry();
  const dummy = spawnDummy();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webscout-test-reaper-'));
  const pid = dummy.pid;
  await new Promise((resolve) => { dummy.once('exit', resolve); dummy.kill(); }); // dies BEFORE the reap runs
  appendEntry(registryPath, { pid, port: 54323, dir, startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() });

  const r = reapLeakedRelays({ ageMs: 30 * 60 * 1000, registryPath });
  assert.ok(r.removedDirs >= 1, 'the temp dir is removed even though the process was already gone');
  assert.ok(!fs.existsSync(dir));
  assert.deepEqual(readRegistry(registryPath), []);
  fs.rmSync(path.dirname(registryPath), { recursive: true, force: true });
});
