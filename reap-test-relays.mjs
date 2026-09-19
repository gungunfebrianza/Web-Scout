#!/usr/bin/env node
// Cleans up orphaned test relays right now, instead of waiting for the next `node --test` run's
// own automatic pass (test-relay.mjs's startTestRelay() already runs reapLeakedRelays() once per
// run) - useful right after a Ctrl-C or a crashed run. Never touches port 8973 (the real relay).
//
//   node tools/web-scout/reap-test-relays.mjs [--max-age-minutes N]
//
// Deliberately its own file, not a CLI block inside test-relay.mjs: Node's test runner's default
// file discovery also matches anything named test-*.mjs, so a bare `node --test` (no explicit
// glob) picked up test-relay.mjs itself as a pseudo test file - confirmed live.

import { reapLeakedRelays, REAL_RELAY_PORT } from './test-relay.mjs';

function flag(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

const ageMinutes = Number(flag('--max-age-minutes'));
const r = reapLeakedRelays({ ...(Number.isFinite(ageMinutes) ? { ageMs: ageMinutes * 60000 } : {}), verbose: true });
console.log(`reap: killed ${r.killedRelays} relay(s), removed ${r.removedDirs} temp dir(s), ${r.remaining} registry entr${r.remaining === 1 ? 'y' : 'ies'} remaining (not yet stale, or the real relay on port ${REAL_RELAY_PORT}).`);
