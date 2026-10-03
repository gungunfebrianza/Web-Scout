// The /state/* family of HTTP routes (snapshot, snapshots/:id, diff, diffs/:id, verify, restore), split out of relay.mjs.
// Everything the handlers need arrives in `d`. surfaces.test.mjs reads this file too.
export function stateRoutes(d) {
  const { broadcastUpdate, COMMAND_TIMEOUT_MS, computeDiff, dbApi, DEFAULT_AGENT, dispatchCommand, HttpError, readJsonBody, requireActiveSession, SNAPSHOT_TIMEOUT_MS, summarizeDiff, verifyAgainstBaseline, withLoggedAction } = d;
  return [
  {
    method: 'POST',
    pattern: /^\/state\/snapshot$/,
    handler: async (req) => {
      const body = await readJsonBody(req);
      const agentName = body.agent || DEFAULT_AGENT;
      const stores = Array.isArray(body.stores) ? body.stores : undefined;
      const goldenName = typeof body.golden === 'string' && body.golden.trim() ? body.golden.trim() : undefined;
      const where = body.where && typeof body.where === 'object' ? body.where : undefined;
      const session = requireActiveSession();
      const { result, actionId } = await withLoggedAction(session.id, 'idb.snapshot', { stores, golden: goldenName, where }, () => dispatchCommand('idb.snapshot', { stores, where }, SNAPSHOT_TIMEOUT_MS, agentName), agentName);
      const saved = dbApi.saveSnapshot({ sessionId: session.id, actionId, stores: result.stores, agentName, goldenName, where });
      broadcastUpdate('action', session.id);
      broadcastUpdate('snapshot', session.id);
      return { id: saved.id, takenAt: saved.takenAt, counts: saved.counts, byteSize: saved.byteSize, agentName: saved.agentName, goldenName: saved.goldenName, where: saved.where };
    },
  },
  { method: 'GET', pattern: /^\/state\/snapshots\/(\d+)$/, handler: async (_req, m) => dbApi.getSnapshot(Number(m[1])) },
  {
    // Accepts EITHER {idA, idB} (two persisted snapshot ids, original form)
    // OR {golden: "<name>", idB} (resolves idA via the latest snapshot
    // tagged with that name, from ANY session - see db.mjs's
    // getGoldenSnapshot) - a golden regression baseline lets a later phase
    // ask "did I touch anything this name already proved untouched" without
    // hunting down an old snapshot id by hand.
    method: 'POST',
    pattern: /^\/state\/diff$/,
    handler: async (req) => {
      const body = await readJsonBody(req);
      const idB = Number(body.idB);
      if (!idB) throw new HttpError(400, 'idB (snapshot id) is required');
      const session = requireActiveSession();
      let idA;
      if (body.golden) {
        const golden = dbApi.getGoldenSnapshot(String(body.golden));
        idA = golden.id;
      } else {
        idA = Number(body.idA);
        if (!idA) throw new HttpError(400, 'idA (snapshot id) or golden (name) is required');
      }
      // Content-hash cache check (see db.mjs's findCachedDiff): two
      // DIFFERENT snapshot ids whose own content is byte-identical to a
      // pair already diffed produce the same diff - a repeat "suite run"
      // (diff-golden re-checked every phase even when nothing changed) no
      // longer pays to recompute OR receive that full diff body again.
      const snapA = dbApi.getSnapshot(idA);
      const snapB = dbApi.getSnapshot(idB);
      const cached = dbApi.findCachedDiff(snapA.content_hash, snapB.content_hash);
      const { result, actionId } = await withLoggedAction(session.id, 'idb.diff', { idA, idB, golden: body.golden ?? undefined, fromCache: !!cached }, async () => {
        if (cached) return { diff: cached.diff, summary: cached.summary };
        const diff = computeDiff(snapA.stores, snapB.stores);
        return { diff, summary: summarizeDiff(diff) };
      });
      const saved = dbApi.saveDiff({ sessionId: session.id, actionId, fromId: idA, toId: idB, summary: result.summary, diff: result.diff, servedFromDiffId: cached ? cached.id : null });
      broadcastUpdate('action', session.id);
      broadcastUpdate('diff', session.id);
      if (cached) {
        // The full diff is still SAVED (GET /diffs/:id has it, unabridged -
        // data integrity for anyone who later wants full detail) but
        // deliberately OMITTED from this immediate response - the caller
        // already has it (it's identical to diff #cached.id), so re-sending
        // it here would be pure waste. `diff: undefined` drops the key from
        // the JSON response (JSON.stringify skips undefined properties).
        return { ...saved, diff: undefined, fromCache: true, cachedFromDiffId: cached.id, note: `identical content to diff #${cached.id} - full diff omitted here (nothing changed since), not recomputed or re-sent. Fetch diff #${cached.id} (GET /diffs) for full detail if genuinely needed.` };
      }
      return saved;
    },
  },
  {
    // The verify half of baseline -> action -> verify in ONE call: re-snapshot the
    // baseline's own stores, diff, check the expectations (crv-verify.mjs), and
    // answer in a few lines - pass/fail, what else changed, and rows only for the
    // parts that failed. The fresh snapshot and the full diff are persisted like
    // any other, so the evidence trail is as complete as with snapshot + diff by hand.
    // Baseline: an id, a golden name, or (default) the session's newest snapshot,
    // so consecutive verifies each baseline the step before.
    method: 'POST',
    pattern: /^\/state\/verify$/,
    handler: async (req) => {
      const body = await readJsonBody(req);
      const agentName = body.agent || DEFAULT_AGENT;
      const session = requireActiveSession();
      let baseline;
      if (body.baseline !== undefined && body.baseline !== null && String(body.baseline) !== '') {
        const ref = String(body.baseline);
        baseline = /^\d+$/.test(ref) ? dbApi.getSnapshot(Number(ref)) : dbApi.getGoldenSnapshot(ref);
      } else {
        const newest = dbApi.listSnapshots(session.id)[0];
        if (!newest) throw new HttpError(409, 'no baseline to verify against - take one first ("idb snapshot --stores a,b"), or pass a snapshot id / golden name as the baseline');
        baseline = dbApi.getSnapshot(newest.id);
      }
      const stores = Array.isArray(body.stores) && body.stores.length ? body.stores : Object.keys(baseline.stores || {});
      return verifyAgainstBaseline(session, agentName, { baseline, stores, expect: body.expect, allowExtra: body.allowExtra, samples: body.samples, verbose: body.verbose });
    },
  },
  {
    // Replays a persisted snapshot's rows back into IndexedDB, one idb.put
    // per row per store - the missing write-back half of golden snapshots/
    // idb diff (which only ever DETECT drift, never correct it). Accepts
    // either {snapshotId} or {golden: "<name>"} (resolved via
    // dbApi.getGoldenSnapshot, same latest-tagged-wins semantics as
    // /state/diff's own golden form). Deliberately additive-only: it never
    // deletes a row added since the snapshot was taken - an exact replace
    // needs an explicit idb.clear per store first, since a blind delete-
    // everything-then-restore could destroy real data restore was never
    // asked to touch. Each put is its own logged action (via: 'restore'),
    // so a partial failure (one bad row) still shows exactly which rows did
    // and didn't make it back, instead of one opaque batch result.
    method: 'POST',
    pattern: /^\/state\/restore$/,
    handler: async (req) => {
      const body = await readJsonBody(req);
      const agentName = body.agent || DEFAULT_AGENT;
      const session = requireActiveSession();
      let snapshot;
      if (body.golden) {
        snapshot = dbApi.getGoldenSnapshot(String(body.golden));
      } else {
        if (!body.snapshotId) throw new HttpError(400, 'snapshotId or golden (name) is required');
        snapshot = dbApi.getSnapshot(Number(body.snapshotId));
      }
      const stores = Object.keys(snapshot.stores || {});
      if (!stores.length) throw new HttpError(400, `snapshot ${snapshot.id} has no stores to restore`);
      const restored = {};
      const failed = [];
      for (const store of stores) {
        const rows = snapshot.stores[store].rows || [];
        let count = 0;
        for (const row of rows) {
          try {
            await withLoggedAction(session.id, 'idb.put', { store, row, via: 'restore', snapshotId: snapshot.id }, () => dispatchCommand('idb.put', { store, row }, COMMAND_TIMEOUT_MS, agentName), agentName);
            count += 1;
          } catch (err) {
            failed.push({ store, error: err.message, row });
          }
        }
        restored[store] = count;
      }
      broadcastUpdate('action', session.id);
      return {
        snapshotId: snapshot.id, goldenName: snapshot.golden_name ?? undefined, restored, failed,
        note: 'restore only PUTS rows from the snapshot - it does NOT delete rows added since the snapshot. Run idb.clear per store first if you need an exact replace instead of a merge.',
      };
    },
  },
  // GET /state/diffs/:id (the saved diff a POST /state/diff or /state/verify points at)
  { method: 'GET', pattern: /^\/state\/diffs\/(\d+)$/, handler: async (_req, m) => dbApi.getDiff(Number(m[1])) },
  ];
}
