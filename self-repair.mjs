// Self-repair loop: config + scoped source patching for web-scout's "coding
// agent" gap (see webscout2.md - Live Control + Causal Evidence only become
// a REPAIR loop, not a dashboard, when the same process that reads the
// evidence also holds write access to the code, and re-runs to confirm its
// own patch). This module is the fail-closed boundary that write access sits
// behind: disabled by default, and a patch outside the configured scope
// directory is refused regardless of the flag - relay.mjs's /repair/* routes
// are thin HTTP glue around the functions here, so the actual write-scope
// decision lives in ONE place, not duplicated per route.
//
// Deliberately NOT a diff/patch engine: a literal find/replace, refusing an
// ambiguous (2+) or missing match rather than guessing which occurrence was
// meant - mirrors idb.patch's own shallow-merge simplicity (mcp-server.mjs).
// This fixes a planted bug in the scoped example app, not general
// refactoring - see docs/self-repair-loop.md for what is and is not proven.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// WEBSCOUT_REPAIR_CONFIG_PATH override - same convention as db.mjs's
// WEBSCOUT_DB_PATH, lets a test point this at a throwaway file instead of
// the real self-repair-config.json.
const CONFIG_PATH = process.env.WEBSCOUT_REPAIR_CONFIG_PATH || path.join(__dirname, 'self-repair-config.json');
const DEFAULT_SCOPE_DIR = 'examples/self-repair-demo';
const DEFAULT_CONFIG = { enabled: false, scopeDir: DEFAULT_SCOPE_DIR, history: [] };

function readConfigFile() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_CONFIG, ...parsed, history: Array.isArray(parsed.history) ? parsed.history : [] };
  } catch {
    // Missing or unreadable file - fail closed to the default (enabled:
    // false), never to an open/permissive state.
    return { ...DEFAULT_CONFIG };
  }
}

function writeConfigFile(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
}

// Public shape omits the raw history array (callers use getConfigHistory for
// that) so a plain "repair status" stays short.
export function getConfig() {
  const { history, ...rest } = readConfigFile();
  return { ...rest, historyCount: history.length };
}

export function getConfigHistory(limit = 20) {
  const { history } = readConfigFile();
  return history.slice(-limit).reverse();
}

export function isEnabled() {
  return readConfigFile().enabled === true;
}

// Toggling is itself a logged, attributable action - not a silent file edit.
// `by` is a self-declared name (same honest limit as approve --by elsewhere
// in this class of tool - not authentication).
export function setEnabled(enabled, { by } = {}) {
  const config = readConfigFile();
  config.enabled = !!enabled;
  config.history = [...config.history, { enabled: config.enabled, by: by || 'unknown', at: new Date().toISOString() }];
  writeConfigFile(config);
  return getConfig();
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

// Refuses a path outside the configured scope dir regardless of the enabled
// flag - the write-scope decision (the example app only, never a real page)
// is enforced here, not just documented. path.resolve collapses any ".."
// before the prefix check, so a traversal attempt lands outside scopeRoot
// and is refused the same as any other out-of-scope path.
export function resolveScopedPath(file) {
  if (typeof file !== 'string' || !file) throw new Error('repair patch refused: file is required');
  const config = readConfigFile();
  const scopeRoot = path.resolve(__dirname, config.scopeDir);
  const target = path.resolve(__dirname, file);
  const withSep = scopeRoot.endsWith(path.sep) ? scopeRoot : scopeRoot + path.sep;
  if (target !== scopeRoot && !target.startsWith(withSep)) {
    throw new Error(`repair patch refused: "${file}" resolves outside the configured scope (${config.scopeDir}) - the self-repair loop can only touch its own example app`);
  }
  return target;
}

export function applyPatch({ file, find, replace }) {
  if (!isEnabled()) throw new Error('self-repair loop is disabled ("repair status" / the dashboard kill-switch) - refusing to patch source');
  if (typeof find !== 'string' || !find) throw new Error('repair patch refused: find is required');
  if (typeof replace !== 'string') throw new Error('repair patch refused: replace is required (use "" to delete the matched text)');
  const target = resolveScopedPath(file);
  let before;
  try {
    before = fs.readFileSync(target, 'utf8');
  } catch {
    throw new Error(`repair patch refused: "${file}" does not exist under the configured scope`);
  }
  const occurrences = before.split(find).length - 1;
  if (occurrences === 0) throw new Error(`repair patch refused: the given "find" text was not found in ${file}`);
  if (occurrences > 1) throw new Error(`repair patch refused: the given "find" text matches ${occurrences} places in ${file} - narrow it to exactly one match`);
  const after = before.replace(find, replace);
  fs.writeFileSync(target, after, 'utf8');
  return { file, beforeHash: sha256(before), afterHash: sha256(after) };
}
