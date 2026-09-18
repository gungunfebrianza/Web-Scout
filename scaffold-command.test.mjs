// The scaffold stubs every surface of a new command, leaves files that still
// parse, and command-coverage.test.mjs refuses the result until it is finished.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));

function copyTool() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'webscout-scaffold-'));
  for (const f of fs.readdirSync(dir)) {
    if (/\.(mjs|js|txt|md|html)$/.test(f) && !/^webscout\.db/.test(f)) fs.copyFileSync(path.join(dir, f), path.join(tmp, f));
  }
  return tmp;
}
// NODE_TEST_CONTEXT would make a nested `node --test` behave as a child of this runner and always exit 0
const { NODE_TEST_CONTEXT, ...cleanEnv } = process.env;
const run = (cwd, ...args) => spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout: 60000, env: cleanEnv });
const touched = ['inject.js', 'command-registry.mjs', 'cli.mjs', 'cli-spec.mjs', 'usage.txt', 'mcp-server.mjs'];

test('scaffolding dom.hover stubs all six files, each still parses, and the coverage test then fails on the markers', () => {
  const tmp = copyTool();
  try {
    const r = run(tmp, 'scaffold-command.mjs', 'dom.hover', '--params', 'selector,nth', '--dir', tmp);
    assert.equal(r.status, 0, r.stderr);
    for (const f of touched) {
      const source = fs.readFileSync(path.join(tmp, f), 'utf8');
      assert.equal(source.split('SCAFFOLD(dom.hover)').length - 1 >= 1, true, `${f} has no marker`);
      if (f.endsWith('.mjs') || f.endsWith('.js')) assert.equal(run(tmp, '--check', f).status, 0, `${f} no longer parses`);
    }
    const cov = run(tmp, '--test', '--test-force-exit', 'command-coverage.test.mjs');
    assert.notEqual(cov.status, 0, 'an unfinished scaffold must fail the coverage test');
    const output = cov.stdout + cov.stderr;
    for (const f of touched) assert.match(output, new RegExp(`dom\.hover in ${f.replace('.', '\.')}`), `coverage test does not name ${f}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a second scaffold of the same command, an unknown namespace and a bad name are refused', () => {
  const tmp = copyTool();
  try {
    assert.equal(run(tmp, 'scaffold-command.mjs', 'net.peek', '--dir', tmp).status, 0);
    const again = run(tmp, 'scaffold-command.mjs', 'net.peek', '--dir', tmp);
    assert.equal(again.status, 1);
    assert.match(again.stderr, /already appears/);
    assert.match(run(tmp, 'scaffold-command.mjs', 'page.zoom', '--dir', tmp).stderr, /not scaffolded/);
    assert.match(run(tmp, 'scaffold-command.mjs', 'hover', '--dir', tmp).stderr, /usage/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('--dry-run writes nothing', () => {
  const tmp = copyTool();
  try {
    const before = touched.map((f) => fs.readFileSync(path.join(tmp, f), 'utf8'));
    assert.equal(run(tmp, 'scaffold-command.mjs', 'idb.count', '--params', 'store', '--dry-run', '--dir', tmp).status, 0);
    assert.deepEqual(touched.map((f) => fs.readFileSync(path.join(tmp, f), 'utf8')), before);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
