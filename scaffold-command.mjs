#!/usr/bin/env node
// Stubs every place a new page command has to appear, so nothing is forgotten:
//   node tools/web-scout/scaffold-command.mjs dom.hover [--params selector,nth] [--mutating] [--dry-run]
// Touches inject.js, command-registry.mjs, cli.mjs, cli-spec.mjs, usage.txt and
// mcp-server.mjs. Every stub carries a SCAFFOLD(<type>) marker and
// command-coverage.test.mjs fails while one is left, so a half-finished command
// cannot be committed by accident. The README and docs/ entries stay manual -
// docs-drift.test.mjs fails until the README mentions the command.
//
// Supported namespaces are the ones with a CLI table entry and an MCP tool of
// the same name: dom, idb, net, console, react. `page.*` commands have their own
// CLI handler; add those by hand (CONTRIBUTING.md).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const NAMESPACES = ['dom', 'idb', 'net', 'console', 'react'];

function parseArgs(argv) {
  const out = { type: null, params: [], mutating: false, dryRun: false, dir: path.dirname(fileURLToPath(import.meta.url)) };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--params') out.params = String(argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--mutating') out.mutating = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--dir') out.dir = path.resolve(argv[++i]);
    else if (!out.type) out.type = a;
    else throw new Error(`unexpected argument: ${a}`);
  }
  return out;
}

// Insert `text` (a whole line) after the first line matching `anchor`, keeping
// that line's newline convention.
function insertAfterLine(source, anchor, text, where) {
  const lines = source.split('\n');
  const at = lines.findIndex((l) => anchor.test(l));
  if (at === -1) throw new Error(`${where}: anchor ${anchor} not found - the file layout changed; update scaffold-command.mjs`);
  lines.splice(at + 1, 0, text);
  return lines.join('\n');
}

function insertBeforeLine(source, anchor, text, where) {
  const lines = source.split('\n');
  const at = lines.findIndex((l) => anchor.test(l));
  if (at === -1) throw new Error(`${where}: anchor ${anchor} not found - the file layout changed; update scaffold-command.mjs`);
  lines.splice(at, 0, ...text.split('\n'));
  return lines.join('\n');
}

