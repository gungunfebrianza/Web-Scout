import http from 'node:http';
import { buildGraph } from './build.mjs';
import { renderHtml } from './render.mjs';
import { runProbes } from './live.mjs';

// `surfacemap serve`: the map, rebuilt from the files on every page load, plus /__live, which probes the running
// service. Listens on loopback only. The page is the same one `build` writes; live mode just switches on.
export async function startMapServer({ config, target = null, port = 4310, host = '127.0.0.1' }) {
  if (target && !/^https?:\/\//i.test(target)) throw new Error(`live target must start with http:// or https:// (got "${target}")`);
  const live = target ? { ...config.live, target } : null;
  let graph = await buildGraph(config, { root: config.root });

  const server = http.createServer(async (req, res) => {
    const send = (code, type, body) => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); };
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method !== 'GET') return send(405, 'text/plain', 'GET only');
      if (url.pathname === '/') {
        graph = await buildGraph(config, { root: config.root });
        return send(200, 'text/html; charset=utf-8', renderHtml(live ? { ...graph, live: { target, interval: config.live?.interval ?? 5 } } : graph));
      }
      if (url.pathname === '/graph.json') return send(200, 'application/json', JSON.stringify(graph));
      if (url.pathname === '/__live') {
        if (!live) return send(404, 'text/plain', 'no live target configured');
        return send(200, 'application/json', JSON.stringify(await runProbes(graph, live)));
      }
      return send(404, 'text/plain', 'not found');
    } catch (err) {
      return send(500, 'text/plain', err.message);
    }
  });

  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  const { port: bound } = server.address();
  return { server, url: `http://${host}:${bound}/`, close: () => new Promise((r) => { server.close(() => r()); server.closeAllConnections?.(); }) };
}
