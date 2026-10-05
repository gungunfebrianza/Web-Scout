// The graph every adapter writes into. Nodes are things a person can reach or call (a CLI command, an HTTP route,
// an MCP action, a capability that groups them); edges say how they connect. toJSON() is deterministic - sorted,
// no timestamps - because the stale check compares a fresh build with the file on disk.

const LEVEL_ORDER = { error: 0, warn: 1, info: 2 };
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export const nodeId = (kind, key) => `${kind}:${key}`;

export function createGraph({ project = 'project' } = {}) {
  const nodes = new Map();
  const edges = new Map();
  const findings = [];

  return {
    project,

    // origin says where the node was learned: 'code' (found in source) or 'declared' (listed in a table a person
    // maintains). A node seen from both is the healthy case; drift is the difference.
    addNode({ kind, key, label = key, origin = null, meta = {} }) {
      if (!kind || key === undefined || key === null || key === '') throw new Error('addNode needs a kind and a key');
      const id = nodeId(kind, key);
      const node = nodes.get(id) ?? { id, kind, key: String(key), label: String(label), origins: [], meta: {} };
      if (origin && !node.origins.includes(origin)) node.origins.push(origin);
      Object.assign(node.meta, meta);
      nodes.set(id, node);
      return id;
    },

    getNode: (id) => nodes.get(id) ?? null,

    addEdge(from, to, kind = 'links') {
      const key = `${from}|${kind}|${to}`;
      if (!edges.has(key)) edges.set(key, { from, to, kind });
    },

    addFinding({ level = 'warn', code, message, nodes: ids = [] }) {
      if (!(level in LEVEL_ORDER)) throw new Error(`unknown finding level "${level}"`);
      findings.push({ level, code, message, nodes: [...ids].sort(byText) });
    },

    nodeList: () => [...nodes.values()],
    edgeList: () => [...edges.values()],

    toJSON() {
      for (const e of edges.values()) {
        if (!nodes.has(e.from) || !nodes.has(e.to)) throw new Error(`edge ${e.from} -> ${e.to} points at a node that was never added`);
      }
      return {
        version: 1,
        project,
        nodes: [...nodes.values()]
          .map((n) => ({ ...n, origins: [...n.origins].sort(byText), meta: sortKeys(n.meta) }))
          .sort((a, b) => byText(a.id, b.id)),
        edges: [...edges.values()].sort((a, b) => byText(a.from, b.from) || byText(a.kind, b.kind) || byText(a.to, b.to)),
        findings: [...findings].sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] || byText(a.code, b.code) || byText(a.message, b.message)),
      };
    },
  };
}

function sortKeys(obj) {
  return Object.fromEntries(Object.keys(obj).sort(byText).map((k) => [k, obj[k]]));
}
