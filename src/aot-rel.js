// REL modules: code the game links at run time with OSLink. Their load
// address is only known once linked, so discovery runs on a synthetic layout
// (section i of the module at SYNTH_BASE + i * SYNTH_STRIDE) with the
// module's own relocations applied, and the plan stores (section, offset)
// pairs. When the runtime sees the module in the OS module list it calls
// relocateModulePlan() with the real section addresses.
import { CONF_ROOT, discover } from "./aot-discovery.js";
import { GuestImage } from "./aot-image.js";
import { Fnv1a64, mergeRanges, regionHash } from "./aot-plan.js";

export const SYNTH_BASE = 0xa0000000;
export const SYNTH_STRIDE = 0x01000000;

// OS globals: first and last linked module (OSModuleInfo*).
export const OS_MODULE_LIST_HEAD = 0x800030c8;
export const OS_MODULE_LIST_TAIL = 0x800030cc;

export const R_PPC_NONE = 0;
export const R_PPC_ADDR32 = 1;
export const R_PPC_ADDR24 = 2;
export const R_PPC_ADDR16 = 3;
export const R_PPC_ADDR16_LO = 4;
export const R_PPC_ADDR16_HI = 5;
export const R_PPC_ADDR16_HA = 6;
export const R_PPC_ADDR14 = 7;
export const R_PPC_REL24 = 10;
export const R_PPC_REL14 = 11;
export const R_DOLPHIN_NOP = 201;
export const R_DOLPHIN_SECTION = 202;
export const R_DOLPHIN_END = 203;

const be32 = (v, o) => v.getUint32(o, false);

export function parseRel(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (u8.byteLength < 0x40) throw new Error("REL header is incomplete");
  const header = {
    id: be32(v, 0x00),
    numSections: be32(v, 0x0c),
    sectionInfoOffset: be32(v, 0x10),
    version: be32(v, 0x1c),
    bssSize: be32(v, 0x20),
    relOffset: be32(v, 0x24),
    impOffset: be32(v, 0x28),
    impSize: be32(v, 0x2c),
    prologSection: u8[0x30],
    epilogSection: u8[0x31],
    unresolvedSection: u8[0x32],
    prolog: be32(v, 0x34),
    epilog: be32(v, 0x38),
    unresolved: be32(v, 0x3c)
  };
  if (header.numSections > 256 || header.sectionInfoOffset + header.numSections * 8 > u8.byteLength) {
    throw new Error("REL section table out of range");
  }
  const sections = [];
  for (let i = 0; i < header.numSections; i++) {
    const raw = be32(v, header.sectionInfoOffset + i * 8);
    const size = be32(v, header.sectionInfoOffset + i * 8 + 4);
    const offset = (raw & ~1) >>> 0;
    const exec = (raw & 1) === 1;
    const bss = offset === 0 && size > 0;
    if (!bss && size && offset + size > u8.byteLength) throw new Error(`REL section ${i} out of range`);
    sections.push({ index: i, offset, size, exec, bss });
  }
  // Import table: per referenced module, a run of relocations.
  const imports = [];
  if (header.impOffset + header.impSize > u8.byteLength) throw new Error("REL import table out of range");
  for (let o = header.impOffset; o + 8 <= header.impOffset + header.impSize; o += 8) {
    const moduleId = be32(v, o);
    const relocs = [];
    let section = 0, offset = 0;
    for (let r = be32(v, o + 4); r + 8 <= u8.byteLength; r += 8) {
      const delta = v.getUint16(r, false), type = u8[r + 2], sect = u8[r + 3], addend = be32(v, r + 4);
      if (type === R_DOLPHIN_END) break;
      if (type === R_DOLPHIN_SECTION) { section = sect; offset = 0; continue; }
      offset += delta;
      if (type === R_DOLPHIN_NOP) continue;
      relocs.push({ section, offset, type, targetSection: sect, addend });
    }
    imports.push({ moduleId, relocs });
  }
  return { header, sections, imports, bytes: u8 };
}

const synthAddr = (section, offset) => (SYNTH_BASE + section * SYNTH_STRIDE + offset) >>> 0;
export const synthToLocal = (addr) => ({ section: ((addr - SYNTH_BASE) >>> 0) >>> 24, offset: (addr - SYNTH_BASE) & 0xffffff });

