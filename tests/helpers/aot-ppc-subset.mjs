// A stand-in for the core while its region translator (0075) and the region
// mode of the oracle do not exist yet: a PowerPC subset (addi, addis, ori,
// add, mflr, mtlr, b, bl, blr, nop), a reference interpreter for it, and a translator that
// turns a plan function into a fragment with the contract of
// src/aot-region-module.js. The equivalence driver takes both as parameters,
// so the core's _DolphinWeb_AotTranslateForTest and its oracle replace them.
//
// State in linear memory (offsets from the state pointer): pc +0, lr +4,
// GPR r at +16 + 4r.
import { paddedUleb } from "../../src/aot-region-module.js";

export const LAYOUT = { pc: 0, lr: 4, gpr: 16 };
export const STATE_BYTES = 16 + 32 * 4;

const sext16 = (v) => (v << 16) >> 16;

// Decoded instruction, or null outside the subset.
export function decode(word, pc) {
  const op = word >>> 26;
  const d = (word >>> 21) & 31, a = (word >>> 16) & 31, b = (word >>> 11) & 31;
  if (op === 14) return { kind: "addi", d, a, imm: sext16(word & 0xffff) };
  if (op === 15) return { kind: "addi", d, a, imm: (word & 0xffff) << 16 };
  if (op === 24) return { kind: "ori", a, s: d, imm: word & 0xffff };
  if (op === 31 && ((word >>> 1) & 0x3ff) === 266 && !(word & 1)) return { kind: "add", d, a, b };
  // mfspr/mtspr with spr 8 (LR): the spr field is split, LR is 8 << 16
  if (op === 31 && ((word >>> 11) & 0x3ff) === 8 << 5 && ((word >>> 1) & 0x3ff) === 339) return { kind: "mflr", d };
  if (op === 31 && ((word >>> 11) & 0x3ff) === 8 << 5 && ((word >>> 1) & 0x3ff) === 467) return { kind: "mtlr", s: d };
  if (op === 18 && !(word & 2)) {
    const target = (pc + ((word & 0x03fffffc) << 6 >> 6)) >>> 0;
    return { kind: word & 1 ? "bl" : "b", target };
  }
  if (word === 0x4e800020) return { kind: "blr" };
  return null;
}

// Reference: steps from state.pc until pc === stopPc. `st` gives and takes
// pc, lr and gpr(r).
export function interpretStep(st, read32) {
  const pc = st.pc;
  const ins = decode(read32(pc), pc);
  if (!ins) throw new Error(`interpreter: unsupported instruction at ${pc.toString(16)}`);
  let next = (pc + 4) >>> 0;
  switch (ins.kind) {
    case "addi": st.setGpr(ins.d, ((ins.a ? st.gpr(ins.a) : 0) + ins.imm) | 0); break;
    case "ori": st.setGpr(ins.a, (st.gpr(ins.s) | ins.imm) | 0); break;
    case "add": st.setGpr(ins.d, (st.gpr(ins.a) + st.gpr(ins.b)) | 0); break;
    case "mflr": st.setGpr(ins.d, st.lr | 0); break;
    case "mtlr": st.lr = st.gpr(ins.s) >>> 0; break;
    case "b": next = ins.target; break;
    case "bl": st.lr = next; next = ins.target; break;
    case "blr": next = st.lr >>> 0; break;
  }
  st.pc = next;
}

function sleb(out, v) {
  v |= 0;
  for (;;) {
    const b = v & 0x7f;
    v >>= 7;
    if ((v === 0 && !(b & 0x40)) || (v === -1 && (b & 0x40))) { out.push(b); return; }
    out.push(b | 0x80);
  }
}

// One fragment for a plan function, or null when its code leaves the subset
// or falls through from one of its ranges into another. Entries: the start
// of every range (a tail-merged target is a range of its caller) and every
// return point after a bl. A segment runs from an entry to the next bl (jump
// to the callee, LR written), b (jump) or blr (dispatch on LR).
// `mutate` lets a test plant a translator bug.
export function translateFunction(f, read32, { mutate = null } = {}) {
  const ranges = [...f.ranges].sort((x, y) => x[0] - y[0]);
  if (!ranges.some((r) => r[0] === f.entry)) return null;
  const segments = [];
  for (const [start, end] of ranges) {
    let current = { start, ops: [] };
    for (let pc = start; pc < end; pc += 4) {
      const word = read32(pc);
      const ins = word === undefined ? null : decode(word, pc);
      if (!ins) return null;
      if (mutate) mutate(ins, pc);
      current.ops.push(ins);
      if (ins.kind === "bl" || ins.kind === "b" || ins.kind === "blr") {
        segments.push(current);
        current = { start: pc + 4, ops: [] };
      }
    }
    if (current.ops.length) return null; // falls off the end of the range
  }
  const code = [0x00]; // no locals
  const relocs = [];
  const get = () => code.push(0x20, 0x00);
  const loadGpr = (r) => { get(); code.push(0x28, 0x02); sleb(code, LAYOUT.gpr + 4 * r); };
  const storeTo = (off, pushValue) => { get(); pushValue(); code.push(0x36, 0x02); sleb(code, off); };
  const konst = (v) => { code.push(0x41); sleb(code, v); };
  const tail = (reloc) => { get(); code.push(0x12); relocs.push({ offset: code.length, ...reloc }); code.push(...paddedUleb(0)); };
  const entries = [];
  for (const seg of segments) {
    entries.push(seg.start);
    // if (state.pc == seg.start) { ... }
    get(); code.push(0x28, 0x02); sleb(code, LAYOUT.pc); konst(seg.start); code.push(0x46, 0x04, 0x40);
    let pc = seg.start;
    for (const ins of seg.ops) {
      switch (ins.kind) {
        case "addi": storeTo(LAYOUT.gpr + 4 * ins.d, () => { if (ins.a) { loadGpr(ins.a); konst(ins.imm); code.push(0x6a); } else konst(ins.imm); }); break;
        case "ori": storeTo(LAYOUT.gpr + 4 * ins.a, () => { loadGpr(ins.s); konst(ins.imm); code.push(0x72); }); break;
        case "add": storeTo(LAYOUT.gpr + 4 * ins.d, () => { loadGpr(ins.a); loadGpr(ins.b); code.push(0x6a); }); break;
        case "mflr": storeTo(LAYOUT.gpr + 4 * ins.d, () => { get(); code.push(0x28, 0x02); sleb(code, LAYOUT.lr); }); break;
        case "mtlr": storeTo(LAYOUT.lr, () => loadGpr(ins.s)); break;
        case "bl":
          storeTo(LAYOUT.lr, () => konst(pc + 4));
          storeTo(LAYOUT.pc, () => konst(ins.target));
          tail({ kind: "jump", targetPc: ins.target });
          break;
        case "b":
          storeTo(LAYOUT.pc, () => konst(ins.target));
          tail({ kind: "jump", targetPc: ins.target });
          break;
        case "blr":
          storeTo(LAYOUT.pc, () => { get(); code.push(0x28, 0x02); sleb(code, LAYOUT.lr); });
          tail({ kind: "dispatch" });
          break;
      }
      pc += 4;
    }
    code.push(0x0b); // end if
  }
  konst(2); // reached only on a PC the fragment did not declare: halted
  code.push(0x0b);
  return { entry: f.entry, entries, code: Uint8Array.from(code), relocs };
}
