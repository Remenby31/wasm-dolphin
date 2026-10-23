// First-launch optimisation, end to end (plan piste 3, P7), behind ?aot=1
// (off by default). Glue between the pieces that already exist:
//
//   first launch   plan (P2, aot-recomp planDisc) -> optimiser (aot-optimizer:
//                  groups, translation by the core, assembly) -> compile off
//                  the CPU thread (P5, aot-compiler-worker) -> cache (P6,
//                  aot-cache, keyed by regionModuleKey)
//   next launches  loader (aot-region-loader) -> cache -> modules installed
//                  before the boot (decision (c)+(c')+(d), PROGRAM.md)
//
// Every collaborator is injected, so the whole flow runs in tests with a fake
// translator and an in-memory CacheStorage. In the discio worker, the
// translator is coreRegionTranslator(core) over _DolphinWeb_AotTranslate;
// a core without that export makes the flow "unsupported" and changes
// nothing.
//
// A region that fails anywhere (untranslatable, assembly, engine reject,
// quota) is blacklisted in the cache and left to the JIT; the game goes on.
//
// Progress (for the site's "Optimisation pour ta machine…" and the KPI probe)
// is a list of events, schema AOT_PROGRESS_SCHEMA:
//   { t, type: "install"|"start"|"progress"|"done"|"error", ... }
//   install  { loaded, failed, deferred, ms }        modules installed before boot
//   start    { fraction, done, total, unit, ms: 0, resumed }
//   progress { fraction, done, total, unit: "regions", ms }
//   done     { total, refused, compiled, deferred, ms }
//   error    { message, fatal }                        fatal = false: play goes on
// t = performance.timeOrigin + performance.now() (ms since the epoch); ms =
// time since the start of this run.
import { AotOptimizer } from "./aot-optimizer.js";
import { createAotRegionLoader } from "./aot-region-loader.js";
import { REGION_HEAP_NAMES, regionModuleEntries, regionModuleLayout } from "./aot-region-module.js";

export const AOT_FIRST_LAUNCH_PARAM = "aot";
export const AOT_PROGRESS_SCHEMA = "wasm-dolphin.aot-progress.v1";
const MAX_EVENTS = 4096;

export function aotFirstLaunchRequested(search = "") {
  return new URLSearchParams(search).get(AOT_FIRST_LAUNCH_PARAM) === "1";
}

// Name of the region cache's compiler version for these key parts: a new
// compiler version or codegen mask opens another cache (aotCacheIdentity).
export function regionCacheIdentity(keyParts) {
  return { compilerVersion: `region-${keyParts.compilerVersion >>> 0}`, flagsMask: keyParts.codegenMask >>> 0 };
}

const epochNow = () => (globalThis.performance?.timeOrigin ?? 0) + (globalThis.performance?.now?.() ?? Date.now());

