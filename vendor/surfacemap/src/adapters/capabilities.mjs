// A hand-kept table of capabilities: each says which HTTP routes, CLI commands and dashboard calls reach it.
// Row: { id, family?, http?: [], cli?: [], mcp?: [], dashboard?: [] | null, dashboardWhy?: '...' }.
// null on a surface is a decision ("this is not reachable from there") and must carry a <surface>Why, so a
// missing surface is never an accident.
const SURFACE_KEYS = ['http', 'cli', 'mcp', 'dashboard'];

export function capabilities({ rows }) {
  if (!Array.isArray(rows)) throw new Error('capabilities() needs a rows array');
  return {
    name: 'capabilities',
    run({ graph }) {
      for (const row of rows) {
        const cap = graph.addNode({ kind: 'capability', key: row.id, origin: 'declared', meta: row.family ? { family: row.family } : {} });
        for (const kind of ['http', 'cli', 'mcp']) {
          for (const key of row[kind] ?? []) graph.addEdge(cap, graph.addNode({ kind, key, origin: 'declared' }), 'exposes');
        }
        if (Array.isArray(row.dashboard)) {
          const panel = graph.addNode({ kind: 'dashboard', key: row.id, label: `${row.id} (dashboard)`, origin: 'declared', meta: { routes: [...row.dashboard].sort() } });
          graph.addEdge(cap, panel, 'exposes');
          for (const route of row.dashboard) graph.addEdge(panel, graph.addNode({ kind: 'http', key: route, origin: 'declared' }), 'calls');
        }
        const gaps = {};
        for (const kind of SURFACE_KEYS) {
          if (row[kind] !== null) continue;
          const why = row[`${kind}Why`];
          gaps[kind] = why ?? null;
          if (!why) graph.addFinding({ level: 'warn', code: 'gap-without-reason', message: `capability "${row.id}" is not reachable from ${kind} and says nothing about why`, nodes: [cap] });
        }
        if (Object.keys(gaps).length) graph.addNode({ kind: 'capability', key: row.id, meta: { gaps } });
      }
    },
  };
}
