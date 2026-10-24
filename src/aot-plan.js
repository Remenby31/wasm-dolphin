// Compilation plan: what ahead-of-time discovery hands to the region compiler.
// Format reference: docs/aot-plan.md. The plan holds addresses, edges and
// fingerprints only, never guest bytes, so it can be cached next to the
// compiled modules and thrown away at any time: the JIT covers everything the
// plan does not.
import { CONF_POINTER, CONF_PROFILE, CONF_ROOT, EDGE, discover } from "./aot-discovery.js";
import { PROFILE_REAL_MODE } from "./aot-profile.js";
import { IncrementalSha256 } from "./incremental-sha256.js";

export const PLAN_SCHEMA = "salon-aot-plan/1";
export const ANALYZER_VERSION = 3; // 2: per-region sha256, extraEntries, plan identity; 3: jump tables bounded by a masked index
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

// SHA-256 of the same bytes, for the persistent cache key: FNV-1a 64 is a
// fast check, not collision resistant across disc revisions.
export function regionSha256(read32, ranges) {
  let size = 0;
  for (const [s, e] of ranges) size += e - s;
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  let o = 0;
  for (const [s, e] of ranges) {
    for (let a = s; a < e; a += 4, o += 4) {
      const w = read32(a);
      if (w === undefined) return null;
      view.setUint32(o, w, false);
    }
  }
  return new IncrementalSha256().update(bytes).digestHex();
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
// `profile`: normalised profile blocks, to count how often each region was seen.
export function planModule(result, { id = 0, kind = "dol", read32, profile = null, extra = {} } = {}) {
  const { blocks, edges } = result;
  // Entries from outside a region that its compiler cannot infer from the
  // code alone: jump-table targets, resolved indirect targets, code pointers.
  const outside = new Set(result.codePointers ?? []);
  for (const t of result.jumpTables) for (const x of t.targets) outside.add(x);
  for (const site of result.indirectSites) for (const x of site.resolved ?? []) outside.add(x);
  const outsideSorted = [...outside].sort((a, b) => a - b);
  const profileStarts = profile ? profile.map((b) => b[0]) : [];
  const functions = result.functions.map((f) => {
    const ranges = mergeRanges(f.blocks.map((b) => [blocks.start[b], blocks.end[b]]));
    const extraEntries = [];
    let profileHits = 0;
    for (const [s, e] of ranges) {
      for (let i = lowerBound(outsideSorted, s); i < outsideSorted.length && outsideSorted[i] < e; i++) {
        if (outsideSorted[i] !== f.entry) extraEntries.push(outsideSorted[i]);
      }
      for (let i = lowerBound(profileStarts, s); i < profileStarts.length && profileStarts[i] < e; i++) profileHits += profile[i][2] ?? 1;
    }
    return {
      entry: f.entry,
      confidence: f.confidence,
      sources: f.sources,
      flags: 0,
      ranges,
      extraEntries,
      profileHits,
      hash: read32 ? regionHash(read32, ranges) : null,
      sha256: read32 ? regionSha256(read32, ranges) : null
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

function lowerBound(sorted, x) {
  let lo = 0, hi = sorted.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (sorted[m] < x) lo = m + 1; else hi = m;
  }
  return lo;
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
    // A sheet is the user's claim, not proof: walked on trial like a code pointer.
    for (const e of hints.entryPoints) entryPoints.push({ addr: e, source: "hint", confidence: CONF_POINTER, trial: true, forceEntry: true });
  }
  const dynamic = [];
  const inImage = [];
  for (const b of profile?.blocks ?? []) {
    const [s, e, , flags = 0] = b;
    if (!(flags & PROFILE_REAL_MODE) && image.isExec(s)) {
      entryPoints.push({ addr: s, source: "profile", confidence: CONF_PROFILE, trial: true });
      inImage.push(b);
    } else {
      dynamic.push({ start: s, end: e, mode: flags & PROFILE_REAL_MODE ? "real" : "virt", source: "profile" });
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
    modules: [planModule(result, { id: 0, kind: "dol", read32, profile: inImage })],
    dynamic,
    hints
  });
}


const isU32 = (v) => Number.isInteger(v) && v >= 0 && v <= 0xffffffff;
const isWord = (v) => isU32(v) && (v & 3) === 0;
const MODULE_KINDS = new Set(["dol", "apploader", "rel"]);
const fail = (msg) => { throw new Error(`aot-plan: ${msg}`); };

function checkRanges(ranges, where) {
  if (!Array.isArray(ranges) || !ranges.length) fail(`${where}: no ranges`);
  let last = -1;
  for (const r of ranges) {
    if (!Array.isArray(r) || r.length !== 2 || !isWord(r[0]) || !isWord(r[1]) || r[1] <= r[0]) fail(`${where}: bad range`);
    if (r[0] < last) fail(`${where}: ranges overlap or unsorted`);
    last = r[1];
  }
}
// Ranges are sorted and disjoint (checkRanges): binary search.
const within = (ranges, a) => {
  let lo = 0, hi = ranges.length - 1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (a < ranges[m][0]) hi = m - 1; else if (a >= ranges[m][1]) lo = m + 1; else return true;
  }
  return false;
};

// Structural check of a plan (from cache or another agent). Throws on the
// first problem; a consumer that catches simply runs without the plan.
export function validatePlan(plan) {
  if (!plan || typeof plan !== "object") fail("not an object");
  if (plan.schema !== PLAN_SCHEMA) fail(`schema ${plan.schema} unsupported`);
  if (plan.hash !== HASH_ALGORITHM) fail(`hash ${plan.hash} unsupported`);
  if (plan.analyzer !== ANALYZER_VERSION) fail(`analyzer ${plan.analyzer} is not ${ANALYZER_VERSION}: rebuild the plan`);
  if (!Array.isArray(plan.modules) || !Array.isArray(plan.rels) || !Array.isArray(plan.dynamic)) fail("modules, rels and dynamic must be arrays");
  for (const m of plan.modules) {
    if (!isU32(m.id) || !MODULE_KINDS.has(m.kind)) fail("bad module");
    const n = m.blocks?.start?.length;
    if (!Number.isInteger(n) || m.blocks.end?.length !== n || m.blocks.func?.length !== n) fail("block columns differ in length");
    const nf = m.functions?.length;
    if (!Number.isInteger(nf)) fail("functions missing");
    for (let i = 0; i < n; i++) {
      const s = m.blocks.start[i], e = m.blocks.end[i], f = m.blocks.func[i];
      if (!isWord(s) || !isWord(e) || e <= s) fail(`bad block ${i}`);
      if (!Number.isInteger(f) || f < -1 || f >= nf) fail(`bad block owner ${i}`);
      // A linked REL places its sections anywhere: only fixed modules are globally sorted.
      if (i && m.kind !== "rel" && s < m.blocks.end[i - 1]) fail(`blocks overlap or unsorted at ${i}`);
    }
    const ne = m.edges?.from?.length;
    if (!Number.isInteger(ne) || m.edges.to?.length !== ne || m.edges.kind?.length !== ne) fail("edge columns differ in length");
    for (let i = 0; i < ne; i++) {
      const a = m.edges.from[i], b = m.edges.to[i];
      if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0 || a >= n || b >= n || !(m.edges.kind[i] in EDGE_NAMES)) fail(`bad edge ${i}`);
    }
    for (const f of m.functions) {
      if (!isWord(f.entry) || !Number.isInteger(f.confidence) || f.confidence < 0 || f.confidence > 3) fail("bad function");
      checkRanges(f.ranges, "function");
      if (!within(f.ranges, f.entry)) fail("entry outside its ranges");
      if (f.hash !== null && !/^[0-9a-f]{16}$/.test(f.hash)) fail("bad hash");
      if (f.sha256 != null && !/^[0-9a-f]{64}$/.test(f.sha256)) fail("bad sha256");
      if (!isU32(f.flags ?? 0)) fail("bad flags");
      for (const x of f.extraEntries ?? []) if (!isWord(x) || !within(f.ranges, x)) fail("extra entry outside its region");
    }
    for (const t of m.jumpTables ?? []) {
      if (!isWord(t.site) || !isWord(t.table) || !Array.isArray(t.targets) || t.targets.length !== t.count || !t.targets.every(isWord)) fail("bad jump table");
    }
    for (const x of m.indirectSites ?? []) {
      if (!isWord(x.site) || !(x.resolved === null || (Array.isArray(x.resolved) && x.resolved.every(isWord)))) fail("bad indirect site");
    }
  }
  for (const r of plan.rels) {
    if (r.error) continue;
    if (r.kind !== "rel" || !isU32(r.relId) || !/^[0-9a-f]{16}$/.test(r.moduleHash ?? "") || !Array.isArray(r.sections)) fail("bad rel");
    const n = r.blocks?.start?.length;
    if (!Number.isInteger(n) || r.blocks.end?.length !== n || r.blocks.section?.length !== n) fail("rel block columns differ in length");
    for (const f of r.functions ?? []) {
      if (!r.sections[f.section] || !Array.isArray(f.ranges) || !f.ranges.every((x) => Array.isArray(x) && x.length === 3 && r.sections[x[0]] && isWord(x[1]) && isWord(x[2]) && x[2] > x[1] && x[2] <= r.sections[x[0]].size)) fail("bad rel function");
    }
  }
  for (const d of plan.dynamic) {
    if (!isWord(d.start) || !isWord(d.end) || d.end <= d.start || (d.mode !== "virt" && d.mode !== "real")) fail("bad dynamic range");
  }
  return plan;
}
const EDGE_NAMES = Object.fromEntries(Object.entries(EDGE).map(([k, v]) => [v, k]));

// Compile order for the core: regions seen by the profile first (most seen
// first), then by confidence, then smallest first. The core compiles in
// buffer order under its budget.
export function orderedRegions(plan) {
  const all = [];
  for (const m of plan.modules) for (const f of m.functions) all.push({ module: m.id, f, size: f.ranges.reduce((n, [s, e]) => n + e - s, 0) });
  return all.sort((a, b) => (b.f.profileHits ?? 0) - (a.f.profileHits ?? 0) || a.f.confidence - b.f.confidence || a.size - b.size || a.f.entry - b.f.entry);
}

// Compact binary of the regions, for the core (u32 little-endian), in compile order:
//   "SAOTPLN1", u32 version=1, u32 regionCount, u32 reserved, then per region:
//   u32 module, u32 entry, u32 confidence, u32 flags (bit0: real mode), u32 hashHi, u32 hashLo,
//   u32 rangeCount, rangeCount x (u32 start, u32 end), u32 extraEntryCount, extraEntryCount x u32
export const PLAN_BINARY_MAGIC = "SAOTPLN1";
export const REGION_FLAG_REAL_MODE = 1;
export function encodePlanRegions(plan) {
  const regions = orderedRegions(plan);
  let words = 3;
  for (const { f } of regions) words += 8 + 2 * f.ranges.length + (f.extraEntries?.length ?? 0);
  const out = new Uint8Array(8 + words * 4);
  out.set(new TextEncoder().encode(PLAN_BINARY_MAGIC), 0);
  const v = new DataView(out.buffer);
  let o = 8;
  const put = (x) => { v.setUint32(o, x >>> 0, true); o += 4; };
  put(1); put(regions.length); put(0);
  for (const { module, f } of regions) {
    put(module); put(f.entry); put(f.confidence); put(f.flags ?? 0);
    put(f.hash ? parseInt(f.hash.slice(0, 8), 16) : 0);
    put(f.hash ? parseInt(f.hash.slice(8), 16) : 0);
    put(f.ranges.length);
    for (const [s, e] of f.ranges) { put(s); put(e); }
    const extra = f.extraEntries ?? [];
    put(extra.length);
    for (const x of extra) put(x);
  }
  return out;
}