export function createAotFirstLaunch({
  discKey,
  coreHash,
  keyParts, // { compilerVersion, codegenMask }: _DolphinWeb_AotKeyParts
  translator, // null: unsupported (the core cannot translate yet)
  assembleOptions, // { helpers, pcOffset, memoryPages }
  openCache, // (identity) -> cache session (openAotCache)
  buildPlan, // () -> plan (planDisc over the user's disc)
  planStore = null,
  compile = null, // (key, bytes) -> { module } | { reason } (P5); also keeps the Module alive
  retain = () => {}, // (key, module): a module loaded before boot, for the CPU thread
  install = null, // ({ key, bytes, entries, members }): hands a module to the core's dispatcher
  onEvent = () => {}, // every progress event, as it happens
  maxFunctions = 100,
  batchSize,
  bootBudgetMs = 1500,
  maxBootModules = Infinity,
  maxBootBytes = Infinity, // what the launch may retain, in bytes of region modules
  loadBeforeBoot = false, // true: the cache loads before the boot (under bootBudgetMs), as before
  maxErrorEvents = 64, // per run: a flood of refusals never pushes out install/start
  runId = null,
  tuning = {}, // AotOptimizer options: maxAttempts, notReadyDelayMs, maxNotReadyWaits
  clock = epochNow,
  now = () => globalThis.performance?.now?.() ?? Date.now(),
  sleep
}) {
  const supported = Boolean(translator && keyParts && assembleOptions);
  const identity = { discKey, coreHash, ...(keyParts ? regionCacheIdentity(keyParts) : {}) };
  let events = [];
  let running = false;
  let lastState = supported ? "none" : "unsupported";
  // cancel() and dispose() bump it: a start queued before (after the boot)
  // checks it and does not run a flow that was stopped meanwhile.
  let generation = 0;
  let disposed = false;
  let errorEvents = 0;
  let errorsDropped = 0;
  let started = false; // start() was called: the boot is behind
  let deferredLoad = false; // the cache is read after the first image (loadRest)
  let retranslated = 0;
  const run = runId ?? Math.random().toString(36).slice(2, 10);

  function record(type, detail) {
    if (type === "error" && !detail.fatal && ++errorEvents > maxErrorEvents) {
      errorsDropped++;
      return null;
    }
    if (type === "start") errorEvents = 0;
    if (type === "done" && errorsDropped) detail = { ...detail, errorsDropped };
    const event = { t: clock(), type, disc: discKey, run, ...detail };
    events.push(event);
    if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
    try {
      onEvent(event);
    } catch {
      // a listener never stops the optimisation
    }
    return event;
  }

  // The plan store names its files after the disc key: letters, digits, _ and - only.
  const planKey = String(discKey).replace(/[^0-9A-Za-z_-]/g, "_").slice(0, 128);
  const optimizer = supported
    ? new AotOptimizer({
      discKey: planKey, buildPlan, translator, planStore, keyParts, assembleOptions, compile, install, maxFunctions, now,
      openCache: () => openCache(identity),
      ...(batchSize ? { batchSize } : {}),
      ...(sleep ? { sleep } : {}),
      ...tuning
    })
    : null;
  if (optimizer) {
    for (const [name, type] of [["optimization-start", "start"], ["optimization-progress", "progress"], ["optimization-done", "done"], ["optimization-error", "error"]]) {
      optimizer.addEventListener(name, (e) => {
        if (type === "done") lastState = e.detail.deferred ? "partial" : "complete";
        record(type, e.detail);
      });
    }
  }

  // A module from the cache goes to the dispatcher too, mapped at its
  // functions' entries (block starts inside are resolved by its own
  // dispatcher); ranges for invalidation.
  const retainAndInstall = (key, module, bytes) => {
    retain(key, module);
    const unit = install && bytes ? optimizer?.regions?.find((u) => u.key === key) : null;
    if (!unit) return;
    const entries = regionModuleEntries(module) ?? unit.members.map((f) => f.entry);
    install({ key, bytes, entries, layout: regionModuleLayout(module), members: unit.members.map((f) => ({ ranges: f.ranges, hash: f.hash })) });
  };
  const loader = createAotRegionLoader({ openCache, retain: retainAndInstall, now });

  return {
    supported,
    identity,

    // Next launches: opens the region cache for the modules it holds for
    // this disc, in compile order; they load after the first image with
    // loadRest() (loadBeforeBoot: before the boot, under `bootBudgetMs`).
    // Never throws: a failure costs only speed.
    async installBeforeBoot() {
      if (!supported) return { loaded: 0, failed: [], deferred: 0, ms: 0, unsupported: true };
      const t0 = now();
      let report;
      try {
        // Never plans: without a valid stored plan (first launch, new
        // analyzer, no OPFS) the boot goes on without regions and planning
        // happens after it.
        if (!(await optimizer.getPlan({ build: false }))) {
          const ms = Math.round(now() - t0);
          record("install", { loaded: 0, failed: 0, deferred: 0, ms, firstLaunch: true });
          return { loaded: 0, failed: [], deferred: 0, ms, firstLaunch: true };
        }
        // Before the boot, nothing by default (loadBeforeBoot = false): the
        // whole cache read and compiled first delayed the first image of a
        // second launch by 0.8 s, and the boot does not need the regions (a
        // first launch never has them there). They load after the first
        // image (loadRest), as the optimisation of a first launch does; even
        // the cache's index (has() over every key, ~110 ms) is read then.
        if (!loadBeforeBoot) {
          deferredLoad = true;
          report = { loaded: 0, failed: [], deferred: optimizer.regions?.length ?? 0, ms: 0 };
        } else {
          const keys = await optimizer.bootKeys();
          report = await loader.load({ ...identity, keys, budgetMs: bootBudgetMs, maxModules: maxBootModules, maxBytes: maxBootBytes });
        }
      } catch (error) {
        report = { loaded: 0, failed: [], deferred: 0, ms: 0, error: String(error?.message || error) };
      }
      const ms = Math.round(now() - t0);
      record("install", { loaded: report.loaded, failed: report.failed.length, deferred: report.deferred, ms, ...(report.error ? { error: report.error } : {}) });
      return { ...report, ms };
    },

    // After the first image: what installBeforeBoot left, as a second
    // "install" event (after: "first-image").
    // A cancel() or dispose() (another disc mounted, a stop) before or during
    // it: nothing loads.
    async loadRest() {
      if (!supported || disposed) return { loaded: 0, failed: [], deferred: 0 };
      const t0 = now();
      const ifGeneration = generation;
      let report;
      if (deferredLoad) {
        // The whole cache, in compile order (hottest first), with no budget.
        deferredLoad = false;
        try {
          const keys = await optimizer.bootKeys();
          if (disposed || ifGeneration !== generation) return { loaded: 0, failed: [], deferred: 0, cancelled: true };
          report = await loader.load({ ...identity, keys, maxModules: maxBootModules, maxBytes: maxBootBytes });
        } catch (error) {
          report = { loaded: 0, failed: [], deferred: 0, error: String(error?.message || error) };
        }
      } else {
        report = await loader.loadRest();
      }
      if (report.loaded || report.failed.length) {
        record("install", { loaded: report.loaded, failed: report.failed.length, deferred: report.deferred, ms: Math.round(now() - t0), after: "first-image" });
      }
      return report;
    },

    async status() {
      if (!supported) return { state: "unsupported", fraction: 0 };
      try {
        const s = await optimizer.status();
        if (!running) lastState = s.state;
        return s;
      } catch (error) {
        return { state: "none", fraction: 0, error: String(error?.message || error) };
      }
    },

    // First launch, or a resume: in the background, after the boot (the core
    // translates from guest memory and answers "not-ready" before it).
    // ifGeneration: the generation read when this start was queued; a
    // cancel() since then makes it a no-op.
    async start({ resume = true, ifGeneration = generation } = {}) {
      if (!supported || disposed || ifGeneration !== generation) return;
      running = true;
      started = true;
      lastState = "running";
      try {
        await optimizer.start({ resume });
        // Marked stale after the run's last module: one more run for them.
        if (optimizer.stale.size && !disposed && ifGeneration === generation) await optimizer.start({ resume: true });
      } finally {
        running = false;
        if (lastState === "running") lastState = "partial"; // cancelled or fatal
      }
    },

    // A module from the cache the core cannot run here (translated for another
    // heap layout): translated again from guest memory, live, and its cache
    // entry overwritten, instead of being lost for every launch. Once per key
    // and launch, 3 launches at most. True when queued.
    retranslate(key) {
      if (!supported || disposed || !optimizer.markStale(key)) return false;
      retranslated += 1;
      if (started && !running) void this.start({ resume: true });
      return true;
    },

    get generation() {
      return generation;
    },

    cancel() {
      generation++;
      deferredLoad = false; // the cache deferred to the first image never loads
      optimizer?.cancel();
      loader.cancel();
    },

    // The disc is gone (remount, stop): nothing of this flow runs again.
    dispose() {
      disposed = true;
      this.cancel();
    },

    // The probe's read: events since the boot, or since the last drain.
    progress({ drain = false } = {}) {
      const out = { schema: AOT_PROGRESS_SCHEMA, state: running ? "running" : lastState, disc: discKey, run, events: events.slice() };
      if (drain) events = [];
      return out;
    },

    stats: () => ({ loader: loader.stats(), retranslated })
  };
}

