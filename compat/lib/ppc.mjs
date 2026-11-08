// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later

// PowerPC encoders and oracle-state helpers for the ported hardware tests.
// A case is a short program (ending in blr) and an input state; the core's
// JIT oracle (tests/helpers/jit-oracle.mjs, patch 0071) runs it on the
// interpreter, then on the WASM JIT, and returns both final states. The
// ported checks read the value the hardware test reads and compare it to the
// value the Dolphin project measured on a console.
//
// State layout (248 words, JitOracleLoadState/SaveState): r0-r31, CR, XER,
// LR, CTR, FPSCR, MSR, GQR0-7, Exceptions, PC, then per FPR ps0 lo/hi and
// ps1 lo/hi (48 + 4i), then 256 bytes of scratch memory at 0x80100000, then
// SRR0, SRR1, DAR, DSISR.

const u = (v) => v >>> 0;
export const BLR = 0x4e800020;
export const SCRATCH = 0x80100000;
const SENTINEL = 0x80002000;
const STATE_WORDS = 248;
// FP, IR, DR, RI: what a libogc program runs with (no FE0/FE1).
const MSR = 0x00002032;

// ---- encoders (operand order as in assembly) --------------------------------
const D = (op, rt, ra, imm) => u((op << 26) | (rt << 21) | (ra << 16) | (imm & 0xffff));
const X = (op, rt, ra, rb, xo, rc = 0) => u((op << 26) | (rt << 21) | (ra << 16) | (rb << 11) | (xo << 1) | rc);
const A = (op, t, a, b, c, xo, rc = 0) => u((op << 26) | (t << 21) | (a << 16) | (b << 11) | (c << 6) | (xo << 1) | rc);
const M = (op, rs, ra, sh, mb, me, rc = 0) => u((op << 26) | (rs << 21) | (ra << 16) | (sh << 11) | (mb << 6) | (me << 1) | rc);
const sprField = (n) => ((n & 0x1f) << 5) | (n >> 5);

export const ppc = {
  li: (rd, imm) => D(14, rd, 0, imm),
  // Loads: D form (rd, displacement, ra) and X form (rd, ra, rb).
  ...Object.fromEntries([["lwz", 32], ["lwzu", 33], ["lbz", 34], ["lbzu", 35], ["lhz", 40], ["lhzu", 41],
    ["lha", 42], ["lhau", 43]].map(([n, op]) => [n, (rd, d, ra) => D(op, rd, ra, d)])),
  ...Object.fromEntries([["lwzx", 23], ["lwzux", 55], ["lbzx", 87], ["lbzux", 119], ["lhzx", 279],
    ["lhzux", 311], ["lhax", 343], ["lhaux", 375]].map(([n, xo]) => [n, (rd, ra, rb) => X(31, rd, ra, rb, xo)])),
  addi: (rd, ra, imm) => D(14, rd, ra, imm),
  cmpwi: (crf, ra, imm) => D(11, crf << 2, ra, imm),
  mtspr: (spr, rs) => X(31, rs, 0, 0, 467) | (sprField(spr) << 11),
  mfspr: (rd, spr) => X(31, rd, 0, 0, 339) | (sprField(spr) << 11),
  mfcr: (rd) => X(31, rd, 0, 0, 19),
  crset: (bx) => X(19, bx, bx, bx, 289),
  crclr: (bx) => X(19, bx, bx, bx, 193),
  addze: (rd, ra) => X(31, rd, ra, 0, 202),
  srawi: (ra, rs, sh) => X(31, rs, ra, sh, 824),
  rlwimi: (ra, rs, sh, mb, me) => M(20, rs, ra, sh, mb, me),
  rlwinm: (ra, rs, sh, mb, me) => M(21, rs, ra, sh, mb, me),
  rlwnm: (ra, rs, rb, mb, me) => M(23, rs, ra, rb, mb, me),
  isync: () => 0x4c00012c,
  lfd: (fd, d, ra) => D(50, fd, ra, d),
  // Paired singles; A-form operands in assembly order (frD, frA, frC, frB).
  ...Object.fromEntries([["ps_mr", 72], ["ps_neg", 40], ["ps_abs", 264], ["ps_nabs", 136]]
    .map(([n, xo]) => [n, (fd, fb) => X(4, fd, 0, fb, xo)])),
  ...Object.fromEntries([["ps_merge00", 528], ["ps_merge01", 560], ["ps_merge10", 592], ["ps_merge11", 624]]
    .map(([n, xo]) => [n, (fd, fa, fb) => X(4, fd, fa, fb, xo)])),
  ps_sel: (fd, fa, fc, fb) => A(4, fd, fa, fb, fc, 23),
  ps_sum0: (fd, fa, fc, fb) => A(4, fd, fa, fb, fc, 10),
  ps_sum1: (fd, fa, fc, fb) => A(4, fd, fa, fb, fc, 11),
  ps_add: (fd, fa, fb) => A(4, fd, fa, fb, 0, 21),
  ps_res: (fd, fb) => A(4, fd, 0, fb, 0, 24),
  ps_rsqrte: (fd, fb) => A(4, fd, 0, fb, 0, 26),
  fres: (fd, fb) => A(59, fd, 0, fb, 0, 24),
  frsqrte: (fd, fb) => A(63, fd, 0, fb, 0, 26),
  frsp: (fd, fb) => X(63, fd, 0, fb, 12),
  fctiw: (fd, fb) => X(63, fd, 0, fb, 14),
  fctiwz: (fd, fb) => X(63, fd, 0, fb, 15),
  fadd: (fd, fa, fb) => A(63, fd, fa, fb, 0, 21),
  fadds: (fd, fa, fb) => A(59, fd, fa, fb, 0, 21),
  fdiv: (fd, fa, fb) => A(63, fd, fa, fb, 0, 18),
  fmul: (fd, fa, fc) => A(63, fd, fa, 0, fc, 25),
  fmuls: (fd, fa, fc) => A(59, fd, fa, 0, fc, 25),
  fcmpu: (crf, fa, fb) => X(63, crf << 2, fa, fb, 0),
  fcmpo: (crf, fa, fb) => X(63, crf << 2, fa, fb, 32),
  mffs: (fd) => X(63, fd, 0, 0, 583),
  mtfsfi: (crf, imm) => X(63, crf << 2, 0, (imm & 0xf) << 1, 134)
};

