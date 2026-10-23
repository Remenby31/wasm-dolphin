// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later

// Region equivalence on the core (plan piste 3, P4): the N-slice driver of
// test/aot-region-equivalence with the core in place of its stand-ins. The
// translator is _DolphinWeb_AotTranslateForTest, the reference the core's
// interpreter, regions are assembled by src/aot-region-module.js and run on
// the core's memory and PowerPCState with the real helpers. Every function of
// a plan runs twice from the same seeded call state: interpreter only, then
// regions wherever one holds the pc (interpreter elsewhere, as the JIT would).
// The whole 248-word oracle state, downcount and all of RAM must end
// identical. A call has a budget of guest cycles: both runs take every
// instruction's cycles from downcount (regions a block's at once), so a call
// that does not return within it (a wait on the time base, `b .`, a list walk
// on a seeded pointer) is compared where the region run ran out, with the
// interpreter run stopped at the same downcount. A call that ends in an
// exception is compared at the exception.

import { readFileSync } from "node:fs";

import { orderedRegions } from "../../src/aot-plan.js";
import { REGION_HEAP_NAMES, assembleRegion, groupRegions } from "../../src/aot-region-module.js";
import { PRODUCTION_DISABLE_MASK, makeRng, randomProgram, randomState } from "./jit-oracle.mjs";

// Signatures of the block module's import types (BuildWasmCachedInterpreterBlock).
const T1 = { params: ["i32", "i32"], results: ["i32"] };
const T2 = { params: ["i32", "i32", "i32"], results: [] };
const T3 = { params: ["i32", "i32", "i32", "i32", "i32"], results: ["i32"] };
const FMA = { params: ["f64", "f64", "f64", "i32"], results: ["f64"] };
export const HELPER_SIGNATURES = {
  read_u32: T1, write_u32: T2, read_u8: T1, write_u8: T2, read_u16: T1, write_u16: T2,
  lfs: T3, stfs: T3, lfd: T3, fmr: T3, system: T3, fp: T3, fctiwz: T3, interpret: T3,
  fastcheck_gpfifo: T2, fast_os_interrupt_call: T3, fast_melee_input_status_call: T1,
  fast_melee_status_call: T3, fast_melee_service_poll_call: T3, fma: FMA
};

export const STOP = 0x80002000; // return address of the call under test: no code there
const SCRATCH = 0x80c00000; // pointer arguments land in 1 MiB nothing else uses
const STACK = 0x80f00000;