// --- The core's side (P4, patch 0075; agreed with the JIT owner 2026-10-19) ---
//
// _DolphinWeb_AotTranslate(pc, mask, rangesPtr, rangeCount, maxBlocks, hashLo, hashHi) -> ptr
//   Safe on any pthread of the module other than the CPU thread (state in
//   thread_local, guest code read from physical RAM through the BAT views).
//   ptr -> [status, entry, codeLength, entryCount, relocCount, reserved],
//   entries (u32 each), relocs (offset, kind, value: 0 import by helper
//   index, 1 jump to value, 2 dispatch, 3 heap site: bit 0 REGION_HEAP_NAMES
//   index, bit 1 the form, 0 an i32.const, 1 a memarg offset), code. Valid until the next call on
//   the same thread; 0 is an internal error.
// _DolphinWeb_AotKeyParts(ptr) writes [compilerVersion, codegenMask].
// _DolphinWeb_JitHelperName(i) / _DolphinWeb_JitHelperSignature(i): helper
//   names and "i32,i32>i32" signatures, until a null pointer.
// _DolphinWeb_JitStateLayout(ptr) writes [pcOffset, npcOffset, downcountOffset, version].
export const TRANSLATE_STATUS = Object.freeze(["ok", "hash-mismatch", "untranslatable", "too-large", "not-ready", "budget"]);

