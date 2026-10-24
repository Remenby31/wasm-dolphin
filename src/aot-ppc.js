// Gekko (PowerPC 750CL) instruction classification for ahead-of-time code
// discovery. This decoder only answers what discovery needs: is the word a
// valid Gekko instruction, does it end a block, where can control go next,
// and the few register effects used to resolve jump tables and constant
// branch targets. It never executes anything.

const PRIMARY_VALID = new Set([
  3, 4, 7, 8, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 23, 24, 25, 26, 27, 28, 29, 31,
  32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55,
  56, 57, 59, 60, 61, 63
]);

const OP19 = new Set([0, 16, 33, 50, 129, 150, 193, 225, 257, 289, 417, 449, 528]);

const OP31 = new Set([
  0, 4, 19, 20, 23, 24, 26, 28, 32, 54, 55, 60, 83, 86, 87, 119, 124, 144, 146, 150, 151, 183,
  210, 215, 242, 246, 247, 278, 279, 284, 306, 310, 311, 316, 339, 343, 371, 375, 407, 412,
  438, 439, 444, 467, 470, 476, 512, 533, 534, 535, 536, 566, 567, 595, 597, 598, 599, 631,
  659, 661, 662, 663, 695, 725, 727, 759, 790, 792, 824, 854, 918, 922, 954, 982, 983, 1014
]);
// XO-form arithmetic: 9-bit extended opcode, bit 21 is OE.
const OP31_XO = new Set([8, 10, 11, 40, 75, 104, 136, 138, 200, 202, 232, 234, 235, 266, 459, 491]);

const OP59_A = new Set([18, 20, 21, 24, 25, 28, 29, 30, 31]);
const OP63_A = new Set([18, 20, 21, 23, 25, 26, 28, 29, 30, 31]);
const OP63_X = new Set([0, 12, 14, 15, 32, 38, 40, 64, 70, 72, 134, 136, 264, 583, 711]);

const OP4_X = new Set([0, 32, 40, 64, 72, 96, 136, 264, 528, 560, 592, 624, 1014]);
const OP4_XW = new Set([6, 7, 38, 39]);
const OP4_A = new Set([10, 11, 12, 13, 14, 15, 18, 20, 21, 23, 24, 25, 26, 28, 29, 30, 31]);

export const opcd = (w) => w >>> 26;
export const rD = (w) => (w >>> 21) & 31;
export const rA = (w) => (w >>> 16) & 31;
export const rB = (w) => (w >>> 11) & 31;
export const simm = (w) => (w << 16) >> 16;
export const uimm = (w) => w & 0xffff;
const xo10 = (w) => (w >>> 1) & 0x3ff;

export function isValidInstruction(w) {
  const op = w >>> 26;
  if (!PRIMARY_VALID.has(op)) return false;
  switch (op) {
    case 19: return OP19.has(xo10(w));
    case 31: {
      const x = xo10(w);
      return OP31.has(x) || OP31_XO.has(x & 0x1ff);
    }
    case 59: return OP59_A.has((w >>> 1) & 31);
    case 63: {
      const x5 = (w >>> 1) & 31;
      return x5 >= 16 ? OP63_A.has(x5) : OP63_X.has(xo10(w));
    }
    case 4: {
      if (OP4_X.has(xo10(w))) return true;
      if (OP4_XW.has((w >>> 1) & 63)) return true;
      return OP4_A.has((w >>> 1) & 31);
    }
    default: return true;
  }
}

// Control-flow kinds. A block ends after any of them.
export const FLOW_NONE = 0;
export const FLOW_BRANCH = 1; // b, bc: direct target
export const FLOW_RETURN = 2; // bclr (blr and its conditional forms)
export const FLOW_INDIRECT = 3; // bcctr
export const FLOW_SYSCALL = 4; // sc: continues at the next instruction
export const FLOW_RFI = 5; // rfi: never falls through
export const FLOW_TRAP = 6; // tw/twi: unconditional only when TO=31

// Branch condition is "always" when BO = 1z1zz.
const alwaysBO = (bo) => (bo & 0x14) === 0x14;

