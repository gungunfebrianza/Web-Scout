// Route extractors: (source text) => ["GET /path", ...]. They only read text, so they work on any framework whose
// routes are written down somewhere greppable. Bring your own when a project declares routes differently.

const METHODS = 'GET|POST|PUT|PATCH|DELETE|HEAD';

// 'GET /health' written as a string literal anywhere in the file.
export function literal(source) {
  const out = [];
  const re = new RegExp(`['"\`](${METHODS}) (/[^'"\`\\s]*)['"\`]`, 'g');
  for (const m of source.matchAll(re)) out.push(`${m[1]} ${m[2]}`);
  return out;
}

// app.get('/x', ...) / router.post('/x', ...) - Express, Fastify, Koa-router and friends.
export function expressCalls(source) {
  const out = [];
  const re = /\b(?:app|router|server|fastify|api)\.(get|post|put|patch|delete|head)\(\s*['"`]([^'"`]+)['"`]/g;
  for (const m of source.matchAll(re)) out.push(`${m[1].toUpperCase()} ${m[2]}`);
  return out;
}

// { method: 'GET', pattern: /^\/sessions\/(\d+)$/ } - a hand-rolled router that matches regex literals.
// Each numeric capture becomes :n, so the key reads like a route.
export function methodPattern(source) {
  const out = [];
  const re = /method: '([A-Z]+)',\s*pattern: (\/(?:\\\/|[^/\n])+\/)/g;
  for (const m of source.matchAll(re)) {
    const path = m[2].slice(1, -1).replace(/^\^/, '').replace(/\$$/, '').replace(/\\\//g, '/').replace(/\(\\d\+\)/g, ':n');
    out.push(`${m[1]} ${path}`);
  }
  return out;
}


// ---- client-side call extractors: what a browser or app file asks the backend for ----
// A path segment written as ${...} is a numeric id and becomes :n, a ${...} tacked onto the end is an optional
// suffix (a query string) and is dropped, and a literal query string is dropped. A call whose path is built at run
// time ('/x/' + id) cannot be known from text and is skipped.
const callPath = (raw) => raw.replace(/\/\$\{[^}]*\}/g, '/:n').replace(/\$\{[^}]*\}/g, '').replace(/[?#].*$/, '');

// api('POST', '/x') - a small project-local wrapper, the style Web-Scout's dashboard uses.
export function apiCalls(source) {
  const out = [];
  const pairs = [
    ...[...source.matchAll(/api\('([A-Z]+)',\s*`([^`]*)`/g)].map((m) => [m[1], m[2]]),
    ...[...source.matchAll(/api\('([A-Z]+)',\s*(['"])([^'"]*)\2/g)].map((m) => [m[1], m[3]]),
  ];
  for (const [method, raw] of pairs) if (!raw.endsWith('/')) out.push(`${method} ${callPath(raw)}`);
  return out;
}

// fetch('/x') and fetch('/x', { method: 'POST' }). Absolute URLs are someone else's backend and are skipped.
export function fetchCalls(source) {
  const out = [];
  for (const m of source.matchAll(/fetch\(\s*([`'"])([^`'"]*)\1([^)]{0,200})/g)) {
    if (!m[2].startsWith('/') || m[2].endsWith('/')) continue;
    const method = /method:\s*['"]([A-Za-z]+)['"]/.exec(m[3])?.[1]?.toUpperCase() ?? 'GET';
    out.push(`${method} ${callPath(m[2])}`);
  }
  return out;
}

// axios.get('/x'), http.post('/x'), client.delete('/x') ...
export function axiosCalls(source) {
  const out = [];
  for (const m of source.matchAll(/\b(?:axios|http|client|api)\.(get|post|put|patch|delete)\(\s*(['"`])([^'"`]*)\2/g)) {
    if (m[3].startsWith('/') && !m[3].endsWith('/')) out.push(`${m[1].toUpperCase()} ${callPath(m[3])}`);
  }
  return out;
}

export const extractors = { literal, expressCalls, methodPattern, apiCalls, fetchCalls, axiosCalls };