export async function loadAotCore(coreDir = new URL("../../cores/dolphin/", import.meta.url)) {
  const { default: createDolphinCore } = await import(new URL("dolphin-core-upstream.js", coreDir));
  const m = await createDolphinCore({
    wasmBinary: readFileSync(new URL("dolphin-core-upstream.wasm", coreDir)),
    noInitialRun: true,
    print: () => {},
    printErr: () => {}
  });
  if (typeof m._DolphinWeb_AotTranslateForTest !== "function") return null;
  const statePtr = m._DolphinWeb_AotTestSetUp() >>> 0;
  if (!statePtr) throw new Error("core: test CPU set-up failed");
  const ramPtr = m._DolphinWeb_AotTestRam() >>> 0;
  const RAM_BYTES = 24 << 20;
  const ram = () => new Uint8Array(m.HEAPU8.buffer, ramPtr, RAM_BYTES);
  const helperNames = [];
  for (let i = 0; ; i++) {
    const p = m._DolphinWeb_JitHelperName(i);
    if (!p) break;
    helperNames.push(m.UTF8ToString(p));
  }
  const layoutPtr = m._malloc(16);
  m._DolphinWeb_JitStateLayout(layoutPtr);
  const [pcOffset, , downcountOffset] = new Uint32Array(m.HEAPU8.buffer, layoutPtr, 4);
  m._free(layoutPtr);
  const gprPtr = m._malloc(128);
  // The core's [ramBase, l1Base] (0084), null with an older core.
  const heapBases = () => {
    if (typeof m._DolphinWeb_AotRegionHeapBases !== "function") return null;
    const p = m._malloc(8);
    try {
      m._DolphinWeb_AotRegionHeapBases(p);
      return Array.from(new Uint32Array(m.HEAPU8.buffer, p, 2));
    } finally {
      m._free(p);
    }
  };
  return {
    module: m, // the Emscripten module, for the production exports
    has: (name) => typeof m[`_${name}`] === "function",
    pcOffset,
    helperNames,
    memoryPages: m.HEAPU8.buffer.byteLength / 65536,
    ram,
    // Guest bytes at effective address `addr` (0x80000000 view of MEM1).
    load(addr, bytes) { ram().set(bytes, addr & 0x01ffffff); },
    // Fragment of the function at `pc`: its blocks reachable inside `ranges`
    // ([[start, end)], the block at pc alone by default), or null when the
    // core cannot translate the block at pc.
    translate(pc, { mask = PRODUCTION_DISABLE_MASK, ranges = [[pc, pc + 4]], maxBlocks = 64 } = {}) {
      const r = m._malloc(8 * ranges.length);
      let p;
      try {
        new Uint32Array(m.HEAPU8.buffer, r, 2 * ranges.length).set(ranges.flat());
        p = m._DolphinWeb_AotTranslateForTest(pc >>> 0, mask >>> 0, r, ranges.length, maxBlocks) >>> 0;
      } finally {
        m._free(r);
      }
      if (!p) return null;
      const [entry, codeLength, entryCount, relocCount] = new Uint32Array(m.HEAPU8.buffer, p, 4);
      const words = new Uint32Array(m.HEAPU8.buffer, p + 16, entryCount + 3 * relocCount);
      const entries = Array.from(words.subarray(0, entryCount));
      const relocs = Array.from({ length: relocCount }, (_, i) => {
        const [offset, kind, value] = words.subarray(entryCount + 3 * i, entryCount + 3 * i + 3);
        if (kind === 0) return { offset, kind: "import", name: helperNames[value] };
        if (kind === 1) return { offset, kind: "jump", targetPc: value };
        if (kind === 3) return { offset, kind: "heap", name: REGION_HEAP_NAMES[value & 1], form: value & 2 ? "offset" : "const" };
        if (kind === 4) return { offset, kind: "hint", likely: value === 1 }; // branch hint (0131)
        return { offset, kind: "dispatch" };
      });
      const at = p + 16 + 4 * (entryCount + 3 * relocCount);
      return { entry, entries, code: m.HEAPU8.slice(at, at + codeLength), relocs, ...(heapBases() ? { heapBases: heapBases() } : {}) };
    },
    // Handle of the compiled module in the core's table (> 0), as for a block.
    compile(bytes) {
      const p = m._malloc(bytes.length);
      try {
        m.HEAPU8.set(bytes, p);
        return m._DolphinWeb_JitCompileBytesForTest(p, bytes.length);
      } finally {
        m._free(p);
      }
    },
    runRegion: (handle) => m._DolphinWeb_AotRunRegionForTest(handle),
    // The MMU mode a game's INI sets (0091); null when the core lacks the hook.
    setMMUMode: typeof m._DolphinWeb_AotMMUModeForTest === "function" ? (on) => m._DolphinWeb_AotMMUModeForTest(on ? 1 : 0) : null,
    // The dispatcher's region path (P4 step 5): queue, install, dispatch.
    // members: [{ ranges, hash }] (hash: the plan's 16-hex FNV-1a 64, or null).
    // bases: the RAM and L1 addresses its heap sites hold (0084), this session's by default.
    queueRegion(bytes, entries, members, layout = m._DolphinWeb_AotLayoutHash?.() ?? 0, bases = heapBases() ?? [0, 0]) {
      const ranges = members.flatMap((x) => x.ranges);
      const triples = members.flatMap((x) => [x.ranges.length, x.hash ? parseInt(x.hash.slice(8), 16) : 0, x.hash ? parseInt(x.hash.slice(0, 8), 16) : 0]);
      const words = [...entries, ...ranges.flat(), ...triples].map((v) => v >>> 0);
      const b = m._malloc(bytes.length), w = m._malloc(4 * words.length);
      try {
        m.HEAPU8.set(bytes, b);
        new Uint32Array(m.HEAPU8.buffer, w, words.length).set(words);
        const rangesAt = w + 4 * entries.length;
        m._DolphinWeb_AotQueueRegion(b, bytes.length, w, entries.length, rangesAt, ranges.length, rangesAt + 8 * ranges.length, members.length, layout >>> 0, bases[0] >>> 0, bases[1] >>> 0);
      } finally {
        m._free(b);
        m._free(w);
      }
    },
    serviceRegions: () => m._DolphinWeb_AotServiceRegionsForTest(),
    setRegionsEnabled: (on) => m._DolphinWeb_JitSetRegionsEnabled(on ? 1 : 0),
    regionCount: () => m._DolphinWeb_JitRegionCount() >>> 0,
    dispatchRegion: () => m._DolphinWeb_AotDispatchRegionForTest(),
    // Region chaining (patch 0102): on/off, and its counters (null before 0102).
    setRegionChaining: (on) => m._DolphinWeb_JitSetRegionChaining?.(on ? 1 : 0),
    regionChainStats() {
      if (!m._DolphinWeb_JitRegionChainStats) return null;
      const p = m._DolphinWeb_JitRegionChainStats() >>> 0;
      const head = new Uint32Array(m.HEAPU8.buffer, p, 2);
      const f = new Float64Array(m.HEAPU8.buffer, p + 8, 4);
      return { version: head[0], enabled: head[1], chained: f[0], outOfTime: f[1], noRegion: f[2], refused: f[3] };
    },
    invalidate: (address, size) => m._DolphinWeb_AotInvalidateForTest(address >>> 0, size >>> 0),
    unverifyRegions: () => m._DolphinWeb_AotUnverifyForTest(),
    // Layout v1 of DolphinWeb_JitRegionStats (sampleEvery >= 0 resets).
    regionStats(sampleEvery = -1) {
      const p = m._DolphinWeb_JitRegionStats(sampleEvery) >>> 0;
      m._DolphinWeb_AotPublishStatsForTest?.(); // no CPU loop here: apply and publish now
      const head = new Uint32Array(m.HEAPU8.buffer, p, 4);
      const f = new Float64Array(m.HEAPU8.buffer, p + 16, 9);
      const names = ["regionCycles", "totalCycles", "regionTimeMs", "dispatchTimeMs", "blockTimeMs", "interpTimeMs",
        "regionCalls", "regionNotEntry", "regionStops"];
      return { version: head[0], sizeBytes: head[1], sampleEvery: head[2], installFallbacks: head[3] & 0xffff, installBootMaxSliceMs: (head[3] >>> 16) / 10, ...Object.fromEntries(names.map((n, i) => [n, f[i]])) };
    },
    interpretOne: () => m._DolphinWeb_AotTestInterpretOne(),
    reset(gprs, pc, lr, downcount) {
      new Int32Array(m.HEAPU8.buffer, gprPtr, 32).set(gprs);
      m._DolphinWeb_AotTestReset(gprPtr, pc >>> 0, lr >>> 0);
      new Int32Array(m.HEAPU8.buffer, statePtr + downcountOffset, 1)[0] = downcount;
    },
    downcount: () => new Int32Array(m.HEAPU8.buffer, statePtr + downcountOffset, 1)[0],
    setDowncount: (v) => { new Int32Array(m.HEAPU8.buffer, statePtr + downcountOffset, 1)[0] = v; },
    // The oracle's 248-word state (jit-oracle.mjs) as the start state, at pc.
    loadState(words, pc) {
      const p = m._malloc(4 * words.length);
      try {
        new Uint32Array(m.HEAPU8.buffer, p, words.length).set(words);
        m._DolphinWeb_AotTestLoadState(p, pc >>> 0);
      } finally {
        m._free(p);
      }
    },
    // The test CPU has no hardware behind MMIO and no CoreTiming: code that
    // reaches them traps. The caller catches the trap and restores the stack.
    stackSave: () => m._DolphinWeb_AotTestStackPointer() >>> 0,
    stackRestore: (sp) => m._DolphinWeb_AotTestStackRestore(sp),
    state: () => Uint32Array.from(new Uint32Array(m.HEAPU8.buffer, m._DolphinWeb_AotTestState() >>> 0, 248)),
    pc: () => new Uint32Array(m.HEAPU8.buffer, statePtr + pcOffset, 1)[0]
  };
}

