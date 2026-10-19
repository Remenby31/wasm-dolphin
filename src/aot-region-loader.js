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
//   const keys = await optimizer.bootKeys(); // P7: module keys (regionModuleKey), compile order
//   await loader.load({ ...identity, keys, budgetMs: 1500,
//     maxModules: DOLPHIN_JIT_CACHE_MAX - dolphinJitCacheMap.size });
//   ...installDolphinPthreadChannels(...)        // delivers what was loaded
//   void loader.loadRest();                      // the rest, retained only
//
// `keys` come from the optimiser in plan order (profile, then confidence,
// then size), never rebuilt from has(): the budget then cuts the coldest
// regions, which load after boot.

export const DEFAULT_REGION_BATCH = 64;

export function createAotRegionLoader({ openCache, retain, now = () => performance.now() }) {
  // Every load() starts a run with its own session, cut keys and caps; a
  // loadRest() or a batch of an older run stops at its next step.
  let current = null;
  let generation = 0;
  const totals = {
    loaded: 0, streamed: 0, missing: 0, corrupt: 0, rejected: 0, readErrors: 0, otherFailures: 0,
    skipped: 0, retainErrors: 0, overCap: 0, retainedBytes: 0
  };

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

  const live = (run) => run === current && !run.cancelled;

  // Loads `keys` of `run` in order. With a budget, regions load one at a time
  // and the budget is checked before each (time spent opening the cache
  // included); without one, by batches. Stops at the run's caps (modules,
  // bytes): what is left is counted over the cap, not deferred.
  async function loadKeys(run, keys, { budgetMs = Infinity, batchSize = DEFAULT_REGION_BATCH } = {}) {
    const report = { loaded: 0, failed: [], deferred: 0, overCap: 0, ms: 0 };
    const step = Number.isFinite(budgetMs) ? 1 : Math.max(1, batchSize);
    let i = 0;
    while (i < keys.length && live(run)) {
      if (now() - run.startedAt >= budgetMs) break;
      if (run.modules >= run.maxModules || run.bytes >= run.maxBytes) {
        report.overCap += keys.length - i;
        totals.overCap += keys.length - i;
        i = keys.length;
        break;
      }
      const batch = keys.slice(i, i + Math.min(step, run.maxModules - run.modules));
      let results;
      try {
        results = await run.session.load(batch);
      } catch (error) {
        results = new Map(batch.map((key) => [key, { reason: `load-error: ${error?.message || error}` }]));
      }
      if (!live(run)) break; // cancelled or superseded meanwhile: retain nothing more
      for (const [n, key] of batch.entries()) {
        if (run.bytes >= run.maxBytes) {
          // The byte cap is crossed inside this batch: the rest is over it
          // too (whatever follows in `keys` is counted at the top).
          report.overCap += batch.length - n;
          totals.overCap += batch.length - n;
          break;
        }
        const entry = results.get(key) ?? { reason: "missing" };
        count(entry);
        if (!entry.module) {
          if (entry.reason !== "missing") report.failed.push({ key, reason: entry.reason });
          continue;
        }
        try {
          retain(key, entry.module, entry.bytes);
          report.loaded += 1;
          run.modules += 1;
          run.bytes += entry.byteLength ?? 0;
          totals.retainedBytes += entry.byteLength ?? 0;
        } catch {
          totals.retainErrors += 1;
          report.failed.push({ key, reason: "retain-error" });
        }
      }
      i += batch.length;
    }
    run.deferred = live(run) ? keys.slice(i) : [];
    report.deferred = run.deferred.length;
    report.ms = now() - run.startedAt;
    return report;
  }

  const empty = (extra = {}) => ({ loaded: 0, failed: [], deferred: 0, overCap: 0, ms: 0, ...extra });

  return {
    // identity: { discKey, coreHash, compilerVersion, flagsMask } (openAotCache).
    // maxModules / maxBytes: what this launch may retain in all (load + loadRest).
    async load({ keys = [], budgetMs = Infinity, batchSize = DEFAULT_REGION_BATCH, maxModules = Infinity, maxBytes = Infinity, ...identity } = {}) {
      if (current) {
        current.cancelled = true;
        current.session?.cancel?.();
      }
      const run = { id: ++generation, startedAt: now(), cancelled: false, session: null, deferred: [], modules: 0, bytes: 0, maxModules, maxBytes };
      current = run;
      const list = Array.isArray(keys) ? keys : [];
      try {
        run.session = await openCache(identity);
      } catch (error) {
        return empty({ error: String(error?.message || error) });
      }
      if (!live(run)) return empty({ cancelled: true });
      if (!run.session) return empty({ error: "no-cache" });
      const wanted = list.filter((key) => {
        if (run.session.isBlacklisted?.(key)) {
          totals.skipped += 1;
          return false;
        }
        return true;
      });
      return loadKeys(run, wanted, { budgetMs, batchSize });
    },

    // What the budget cut in the latest load(), with no budget (after boot:
    // retained only). A later load() or cancel() stops it.
    async loadRest({ batchSize = DEFAULT_REGION_BATCH } = {}) {
      const run = current;
      if (!run || !live(run) || !run.session || !run.deferred.length) return empty();
      const keys = run.deferred;
      run.deferred = [];
      return loadKeys(run, keys, { batchSize });
    },

    // Stops at the next region or batch (pause, tab closing). Loaded Modules
    // stay retained; the next load() opens a new session.
    cancel() {
      if (!current) return;
      current.cancelled = true;
      current.deferred = [];
      current.session?.cancel?.();
    },

    stats: () => ({ ...totals, deferred: current?.deferred.length ?? 0, generation })
  };
}
