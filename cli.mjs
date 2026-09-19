#!/usr/bin/env node
// Web-scout CLI - thin wrapper Claude Code (or an operator) invokes via
// Bash. Talks to the relay's local HTTP endpoint (tools/web-scout/relay.mjs,
// must already be running - `node tools/web-scout/relay.mjs`), which
// forwards commands over an already-open WebSocket to the in-page agent(s)
// (tools/web-scout/inject.js), and persists sessions/actions/snapshots/
// diffs/console/net/Q&A to tools/web-scout/webscout.db. See
// tools/web-scout/README.md for the full command list, security model, and
// non-goals.

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {
  request, BASE, HOST, PORT, netHistory, pageFresh, buildVerityScenarioStub, runSuite, dbVersionCheck, waitForReconnect, snapshotSince, ensureFreshRelayForNewSession,
} from './client.mjs';
import { validateArgs, findMsysMangledArgs, findSpec } from './cli-spec.mjs';
import { parseUsage, helpTopic, helpMissing } from './help.mjs';
import { resolveRelayPid, stopRelay, startRelay, restartRelay, RELAY_SOURCE_FILES } from './relay-control.mjs';
import { rankAutoTraces } from './trace.mjs';

// Set once near the top of main() from a `--agent <name>` flag found
// anywhere in the subcommand's own arguments; every dom/idb(snapshot)/eval
// dispatch below includes it as a top-level `agent` field on the request
// body (never nested inside `params`) - see tools/web-scout/relay.mjs.
let agentFlag;
// Reply shaping for cacheable reads (--table / --if-changed / --delta / --peek / --no-guard),
// set once in main() and sent as the request's `opts` - see relay-side read-pipeline.mjs.
let shapeOpts;
// Compact JSON by default: indentation and newlines are tokens the caller pays for on
// every call. A terminal (or --pretty / WEBSCOUT_PRETTY=1) still gets the indented form.
let prettyFlag = false;
const wantPretty = () => prettyFlag || process.env.WEBSCOUT_PRETTY === '1' || (process.stdout.isTTY === true && process.env.WEBSCOUT_COMPACT !== '1');

function send(type, params) {
  return request('POST', '/command', { type, params, agent: agentFlag, opts: shapeOpts });
}

// chars/4 - same rough estimate as db.mjs's getActionCostReport, applied
// here at print time so the cost is visible the moment a heavy call
// happens, not only after the fact via "token-report"/"session show".
// stderr, not stdout - a caller piping/parsing this JSON must never see it
// mixed in.
const PRINT_RESULT_TOKEN_WARN_THRESHOLD = 2000;
function printResult(result) {
  const json = JSON.stringify(result, null, wantPretty() ? 2 : 0);
  console.log(json);
  const estTokens = Math.round(json.length / 4);
  if (estTokens > PRINT_RESULT_TOKEN_WARN_THRESHOLD) {
    console.error(`NOTE: this result is ~${estTokens} estimated tokens (${json.length} chars). If this is idb.dump, try --where/--fields/--limit to scope it (--table states each key once, --peek returns just the shape); if dom.query, note outerHTML/text are already truncated - "token-report" ranks which command types cost the most across a session.`);
  }
}

// Extracts `--name <value>` anywhere in `args`, returning the remaining
// args and the value (undefined if the flag wasn't present).
function extractFlag(args, name) {
  const idx = args.indexOf(name);
  if (idx === -1) return { args, value: undefined };
  return { args: [...args.slice(0, idx), ...args.slice(idx + 2)], value: args[idx + 1] };
}

// Extracts a boolean `--name` flag (no value) anywhere in `args`.
function extractBooleanFlag(args, name) {
  const idx = args.indexOf(name);
  if (idx === -1) return { args, value: false };
  return { args: [...args.slice(0, idx), ...args.slice(idx + 1)], value: true };
}

// Fire-and-forget: does "help all" still get called, against the sliced forms it exists to
// replace? Never awaited (a "help" command must stay instant) and never lets a down/slow relay
// affect the exit code - see token-report's helpUsage.
function noteHelpUsage(kind) {
  request('POST', '/help-used', { kind }, { autostart: false }).catch(() => {});
}

// The help text lives in usage.txt, not a template literal here - a single
// stray backtick or ${ in ~600 lines of prose used to be a syntax-error trap
// every time a new flag was documented.
// Printing all of it costs ~16k tokens, so by default a caller gets the index, one group or one
// command (help.mjs); "help all" prints the whole file. Returns false when nothing matched.
function usage(topic, sub) {
  const text = fs.readFileSync(new URL('./usage.txt', import.meta.url), 'utf8').trimEnd();
  if (topic === 'all') { console.log(text); noteHelpUsage('all'); return true; }
  const parsed = parseUsage(text);
  const out = helpTopic(parsed, topic, sub);
  if (out === null) { console.error(helpMissing(parsed, topic, sub)); noteHelpUsage('sliced'); return false; }
  console.log(out);
  noteHelpUsage('sliced');
  return true;
}

// Best-effort startup health check: compares the LIVE connected tab's real
// IndexedDB version (db.version handler in inject.js) against js/db.js's
// own DB_VERSION constant on disk. A mismatch means the tab has not
// re-opened the DB since a migration bump landed in source - a whole CRV
// pass run against that stale schema previously wasted real time before
// anyone noticed why a "new" store looked missing. Never fatal: no
// js/db.js at this relative path, no agent connected yet, or any other
// read/parse failure is swallowed silently - this is a warning, not a gate.
async function warnOnDbVersionDrift(hint) {
  try {
    const src = fs.readFileSync('js/db.js', 'utf8');
    const match = src.match(/DB_VERSION\s*=\s*(\d+)/);
    if (!match) return;
    const sourceVersion = Number(match[1]);
    const live = await send('db.version', {});
    if (live.version !== sourceVersion) {
      console.error(`WARNING: live IndexedDB version (${live.version}) != js/db.js DB_VERSION (${sourceVersion}) - the connected tab has not re-opened the DB since a migration bump. Run "page reload" (or "page reload --hard") before trusting any new-store check.${hint ? ` ${hint}` : ''}`);
    }
  } catch { /* best-effort - no js/db.js here, no agent connected, etc. */ }
}

// The relay is a long-lived process the CLI does not otherwise manage. This
// exists because a relay left on OLD code after an edit is easy to miss, and
// killing it by hand on Windows meant netstat + taskkill (pkill silently fails
// against a native node.exe). `relay status` works even when the relay is down.
async function handleRelay(sub) {
  const opts = { port: PORT, host: HOST, env: { WEBSCOUT_AUTO_CALIBRATE: '1' } };
  if (sub === 'status') {
    const found = resolveRelayPid(PORT);
    let health = null;
    try { health = await request('GET', '/health', undefined, { autostart: false }); } catch { /* not reachable */ }
    printResult({
      running: !!health, port: PORT, pid: health?.relay?.pid ?? found?.pid ?? null,
      pidSource: found?.via ?? null, startedAt: health?.relay?.started_at ?? null, uptimeSeconds: health?.relay?.uptime_seconds ?? null,
      staleSourceFiles: health?.relay?.stale_source_files ?? null,
      staleAgents: health?.stale_agents ?? null,
      events24h: health?.relay?.events_24h ?? null,
      note: !health ? 'relay is not answering - "relay start" launches one.'
        : health.relay?.events_24h?.uncleanExits ? `something killed the relay ${health.relay.events_24h.uncleanExits} time(s) in the last 24h (it booted to find the previous one's pidfile left behind); ${health.relay.events_24h.autostarts} client autostart(s). Look for another session or script that kills node processes by command line.`
        : health.relay?.stale_source_files?.length ? `relay is running OLDER code than disk (${health.relay.stale_source_files.join(', ')}) - "relay restart".`
          : health.relay ? `relay is running current code (watching ${RELAY_SOURCE_FILES.join(', ')}).` : 'this relay predates pid/stale reporting - "relay restart" once to pick it up.',
    });
    return;
  }
  if (sub === 'start') { printResult(await startRelay(opts)); return; }
  if (sub === 'stop') {
    const r = await stopRelay(opts);
    printResult(r);
    if (!r.stopped) process.exitCode = 1;
    return;
  }
  if (sub === 'restart') {
    const r = await restartRelay(opts);
    printResult(r);
    if (!r.restarted) process.exitCode = 1;
    return;
  }
  throw new Error(`unknown 'relay ${sub || ''}' - expected start | stop | restart | status`);
}

