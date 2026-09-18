// Pure reshaping of a read result BEFORE it is handed to the caller. The relay
// keeps, caches and logs the full result; only what the caller receives changes,
// and only when the caller asked (or the session budget forced it). Nothing here
// touches I/O, so every function is unit-tested in read-shape.test.mjs.
//
//   tabulate      rows of objects -> { columns, rows: [[...]] } (keys said once)
//   peekSummary   a large result -> counts, columns, one sample row, size estimate
//   computeReadDelta   previous full result vs new one -> only what changed

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const sizeOf = (v) => JSON.stringify(v).length;

const MIN_TABLE_ROWS = 3;
const SAMPLE_STRING_CHARS = 120;

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// Column order = first-seen order across rows.
function columnsOf(rows) {
  const cols = [];
  const seen = new Set();
  for (const r of rows) for (const k of Object.keys(r)) if (!seen.has(k)) { seen.add(k); cols.push(k); }
  return cols;
}

// Only worth it (and only lossless) when enough rows share keys. A row missing a
// column gets null, which is ambiguous with a stored null - `sparse` says so.
// Returns the same object untouched when no array in it qualifies.
export function tabulate(result) {
  if (!isPlain(result)) return { result, changed: false };
  let changed = false;
  const out = {};
  for (const [key, value] of Object.entries(result)) {
    if (Array.isArray(value) && value.length >= MIN_TABLE_ROWS && value.every(isPlain)) {
      const columns = columnsOf(value);
      if (columns.length >= 2) {
        const sparse = value.some((r) => Object.keys(r).length !== columns.length);
        out[key] = { columns, rows: value.map((r) => columns.map((c) => (Object.prototype.hasOwnProperty.call(r, c) ? r[c] : null))), ...(sparse ? { sparse: true } : {}) };
        changed = true;
        continue;
      }
    }
    out[key] = value;
  }
  if (!changed) return { result, changed: false };
  return { result: { ...out, __table: true }, changed: true };
}

function clip(value) {
  if (typeof value === 'string' && value.length > SAMPLE_STRING_CHARS) return `${value.slice(0, SAMPLE_STRING_CHARS)}... (+${value.length - SAMPLE_STRING_CHARS} chars)`;
  if (isPlain(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clip(v)]));
  if (Array.isArray(value)) return value.length > 3 ? [...value.slice(0, 3).map(clip), `... (+${value.length - 3} more)`] : value.map(clip);
  return value;
}

const NARROWING_HINT = {
  'idb.dump': 'narrow it: --where \'{"field":value}\' --fields a,b --limit N (matchedCount says how many rows match)',
  'net.log': 'narrow it: --url <substring> --limit N',
  'console.log': 'narrow it: --limit N',
  'dom.query': 'narrow it: a more specific selector, or --meta for counts only',
  'dom.computedStyle': 'narrow it: pass only the properties you need',
  'react.inspect': 'narrow it: a more specific selector',
  'react.tree': 'narrow it: a smaller --max-depth or a more specific selector',
};

// Shape of a result without its bulk: what is in it, how big it is, and how to
// ask for less. `estTokens` comes from the caller (token-estimate.mjs) so this
// module stays free of calibration state.
export function peekSummary(type, result, { estTokens, estBytes = sizeOf(result), guarded = false, guardTokens } = {}) {
  const summary = { peek: true, ...(guarded ? { guarded: true } : {}), type, estBytes, estTokens };
  if (isPlain(result)) {
    const scalars = {};
    const arrays = {};
    const objects = {};
    for (const [key, value] of Object.entries(result)) {
      if (Array.isArray(value)) {
        const rowsLike = value.filter(isPlain);
        const bytes = sizeOf(value);
        arrays[key] = {
          count: value.length,
          bytes,
          ...(rowsLike.length ? { columns: columnsOf(rowsLike).slice(0, 40), sample: clip(rowsLike[0]) } : { sample: clip(value[0]) }),
          avgItemBytes: value.length ? Math.round(bytes / value.length) : 0,
        };
      } else if (isPlain(value)) {
        objects[key] = { keys: Object.keys(value).slice(0, 30), bytes: sizeOf(value) };
      } else if (typeof value === 'string' && value.length > SAMPLE_STRING_CHARS) {
        scalars[key] = { chars: value.length, head: `${value.slice(0, 60)}...` };
      } else {
        scalars[key] = value;
      }
    }
    summary.scalars = scalars;
    if (Object.keys(arrays).length) summary.arrays = arrays;
    if (Object.keys(objects).length) summary.objects = objects;
  } else if (Array.isArray(result)) {
    summary.arrays = { '(top level)': { count: result.length, bytes: sizeOf(result), sample: clip(result[0]) } };
  } else {
    summary.value = clip(result);
  }
  const how = NARROWING_HINT[type];
  const again = guarded ? 'with --no-guard' : 'without --peek';
  summary.next = `${guarded ? `this read is over the ~${guardTokens}-token guard for this session, so only its shape was returned. ` : ''}${how ? `${how}; ` : ''}the full result is cached on the relay, so repeating the same call ${again} returns it with no page round trip.`;
  return summary;
}

