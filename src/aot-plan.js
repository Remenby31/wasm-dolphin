// Compilation plan: what ahead-of-time discovery hands to the region compiler.
// Format reference: docs/aot-plan.md. The plan holds addresses, edges and
// fingerprints only, never guest bytes, so it can be cached next to the
// compiled modules and thrown away at any time: the JIT covers everything the
// plan does not.
import { CONF_PROFILE, CONF_ROOT, EDGE, discover } from "./aot-discovery.js";

export const PLAN_SCHEMA = "salon-aot-plan/1";
export const ANALYZER_VERSION = 1;
export const HASH_ALGORITHM = "fnv1a64";

// FNV-1a 64 over guest bytes in memory order. Kept in two 32-bit halves:
// prime 0x100000001b3 = 2^40 + 0x1b3.
export class Fnv1a64 {
  constructor() {
    this.hi = 0xcbf29ce4;
    this.lo = 0x84222325;
  }
  byte(b) {
    const lo = (this.lo ^ b) >>> 0;
    const t = lo * 0x1b3;
    const carry = Math.floor(t / 0x100000000);
    this.lo = t >>> 0;
    this.hi = (Math.imul(this.hi, 0x1b3) + carry + (lo << 8)) >>> 0;
  }
  word(w) {
    this.byte(w >>> 24);
    this.byte((w >>> 16) & 0xff);
    this.byte((w >>> 8) & 0xff);
    this.byte(w & 0xff);
  }
  hex() {
    return this.hi.toString(16).padStart(8, "0") + this.lo.toString(16).padStart(8, "0");
  }
}

export function fnv1a64Hex(bytes) {
  const h = new Fnv1a64();
  for (const b of bytes) h.byte(b);
  return h.hex();
}

// Hash of the guest code covered by `ranges` ([[start, end)...], ascending).
export function regionHash(read32, ranges) {
  const h = new Fnv1a64();
  for (const [s, e] of ranges) {
    for (let a = s; a < e; a += 4) {
      const w = read32(a);
      if (w === undefined) return null;
      h.word(w);
    }
  }
  return h.hex();
}

