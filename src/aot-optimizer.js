// First-launch optimisation (track 3, P7): build the compilation plan of the
// user's disc, then feed its regions to the region compiler in compile order
// until they are all in the persistent cache. Interruptible at any point:
// progress is what the cache holds, so a reload resumes where it stopped.
//
// Interface consumed by the site (P8), on the host or the adapter:
//   optimizationStatus() -> { state: "none"|"partial"|"complete", fraction }
//   startOptimization({ resume }) / cancelOptimization()
//   events "optimization-progress" { fraction, done, total, unit: "regions" },
//          "optimization-done" { total, ms }, "optimization-error" { message, fatal }
//
// Two collaborators:
//   translator (P4, region compiler in the core, fed from guest memory):
//     translate(regions) -> Promise<[{ key, bytes } | { key, reason }]>
//   cache (P5/P6, src/aot-cache.js): openAotCache({ discKey, coreHash, compilerVersion, flagsMask })
//     -> session { has(keys) -> Set, put([{ key, bytes, meta }]) -> { failed: [{ key, reason }] }, cancel() }
// The cache key of a region is its fingerprint (known before translation, so
// has() can resume an interrupted run).
import { orderedRegions, validatePlan, ANALYZER_VERSION } from "./aot-plan.js";

export const PLAN_CACHE_DIR = "aot-plan";
const BATCH = 64;

const regionWeight = (f) => f.ranges.reduce((n, [s, e]) => n + e - s, 0);

export class AotOptimizer extends EventTarget {
  // buildPlan: () => Promise<plan> (planDisc over the user's disc, with its profile)
  // planStore: { load(discKey) -> plan|null, save(discKey, plan) } (optional)
  constructor({ discKey, buildPlan, translator, openCache, cacheIdentity = {}, planStore = null, batchSize = BATCH, now = () => performance.now() }) {
    super();
    this.discKey = discKey;
    this.buildPlan = buildPlan;
    this.translator = translator;
    this.openCache = openCache;
    this.cacheIdentity = cacheIdentity;
    this.planStore = planStore;
    this.now = now;
    this.batchSize = batchSize;
    this.plan = null;
    this.session = null;
    this.running = null;
    this.cancelled = false;
  }

  async getPlan() {
    if (this.plan) return this.plan;
    let plan = null;
    try {
      plan = await this.planStore?.load(this.discKey);
      if (plan && plan.analyzer !== ANALYZER_VERSION) plan = null;
      if (plan) validatePlan(plan);
    } catch {
      plan = null; // a bad cached plan is rebuilt
    }
    if (!plan) {
      plan = validatePlan(await this.buildPlan());
      await this.planStore?.save(this.discKey, plan).catch(() => {});
    }
    this.plan = plan;
    this.regions = orderedRegions(plan).filter((r) => r.f.hash);
    this.totalWeight = this.regions.reduce((n, r) => n + regionWeight(r.f), 0);
    return plan;
  }

  async openSession() {
    if (!this.session) this.session = await this.openCache({ discKey: this.discKey, ...this.cacheIdentity });
    return this.session;
  }

  // Weighted by region size: a 10 KiB region counts more than a 40-byte one.
  progress(doneSet) {
    let doneWeight = 0, done = 0;
    for (const r of this.regions) if (doneSet.has(r.f.hash)) { done++; doneWeight += regionWeight(r.f); }
    const fraction = this.totalWeight ? doneWeight / this.totalWeight : 1;
    return { fraction, done, total: this.regions.length, unit: "regions" };
  }

  async status() {
    await this.getPlan();
    const session = await this.openSession();
    const doneSet = await session.has(this.regions.map((r) => r.f.hash));
    const p = this.progress(doneSet);
    return { state: p.done === 0 ? "none" : p.done >= p.total ? "complete" : "partial", fraction: p.fraction };
  }

  start({ resume = true } = {}) {
    if (this.running) return this.running;
    this.cancelled = false;
    this.running = this.run(resume).finally(() => { this.running = null; });
    return this.running;
  }

  cancel() {
    this.cancelled = true;
    this.session?.cancel?.();
    this.session = null; // the next start opens a fresh session
  }

  emit(type, detail) {
    this.dispatchEvent(Object.assign(new Event(type), { detail }));
  }