async function handleSession(sub, rawArgs) {
  if (sub === 'start') {
    let args = rawArgs;
    let tagsValue;
    let strictCrv;
    let storesValue;
    let autoSnapshot;
    let tokenBudgetValue;
    let noBriefing;
    let leanValue;
    let crvCompactValue;
    ({ args, value: noBriefing } = extractBooleanFlag(args, '--no-briefing'));
    ({ args, value: leanValue } = extractBooleanFlag(args, '--lean'));
    ({ args, value: tagsValue } = extractFlag(args, '--tags'));
    ({ args, value: strictCrv } = extractBooleanFlag(args, '--strict-crv'));
    ({ args, value: crvCompactValue } = extractBooleanFlag(args, '--crv-compact'));
    ({ args, value: storesValue } = extractFlag(args, '--stores'));
    ({ args, value: autoSnapshot } = extractBooleanFlag(args, '--auto-snapshot'));
    ({ args, value: tokenBudgetValue } = extractFlag(args, '--token-budget'));
    ({ args, value: agentFlag } = extractFlag(args, '--agent'));
    const tags = tagsValue ? tagsValue.split(',').map((t) => t.trim()).filter(Boolean) : [];
    const strictCrvStores = storesValue ? storesValue.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
    await ensureFreshRelayForNewSession();
    const session = await request('POST', '/sessions', { goal: args[0], context: args[1], strict_crv: strictCrv, strict_crv_stores: strictCrvStores, crv_compact: crvCompactValue || undefined, tags, token_budget: tokenBudgetValue !== undefined ? Number(tokenBudgetValue) : undefined, briefing: noBriefing ? false : undefined, lean: leanValue || undefined, agent: agentFlag });
    if (strictCrv && !storesValue) {
      console.error('WARNING: --strict-crv with no --stores auto-snapshots the WHOLE db on every dom.click/fill/eval/idb.put/idb.delete - this WILL time out (60s) against a real-size production IndexedDB. Pass --stores a,b,c to scope it.');
    }
    if (autoSnapshot) {
      // Requires --stores for the same reason "idb snapshot" itself warns
      // about unscoped snapshots - refused rather than silently attempting
      // a whole-db snapshot that risks the same 60s timeout right at
      // session start.
      if (!strictCrvStores) {
        console.error('WARNING: --auto-snapshot requires --stores a,b,c (unscoped risks the same 60s snapshot timeout as an unscoped "idb snapshot") - skipped.');
      } else {
        try {
          const snap = await request('POST', '/state/snapshot', { agent: agentFlag, stores: strictCrvStores });
          console.error(`auto-snapshot #${snap.id} taken (stores: ${strictCrvStores.join(', ')}) - "session cleanup ${session.id} --since-snapshot ${snap.id}" will catch every row added since now, however it was written.`);
        } catch (err) {
          console.error(`WARNING: --auto-snapshot failed: ${err.message}`);
        }
      }
    }
    printResult(session);
    await warnOnDbVersionDrift();
    return;
  }
  if (sub === 'end') {
    let args = rawArgs;
    let traceFlag;
    ({ args, value: traceFlag } = extractBooleanFlag(args, '--trace'));
    let id = args[0];
    if (!id) {
      const health = await request('GET', '/health');
      if (!health.active_session) throw new Error('no active session to end');
      id = health.active_session.id;
    }
    const ended = await request('POST', `/sessions/${id}/end`);
    if (traceFlag) {
      try {
        const trace = await request('POST', `/sessions/${ended.id}/trace`);
        console.error(`session #${ended.id} exported to ${trace.file} (${trace.events} events, ${trace.reads} shapeable reads) - grows the trace.mjs corpus (traces/auto/, gitignored); "trace.mjs replay traces/auto/*.json.gz" to see its own numbers, or promote a good one into the committed traces/ directory by hand.`);
        // The corpus otherwise just grows with nobody nudged to look at it - rank it against every
        // OTHER auto-exported trace right now, and only speak up if THIS one is actually near the
        // top (a real candidate), not for every export.
        try {
          const { candidates } = rankAutoTraces();
          const name = path.basename(trace.file);
          const rank = candidates.findIndex((c) => c.file === name);
          if (rank !== -1 && rank < 3) {
            console.error(`this trace ranks #${rank + 1} of ${candidates.length} in traces/auto/ by distrust rate (${candidates[rank].distrustRatePct}%) - a candidate worth promoting into the committed benchmark; "trace.mjs rank-auto" for the full list.`);
          }
        } catch { /* best-effort nudge only - never fail "session end" over it */ }
      } catch (err) {
        console.error(`WARNING: --trace export failed: ${err.message}`);
      }
    }
    if (ended.replayableActionCount >= 5) {
      console.error(`${ended.replayableActionCount} replayable action(s) this session - consider "macro record \\"<name>\\" ${ended.id}" if this shape (seed/verify/cleanup, etc.) will repeat.`);
    }
    // One-line cost receipt at the natural end-of-session checkpoint -
    // catches waste the same day it happened instead of only on a later,
    // on-demand "token-report" call nobody remembered to run.
    try {
      const tokenReport = await request('GET', `/sessions/${ended.id}/token-report`);
      const top = tokenReport.byType[0];
      console.error(`session #${ended.id} cost: ${tokenReport.totalCalls} call(s), ~${tokenReport.totalEstTokens} estimated tokens${top ? ` (top: ${top.type} ~${top.estTokens})` : ''}.`);
      const receipt = ended.savingsReceipt;
      if (receipt && (receipt.scopedCalls || receipt.cacheHits || receipt.shapedCalls)) {
        const tok = (bytes) => Math.round(bytes / 4);
        console.error(`session #${ended.id} savings: ${receipt.scopedCalls} scoped read(s) left out ~${tok(receipt.avoidedBytes)} tokens vs unscoped; ${receipt.cacheHits} cache hit(s) skipped a page round trip (~${tok(receipt.cacheBytes)} tokens still delivered)${receipt.shapedCalls ? `; ${receipt.shapedCalls} shaped repl${receipt.shapedCalls === 1 ? 'y' : 'ies'} (pointer/delta/peek/table) kept ~${tok(receipt.shapedBytes)} tokens off your screen` : ''}.`);
      }
      const deliveredTokens = receipt?.deliveredEstTokens ?? tokenReport.totalEstTokens;
      if (ended.token_budget && deliveredTokens > ended.token_budget) {
        console.error(`WARNING: session #${ended.id} delivered ~${deliveredTokens} estimated tokens, over its declared --token-budget of ${ended.token_budget}.`);
      }
    } catch { /* best-effort - never fail "session end" over the receipt */ }
    printResult(ended);
    return;
  }
  if (sub === 'current') {
    const health = await request('GET', '/health');
    printResult(health.active_session ?? { active: false });
    return;
  }
  if (sub === 'list') {
    printResult(await request('GET', '/sessions'));
    return;
  }
  if (sub === 'show') {
    const id = rawArgs[0];
    if (!id) throw new Error('session show requires an id');
    const [session, actions, snapshots, diffs, qa, consoleEntries, net, tokenReport] = await Promise.all([
      request('GET', `/sessions/${id}`),
      request('GET', `/sessions/${id}/actions?full=1`),
      request('GET', `/sessions/${id}/snapshots`),
      request('GET', `/sessions/${id}/diffs`),
      request('GET', `/sessions/${id}/qa`),
      request('GET', `/sessions/${id}/console`),
      request('GET', `/sessions/${id}/net`),
      // Pure SQL aggregate (see db.mjs's getActionCostReport) - adds
      // essentially nothing to this call's own cost despite `actions`
      // above already being the full, unredacted dump.
      request('GET', `/sessions/${id}/token-report`),
    ]);
    if (session.token_budget && tokenReport.totalEstTokens > session.token_budget) {
      console.error(`WARNING: session #${id} has used ~${tokenReport.totalEstTokens} estimated tokens, over its declared --token-budget of ${session.token_budget}.`);
    }
    printResult({ session, actions, snapshots, diffs, qa, console: consoleEntries, net, tokenReport });
    return;
  }
  if (sub === 'report') {
    let args = rawArgs;
    let format;
    let out;
    let verityPath;
    ({ args, value: format } = extractFlag(args, '--format'));
    ({ args, value: out } = extractFlag(args, '--out'));
    ({ args, value: verityPath } = extractFlag(args, '--verity'));
    const id = args[0];
    if (!id) throw new Error('session report requires an id');
    if (verityPath) {
      // Folds a Verity scenario-result JSON file straight into this
      // session's evidence trail before exporting - see "verity import"
      // below for the standalone form (same underlying POST).
      const result = JSON.parse(fs.readFileSync(verityPath, 'utf8'));
      await request('POST', '/verity/import', { sessionId: Number(id), label: verityPath, result });
    }
    const { content } = await request('GET', `/sessions/${id}/report?format=${format === 'json' ? 'json' : 'md'}`);
    if (out) {
      fs.writeFileSync(out, content, 'utf8');
      console.log(`wrote ${out}`);
    } else {
      console.log(content);
    }
    return;
  }
  if (sub === 'viz') {
    let args = rawArgs;
    let section;
    ({ args, value: section } = extractFlag(args, '--section'));
    const id = args[0];
    if (!id) throw new Error('session viz requires an id');
    const viz = await request('GET', `/sessions/${id}/viz`);
    if (section === undefined) { printResult(viz); return; }
    if (!(section in viz)) throw new Error(`session viz --section must be one of: ${Object.keys(viz).filter((k) => typeof viz[k] === 'object' && viz[k] !== null).join(', ')}`);
    printResult(viz[section]);
    return;
  }
  if (sub === 'cleanup') {
    let args = rawArgs;
    let confirm;
    let sinceSnapshotId;
    let summary;
    ({ args, value: confirm } = extractBooleanFlag(args, '--confirm'));
    ({ args, value: sinceSnapshotId } = extractFlag(args, '--since-snapshot'));
    ({ args, value: summary } = extractBooleanFlag(args, '--summary'));
    const id = args[0];
    if (!id) throw new Error('session cleanup requires an id');
    printResult(await request('POST', `/sessions/${id}/cleanup`, { confirm, sinceSnapshotId: sinceSnapshotId !== undefined ? Number(sinceSnapshotId) : undefined, summary }));
    return;
  }
  if (sub === 'intents') {
    let args = rawArgs;
    let transcript;
    let format;
    ({ args, value: transcript } = extractFlag(args, '--transcript'));
    ({ args, value: format } = extractFlag(args, '--format'));
    const id = args[0];
    if (!id) throw new Error('session intents requires a session id');
    if (format !== undefined && !['auto', 'claude', 'codex'].includes(format)) throw new Error('--format must be auto, claude or codex');
    // The relay may run from another directory - hand it an absolute path.
    printResult(await request('POST', `/sessions/${id}/intents/import`, { transcriptPath: transcript ? path.resolve(transcript) : undefined, format }));
    return;
  }
  if (sub === 'assert') {
    let args = rawArgs;
    ({ args, value: agentFlag } = extractFlag(args, '--agent'));
    const [id, checksJson] = args;
    if (!id || !checksJson) throw new Error('session assert requires <id> \'<checks-json>\' - a single check object or an array of them');
    let checks = JSON.parse(checksJson);
    if (!Array.isArray(checks)) checks = [checks];
    const result = await request('POST', `/sessions/${id}/assert`, { checks, agent: agentFlag });
    printResult(result);
    // A regression check that silently exits 0 on failure is not a
    // regression check a script/CI step can trust - confirmed gap: this
    // previously always exited 0 even with passed:false, so a caller had
    // to parse stdout itself to notice a failure.
    if (!result.passed) process.exitCode = 1;
    return;
  }
  throw new Error(`unknown 'session ${sub || ''}'`);
}

