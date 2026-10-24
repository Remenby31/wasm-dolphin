// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later

// Interpreter-vs-JIT oracle driver. The core's DolphinWeb_JitOracleRun runs one
// PowerPC program twice from the same state (interpreter, then the WASM block
// pipeline of the CPU thread) and returns both final states; this module
// generates the programs and states and explains a difference.
//
// Programs live at 0x80003000 and return with blr to a sentinel in LR. r1
// points into a 256-byte scratch buffer (0x80100080, the only memory that is
// compared), r2 holds a small aligned index for X-form accesses; neither is
// ever a destination. Floating-point inputs include zeros, infinities, quiet
// and signalling NaNs, double and single denormals, values at the single
// rounding boundary and random bit patterns; FPSCR gets a random rounding
// mode and non-IEEE bit (exceptions stay masked by MSR.FE0/FE1 = 0).

import { readFileSync } from "node:fs";

export const PRODUCTION_DISABLE_MASK = (1 << 17) | (1 << 21); // blockmerge, shortprefix off
export const SHORT_PREFIX_MASK = 1 << 17; // lets a 2-op block (inst + blr) compile
export const REGALLOC_OFF = 1 << 20;

const SCRATCH = 0x80100000;
const SENTINEL = 0x80002000;
const BLR = 0x4e800020;
const STATE_WORDS = 248;
const MAX_WORDS = 256;

export async function loadOracleCore(coreDir = new URL("../../cores/dolphin/", import.meta.url)) {
  const { default: createDolphinCore } = await import(new URL("dolphin-core-upstream.js", coreDir));
  const module = await createDolphinCore({
    wasmBinary: readFileSync(new URL("dolphin-core-upstream.wasm", coreDir)),
    noInitialRun: true,
    print: () => {},
    printErr: () => {}
  });
  // The 248-word state (exception registers) ships with the armed warmup in
  // patch 0072: an older core cannot run these programs.
  if (typeof module._DolphinWeb_JitOracleRun !== "function" ||
      typeof module._DolphinWeb_JitArmedStepForTest !== "function") return null;
  const base = module._DolphinWeb_JitOracleBuffer() >>> 0;
  const view = () => new Uint32Array(module.HEAPU8.buffer, base, MAX_WORDS + 3 * STATE_WORDS + 4);
  return {
    has: (name) => typeof module[`_${name}`] === "function",
    // Patch 0121: FPRF on or off for every tier (Config::MAIN_FPRF).
    setFprf: (on) => module._DolphinWeb_SetFprfForTest(on ? 1 : 0),
    // Patch 0129: the FMA emitter's relaxed_madd mode (returns the previous one).
    setFusedMadd: (on) => module._DolphinWeb_SetFusedMadd(on ? 1 : 0),
    // The core's helper counters (GetPpcWasmHelperStats): imports fp:N counts
    // calls of the fp helper, the interpreter fallback of FPU ops.
    fpHelperCalls: () => Number(/\bfp:(\d+)/.exec(module.UTF8ToString(module._GetPpcWasmHelperStats()))?.[1] ?? NaN),
    // Region modules (P4): pc, npc and downcount offsets in PowerPCState, version.
    stateLayout() {
      const ptr = module._malloc(16);
      try {
        module._DolphinWeb_JitStateLayout(ptr);
        return Array.from(new Uint32Array(module.HEAPU8.buffer, ptr, 4));
      } finally {
        module._free(ptr);
      }
    },
    // Executed-block export (docs/aot-plan.md): {start, length, flags} triplets.
    dumpBlocks() {
      const count = module._DolphinWeb_JitDumpBlocksNowForTest();
      if (count < 0) return null;
      const words = new Uint32Array(module.HEAPU8.buffer, module._DolphinWeb_JitDumpBlocksBuffer() >>> 0, count * 3);
      return Array.from({ length: count }, (_, i) => ({ start: words[3 * i], length: words[3 * i + 1], flags: words[3 * i + 2] }));
    },
    run(program, state, mask = PRODUCTION_DISABLE_MASK) {
      if (program.length > MAX_WORDS) throw new Error("program too long");
      const v = view();
      v.set(program, 0);
      v.set(state, MAX_WORDS);
      const code = module._DolphinWeb_JitOracleRun(program.length, mask >>> 0);
      const w = view();
      return {
        code,
        message: module.UTF8ToString(module._DolphinWeb_JitOracleMessage()),
        interp: Uint32Array.from(w.subarray(MAX_WORDS + STATE_WORDS, MAX_WORDS + 2 * STATE_WORDS)),
        jit: Uint32Array.from(w.subarray(MAX_WORDS + 2 * STATE_WORDS, MAX_WORDS + 3 * STATE_WORDS)),
        compiledBlocks: w[MAX_WORDS + 3 * STATE_WORDS],
        compiledOps: w[MAX_WORDS + 3 * STATE_WORDS + 1]
      };
    }
  };
}