// Merge sorted block ranges into maximal contiguous ranges.
export function mergeRanges(ranges) {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

// Turn a discovery result into the plan section of one module.
export function planModule(result, { id = 0, kind = "dol", read32, extra = {} } = {}) {
  const { blocks, edges } = result;
  const functions = result.functions.map((f) => {
    const ranges = mergeRanges(f.blocks.map((b) => [blocks.start[b], blocks.end[b]]));
    return {
      entry: f.entry,
      confidence: f.confidence,
      sources: f.sources,
      ranges,
      hash: read32 ? regionHash(read32, ranges) : null
    };
  });
  return {
    id,
    kind,
    ...extra,
    blocks: { start: blocks.start, end: blocks.end, func: blocks.func },
    edges: { from: edges.from, to: edges.to, kind: edges.kind },
    functions,
    jumpTables: result.jumpTables.map(({ site, table, count, targets, bound, kind }) => ({ site, table, count, kind, targets, bound })),
    indirectSites: result.indirectSites,
    stats: result.stats
  };
}

// Full plan for a disc: the DOL module, REL modules (aot-rel.js), dynamic
// code seen by the profile outside any module.
export function buildPlan({ disc = {}, modules, rels = [], dynamic = [], hints = null }) {
  return {
    schema: PLAN_SCHEMA,
    analyzer: ANALYZER_VERSION,
    hash: HASH_ALGORITHM,
    disc: { gameId: disc.gameId ?? null, dolHash: disc.dolHash ?? null },
    hints: hints ? { name: hints.name ?? null, entries: hints.entryPoints.length } : null,
    modules,
    // REL modules not linked yet, in (section, offset) form (aot-rel.js).
    rels,
    dynamic
  };
}

// Discover and plan the DOL of a disc.
// `profile`: blocks seen executing in earlier sessions (aot-profile.js).
// `hints`: a validated per-game hint sheet (aot-hints.js).
export function planDol({ image, entryPoint, gameId = null, dolBytes = null, profile = null, hints = null, options = {} }) {
  const entryPoints = [{ addr: entryPoint, source: "dol-entry", confidence: CONF_ROOT }];
  if (hints) {
    for (const e of hints.entryPoints) entryPoints.push({ addr: e, source: "hint", confidence: CONF_ROOT });
  }
  const dynamic = [];
  if (profile) {
    for (const [s, e] of profile.blocks) {
      if (image.isExec(s)) entryPoints.push({ addr: s, source: "profile", confidence: CONF_PROFILE });
      else dynamic.push([s, e]);
    }
  }
  const result = discover(image, {
    ...options,
    entryPoints,
    exclude: hints?.notCode ?? [],
    knownTables: hints?.jumpTables ?? []
  });
  const read32 = (a) => image.read32(a);
  return buildPlan({
    disc: { gameId, dolHash: dolBytes ? fnv1a64Hex(dolBytes) : null },
    modules: [planModule(result, { id: 0, kind: "dol", read32 })],
    dynamic: mergeRanges(dynamic).map(([s, e]) => ({ start: s, end: e, source: "profile" })),
    hints
  });
}

const isU32 = (v) => Number.isInteger(v) && v >= 0 && v <= 0xffffffff;

// Structural check of a plan (from cache or another agent). Throws on the
// first problem; a consumer that catches simply runs without the plan.
export function validatePlan(plan) {
  if (!plan || plan.schema !== PLAN_SCHEMA) throw new Error(`aot-plan: schema ${plan?.schema} unsupported`);
  if (plan.hash !== HASH_ALGORITHM) throw new Error(`aot-plan: hash ${plan.hash} unsupported`);
  if (!Array.isArray(plan.modules)) throw new Error("aot-plan: modules missing");
  for (const m of plan.modules) {
    const n = m.blocks.start.length;
    if (m.blocks.end.length !== n || m.blocks.func.length !== n) throw new Error("aot-plan: block columns differ in length");
    for (let i = 0; i < n; i++) {
      const s = m.blocks.start[i], e = m.blocks.end[i];
      if (!isU32(s) || !isU32(e) || e <= s || (s & 3) || (e & 3)) throw new Error(`aot-plan: bad block ${i}`);
      // A linked REL places its sections anywhere: only the DOL is globally sorted.
      if (i && m.kind === "dol" && s < m.blocks.end[i - 1]) throw new Error(`aot-plan: blocks overlap or unsorted at ${i}`);
    }
    const ne = m.edges.from.length;
    if (m.edges.to.length !== ne || m.edges.kind.length !== ne) throw new Error("aot-plan: edge columns differ in length");
    for (let i = 0; i < ne; i++) {
      if (!(m.edges.from[i] < n && m.edges.to[i] < n && m.edges.kind[i] in EDGE_NAMES)) throw new Error(`aot-plan: bad edge ${i}`);
    }
    for (const f of m.functions) {
      if (!isU32(f.entry) || !Array.isArray(f.ranges) || !f.ranges.length) throw new Error("aot-plan: bad function");
      if (!f.ranges.some(([s, e]) => f.entry >= s && f.entry < e)) throw new Error(`aot-plan: entry outside its ranges`);
      if (f.hash !== null && !/^[0-9a-f]{16}$/.test(f.hash)) throw new Error("aot-plan: bad hash");
    }
  }
  return plan;
}
const EDGE_NAMES = Object.fromEntries(Object.entries(EDGE).map(([k, v]) => [v, k]));

// Compact binary of the regions, for a consumer in the core (u32 little-endian):
//   "SAOTPLN1", u32 version=1, u32 regionCount, then per region:
//   u32 module, u32 entry, u32 confidence, u32 hashHi, u32 hashLo, u32 rangeCount, rangeCount x (u32 start, u32 end)
export const PLAN_BINARY_MAGIC = "SAOTPLN1";
export function encodePlanRegions(plan) {
  let words = 3;
  for (const m of plan.modules) for (const f of m.functions) words += 6 + 2 * f.ranges.length;
  const out = new Uint8Array(8 + words * 4);
  out.set(new TextEncoder().encode(PLAN_BINARY_MAGIC), 0);
  const v = new DataView(out.buffer);
  let o = 8;
  const put = (x) => { v.setUint32(o, x >>> 0, true); o += 4; };
  let count = 0;
  for (const m of plan.modules) count += m.functions.length;
  put(1); put(count); put(0);
  for (const m of plan.modules) {
    for (const f of m.functions) {
      put(m.id); put(f.entry); put(f.confidence);
      put(f.hash ? parseInt(f.hash.slice(0, 8), 16) : 0);
      put(f.hash ? parseInt(f.hash.slice(8), 16) : 0);
      put(f.ranges.length);
      for (const [s, e] of f.ranges) { put(s); put(e); }
    }
  }
  return out;
}
