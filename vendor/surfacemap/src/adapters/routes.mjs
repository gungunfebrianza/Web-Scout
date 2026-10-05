import { expandFiles, readText } from '../files.mjs';
import { literal } from '../extractors.mjs';

// HTTP routes found in source files. `files` accepts "routes-*.mjs" style patterns; `extract` is one of the
// functions in extractors.mjs (or your own). `internal` maps a route to the reason it is plumbing, not a
// capability - it is then exempt from the "no capability exposes it" check.
export function routes({ files, extract = literal, normalize = (key) => key, internal = {}, kind = 'http' }) {
  if (!Array.isArray(files) || !files.length) throw new Error('routes() needs a files list');
  return {
    name: 'routes',
    run({ graph, root }) {
      const { files: found, missing } = expandFiles(root, files);
      for (const m of missing) graph.addFinding({ level: 'error', code: 'file-not-found', message: `routes(): no file matches "${m}"` });
      for (const file of found) {
        for (const key of new Set(extract(readText(root, file)).map(normalize))) {
          const id = graph.addNode({ kind, key, origin: 'code' });
          const seen = graph.getNode(id).meta.files ?? [];
          if (!seen.includes(file)) graph.addNode({ kind, key, meta: { files: [...seen, file].sort() } });
        }
      }
      for (const [key, why] of Object.entries(internal)) graph.addNode({ kind, key, origin: 'declared', meta: { internal: why } });
    },
  };
}
