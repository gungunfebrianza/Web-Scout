#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { findConfig, loadConfig } from '../src/config.mjs';
import { renderOutputs, writeOutputs, staleOutputs, startMapServer } from '../src/index.mjs';

const USAGE = `surfacemap - a living map of how a project's surfaces connect

  surfacemap init                  write a starter surfacemap.config.mjs here
  surfacemap build                 write <out>.html and <out>.json
  surfacemap check                 fail (exit 1) when the files are stale or findings reach --fail-on
  surfacemap findings              print the drift findings, change nothing
  surfacemap serve                 serve the map rebuilt on each load; with a live target it probes the running service

  --config <file>     config file (default: surfacemap.config.mjs in the current folder)
  --fail-on <levels>  check: comma list of error,warn (default from config, else error)
  --target <url>      serve: the running service to probe (default: live.target in the config)
  --port <n>          serve: port to listen on (default 4310)
`;

const STARTER = `import { defineConfig } from 'surfacemap';
import { routes, extractors } from 'surfacemap/adapters';

export default defineConfig({
  project: 'my-project',
  purpose: 'What this map is for, in a sentence.',
  out: 'docs/surfacemap',
  adapters: [
    // HTTP routes found in source. Pick an extractor that matches how routes are written.
    routes({ files: ['src/*.js'], extract: extractors.expressCalls }),
  ],
});
`;

function parse(argv) {
  const out = { command: argv[0], config: null, failOn: null, target: null, port: 4310 };
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--config') out.config = argv[++i];
    else if (argv[i] === '--fail-on') out.failOn = (argv[++i] ?? '').split(',').filter(Boolean);
    else if (argv[i] === '--target') out.target = argv[++i];
    else if (argv[i] === '--port') out.port = Number(argv[++i]);
    else throw new Error(`unknown argument "${argv[i]}"`);
  }
  return out;
}

function printFindings(findings) {
  for (const f of findings) console.error(`${f.level.padEnd(5)} ${f.code}: ${f.message}`);
}

async function main() {
  const args = parse(process.argv.slice(2));
  if (!args.command || args.command === '--help' || args.command === 'help') { console.log(USAGE); return 0; }

  if (args.command === 'init') {
    const target = path.join(process.cwd(), 'surfacemap.config.mjs');
    if (fs.existsSync(target)) { console.error('surfacemap.config.mjs already exists; not overwriting it'); return 1; }
    fs.writeFileSync(target, STARTER);
    console.log('wrote surfacemap.config.mjs - edit the adapters, then run: surfacemap build');
    return 0;
  }

  if (!['build', 'check', 'findings', 'serve'].includes(args.command)) { console.error(`unknown command "${args.command}"\n\n${USAGE}`); return 2; }
  const file = args.config ?? findConfig(process.cwd());
  if (!file) { console.error('no surfacemap.config.mjs here; run "surfacemap init" or pass --config'); return 2; }
  const config = await loadConfig(file);

  if (args.command === 'serve') {
    if (!Number.isInteger(args.port) || args.port < 0 || args.port > 65535) { console.error('--port must be a number from 0 to 65535'); return 2; }
    const target = args.target ?? config.live?.target ?? null;
    const { url } = await startMapServer({ config, target, port: args.port });
    console.log(`serving ${url}${target ? ` - live against ${target}` : ' - no live target (set live.target or pass --target)'}`);
    return new Promise(() => {}); // keep running until Ctrl+C
  }

  const outputs = await renderOutputs(config);
  const { graph } = outputs;

  if (args.command === 'findings') { printFindings(graph.findings); console.log(`${graph.findings.length} finding(s)`); return 0; }

  if (args.command === 'build') {
    writeOutputs(config, outputs);
    console.log(`wrote ${path.relative(process.cwd(), `${config.out}.html`)} and .json: ${graph.nodes.length} nodes, ${graph.edges.length} links, ${graph.findings.length} finding(s)`);
    printFindings(graph.findings);
    return 0;
  }

  // check
  const failOn = new Set(args.failOn ?? config.failOn);
  const stale = staleOutputs(config, outputs);
  const failing = graph.findings.filter((f) => failOn.has(f.level));
  printFindings(graph.findings);
  if (stale.length) console.error(`stale: ${stale.map((s) => path.relative(process.cwd(), s)).join(', ')} - run "surfacemap build"`);
  if (failing.length) console.error(`${failing.length} finding(s) at level ${[...failOn].join('/')}`);
  if (stale.length || failing.length) return 1;
  console.log(`surfacemap ok: ${graph.nodes.length} nodes, ${graph.edges.length} links, up to date`);
  return 0;
}

main().then((code) => { process.exitCode = code; }, (err) => { console.error(err.message); process.exitCode = 2; });