// Copy the module's sections at the synthetic layout and apply relocations
// against itself (synthetic) and the DOL (absolute). Relocations against
// other RELs stay as on disc: the code there is unknown until linked.
export function synthImage(rel) {
  const copies = rel.sections.map((s) => (s.bss || !s.size ? null : rel.bytes.slice(s.offset, s.offset + s.size)));
  const relocWords = rel.sections.map(() => new Set());
  for (const imp of rel.imports) {
    const self = imp.moduleId === rel.header.id;
    if (!self && imp.moduleId !== 0) {
      for (const r of imp.relocs) relocWords[r.section]?.add(r.offset & ~3);
      continue;
    }
    for (const r of imp.relocs) {
      const buf = copies[r.section];
      if (!buf || r.offset + 4 > buf.length && r.type !== R_PPC_ADDR16_LO && r.type !== R_PPC_ADDR16_HI && r.type !== R_PPC_ADDR16_HA) continue;
      relocWords[r.section].add(r.offset & ~3);
      const S = self ? synthAddr(r.targetSection, r.addend) : r.addend >>> 0;
      const P = synthAddr(r.section, r.offset);
      applyReloc(buf, r.offset, r.type, S, P);
    }
  }
  const segments = [];
  rel.sections.forEach((s, i) => {
    if (copies[i]) segments.push({ start: synthAddr(i, 0), bytes: copies[i], exec: s.exec, name: `rel-s${i}` });
  });
  return { image: new GuestImage(segments), relocWords: relocWords.map((set) => [...set].sort((a, b) => a - b)) };
}

function applyReloc(buf, off, type, S, P) {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const w32 = (x) => v.setUint32(off, x >>> 0, false);
  const w16 = (x) => v.setUint16(off, x & 0xffff, false);
  switch (type) {
    case R_PPC_ADDR32: w32(S); break;
    case R_PPC_ADDR24: w32((v.getUint32(off, false) & 0xfc000003) | (S & 0x03fffffc)); break;
    case R_PPC_ADDR16: case R_PPC_ADDR16_LO: w16(S); break;
    case R_PPC_ADDR16_HI: w16(S >>> 16); break;
    case R_PPC_ADDR16_HA: w16(((S >>> 16) + ((S & 0x8000) ? 1 : 0))); break;
    case R_PPC_ADDR14: w32((v.getUint32(off, false) & 0xffff0003) | (S & 0xfffc)); break;
    case R_PPC_REL24: w32((v.getUint32(off, false) & 0xfc000003) | ((S - P) & 0x03fffffc)); break;
    case R_PPC_REL14: w32((v.getUint32(off, false) & 0xffff0003) | ((S - P) & 0xfffc)); break;
    default: break;
  }
}

// Identity of a module independent of where it is linked: FNV-1a 64 over its
// executable sections with every relocated word replaced by zero.
export function maskedModuleHash(read32ForSection, rel, relocWords) {
  const h = new Fnv1a64();
  for (const s of rel.sections) {
    if (!s.exec || s.bss || !s.size) continue;
    const masked = new Set(relocWords[s.index]);
    h.word(s.index);
    for (let off = 0; off + 4 <= s.size; off += 4) {
      const w = masked.has(off) ? 0 : read32ForSection(s.index, off);
      if (w === undefined) return null;
      h.word(w);
    }
  }
  return h.hex();
}

