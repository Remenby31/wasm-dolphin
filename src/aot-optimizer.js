// First-launch optimisation (track 3, P7): build the compilation plan of the
// user's disc, group its functions into region modules, have the core
// translate each function, assemble the fragments and store each module in
// the persistent cache, in compile order. Interruptible at any point:
// progress is what the cache holds, so a reload resumes where it stopped.
//
// Interface consumed by the site (P8), on the host or the adapter:
//   optimizationStatus() -> { state: "none"|"partial"|"complete", fraction }
//   startOptimization({ resume }) / cancelOptimization()
//   events "optimization-start" { fraction, done, total, unit, ms: 0, resumed },
//          "optimization-progress" { fraction, done, total, unit: "regions", ms },
//          "optimization-done" { total, refused, compiled, deferred, ms },
//          "optimization-error" { message, fatal }
//   (one region = one module; ms = time since this run started)
//
// Collaborators:
//   translator (P4, region translator in the core, fed from guest memory):
//     translate(functions) -> Promise<[{ entry, fragment } | { entry, reason }]>
//     in batch order; fragment = { entry, entries, code, relocs } (the
//     contract of src/aot-region-module.js). Reasons: hash-mismatch,
//     untranslatable, too-large, budget (stop, resume here), not-ready.
//   assemble(fragments) -> Uint8Array, default assembleRegion with
//     `assembleOptions` (helpers, pcOffset, memoryPages from the core).
//   compile(key, bytes) -> Promise<{ module } | { reason }> (optional, P5):
//     compiles an assembled module off the CPU thread and keeps it alive
//     before it is stored. "compile"/"link" (the bytes are bad) blacklist the
//     module; any other reason (out of memory) leaves it for the next launch.
//   cache (src/aot-cache.js): openAotCache(identity) -> session { has, put,
//     isBlacklisted, blacklist, cancel }.
// One cache entry is one module; its key (regionModuleKey) covers the planned
// members, so has() and bootKeys() work before anything is translated. A
// member the core refuses is left out of the module (the dispatcher answers 1
// for its entries and the JIT runs it); a module with no member left is
// blacklisted. A module whose every member is a hash mismatch (code not in
// memory yet, such as a REL not loaded, or patched), a compile out of memory
// or a full quota get no verdict at once: the module is retried at the next
// launch, `maxAttempts` launches at most, then blacklisted. Attempts are kept
// in the plan store (loadAttempts/saveAttempts).
import { orderedRegions, validatePlan, ANALYZER_VERSION } from "./aot-plan.js";
import { assembleRegion, claimEntries, groupRegions, regionModuleKey } from "./aot-region-module.js";

export const PLAN_CACHE_DIR = "aot-plan";
// Guest code past which a function may need continuation fragments (256
// instructions): the large functions of a module share its continuation
// budget (largeLeft, the translator).
export const REGION_LARGE_FUNCTION_BYTES = 1024;
const BATCH = 64;

const functionWeight = (f) => f.ranges.reduce((n, [s, e]) => n + e - s, 0);