// ---------- delta ----------

const ID_CANDIDATES = ['id', 'key', 'uuid', 'seq', 'requestId'];

// A field every row in both arrays has, whose values are unique in each -
// otherwise rows cannot be matched by identity.
function identityField(prevRows, nextRows, hint) {
  const candidates = [...(typeof hint === 'string' ? [hint] : []), ...ID_CANDIDATES];
  for (const field of candidates) {
    const all = [...prevRows, ...nextRows];
    if (!all.every((r) => isPlain(r) && Object.prototype.hasOwnProperty.call(r, field))) continue;
    const unique = (rows) => new Set(rows.map((r) => JSON.stringify(r[field]))).size === rows.length;
    if (unique(prevRows) && unique(nextRows)) return field;
  }
  return null;
}

function diffArrays(prev, next, keyPathHint) {
  const bothRows = prev.every(isPlain) && next.every(isPlain);
  const field = bothRows && (prev.length || next.length) ? identityField(prev, next, keyPathHint) : null;
  if (field) {
    const prevById = new Map(prev.map((r) => [JSON.stringify(r[field]), r]));
    const nextIds = new Set(next.map((r) => JSON.stringify(r[field])));
    const added = [];
    const changed = [];
    for (const r of next) {
      const id = JSON.stringify(r[field]);
      if (!prevById.has(id)) added.push(r);
      else if (!sameJson(prevById.get(id), r)) changed.push(r);
    }
    const removed = prev.filter((r) => !nextIds.has(JSON.stringify(r[field]))).map((r) => r[field]);
    return { by: field, prevCount: prev.length, nextCount: next.length, ...(added.length ? { added } : {}), ...(changed.length ? { changed } : {}), ...(removed.length ? { removed } : {}) };
  }
  // No stable id (net.log / console.log entries): match by content. A row edited in
  // place shows as one added row; removed rows are counted, not listed.
  const remaining = new Map();
  for (const r of prev) { const k = JSON.stringify(r); remaining.set(k, (remaining.get(k) ?? 0) + 1); }
  const added = [];
  for (const r of next) {
    const k = JSON.stringify(r);
    if (remaining.get(k) > 0) remaining.set(k, remaining.get(k) - 1);
    else added.push(r);
  }
  const removedCount = [...remaining.values()].reduce((a, b) => a + b, 0);
  return { by: 'content', prevCount: prev.length, nextCount: next.length, ...(added.length ? { added } : {}), ...(removedCount ? { removedCount, removedNote: 'rows had no id, so the removed ones are counted, not listed' } : {}) };
}

// `prev` and `next` are FULL results of the same call. Returns null when a delta
// does not apply (not objects) or would not be smaller than `next` - the caller
// then just sends `next`.
export function computeReadDelta(prev, next, { maxRatio = 0.7 } = {}) {
  if (!isPlain(prev) || !isPlain(next)) return null;
  const unchangedKeys = [];
  const changed = {};
  const arrays = {};
  for (const [key, value] of Object.entries(next)) {
    if (!Object.prototype.hasOwnProperty.call(prev, key)) { changed[key] = value; continue; }
    if (sameJson(prev[key], value)) { unchangedKeys.push(key); continue; }
    if (Array.isArray(prev[key]) && Array.isArray(value)) { arrays[key] = diffArrays(prev[key], value, next.keyPath ?? prev.keyPath); continue; }
    changed[key] = value;
  }
  const removedKeys = Object.keys(prev).filter((k) => !Object.prototype.hasOwnProperty.call(next, k));
  const delta = {
    ...(unchangedKeys.length ? { unchangedKeys } : {}),
    ...(Object.keys(changed).length ? { changed } : {}),
    ...(Object.keys(arrays).length ? { arrays } : {}),
    ...(removedKeys.length ? { removedKeys } : {}),
  };
  if (sizeOf(delta) >= sizeOf(next) * maxRatio) return null;
  return delta;
}