// xorshift32, same as the cpufuzz homebrew.
export function makeRng(seed) {
  let s = seed >>> 0 || 1;
  const next = () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s;
  };
  const below = (n) => next() % n;
  return { next, below, pick: (a) => a[below(a.length)], chance: (p) => next() / 2 ** 32 < p };
}

// ---- encoders --------------------------------------------------------------
const u = (v) => v >>> 0;
const D = (op, rt, ra, imm) => u((op << 26) | (rt << 21) | (ra << 16) | (imm & 0xffff));
const X = (op, rt, ra, rb, xo, rc = 0) => u((op << 26) | (rt << 21) | (ra << 16) | (rb << 11) | (xo << 1) | rc);
const XO = (rt, ra, rb, oe, xo, rc) => u((31 << 26) | (rt << 21) | (ra << 16) | (rb << 11) | (oe << 10) | (xo << 1) | rc);
const A = (op, t, a, b, c, xo, rc = 0) => u((op << 26) | (t << 21) | (a << 16) | (b << 11) | (c << 6) | (xo << 1) | rc);
const M = (op, rs, ra, sh, mb, me, rc) => u((op << 26) | (rs << 21) | (ra << 16) | (sh << 11) | (mb << 6) | (me << 1) | rc);
const SPR = (n) => ((n & 0x1f) << 5) | (n >> 5);
const PSQ = (op, t, a, w, i, d) => u((op << 26) | (t << 21) | (a << 16) | (w << 15) | (i << 12) | (d & 0xfff));
const PSQX = (t, a, b, w, i, xo) => u((4 << 26) | (t << 21) | (a << 16) | (b << 11) | (w << 10) | (i << 7) | (xo << 1));

// Destination GPRs: r0, r3..r27, r29 and r31 (r1/r2 are the scratch base and
// index, r28 a base no BAT maps, r30 the base of update forms).
// Half of the picks come from r3..r6, so sources and destinations alias and
// instructions depend on each other far more often than with uniform picks.
const dst = (r) => {
  if (r.below(2)) return 3 + r.below(4);
  const v = r.below(28);
  return v === 0 ? 0 : v === 26 ? 29 : v === 27 ? 31 : v + 2;
};
const X_STORES = new Set([215, 407, 151, 918, 662]);
const src = (r) => (r.below(2) ? 3 + r.below(4) : r.below(32));
const fpr = (r) => (r.below(2) ? 1 + r.below(4) : r.below(32));
const crf = (r) => r.below(8);
const disp = (r, size) => (r.below(Math.floor(128 / size)) * size) - 64; // 8-aligned within scratch
const udisp = (r) => (r.below(5) - 2) * 8; // update forms drift slowly and keep r30 8-aligned