export class AotOptimizer extends EventTarget {
  // buildPlan: () => Promise<plan> (planDisc over the user's disc, with its profile)
  // planStore: { load(discKey) -> plan|null, save(discKey, plan) } (optional)
  // keyParts: { compilerVersion, codegenMask } (the core's _DolphinWeb_AotKeyParts)
  constructor({ discKey, buildPlan, translator, openCache, cacheIdentity = {}, keyParts = { compilerVersion: 0, codegenMask: 0 },
    assemble = null, assembleOptions = null, compile = null, install = null, maxFunctions = 100, planStore = null, batchSize = BATCH,
    notReadyDelayMs = 1000, maxNotReadyWaits = 300, maxAttempts = 3, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => performance.now() }) {
    super();
    this.discKey = discKey;
    this.buildPlan = buildPlan;
    this.translator = translator;
    this.openCache = openCache;
    this.cacheIdentity = cacheIdentity;
    this.keyParts = keyParts;
    if (!assemble && !assembleOptions) throw new Error("aot-optimizer: assembleOptions (helpers, pcOffset, memoryPages from the core) required");
    this.assemble = assemble ?? ((fragments) => assembleRegion(fragments, assembleOptions).bytes);
    this.chain = Boolean(assembleOptions?.chain); // chained modules have their own keys (region-v2)
    this.compile = compile;
    // install({ key, bytes, entries, layout, members }): hands a compiled module to the
    // core's dispatcher (_DolphinWeb_AotQueueRegion). Optional.
    this.install = install;
    this.maxFunctions = maxFunctions;
    this.planStore = planStore;
    this.now = now;
    this.batchSize = batchSize;
    // Frontier blocks left as exits because a function's or a module's
    // continuation budget ran out (in the done event: the probes see it).
    this.budgetRefused = 0;
    this.notReadyDelayMs = notReadyDelayMs;
    this.maxNotReadyWaits = maxNotReadyWaits;
    this.maxAttempts = maxAttempts;
    this.attempts = null;
    // Modules the engine refused to compile or link this session (status():
    // regionsRefused), so a silent loss of regions shows up.
    this.engineRejects = 0;
    this.planTask = null;
    this.sleep = sleep;
    this.plan = null;
    this.session = null;
    this.running = null;
    this.cancelled = false;
    // Keys whose stored module the core refused (translated for another heap
    // layout): the next run translates them again and overwrites the entry.
    // Once per key and session: a second refusal leaves it to the JIT. And
    // `maxAttempts` launches per key at most (counted with the attempts, as
    // "retranslate:<key>"): a module the core kept refusing after its
    // retranslation is not translated again at every launch.
    this.stale = new Set();
    this.restaled = new Set();
    this.uncounted = new Set(); // marked before the attempts were read
    // The run's work, and how far it got: prioritize() reorders what is left.
    this.todo = null;
    this.cursor = 0;
    this.priority = null; // { score: Map<unit, hits> } a run not yet started applies
    this.finished = false; // the last run went through its work (hasWork)
  }

  // A save state just loaded: the guest now runs code the plan's order may
  // reach late (a first launch translates in static order, ~25 modules/s).
  // `hits` ([[pc, samples]], guest PCs sampled since the load) move the
  // modules whose members cover them ahead of the rest of this run's work,
  // most hits first; the others keep their order. Kept until the plan exists
  // (a load ~2 s into a first launch comes before it) and the run applies it.
  // Returns how many modules moved now.
  prioritize(hits) {
    if (!hits?.length) return 0;
    this.priority = { hits, score: null };
    return this.applyPriority();
  }