// Discover the code of one REL. Entry points: prolog, epilog, unresolved,
// plus everything discovery reaches (relocated calls, vtables in data).
export function planRel(relBytes, { name = "", options = {} } = {}) {
  const rel = parseRel(relBytes);
  const { image, relocWords } = synthImage(rel);
  const entryPoints = [];
  const h = rel.header;
  for (const [sect, off, source] of [[h.prologSection, h.prolog, "rel-prolog"], [h.epilogSection, h.epilog, "rel-epilog"], [h.unresolvedSection, h.unresolved, "rel-unresolved"]]) {
    if (sect && rel.sections[sect]?.exec) entryPoints.push({ addr: synthAddr(sect, off), source, confidence: CONF_ROOT });
  }
  const result = discover(image, { ...options, entryPoints });
  const local = (a) => { const l = synthToLocal(a); return [l.section, l.offset]; };
  const blocks = result.blocks;
  const original = (section, off) => {
    const s = rel.sections[section];
    return s && off + 4 <= s.size ? new DataView(rel.bytes.buffer, rel.bytes.byteOffset + s.offset + off, 4).getUint32(0, false) : undefined;
  };
  return {
    kind: "rel",
    relId: h.id,
    name,
    moduleHash: maskedModuleHash(original, rel, relocWords),
    sections: rel.sections.map((s) => ({ index: s.index, size: s.size, exec: s.exec, bss: s.bss, relocWords: s.exec ? relocWords[s.index] : [] })),
    // (section, offset) pairs, the same order as the DOL plan's columns.
    blocks: {
      section: blocks.start.map((a) => local(a)[0]),
      start: blocks.start.map((a) => local(a)[1]),
      end: blocks.end.map((a) => local(a)[1]),
      func: blocks.func
    },
    edges: result.edges,
    functions: result.functions.map((f) => ({
      section: local(f.entry)[0],
      entry: local(f.entry)[1],
      confidence: f.confidence,
      sources: f.sources,
      // [section, start, end): a function may cross sections through a branch.
      ranges: mergeRanges(f.blocks.map((b) => [blocks.start[b], blocks.end[b]])).map(([s, e]) => [local(s)[0], local(s)[1], local(e - 4)[1] + 4])
    })),
    jumpTables: result.jumpTables.map((t) => ({ site: local(t.site), count: t.count, targets: t.targets.map(local) })),
    indirectSites: result.indirectSites.map((s) => ({ site: local(s.site), kind: s.kind })),
    stats: result.stats
  };
}

// Modules currently linked by the OS: [{ id, address, sections: [{ index, address, size, exec }] }].
// `read32` reads guest memory (effective addresses). Bounded walk: a corrupt
// list returns what was read so far.
export function readLinkedModules(read32, { max = 64 } = {}) {
  const out = [];
  const seen = new Set();
  let m = read32(OS_MODULE_LIST_HEAD);
  while (m && out.length < max && !seen.has(m) && m >= 0x80000000 && m < 0x81800000) {
    seen.add(m);
    const id = read32(m);
    const num = read32(m + 0x0c);
    const info = read32(m + 0x10);
    if (id === undefined || num === undefined || num > 256 || info === undefined) break;
    const sections = [];
    for (let i = 0; i < num; i++) {
      const raw = read32(info + i * 8), size = read32(info + i * 8 + 4);
      if (raw === undefined || size === undefined) break;
      sections.push({ index: i, address: (raw & ~1) >>> 0, size, exec: (raw & 1) === 1 });
    }
    out.push({ id, address: m, sections });
    m = read32(m + 0x04);
  }
  return out;
}

// Place a REL module plan at its linked addresses. Returns null when the
// linked module is not the one planned (id or masked hash differ): the JIT
// then handles it alone. Region hashes are computed from guest memory now,
// after linking, so later changes to the code are still detected.
export function relocateModulePlan(modulePlan, linked, read32) {
  if (!linked || linked.id !== modulePlan.relId) return null;
  const base = (section) => linked.sections[section]?.address;
  const read = (section, off) => {
    const b = base(section);
    return b === undefined ? undefined : read32(b + off);
  };
  const relShape = { sections: modulePlan.sections.map((s) => ({ ...s, offset: 0 })) };
  if (maskedModuleHash(read, relShape, modulePlan.sections.map((s) => s.relocWords)) !== modulePlan.moduleHash) return null;
  const abs = (section, off) => (base(section) + off) >>> 0;
  const functions = modulePlan.functions.map((f) => {
    const ranges = f.ranges.map(([sect, s, e]) => [abs(sect, s), abs(sect, e)]).sort((a, b) => a[0] - b[0]);
    return { entry: abs(f.section, f.entry), confidence: f.confidence, sources: f.sources, ranges, hash: regionHash(read32, ranges) };
  });
  return {
    id: modulePlan.relId,
    kind: "rel",
    linkedAt: linked.address,
    blocks: {
      start: modulePlan.blocks.start.map((s, i) => abs(modulePlan.blocks.section[i], s)),
      end: modulePlan.blocks.end.map((e, i) => abs(modulePlan.blocks.section[i], e)),
      func: modulePlan.blocks.func
    },
    edges: modulePlan.edges,
    functions,
    jumpTables: modulePlan.jumpTables.map((t) => ({ site: abs(...t.site), count: t.count, targets: t.targets.map((x) => abs(...x)) })),
    indirectSites: modulePlan.indirectSites.map((s) => ({ site: abs(...s.site), kind: s.kind }))
  };
}