// Each entry: [name, (rng) => word]. The name is the instruction class.
export const CATALOG = [
  // integer arithmetic (OE and Rc variants)
  ...[[266, "add"], [40, "subf"], [10, "addc"], [8, "subfc"], [138, "adde"], [136, "subfe"],
    [235, "mullw"], [491, "divw"], [459, "divwu"]].map(([xo, n]) =>
    [n, (r) => XO(dst(r), src(r), src(r), r.below(2), xo, r.below(2))]),
  ...[[75, "mulhw"], [11, "mulhwu"]].map(([xo, n]) => [n, (r) => XO(dst(r), src(r), src(r), 0, xo, r.below(2))]),
  ...[[202, "addze"], [234, "addme"], [200, "subfze"], [232, "subfme"], [104, "neg"]].map(([xo, n]) =>
    [n, (r) => XO(dst(r), src(r), 0, r.below(2), xo, r.below(2))]),
  ...[[14, "addi"], [15, "addis"], [12, "addic"], [13, "addic."], [8, "subfic"], [7, "mulli"]].map(([op, n]) =>
    [n, (r) => D(op, dst(r), src(r), r.next())]),
  ...[[24, "ori"], [25, "oris"], [26, "xori"], [27, "xoris"], [28, "andi."], [29, "andis."]].map(([op, n]) =>
    [n, (r) => D(op, src(r) /* rs */, dst(r), r.next())]),
  ...[[28, "and"], [60, "andc"], [444, "or"], [412, "orc"], [316, "xor"], [476, "nand"], [124, "nor"],
    [284, "eqv"], [24, "slw"], [536, "srw"], [792, "sraw"]].map(([xo, n]) =>
    [n, (r) => X(31, src(r), dst(r), src(r), xo, r.below(2))]),
  ["srawi", (r) => X(31, src(r), dst(r), r.below(32), 824, r.below(2))],
  ...[[26, "cntlzw"], [954, "extsb"], [922, "extsh"]].map(([xo, n]) => [n, (r) => X(31, src(r), dst(r), 0, xo, r.below(2))]),
  ["rlwinm", (r) => M(21, src(r), dst(r), r.below(32), r.below(32), r.below(32), r.below(2))],
  ["rlwimi", (r) => M(20, src(r), dst(r), r.below(32), r.below(32), r.below(32), r.below(2))],
  ["rlwnm", (r) => M(23, src(r), dst(r), src(r), r.below(32), r.below(32), r.below(2))],
  // compares and condition register
  ["cmp", (r) => X(31, crf(r) << 2, src(r), src(r), 0)],
  ["cmpl", (r) => X(31, crf(r) << 2, src(r), src(r), 32)],
  ["cmpi", (r) => D(11, crf(r) << 2, src(r), r.next())],
  ["cmpli", (r) => D(10, crf(r) << 2, src(r), r.next())],
  ...[[257, "crand"], [449, "cror"], [193, "crxor"], [225, "crnand"], [33, "crnor"], [289, "creqv"],
    [129, "crandc"], [417, "crorc"]].map(([xo, n]) => [n, (r) => X(19, r.below(32), r.below(32), r.below(32), xo)]),
  ["mcrf", (r) => X(19, crf(r) << 2, crf(r) << 2, 0, 0)],
  ["mcrxr", (r) => X(31, crf(r) << 2, 0, 0, 512)],
  ["mfcr", (r) => X(31, dst(r), 0, 0, 19)],
  ["mtcrf", (r) => u((31 << 26) | (src(r) << 21) | (r.below(256) << 12) | (144 << 1))],
  ["mfxer", (r) => X(31, dst(r), 0, 0, 0) | (SPR(1) << 11) | (339 << 1)],
  ["mtxer", (r) => X(31, src(r), 0, 0, 0) | (SPR(1) << 11) | (467 << 1)],
  ["mfctr", (r) => X(31, dst(r), 0, 0, 0) | (SPR(9) << 11) | (339 << 1)],
  ["mtctr", (r) => X(31, src(r), 0, 0, 0) | (SPR(9) << 11) | (467 << 1)],
  ["mflr", (r) => X(31, dst(r), 0, 0, 0) | (SPR(8) << 11) | (339 << 1)],
  ["mfgqr", (r) => X(31, dst(r), 0, 0, 0) | (SPR(912 + r.below(8)) << 11) | (339 << 1)],
  ["mtgqr", (r) => X(31, src(r), 0, 0, 0) | (SPR(912 + r.below(8)) << 11) | (467 << 1)],
  // integer memory (r1 = scratch middle, r2 = small index)
  ...[[34, "lbz", 1], [40, "lhz", 2], [42, "lha", 2], [32, "lwz", 4], [38, "stb", 1], [44, "sth", 2], [36, "stw", 4]]
    .map(([op, n, s]) => [n, (r) => D(op, n.startsWith("st") ? src(r) : dst(r), 1, disp(r, s))]),
  ...[[35, "lbzu", 1], [41, "lhzu", 2], [43, "lhau", 2], [33, "lwzu", 4], [39, "stbu", 1], [45, "sthu", 2], [37, "stwu", 4]]
    .map(([op, n, s]) => [n, (r) => D(op, n.startsWith("st") ? src(r) : updDst(r), 30, udisp(r, s))]),
  ...[[87, "lbzx"], [279, "lhzx"], [343, "lhax"], [23, "lwzx"], [215, "stbx"], [407, "sthx"], [151, "stwx"],
    [790, "lhbrx"], [534, "lwbrx"], [918, "sthbrx"], [662, "stwbrx"]].map(([xo, n]) =>
    [n, (r) => X(31, X_STORES.has(xo) ? src(r) : dst(r), 1, 2, xo)]),
  // X-form update forms: base r30, index r2 (8-aligned, small)
  ...[[119, "lbzux"], [311, "lhzux"], [375, "lhaux"], [55, "lwzux"], [247, "stbux"], [439, "sthux"], [183, "stwux"]]
    .map(([xo, n]) => [n, (r) => X(31, n.startsWith("st") ? src(r) : updDst(r), 30, 2, xo)]),
  ...[[567, "lfsux"], [631, "lfdux"], [695, "stfsux"], [759, "stfdux"]].map(([xo, n]) =>
    [n, (r) => X(31, fpr(r), 30, 2, xo)]),
  ["lswi", (r) => X(31, 26, 1, 1 + r.below(8), 597)], // fills at most r26..r27
  ["stswi", (r) => X(31, src(r), 1, 1 + r.below(16), 725)],
  ["lmw", (r) => D(46, 31, 1, disp(r, 4))],
  ["stmw", (r) => D(47, 20 + r.below(12), 1, -64)],
  ["dcbz", (r) => X(31, 0, 1, 2, 1014)],
  // Addresses no BAT maps (r28) and a misaligned lmw. Without MMU emulation
  // the core does not vector these; both sides must still agree (MMU helper
  // path, no direct RAM access).
  ...[[32, "lwz-unmapped"], [36, "stw-unmapped"], [48, "lfs-unmapped"], [52, "stfs-unmapped"], [34, "lbz-unmapped"]].map(([op, n]) =>
    [n, (r) => D(op, n.startsWith("st") ? src(r) : dst(r), 28, r.below(8) * 4)]),
  ["lmw-misaligned", (r) => D(46, 31, 1, 2)],
  ["dcbst", (r) => X(31, 0, 1, 2, 54)],
  ["dcbf", (r) => X(31, 0, 1, 2, 86)],
  ["sync", () => X(31, 0, 0, 0, 598)],
  ["eieio", () => X(31, 0, 0, 0, 854)],
  ["isync", () => X(19, 0, 0, 0, 150)],
  ["mfmsr", (r) => X(31, dst(r), 0, 0, 83)],
  ["mfsprg", (r) => X(31, dst(r), 0, 0, 0) | (SPR(272 + r.below(4)) << 11) | (339 << 1)],
  ["mtsprg", (r) => X(31, src(r), 0, 0, 0) | (SPR(272 + r.below(4)) << 11) | (467 << 1)],
  // floating point memory
  ...[[48, "lfs", 4], [50, "lfd", 8], [52, "stfs", 4], [54, "stfd", 8]].map(([op, n, s]) =>
    [n, (r) => D(op, fpr(r), 1, disp(r, s))]),
  ...[[49, "lfsu", 4], [51, "lfdu", 8], [53, "stfsu", 4], [55, "stfdu", 8]].map(([op, n, s]) =>
    [n, (r) => D(op, fpr(r), 30, udisp(r, s))]),
  ...[[535, "lfsx"], [599, "lfdx"], [663, "stfsx"], [727, "stfdx"], [983, "stfiwx"]].map(([xo, n]) =>
    [n, (r) => X(31, fpr(r), 1, 2, xo)]),
  // floating point arithmetic, double (63) and single (59)
  ...[59, 63].flatMap((op) => [
    ...[[21, "fadd"], [20, "fsub"], [18, "fdiv"]].map(([xo, n]) =>
      [`${n}${op === 59 ? "s" : ""}`, (r) => A(op, fpr(r), fpr(r), fpr(r), 0, xo, r.below(2))]),
    [`fmul${op === 59 ? "s" : ""}`, (r) => A(op, fpr(r), fpr(r), 0, fpr(r), 25, r.below(2))],
    ...[[29, "fmadd"], [28, "fmsub"], [31, "fnmadd"], [30, "fnmsub"]].map(([xo, n]) =>
      [`${n}${op === 59 ? "s" : ""}`, (r) => A(op, fpr(r), fpr(r), fpr(r), fpr(r), xo, r.below(2))])
  ]),
  ["fres", (r) => A(59, fpr(r), 0, fpr(r), 0, 24, r.below(2))],
  ["frsqrte", (r) => A(63, fpr(r), 0, fpr(r), 0, 26, r.below(2))],
  ["fsel", (r) => A(63, fpr(r), fpr(r), fpr(r), fpr(r), 23, r.below(2))],
  ...[[12, "frsp"], [14, "fctiw"], [15, "fctiwz"], [40, "fneg"], [72, "fmr"], [136, "fnabs"], [264, "fabs"]]
    .map(([xo, n]) => [n, (r) => X(63, fpr(r), 0, fpr(r), xo, r.below(2))]),
  ["fcmpu", (r) => X(63, crf(r) << 2, fpr(r), fpr(r), 0)],
  ["fcmpo", (r) => X(63, crf(r) << 2, fpr(r), fpr(r), 32)],
  ["mffs", (r) => X(63, fpr(r), 0, 0, 583, r.below(2))],
  ["mtfsf", (r) => u((63 << 26) | (r.below(256) << 17) | (fpr(r) << 11) | (711 << 1) | r.below(2))],
  ["mtfsfi", (r) => u((63 << 26) | (crf(r) << 23) | (r.below(16) << 12) | (134 << 1) | r.below(2))],
  ["mtfsb0", (r) => X(63, r.below(32), 0, 0, 70, r.below(2))],
  ["mtfsb1", (r) => X(63, r.below(32), 0, 0, 38, r.below(2))],
  ["mcrfs", (r) => X(63, crf(r) << 2, crf(r) << 2, 0, 64)],
  // paired singles
  ...[[21, "ps_add"], [20, "ps_sub"], [18, "ps_div"]].map(([xo, n]) =>
    [n, (r) => A(4, fpr(r), fpr(r), fpr(r), 0, xo, r.below(2))]),
  ...[[25, "ps_mul"], [12, "ps_muls0"], [13, "ps_muls1"]].map(([xo, n]) =>
    [n, (r) => A(4, fpr(r), fpr(r), 0, fpr(r), xo, r.below(2))]),
  ...[[29, "ps_madd"], [28, "ps_msub"], [31, "ps_nmadd"], [30, "ps_nmsub"], [14, "ps_madds0"], [15, "ps_madds1"],
    [10, "ps_sum0"], [11, "ps_sum1"], [23, "ps_sel"]].map(([xo, n]) =>
    [n, (r) => A(4, fpr(r), fpr(r), fpr(r), fpr(r), xo, r.below(2))]),
  ["ps_res", (r) => A(4, fpr(r), 0, fpr(r), 0, 24, r.below(2))],
  ["ps_rsqrte", (r) => A(4, fpr(r), 0, fpr(r), 0, 26, r.below(2))],
  ...[[40, "ps_neg"], [72, "ps_mr"], [136, "ps_nabs"], [264, "ps_abs"]].map(([xo, n]) =>
    [n, (r) => X(4, fpr(r), 0, fpr(r), xo, r.below(2))]),
  ...[[528, "ps_merge00"], [560, "ps_merge01"], [592, "ps_merge10"], [624, "ps_merge11"]].map(([xo, n]) =>
    [n, (r) => X(4, fpr(r), fpr(r), fpr(r), xo, r.below(2))]),
  ...[[0, "ps_cmpu0"], [32, "ps_cmpo0"], [64, "ps_cmpu1"], [96, "ps_cmpo1"]].map(([xo, n]) =>
    [n, (r) => X(4, crf(r) << 2, fpr(r), fpr(r), xo)]),
  ["psq_l", (r) => PSQ(56, fpr(r), 1, r.below(2), r.below(8), disp(r, 8))],
  ["psq_lu", (r) => PSQ(57, fpr(r), 30, r.below(2), r.below(8), udisp(r, 8))],
  ["psq_st", (r) => PSQ(60, fpr(r), 1, r.below(2), r.below(8), disp(r, 8))],
  ["psq_stu", (r) => PSQ(61, fpr(r), 30, r.below(2), r.below(8), udisp(r, 8))],
  ["psq_lx", (r) => PSQX(fpr(r), 1, 2, r.below(2), r.below(8), 6)],
  ["psq_stx", (r) => PSQX(fpr(r), 1, 2, r.below(2), r.below(8), 7)],
  ["psq_lux", (r) => PSQX(fpr(r), 30, 2, r.below(2), r.below(8), 38)],
  ["psq_stux", (r) => PSQX(fpr(r), 30, 2, r.below(2), r.below(8), 39)]
];

