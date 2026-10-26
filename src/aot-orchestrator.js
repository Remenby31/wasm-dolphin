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
import { regionHash } from "./aot-plan.js";
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

// One turn of the event loop, through a MessageChannel: a setTimeout(0)
// chain is clamped to 4 ms after five nested timers, which left 8 ms
// translation slices a third of the time idle (research deep-first-minute
// §2.1); a message has no clamp and still lets the worker's other messages
// (the core's disc reads, compile requests) run between slices.
// A yield that also gives way to the core's disc reads: while the worker
// served one less than quietMs ago (lastReadAt), the next translation slice
// waits, in steps, so a burst of sequential reads (a boot, a load) is not
// served one per slice. The core's DVD thread issues its next read as soon
// as one completes: a slice in between delays each by up to a slice, and
// the emulated CPU waits on it (drop meter: cold boot, 0.55-1.7 s at ~17 %
// speed, reads at ~10-50 ms each while translating).
// The waiting has a budget kept across calls (review of #268: a bound per
// call let endless reads, a movie or streamed audio, starve the translation):
// it starts at maxWaitMs, each slice of translation earns as much again (up
// to maxWaitMs), each wait spends it. Under reads that never stop, the
// translation still gets about half the time after the first maxWaitMs.
export function discAwareYield({ lastReadAt, quietMs = 15, maxWaitMs = 1000, now = () => performance.now(),
  yieldNow = yieldToEventLoop, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  let budget = maxWaitMs;
  let sliceStart = null;
  const out = async () => {
    if (sliceStart != null) budget = Math.min(maxWaitMs, budget + (now() - sliceStart));
    await yieldNow();
    while (budget > 0 && now() - lastReadAt() < quietMs) {
      const t0 = now();
      await sleep(quietMs);
      budget -= now() - t0;
      out.waitedMs += now() - t0;
    }
    sliceStart = now();
  };
  out.waitedMs = 0;
  return out;
}

export function yieldToEventLoop() {
  if (typeof MessageChannel !== "function") return new Promise((r) => setTimeout(r, 0));
  // A channel per turn, closed once it delivered: a port left open would
  // keep a worker (or Node) alive.
  return new Promise((r) => {
    const { port1, port2 } = new MessageChannel();
    port1.onmessage = () => {
      port1.close();
      port2.close();
      r();
    };
    port2.postMessage(0);
  });
}

// The translator the optimiser drives, over the core's export. Translates
// for at most `sliceMs` per call and answers "budget" for the rest: the discio
// worker also serves the core's disc reads, so it yields between slices.
// maxContinuations: fragments translated after a function's first one, from
// its frontier (see translateWithContinuations).
export function coreRegionTranslator(m, { mask, helperNames, maxBlocks = 64, maxContinuations = REGION_MAX_CONTINUATIONS, sliceMs = 8, now = () => performance.now(),
  yieldNow = yieldToEventLoop, functionCap = 0 } = {}) {
  if (typeof m?._DolphinWeb_AotTranslate !== "function") return null;
  const names = helperNames ?? coreAssembleOptions(m)?.helperNames ?? [];
  return {
    unitContinuationBytes: REGION_UNIT_CONTINUATION_MAX_BYTES,
    async translate(batch) {
      await yieldNow();
      let t0 = now();
      const out = [];
      // The continuations of a function also yield to the worker once the
      // slice is spent (review of #138): it serves the core's disc reads.
      const slice = async () => {
        if (now() - t0 < sliceMs) return;
        await yieldNow();
        t0 = now();
      };
      // Continuation bytes left for this module (a unit; review of #138):
      // the optimiser says how many its earlier batches used.
      let unitBytes = REGION_UNIT_CONTINUATION_MAX_BYTES - (batch[0]?.continuationBytesUsed ?? 0);
      for (const [n, f] of batch.entries()) {
        if (n && now() - t0 >= sliceMs) {
          out.push({ entry: f.entry, reason: "budget" });
          break;
        }
        // A large member's even share of what is left (the optimiser gives
        // the rest back to the refused ones at the module's end, `resume`).
        const share = f.largeLeft > 1 ? Math.floor(unitBytes / f.largeLeft) : unitBytes;
        const r = await translateWithContinuations(m, f, { mask, maxBlocks, names, maxContinuations, maxBytes: share, functionCap, slice });
        unitBytes -= r.budgetCharged ?? 0;
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
// is capped, its frontier (the leaders that branches inside blocks it holds
// reach, decoded from guest memory) starts continuation fragments of the
// same function, in the same module, until no frontier is left: the
// region's exit there becomes a direct return_call, and claimEntries (at
// assembly) keeps each PC's first owner. A fragment is capped when it holds
// maxBlocks blocks or its code reaches REGION_FRAGMENT_MAX_BYTES (the byte
// cap of patch 0115, #131: its discovery stops once the code reaches it).
// Each continuation stays under that cap on its own (fewer blocks until it
// fits; a single block over it is refused and stays an exit). At most
// maxContinuations fragments and maxBytes of them per function, and
// REGION_UNIT_CONTINUATION_MAX_BYTES per module: a module must still fit a
// throttle sleep (0107, ~1.7 ms/MB). A leader that does not translate (a
// first op the translator refuses) stays an exit, as before.
export const REGION_FRAGMENT_MAX_BYTES = 96000;
// Under JavaScriptCore (src/wasm-engine.js) every fragment, the first one
// included, stays under this as a whole wasm function body (prologue and
// exits counted: fragment.code is the body): JSC never tiers a function past
// 100,000 bytes of body up to OMG (maximumOMGCandidateCost), so a bigger hot
// fragment stays in BBQ, 1.6x slower (rendu's WebKit lane). V8 has no such
// limit and pays for the extra transitions (heavy scene: -3.9 % headroom),
// SpiderMonkey decides Ion per module: neither gets it (functionCap 0).
export const REGION_JSC_FUNCTION_CAP = 95000;
export const REGION_CONTINUATION_MAX_BYTES = 2 << 20;
export const REGION_UNIT_CONTINUATION_MAX_BYTES = 1 << 20;
export const REGION_MAX_CONTINUATIONS = 31;
export const REGION_UNCUT_BLOCKS = 64; // what one fragment held before continuations: free of budget
const capped = (fragment, maxBlocks, maxFragmentBytes) => fragment.entries.length >= maxBlocks || fragment.code.length >= maxFragmentBytes;
export async function translateWithContinuations(m, f, { mask, maxBlocks, names, maxContinuations = REGION_MAX_CONTINUATIONS,
  maxBytes = REGION_CONTINUATION_MAX_BYTES, maxFragmentBytes = REGION_FRAGMENT_MAX_BYTES, functionCap = 0, slice = async () => {} }) {
  // functionCap (JSC, REGION_JSC_FUNCTION_CAP): the first fragment, too,
  // under it: fewer blocks until it fits (a single block over it is kept,
  // being the function's entry); what it leaves out goes to continuations,
  // which stay under it as well. 0: as before (a first fragment capped by
  // blocks only; 0x800f4e50: 612 KB in one function, fine for V8).
  if (functionCap > 0) maxFragmentBytes = Math.min(maxFragmentBytes, functionCap);
  let first = translateOne(m, f, { mask, maxBlocks, names });
  let cut = false;
  for (let blocks = maxBlocks; functionCap > 0 && first.fragment && first.fragment.code.length > maxFragmentBytes && blocks > 1;) {
    blocks = Math.max(1, blocks >> 1);
    await slice(); // a 612 KB function retried up to 6 times: the worker's slice in between (review of #215)
    first = translateOne(m, f, { mask, maxBlocks: blocks, names });
    cut = true;
  }
  if (!first.fragment || maxContinuations <= 0) return first;
  const owned = new Set(first.fragment.entries.map((pc) => pc >>> 0));
  // The plan's extra entries (jump-table targets, resolved indirect targets,
  // code pointers) that no direct branch reaches: seeds of the frontier, so
  // a bctr into them stays in the region rather than leaving for code with
  // none (the race scene's 0x80077044, a jump-table target of 0x80076eb8).
  const seeds = (f.extraEntries ?? []).map((pc) => pc >>> 0).filter((pc) => !owned.has(pc) && f.ranges.some(([s, e]) => pc >= s && pc < e));
  // An uncapped first fragment can still leave code out: the core's
  // discovery does not follow an mtmsr's fall-through (an exit: MSR may
  // have changed), so blocks only it reaches had no entry (a homebrew's main
  // loop: 35 % of its cycles outside regions). The frontier says so; it is
  // followed only when that code loops (a branch back at or past the first
  // leader). A straight tail after an mtmsr (an OS routine's FPU save or
  // load, the FP unavailable path) runs once per call: as a region it cost
  // one more region entry per call and broke block chains there (race
  // scene -1.3 %, review of #240).
  const branches = functionBranches(m, f.ranges);
  if (!seeds.length && !cut && !capped(first.fragment, maxBlocks, maxFragmentBytes) && !loopsPast(branches, frontier(branches, owned), owned)) return first;
  const tried = new Set();
  const continuations = [];
  // The budget counts only what goes past the function's old single
  // fragment: the first fragment and its continuations together, up to
  // maxBlocks blocks, are the code one uncut fragment held before
  // continuations (and before a byte cap moved it into them), so they are
  // free; only the blocks after those spend the
  // function's budget and the module's (review of 0130: −39 % when the
  // moved code ran out of budget and fell back to the dispatcher).
  let freeBlocks = Math.max(0, REGION_UNCUT_BLOCKS - first.fragment.entries.length);
  let fnBytes = REGION_CONTINUATION_MAX_BYTES; // the function's own cap, over every grow
  let oversize = 0;
  // Continuations are translated over carved ranges, which the core cannot
  // check against the plan's hash (it covers the whole ranges): the code is
  // hashed here after each one, as the core hashed it for the first. Code
  // rewritten meanwhile (an overlay or a REL during a slice) refuses the
  // fragment and stops the function's growth; back by install time, it
  // would pass the install's check and be stored under the plan's key, then
  // run in every later session (review of #205).
  const read32 = guestRead32(m);
  let codeChanged = false;
  const codeMatchesPlan = () => !f.hash || !read32 || regionHash(read32, f.ranges) === f.hash;
  // `elsewhere`: entries another member of the module already holds (a
  // continuation started there would be dropped at assembly, its bytes
  // charged for nothing).
  // The frontier's leaders first (what held code reaches), then the seeds
  // nothing held reaches yet, each in address order: a big table of seeds
  // at low addresses no longer takes the continuations and the budget from
  // the leaders above it (review of #191). `fromSeed`: started from a seed.
  const next_ = (elsewhere) => {
    const keep = (x) => !tried.has(x) && !owned.has(x) && !elsewhere?.has(x);
    const leaders = frontier(branches, owned).filter(keep);
    const reached = new Set(leaders);
    return [...leaders, ...seeds.filter((x) => keep(x) && !reached.has(x)).sort((a, b) => a - b)];
  };
  const fromSeed = (pc) => seeds.includes(pc) && !frontier(branches, owned).includes(pc);
  // Continuations from the frontier until it is empty or the next one would
  // cost more than `limit` (never past it: that one goes back to the
  // frontier, for a later share); what is left waiting is refused for lack
  // of budget. `exhausted`: the function's own cap is reached (no share can
  // help it any more).
  const grow = async (limit, elsewhere = null) => {
    let bytes = Math.min(limit, fnBytes);
    let charged = 0, refused = 0;
    const added = [];
    for (;;) {
      const waiting = next_(elsewhere);
      if (!waiting.length || codeChanged) break;
      if (continuations.length >= maxContinuations || bytes <= 0) {
        refused = waiting.length; // left as exits for lack of budget
        break;
      }
      const pc = waiting[0];
      const seeded = fromSeed(pc);
      tried.add(pc);
      await slice();
      // Over the function's ranges without the first word of each block
      // already held: a continuation stops at a held block (its range ends
      // there) and jumps to it, rather than translating it again (in
      // 0x800f4e50, 39 of 142 entries were blocks of another fragment). The
      // plan's hash covers the whole ranges, so it is not asked here: the
      // first fragment checked it in this pass, and the install checks every
      // member against the plan again.
      const carved = { ...f, entry: pc, ranges: withoutStarts(f.ranges, owned), hash: null };
      let next = translateOne(m, carved, { mask, maxBlocks, names });
      for (let blocks = maxBlocks; next.fragment && next.fragment.code.length > maxFragmentBytes && blocks > 1;) {
        blocks = Math.max(1, blocks >> 1);
        next = translateOne(m, carved, { mask, maxBlocks: blocks, names });
      }
      if (!next.fragment) continue;
      if (!codeMatchesPlan()) {
        codeChanged = true;
        break;
      }
      if (next.fragment.code.length > maxFragmentBytes) { oversize += 1; continue; } // one block alone: left an exit
      // The share of this fragment within the old single fragment's blocks
      // is free; not for one started from a seed, which held code does not
      // reach: it is charged whole, so the seeds' code is bounded by the
      // budget (review of #191).
      const n = next.fragment.entries.length;
      const free = seeded ? 0 : Math.min(freeBlocks, n);
      const cost = Math.round(next.fragment.code.length * (n - free) / Math.max(1, n));
      if (cost > bytes) {
        tried.delete(pc); // past the budget: back to the frontier
        refused = next_(elsewhere).length;
        break;
      }
      freeBlocks -= free;
      for (const e of next.fragment.entries) owned.add(e >>> 0);
      continuations.push(next.fragment);
      added.push(next.fragment);
      bytes -= cost;
      charged += cost;
    }
    fnBytes -= charged;
    return { added, charged, refused, exhausted: codeChanged || (refused > 0 && (continuations.length >= maxContinuations || fnBytes <= 0)) };
  };
  const { charged, refused, exhausted } = await grow(maxBytes);
  return {
    ...first, ...(continuations.length ? { continuations: [...continuations], budgetCharged: charged } : {}), ...(oversize ? { oversize } : {}),
    ...(codeChanged ? { codeChanged } : {}),
    ...(refused ? { budgetRefused: refused } : {}),
    ...(refused && !exhausted ? {
      // The module's leftover budget, once its other functions took their
      // share: this function's frontier goes on where it stopped (nothing
      // translated again), never past `limit`, and not from an entry another
      // member holds (`elsewhere`). The new continuations, what they cost,
      // what is still refused, and whether the function's own cap is reached.
      resume: async (limit, elsewhere = null) => {
        const more = await grow(limit, elsewhere);
        return { continuations: more.added, budgetCharged: more.charged, budgetRefused: more.refused, exhausted: more.exhausted };
      }
    } : {})
  };
}

// A reader of guest words (big-endian, the RAM through its heap base), or
// null with a core that does not say where its RAM is.
function guestRead32(m) {
  if (typeof m?._DolphinWeb_AotRegionHeapBases !== "function") return null;
  const ram = coreHeapBases(m)[0];
  return (a) => new DataView(m.HEAPU8.buffer).getUint32(ram + (a & 0x01ffffff), false);
}

// `ranges` (sorted [start, end)) without the word at each of `starts`.
export function withoutStarts(ranges, starts) {
  const cuts = [...starts].map((pc) => pc >>> 0).sort((a, b) => a - b);
  const out = [];
  for (const [s0, e] of ranges) {
    let s = s0 >>> 0;
    for (const c of cuts) {
      if (c < s || c >= e) continue;
      if (c > s) out.push([s, c]);
      s = c + 4;
    }
    if (s < e) out.push([s, e >>> 0]);
  }
  return out;
}

// Whether the code the frontier's `leaders` lead to holds a loop: walked
// from each leader to the next block end or held entry, following the
// branches met there (targets not held), a branch goes back into code the
// walk reached. Held code is never walked (a straight tail before a held
// loop does not count), nor a word no walk reaches (a literal after a blr
// that decodes as a branch back; review of #243).
export function loopsPast(branches, leaders, owned) {
  const ends = branches.ends ?? [];
  const starts = [...owned].sort((x, y) => x - y);
  const after = (list, pc) => { let lo = 0, hi = list.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid] < pc) lo = mid + 1; else hi = mid; } return list[lo]; };
  const walked = [], met = [];
  const queue = [...leaders], seen = new Set(queue);
  while (queue.length) {
    const s = queue.pop();
    const end = after(ends, s), held = after(starts, s + 1);
    const stop = Math.min(end === undefined ? Infinity : end + 4, held === undefined ? Infinity : held);
    walked.push([s, stop]);
    for (const [a, targets] of branches) {
      if (a < s || a >= stop) continue;
      met.push([a, targets]);
      for (const t of targets) if (!owned.has(t) && !seen.has(t)) { seen.add(t); queue.push(t); }
    }
  }
  const reached = (pc) => walked.some(([s, e]) => pc >= s && pc < e);
  return met.some(([a, targets]) => targets.some((t) => t <= a && reached(t)));
}

// The direct branches of the code in `ranges` ([start, end) guest
// addresses), read from the emulated RAM (big-endian): [address, leaders it
// makes] for each b and bc without link (its target inside the ranges, and
// for a bc the next instruction), in address order; `ends` lists the
// instructions after which a block never falls through (b, blr and bctr
// always taken, rfi).
export function functionBranches(m, ranges) {
  const out = [];
  out.ends = [];
  out.calls = []; // call sites (bl, bcl, bctrl, blrl): their return point is reached once the callee returns
  if (typeof m._DolphinWeb_AotRegionHeapBases !== "function") return out;
  const ram = coreHeapBases(m)[0];
  const inside = (pc) => ranges.some(([s, e]) => pc >= s && pc < e);
  const view = new DataView(m.HEAPU8.buffer);
  for (const [s, e] of ranges) {
    for (let a = s >>> 0; a < e >>> 0; a += 4) {
      const w = view.getUint32(ram + (a & 0x01ffffff), false);
      const op = w >>> 26;
      const xo = (w >>> 1) & 0x3ff;
      if ((op === 18 && !(w & 1)) || (op === 19 && (xo === 50 || ((xo === 16 || xo === 528) && ((w >>> 21) & 0x14) === 0x14)))) out.ends.push(a >>> 0);
      if ((w & 1) && (op === 16 || op === 18 || (op === 19 && (xo === 16 || xo === 528))) && inside((a + 4) >>> 0)) out.calls.push(a >>> 0);
      if ((op !== 16 && op !== 18) || (w & 1)) continue; // b/bc without link
      const disp = op === 18 ? ((w & 0x03fffffc) << 6) >> 6 : ((w & 0xfffc) << 16) >> 16;
      const target = ((w & 2) ? disp : a + disp) >>> 0;
      const leaders = [target, ...(op === 16 ? [(a + 4) >>> 0] : [])].filter(inside);
      out.push([a >>> 0, leaders]);
    }
  }
  out.sort((x, y) => x[0] - y[0]);
  out.ends.sort((x, y) => x - y);
  out.calls.sort((x, y) => x - y);
  return out;
}

// The leaders that the blocks held already reach and that none holds, in
// address order. A branch is in held code when the nearest held entry at or
// before it reaches it with no block end between them (the core's block can
// run through a leader it did not split at, e.g. a loop head right after the
// entry); a word that only looks like a branch (a literal after a blr) is in
// no block.
export function frontier(branches, owned) {
  const starts = [...owned].sort((a, b) => a - b);
  const blockOf = (a) => {
    let lo = 0, hi = starts.length - 1, at = null;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (starts[mid] <= a) { at = starts[mid]; lo = mid + 1; } else hi = mid - 1; }
    return at;
  };
  const ends = branches.ends ?? [];
  const endBetween = (from, to) => ends.some((e) => e >= from && e < to);
  const out = new Set();
  for (const [a, leaders] of branches) {
    const start = blockOf(a);
    if (start === null || endBetween(start, a)) continue;
    for (const pc of leaders) if (!owned.has(pc)) out.add(pc);
  }
  // The return point of a call made from held code (a bctrl's next word is
  // no branch target: before continuations stopped at held blocks, one
  // translated through the call and held it). Discovery has no noreturn
  // knowledge either: the word after a call is inside the plan's ranges, so
  // under its hash; were it data, an invalid op ends or refuses the
  // fragment, and nothing enters it unless a PC really goes there.
  for (const c of branches.calls ?? []) {
    const pc = (c + 4) >>> 0;
    if (owned.has(pc) || out.has(pc)) continue;
    const start = blockOf(c);
    if (start !== null && !endBetween(start, c)) out.add(pc);
  }
  // A leader a held block falls into, with no branch to it from held code
  // (a loop head after the mtctr that precedes it, review of dispatch): no
  // block end between the nearest held entry and it. A continuation stops
  // at held blocks, so nothing else reaches it.
  for (const [, leaders] of branches) {
    for (const pc of leaders) {
      if (owned.has(pc) || out.has(pc)) continue;
      const start = blockOf((pc - 4) >>> 0);
      if (start !== null && !endBetween(start, pc)) out.add(pc);
    }
  }
  return [...out].sort((a, b) => a - b);
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
    if (kind === 5) return { offset, kind: "call", targetPc: value }; // a guest call as a wasm call (0142)
    if (kind === 4) return { offset, kind: "hint", likely: value === 1 }; // an `if` and whether its true arm is likely (0131)
    return { offset, kind: "dispatch" };
  });
  const at = p + 24 + 4 * (entryCount + 3 * relocCount);
  // layout: the core's heap layout hash the code embeds (0 from a core
  // before the layout guard): the region module carries it to the install.
  // heapBases: the RAM and L1 addresses its heap sites hold (0084).
  const heapBases = typeof m._DolphinWeb_AotRegionHeapBases === "function" ? coreHeapBases(m) : null;
  return { entry: f.entry, fragment: { entry, entries, code: m.HEAPU8.slice(at, at + codeLength), relocs, layout, ...(heapBases ? { heapBases } : {}) } };
}
