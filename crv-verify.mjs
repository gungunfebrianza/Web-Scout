// The verify half of a baseline -> action -> verify CRV loop, as pure functions.
//
// Reading the same state three times to prove a change costs three full bodies.
// `idb verify` takes the baseline snapshot once, re-snapshots the same stores, and
// answers in a few lines: did every expectation hold, did anything ELSE change, and
// for the parts that failed only, what exactly differed (changed rows as
// {field: [before, after]}, not two whole rows). The full diff is still saved by the
// relay; nothing here reads or writes I/O.
//
// Expectation syntax (one comma-separated term per store):
//   notes:+1        exactly one row added (removed/changed unconstrained)
//   notes:+1+       at least one row added
//   notes:+1-0~0    exactly one added, none removed, none changed
//   tags:same       no row added, removed or changed
//   notes:~2        two rows changed
// or JSON: [{"store":"notes","added":1},{"store":"tags","unchanged":true}], keys
// added/addedGte/addedLte/removed/changed/unchanged.

const BUCKETS = ['added', 'removed', 'changed'];
const SIGN = { '+': 'added', '-': 'removed', '~': 'changed' };
const CLAUSE = /([+\-~])(\d+)(\+)?/y;

function parseSpec(spec, term) {
  const s = spec.trim();
  if (s === 'same' || s === 'none' || s === '0') return { unchanged: true };
  const out = {};
  let i = 0;
  while (i < s.length) {
    CLAUSE.lastIndex = i;
    const m = CLAUSE.exec(s);
    if (!m) throw new Error(`cannot read expectation "${term}" at "${s.slice(i)}" - use +N (added), -N (removed), ~N (changed), a trailing + for "at least", or "same"`);
    const [, sign, n, atLeast] = m;
    const bucket = SIGN[sign];
    if (atLeast) {
      if (bucket !== 'added') throw new Error(`"${term}": "at least" (trailing +) is only supported for added rows, e.g. notes:+1+`);
      out.addedGte = Number(n);
    } else {
      out[bucket] = Number(n);
    }
    i = CLAUSE.lastIndex;
  }
  if (!Object.keys(out).length) throw new Error(`empty expectation for "${term}"`);
  return out;
}

export function parseExpect(input) {
  if (input === undefined || input === null || input === '') return [];
  let list;
  if (typeof input === 'string') {
    const text = input.trim();
    if (text.startsWith('[') || text.startsWith('{')) {
      let parsed;
      try { parsed = JSON.parse(text); } catch (err) { throw new Error(`expect is not valid JSON: ${err.message}`); }
      list = Array.isArray(parsed) ? parsed : [parsed];
    } else {
      list = text.split(',').map((t) => t.trim()).filter(Boolean).map((term) => {
        const idx = term.indexOf(':');
        if (idx < 1) throw new Error(`expectation "${term}" needs the form store:spec, e.g. notes:+1`);
        return { store: term.slice(0, idx).trim(), ...parseSpec(term.slice(idx + 1), term) };
      });
    }
  } else if (Array.isArray(input)) list = input;
  else if (typeof input === 'object') list = [input];
  else throw new Error('expect must be a string, an object or an array');

  return list.map((e) => {
    if (!e || typeof e.store !== 'string' || !e.store) throw new Error('every expectation needs a "store"');
    const known = ['store', 'added', 'addedGte', 'addedLte', 'removed', 'changed', 'unchanged'];
    const stray = Object.keys(e).filter((k) => !known.includes(k));
    if (stray.length) throw new Error(`expectation for "${e.store}" has unknown key(s) ${stray.join(', ')} (valid: ${known.slice(1).join(', ')})`);
    const constrained = known.slice(1).some((k) => e[k] !== undefined);
    if (!constrained) throw new Error(`expectation for "${e.store}" constrains nothing`);
    return e;
  });
}

const zero = { added: 0, removed: 0, changed: 0 };

export function describeExpectation(e) {
  if (e.unchanged) return 'same';
  const parts = [];
  if (e.added !== undefined) parts.push(`+${e.added}`);
  if (e.addedGte !== undefined) parts.push(`+${e.addedGte}+`);
  if (e.addedLte !== undefined) parts.push(`+<=${e.addedLte}`);
  if (e.removed !== undefined) parts.push(`-${e.removed}`);
  if (e.changed !== undefined) parts.push(`~${e.changed}`);
  return parts.join('');
}

const describeActual = (a) => `+${a.added}-${a.removed}~${a.changed}`;

