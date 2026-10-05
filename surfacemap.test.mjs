// The surface map (docs/surfacemap.html and .json) is generated from cli-spec.mjs, surfaces.mjs, the relay's route
// modules and dashboard.html. This fails when it is out of date, or when the map finds an error-level problem
// (a file the config names that does not exist). Drift warnings (a command no capability claims, a route nobody
// exposes) are shown in the map itself and do not fail the build.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './vendor/surfacemap/src/config.mjs';
import { renderOutputs, staleOutputs } from './vendor/surfacemap/src/index.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const config = await loadConfig(path.join(dir, 'surfacemap.config.mjs'));
const outputs = await renderOutputs(config);

test('the surface map finds the relay, the spec, the capabilities and the dashboard (guards the config itself)', () => {
  const count = (kind) => outputs.graph.nodes.filter((n) => n.kind === kind).length;
  assert.ok(count('http') > 60, `only ${count('http')} routes in the map`);
  assert.ok(count('cli') > 100, `only ${count('cli')} commands in the map`);
  assert.ok(count('capability') > 20, `only ${count('capability')} capabilities in the map`);
  assert.equal(count('client'), 1, 'dashboard.html is not in the map');
  assert.ok(outputs.graph.edges.some((e) => e.kind === 'mirrors'), 'no CLI command is linked to an MCP action');
});

test('the map has no error-level findings', () => {
  const errors = outputs.graph.findings.filter((f) => f.level === 'error');
  assert.deepEqual(errors, []);
});

test('docs/surfacemap.html and .json are up to date (run: node vendor/surfacemap/bin/surfacemap.mjs build)', () => {
  const stale = staleOutputs(config, outputs).map((f) => path.relative(dir, f));
  assert.deepEqual(stale, [], 'out of date: run "node vendor/surfacemap/bin/surfacemap.mjs build"');
});