const updDst = dst; // never r30, the update base

const SPECIAL_U32 = [0, 1, 2, 0xffffffff, 0x80000000, 0x7fffffff, 0x8000, 0x7fff, 0xffff, 0xffff8000, 31, 32, 33, 0x80000001];

const F64 = (hi, lo = 0) => [lo >>> 0, hi >>> 0];
const SPECIAL_F64 = [
  F64(0), F64(0x80000000), F64(0x3ff00000), F64(0xbff00000), F64(0x7ff00000), F64(0xfff00000),
  F64(0x7ff80000), F64(0xfff80000, 1), F64(0x7ff40000), F64(0x7ff00000, 1), // QNaN, SNaN
  F64(0x00000000, 1), F64(0x000fffff, 0xffffffff), F64(0x80080000), // double denormals
  F64(0x36a00000), F64(0x38100000), F64(0x380fffff, 0xe0000000), F64(0xb7f00000), // single denormal / min normal
  F64(0x47efffff, 0xe0000000), F64(0x47efffff, 0xf0000000), F64(0x47f00000), // FLT_MAX and the rounding edge
  F64(0x3ff00000, 0x10000000), F64(0x3ff00000, 0x30000000), // ties at single precision
  F64(0x41dfffff, 0xffc00000), F64(0xc1e00000), F64(0x41e00000), // int32 limits for fctiw
  F64(0x3fe00000), F64(0x400921fb, 0x54442d18), F64(0x7fefffff, 0xffffffff), F64(0x00100000)
];