export function coreAotKeyParts(m) {
  if (typeof m?._DolphinWeb_AotKeyParts !== "function" || typeof m._malloc !== "function") return null;
  const p = m._malloc(8);
  try {
    m._DolphinWeb_AotKeyParts(p);
    const [compilerVersion, codegenMask] = new Uint32Array(m.HEAPU8.buffer, p, 2);
    return { compilerVersion, codegenMask };
  } finally {
    m._free(p);
  }
}

export function parseHelperSignature(text) {
  const [params, results = ""] = String(text).split(">");
  const list = (s) => s.split(",").map((t) => t.trim()).filter(Boolean);
  return { params: list(params), results: list(results) };
}

// Helpers, state layout and memory size of the core: the options of
// assembleRegion. Null without the exports.
export function coreAssembleOptions(m) {
  if (typeof m?._DolphinWeb_JitHelperName !== "function" || typeof m._DolphinWeb_JitHelperSignature !== "function" ||
      typeof m._DolphinWeb_JitStateLayout !== "function") return null;
  const names = [];
  const helpers = {};
  for (let i = 0; ; i++) {
    const p = m._DolphinWeb_JitHelperName(i);
    if (!p) break;
    const name = m.UTF8ToString(p);
    names.push(name);
    helpers[name] = parseHelperSignature(m.UTF8ToString(m._DolphinWeb_JitHelperSignature(i)));
  }
  const p = m._malloc(16);
  let pcOffset;
  try {
    m._DolphinWeb_JitStateLayout(p);
    [pcOffset] = new Uint32Array(m.HEAPU8.buffer, p, 4);
  } finally {
    m._free(p);
  }
  // The core's memory never grows (INITIAL_MEMORY = DOLPHIN_WASM_MEMORY_PAGES):
  // its size is the maximum the region modules declare.
  // chain: region modules tail-call the next region when the core exports
  // the chaining helper (patch 0102); an older core cannot link them.
  return { helperNames: names, assemble: { helpers, pcOffset, memoryPages: m.HEAPU8.buffer.byteLength / 65536,
    chain: typeof m._DolphinWeb_RegionChainHelper === "function" } };
}