// Describe the control flow of the instruction `w` at `pc`.
// Returns { kind, target, link, conditional } or null for ordinary instructions.
export function decodeFlow(w, pc) {
  const op = w >>> 26;
  if (op === 18) {
    let li = w & 0x03fffffc;
    if (li & 0x02000000) li -= 0x04000000;
    const target = (w & 2 ? li : pc + li) >>> 0;
    return { kind: FLOW_BRANCH, target, link: (w & 1) === 1, conditional: false };
  }
  if (op === 16) {
    const bo = rD(w);
    const bd = simm(w & 0xfffc);
    const target = (w & 2 ? bd : pc + bd) >>> 0;
    return { kind: FLOW_BRANCH, target, link: (w & 1) === 1, conditional: !alwaysBO(bo) };
  }
  if (op === 19) {
    const x = xo10(w);
    if (x === 16) return { kind: FLOW_RETURN, target: null, link: (w & 1) === 1, conditional: !alwaysBO(rD(w)) };
    if (x === 528) return { kind: FLOW_INDIRECT, target: null, link: (w & 1) === 1, conditional: !alwaysBO(rD(w)) };
    if (x === 50) return { kind: FLOW_RFI, target: null, link: false, conditional: false };
    return null;
  }
  if (op === 17) return { kind: FLOW_SYSCALL, target: null, link: false, conditional: false };
  if (op === 3) return { kind: FLOW_TRAP, target: null, link: false, conditional: rD(w) !== 31 };
  if (op === 31 && xo10(w) === 4) return { kind: FLOW_TRAP, target: null, link: false, conditional: rD(w) !== 31 };
  return null;
}

// Does execution continue at pc+4 after this flow instruction?
export function fallsThrough(flow) {
  if (!flow) return true;
  if (flow.link) return true; // bl/bcl/blrl/bctrl: the call returns here
  if (flow.kind === FLOW_SYSCALL) return true;
  if (flow.kind === FLOW_RFI) return false;
  return flow.conditional;
}

// ---- Register effects used by the backward slices ----

// mtspr/mfspr encode the SPR number with its two halves swapped.
const sprOf = (w) => ((w >>> 16) & 31) | (((w >>> 11) & 31) << 5);
export const SPR_LR = 8;
export const SPR_CTR = 9;

export function isMtspr(w, spr) {
  return (w >>> 26) === 31 && xo10(w) === 467 && sprOf(w) === spr;
}

// Could the instruction write GPR `r`? Conservative: true unless the
// instruction is known not to write a GPR (stores without update, compares,
// branches, cache and system ops) or names other registers. A slice that
// meets a possible write it does not model gives up, it never guesses.
const NO_GPR_WRITE_OP = new Set([3, 10, 11, 16, 17, 18, 19, 36, 38, 44, 47, 48, 50, 52, 54, 56, 60]);
const NO_GPR_WRITE_31 = new Set([0, 4, 32, 54, 86, 144, 146, 150, 151, 210, 215, 242, 246, 278, 306,
  407, 438, 467, 470, 512, 566, 598, 661, 662, 663, 725, 727, 854, 918, 982, 983, 1014]);

const WRITES_RD_OP = new Set([7, 8, 12, 13, 14, 15, 32, 34, 40, 42]);
const WRITES_RD_RA_OP = new Set([33, 35, 41, 43]); // update loads
const WRITES_RA_OP = new Set([20, 21, 23, 24, 25, 26, 27, 28, 29, 37, 39, 45, 49, 51, 53, 55, 57, 61]);
const WRITES_RD_RA_31 = new Set([55, 119, 311, 375]);
const WRITES_RA_31 = new Set([24, 26, 28, 60, 124, 183, 247, 284, 316, 412, 439, 444, 476, 536, 567,
  631, 695, 759, 792, 824, 922, 954]);