// xorshift32 GPRs: half small integers, half pointers into the scratch area
// (aligned to 16); r1 the stack.
export function seedGprs(seed) {
  let s = seed >>> 0 || 1;
  const next = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s; };
  const g = new Int32Array(32);
  for (let r = 0; r < 32; r++) {
    const v = next();
    g[r] = v & 1 ? (SCRATCH + (v & 0x000ffff0)) | 0 : (v >>> 1) % 4096;
  }
  g[1] = STACK;
  return g;
}

export function regionGroups(plan, maxFunctions) {
  const ordered = orderedRegions(plan);
  const groups = [];
  for (const m of plan.modules) {
    const order = ordered.filter((r) => r.module === m.id).map((r) => m.functions.indexOf(r.f)).filter((i) => i >= 0);
    for (const g of groupRegions(m, order, { maxFunctions })) groups.push(g.map((i) => m.functions[i]));
  }
  return groups;
}

// A function's fragment: its blocks reachable from the entry inside its ranges.
export const functionFragments = (core, { mask = PRODUCTION_DISABLE_MASK, maxBlocks = 64 } = {}) => (f) => {
  const fr = core.translate(f.entry, { mask, ranges: f.ranges, maxBlocks });
  return fr ? [fr] : [];
};

// Functions of a region share blocks (tail-merged code, a function inside
// another's ranges): a PC is an entry of the first fragment that holds it;
// a fragment whose own entry is taken is left out (the other one runs it).
function claimEntries(fragments) {
  const claimed = new Set();
  const out = [];
  for (const fr of fragments) {
    if (claimed.has(fr.entry >>> 0)) continue;
    const entries = fr.entries.filter((pc) => !claimed.has(pc >>> 0));
    for (const pc of entries) claimed.add(pc >>> 0);
    out.push({ ...fr, entries });
  }
  return out;
}

