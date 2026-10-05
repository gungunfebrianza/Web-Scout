// Live mode: ask a running service whether the routes on the map answer, and how many things they hold.
// Probing happens here, on the machine running `surfacemap serve`, never in the page: the page is opened from
// disk or another origin and a browser would block the calls, and a hung stream (server-sent events) would
// stall it. Only GET is ever sent.

const GET_KEY = /^GET (\S+)$/;
const asPattern = (p) => (p instanceof RegExp ? p : new RegExp(p));

// Which routes can be probed safely: a GET with no path parameters (nothing to fill in), passing the include /
// exclude lists in the config. Everything else is listed in `skipped` with the reason, so the page can say why.
export function probeTargets(graph, live = {}) {
  const kind = live.kind ?? 'http';
  const include = (live.include ?? []).map(asPattern);
  const exclude = (live.exclude ?? []).map(asPattern);
  const targets = [];
  const skipped = {};
  for (const node of graph.nodes) {
    if (node.kind !== kind) continue;
    const m = GET_KEY.exec(node.key);
    if (!m) skipped[node.id] = 'not a GET route, so it is never called';
    else if (/[:*]/.test(m[1])) skipped[node.id] = 'the path has a parameter, so there is nothing safe to call';
    else if (include.length && !include.some((p) => p.test(node.key))) skipped[node.id] = 'not matched by live.include';
    else if (exclude.some((p) => p.test(node.key))) skipped[node.id] = 'left out by live.exclude';
    else targets.push({ id: node.id, path: m[1] });
  }
  return { targets, skipped };
}

// How many things a JSON answer holds: an array, a `count` / `total` field, or the first array it carries.
export function summarize(json) {
  if (Array.isArray(json)) return { count: json.length, countOf: 'items' };
  if (json && typeof json === 'object') {
    for (const k of ['count', 'total']) if (Number.isInteger(json[k]) && json[k] >= 0) return { count: json[k], countOf: k };
    for (const [k, v] of Object.entries(json)) if (Array.isArray(v)) return { count: v.length, countOf: k };
  }
  return {};
}

// One GET. Never throws: a dead service is a result (`error`), not a crash. The clock stops at the response
// headers, so a slow body does not read as a slow route. A stream is not read at all; a huge body is cut off.
export async function probeOne(base, route, { timeoutMs = 4000, headers = {}, maxBytes = 512 * 1024 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const started = performance.now();
  let out = null;
  try {
    const res = await fetch(base.replace(/\/+$/, '') + route, { headers, signal: ctl.signal, redirect: 'manual' });
    out = { status: res.status, ms: Math.round(performance.now() - started) };
    const type = res.headers.get('content-type') ?? '';
    if (!res.body) return out;
    if (/event-stream/i.test(type)) { await res.body.cancel().catch(() => {}); return { ...out, streaming: true }; }
    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
      if (size > maxBytes) { await reader.cancel().catch(() => {}); return { ...out, truncated: true }; }
    }
    if (/json/i.test(type)) {
      try { return { ...out, ...summarize(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }; } catch { /* not JSON after all */ }
    }
    return out;
  } catch (err) {
    if (out) return { ...out, partial: true };
    return { error: ctl.signal.aborted ? 'timeout' : (err.cause?.code ?? err.message) };
  } finally {
    clearTimeout(timer);
  }
}

// Probe every target, a few at a time.
export async function runProbes(graph, live, { concurrency = 6 } = {}) {
  const { targets, skipped } = probeTargets(graph, live);
  const results = {};
  let next = 0;
  const worker = async () => {
    while (next < targets.length) {
      const t = targets[next++];
      results[t.id] = await probeOne(live.target, t.path, live);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker));
  return { checkedAt: new Date().toISOString(), target: live.target, results, skipped };
}