export function mayWriteGpr(w, r) {
  const op = w >>> 26;
  if (op === 46) return r >= rD(w); // lmw
  if (NO_GPR_WRITE_OP.has(op)) return false;
  if (WRITES_RD_OP.has(op)) return rD(w) === r;
  if (WRITES_RD_RA_OP.has(op)) return rD(w) === r || rA(w) === r;
  if (WRITES_RA_OP.has(op)) return rA(w) === r;
  if (op === 59 || op === 63) return false;
  if (op === 4) return OP4_XW.has((w >>> 1) & 63) && ((w >>> 1) & 32) !== 0 && rA(w) === r; // psq_lux/stux
  if (op === 31) {
    const x = xo10(w);
    if (x === 533 || x === 597) return true; // lswx/lswi: many registers
    if (NO_GPR_WRITE_31.has(x)) return false;
    if (WRITES_RD_RA_31.has(x)) return rD(w) === r || rA(w) === r;
    if (WRITES_RA_31.has(x)) return rA(w) === r;
    return rD(w) === r;
  }
  return rD(w) === r || rA(w) === r;
}

// Constant-materialisation steps understood by the slices.
// Returns { dst, src, op, imm } or null.
export function constStep(w) {
  const op = w >>> 26;
  if (op === 15) return { dst: rD(w), src: rA(w), op: "addis", imm: simm(w) };
  if (op === 14) return { dst: rD(w), src: rA(w), op: "addi", imm: simm(w) };
  if (op === 24) return { dst: rA(w), src: rD(w), op: "ori", imm: uimm(w) };
  if (op === 25) return { dst: rA(w), src: rD(w), op: "oris", imm: uimm(w) };
  if (op === 31 && xo10(w) === 444 && rD(w) === rB(w)) return { dst: rA(w), src: rD(w), op: "mr", imm: 0 };
  return null;
}

// lwzx rD, rA, rB
export function isLwzx(w) {
  return (w >>> 26) === 31 && xo10(w) === 23;
}

// add rD, rA, rB (no OE)
export function isAdd(w) {
  return (w >>> 26) === 31 && (xo10(w) & 0x1ff) === 266;
}

// rlwinm rA, rS, SH, MB, ME used as slwi rA, rS, 2 (SH=2, MB=0, ME=29)
export function slwi2Source(w) {
  if ((w >>> 26) !== 21) return -1;
  const sh = (w >>> 11) & 31, mb = (w >>> 6) & 31, me = (w >>> 1) & 31;
  return sh === 2 && mb === 0 && me === 29 ? rD(w) : -1;
}

// A word index scaled to a byte offset by rlwinm rA, rS, 2, MB, 29: slwi 2
// (MB 0), or the same with a mask (MB > 0: `x & (2^k - 1)` scaled, the
// switch of a table with no compare). -> { src, entries } where entries is
// the number of offsets the mask allows (2^(30 - MB)), null without a mask.
export function scaledWordIndex(w) {
  if ((w >>> 26) !== 21) return null;
  const sh = (w >>> 11) & 31, mb = (w >>> 6) & 31, me = (w >>> 1) & 31;
  if (sh !== 2 || me !== 29) return null;
  return { src: rD(w), entries: mb === 0 ? null : 2 ** (30 - mb) };
}

// A register masked to its low bits: andi. rA, rS, 2^k - 1, or clrlwi
// (rlwinm rA, rS, 0, MB, 31) -> the number of values it can take, else null.
export function maskedValues(w) {
  const op = w >>> 26;
  if (op === 28) {
    const imm = w & 0xffff;
    return imm > 0 && (imm & (imm + 1)) === 0 ? imm + 1 : null;
  }
  if (op === 21) {
    const sh = (w >>> 11) & 31, mb = (w >>> 6) & 31, me = (w >>> 1) & 31;
    return sh === 0 && me === 31 && mb > 0 ? 2 ** (32 - mb) : null;
  }
  return null;
}

// cmplwi crf, rA, UIMM  -> { crf, reg, imm }
export function cmplwi(w) {
  if ((w >>> 26) !== 10) return null;
  return { crf: (w >>> 23) & 7, reg: rA(w), imm: uimm(w) };
}

// bc decoded as a condition on a CR field bit: { crf, bit, ifTrue }
export function bcCondition(w) {
  if ((w >>> 26) !== 16) return null;
  const bo = rD(w), bi = rA(w);
  if (alwaysBO(bo) || (bo & 0x04) === 0) return null; // unconditional or CTR-decrementing
  return { crf: bi >> 2, bit: bi & 3, ifTrue: (bo & 0x08) !== 0 };
}
