// Loading compiled regions back at launch (plan piste 3, P6 -> P7). Not wired
// yet: nothing produces regions before the region compiler (P4) and the
// first-launch optimiser (P7). This is the interface they plug into.
//
// How regions reach the CPU thread (decision c + c' + d, PROGRAM.md):
//   - before boot, the Modules loaded here are retained in the discio cache
//     map, and the existing pre-boot fence (installDolphinPthreadChannels)
//     hands them to every pthread;
//   - after boot no message reaches the CPU thread: Modules loaded later are
//     only retained, so that the CPU thread's own synchronous compile of the
//     same bytes hits V8's native module cache.
// Either way the call is the same: `retain(key, module)`.
//
// Wiring, when P4/P7 land (discio worker, loadCore, after the block cache):
//   const loader = createAotRegionLoader({ openCache: openDolphinAotCache,
//     retain: (key, module) => dolphinJitCacheMap.set(key, module) });
//   await loader.load({ ...identity, keys: hotFirstKeys, budgetMs: 1500 });
//   ...installDolphinPthreadChannels(...)        // delivers what was loaded
//   void loader.loadRest();                      // the rest, retained only
//
// `keys` come in plan order (orderedRegions: profile first), so the budget
// cuts the coldest regions, which then load after boot.

export const DEFAULT_REGION_BATCH = 64;

export function createAotRegionLoader({ openCache, retain, now = () => performance.now() }) {
  let session = null;
  let identityOpened = null;
  let deferred = [];
  let cancelled = false;
  const totals = { loaded: 0, streamed: 0, missing: 0, corrupt: 0, rejected: 0, readErrors: 0, otherFailures: 0, skipped: 0, retainErrors: 0 };

  async function ensureSession(identity) {
    const id = JSON.stringify(identity);
    if (session && identityOpened === id) return session;
    session = await openCache(identity);
    identityOpened = id;
    return session;
  }

  function count(entry) {
    if (entry.module) {
      totals.loaded += 1;
      if (entry.streamed) totals.streamed += 1;
      return;
    }
    if (entry.reason === "missing") totals.missing += 1;
    else if (entry.reason === "corrupt") totals.corrupt += 1;
    else if (entry.reason === "engine-reject") totals.rejected += 1;
    else if (entry.reason === "read-error") totals.readErrors += 1;
    else totals.otherFailures += 1;
  }

  // Loads `keys` in order, batch by batch, until `budgetMs` is spent (checked
  // between batches; what is left is `deferred`, for loadRest). Never throws:
  // a cache that cannot be opened is reported, the launch goes on with the JIT.
  async function loadKeys(keys, { budgetMs = Infinity, batchSize = DEFAULT_REGION_BATCH } = {}) {
    const t0 = now();
    const report = { loaded: 0, failed: [], deferred: 0, ms: 0 };
    let i = 0;
    for (; i < keys.length && !cancelled; i += batchSize) {
      if (i > 0 && now() - t0 >= budgetMs) break;
      const batch = keys.slice(i, i + batchSize);
      let results;
      try {
        results = await session.load(batch);
      } catch (error) {
        results = new Map(batch.map((key) => [key, { reason: `load-error: ${error?.message || error}` }]));
      }
      for (const key of batch) {
        const entry = results.get(key) ?? { reason: "missing" };
        count(entry);
        if (!entry.module) {
          if (entry.reason !== "missing") report.failed.push({ key, reason: entry.reason });
          continue;
        }
        try {
          retain(key, entry.module);
          report.loaded += 1;
        } catch {
          totals.retainErrors += 1;
          report.failed.push({ key, reason: "retain-error" });
        }
      }
    }
    deferred = cancelled ? [] : keys.slice(i);
    report.deferred = deferred.length;
    report.ms = now() - t0;
    return report;
  }

  return {
    // identity: { discKey, coreHash, compilerVersion, flagsMask } (openAotCache).
    async load({ keys, budgetMs = Infinity, batchSize = DEFAULT_REGION_BATCH, ...identity }) {
      cancelled = false;
      try {
        await ensureSession(identity);
      } catch (error) {
        return { loaded: 0, failed: [], deferred: 0, ms: 0, error: String(error?.message || error) };
      }
      if (!session) return { loaded: 0, failed: [], deferred: 0, ms: 0, error: "no-cache" };
      const wanted = keys.filter((key) => {
        if (session.isBlacklisted?.(key)) {
          totals.skipped += 1;
          return false;
        }
        return true;
      });
      return loadKeys(wanted, { budgetMs, batchSize });
    },

    // What the budget cut, with no budget (after boot: retained only).
    async loadRest({ batchSize = DEFAULT_REGION_BATCH } = {}) {
      if (!session || !deferred.length) return { loaded: 0, failed: [], deferred: 0, ms: 0 };
      return loadKeys(deferred, { batchSize });
    },

    // Stops at the next batch (pause, tab closing). Loaded Modules stay retained.
    cancel() {
      cancelled = true;
      deferred = [];
      session?.cancel?.();
      session = null; // a cancelled session refuses work: the next load opens a new one
    },

    stats: () => ({ ...totals, deferred: deferred.length })
  };
}