function randomF64(r) {
  switch (r.below(6)) {
    case 0: case 1: return r.pick(SPECIAL_F64);
    case 2: { const f = new Float64Array([(r.next() / 2 ** 16 - 32768) / (1 + r.below(1000))]); return Array.from(new Uint32Array(f.buffer)); }
    case 3: { // a single-precision value widened, as games mostly hold
      const f = new Float32Array([new Float32Array(new Uint32Array([r.next()]).buffer)[0]]);
      const d = new Float64Array([f[0]]);
      return Array.from(new Uint32Array(d.buffer));
    }
    default: return [r.next(), r.next()];
  }
}

export function randomState(r) {
  const s = new Uint32Array(STATE_WORDS);
  for (let i = 0; i < 32; i++) s[i] = r.chance(0.4) ? r.pick(SPECIAL_U32) : r.next();
  s[1] = SCRATCH + 0x80;
  s[2] = r.below(16) * 8;
  s[30] = SCRATCH + 0x80;
  // No BAT maps it and, without MMU emulation, nothing backs it: stores are
  // dropped and loads read 0. (0x4xxxxxxx and 0x7exxxxxx are backed by
  // memory the oracle does not reset between its two runs: not usable.)
  s[28] = 0x00100080;
  s[32] = r.next();
  s[33] = r.next() & 0xe000007f;
  s[34] = SENTINEL;
  s[35] = r.chance(0.5) ? r.below(8) : r.next();
  // RN, NI and the exception enables random; sticky bits random too.
  s[36] = r.next() & ~0x00000800; // bit 20 is reserved
  // FP, IR, DR, RI; one state in six also sets FE0/FE1 so an enabled FP
  // exception becomes a program exception.
  s[37] = r.chance(1 / 6) ? 0x00002932 : 0x00002032;
  s[240] = r.next(); // SRR0, SRR1, DAR, DSISR: overwritten by any exception
  s[241] = r.next() & 0x87c0ffff;
  s[242] = r.next();
  s[243] = r.next();
  for (let i = 0; i < 8; i++) {
    // GQR halves: float, the forms the JIT inlines (s16 load with scale 0,
    // u8 store with scale 61), or any valid type (0, 4-7) with any scale.
    const half = (load) => {
      switch (r.below(4)) {
        case 0: return 0;
        case 1: return load ? 7 : (61 << 8) | 4;
        default: return (r.below(64) << 8) | r.pick([0, 4, 5, 6, 7]);
      }
    };
    s[38 + i] = ((half(true) << 16) | half(false)) >>> 0;
  }
  for (let i = 0; i < 32; i++) {
    const a = randomF64(r);
    const b = r.chance(0.3) ? a : randomF64(r);
    s.set([a[0], a[1], b[0], b[1]], 48 + i * 4);
  }
  for (let i = 0; i < 64; i++) {
    if (r.chance(0.5)) { const d = randomF64(r); s[176 + i] = d[r.below(2)]; }
    else s[176 + i] = r.chance(0.3) ? r.pick(SPECIAL_U32) : r.next();
  }
  return s;
}

