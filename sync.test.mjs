// harness sync / check: carrying the scratch lifecycle fix into a vendored copy that predates it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpDir } from './scratch.mjs';
import { checkCopy, syncCopy, HARNESS_FILES, STAMP_NAME, BACKUP_DIR } from './sync.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const base = tmpDir('webscout-synctest-'); // removed on exit; fixtures, so no owner marker

// The pre-fix harness: bare mkdtemp under the temp dir, kill() on the root process only, rmSync errors swallowed.
const LEGACY = `import fs from 'node:fs';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function launchBrowser() {
  const profile = fs.mkdtempSync('webscout-browser-profile-');
  const child = { kill() {} };
  const close = async () => { try { child.kill(); } catch {} try { fs.rmSync(profile, { recursive: true }); } catch {} };
  return { close };
}
`;
const legacyCopy = (name) => { const d = path.join(base, name); fs.mkdirSync(d); fs.writeFileSync(path.join(d, 'browser-harness.mjs'), LEGACY); fs.writeFileSync(path.join(d, 'test-relay.mjs'), '// old'); return d; };
const cli = (...args) => spawnSync(process.execPath, [path.join(here, 'cli.mjs'), ...args], { encoding: 'utf8', timeout: 30000, env: { ...process.env, WEBSCOUT_PORT: '1' } });

test('lint: the canonical harness never kills only the browser root or swallows a profile rmSync', () => {
  const src = fs.readFileSync(path.join(here, 'browser-harness.mjs'), 'utf8');
  assert.doesNotMatch(src, /child\.kill\(\)/);
  assert.doesNotMatch(src, /fs\.mkdtempSync\(path\.join\(os\.tmpdir\(\), 'webscout-browser-profile-'\)\)/);
  assert.match(src, /ownScratchDir\(createScratchDir\('webscout-browser-profile-'\)\)/);
});

test('the harness files import without host-health.mjs (a vendored copy has none)', () => {
  const d = path.join(base, 'bare');
  fs.mkdirSync(d);
  fs.writeFileSync(path.join(d, 'test-relay.mjs'), 'export const freePort = async () => 0;');
  const dry = syncCopy(d, { dryRun: true });
  assert.deepEqual(dry.changed.sort(), [...HARNESS_FILES].sort());
  syncCopy(d);
  const r = spawnSync(process.execPath, ['-e', "import('./browser-harness.mjs').then((m) => console.log(Object.keys(m).includes('launchBrowser') && Object.keys(m).includes('SLIM_FLAGS')))"], { cwd: d, encoding: 'utf8', timeout: 30000 });
  assert.equal(r.stdout.trim(), 'true', r.stderr);
});

test('check flags a legacy copy; sync backs the old file up, updates it, and check then passes', () => {
  const d = legacyCopy('legacy');
  assert.equal(checkCopy(d).state, 'stale');
  const dry = syncCopy(d, { dryRun: true });
  assert.ok(dry.changed.includes('browser-harness.mjs'));
  assert.equal(fs.existsSync(path.join(d, STAMP_NAME)), false, 'dry run writes nothing');
  assert.equal(fs.readFileSync(path.join(d, 'browser-harness.mjs'), 'utf8'), LEGACY);

  const r = syncCopy(d);
  assert.equal(checkCopy(d).state, 'current');
  assert.equal(JSON.parse(fs.readFileSync(path.join(d, STAMP_NAME), 'utf8')).files.length, HARNESS_FILES.length);
  const backups = fs.readdirSync(path.join(d, BACKUP_DIR));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(d, BACKUP_DIR, backups[0], 'browser-harness.mjs'), 'utf8'), LEGACY);
  assert.deepEqual(syncCopy(d).changed, [], 'a second sync is a no-op');
  assert.equal(r.target, path.resolve(d));
});

test('sync refuses this checkout and a folder that is not a web-scout copy', () => {
  assert.throws(() => syncCopy(here), /this checkout itself/);
  const d = path.join(base, 'random');
  fs.mkdirSync(d);
  assert.throws(() => syncCopy(d), /does not look like a web-scout copy/);
  assert.throws(() => syncCopy(path.join(base, 'nope')), /not a directory/);
});

test('CLI: harness check exits 1 on a stale copy and 0 once synced', () => {
  const d = legacyCopy('cli-copy');
  assert.equal(cli('harness', 'check', d).status, 1);
  assert.equal(cli('harness', 'sync', d, '--dry-run').status, 0);
  assert.equal(checkCopy(d).state, 'stale');
  assert.equal(cli('harness', 'sync', d).status, 0);
  assert.equal(cli('harness', 'check', d).status, 0);
  assert.notEqual(cli('harness', 'check').status, 0, 'needs a folder');
});