// [ramBase, l1Base] of the core's session (_DolphinWeb_AotRegionHeapBases).
export function coreHeapBases(m) {
  const p = m._malloc(8);
  try {
    m._DolphinWeb_AotRegionHeapBases(p);
    return Array.from(new Uint32Array(m.HEAPU8.buffer, p, 2));
  } finally {
    m._free(p);
  }
}

// The translator the optimiser drives, over the core's export. Translates
// for at most `sliceMs` per call and answers "budget" for the rest: the discio
// worker also serves the core's disc reads, so it yields between slices.
// maxContinuations: fragments translated after a function's first one, from
// its frontier (see translateWithContinuations).
export function coreRegionTranslator(m, { mask, helperNames, maxBlocks = 64, maxContinuations = REGION_MAX_CONTINUATIONS, sliceMs = 8, now = () => performance.now(),
  yieldNow = () => new Promise((r) => setTimeout(r, 0)) } = {}) {
  if (typeof m?._DolphinWeb_AotTranslate !== "function") return null;
  const names = helperNames ?? coreAssembleOptions(m)?.helperNames ?? [];
  return {
    async translate(batch) {
      await yieldNow();
      const t0 = now();
      const out = [];
      for (const [n, f] of batch.entries()) {
        if (n && now() - t0 >= sliceMs) {
          out.push({ entry: f.entry, reason: "budget" });
          break;
        }
        const r = translateWithContinuations(m, f, { mask, maxBlocks, names, maxContinuations });
        out.push(r);
        if (r.reason === "budget" || r.reason === "not-ready") break;
      }
      return out;
    }
  };
}

// A function whose blocks do not fit one fragment (the 64-block cap) left
// the rest to the dispatcher and the block JIT at every pass: 77 % of a
// CPU-bound intro scene's time (2026-10-23, 2.2 M region exits per 4 s to
// PCs of the same function that no fragment held). When the first fragment
// is capped, the function's block leaders that no fragment holds (targets
// of its direct branches and fall-throughs of its conditional ones, inside
// its ranges, decoded from guest memory) start continuation fragments of
// the same function, in the same module: the region's exit there becomes a
// direct return_call, and claimEntries (at assembly) keeps each PC's first
// owner. A fragment is capped when it holds maxBlocks blocks or its code
// reaches REGION_FRAGMENT_MAX_BYTES (the byte cap of patch 0115, #131: its
// discovery stops once the code reaches it). Continuations stop after
// maxContinuations fragments or REGION_CONTINUATION_MAX_BYTES of code per
// function (the 0107 install cost grows with the module, ~1.7 ms/MB); a
// leader that does not translate (a first op the translator refuses) stays
// an exit, as before.
export const REGION_FRAGMENT_MAX_BYTES = 96000;
export const REGION_CONTINUATION_MAX_BYTES = 2 << 20;
export const REGION_MAX_CONTINUATIONS = 31;
const capped = (fragment, maxBlocks) => fragment.entries.length >= maxBlocks || fragment.code.length >= REGION_FRAGMENT_MAX_BYTES;
export function translateWithContinuations(m, f, { mask, maxBlocks, names, maxContinuations = REGION_MAX_CONTINUATIONS }) {
  const first = translateOne(m, f, { mask, maxBlocks, names });
  if (!first.fragment || maxContinuations <= 0 || !capped(first.fragment, maxBlocks)) return first;
  const owned = new Set(first.fragment.entries.map((pc) => pc >>> 0));
  const continuations = [];
  let bytes = 0;
  for (const pc of blockLeaders(m, f.ranges)) {
    if (continuations.length >= maxContinuations || bytes >= REGION_CONTINUATION_MAX_BYTES) break;
    if (owned.has(pc)) continue;
    const next = translateOne(m, { ...f, entry: pc }, { mask, maxBlocks, names });
    if (!next.fragment) continue;
    for (const e of next.fragment.entries) owned.add(e >>> 0);
    continuations.push(next.fragment);
    bytes += next.fragment.code.length;
  }
  return continuations.length ? { ...first, continuations } : first;
}