const CATALOG_BY_NAME = new Map(CATALOG.map(([n, g]) => [n, g]));
export const instructionNames = () => CATALOG.map(([n]) => n);
export const generate = (name, r) => CATALOG_BY_NAME.get(name)(r);

// A straight-line block of random instructions, optionally with a forward
// conditional skip and a CTR loop like the cpufuzz homebrew, then blr.
const FP_CHAIN = CATALOG.filter(([n]) =>
  /^(f(add|sub|mul|div|madd|msub|nmadd|nmsub)s?|frsp|fctiwz?|fcmp[uo]|mffs|fsel|fres|frsqrte|ps_(add|sub|mul|madd|msub|nmadd|nmsub|muls[01]|madds[01]|sum[01]|res|neg|mr|nabs|abs))$/.test(n));

// Not in programs: a random GQR value can select a reserved quantization
// type, which the hardware leaves undefined (the interpreter panics on it).
const PROGRAM_EXCLUDED = new Set(["mtgqr"]);

export function randomProgram(r, length = 24, { names = null } = {}) {
  const pool = CATALOG.filter(([n]) => (names ? names.includes(n) : !PROGRAM_EXCLUDED.has(n)));
  const one = () => r.pick(pool)[1](r);
  const words = [];
  while (words.length < length) {
    const k = r.below(10);
    if (k === 0 && length - words.length >= 4) {
      const skip = 1 + r.below(3);
      words.push(u((16 << 26) | (r.pick([4, 12]) << 21) | (r.below(32) << 16) | (((skip + 1) * 4) & 0xfffc)));
      for (let i = 0; i < skip; i++) words.push(one());
    } else if (k === 1 && length - words.length >= 7) {
      const body = 1 + r.below(3);
      words.push(D(14, 0, 0, 1 + r.below(4)), 0x7c0903a6); // li r0,n; mtctr r0
      const safe = pool.filter(([n]) => !/ctr|^l|^st|^psq|dcbz|mtxer/.test(n));
      for (let i = 0; i < body; i++) words.push(r.pick(safe)[1](r));
      words.push(u((16 << 26) | (16 << 21) | ((-(body * 4)) & 0xfffc))); // bdnz
    } else if (k === 2 && length - words.length >= 2) {
      words.push(u((18 << 26) | 8), one()); // b +8
    } else if (k === 3 && length - words.length >= 6) {
      // A run of floating-point arithmetic with no load, store or branch in
      // between: the only place one op's FPRF can be overwritten by the
      // next inside a block (and read back by mffs or a compare).
      const chain = 2 + r.below(4);
      for (let i = 0; i < chain; i++) words.push(r.pick(FP_CHAIN)[1](r));
    } else {
      words.push(one());
    }
  }
  words.push(BLR);
  return Uint32Array.from(words);
}