  // The modules covering the hits, by hits: computed once the plan exists.
  priorityScore() {
    const p = this.priority;
    if (!p || !this.regions?.length) return null;
    if (p.score) return p.score;
    // The members' ranges by start, once per plan (a load's rounds score again).
    if (this.rangeIndex?.regions !== this.regions) {
      const all = [];
      for (const u of this.regions) for (const f of u.members) for (const [s, e] of f.ranges) all.push([s >>> 0, e >>> 0, u]);
      all.sort((x, y) => x[0] - y[0]);
      // Ranges may overlap (a block shared by two functions): any range that
      // starts less than the longest one's length before pc may hold it.
      this.rangeIndex = { regions: this.regions, starts: all, longest: all.reduce((m, [s, e]) => Math.max(m, e - s), 0) };
    }
    const { starts, longest } = this.rangeIndex;
    const unitAt = (pc) => {
      let lo = 0, hi = starts.length - 1, found = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (starts[mid][0] <= pc) { found = mid; lo = mid + 1; } else hi = mid - 1;
      }
      for (let i = found; i >= 0 && pc - starts[i][0] < longest; i--) if (pc < starts[i][1]) return starts[i][2];
      return null;
    };
    const score = new Map();
    for (const [pc, n] of p.hits) {
      const u = unitAt(pc >>> 0);
      if (u) score.set(u, (score.get(u) ?? 0) + (n || 1));
    }
    p.score = score;
    return score;
  }

  // Modules left to translate: before a run, during it, or marked stale.
  hasWork() {
    return !this.finished || this.stale.size > 0;
  }

  applyPriority() {
    const score = this.priorityScore();
    if (!score?.size || !this.todo) return 0;
    const rest = this.todo.slice(this.cursor);
    const hot = rest.filter((u) => score.has(u)).sort((x, y) => score.get(y) - score.get(x));
    if (!hot.length) return 0;
    const cold = rest.filter((u) => !score.has(u));
    this.todo.splice(this.cursor, rest.length, ...hot, ...cold);
    return hot.length;
  }


  // A stored module the core refused: translated again, live, by the current
  // run or the next one. False when the key was already retranslated this
  // session, `maxAttempts` launches already, or is not a module of the plan.
  // Synchronous: a run that is ending sees the key (no window between the
  // mark and the check that starts one more run).
  markStale(key) {
    if (this.restaled.has(key) || !this.regions?.some((u) => u.key === key)) return false;
    this.restaled.add(key);
    if (this.attempts && !this.countRetranslation(key)) return false;
    if (!this.attempts) this.uncounted.add(key); // counted when the run reads them
    this.stale.add(key);
    return true;
  }

  countRetranslation(key) {
    const counter = `retranslate:${key}`;
    const n = this.attempts.get(counter) ?? 0;
    if (n >= this.maxAttempts) return false;
    this.attempts.set(counter, n + 1);
    void this.saveAttempts();
    return true;
  }

  // One plan computation at a time, shared by every caller. build = false:
  // the stored plan only (before the boot, when planning would read the disc
  // while the core boots), null without a valid one.
  async getPlan({ build = true } = {}) {
    if (this.plan) return this.plan;
    if (this.planTask && (this.planTask.build || !build)) return this.planTask.promise;
    if (this.planTask) {
      await this.planTask.promise.catch(() => null);
      if (this.plan) return this.plan;
      if (this.planTask?.build) return this.planTask.promise;
    }
    const task = { build, promise: null };
    task.promise = this.preparePlan(build).finally(() => {
      if (this.planTask === task) this.planTask = null;
    });
    this.planTask = task;
    return task.promise;
  }

  async preparePlan(build) {
    let plan = null;
    try {
      plan = await this.planStore?.load(this.discKey);
      if (plan && plan.analyzer !== ANALYZER_VERSION) plan = null;
      if (plan) validatePlan(plan);
    } catch {
      plan = null; // a bad cached plan is rebuilt
    }
    if (!plan && !build) return null;
    if (!plan) {
      plan = validatePlan(await this.buildPlan());
      await this.planStore?.save(this.discKey, plan).catch(() => {});
    }
    // Region modules, in compile order: each module takes the place of its
    // first member in orderedRegions. Groups are kept across plan rebuilds (a
    // new profile reorders functions, and regrouping would change every key
    // and miss the whole cache): a stored group whose members all still exist
    // with the same code is reused as is; only the rest is grouped anew.
    const ordered = orderedRegions(plan).filter((r) => r.f.hash && r.f.sha256);
    const rankOf = new Map(ordered.map((r, i) => [r.f, i]));
    const memberId = (moduleId, f) => `${moduleId}:${(f.entry >>> 0).toString(16)}:${f.sha256}`;
    let stored = null;
    try {
      stored = await this.planStore?.loadGroups?.(this.discKey);
    } catch {
      stored = null;
    }
    const units = [];
    const savedGroups = [];
    for (const m of [...plan.modules, ...(plan.rels ?? []).filter((r) => r.functions)]) {
      const indexOf = new Map(m.functions.map((f, i) => [memberId(m.id, f), i]));
      const taken = new Set();
      const groups = [];
      for (const ids of Array.isArray(stored) ? stored : []) {
        if (!Array.isArray(ids) || !ids.length) continue;
        const idx = ids.map((id) => indexOf.get(id));
        if (idx.some((i) => i === undefined || taken.has(i))) continue;
        idx.forEach((i) => taken.add(i));
        groups.push(idx);
      }
      const order = ordered.filter((r) => r.module === m.id).map((r) => m.functions.indexOf(r.f)).filter((i) => i >= 0 && !taken.has(i));
      groups.push(...groupRegions(m, order, { maxFunctions: this.maxFunctions }));
      for (const group of groups) {
        savedGroups.push(group.map((i) => memberId(m.id, m.functions[i])));
        const members = group.map((i) => m.functions[i]);
        units.push({
          module: m.id,
          members,
          rank: Math.min(...members.map((f) => rankOf.get(f))),
          weight: members.reduce((n, f) => n + functionWeight(f), 0),
          key: await regionModuleKey(members, { ...this.keyParts, chain: this.chain })
        });
      }
    }
    units.sort((a, b) => a.rank - b.rank);
    await this.planStore?.saveGroups?.(this.discKey, savedGroups)?.catch?.(() => {});
    this.plan = plan;
    this.regions = units;
    if (this.priority) this.priority.score = null; // new modules: scored again
    this.totalWeight = units.reduce((n, u) => n + u.weight, 0);
    return plan;
  }

  async openSession() {
    if (!this.session) this.session = await this.openCache({ discKey: this.discKey, ...this.cacheIdentity });
    return this.session;
  }

  // Weighted by guest code size: a 10 KiB module counts more than a 40-byte one.
  progress(doneSet) {
    let doneWeight = 0, done = 0;
    for (const u of this.regions) if (doneSet.has(u.key)) { done++; doneWeight += u.weight; }
    const fraction = this.totalWeight ? doneWeight / this.totalWeight : 1;
    return { fraction, done, total: this.regions.length, unit: "regions" };
  }

  async loadAttempts() {
    if (!this.attempts) {
      let stored = null;
      try {
        stored = await this.planStore?.loadAttempts?.(this.discKey);
      } catch {
        stored = null;
      }
      this.attempts = new Map(stored && typeof stored === "object" ? Object.entries(stored).filter(([, n]) => Number.isInteger(n)) : []);
    }
    return this.attempts;
  }

  async saveAttempts() {
    await this.planStore?.saveAttempts?.(this.discKey, Object.fromEntries(this.attempts))?.catch?.(() => {});
  }

  // "partial" as soon as any work was done, a module deferred included.
  async status() {
    await this.getPlan();
    const session = await this.openSession();
    const doneSet = await session.has(this.regions.map((u) => u.key));
    for (const u of this.regions) if (session.isBlacklisted?.(u.key)) doneSet.add(u.key); // left to the JIT
    const attempts = await this.loadAttempts();
    const tried = this.regions.some((u) => attempts.has(u.key));
    const p = this.progress(doneSet);
    const state = p.done >= p.total ? "complete" : p.done > 0 || tried ? "partial" : "none";
    return { state, fraction: p.fraction, regionsRefused: this.engineRejects };
  }

  // Module keys to load at boot, in compile order, that the cache holds: what
  // the region loader (aot-region-loader.js) loads under its budget. Never
  // plans: without a stored plan, nothing (the first launch boots without).
  async bootKeys() {
    if (!(await this.getPlan({ build: false }))) return [];
    const session = await this.openSession();
    const held = await session.has(this.regions.map((u) => u.key));
    return this.regions.map((u) => u.key).filter((k) => held.has(k) && !session.isBlacklisted?.(k));
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

  // Fragments of the members of `unit`, in member order. The core translates
  // in slices: "budget" means resume at that function, "not-ready" (before
  // boot) means wait and retry. Null when cancelled.
  async translateUnit(unit) {
    const fragments = [];
    const refused = [];
    let i = 0, waits = 0;
    let continuationBytesUsed = 0; // continuation fragments of this module so far (the translator caps them)
    // The module's continuation budget is shared out by water-filling: each
    // large member gets at most an even share of what is left (largeLeft:
    // the large members from it to the end), so the first ones no longer
    // take it all (members are smallest first on a first launch, the
    // biggest last); then what is left goes back, evenly again, to the
    // ones refused for lack of budget (their `resume`).
    const large = unit.members.map((f) => (f.ranges ?? []).reduce((n, [s, e]) => n + e - s, 0) > REGION_LARGE_FUNCTION_BYTES);
    const largeLeft = large.map((_, k) => large.slice(k).filter(Boolean).length);
    const starved = [];
    let unitRefused = 0;
    while (i < unit.members.length) {
      if (this.cancelled) return null;
      const slice = unit.members.slice(i, i + this.batchSize);
      const batch = slice.map((f, k) => ({
        module: unit.module, entry: f.entry, flags: f.flags ?? 0, hash: f.hash, ranges: f.ranges, extraEntries: f.extraEntries ?? [], continuationBytesUsed,
        largeLeft: largeLeft[i + k]
      }));
      const translated = await this.translator.translate(batch);
      if (this.cancelled) return null;
      let consumed = 0, wait = false;
      for (const [n, r] of translated.entries()) {
        if (r.reason === "budget") break;
        if (r.reason === "not-ready") { wait = true; break; }
        if (n >= batch.length || (r.entry !== undefined && r.entry !== batch[n].entry)) throw new Error("translator results out of order");
        consumed++;
        continuationBytesUsed += r.budgetCharged ?? 0;
        unitRefused += r.budgetRefused ?? 0;
        if (r.resume) starved.push(r);
        if (r.fragment) fragments.push(r.fragment, ...(r.continuations ?? []));
        else refused.push({ entry: batch[n].entry, reason: r.reason ?? "untranslatable" });
      }
      i += consumed;
      if (wait && ++waits > this.maxNotReadyWaits) return { notReady: true };
      if (wait || !consumed) await this.sleep(wait ? this.notReadyDelayMs : 0);
    }
    // Rounds: each member still refused gets an even share of what is left
    // at its turn (never past it: the translator keeps no continuation past
    // its limit), until none is refused or a round charges nothing; then one
    // last pass offers each the whole of what is left (a next continuation
    // bigger than every even share). A member at its own cap leaves the
    // rounds; a continuation never starts at an entry the module holds.
    const unitBytes = this.translator.unitContinuationBytes;
    const claimed = new Set(fragments.flatMap((x) => x.entries.map((pc) => pc >>> 0)));
    let waiting = starved.map((r) => ({ resume: r.resume, refused: r.budgetRefused ?? 0, exhausted: false }));
    let whole = false;
    while (waiting.length) {
      let spent = 0;
      for (const [k, w] of waiting.entries()) {
        const left = unitBytes - continuationBytesUsed;
        if (!(left > 0)) break;
        if (this.cancelled) return null;
        const more = await w.resume(whole ? left : Math.floor(left / (waiting.length - k)), claimed);
        continuationBytesUsed += more.budgetCharged ?? 0;
        spent += more.budgetCharged ?? 0;
        unitRefused += (more.budgetRefused ?? 0) - w.refused;
        w.refused = more.budgetRefused ?? 0;
        w.exhausted = Boolean(more.exhausted);
        for (const x of more.continuations ?? []) for (const pc of x.entries) claimed.add(pc >>> 0);
        fragments.push(...(more.continuations ?? []));
      }
      waiting = waiting.filter((w) => w.refused > 0 && !w.exhausted);
      if (!(unitBytes - continuationBytesUsed > 0) || whole) break;
      if (!spent) whole = true;
    }
    this.budgetRefused += unitRefused;
    return { fragments, refused };
  }

  // No verdict yet (code not in memory, out of memory, quota): retried at the
  // next launch, blacklisted after maxAttempts launches.
  async defer(session, unit, reason) {
    const n = (this.attempts.get(unit.key) ?? 0) + 1;
    this.attempts.set(unit.key, n);
    let blacklisted = false;
    if (n >= this.maxAttempts) {
      await session.blacklist?.([{ key: unit.key, reason: `${reason}-retries` }]);
      blacklisted = true;
    }
    await this.saveAttempts();
    this.emit("optimization-error", {
      message: `module ${unit.key}: ${reason}, ${blacklisted ? `left to the JIT after ${n} launches` : "retried at the next launch"}`, fatal: false
    });
    return blacklisted;
  }

  async run(resume = true) {
    const t0 = this.now();
    const ms = () => Math.round(this.now() - t0);
    let compiled = 0, deferred = 0;
    this.budgetRefused = 0; // per run: the done event reports this run's
    this.finished = false;
    try {
      await this.getPlan();
      const session = await this.openSession();
      await this.loadAttempts();
      for (const key of this.uncounted) if (!this.countRetranslation(key)) this.stale.delete(key);
      this.uncounted.clear();
      // resume = false: everything again (stored modules are overwritten).
      const doneSet = resume ? await session.has(this.regions.map((u) => u.key)) : new Set();
      for (const key of this.stale) doneSet.delete(key);
      // Modules refused (no member translatable, rejected bytes, quota) are
      // left to the JIT; keys the cache blacklisted are skipped.
      const refused = new Set();
      for (const u of this.regions) if (session.isBlacklisted?.(u.key)) { refused.add(u.key); doneSet.add(u.key); }
      const todo = this.regions.filter((u) => !doneSet.has(u.key));
      this.todo = todo;
      this.cursor = 0;
      this.applyPriority();
      this.emit("optimization-start", { ...this.progress(doneSet), ms: 0, resumed: doneSet.size > 0 });
      this.emit("optimization-progress", { ...this.progress(doneSet), ms: ms() });
      // Modules marked stale while this run goes are appended to its work.
      const queued = new Set(todo.map((u) => u.key));
      // Module n+1 is translated (on this worker, in slices) while module n
      // compiles (another worker), installs and goes to the cache: the
      // finishing steps are chained, so modules install in order, but the
      // translation no longer waits for them (research deep-first-minute §1.3).
      let finishing = Promise.resolve();
      // A cancel (tab closing, another disc, aotCancel) is no verdict on a
      // module: what compiled still installs (the worker drops it if the
      // disc changed), but nothing is stored, deferred or blacklisted, so
      // the next launch translates it again (review of #144).
      const finish = async (unit, result) => {
        if (this.cancelled) return;
        for (const x of result.refused) {
          this.emit("optimization-error", { message: `function ${x.entry.toString(16)}: ${x.reason}`, fatal: false });
        }
        let failure = null, wait = null;
        if (!result.fragments.length && result.refused.length && result.refused.every((x) => x.reason === "hash-mismatch")) {
          wait = "hash-mismatch";
        } else if (!result.fragments.length) failure = "untranslatable";
        else {
          let bytes = null;
          const fragments = claimEntries(result.fragments);
          try {
            bytes = this.assemble(fragments);
          } catch (error) {
            // Fragments of one unit translated across a stop and a new boot
            // (another heap layout): translated again later, not refused.
            if (/different layouts/.test(String(error?.message))) wait = "layout";
            else failure = `assemble: ${error?.message || error}`;
          }
          if (bytes && this.compile) {
            let out;
            try {
              out = await this.compile(unit.key, bytes);
            } catch (error) {
              out = { reason: String(error?.message || error) };
            }
            if (this.cancelled) {
              if (out?.module) this.install?.({ key: unit.key, bytes, entries: fragments.flatMap((fr) => fr.entries), layout: fragments[0]?.layout ?? 0, members: unit.members.map((f) => ({ ranges: f.ranges, hash: f.hash })) });
              return;
            }
            if (!out?.module) {
              const reason = out?.reason ?? "compile";
              if (reason === "compile" || reason === "link") {
                failure = `engine-reject: ${reason}`;
                this.engineRejects++;
              }
              else wait = reason;
              bytes = null;
            }
          }
          if (bytes) {
            const entries = fragments.flatMap((fr) => fr.entries);
            const ranges = unit.members.flatMap((f) => f.ranges);
            const region = { key: unit.key, bytes, entries, layout: fragments[0]?.layout ?? 0, members: unit.members.map((f) => ({ ranges: f.ranges, hash: f.hash })) };
            // Installed as soon as it compiled, before the cache write: the
            // session runs it even if the write then fails (quota).
            this.install?.(region);
            const stored = await session.put([{ key: unit.key, bytes, meta: { members: unit.members.length, translated: result.fragments.length, entries, ranges } }]);
            if (this.cancelled) return; // the cache refused the write as cancelled: no verdict
            const reason = stored.failed?.[0]?.reason ?? null;
            if (reason === "quota") wait = "quota";
            else failure = reason;
            if (!reason) {
              compiled++;
              if (this.attempts.delete(unit.key)) await this.saveAttempts();
            }
          }
        }
        if (wait) {
          if (await this.defer(session, unit, wait)) refused.add(unit.key);
          else deferred++;
        }
        if (failure) {
          // Refusals survive a reload: the cache keeps them per identity.
          await session.blacklist?.([{ key: unit.key, reason: failure.split(":")[0] }]);
          refused.add(unit.key);
          this.emit("optimization-error", { message: `module ${unit.key}: ${failure}`, fatal: false });
        }
        doneSet.add(unit.key); // stored, or handled (left to the JIT): progress must reach 100 %
        this.emit("optimization-progress", { ...this.progress(doneSet), ms: ms() });
      };
      // A finishing step that throws (a failed blacklist or attempts write)
      // is reported, never left as an unhandled rejection, and every way out
      // of the loop waits for the last one.
      const schedule = (unit, result) => finish(unit, result).catch((error) => {
        this.emit("optimization-error", { message: `module ${unit.key}: ${error?.message || error}`, fatal: false });
      });
      try {
        for (let n = 0; ; n++) {
          if (n >= todo.length) {
            await finishing; // its stale marks are appended below
            for (const u of this.regions) if (this.stale.has(u.key) && !queued.has(u.key)) { queued.add(u.key); todo.push(u); }
          }
          if (n >= todo.length || this.cancelled) break;
          const unit = todo[n];
          this.cursor = n + 1;
          this.stale.delete(unit.key);
          const result = await this.translateUnit(unit);
          await finishing;
          if (!result || this.cancelled) break;
          if (result.notReady) {
            this.emit("optimization-error", { message: "the core is not ready to translate; resumed at the next launch", fatal: false });
            return;
          }
          finishing = schedule(unit, result);
        }
      } finally {
        await finishing;
        this.todo = null;
      }
      if (!this.cancelled) {
        this.finished = true;
        this.priority = null; // its hits were for this run's work
      }
      if (!this.cancelled) this.emit("optimization-done", { total: this.regions.length, refused: refused.size, compiled, deferred, budgetRefused: this.budgetRefused, ms: ms() });
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
  async loadGroups(discKey) {
    try {
      const file = await (await (await this.dir()).getFileHandle(OpfsPlanStore.name(discKey).replace(/\.json$/, ".groups.json"))).getFile();
      return JSON.parse(await file.text());
    } catch (error) {
      if (error?.name === "NotFoundError" || error instanceof SyntaxError) return null;
      throw error;
    }
  }
  async loadAttempts(discKey) {
    try {
      const file = await (await (await this.dir()).getFileHandle(OpfsPlanStore.name(discKey).replace(/\.json$/, ".attempts.json"))).getFile();
      return JSON.parse(await file.text());
    } catch (error) {
      if (error?.name === "NotFoundError" || error instanceof SyntaxError) return null;
      throw error;
    }
  }
  async saveAttempts(discKey, attempts) {
    const handle = await (await this.dir()).getFileHandle(OpfsPlanStore.name(discKey).replace(/\.json$/, ".attempts.json"), { create: true });
    const writable = await handle.createWritable();
    await writable.write(JSON.stringify(attempts));
    await writable.close();
  }
  async saveGroups(discKey, groups) {
    const handle = await (await this.dir()).getFileHandle(OpfsPlanStore.name(discKey).replace(/\.json$/, ".groups.json"), { create: true });
    const writable = await handle.createWritable();
    await writable.write(JSON.stringify(groups));
    await writable.close();
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
// Reasons follow _DolphinWeb_AotTranslate: hash-mismatch, untranslatable,
// budget (stop, resume here), too-large, not-ready (before boot).
// `perCall`: functions translated per call before "budget"; `notReadyCalls`:
// first calls answer "not-ready".
export function fakeTranslator({ msPerKiB = 0, refuse = new Set(), perCall = Infinity, notReadyCalls = 0, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let calls = 0;
  return {
    async translate(regions) {
      calls++;
      if (calls <= notReadyCalls) return regions.map((r) => ({ entry: r.entry, reason: "not-ready" }));
      const out = [];
      for (const [n, r] of regions.entries()) {
        if (n >= perCall) { out.push({ entry: r.entry, reason: "budget" }); break; }
        if (refuse.has(r.hash)) { out.push({ entry: r.entry, reason: "untranslatable" }); continue; }
        const bytes = r.ranges.reduce((t, [s, e]) => t + e - s, 0);
        if (msPerKiB) await sleep((bytes / 1024) * msPerKiB);
        // the smallest fragment with the contract's shape: declares its entry, returns 0
        out.push({ entry: r.entry, fragment: { entry: r.entry, entries: [r.entry], code: Uint8Array.from([0x00, 0x41, 0x00, 0x0b]), relocs: [] } });
      }
      return out;
    }
  };
}

export function fakeCache({ persisted = new Map(), quotaKeys = new Set(), blacklist = new Set() } = {}) {
  const open = async () => {
    let cancelled = false;
    return {
      isBlacklisted: (key) => blacklist.has(key),
      async blacklist(entries) {
        for (const e of entries) blacklist.add(e.key);
      },
      async has(keys) {
        return new Set(keys.filter((k) => persisted.has(k)));
      },
      async put(entries) {
        const failed = [];
        for (const e of entries) {
          // As the real cache (aot-cache.js put): a cancelled session refuses.
          if (cancelled) { failed.push({ key: e.key, reason: "cancelled" }); continue; }
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
