// Single source of truth for how the relay treats every command type the
// in-page agent (inject.js) can execute. relay.mjs used to hold five
// hand-maintained Sets (MUTATING_TYPES, STRICT_CRV_TYPES, DEFAULT_MACRO_TYPES,
// TIMEOUT_VERIFIABLE_TYPES, READ_CACHEABLE_TYPES) plus LONG_POLL_TYPES and
// AUTO_SCREENSHOT_ON_FAILURE_TYPES, and a cleanup tracker that branched on
// type by hand - adding one write command meant editing all of them, and
// idb.putMany was invisible to session cleanup until live testing caught it.
// Now each type declares its flags ONCE here; relay.mjs derives its Sets, and
// command-registry.test.mjs fails if inject.js grows a handler this file does
// not classify, or a write command is left half-classified.
//
// Flags:
//   mutating           - can change DOM/IndexedDB/navigation/log-buffer state;
//                        bumps the read-cache mutation counter so no cached
//                        read recorded before it is ever served again.
//   strictCrv          - a strict-CRV session auto-snapshots before/after it.
//   macroDefault       - replayed by default when a macro is recorded.
//   timeoutVerifiable  - after a genuine 504, best-effort re-check live state.
//   readCacheable      - identical repeat calls are answered from the
//                        same-session read cache while nothing mutated.
//   longPoll           - has its own timeoutMs; the relay's round-trip
//                        timeout must exceed it.
//   autoScreenshot     - a failure with a selector gets a screenshot.
//   cleanup            - how `session cleanup` (action-log mode) tracks the
//                        rows this write leaves behind: 'put' | 'putMany' |
//                        'delete' | 'deleteMany' | 'clear'.
//   cleanupExempt      - required reason string when a mutating idb.* type
//                        has no `cleanup` (it leaves nothing new to delete).
//   strictCrvExempt    - required reason string when a mutating type is not
//                        strictCrv (it never touches IndexedDB rows).
//   dispatch           - 'command' (POST /command) unless noted; idb.snapshot
//                        is persisted via POST /state/snapshot instead.

const READ = { readCacheable: true };

export const COMMAND_TYPES = {
  ping: {},
  'dom.query': { ...READ },
  'dom.rect': { ...READ },
  'dom.computedStyle': { ...READ },
  'react.inspect': { ...READ },
  'react.tree': { ...READ },
  'dom.click': { mutating: true, strictCrv: true, macroDefault: true, timeoutVerifiable: true, autoScreenshot: true },
  'dom.clickWait': { mutating: true, strictCrv: true, macroDefault: true, timeoutVerifiable: true, autoScreenshot: true, longPoll: true },
  'dom.fill': { mutating: true, strictCrv: true, macroDefault: true, timeoutVerifiable: true, autoScreenshot: true },
  'dom.wait': { macroDefault: true, longPoll: true, autoScreenshot: true },
  'dom.settle': { macroDefault: true, longPoll: true },
  'dom.pick': { longPoll: true },
  'dom.screenshot': {},

  'idb.list': { ...READ },
  'idb.dump': { ...READ },
  'idb.get': { ...READ },
  'idb.snapshot': { dispatch: 'state-snapshot' },
  'idb.wait': { macroDefault: true, longPoll: true },
  'idb.put': { mutating: true, strictCrv: true, macroDefault: true, timeoutVerifiable: true, cleanup: 'put' },
  'idb.putMany': { mutating: true, strictCrv: true, macroDefault: true, cleanup: 'putMany' },
  'idb.patch': { mutating: true, strictCrv: true, macroDefault: true, timeoutVerifiable: true, cleanupExempt: 'edits a row that already existed - there is no new row for cleanup to delete' },
  'idb.delete': { mutating: true, strictCrv: true, macroDefault: true, cleanup: 'delete' },
  'idb.deleteMany': { mutating: true, strictCrv: true, macroDefault: true, cleanup: 'deleteMany' },
  'idb.clear': { mutating: true, strictCrv: true, macroDefault: true, cleanup: 'clear' },

  'db.version': {},
  'db.probeUpgrade': {},

  // net.log / console.log read a live buffer these commands empty - without
  // `mutating` a cached net.log would keep being served after net.clear.
  'net.log': { ...READ },
  'net.wait': { macroDefault: true, longPoll: true },
  'net.clear': { mutating: true, strictCrvExempt: 'clears the in-page log buffer only - no DOM/IndexedDB/navigation change' },
  'net.setBodyCapture': { mutating: true, strictCrvExempt: 'arms an in-page capture filter only - no DOM/IndexedDB/navigation change' },
  'console.log': { ...READ },
  'console.wait': { macroDefault: true, longPoll: true },
  'console.clear': { mutating: true, strictCrvExempt: 'clears the in-page log buffer only - no DOM/IndexedDB/navigation change' },

  'debug.state': {},
  'page.reload': { mutating: true, macroDefault: true, strictCrvExempt: 'navigation, not a data write - the tab reloads and re-reads IndexedDB itself' },
  'page.hardReload': { mutating: true, strictCrvExempt: 'navigation, not a data write - the tab reloads and re-reads IndexedDB itself' },
  'page.fileHash': {},
  eval: { mutating: true, strictCrv: true, macroDefault: true, longPoll: true },
};

export const CLEANUP_KINDS = ['put', 'putMany', 'delete', 'deleteMany', 'clear'];

function typesWith(flag) {
  return new Set(Object.entries(COMMAND_TYPES).filter(([, meta]) => meta[flag]).map(([type]) => type));
}

export const MUTATING_TYPES = typesWith('mutating');
export const STRICT_CRV_TYPES = typesWith('strictCrv');
export const DEFAULT_MACRO_TYPES = typesWith('macroDefault');
export const TIMEOUT_VERIFIABLE_TYPES = typesWith('timeoutVerifiable');
export const READ_CACHEABLE_TYPES = typesWith('readCacheable');
export const LONG_POLL_TYPES = typesWith('longPoll');
export const AUTO_SCREENSHOT_ON_FAILURE_TYPES = typesWith('autoScreenshot');

// Problems a registry row can have on its own, independent of inject.js -
// shared by command-registry.test.mjs so the rules live next to the data.
export function findRegistryProblems() {
  const problems = [];
  for (const [type, meta] of Object.entries(COMMAND_TYPES)) {
    if (meta.readCacheable && meta.mutating) problems.push(`${type}: cannot be both readCacheable and mutating`);
    if (meta.mutating && !meta.strictCrv && !meta.strictCrvExempt) problems.push(`${type}: mutating but neither strictCrv nor strictCrvExempt (say why it needs no CRV snapshot)`);
    if (meta.strictCrv && !meta.mutating) problems.push(`${type}: strictCrv without mutating - a write the read cache would not invalidate on`);
    if (type.startsWith('idb.') && meta.mutating && !meta.cleanup && !meta.cleanupExempt) problems.push(`${type}: mutating idb.* type with no cleanup tracker kind and no cleanupExempt reason`);
    if (meta.cleanup && !CLEANUP_KINDS.includes(meta.cleanup)) problems.push(`${type}: unknown cleanup kind '${meta.cleanup}'`);
    if (meta.cleanup && meta.cleanupExempt) problems.push(`${type}: has both cleanup and cleanupExempt`);
  }
  return problems;
}