const FIELDS = [
  ...Array.from({ length: 32 }, (_, i) => [`r${i}`, i]),
  ["cr", 32], ["xer", 33], ["lr", 34], ["ctr", 35], ["fpscr", 36], ["msr", 37],
  ...Array.from({ length: 8 }, (_, i) => [`gqr${i}`, 38 + i]),
  ["exceptions", 46], ["pc", 47], ["srr0", 240], ["srr1", 241], ["dar", 242], ["dsisr", 243]
];

// FPSCR: the low byte is control (RN, NI, exception enables); the rest is
// status (FX, FEX, VX, sticky exception bits, FR, FI, FPRF).
export const FPSCR_STATUS_MASK = 0xffffff00;

// "values" when anything but FPSCR status differs, "fpscr-status" when only
// FPSCR status bits differ, null when identical.
export function classifyDifference(a, b) {
  let status = false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    if (i === 36 && ((a[i] ^ b[i]) & ~FPSCR_STATUS_MASK) === 0) { status = true; continue; }
    return "values";
  }
  return status ? "fpscr-status" : null;
}

export function describeDifference(a, b) {
  const out = [];
  for (const [n, i] of FIELDS) if (a[i] !== b[i]) out.push(`${n}: interp ${hex(a[i])} jit ${hex(b[i])}`);
  for (let f = 0; f < 32; f++) {
    for (let lane = 0; lane < 2; lane++) {
      const i = 48 + f * 4 + lane * 2;
      if (a[i] !== b[i] || a[i + 1] !== b[i + 1]) {
        out.push(`f${f}.ps${lane}: interp ${hex(a[i + 1])}${hex(a[i]).slice(2)} jit ${hex(b[i + 1])}${hex(b[i]).slice(2)}`);
      }
    }
  }
  for (let i = 176; i < 240; i++) {
    if (a[i] !== b[i]) out.push(`mem+${(i - 176) * 4}: interp ${hex(bswap(a[i]))} jit ${hex(bswap(b[i]))}`);
  }
  return out;
}