// Block leaders of the code in `ranges` ([start, end) guest addresses), in
// address order: targets of b and bc without link inside the ranges, and
// the instruction after a bc. Read from the emulated RAM (big-endian).
export function blockLeaders(m, ranges) {
  if (typeof m._DolphinWeb_AotRegionHeapBases !== "function") return [];
  const ram = coreHeapBases(m)[0];
  const inside = (pc) => ranges.some(([s, e]) => pc >= s && pc < e);
  const view = new DataView(m.HEAPU8.buffer);
  const leaders = new Set();
  for (const [s, e] of ranges) {
    for (let a = s >>> 0; a < e >>> 0; a += 4) {
      const w = view.getUint32(ram + (a & 0x01ffffff), false);
      const op = w >>> 26;
      if ((op !== 16 && op !== 18) || (w & 1)) continue; // b/bc without link
      const disp = op === 18 ? ((w & 0x03fffffc) << 6) >> 6 : ((w & 0xfffc) << 16) >> 16;
      const target = ((w & 2) ? disp : a + disp) >>> 0;
      if (inside(target)) leaders.add(target);
      if (op === 16 && inside(a + 4)) leaders.add((a + 4) >>> 0);
    }
  }
  return [...leaders].sort((x, y) => x - y);
}

function translateOne(m, f, { mask, maxBlocks, names }) {
  const ranges = f.ranges;
  const r = m._malloc(8 * ranges.length);
  let p;
  try {
    new Uint32Array(m.HEAPU8.buffer, r, 2 * ranges.length).set(ranges.flat().map((v) => v >>> 0));
    const hashHi = f.hash ? parseInt(f.hash.slice(0, 8), 16) : 0;
    const hashLo = f.hash ? parseInt(f.hash.slice(8), 16) : 0;
    p = m._DolphinWeb_AotTranslate(f.entry >>> 0, mask >>> 0, r, ranges.length, maxBlocks, hashLo >>> 0, hashHi >>> 0) >>> 0;
  } finally {
    m._free(r);
  }
  if (!p) return { entry: f.entry, reason: "untranslatable" };
  const [status, entry, codeLength, entryCount, relocCount, layout] = new Uint32Array(m.HEAPU8.buffer, p, 6);
  if (status !== 0) return { entry: f.entry, reason: TRANSLATE_STATUS[status] ?? "untranslatable" };
  const words = new Uint32Array(m.HEAPU8.buffer, p + 24, entryCount + 3 * relocCount);
  const entries = Array.from(words.subarray(0, entryCount));
  const relocs = Array.from({ length: relocCount }, (_, i) => {
    const [offset, kind, value] = words.subarray(entryCount + 3 * i, entryCount + 3 * i + 3);
    if (kind === 0) return { offset, kind: "import", name: names[value] };
    if (kind === 1) return { offset, kind: "jump", targetPc: value };
    if (kind === 3) return { offset, kind: "heap", name: REGION_HEAP_NAMES[value & 1], form: value & 2 ? "offset" : "const" };
    return { offset, kind: "dispatch" };
  });
  const at = p + 24 + 4 * (entryCount + 3 * relocCount);
  // layout: the core's heap layout hash the code embeds (0 from a core
  // before the layout guard): the region module carries it to the install.
  // heapBases: the RAM and L1 addresses its heap sites hold (0084).
  const heapBases = typeof m._DolphinWeb_AotRegionHeapBases === "function" ? coreHeapBases(m) : null;
  return { entry: f.entry, fragment: { entry, entries, code: m.HEAPU8.slice(at, at + codeLength), relocs, layout, ...(heapBases ? { heapBases } : {}) } };
}
