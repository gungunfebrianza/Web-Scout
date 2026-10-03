// Which names in run-tests.mjs's private scratch root are NOT a leak. Kept in its own module because
// importing run-tests.mjs would run the whole suite. Per-platform so a Linux runner never silently
// ignores a Windows-only name.
export const COMMON_IGNORED = ['node-compile-cache', 'webscout-relays.jsonl', 'webscout-scratch-log.jsonl', 'webscout-scratch-ledger.jsonl', 'webscout-host-samples.jsonl', 'webscout-warn-cache-']; // shared-by-design files
export const PLATFORM_IGNORED = {
  win32: ['msedge_', 'cv_debug.log', '__PSScriptPolicyTest_'], // __PSScriptPolicyTest_*: PowerShell's own policy probe (seen on the hosted runner), not ours
};
export const isIgnoredLeak = (name, platform = process.platform) =>
  [...COMMON_IGNORED, ...(PLATFORM_IGNORED[platform] || [])].some((p) => name.startsWith(p));

// "a, b, ... +N more" - the CI log needs the names, not just a count.
export const formatLeakNames = (names, max = 20) =>
  names.slice(0, max).join(', ') + (names.length > max ? `, +${names.length - max} more` : '');