// First differing word of the oracle state, with the words that differ.
const diffState = (a, b) => {
  const words = [];
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) words.push(i);
  if (!words.length) return null;
  const i = words[0];
  return { word: i, interp: a[i], region: b[i], words: words.slice(0, 8), pc: { interp: a[47], region: b[47] } };
};

// Runs one call twice from `start()` (which sets RAM, state and downcount):
// the interpreter alone, then regions wherever regionAt holds the pc. Until
// the call returns to STOP, an exception is taken or downcount runs out; the
// interpreter is then rerun to the downcount where the regions stopped.
// Returns { trap } when the interpreter cannot run it on the test CPU,
// { error } when a region refused its own entry, else { equal, got,
// reference, difference }.
export function compareCall(core, regionAt, start) {
  const run = (useRegions, stopAt) => {
    let regionRuns = 0, regionCycles = 0, interpCycles = 0;
    const done = (end) => ({ end, regionRuns, regionCycles, interpCycles });
    for (;;) {
      const pc = core.pc();
      if (pc === STOP) return done("stop");
      const before = core.downcount();
      if (before <= stopAt) return done("budget");
      const handle = useRegions ? regionAt.get(pc) : undefined;
      if (handle === undefined) {
        const raised = core.interpretOne();
        interpCycles += before - core.downcount();
        if (raised) return done("exception");
        continue;
      }
      const code = core.runRegion(handle);
      if (code === 4) {
        // Refused by the mode (0121: MSR LE/FE0/FE1, HID2.LSQE): the CPU loop
        // runs blocks here, as the interpreter does.
        const raised = core.interpretOne();
        interpCycles += before - core.downcount();
        if (raised) return done("exception");
        continue;
      }
      regionRuns += 1;
      regionCycles += before - core.downcount();
      if (code === 1) {
        // 0111: with XER.SO set a fragment refuses to run (returns 1 before
        // touching the state); the dispatcher then runs the block path. The
        // program itself may set SO (mtxer runs outside regions).
        if ((core.state()[33] >>> 31) === 1 && core.pc() === pc && core.downcount() === before) {
          regionRuns -= 1;
          const raised = core.interpretOne();
          interpCycles += before - core.downcount();
          if (raised) return done("exception");
          continue;
        }
        throw new Error(`region refused its own entry ${pc.toString(16)}`);
      }
      if (code === 3) return done("exception");
    }
  };
  const sp = core.stackSave();
  const guarded = (useRegions, stopAt = 0) => {
    try {
      return run(useRegions, stopAt);
    } catch (error) {
      if (!(error instanceof WebAssembly.RuntimeError)) throw error;
      core.stackRestore(sp);
      return { end: "trap", error: String(error.message) };
    }
  };
  start();
  let reference = guarded(false);
  if (reference.end === "trap") return { trap: true };
  start();
  let got;
  try {
    got = guarded(true);
  } catch (error) {
    return { error: String(error.message) };
  }
  const state = core.state();
  const downcount = core.downcount();
  const ram = core.ram().slice();
  start();
  // Same point. Regions check downcount between blocks only, so a block can
  // take it below 0 and finish (even return to STOP): the interpreter runs
  // to that same downcount. A region run that ended in an exception is
  // compared with the interpreter run to its exception, whatever the budget.
  const stopAt = got.end === "exception" ? -Infinity : Math.min(downcount, 0);
  reference = guarded(false, stopAt);
  const expectedRam = core.ram();
  let ramAt = -1;
  if (Buffer.compare(ram, expectedRam) !== 0) ramAt = ram.findIndex((b, i) => b !== expectedRam[i]);
  const stateDiff = diffState(core.state(), state);
  // Exits through an exception leave downcount to the CPU loop.
  const cyclesDiffer = got.end !== "exception" && core.downcount() !== downcount;
  const equal = got.end === reference.end && !stateDiff && ramAt < 0 && !cyclesDiffer;
  return { equal, got, reference, difference: equal ? null : { end: got.end, reference: reference.end, state: stateDiff,
    ram: ramAt < 0 ? null : (0x80000000 + ramAt) >>> 0, downcount: cyclesDiffer ? { interp: core.downcount(), region: downcount } : null } };
}