// Walks the repo (skipping node_modules/.git/dist-style build output) and
// bumps EVERY `<basename>?v=N` reference to `targetFile` by 1, across every
// importer - the manual half of this repo's own cache-busting convention
// (editing a file requires bumping its version at every importer, often a
// bulk sed across dozens of files, confirmed real repeated friction across
// a real session). Matches on basename only (not the full relative path) -
// this repo's own import specifiers are written relative to each importing
// file, so the same target is referenced with different leading paths from
// different files; basename + `?v=` is the one thing every reference to a
// given file shares. Reports every file it touched and the old->new version
// per match (a target with inconsistent versions across importers - already
// a latent bug before this ran - is surfaced, not silently "fixed" to one
// arbitrary value). Then (unless --no-reload) issues a hard reload with
// --wait-reconnect, the exact next step this convention always needs
// anyway.
function walkFiles(dir, out, skipDirs) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch { return out; }
  for (const entry of entries) {
    if (skipDirs.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, out, skipDirs);
    else if (/\.(js|mjs|html|css)$/.test(entry.name)) out.push(full);
  }
  return out;
}

async function handleDev(sub, rawArgs) {
  if (sub === 'bump-reload') {
    let args = rawArgs;
    let noReload;
    ({ args, value: noReload } = extractBooleanFlag(args, '--no-reload'));
    ({ args, value: agentFlag } = extractFlag(args, '--agent'));
    const targetFile = args[0];
    if (!targetFile) throw new Error('dev bump-reload requires a file path, e.g. js/pages/capital-flow.js');
    const basename = path.basename(targetFile);
    const escaped = basename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`(${escaped}\\?v=)(\\d+)`, 'g');
    const skipDirs = new Set(['node_modules', '.git', 'dist', 'build', '.claude']);
    const files = walkFiles(process.cwd(), [], skipDirs);
    const touched = [];
    for (const file of files) {
      let content;
      try {
        content = fs.readFileSync(file, 'utf8');
      } catch { continue; }
      if (!pattern.test(content)) continue;
      pattern.lastIndex = 0;
      const matches = [];
      const updated = content.replace(pattern, (whole, prefix, num) => {
        const oldV = Number(num);
        const newV = oldV + 1;
        matches.push({ from: oldV, to: newV });
        return `${prefix}${newV}`;
      });
      if (updated !== content) {
        fs.writeFileSync(file, updated, 'utf8');
        touched.push({ file: path.relative(process.cwd(), file), matches });
      }
    }
    if (!touched.length) {
      console.error(`WARNING: no "${basename}?v=N" reference found anywhere in the repo - nothing bumped. Check the basename is right and the referencing files use this exact "?v=" convention.`);
    }
    const distinctVersions = new Set(touched.flatMap((t) => t.matches.map((m) => m.from)));
    if (distinctVersions.size > 1) {
      console.error(`WARNING: found ${distinctVersions.size} DIFFERENT existing version numbers across importers before this bump (${[...distinctVersions].join(', ')}) - that inconsistency predates this command and every occurrence was still bumped by +1 from whatever it already was, not normalized to one value. Review the list below.`);
    }
    printResult({ basename, filesTouched: touched.length, touched });
    if (!noReload) {
      const result = await send('page.hardReload', {});
      result.reconnect = await waitForReconnect({ agent: agentFlag, timeoutMs: 60000 });
      printResult(result);
    }
    return;
  }
  throw new Error(`unknown 'dev ${sub || ''}'`);
}

