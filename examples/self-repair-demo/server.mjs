#!/usr/bin/env node
// Zero-dependency static server for the self-repair-demo study-case app -
// matches this repo's own no-npm-dependency convention (relay.mjs hand-
// rolls its WebSocket framing for the same reason). Serves inject.js LIVE
// from tools/web-scout/inject.js (not a copy) so the demo always exercises
// the real, current agent - never a stale snapshot that could silently
// drift from what "node tools/web-scout/build-id.mjs --stamp" last hashed.
//
// Usage: node tools/web-scout/examples/self-repair-demo/server.mjs
// Default port 8975 (relay is 8973, witnessloop's own demo relay is 8974 -
// picked to not collide with either). Override with WEBSCOUT_DEMO_PORT.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.WEBSCOUT_DEMO_PORT) || 8975;
const HOST = '127.0.0.1';

const INJECT_PATH = path.resolve(__dirname, '..', '..', 'inject.js');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

function send(res, status, body, contentType) {
  res.writeHead(status, { 'Content-Type': contentType || 'text/plain; charset=utf-8' });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, `http://${HOST}`);
  const clean = pathname === '/' ? '/index.html' : pathname;
  if (clean === '/inject.js') {
    fs.readFile(INJECT_PATH, 'utf8', (err, data) => {
      if (err) { send(res, 404, 'inject.js not found'); return; }
      send(res, 200, data, MIME['.js']);
    });
    return;
  }
  // Only ever serve files inside THIS directory (index.html/app.js) - never
  // walk above it, same reasoning as self-repair.mjs's own scope check.
  const target = path.join(__dirname, clean);
  if (!target.startsWith(__dirname)) { send(res, 403, 'forbidden'); return; }
  fs.readFile(target, (err, data) => {
    if (err) { send(res, 404, 'not found'); return; }
    send(res, 200, data, MIME[path.extname(target)] || 'application/octet-stream');
  });
});

server.listen(PORT, HOST, () => {
  console.log(`self-repair-demo serving http://${HOST}:${PORT}/ (add ?webscout=1 to activate the agent)`);
});