export function checkCoreSlice({ core, plan, image, slice, slices, maxFunctions = 100, budget = 400000, seed = 1,
  mask = PRODUCTION_DISABLE_MASK, maxBlocks = 64, fragmentsOf = functionFragments(core, { mask, maxBlocks }) }) {
  for (const s of image.segments) core.load(s.start, s.bytes);
  const baseline = core.ram().slice();
  const groups = regionGroups(plan, maxFunctions);
  const mine = new Set(groups.filter((_, i) => i % slices === slice).flat());
  const regionAt = new Map(); // entry pc -> handle
  const report = { slice, slices, functions: 0, translated: 0, fragments: 0, blocks: 0, regions: 0, checked: 0, equal: 0,
    regionRuns: 0, regionCycles: 0, interpCycles: 0, ends: {}, mismatches: [], skipped: {} };
  for (const group of groups) {
    const fragments = claimEntries(group.flatMap(fragmentsOf));
    if (!fragments.length) continue;
    const { bytes } = assembleRegion(fragments, { helpers: HELPER_SIGNATURES, pcOffset: core.pcOffset, memoryPages: core.memoryPages });
    const handle = core.compile(bytes);
    if (handle <= 0) throw new Error(`core rejected a region module (${handle}), group of ${group[0].entry.toString(16)}`);
    report.regions += 1;
    report.fragments += fragments.length;
    for (const fr of fragments) report.blocks += fr.entries.length;
    for (const fr of fragments) for (const pc of fr.entries) regionAt.set(pc >>> 0, handle);
  }

  const skip = (reason) => { report.skipped[reason] = (report.skipped[reason] ?? 0) + 1; };
  for (const f of plan.modules.flatMap((m) => m.functions)) {
    if (!mine.has(f)) continue;
    report.functions += 1;
    if (!regionAt.has(f.entry >>> 0)) continue;
    report.translated += 1;
    const gprs = seedGprs(seed ^ f.entry);
    const result = compareCall(core, regionAt, () => {
      core.ram().set(baseline);
      core.reset(gprs, f.entry, STOP, budget);
    });
    if (result.trap) { skip("trap"); continue; }
    if (result.error) { report.mismatches.push({ entry: f.entry, error: result.error }); continue; }
    report.checked += 1;
    for (const k of ["regionRuns", "regionCycles", "interpCycles"]) report[k] += result.got[k];
    report.ends[result.got.end] = (report.ends[result.got.end] ?? 0) + 1;
    if (result.equal) report.equal += 1;
    else report.mismatches.push({ entry: f.entry, ...result.difference });
  }
  return report;
}

export const ORACLE_CODE = 0x80003000;

export function bigEndian(words) {
  const out = new Uint8Array(4 * words.length);
  const v = new DataView(out.buffer);
  words.forEach((w, i) => v.setUint32(4 * i, w >>> 0, false));
  return out;
}

