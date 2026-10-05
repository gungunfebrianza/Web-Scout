// A declarative CLI spec: one row per command, saying which MCP action mirrors it and, for a plain read,
// which HTTP route it prints. Row: { cmd, mcp: 'tool.action' | null, mcpExempt?, read?: '/route' }.
// Field names are configurable so an existing spec works without reshaping.
export function commands({ rows, fields = {} }) {
  if (!Array.isArray(rows)) throw new Error('commands() needs a rows array');
  const f = { cmd: 'cmd', mcp: 'mcp', mcpExempt: 'mcpExempt', read: 'read', ...fields };
  return {
    name: 'commands',
    run({ graph }) {
      for (const row of rows) {
        const meta = {};
        if (row[f.mcpExempt]) meta.mcpExempt = row[f.mcpExempt];
        const cli = graph.addNode({ kind: 'cli', key: row[f.cmd], origin: 'code', meta });
        if (row[f.mcp]) graph.addEdge(cli, graph.addNode({ kind: 'mcp', key: row[f.mcp], origin: 'code' }), 'mirrors');
        else if (!row[f.mcpExempt]) graph.addFinding({ level: 'warn', code: 'cli-without-mcp', message: `command "${row[f.cmd]}" has no MCP action and no reason`, nodes: [cli] });
        if (row[f.read]) graph.addEdge(cli, graph.addNode({ kind: 'http', key: `GET ${row[f.read]}` }), 'reads');
      }
    },
  };
}