const bswap = (v) => (((v & 0xff) << 24) | ((v & 0xff00) << 8) | ((v >>> 8) & 0xff00) | (v >>> 24)) >>> 0;
export const hex = (v) => `0x${(v >>> 0).toString(16).padStart(8, "0")}`;

// a*c + b rounded once to nearest-even (to single precision when `single`,
// returned as the double of that single), from exact integer arithmetic, as
// [lo, hi] words; null when an operand is not finite or the result is
// subnormal or overflows.
export function exactFmaDouble(a, c, b, single = false) {
  const words = (x) => new BigUint64Array(new Float64Array([x]).buffer)[0];
  const parts = (x) => {
    const w = words(x);
    const field = Number((w >> 52n) & 0x7ffn);
    if (field === 0x7ff) return null;
    let m = w & ((1n << 52n) - 1n);
    if (field) m |= 1n << 52n;
    return [w >> 63n ? -m : m, (field || 1) - 1075];
  };
  const pa = parts(a), pc = parts(c), pb = parts(b);
  if (!pa || !pc || !pb) return null;
  const [mp, ep] = [pa[0] * pc[0], pa[1] + pc[1]];
  const e0 = Math.min(ep, pb[1]);
  const sum = (mp << BigInt(ep - e0)) + (pb[0] << BigInt(pb[1] - e0));
  if (sum === 0n) {
    // Exact zero: -0 only when both terms are zeros of negative sign (round
    // to nearest), else +0.
    const negP = (a < 0 || Object.is(a, -0)) !== (c < 0 || Object.is(c, -0));
    const negB = b < 0 || Object.is(b, -0);
    return [0, mp === 0n && pb[0] === 0n && negP && negB ? 0x80000000 : 0];
  }
  const sign = sum < 0n ? 1n : 0n;
  const mag = sum < 0n ? -sum : sum;
  const precision = single ? 24 : 53;
  let shift = mag.toString(2).length - precision;
  let q;
  if (shift > 0) {
    q = mag >> BigInt(shift);
    const rest = mag & ((1n << BigInt(shift)) - 1n), half = 1n << BigInt(shift - 1);
    if (rest > half || (rest === half && (q & 1n))) q += 1n;
    if (q === 1n << BigInt(precision)) { q >>= 1n; shift += 1; }
  } else {
    q = mag << BigInt(-shift);
  }
  const exponent = e0 + shift + precision - 1;
  if (single ? exponent < -126 || exponent > 127 : exponent < -1022 || exponent > 1023) return null;
  if (single) q <<= 29n;
  const w = (sign << 63n) | (BigInt(exponent + 1023) << 52n) | (q - (1n << 52n));
  return [Number(w & 0xffffffffn), Number(w >> 32n)];
}

// Gekko's rounding of frC for single-precision multiplies (Force25Bit).
export function force25Bit(x) {
  const w = new BigUint64Array(new Float64Array([x]).buffer)[0];
  const r = (w & 0xfffffffff8000000n) + (w & 0x8000000n);
  return new Float64Array(new BigUint64Array([r]).buffer)[0];
}