async function handleDebugCli(sub, rawArgs) {
  if (sub === 'sweep') {
    const tag = rawArgs[0];
    if (!tag) throw new Error('debug sweep requires a tag string, e.g. debug sweep P46DEBUG');
    const skipDirs = new Set(['node_modules', '.git', 'dist', 'build', '.claude']);
    const files = walkFiles(process.cwd(), [], skipDirs);
    const hits = [];
    for (const file of files) {
      let content;
      try {
        content = fs.readFileSync(file, 'utf8');
      } catch { continue; }
      if (!content.includes(tag)) continue;
      const lines = content.split('\n');
      lines.forEach((line, i) => {
        if (line.includes(tag)) hits.push({ file: path.relative(process.cwd(), file), line: i + 1, text: line.trim().slice(0, 200) });
      });
    }
    printResult({ tag, hitCount: hits.length, hits, clean: hits.length === 0 });
    if (hits.length) process.exitCode = 1;
    return;
  }
  throw new Error(`unknown 'debug ${sub || ''}' (CLI-level - for the live in-page state, use "debug state")`);
}

async function handleDb(sub, rawArgs) {
  if (sub === 'version-check') {
    let args = rawArgs;
    ({ args, value: agentFlag } = extractFlag(args, '--agent'));
    printResult(await dbVersionCheck({ agent: agentFlag }));
    return;
  }
  throw new Error(`unknown 'db ${sub || ''}'`);
}

// Pre-run, not post-run: sums each step's OWN action type's historical
// average estTokens/call (from GET /token-report's byType, all sessions)
// across the steps about to replay - so a caller can decide to trim a
// macro/suite BEFORE paying for it, not discover the cost after the fact
// via "token-report"/"session end"'s receipt. Best-effort only (a type with
// zero prior history just contributes 0) - never blocks the run.
async function estimateActionsTokenCost(steps) {
  const report = await request('GET', '/token-report');
  const avgByType = new Map((report.byType || []).map((r) => [r.type, r.calls ? r.estTokens / r.calls : 0]));
  return Math.round(steps.reduce((sum, step) => sum + (avgByType.get(step.type) || 0), 0));
}

async function handleMacro(sub, rawArgs) {
  if (sub === 'record') {
    let args = rawArgs;
    let all;
    ({ args, value: all } = extractBooleanFlag(args, '--all'));
    const [name, sessionId] = args;
    if (!name || !sessionId) throw new Error('macro record requires "<name>" <sessionId>');
    printResult(await request('POST', '/macros', { name, sessionId: Number(sessionId), all }));
    return;
  }
  if (sub === 'list') {
    printResult(await request('GET', '/macros'));
    return;
  }
  if (sub === 'show') {
    const id = rawArgs[0];
    if (!id) throw new Error('macro show requires an id');
    printResult(await request('GET', `/macros/${id}`));
    return;
  }
  if (sub === 'run') {
    let args = rawArgs;
    let continueOnError;
    let fromStep;
    let confirm;
    let full;
    ({ args, value: continueOnError } = extractBooleanFlag(args, '--continue-on-error'));
    ({ args, value: fromStep } = extractFlag(args, '--from-step'));
    ({ args, value: confirm } = extractBooleanFlag(args, '--confirm'));
    ({ args, value: full } = extractBooleanFlag(args, '--full'));
    const id = args[0];
    if (!id) throw new Error('macro run requires an id');
    try {
      const macro = await request('GET', `/macros/${id}`);
      // steps_cost_est is stamped once at record/update time (db.mjs's
      // estimateStepsTokenCost) - reused here directly instead of a live
      // /token-report round trip. compacted_steps_removed (also stamped at
      // record time) is surfaced too, since it's real evidence this exact
      // macro is already cheaper than the raw session it was recorded from.
      const estTokens = Number.isFinite(macro.steps_cost_est) ? macro.steps_cost_est : await estimateActionsTokenCost(macro.steps);
      const compactNote = macro.compacted_steps_removed ? ` (${macro.compacted_steps_removed} duplicate step(s) already compacted out at record time)` : '';
      console.error(`NOTE: estimated cost of this replay ~${estTokens} tokens across ${macro.steps.length} step(s)${compactNote} (historical per-type averages - see "token-report").`);
    } catch { /* best-effort estimate only, never block the run */ }
    const result = await request('POST', `/macros/${id}/run`, { continueOnError, confirm, full, fromStep: fromStep !== undefined ? Number(fromStep) : undefined });
    printResult(result);
    // Same exit-code gap as session assert: the relay's own route never
    // throws on a failing step (only on the cross-context guard), so a
    // partial/failed replay used to print results and still exit 0.
    if (result.results.some((r) => !r.ok)) process.exitCode = 1;
    return;
  }
  if (sub === 'delete') {
    const id = rawArgs[0];
    if (!id) throw new Error('macro delete requires an id');
    printResult(await request('DELETE', `/macros/${id}`));
    return;
  }
  if (sub === 'export-verity') {
    let args = rawArgs;
    let outPath;
    ({ args, value: outPath } = extractFlag(args, '--out'));
    const id = args[0];
    if (!id) throw new Error('macro export-verity requires an id');
    const macro = await request('GET', `/macros/${id}`);
    const { scenario, skipped } = buildVerityScenarioStub(macro);
    const text = JSON.stringify(scenario, null, 2);
    if (outPath) {
      fs.writeFileSync(outPath, text, 'utf8');
      console.log(`wrote ${outPath} (${scenario.steps.length} step(s); ${skipped.length} skipped - see "_skipped_steps" note below)`);
    } else {
      console.log(text);
    }
    if (skipped.length) console.error(`Skipped ${skipped.length} step(s) with no Verity equivalent: ${skipped.join(', ')}`);
    return;
  }
  throw new Error(`unknown 'macro ${sub || ''}'`);
}

// A suite is a plain JSON file (no relay-side storage - unlike a macro,
// there's no replayable "actions a session already logged" to draw from
// here, it's an ordered checklist the caller writes by hand once) listing
// steps of 3 shapes:
//   {"type": "macro", "id": N, "continueOnError"?, "confirm"?, "fromStep"?}
//   {"type": "assert", "checks": {...} | [...]}
//   {"type": "diff-golden", "name": "<golden>", "idB": N, "expectClean"?: false}
// Bundles what today takes several manual CLI calls (run a macro, assert
// state, diff-golden to prove nothing else moved) into one named,
// repeatable sequence with ONE pass/fail summary - the CI-shaped wrapper
// around already-existing primitives, not a new execution engine.
async function handleSuite(sub, rawArgs) {
  if (sub === 'run') {
    let args = rawArgs;
    let continueOnError;
    ({ args, value: continueOnError } = extractBooleanFlag(args, '--continue-on-error'));
    const suitePath = args[0];
    if (!suitePath) throw new Error('suite run requires a path to a suite JSON file');
    const steps = JSON.parse(fs.readFileSync(suitePath, 'utf8'));
    try {
      // Sums each referenced macro's OWN stamped steps_cost_est (set once at
      // record time, see db.mjs) instead of a live /token-report call per
      // macro - zero extra HTTP round trips to print this estimate. Falls
      // back to a live estimate only for a pre-migration macro that predates
      // steps_cost_est (null).
      let totalEst = 0;
      let totalSteps = 0;
      let anyLiveFallback = false;
      for (const step of steps) {
        if (step.type !== 'macro' || !step.id) continue;
        const macro = await request('GET', `/macros/${step.id}`);
        totalSteps += macro.steps.length;
        if (Number.isFinite(macro.steps_cost_est)) {
          totalEst += macro.steps_cost_est;
        } else {
          anyLiveFallback = true;
          totalEst += await estimateActionsTokenCost(macro.steps);
        }
      }
      if (totalSteps) {
        console.error(`NOTE: estimated cost of this suite ~${totalEst} tokens across ${totalSteps} macro step(s)${anyLiveFallback ? '' : ' (from each macro\'s own stamped cost estimate, no live lookup needed)'} - see "token-report".`);
      }
    } catch { /* best-effort estimate only, never block the run */ }
    const result = await runSuite(steps, { continueOnError });
    printResult(result);
    if (!result.passed) process.exitCode = 1;
    return;
  }
  throw new Error(`unknown 'suite ${sub || ''}'`);
}

