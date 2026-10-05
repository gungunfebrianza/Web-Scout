import fs from 'node:fs';
import path from 'node:path';
import { buildGraph } from './build.mjs';
import { renderHtml } from './render.mjs';

export { createGraph, nodeId } from './graph.mjs';
export { detectDrift } from './drift.mjs';
export { buildGraph } from './build.mjs';
export { renderHtml } from './render.mjs';
export { defineConfig, loadConfig, findConfig } from './config.mjs';

// The two files a build owns: <out>.html (the map) and <out>.json (the same graph for other tools).
export async function renderOutputs(config) {
  const graph = await buildGraph(config, { root: config.root });
  return { graph, html: renderHtml(graph), json: `${JSON.stringify(graph, null, 2)}\n` };
}

export function writeOutputs(config, outputs) {
  fs.mkdirSync(path.dirname(`${config.out}.html`), { recursive: true });
  fs.writeFileSync(`${config.out}.html`, outputs.html);
  fs.writeFileSync(`${config.out}.json`, outputs.json);
}

// Which owned files differ from a fresh render. A missing file counts as stale. CRLF is ignored so a Windows
// checkout with autocrlf does not fail the check.
export function staleOutputs(config, outputs) {
  const stale = [];
  for (const [ext, fresh] of [['html', outputs.html], ['json', outputs.json]]) {
    const file = `${config.out}.${ext}`;
    const onDisk = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n') : null;
    if (onDisk !== fresh) stale.push(file);
  }
  return stale;
}
