// Drift: the places where what the code has and what a person declared stop agreeing. Run on the finished graph,
// after every adapter. Only kinds that can be compared are checked - a kind with no extraction, or no declaration
// table, produces no findings, so a project can adopt one adapter at a time.

export function detectDrift(graph) {
  const nodes = graph.nodeList();
  const edges = graph.edgeList();

  const foundInCode = new Set(nodes.filter((n) => n.origins.includes('code')).map((n) => n.kind));
  const claimedKinds = new Set();
  const claimed = new Set();
  for (const e of edges) {
    if (e.kind !== 'exposes') continue;
    claimed.add(e.to);
    claimedKinds.add(graph.getNode(e.to)?.kind);
  }

  // Dashboard panels declare the routes they call; client files are what the code really calls. Compared only
  // when a clientCalls() adapter ran, so a project without one gets no noise.
  const clients = nodes.filter((n) => n.kind === 'client' && n.origins.includes('code'));
  if (clients.length) {
    const calledByClient = new Set(edges.filter((e) => e.kind === 'calls' && graph.getNode(e.from)?.kind === 'client').map((e) => e.to));
    const declaredByPanel = new Set();
    for (const e of edges) {
      if (e.kind !== 'calls' || graph.getNode(e.from)?.kind !== 'dashboard') continue;
      declaredByPanel.add(e.to);
      if (!calledByClient.has(e.to)) {
        graph.addFinding({ level: 'warn', code: 'declared-call-not-in-client', message: `${graph.getNode(e.from).label} is declared to call "${graph.getNode(e.to).key}" but no client file calls it`, nodes: [e.from, e.to] });
      }
    }
    if (declaredByPanel.size) {
      for (const id of calledByClient) {
        if (declaredByPanel.has(id)) continue;
        graph.addFinding({ level: 'warn', code: 'client-call-undeclared', message: `a client file calls "${graph.getNode(id).key}" but no dashboard capability declares it`, nodes: [id] });
      }
    }
  }

  for (const n of nodes) {
    if (!foundInCode.has(n.kind)) continue;
    const inCode = n.origins.includes('code');
    if (!inCode) {
      graph.addFinding({
        level: 'warn',
        code: 'declared-not-in-code',
        message: `${n.kind} "${n.key}" is named in a declaration or a call but was not found in the code`,
        nodes: [n.id],
      });
    } else if (claimedKinds.has(n.kind) && !claimed.has(n.id) && !n.meta.internal) {
      graph.addFinding({
        level: 'warn',
        code: 'in-code-not-declared',
        message: `${n.kind} "${n.key}" exists in the code but no capability exposes it`,
        nodes: [n.id],
      });
    }
  }
}