// summary: { store: {added, removed, changed} } for stores that changed (stores that
// did not change are absent, like summarizeDiff's output).
export function evaluateExpectations(summary, expectations, { allowExtra = false } = {}) {
  const named = new Set();
  const results = [];
  for (const e of expectations) {
    named.add(e.store);
    const actual = { ...zero, ...(summary?.[e.store] ?? {}) };
    const problems = [];
    if (e.unchanged && (actual.added || actual.removed || actual.changed)) problems.push('expected no change');
    if (e.added !== undefined && actual.added !== e.added) problems.push(`added ${actual.added}, expected ${e.added}`);
    if (e.addedGte !== undefined && actual.added < e.addedGte) problems.push(`added ${actual.added}, expected at least ${e.addedGte}`);
    if (e.addedLte !== undefined && actual.added > e.addedLte) problems.push(`added ${actual.added}, expected at most ${e.addedLte}`);
    if (e.removed !== undefined && actual.removed !== e.removed) problems.push(`removed ${actual.removed}, expected ${e.removed}`);
    if (e.changed !== undefined && actual.changed !== e.changed) problems.push(`changed ${actual.changed}, expected ${e.changed}`);
    results.push({ store: e.store, pass: problems.length === 0, expected: describeExpectation(e), actual: describeActual(actual), ...(problems.length ? { problem: problems.join('; ') } : {}) });
  }
  const unexpected = Object.entries(summary ?? {})
    .filter(([store, s]) => !named.has(store) && (s.added || s.removed || s.changed))
    .map(([store, s]) => ({ store, added: s.added, removed: s.removed, changed: s.changed }));
  const passed = results.every((r) => r.pass) && (allowExtra || unexpected.length === 0);
  return { passed, results, unexpected };
}

const clip = (v, n = 60) => {
  if (typeof v === 'string') return v.length > n ? `${v.slice(0, n)}...(${v.length})` : v;
  if (v && typeof v === 'object') { const s = JSON.stringify(v); return s.length > n ? `${s.slice(0, n)}...(${s.length})` : v; }
  return v;
};

export function briefRow(row) {
  if (!row || typeof row !== 'object') return clip(row);
  return Object.fromEntries(Object.entries(row).slice(0, 12).map(([k, v]) => [k, clip(v)]));
}

// A changed row as the fields that differ: {key, fields: {f: [before, after]}}.
export function changedFields(before, after) {
  const fields = {};
  const names = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  for (const f of names) {
    if (JSON.stringify(before?.[f]) !== JSON.stringify(after?.[f])) fields[f] = [clip(before?.[f], 40), clip(after?.[f], 40)];
  }
  return fields;
}

// The rows behind a store's counts, cut to `limit` per bucket, the way a person
// debugging a failed check wants them.
export function sampleStoreDiff(storeDiff, limit = 3) {
  const out = {};
  for (const bucket of BUCKETS) {
    const list = storeDiff?.[bucket] ?? [];
    if (!list.length) continue;
    const shown = list.slice(0, limit).map((item) => (bucket === 'changed' ? { key: item.key, fields: changedFields(item.before, item.after) } : briefRow(item)));
    out[bucket] = list.length > limit ? { rows: shown, more: list.length - limit } : { rows: shown };
  }
  return out;
}

// diff: computeDiff's full output (kept out of the reply); summary: its counts.
export function buildVerifyReport({ baselineId, afterId, diffId, summary, diff, expectations, allowExtra = false, samples = 3, verbose = false }) {
  const evaluated = evaluateExpectations(summary, expectations, { allowExtra });
  // No expectations at all means "expect no change anywhere" - the regression guard.
  const guard = expectations.length === 0;
  const changedStores = Object.entries(summary ?? {}).filter(([, s]) => s.added || s.removed || s.changed);
  const passed = guard ? changedStores.length === 0 : evaluated.passed;
  const failing = evaluated.results.filter((r) => !r.pass);
  const report = {
    passed,
    baselineSnapshotId: baselineId,
    afterSnapshotId: afterId,
    diffId,
    checked: expectations.length,
    ...(guard ? { mode: 'no-change guard (no expectations given)' } : {}),
  };
  if (failing.length) report.failed = failing;
  const extra = guard ? changedStores.map(([store, s]) => ({ store, ...s })) : evaluated.unexpected;
  if (extra.length) report[allowExtra && !guard ? 'otherChanges' : 'unexpected'] = extra;
  if (passed && !verbose) {
    report.changedStores = Object.fromEntries(changedStores.map(([store, s]) => [store, describeActual(s)]));
    return report;
  }
  // Rows only for the stores that explain the failure (or all changed ones with verbose).
  const explain = new Set([...failing.map((r) => r.store), ...extra.map((x) => x.store)]);
  if (verbose) for (const [store] of changedStores) explain.add(store);
  const sampled = {};
  for (const store of explain) {
    const s = sampleStoreDiff(diff?.[store], samples);
    if (Object.keys(s).length) sampled[store] = s;
  }
  if (Object.keys(sampled).length) report.samples = sampled;
  if (!passed) report.hint = `the full diff is saved (GET /state/diffs/${diffId}); pass --samples N for more rows per store, --verbose for every changed store`;
  return report;
}
