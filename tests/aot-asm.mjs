// Minimal PowerPC encoder and DOL/REL builders for the ahead-of-time
// discovery tests. Synthetic code only.

export const asm = {
  b: (from, to) => (18 << 26) | ((to - from) & 0x03fffffc),
  bl: (from, to) => (18 << 26) | ((to - from) & 0x03fffffc) | 1,
  bc: (bo, bi, from, to) => (16 << 26) | (bo << 21) | (bi << 16) | ((to - from) & 0xfffc),
  bgt: (from, to, crf = 0) => asm.bc(12, crf * 4 + 1, from, to),
  bge: (from, to, crf = 0) => asm.bc(4, crf * 4 + 0, from, to),
  beq: (from, to, crf = 0) => asm.bc(12, crf * 4 + 2, from, to),
  blr: () => 0x4e800020,
  bctr: () => 0x4e800420,
  bctrl: () => 0x4e800421,
  addi: (d, a, imm) => (14 << 26) | (d << 21) | (a << 16) | (imm & 0xffff),
  li: (d, imm) => asm.addi(d, 0, imm),
  lis: (d, imm) => (15 << 26) | (d << 21) | (imm & 0xffff),
  ori: (a, s, imm) => (24 << 26) | (s << 21) | (a << 16) | (imm & 0xffff),
  cmplwi: (a, imm, crf = 0) => (10 << 26) | (crf << 23) | (a << 16) | (imm & 0xffff),
  slwi2: (a, s) => (21 << 26) | (s << 21) | (a << 16) | (2 << 11) | (0 << 6) | (29 << 1),
  lwzx: (d, a, b) => (31 << 26) | (d << 21) | (a << 16) | (b << 11) | (23 << 1),
  lwz: (d, a, off) => (32 << 26) | (d << 21) | (a << 16) | (off & 0xffff),
  mtctr: (s) => (31 << 26) | (s << 21) | (9 << 16) | (467 << 1),
  mflr: (d) => (31 << 26) | (d << 21) | (8 << 16) | (339 << 1),
  stwu: (s, a, off) => (37 << 26) | (s << 21) | (a << 16) | (off & 0xffff),
  nop: () => 0x60000000
};

// Word array with label resolution: items are numbers or (pc, labels) => word.
export function assemble(base, items) {
  const labels = {};
  let pc = base;
  const flat = [];
  for (const it of items) {
    if (typeof it === "string") { labels[it] = pc; continue; }
    flat.push({ pc, it });
    pc += 4;
  }
  return { words: flat.map(({ pc, it }) => (typeof it === "function" ? it(pc, labels) : it) >>> 0), labels, end: pc };
}

export function wordsToBytes(words) {
  const out = new Uint8Array(words.length * 4);
  const v = new DataView(out.buffer);
  words.forEach((w, i) => v.setUint32(i * 4, w >>> 0, false));
  return out;
}

// DOL with one text and one data section.
export function buildDol({ textAddr, text, dataAddr = 0, data = [], entry }) {
  const textBytes = wordsToBytes(text), dataBytes = wordsToBytes(data);
  const out = new Uint8Array(0x100 + textBytes.length + dataBytes.length);
  const v = new DataView(out.buffer);
  v.setUint32(0x00, 0x100, false);
  v.setUint32(0x48, textAddr, false);
  v.setUint32(0x90, textBytes.length, false);
  if (dataBytes.length) {
    v.setUint32(0x1c, 0x100 + textBytes.length, false);
    v.setUint32(0x64, dataAddr, false);
    v.setUint32(0xac, dataBytes.length, false);
  }
  v.setUint32(0xe0, entry, false);
  out.set(textBytes, 0x100);
  out.set(dataBytes, 0x100 + textBytes.length);
  return out;
}

// REL (version 1) with sections [null, text(exec), data] and relocations
// against itself: relocs = [{ section, offset, type, targetSection, addend }].
export function buildRel({ id, text, data = [], prolog, relocs = [] }) {
  const textBytes = wordsToBytes(text), dataBytes = wordsToBytes(data);
  const headerSize = 0x40, numSections = 3;
  const sectionTable = headerSize;
  const textOff = sectionTable + numSections * 8;
  const dataOff = textOff + textBytes.length;
  const impOff = dataOff + dataBytes.length;
  const relOff = impOff + 8;
  const sorted = [...relocs].sort((a, b) => a.section - b.section || a.offset - b.offset);
  const entries = [];
  let section = -1, last = 0;
  for (const r of sorted) {
    if (r.section !== section) { entries.push([0, 202, r.section, 0]); section = r.section; last = 0; }
    entries.push([r.offset - last, r.type, r.targetSection, r.addend]);
    last = r.offset;
  }
  entries.push([0, 203, 0, 0]);
  const out = new Uint8Array(relOff + entries.length * 8);
  const v = new DataView(out.buffer);
  v.setUint32(0x00, id, false);
  v.setUint32(0x0c, numSections, false);
  v.setUint32(0x10, sectionTable, false);
  v.setUint32(0x1c, 1, false);
  v.setUint32(0x24, relOff, false);
  v.setUint32(0x28, impOff, false);
  v.setUint32(0x2c, 8, false);
  out[0x30] = 1;
  v.setUint32(0x34, prolog, false);
  v.setUint32(sectionTable + 8, textOff | 1, false);
  v.setUint32(sectionTable + 12, textBytes.length, false);
  v.setUint32(sectionTable + 16, dataOff, false);
  v.setUint32(sectionTable + 20, dataBytes.length, false);
  out.set(textBytes, textOff);
  out.set(dataBytes, dataOff);
  v.setUint32(impOff, id, false);
  v.setUint32(impOff + 4, relOff, false);
  entries.forEach(([delta, type, sect, addend], i) => {
    v.setUint16(relOff + i * 8, delta, false);
    out[relOff + i * 8 + 2] = type;
    out[relOff + i * 8 + 3] = sect;
    v.setUint32(relOff + i * 8 + 4, addend >>> 0, false);
  });
  return out;
}