// ---- values -------------------------------------------------------------------
const f64 = new Float64Array(1);
const u64of = new BigUint64Array(f64.buffer);
const f32 = new Float32Array(1);
const u32of = new Uint32Array(f32.buffer);
export const bitsOfDouble = (x) => { f64[0] = x; return u64of[0]; };
export const doubleOfBits = (b) => { u64of[0] = BigInt.asUintN(64, b); return f64[0]; };
export const bitsOfFloat = (x) => { f32[0] = x; return u32of[0]; };
export const floatOfBits = (b) => { u32of[0] = b; return f32[0]; };
// A single held in an FPR is its double widening.
export const doubleBitsOfFloatBits = (b) => bitsOfDouble(floatOfBits(b));
export const hex64 = (b) => `0x${BigInt.asUintN(64, b).toString(16).padStart(16, "0")}`;
export const hex32 = (v) => `0x${(v >>> 0).toString(16).padStart(8, "0")}`;

// ---- state ----------------------------------------------------------------------
/**
 * @param {{gpr?: Record<number, number>, fpr?: Record<number, bigint | [bigint, bigint]>,
 *   cr?: number, xer?: number, ctr?: number, fpscr?: number, gqr?: number[], mem?: ArrayLike<number>}} init
 *   FPR values are 64-bit patterns (ps0, or [ps0, ps1]; ps1 defaults to ps0).
 *   mem: guest bytes (big-endian order, as in RAM) at SCRATCH, up to 256.
 */
export function makeState(init = {}) {
  const s = new Uint32Array(STATE_WORDS);
  s[1] = SCRATCH + 0x80;
  for (const [r, v] of Object.entries(init.gpr ?? {})) s[Number(r)] = u(v);
  s[32] = u(init.cr ?? 0);
  s[33] = u(init.xer ?? 0);
  s[34] = SENTINEL;
  s[35] = u(init.ctr ?? 0);
  s[36] = u(init.fpscr ?? 0);
  s[37] = MSR;
  (init.gqr ?? []).forEach((v, i) => { s[38 + i] = u(v); });
  for (const [f, v] of Object.entries(init.fpr ?? {})) {
    const [a, b] = Array.isArray(v) ? v : [v, v];
    const w = 48 + Number(f) * 4;
    s[w] = Number(a & 0xffffffffn); s[w + 1] = Number(a >> 32n);
    s[w + 2] = Number(b & 0xffffffffn); s[w + 3] = Number(b >> 32n);
  }
  // The core copies these words to RAM with a host (little-endian) memcpy.
  const mem = init.mem ?? [];
  if (mem.length > 256) throw new Error("scratch memory is 256 bytes");
  for (let i = 0; i < mem.length; i++) s[176 + (i >> 2)] |= (mem[i] & 0xff) << (8 * (i & 3));
  return s;
}

export const read = {
  gpr: (s, r) => s[r] >>> 0,
  cr: (s) => s[32] >>> 0,
  xer: (s) => s[33] >>> 0,
  fpscr: (s) => s[36] >>> 0,
  gqr: (s, i) => s[38 + i] >>> 0,
  mem8: (s, i) => (s[176 + (i >> 2)] >>> (8 * (i & 3))) & 0xff,
  ps0: (s, f) => (BigInt(s[48 + f * 4 + 1]) << 32n) | BigInt(s[48 + f * 4]),
  ps1: (s, f) => (BigInt(s[48 + f * 4 + 3]) << 32n) | BigInt(s[48 + f * 4 + 2])
};

// FPSCR[NI] and FPSCR[RN] from the hwtests' "mtfsf 7, NI<<2 | RN" (which
// also sets XE, bit 28, when the low nibble has bit 3 set: never here).
export const fpscrNiRn = (niRn) => niRn & 0x7;