// Manually parses the relay's SSE feed (GET /events) over a plain
// node:http request - re-checks `store`'s row count on every "something
// changed" push instead of polling on a fixed interval. Resolves once
// --count-gte is reached, --timeout elapses, or the process is
// interrupted (Ctrl+C, handled by the caller destroying the request).
function watchIdbStore(store, countGte, timeoutMs) {
  const limit = Number(timeoutMs) || 30000;
  const start = Date.now();
  let lastCount = null;
  return new Promise((resolve, reject) => {
    let settled = false;
    const req = http.get(`${BASE}/events`, (res) => {
      let buf = '';
      const check = async () => {
        try {
          const dump = await send('idb.dump', { store });
          if (dump.count !== lastCount) {
            console.log(JSON.stringify({ at: new Date().toISOString(), store, count: dump.count, delta: lastCount === null ? null : dump.count - lastCount }));
            lastCount = dump.count;
            if (countGte !== undefined && dump.count >= Number(countGte)) finish();
          }
        } catch (err) {
          console.error('watch check failed:', err.message);
        }
      };
      check();
      res.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          buf = buf.slice(idx + 2);
          check();
        }
      });
      res.on('error', (err) => { if (!settled) { settled = true; clearTimeout(timer); reject(err); } });
    });
    req.on('error', (err) => { if (!settled) { settled = true; clearTimeout(timer); reject(err); } });
    const timer = setTimeout(finish, limit);
    function finish() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      resolve({ finalCount: lastCount, watchedMs: Date.now() - start });
    }
  });
}

