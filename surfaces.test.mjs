// The capability map (surfaces.mjs) against the code: every HTTP route, CLI command and dashboard call
// is accounted for, and nothing in the map points at something that does not exist. A feature that
// ships on one surface only fails here, with the name of what is missing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SURFACES, INTERNAL_ROUTES } from './surfaces.mjs';
import { CLI_SPEC } from './cli-spec.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const relaySource = fs.readFileSync(path.join(dir, 'relay.mjs'), 'utf8');
const dashboardSource = fs.readFileSync(path.join(dir, 'dashboard.html'), 'utf8');

// "METHOD /path" with every numeric capture as :n, from the relay's own pattern literals.
const normalizePattern = (literal) => literal.slice(1, -1).replace(/^\^/, '').replace(/\$$/, '').replace(/\\\//g, '/').replace(/\(\\d\+\)/g, ':n');
const relayRoutes = (() => {
  const out = new Set();
  for (const m of relaySource.matchAll(/method: '([A-Z]+)',\s*pattern: (\/(?:\\\/|[^/\n])+\/)/g)) out.add(`${m[1]} ${normalizePattern(m[2])}`);
  return out;
})();

// Every api('METHOD', path) the dashboard makes; a path segment ${...} is a numeric id, a ${...} tacked onto the end is
// an optional suffix (a query string), and a literal query string is dropped.
// A call whose path is built at run time ('/friction/' + act) is skipped - the explicit calls cover those routes.
const dashboardCalls = (() => {
  const out = new Set();
  const normalizeCall = (raw) => raw.replace(/\/\$\{[^}]*\}/g, '/:n').replace(/\$\{[^}]*\}/g, '').replace(/[?#].*$/, '');
  // A backtick template may hold quotes inside ${...} (a ternary), so it gets its own pattern.
  const calls = [
    ...[...dashboardSource.matchAll(/api\('([A-Z]+)',\s*`([^`]*)`/g)].map((m) => [m[1], m[2]]),
    ...[...dashboardSource.matchAll(/api\('([A-Z]+)',\s*(['"])([^'"]*)\2/g)].map((m) => [m[1], m[3]]),
  ];
  for (const [method, raw] of calls) {
    if (raw.endsWith('/')) continue;
    out.add(`${method} ${normalizeCall(raw)}`);
  }
  // fetch(...) used directly for feeds
  for (const m of dashboardSource.matchAll(/fetch\(\s*([`'"])([^`'"]*)\1/g)) {
    const raw = m[2];
    if (!raw.startsWith('/')) continue;
    out.add(`GET ${raw.replace(/\$\{[^}]*\}/g, ':n').replace(/[?#].*$/, '')}`);
  }
  return out;
})();

const claimedRoutes = new Set(SURFACES.flatMap((s) => s.http ?? []));
const cliCommands = new Set(CLI_SPEC.map((r) => r.cmd));

test('the route extraction found the relay\'s routes (guards the test itself)', () => {
  assert.ok(relayRoutes.size > 60, `only ${relayRoutes.size} routes parsed from relay.mjs`);
  assert.ok(relayRoutes.has('POST /command'));
  assert.ok(relayRoutes.has('GET /sessions/:n/actions/:n'));
  assert.ok(dashboardCalls.size > 20, `only ${dashboardCalls.size} dashboard calls parsed`);
});

test('every relay route belongs to a capability in surfaces.mjs (or is declared internal with a reason)', () => {
  const unclaimed = [...relayRoutes].filter((r) => !claimedRoutes.has(r) && !(r in INTERNAL_ROUTES)).sort();
  assert.deepEqual(unclaimed, [], 'a new route: add it to a capability in surfaces.mjs and say where a person reaches it from');
});

test('every route a capability claims exists in the relay', () => {
  const missing = [...claimedRoutes].filter((r) => !relayRoutes.has(r)).sort();
  assert.deepEqual(missing, [], 'surfaces.mjs names routes the relay does not serve');
  const staleInternal = Object.keys(INTERNAL_ROUTES).filter((r) => !relayRoutes.has(r));
  assert.deepEqual(staleInternal, []);
});

test('every CLI command a capability names exists in the CLI spec', () => {
  const missing = SURFACES.flatMap((s) => (s.cli ?? []).filter((c) => !cliCommands.has(c)).map((c) => `${s.id}: ${c}`));
  assert.deepEqual(missing, []);
});

test('every dashboard call a capability names is a call dashboard.html really makes', () => {
  const missing = SURFACES.flatMap((s) => (s.dashboard ?? []).filter((c) => !dashboardCalls.has(c)).map((c) => `${s.id}: ${c}`));
  assert.deepEqual(missing, [], 'the dashboard does not call these - fix the claim or wire the control');
});

test('every route the dashboard calls exists in the relay (no dead controls)', () => {
  const dead = [...dashboardCalls].filter((c) => !relayRoutes.has(c)).sort();
  assert.deepEqual(dead, []);
});

test('a capability that leaves the CLI or the dashboard empty says why', () => {
  const unexplained = SURFACES.flatMap((s) => {
    const out = [];
    if (!(s.cli?.length) && !s.cliWhy) out.push(`${s.id}: no CLI command and no cliWhy`);
    if (!(s.dashboard?.length) && !s.dashboardWhy) out.push(`${s.id}: no dashboard control and no dashboardWhy`);
    return out;
  });
  assert.deepEqual(unexplained, []);
});

test('a friction capability is reachable from all four surfaces, with no excuse', () => {
  const gaps = SURFACES.filter((s) => s.family === 'friction').flatMap((s) => {
    const out = [];
    if (!s.http?.length) out.push(`${s.id}: no HTTP route`);
    if (!s.cli?.length) out.push(`${s.id}: no CLI command`);
    else if (!s.cli.some((c) => CLI_SPEC.find((r) => r.cmd === c)?.mcp)) out.push(`${s.id}: no CLI command of it has an MCP action`);
    if (!s.dashboard?.length) out.push(`${s.id}: no dashboard control`);
    return out;
  });
  assert.deepEqual(gaps, []);
});

test('capability ids are unique and no route is claimed twice', () => {
  const ids = SURFACES.map((s) => s.id);
  assert.deepEqual(ids.filter((id, i) => ids.indexOf(id) !== i), []);
  const all = SURFACES.flatMap((s) => s.http ?? []);
  assert.deepEqual(all.filter((r, i) => all.indexOf(r) !== i), [], 'a route belongs to exactly one capability');
});
