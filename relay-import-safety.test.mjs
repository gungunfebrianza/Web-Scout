// relay.mjs used to call server.listen() unconditionally at module scope - so a plain
// `import('./relay.mjs')` (a syntax check, or any other programmatic import) actually ran the
// whole relay, including binding a port. Confirmed real, twice, in the same round: a
// `node -e "import('./relay.mjs')..."` meant as a syntax check bound the REAL port (8973, no env
// override) because the previous relay had already exited by that point in the session - see
// [[web-scout-v34-round]] and [[web-scout-v35-round]]. isMainModule now gates the whole
// server.listen() block on this file being the actual process entry point.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import { freePort, isUp } from './test-relay.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const relayFile = path.join(dir, 'relay.mjs');

test('a plain import of relay.mjs never binds the port, and the process exits on its own', async () => {
  const port = await freePort();
  const script = `import(${JSON.stringify(pathToFileURL(relayFile).href)}).then(() => console.log('imported ok'));`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, WEBSCOUT_PORT: String(port), WEBSCOUT_NO_AUTOOPEN: '1' },
  });
  let stdout = '';
  child.stdout.on('data', (d) => { stdout += d; });
  const exited = await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill(); resolve(false); }, 8000);
    child.once('exit', (code) => { clearTimeout(timer); resolve(true); });
  });
  assert.ok(exited, 'a bare import must not keep the process alive (no listen(), no leftover interval)');
  assert.match(stdout, /imported ok/);
  assert.equal(await isUp(port), false, 'a bare import must never bind a port');
});

test('spawning relay.mjs directly (the real entry point) DOES bind the port', async () => {
  const port = await freePort();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'webscout-import-safety-'));
  const child = spawn(process.execPath, [relayFile], {
    cwd: dir,
    env: { ...process.env, WEBSCOUT_PORT: String(port), WEBSCOUT_NO_AUTOOPEN: '1', WEBSCOUT_DB_PATH: path.join(tmp, 'test.db'), WEBSCOUT_PID_PATH: path.join(tmp, 'relay.pid'), WEBSCOUT_TOKEN_CALIBRATION: path.join(tmp, 'token-calibration.json') },
    stdio: 'ignore',
  });
  try {
    let up = false;
    for (let i = 0; i < 100 && !up; i += 1) { up = await isUp(port); if (!up) await new Promise((r) => setTimeout(r, 100)); }
    assert.ok(up, 'the real entry point must still bind the port - the guard must not disable it entirely');
  } finally {
    const exited = new Promise((resolve) => (child.exitCode !== null ? resolve() : child.once('exit', resolve)));
    child.kill();
    await exited;
    // sqlite holds the file open until the process is fully gone (Windows refuses to delete it earlier)
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* leftover temp dir - harmless */ }
  }
});