async function main() {
  const [command, ...restRaw] = process.argv.slice(2);
  let rest = restRaw;
  ({ args: rest, value: prettyFlag } = extractBooleanFlag(rest, '--pretty'));
  if (!command || command === '-h' || command === '--help') {
    usage();
    process.exitCode = command ? 0 : 1;
    return;
  }

  if (command === 'help') {
    process.exitCode = usage(rest[0], rest[1]) ? 0 : 1;
    return;
  }
  // "<command> --help" answers with that command's own entry, not the whole file. eval is exempt:
  // its expression may legitimately contain --help.
  if (command !== 'eval' && (rest.includes('--help') || rest.includes('-h'))) {
    const bare = rest.filter((a) => a !== '--help' && a !== '-h');
    const spec = findSpec(command, bare);
    usage(command, spec ? spec.cmd.split(' ')[1] : undefined);
    return;
  }

  const argError = validateArgs(command, rest);
  if (argError) {
    console.error(`web-scout cli error: ${argError}`);
    process.exitCode = 1;
    return;
  }

  const mangled = findMsysMangledArgs(rest);
  if (mangled.length) {
    console.error(`WARNING: ${mangled.map((m) => JSON.stringify(m)).join(', ')} looks like Git Bash rewrote a leading-slash argument into a Windows path, so it will not match what you meant. Re-run with MSYS_NO_PATHCONV=1 in front of the command, or drop the leading slash.`);
  }

  if (command === 'status') {
    printResult(await request('GET', '/health', undefined, { autostart: false }));
    return;
  }

  if (command === 'relay') {
    await handleRelay(rest[0]);
    return;
  }

  if (command === 'agents') {
    printResult(await request('GET', '/agents'));
    return;
  }

  if (command === 'ping') {
    let a = rest;
    ({ args: a, value: agentFlag } = extractFlag(a, '--agent'));
    printResult(await request('POST', '/ping', { agent: agentFlag }));
    return;
  }

  if (command === 'session') {
    await handleSession(rest[0], rest.slice(1));
    return;
  }

  if (command === 'db') {
    await handleDb(rest[0], rest.slice(1));
    return;
  }

  if (command === 'macro') {
    await handleMacro(rest[0], rest.slice(1));
    return;
  }

  if (command === 'suite') {
    await handleSuite(rest[0], rest.slice(1));
    return;
  }

  if (command === 'analytics') {
    printResult(await request('GET', '/analytics'));
    return;
  }

  if (command === 'search') {
    const q = rest.join(' ');
    if (!q) throw new Error('search requires a query, e.g. search "cfi_ontology_candidates"');
    printResult(await request('GET', `/search?q=${encodeURIComponent(q)}`));
    return;
  }

  if (command === 'verity' && rest[0] === 'import') {
    let args = rest.slice(1);
    let label;
    ({ args, value: label } = extractFlag(args, '--label'));
    const [sessionId, path] = args;
    if (!sessionId || !path) throw new Error('verity import requires <sessionId> <path-to-scenario-result.json>');
    const result = JSON.parse(fs.readFileSync(path, 'utf8'));
    printResult(await request('POST', '/verity/import', { sessionId: Number(sessionId), label: label ?? path, result }));
    return;
  }

  if (command === 'dev') {
    await handleDev(rest[0], rest.slice(1));
    return;
  }

  if (command === 'debug' && rest[0] === 'sweep') {
    await handleDebugCli(rest[0], rest.slice(1));
    return;
  }

  if (command === 'dashboard') {
    console.log(`${BASE}/dashboard`);
    return;
  }

  // Ranks command TYPES by estimated tokens a coding agent actually reads
  // off stdout for them (chars/4 over the SAME result_json every
  // printResult call already prints) - a pure SQL aggregate server-side
  // (db.mjs's getActionCostReport), so running this never itself pays
  // anything close to the bytes it measures. Omit --session for a
  // cross-session, all-time ranking (which type is worst overall); pass it
  // to audit one CRV session. `loops` (session-scoped only) flags
  // consecutive same-type+same-params calls within 5s of each other, 3+ in
  // a row - the confirmed real "eval 1+1 while waiting for boot" poll
  // shape, a waste class byType alone can't distinguish from one-off heavy
  // calls. byIntent (session-scoped only) ranks the agent's own narrated
  // WHY (from "session intents") instead of WHAT was called.
  if (command === 'token-report') {
    // NOT rest.slice(1) - rest here IS the flag list itself (no leading
    // subcommand token to skip), so slicing dropped "--session" outright
    // and silently sent every "--session <id>" call to the all-time (no
    // session scope) endpoint instead - found live while verifying byMacro.
    const { value: sessionIdArg } = extractFlag(rest, '--session');
    const report = sessionIdArg
      ? await request('GET', `/sessions/${sessionIdArg}/token-report`)
      : await request('GET', '/token-report');
    printResult(report);
    return;
  }

  let args = rest;
  ({ args, value: agentFlag } = extractFlag(args, '--agent'));
  {
    const shape = {};
    for (const [flag, key] of [['--table', 'table'], ['--if-changed', 'ifChanged'], ['--delta', 'delta'], ['--peek', 'peek'], ['--no-guard', 'noGuard']]) {
      let on;
      ({ args, value: on } = extractBooleanFlag(args, flag));
      if (on) shape[key] = true;
    }
    shapeOpts = Object.keys(shape).length ? shape : undefined;
  }
  let nthValue;
  let textValue;
  let timeoutValue;
  let countGteValue;
  let storesValue;
  let goldenValue;
  let sinceValue;
  let quietValue;
  let graceValue;
  let fileValue;
  let filterValue;
  let minDurationValue;
  let sortValue;
  let limitValue;
  let sessionValue;
  let changedValue;
  let waitReconnectValue;
  let whereValue;
  let fieldsValue;
  let selectorFileValue;
  let stableValue;
  let stableCountValue;
  let waitSelectorValue;
  let fullValue;
  ({ args, value: fullValue } = extractBooleanFlag(args, '--full'));
  let dryRunValue;
  ({ args, value: dryRunValue } = extractBooleanFlag(args, '--dry-run'));
  let offValue;
  ({ args, value: offValue } = extractBooleanFlag(args, '--off'));
  let metaValue;
  ({ args, value: metaValue } = extractBooleanFlag(args, '--meta'));
  ({ args, value: stableValue } = extractBooleanFlag(args, '--stable'));
  ({ args, value: stableCountValue } = extractFlag(args, '--stable-count'));
  ({ args, value: waitSelectorValue } = extractFlag(args, '--wait-selector'));
  ({ args, value: selectorFileValue } = extractFlag(args, '--selector-file'));
  ({ args, value: whereValue } = extractFlag(args, '--where'));
  ({ args, value: fieldsValue } = extractFlag(args, '--fields'));
  ({ args, value: changedValue } = extractBooleanFlag(args, '--changed'));
  ({ args, value: waitReconnectValue } = extractBooleanFlag(args, '--wait-reconnect'));
  ({ args, value: nthValue } = extractFlag(args, '--nth'));
  ({ args, value: textValue } = extractFlag(args, '--text'));
  ({ args, value: timeoutValue } = extractFlag(args, '--timeout'));
  ({ args, value: countGteValue } = extractFlag(args, '--count-gte'));
  ({ args, value: storesValue } = extractFlag(args, '--stores'));
  ({ args, value: goldenValue } = extractFlag(args, '--golden'));
  ({ args, value: sinceValue } = extractFlag(args, '--since'));
  ({ args, value: quietValue } = extractFlag(args, '--quiet-ms'));
  ({ args, value: graceValue } = extractFlag(args, '--grace'));
  ({ args, value: fileValue } = extractFlag(args, '--file'));
  ({ args, value: filterValue } = extractFlag(args, '--filter'));
  ({ args, value: minDurationValue } = extractFlag(args, '--min-duration'));
  ({ args, value: sortValue } = extractFlag(args, '--sort'));
  ({ args, value: limitValue } = extractFlag(args, '--limit'));
  ({ args, value: sessionValue } = extractFlag(args, '--session'));
  // read projection flags: applied IN THE PAGE (inject.js), so what they cut never crosses the wire
  let pickValue;
  let countOnlyValue;
  let nonEmptyValue;
  let failedValue;
  let levelValue;
  let containsValue;
  ({ args, value: pickValue } = extractFlag(args, '--pick'));
  ({ args, value: countOnlyValue } = extractBooleanFlag(args, '--count'));
  ({ args, value: nonEmptyValue } = extractBooleanFlag(args, '--non-empty'));
  ({ args, value: failedValue } = extractBooleanFlag(args, '--failed'));
  ({ args, value: levelValue } = extractFlag(args, '--level'));
  ({ args, value: containsValue } = extractFlag(args, '--contains'));
  const csv = (v) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : undefined);
  let expectValue;
  let expectFileValue;
  let samplesValue;
  let allowExtraValue;
  let verboseValue;
  ({ args, value: expectValue } = extractFlag(args, '--expect'));
  ({ args, value: expectFileValue } = extractFlag(args, '--expect-file'));
  ({ args, value: samplesValue } = extractFlag(args, '--samples'));
  ({ args, value: allowExtraValue } = extractBooleanFlag(args, '--allow-extra'));
  ({ args, value: verboseValue } = extractBooleanFlag(args, '--verbose'));
  // "crv run": the action between the two snapshots, given the same way /command takes it.
  let typeValue;
  let paramsValue;
  ({ args, value: typeValue } = extractFlag(args, '--type'));
  ({ args, value: paramsValue } = extractFlag(args, '--params'));

  if (command === 'page' && args[0] === 'reload') {
    let a = args.slice(1);
    let hard;
    ({ args: a, value: hard } = extractBooleanFlag(a, '--hard'));
    // Plain reload does NOT bust a Service Worker's cache - confirmed live:
    // this cost a real session a genuine VersionError (stale-cached JS
    // still declaring the OLD DB_VERSION, racing a DB already bumped by a
    // properly-fresh tab). Warn up front, once, whenever this repo actually
    // has a sw.js at its root - not fatal, just visible before the caller
    // trusts a plain reload's result.
    if (!hard && fs.existsSync(path.join(process.cwd(), 'sw.js'))) {
      console.error('NOTE: this repo has a sw.js (Service Worker) - a plain "page reload" can keep serving OLD cached JS for several reloads (stale-while-revalidate) even after a real file edit. If you just edited js/db.js, sw.js, or any file this app precaches, use "page reload --hard" instead.');
    }
    const result = await send(hard ? 'page.hardReload' : 'page.reload', {});
    if (waitReconnectValue) {
      // A hard reload additionally unregisters the Service Worker and
      // clears Cache Storage before navigating - on a large cache this can
      // take noticeably longer than a plain reload's wait, which at the old
      // 15000/30000 defaults previously produced a false-negative
      // reconnected:false even though the tab came back healthy moments
      // later (confirmed live, twice, against a real app with hundreds of
      // unbundled ES module files - full boot took 45-60s+). Bumped to
      // 45000/60000; --timeout still overrides either.
      const defaultTimeout = hard ? 60000 : 45000;
      result.reconnect = await waitForReconnect({ agent: agentFlag, timeoutMs: timeoutValue !== undefined ? Number(timeoutValue) : defaultTimeout });
    }
    printResult(result);
    return;
  }

  if (command === 'page' && args[0] === 'fresh') {
    let a = args.slice(1);
    let urlPath;
    ({ args: a, value: urlPath } = extractFlag(a, '--url'));
    const localPath = a[0];
    if (!localPath) throw new Error('page fresh requires a local file path, e.g. js/capital-flow.js');
    printResult(await pageFresh({ localPath, urlPath, agent: agentFlag }));
    return;
  }

  if (command === 'dom' && args[0] === 'screenshot') {
    let a = args.slice(1);
    let outPath;
    ({ args: a, value: outPath } = extractFlag(a, '--out'));
    const result = await send('dom.screenshot', { selector: a[0] });
    if (outPath) {
      const base64 = result.dataUrl.split(',')[1] ?? '';
      fs.writeFileSync(outPath, Buffer.from(base64, 'base64'));
      console.log(`wrote ${outPath} (${result.width}x${result.height})`);
    } else {
      printResult({ width: result.width, height: result.height, dataUrlLength: result.dataUrl.length, note: 'pass --out <path> to save as a PNG file' });
    }
    return;
  }

  if (command === 'eval') {
    // --file <path> reads the expression/statement body from disk instead
    // of the CLI arg string - shell quoting a multi-line JS payload (nested
    // quotes, heredoc-to-var, "unexpected EOF" on any embedded newline) was
    // the single biggest time-sink in a real session; writing the script to
    // a file and passing --file sidesteps shell quoting entirely.
    let expr;
    if (fileValue) {
      // fs.readFileSync throwing ENOENT is the easy case - the confirmed
      // real gotcha is a path that SEEMS to read (no throw) but is empty or
      // whitespace-only, e.g. a POSIX-style /tmp/... path that doesn't
      // resolve the way the caller expects on Windows/Git Bash, silently
      // producing an empty string instead of erroring - which then evals as
      // a no-op expression and returns {} with zero signal anything went
      // wrong. Fail loud here instead.
      expr = fs.readFileSync(fileValue, 'utf8');
      if (!expr.trim()) {
        throw new Error(`--file ${fileValue} read as empty/whitespace-only - on Windows/Git Bash a POSIX-style path (e.g. /tmp/...) may not resolve the way you expect; write the script to a real path under your scratchpad directory and pass that.`);
      }
    } else {
      expr = args.join(' ');
    }
    // A hand-written `(async () => { ... })();` wrapper is unnecessary
    // (the relay-side statement-body fallback already handles multiple
    // statements) and actively dangerous: the trailing `;` breaks the
    // single-EXPRESSION parse attempt, falling into that fallback anyway,
    // where a `return` nested inside THIS inner function never reaches the
    // outer one - silently yielding undefined (confirmed live, twice, in a
    // real session before the cause was found). Warn, don't block - a
    // caller with a real reason to nest an IIFE (rare) can ignore this.
    if (/^\s*\(\s*(async\s+)?\(\s*\)\s*=>\s*\{[\s\S]*\}\s*\)\s*\(\s*\)\s*;?\s*$/.test(expr)) {
      console.error('NOTE: expr looks like a hand-wrapped IIFE ("(async () => { ... })();"). This is usually unnecessary now (eval already falls back to a statement body for multi-statement input) and can silently swallow a `return` nested inside it. Consider writing expr as a plain statement body instead - see eval\'s help text.');
    }
    printResult(await send('eval', { expr, timeoutMs: timeoutValue !== undefined ? Number(timeoutValue) : undefined }));
    return;
  }

  if (command === 'ask') {
    let a = args;
    let sessionId;
    if (a[0] === '--session') {
      sessionId = a[1];
      a = a.slice(2);
    }
    const question = a.join(' ');
    if (!question) throw new Error('ask requires a question');
    printResult(await request('POST', '/ask', { session_id: sessionId ?? undefined, question }));
    return;
  }

  const sub = args[0];
  const subArgs = args.slice(1);
  // --selector-file reads the selector from a file (trimmed) instead of the
  // shell arg - same fix, same reason, as eval --file: shell-quoting a
  // selector with nested quotes/brackets/attribute-value strings through
  // bash was a real, repeated time-sink. Only affects dom subcommands that
  // take a selector as their first positional arg.
  const domSelector = selectorFileValue ? fs.readFileSync(selectorFileValue, 'utf8').trim() : subArgs[0];

  const table = {
    dom: {
      // A whole-page selector (body/html/#app/...) is answered with an outline
      // by inject.js itself, so the CLI no longer needs a pre-call warning.
      query: () => send('dom.query', { selector: domSelector, full: fullValue, meta: metaValue, pick: csv(pickValue) }),
      click: () => send('dom.click', { selector: domSelector, nth: nthValue !== undefined ? Number(nthValue) : undefined }),
      fill: () => send('dom.fill', { selector: domSelector, value: subArgs[1], nth: nthValue !== undefined ? Number(nthValue) : undefined }),
      rect: () => send('dom.rect', { selector: domSelector }),
      style: () => send('dom.computedStyle', { selector: domSelector, properties: subArgs[1] ? subArgs[1].split(',').map((s) => s.trim()) : undefined }),
      wait: () => send('dom.wait', { selector: domSelector, text: textValue, timeoutMs: timeoutValue !== undefined ? Number(timeoutValue) : undefined, changed: changedValue, stable: stableValue, stableCount: stableCountValue !== undefined ? Number(stableCountValue) : undefined }),
      pick: () => send('dom.pick', { timeoutMs: timeoutValue !== undefined ? Number(timeoutValue) : undefined }),
      // Click, then wait for a (possibly different) --wait-selector to reach
      // a state - one round trip instead of "dom click" then a separate
      // "dom wait", and a real answer to "did the handler actually finish"
      // instead of dom.click's own mutated:true (which only proves the
      // click's synchronous 200ms grace window saw SOME DOM change, not
      // that an async handler - dialog open, dispatch commit - is done).
      'click-wait': () => send('dom.clickWait', {
        selector: domSelector, nth: nthValue !== undefined ? Number(nthValue) : undefined,
        waitSelector: waitSelectorValue, text: textValue,
        timeoutMs: timeoutValue !== undefined ? Number(timeoutValue) : undefined,
        changed: changedValue, stable: stableValue, stableCount: stableCountValue !== undefined ? Number(stableCountValue) : undefined,
      }),
      // Generic "wait until quiet" - pass a selector to scope it (default:
      // document.body). Use after a click/rebuild and before the next
      // dom.query/dom.click instead of a guessed sleep.
      settle: () => send('dom.settle', { selector: subArgs[0], quietMs: quietValue !== undefined ? Number(quietValue) : undefined, timeoutMs: timeoutValue !== undefined ? Number(timeoutValue) : undefined }),
    },
    react: {
      // props (+ state for a class component, or positional hooks for a
      // function component) of the nearest enclosing React component,
      // walking up from domSelector - see inject.js's findComponentFiber.
      inspect: () => send('react.inspect', { selector: domSelector, nth: nthValue !== undefined ? Number(nthValue) : undefined, pick: csv(pickValue) }),
      // Ancestor chain of enclosing component names only (not full
      // props/state per level) - orient first, then `react inspect` a more
      // specific selector.
      tree: () => send('react.tree', { selector: domSelector, nth: nthValue !== undefined ? Number(nthValue) : undefined, maxDepth: subArgs[1] !== undefined ? Number(subArgs[1]) : undefined }),
    },
    idb: {
      list: () => send('idb.list', { stores: csv(storesValue), nonEmpty: nonEmptyValue || undefined }),
      // where/fields/limit are now filtered/projected IN-PAGE (inject.js) -
      // this dispatches them as params instead of re-filtering a full dump
      // client-side, so a scoped dump of a huge store no longer pays full
      // transfer+DB-storage+stdout-print cost for every unrelated row.
      // Pre-call, not post-call: checks this store's OWN historical average
      // cost (across all sessions, via GET /token-report's byTarget) before
      // dispatching - a real, learned number ("store X averaged ~N
      // tokens/call over M past dumps"), not the static whole-page-selector
      // heuristic "dom query" uses above. Only fires when the caller hasn't
      // already scoped the call (no --where/--fields/--limit).
      dump: async () => {
        const store = subArgs[0];
        if (store && !whereValue && !fieldsValue && !limitValue && !countOnlyValue) {
          try {
            const report = await request('GET', '/token-report');
            const hist = (report.byTarget || []).find((t) => t.type === 'idb.dump' && t.target === store);
            if (hist && hist.calls >= 3) {
              console.error(`NOTE: store "${store}" dumped ${hist.calls}x before, averaging ~${hist.avgEstTokens} estimated tokens/call (~${hist.avgResultBytes} bytes). Consider --where/--fields/--limit to scope it.`);
            }
          } catch { /* best-effort historical hint only, never block the dump */ }
        }
        return send('idb.dump', {
          store,
          where: whereValue ? JSON.parse(whereValue) : undefined,
          fields: fieldsValue ? fieldsValue.split(',').map((f) => f.trim()) : undefined,
          limit: limitValue !== undefined ? Number(limitValue) : undefined,
          countOnly: countOnlyValue || undefined,
        });
      },
      get: () => send('idb.get', { store: subArgs[0], key: JSON.parse(subArgs[1]), fields: csv(fieldsValue) }),
      snapshot: async () => {
        const stores = storesValue ? storesValue.split(',').map((s) => s.trim()) : undefined;
        // --since <snapshotId>: sugar for "take a fresh snapshot scoped to
        // that baseline's own stores, diff against it, print only the
        // delta" - idb.snapshot is the #2 all-time token cost offender
        // (getActionCostReport) precisely because a full dump prints every
        // unchanged row alongside whatever actually changed. /state/diff
        // already only returns added/removed/changed rows per store (see
        // relay.mjs's computeDiff) - this just makes that the DEFAULT view
        // for "what changed" instead of a separate diff call after the fact.
        // The fresh full snapshot is still taken and persisted (its id is
        // in the response) for anyone who later needs the complete dump.
        if (sinceValue) {
          return snapshotSince({ baselineId: sinceValue, stores, golden: goldenValue, agent: agentFlag });
        }
        // Unscoped snapshot of a real-size db is the confirmed
        // SNAPSHOT_TIMEOUT_MS (60s) failure mode - warn with a real row-
        // count total (via the cheap idb.list counts, not a full dump)
        // BEFORE attempting it, instead of only discovering the size after
        // a minute-long timeout.
        if (!stores) {
          try {
            const { counts } = await send('idb.list', {});
            const total = Object.values(counts || {}).reduce((a, b) => a + b, 0);
            if (total > 5000) {
              console.error(`WARNING: unscoped snapshot of ~${total} rows across ${Object.keys(counts).length} stores - this may be slow or time out (${'60s'}). Pass --stores a,b,c to scope it to just what you need.`);
            }
          } catch { /* best-effort - don't block the real snapshot on this */ }
        }
        return request('POST', '/state/snapshot', { agent: agentFlag, stores, golden: goldenValue, where: whereValue ? JSON.parse(whereValue) : undefined });
      },
      diff: () => request('POST', '/state/diff', { idA: Number(subArgs[0]), idB: Number(subArgs[1]) }),
      'diff-golden': () => request('POST', '/state/diff', { golden: subArgs[0], idB: Number(subArgs[1]) }),
      // The verify half of baseline -> action -> verify in one call: re-snapshot the
      // baseline's stores, diff, check --expect, print pass/fail plus rows only for
      // what failed. Baseline = an id, a golden name, or the session's newest snapshot.
      verify: () => request('POST', '/state/verify', {
        agent: agentFlag, baseline: subArgs[0], stores: storesValue ? storesValue.split(',').map((s) => s.trim()) : undefined,
        expect: expectFileValue ? fs.readFileSync(expectFileValue, 'utf8') : expectValue,
        allowExtra: allowExtraValue || undefined, verbose: verboseValue || undefined, samples: samplesValue !== undefined ? Number(samplesValue) : undefined,
      }),
      restore: () => request('POST', '/state/restore', { agent: agentFlag, snapshotId: subArgs[0] ? Number(subArgs[0]) : undefined, golden: goldenValue }),
      put: () => send('idb.put', { store: subArgs[0], row: JSON.parse(subArgs[1]), dryRun: dryRunValue || undefined }),
      // Batch write, one transaction - a single failed row (e.g. a unique-
      // index conflict) is reported per-row (see idb.putMany's own
      // failed:[{index,row,error}]), not an all-or-nothing abort. Replaces
      // a shell loop of separate "idb put" calls, each its own shell-quoted
      // JSON arg - confirmed real friction seeding a handful of fixture rows
      // by hand, including a `for` loop whose overall exit code came back 1
      // from an unrelated `grep` pipeline despite every write succeeding.
      'put-many': () => send('idb.putMany', { store: subArgs[0], rows: JSON.parse(subArgs[1]), dryRun: dryRunValue || undefined }),
      // Merge-then-write: reads the existing row, shallow-merges the given
      // JSON patch onto it, writes the merged row back - replaces re-typing
      // a whole row (idb.put's real REPLACE semantics) for a 2-3 field
      // change (e.g. maturing an execution window, flipping outcome_status).
      // Requires an existing row at <json-key> - errors rather than
      // silently inserting a sparse row if the key doesn't already exist.
      patch: () => send('idb.patch', { store: subArgs[0], key: JSON.parse(subArgs[1]), patch: JSON.parse(subArgs[2]) }),
      delete: () => send('idb.delete', { store: subArgs[0], key: JSON.parse(subArgs[1]) }),
      'delete-many': () => send('idb.deleteMany', { store: subArgs[0], keys: JSON.parse(subArgs[1]) }),
      clear: () => send('idb.clear', { store: subArgs[0] }),
      wait: () => send('idb.wait', { store: subArgs[0], countGte: countGteValue !== undefined ? Number(countGteValue) : undefined, timeoutMs: timeoutValue !== undefined ? Number(timeoutValue) : undefined }),
      watch: () => watchIdbStore(subArgs[0], countGteValue, timeoutValue),
    },
    crv: {
      // Baseline -> action -> verify in ONE call: snapshot --stores, dispatch --type/--params,
      // re-snapshot, diff, check --expect - what would otherwise be "idb snapshot", the action
      // itself, then "idb verify" as three separate round trips (three full-body replies to read)
      // becomes one, few-line reply. See relay.mjs's POST /crv/run.
      run: () => request('POST', '/crv/run', {
        agent: agentFlag, stores: csv(storesValue), type: typeValue, params: paramsValue ? JSON.parse(paramsValue) : {},
        expect: expectFileValue ? fs.readFileSync(expectFileValue, 'utf8') : expectValue,
        allowExtra: allowExtraValue || undefined, verbose: verboseValue || undefined, samples: samplesValue !== undefined ? Number(samplesValue) : undefined,
      }),
    },
    net: {
      // --limit N keeps only the N most recent entries and --url <substr> only
      // those whose URL contains it - filtered IN THE PAGE (inject.js), so the
      // 500-entry ring buffer never crosses the wire when you wanted three.
      // Before this, `net log --limit 3` silently ignored the flag and printed
      // all 236 entries (~55KB).
      log: () => send('net.log', {
        limit: limitValue !== undefined ? Number(limitValue) : undefined, urlContains: extractFlag(rest, '--url').value,
        fields: csv(fieldsValue), failed: failedValue || undefined,
      }),
      clear: () => send('net.clear', {}),
      // Attach to a specific request by URL substring instead of a
      // blind sleep+`net log`-poll loop - resolves as soon as a matching
      // entry (already finished within --grace ms, or finishing while
      // this call is outstanding) is seen.
      wait: () => send('net.wait', {
        urlPattern: subArgs[0],
        timeoutMs: timeoutValue !== undefined ? Number(timeoutValue) : undefined,
        graceMs: graceValue !== undefined ? Number(graceValue) : undefined,
      }),
      // Queries the DURABLE, already-persisted net_entries table (via the
      // relay's /sessions/:id/net) instead of the in-page live ring buffer
      // (net.log, capped at 500 - evicted by background sync noise within
      // minutes in a real session). Every entry here already carries
      // started_at/ended_at, so --min-duration/--sort work without any
      // schema change. Defaults to the current active session.
      history: () => netHistory({ sessionId: sessionValue, filter: filterValue, minDuration: minDurationValue, sort: sortValue, limit: limitValue }),
      // Arms response-BODY capture (fetch/XHR) for entries whose URL
      // contains <substr> - net.log/net.wait/net.history entries gain a
      // bodyPreview (capped 4000 chars, bodyTruncated says whether anything
      // was cut) going forward. Off by default; `--off` disarms it.
      // Replaces hand-patching window.fetch via `eval` to see a raw AI-
      // provider response body that fail-closed validation would otherwise
      // discard with no trace (e.g. cfi_cognitive_runs.result: null on
      // AI_RESPONSE_INVALID).
      capture: () => send('net.setBodyCapture', offValue ? { off: true } : { filter: subArgs[0] }),
    },
    console: {
      log: () => send('console.log', { limit: limitValue !== undefined ? Number(limitValue) : undefined, level: levelValue, contains: containsValue, fields: csv(fieldsValue) }),
      clear: () => send('console.clear', {}),
      // Attach-and-wait for a console entry containing a substring, instead
      // of a blind sleep+"console log"-poll loop - the same fix, same
      // reason, as net.wait: a poll called right after triggering an action
      // can race the app's own (often async) console.error call, reading as
      // "nothing logged yet" even though the entry lands a moment later.
      wait: () => send('console.wait', { substr: subArgs[0], timeoutMs: timeoutValue !== undefined ? Number(timeoutValue) : undefined, graceMs: graceValue !== undefined ? Number(graceValue) : undefined }),
    },
    debug: {
      // Introspection shortcut for THIS tool's own runtime state (WebSocket
      // readyState, pending event-batch sizes, reconnect backoff) plus an
      // app-declared `window.__appDebug` object if the app itself sets one -
      // exists to shrink the manual "add a console.error, bump the
      // importer's ?v=, reload, read the log, remove it, bump again" cycle
      // that was the single biggest confirmed time-sink debugging a real
      // session's live state.
      state: () => send('debug.state', {}),
    },
  };

  const group = table[command];
  if (!group) {
    console.error(`Unknown command '${command}'.\n`);
    usage();
    process.exitCode = 1;
    return;
  }
  const fn = group[sub];
  if (!fn) {
    console.error(`Unknown '${command} ${sub || ''}'.\n`);
    usage(command);
    process.exitCode = 1;
    return;
  }
  printResult(await fn());
}

main().catch((err) => {
  console.error('web-scout cli error:', err.message);
  if (err.status === 409) {
    console.error('Hint: start a session first - node tools/web-scout/cli.mjs session start "<goal>" ["<context>"]');
  }
  // See relay.mjs's verifyAfterTimeout()/dispatchTracked - a 504 on
  // dom.click/dom.clickWait/dom.fill/idb.put/idb.patch does NOT prove the
  // command never ran, only that the reply didn't arrive in time. Surface
  // the best-effort re-check here so a timeout doesn't read as a flat,
  // uninformative failure that just gets retried blind.
  if (err.postTimeoutVerification) {
    console.error('Post-timeout verification (best-effort - does not prove the original command succeeded, only offers a second signal):');
    console.error(JSON.stringify(err.postTimeoutVerification, null, 2));
  }
  process.exitCode = 1;
});