  async run() {
    const t0 = this.now();
    try {
      await this.getPlan();
      const session = await this.openSession();
      const doneSet = await session.has(this.regions.map((r) => r.f.hash));
      // Regions refused once (hash mismatch, engine reject) are left to the JIT.
      const refused = new Set();
      const todo = this.regions.filter((r) => !doneSet.has(r.f.hash));
      this.emit("optimization-progress", this.progress(doneSet));
      for (let i = 0; i < todo.length && !this.cancelled; i += this.batchSize) {
        const batch = todo.slice(i, i + this.batchSize).map(({ module, f }) => ({
          module, entry: f.entry, flags: f.flags ?? 0, hash: f.hash, ranges: f.ranges, extraEntries: f.extraEntries ?? []
        }));
        const translated = await this.translator.translate(batch);
        if (this.cancelled) break;
        const failed = translated.filter((t) => !t.bytes);
        const ok = translated.filter((t) => t.bytes);
        const stored = ok.length ? await session.put(ok.map((t) => ({ key: t.key, bytes: t.bytes, meta: t.meta ?? null }))) : { failed: [] };
        if (this.cancelled) break;
        failed.push(...(stored.failed ?? []));
        const failedKeys = new Set(failed.map((x) => x.key));
        for (const t of ok) if (!failedKeys.has(t.key)) doneSet.add(t.key);
        for (const x of failed) {
          refused.add(x.key);
          doneSet.add(x.key); // handled (left to the JIT): progress must reach 100 %
          this.emit("optimization-error", { message: `region ${x.key}: ${x.reason}`, fatal: false });
        }
        this.emit("optimization-progress", this.progress(doneSet));
      }
      if (!this.cancelled) this.emit("optimization-done", { total: this.regions.length, refused: refused.size, ms: Math.round(this.now() - t0) });
    } catch (error) {
      this.emit("optimization-error", { message: String(error?.message || error), fatal: true });
    }
  }
}

// Plan cache in OPFS: aot-plan/<discKey>.json, rebuilt when the analyzer changes.
export class OpfsPlanStore {
  constructor(root) {
    this.root = root;
  }
  static name(discKey) {
    const key = String(discKey);
    if (!/^[0-9A-Za-z_-]{1,128}$/.test(key)) throw new Error("aot-optimizer: invalid disc key");
    return `${key}.json`;
  }
  async dir() {
    return this.root.getDirectoryHandle(PLAN_CACHE_DIR, { create: true });
  }
  async load(discKey) {
    try {
      const file = await (await (await this.dir()).getFileHandle(OpfsPlanStore.name(discKey))).getFile();
      return JSON.parse(await file.text());
    } catch (error) {
      if (error?.name === "NotFoundError" || error instanceof SyntaxError) return null;
      throw error;
    }
  }
  async save(discKey, plan) {
    const handle = await (await this.dir()).getFileHandle(OpfsPlanStore.name(discKey), { create: true });
    const writable = await handle.createWritable();
    await writable.write(JSON.stringify(plan));
    await writable.close();
  }
}

// Stand-ins with the agreed shapes, for tests and the site's simulated flow.
// fakeTranslator: "translates" in `msPerKiB` per KiB of guest code, refuses
// keys listed in `refuse`. fakeCache: an in-memory cache session factory.
export function fakeTranslator({ msPerKiB = 0, refuse = new Set(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  return {
    async translate(regions) {
      const out = [];
      for (const r of regions) {
        if (refuse.has(r.hash)) { out.push({ key: r.hash, reason: "engine-reject" }); continue; }
        const bytes = r.ranges.reduce((n, [s, e]) => n + e - s, 0);
        if (msPerKiB) await sleep((bytes / 1024) * msPerKiB);
        out.push({ key: r.hash, bytes: new Uint8Array(8) });
      }
      return out;
    }
  };
}

export function fakeCache({ persisted = new Map(), quotaKeys = new Set() } = {}) {
  const open = async () => {
    let cancelled = false;
    return {
      async has(keys) {
        return new Set(keys.filter((k) => persisted.has(k)));
      },
      async put(entries) {
        const failed = [];
        for (const e of entries) {
          if (cancelled) break;
          if (quotaKeys.has(e.key)) failed.push({ key: e.key, reason: "quota" });
          else persisted.set(e.key, e.bytes);
        }
        return { failed };
      },
      cancel() {
        cancelled = true;
      }
    };
  };
  open.persisted = persisted;
  return open;
}
