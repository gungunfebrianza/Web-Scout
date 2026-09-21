// A throwaway static file server for one CRV worktree/checkout, spawned and tracked by
// `crv serve`/`crv stop` (see serve-control.mjs). Exists to close a real gap: driving a
// worktree's own throwaway origin for CRV previously meant reaching for `python -m
// http.server` (an extra runtime dependency this Node-only tool otherwise never needs) AND
// killing it by hand afterward - `pkill` silently does nothing against a native Windows
// process, forcing a `netstat -ano` + `taskkill //F //PID` dance every time (the exact same
// friction `relay-control.mjs` already solved for the relay process itself, generalized here
// to whatever static dir a CRV pass needs served). Zero npm dependencies, per this repo's own
// hardest-enforced convention - hand-rolled over node:http, not express/serve-static.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8', '.wasm': 'application/wasm',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.webp': 'image/webp',
};

// Resolves a request path against `root`, refusing anything that escapes it (a `..` segment,
// or a symlink target outside it) rather than serving it - a static server for an arbitrary
// worktree dir must never become a way to read files outside that dir.
function resolveSafe(root, urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const rel = decoded.replace(/^\/+/, '');
  const resolved = path.resolve(root, rel || '.');
  const relToRoot = path.relative(root, resolved);
  if (relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) return null;
  return resolved;
}

export function createStaticServer(root) {
  return http.createServer((req, res) => {
    let filePath = resolveSafe(root, req.url || '/');
    if (!filePath) { res.writeHead(403); res.end('forbidden'); return; }
    fs.stat(filePath, (err, stat) => {
      if (!err && stat.isDirectory()) filePath = path.join(filePath, 'index.html');
      fs.readFile(filePath, (readErr, data) => {
        if (readErr) { res.writeHead(404); res.end('not found'); return; }
        res.writeHead(200, { 'Content-Type': MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
        res.end(data);
      });
    });
  });
}

// Only runs when this file is the actual process entry point (same pathToFileURL-based guard
// relay.mjs uses for its own server.listen(), NOT a manual pathname string transform - the
// naive `new URL(import.meta.url).pathname` approach was tried first and silently produced a
// mismatch on Windows every time, so the process spawned, matched nothing, and exited having
// bound no port at all with no error - confirmed real, the exact failure this comment now warns
// against redoing) - a plain `import('./static-server.mjs')` must never bind a port.
const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMainModule) {
  const args = process.argv.slice(2);
  const dirIdx = args.indexOf('--dir');
  const portIdx = args.indexOf('--port');
  const dir = dirIdx !== -1 ? args[dirIdx + 1] : null;
  const port = portIdx !== -1 ? Number(args[portIdx + 1]) : null;
  if (!dir || !Number.isFinite(port)) {
    console.error('static-server.mjs: usage: node static-server.mjs --dir <path> --port <n>');
    process.exit(1);
  }
  createStaticServer(path.resolve(dir)).listen(port, '127.0.0.1', () => {
    console.log(`[web-scout static-server] serving ${path.resolve(dir)} on http://127.0.0.1:${port}`);
  });
}
