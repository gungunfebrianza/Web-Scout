import { createGraph } from './graph.mjs';
import { detectDrift } from './drift.mjs';

export const DEFAULT_KINDS = {
  cli: { label: 'CLI command', purpose: 'what a person types' },
  mcp: { label: 'MCP action', purpose: 'what an AI agent calls' },
  capability: { label: 'Capability', purpose: 'one feature, grouping every way to reach it' },
  http: { label: 'HTTP route', purpose: 'what the backend serves' },
  dashboard: { label: 'Dashboard', purpose: 'what a person clicks' },
  client: { label: 'Client file', purpose: 'what the browser code actually calls' },
};
const DEFAULT_ORDER = ['cli', 'mcp', 'capability', 'http', 'dashboard', 'client'];

// Run every adapter against one graph, then compare code with declarations. Returns plain JSON.
export async function buildGraph(config, { root }) {
  const graph = createGraph({ project: config.project });
  for (const adapter of config.adapters) {
    if (!adapter || typeof adapter.run !== 'function') throw new Error('every entry in adapters must come from an adapter factory (it needs a run function)');
    await adapter.run({ graph, root });
  }
  detectDrift(graph);
  const json = graph.toJSON();
  const present = new Set(json.nodes.map((n) => n.kind));
  const order = [...DEFAULT_ORDER.filter((k) => present.has(k)), ...[...present].filter((k) => !DEFAULT_ORDER.includes(k)).sort()];
  const kinds = {};
  for (const k of order) kinds[k] = { ...(DEFAULT_KINDS[k] ?? { label: k, purpose: '' }), ...(config.kinds?.[k] ?? {}) };
  return { ...json, purpose: config.purpose ?? '', columns: order, kinds };
}
