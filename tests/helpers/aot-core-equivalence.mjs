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
import { assembleRegion, groupRegions } from "../../src/aot-region-module.js";
import { PRODUCTION_DISABLE_MASK } from "./jit-oracle.mjs";

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
  return {
    pcOffset,
    helperNames,
    memoryPages: m.HEAPU8.buffer.byteLength / 65536,
    ram,
    // Guest bytes at effective address `addr` (0x80000000 view of MEM1).
    load(addr, bytes) { ram().set(bytes, addr & 0x01ffffff); },
    // Fragment of the block at `pc`, or null when the core cannot translate it.
    translate(pc, mask = PRODUCTION_DISABLE_MASK) {
      const p = m._DolphinWeb_AotTranslateForTest(pc >>> 0, mask >>> 0) >>> 0;
      if (!p) return null;
      const head = new Uint32Array(m.HEAPU8.buffer, p, 3);
      const [entry, codeLength, relocCount] = head;
      const words = new Uint32Array(m.HEAPU8.buffer, p + 12, 2 * relocCount);
      const relocs = Array.from({ length: relocCount }, (_, i) => ({
        offset: words[2 * i], kind: "import", name: helperNames[words[2 * i + 1]]
      }));
      const code = m.HEAPU8.slice(p + 12 + 8 * relocCount, p + 12 + 8 * relocCount + codeLength);
      return { entry, entries: [entry], code, relocs };
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
    interpretOne: () => m._DolphinWeb_AotTestInterpretOne(),
    reset(gprs, pc, lr, downcount) {
      new Int32Array(m.HEAPU8.buffer, gprPtr, 32).set(gprs);
      m._DolphinWeb_AotTestReset(gprPtr, pc >>> 0, lr >>> 0);
      new Int32Array(m.HEAPU8.buffer, statePtr + downcountOffset, 1)[0] = downcount;
    },
    downcount: () => new Int32Array(m.HEAPU8.buffer, statePtr + downcountOffset, 1)[0],
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

// Step 2 of the translator: a function's fragment is the block at its entry.
// The rest of the function runs in the interpreter.
const entryBlockFragments = (core, mask) => (f) => {
  const fr = core.translate(f.entry, mask);
  return fr ? [fr] : [];
};

const diffState = (a, b) => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return { word: i, interp: a[i], region: b[i] };
  return null;
};

export function checkCoreSlice({ core, plan, image, slice, slices, maxFunctions = 100, budget = 400000, seed = 1,
  mask = PRODUCTION_DISABLE_MASK, fragmentsOf = entryBlockFragments(core, mask) }) {
  for (const s of image.segments) core.load(s.start, s.bytes);
  const baseline = core.ram().slice();
  const groups = regionGroups(plan, maxFunctions);
  const mine = new Set(groups.filter((_, i) => i % slices === slice).flat());
  const regionAt = new Map(); // entry pc -> handle
  const report = { slice, slices, functions: 0, translated: 0, fragments: 0, regions: 0, checked: 0, equal: 0,
    regionRuns: 0, ends: {}, mismatches: [], skipped: {} };
  for (const group of groups) {
    const fragments = group.flatMap(fragmentsOf);
    if (!fragments.length) continue;
    const { bytes } = assembleRegion(fragments, { helpers: HELPER_SIGNATURES, pcOffset: core.pcOffset, memoryPages: core.memoryPages });
    const handle = core.compile(bytes);
    if (handle <= 0) throw new Error(`core rejected a region module (${handle}), group of ${group[0].entry.toString(16)}`);
    report.regions += 1;
    report.fragments += fragments.length;
    for (const fr of fragments) for (const pc of fr.entries) regionAt.set(pc >>> 0, handle);
  }

  const skip = (reason) => { report.skipped[reason] = (report.skipped[reason] ?? 0) + 1; };
  // Until the call returns, an exception is taken or downcount <= stopAt.
  const run = (useRegions, stopAt) => {
    let regionRuns = 0;
    for (;;) {
      const pc = core.pc();
      if (pc === STOP) return { end: "stop", regionRuns };
      if (core.downcount() <= stopAt) return { end: "budget", regionRuns };
      const handle = useRegions ? regionAt.get(pc) : undefined;
      if (handle === undefined) {
        if (core.interpretOne()) return { end: "exception", regionRuns };
        continue;
      }
      regionRuns += 1;
      const code = core.runRegion(handle);
      if (code === 1) throw new Error(`region refused its own entry ${pc.toString(16)}`);
      if (code === 3) return { end: "exception", regionRuns };
    }
  };

  const sp = core.stackSave();
  const guarded = (useRegions, stopAt = 0) => {
    try {
      return run(useRegions, stopAt);
    } catch (error) {
      if (!(error instanceof WebAssembly.RuntimeError)) throw error;
      core.stackRestore(sp);
      return { end: "trap", regionRuns: 0, error: String(error.message) };
    }
  };

  for (const f of plan.modules.flatMap((m) => m.functions)) {
    if (!mine.has(f)) continue;
    report.functions += 1;
    if (!regionAt.has(f.entry >>> 0)) continue;
    report.translated += 1;
    const gprs = seedGprs(seed ^ f.entry);
    const start = () => {
      core.ram().set(baseline);
      core.reset(gprs, f.entry, STOP, budget);
    };
    start();
    let reference = guarded(false);
    if (reference.end === "trap") { skip("trap"); continue; }
    start();
    let got;
    try {
      got = guarded(true);
    } catch (error) {
      report.mismatches.push({ entry: f.entry, error: String(error.message) });
      continue;
    }
    const state = core.state();
    const downcount = core.downcount();
    const ram = core.ram().slice();
    if (got.end === "budget" && reference.end === "budget") {
      // Same point: the interpreter stops at the downcount the regions ran out at.
      start();
      reference = guarded(false, downcount);
    } else {
      start();
      reference = guarded(false);
    }
    report.checked += 1;
    report.regionRuns += got.regionRuns;
    report.ends[got.end] = (report.ends[got.end] ?? 0) + 1;
    const expectedRam = core.ram();
    let ramAt = -1;
    if (Buffer.compare(ram, expectedRam) !== 0) ramAt = ram.findIndex((b, i) => b !== expectedRam[i]);
    const stateDiff = diffState(core.state(), state);
    // Exits through an exception leave downcount to the CPU loop.
    const cyclesDiffer = got.end !== "exception" && core.downcount() !== downcount;
    if (got.end === reference.end && !stateDiff && ramAt < 0 && !cyclesDiffer) report.equal += 1;
    else report.mismatches.push({ entry: f.entry, end: got.end, reference: reference.end, state: stateDiff,
      ram: ramAt < 0 ? null : (0x80000000 + ramAt) >>> 0, downcount: cyclesDiffer ? { interp: core.downcount(), region: downcount } : null });
  }
  return report;
}