export function scaffold({ type, params = [], mutating = false, dir }) {
  const m = /^([a-z]+)\.([A-Za-z]+)$/.exec(type ?? '');
  if (!m) throw new Error('usage: scaffold-command.mjs <namespace.action> (e.g. dom.hover) [--params a,b] [--mutating] [--dry-run]');
  const [, ns, action] = m;
  if (!NAMESPACES.includes(ns)) throw new Error(`namespace '${ns}' is not scaffolded (${NAMESPACES.join(', ')}); add ${type} by hand - see CONTRIBUTING.md`);
  const mark = `SCAFFOLD(${type})`;
  const cliAction = action.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
  const mcpAction = action.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

  // Work on LF text, remember each file's own ending, and restore it on write.
  const files = {};
  const eols = {};
  const load = (f) => {
    if (files[f] === undefined) {
      const raw = fs.readFileSync(path.join(dir, f), 'utf8');
      eols[f] = raw.includes('\r\n') ? '\r\n' : '\n';
      files[f] = raw.replace(/\r\n/g, '\n');
    }
    return files[f];
  };
  for (const f of ['inject.js', 'command-registry.mjs', 'cli.mjs', 'cli-spec.mjs', 'usage.txt', 'mcp-server.mjs']) {
    if (load(f).includes(`'${type}'`) || load(f).includes(mark)) throw new Error(`${type} already appears in ${f} - nothing scaffolded`);
  }

  const destructured = params.length ? `{ ${params.join(', ')} }` : '';
  files['inject.js'] = insertAfterLine(load('inject.js'), /^ {4}'page\.epoch':/,
    `    // ${mark}: implement, then delete this comment\n    '${type}': (${destructured}) => { throw new Error('${type}: not implemented'); },`, 'inject.js');

  files['command-registry.mjs'] = insertAfterLine(load('command-registry.mjs'), /^ {2}'page\.epoch': \{\},/,
    mutating
      ? `  '${type}': { mutating: true, strictCrvExempt: '${mark}: why this needs no CRV snapshot (or make it strictCrv)' },`
      : `  '${type}': { ...READ }, // ${mark}: drop the cache flag if this is not a pure read`, 'command-registry.mjs');

  const sendArgs = params.map((p, i) => `${p}: subArgs[${i}]`).join(', ');
  const cliRe = new RegExp(`^ {4}${ns}: \\{$`);
  files['cli.mjs'] = insertAfterLine(load('cli.mjs'), cliRe,
    `      '${cliAction}': () => send('${type}', { ${sendArgs} }), // ${mark}: map the real flags`, 'cli.mjs');

  const specRow = `  { cmd: '${ns} ${cliAction}', pos: [0, ${Math.max(1, params.length)}], val: ['--agent'], mcp: 'webscout_${ns}.${mcpAction}' }, // ${mark}: real arity, flags and params map`;
  const specRe = new RegExp(`^ {2}\\{ cmd: '${ns} `);
  files['cli-spec.mjs'] = load('cli-spec.mjs').split('\n').some((l) => specRe.test(l))
    ? insertBeforeLine(load('cli-spec.mjs'), specRe, specRow, 'cli-spec.mjs')
    : insertAfterLine(load('cli-spec.mjs'), /^ {2}\{ cmd: 'status'/, specRow, 'cli-spec.mjs');

  const usageBlock = [`  ${ns} ${cliAction}${params.map((p) => ` <${p}>`).join('')}`, `                                   ${mark}: describe what it does and why it exists.`, ''].join('\n');
  files['usage.txt'] = insertBeforeLine(load('usage.txt'), new RegExp(`^ {2}${ns} `), usageBlock, 'usage.txt');

  const mcpToolRe = new RegExp(`name: 'webscout_${ns}'`);
  const mcpLines = load('mcp-server.mjs').split('\n');
  const toolAt = mcpLines.findIndex((l) => mcpToolRe.test(l));
  if (toolAt === -1) throw new Error(`mcp-server.mjs: no webscout_${ns} tool found`);
  const actionsAt = mcpLines.findIndex((l, i) => i > toolAt && /^ {4}actions: \{$/.test(l));
  const descAt = mcpLines.findIndex((l, i) => i > toolAt && /^ {6}\+ 'Actions:\\n'$/.test(l));
  if (actionsAt === -1 || descAt === -1) throw new Error(`mcp-server.mjs: webscout_${ns} layout changed; update scaffold-command.mjs`);
  mcpLines.splice(actionsAt + 1, 0, `      ${mcpAction}: (p) => sendCmd('${type}', { ${params.map((p) => `${p}: p?.${p}`).join(', ')} }, p?.agent), // ${mark}`);
  mcpLines.splice(descAt + 1, 0, `      + '  ${mcpAction} {${params.join(', ')}} - ${mark}: describe it (the MCP client sees only this text for its params)\\n'`);
  files['mcp-server.mjs'] = mcpLines.join('\n');

  return { files, eols, mark, todo: ['README.md: add the command to "Everyday commands"', 'docs/web-scout-architecture.md and docs/web-scout-roadmap.md: rationale entry', 'tests: a real-browser case in inject-browser.test.mjs if it reads or changes the page'] };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const { files, eols, mark, todo } = scaffold(opts);
    if (opts.dryRun) {
      console.log(`would stub ${opts.type} in: ${Object.keys(files).join(', ')}`);
    } else {
      for (const [f, source] of Object.entries(files)) fs.writeFileSync(path.join(opts.dir, f), source.replace(/\n/g, eols[f]));
      console.log(`stubbed ${opts.type} in: ${Object.keys(files).join(', ')}`);
    }
    console.log(`\nfinish it: search for ${mark} and replace each marker with the real thing.\nstill manual:\n${todo.map((t) => `  - ${t}`).join('\n')}\ncommand-coverage.test.mjs fails until every ${mark} is gone.`);
  } catch (err) {
    console.error(`scaffold-command: ${err.message}`);
    process.exit(1);
  }
}
