import { expandFiles, readText } from '../files.mjs';
import { apiCalls } from '../extractors.mjs';

// What client code (a dashboard, a front-end bundle, an SDK) actually asks the backend for. One `client` node per
// file, one `calls` link per route found in it. Declared dashboard panels (capabilities()) are then checked against
// this: a panel that claims a route the client never calls, or a client call no panel accounts for, is drift.
// `normalize` rewrites every key, so `/users/:n` can become `/users/:id` to match your server's route style.
export function clientCalls({ files, extract = apiCalls, normalize = (key) => key, kind = 'client' }) {
  if (!Array.isArray(files) || !files.length) throw new Error('clientCalls() needs a files list');
  return {
    name: 'clientCalls',
    run({ graph, root }) {
      const { files: found, missing } = expandFiles(root, files);
      for (const m of missing) graph.addFinding({ level: 'error', code: 'file-not-found', message: `clientCalls(): no file matches "${m}"` });
      for (const file of found) {
        const keys = [...new Set(extract(readText(root, file)).map(normalize))];
        const client = graph.addNode({ kind, key: file, origin: 'code', meta: { calls: keys.length } });
        for (const key of keys) graph.addEdge(client, graph.addNode({ kind: 'http', key }), 'calls');
      }
    },
  };
}