// The oracle's random programs (jit-oracle.mjs), one fragment each, from its
// random states, with a full and a small cycle budget (mid-region exits).
// One program at ORACLE_CODE, translated as a region while `translateState`
// is loaded (its MSR decides which FPU ops the translator takes), then run
// from `state` by the interpreter alone and by the region (compareCall).
export function compareRegionProgram(core, words, state, { translateState = state, mask = PRODUCTION_DISABLE_MASK, budget = 400000 } = {}) {
  core.load(ORACLE_CODE, bigEndian(words));
  core.loadState(translateState, ORACLE_CODE);
  const fragment = core.translate(ORACLE_CODE, { mask, ranges: [[ORACLE_CODE, ORACLE_CODE + 4 * words.length]] });
  if (!fragment) return { translated: false };
  const { bytes } = assembleRegion([fragment], { helpers: HELPER_SIGNATURES, pcOffset: core.pcOffset, memoryPages: core.memoryPages });
  const handle = core.compile(bytes);
  if (handle <= 0) throw new Error(`core rejected a region module (${handle})`);
  const regionAt = new Map(fragment.entries.map((pc) => [pc >>> 0, handle]));
  const baseline = core.ram().slice();
  const result = compareCall(core, regionAt, () => {
    core.ram().set(baseline);
    core.loadState(state, ORACLE_CODE);
    core.setDowncount(budget);
  });
  return { translated: true, fragment, ...result };
}

export function runOracleProgramsAsRegions(core, { seed, count, length, mask }) {
  const r = makeRng(seed);
  const tally = { programs: 0, translated: 0, compared: 0, equal: 0, trap: 0, ends: {}, regionRuns: 0, mismatches: [] };
  for (let n = 0; n < count; n++) {
    const words = randomProgram(r, length);
    const state = randomState(r);
    const smallBudget = 1 + r.below(60);
    tally.programs += 1;
    core.load(ORACLE_CODE, bigEndian(words));
    const fragment = core.translate(ORACLE_CODE, { mask, ranges: [[ORACLE_CODE, ORACLE_CODE + 4 * words.length]] });
    if (!fragment) continue;
    tally.translated += 1;
    const { bytes } = assembleRegion([fragment], { helpers: HELPER_SIGNATURES, pcOffset: core.pcOffset, memoryPages: core.memoryPages });
    const handle = core.compile(bytes);
    if (handle <= 0) throw new Error(`core rejected a region module (${handle})`);
    const regionAt = new Map(fragment.entries.map((pc) => [pc >>> 0, handle]));
    const baseline = core.ram().slice();
    for (const budget of [400000, smallBudget]) {
      const call = (start) => compareCall(core, regionAt, () => {
        core.ram().set(baseline);
        core.loadState(start, ORACLE_CODE);
        core.setDowncount(budget);
      });
      let result = call(state);
      // 0111: regions do not run with XER.SO set (their compares store CR
      // fields without it): from a state with SO set, compareCall runs the
      // interpreter where a fragment refuses. The program is also compared
      // from the same state with SO clear, so its regions run.
      if ((state[33] >>> 31) === 1 && core.has?.("DolphinWeb_AotKeyParts")) {
        const clear = state.slice();
        clear[33] = (clear[33] & 0x7fffffff) >>> 0;
        const again = call(clear);
        if (!again.trap) {
          tally.soCleared = (tally.soCleared ?? 0) + 1;
          if (again.error) tally.mismatches.push({ n, budget, soCleared: true, error: again.error });
          else if (!again.equal) tally.mismatches.push({ n, budget, soCleared: true, program: Array.from(words, (w) => w.toString(16)), ...again.difference });
        }
      }
      if (result.trap) { tally.trap += 1; continue; }
      tally.compared += 1;
      if (result.error) { tally.mismatches.push({ n, budget, error: result.error }); continue; }
      tally.ends[result.got.end] = (tally.ends[result.got.end] ?? 0) + 1;
      tally.regionRuns += result.got.regionRuns;
      if (result.equal) tally.equal += 1;
      else tally.mismatches.push({ n, budget, program: Array.from(words, (w) => w.toString(16)), ...result.difference });
    }
  }
  return tally;
}

