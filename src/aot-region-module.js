// Region assembly (track 3, P4): group the translated functions of a plan
// region into one WebAssembly module. The translator (core, patch 0075)
// turns one PowerPC function into a fragment; this file links fragments
// together. Contract (docs/plan-piste3.md, P4):
//
// Fragment: { entry, entries: [pc], code, relocs }
//   code     body of a function of type (param i32 state) (result i32): local
//            declarations, expression, `end`. It starts with its own dispatch
//            on state.pc over `entries` and exits through `return`, or through
//            a relocated `return_call`.
//   relocs   [{ offset, kind, name | targetPc }]: 5-byte padded u32 LEB at
//            `offset` in `code`, patched here:
//            "import"   name of an env helper (`call`); index assigned here
//            "jump"     return_call to the function holding targetPc, or to
//                       the exit stub when targetPc is outside the region
//            "dispatch" return_call to the region dispatcher (blr, bctr),
//                       state.pc already written
//            "global"   global.get of a host address the core passes at
//                       instantiation (REGION_GLOBAL_NAMES: the emulated RAM,
//                       L1; patch 0084), so the code runs wherever the heap is
//
// Module: imports env.memory (shared), the helpers used and the globals used
// (immutable i32, in REGION_GLOBAL_NAMES order), exports one
// function `f` = the dispatcher: (state) -> 0 continue at state.pc, 1 state.pc
// is not an entry of the region (nothing ran), 2 stopped. The dispatcher
// searches state.pc over the declared entries only, so a fragment is never
// entered on a PC it did not declare. The exit stub returns 0.

const TYPE_STATE = 0; // (i32) -> i32: dispatcher, stub, fragments
// Globals a fragment may read, by the index the core's reloc carries (kind 3).
export const REGION_GLOBAL_NAMES = Object.freeze(["ram_base", "l1_base"]);

const OP = { globalGet: 0x23, localGet: 0x20, localSet: 0x21, i32Load: 0x28, i32Const: 0x41, i32Eq: 0x46, i32LtU: 0x49, if: 0x04, end: 0x0b, return: 0x0f, returnCall: 0x12 };
const VAL = { i32: 0x7f, i64: 0x7e, f32: 0x7d, f64: 0x7c };

function uleb(out, v) {
  v >>>= 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
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

function name(out, s) {
  const bytes = new TextEncoder().encode(s);
  uleb(out, bytes.length);
  out.push(...bytes);
}

function section(out, id, body) {
  out.push(id);
  uleb(out, body.length);
  for (const b of body) out.push(b);
}

// 5-byte padded u32 LEB, the form relocation sites use.
export function paddedUleb(v) {
  v >>>= 0;
  return [0x80 | (v & 0x7f), 0x80 | ((v >>> 7) & 0x7f), 0x80 | ((v >>> 14) & 0x7f), 0x80 | ((v >>> 21) & 0x7f), (v >>> 28) & 0x0f];
}

function signature(sig) {
  const out = [0x60];
  uleb(out, sig.params.length);
  for (const p of sig.params) out.push(VAL[p]);
  uleb(out, sig.results.length);
  for (const r of sig.results) out.push(VAL[r]);
  return out;
}

// Dispatcher body: binary search of state.pc over sorted [pc, funcIndex].
// `missing` is what a PC that is not an entry returns: 1 for the exported
// dispatcher (nothing ran), 0 for the internal one that `dispatch` relocs
// reach (code already ran and wrote state.pc: continue there).
function dispatcherBody(entries, pcOffset, missing) {
  const body = [0x01, 0x01, VAL.i32]; // one i32 local: pc
  body.push(OP.localGet, 0, OP.i32Load, 2);
  uleb(body, pcOffset);
  body.push(OP.localSet, 1);
  const emit = (lo, hi) => {
    if (hi - lo <= 4) {
      for (let i = lo; i < hi; i++) {
        body.push(OP.localGet, 1, OP.i32Const);
        sleb(body, entries[i][0]);
        body.push(OP.i32Eq, OP.if, 0x40, OP.localGet, 0, OP.returnCall);
        uleb(body, entries[i][1]);
        body.push(OP.end);
      }
      body.push(OP.i32Const, missing, OP.return); // not an entry of the region
      return;
    }
    const mid = (lo + hi) >> 1;
    body.push(OP.localGet, 1, OP.i32Const);
    sleb(body, entries[mid][0]);
    body.push(OP.i32LtU, OP.if, 0x40);
    emit(lo, mid);
    body.push(OP.end);
    emit(mid, hi);
  };
  emit(0, entries.length);
  body.push(OP.i32Const, missing, OP.end);
  return body;
}

// Assemble fragments into a region module.
//   helpers     { name: { params: ["i32", ...], results: [...] } } for every
//               helper a fragment may import (the core's fixed list)
//   pcOffset    offset of pc in PowerPCState (_DolphinWeb_JitStateLayout)
//   memoryPages maximum pages of the shared memory (the core's); the declared
//               minimum is memoryMinPages (1): the emulator's memory satisfies
//               it, and an off-thread warm-up then needs only a small scratch
//               memory (V8 commits a Memory's initial pages at allocation, which
//               on Windows counts against the commit charge; decision of #30)
// Returns { bytes, entries: [[pc, fragmentIndex]] sorted, helpers: [name] }.
export const REGION_ENTRIES_SECTION = "region-entries";
// Custom section "region-layout": the u32 hash of the core's heap layout the
// fragments were translated for (WasmLayoutHash: offsets in the CPU state and
// sizes their code embeds; since patch 0084 not the RAM and L1 addresses,
// which are globals). The core installs the module only under the same
// layout; a module without it is never installed.
export const REGION_LAYOUT_SECTION = "region-layout";

export function regionModuleLayout(module) {
  const [section] = WebAssembly.Module.customSections(module, REGION_LAYOUT_SECTION);
  return section && section.byteLength === 4 ? new DataView(section).getUint32(0, true) : 0;
}

// Entries a region module declares (its "region-entries" section), or null.
export function regionModuleEntries(module) {
  const [section] = WebAssembly.Module.customSections(module, REGION_ENTRIES_SECTION);
  if (!section || section.byteLength % 4) return null;
  return Array.from(new Uint32Array(section.slice(0)));
}

export function assembleRegion(fragments, { helpers, pcOffset, memoryPages, memoryMinPages = 1, sharedMemory = true }) {
  if (!Array.isArray(fragments) || !fragments.length) throw new Error("region: no fragments");
  if (!Number.isInteger(pcOffset) || pcOffset < 0) throw new Error("region: pcOffset required");
  if (!Number.isInteger(memoryPages) || memoryPages < 1) throw new Error("region: memoryPages (the core's maximum) required");
  if (!Number.isInteger(memoryMinPages) || memoryMinPages < 0 || memoryMinPages > memoryPages) throw new Error("region: bad memory limits");

  // Helpers actually used, in name order: their function index is their rank.
  const used = new Set();
  for (const f of fragments) for (const r of f.relocs ?? []) if (r.kind === "import") used.add(r.name);
  const helperNames = [...used].sort();
  for (const n of helperNames) if (!helpers?.[n]) throw new Error(`region: unknown helper ${n}`);
  const helperIndex = new Map(helperNames.map((n, i) => [n, i]));
  const usedGlobals = new Set();
  for (const f of fragments) for (const r of f.relocs ?? []) if (r.kind === "global") usedGlobals.add(r.name);
  const globalNames = REGION_GLOBAL_NAMES.filter((n) => usedGlobals.has(n));
  for (const n of usedGlobals) if (!REGION_GLOBAL_NAMES.includes(n)) throw new Error(`region: unknown global ${n}`);
  const globalIndex = new Map(globalNames.map((n, i) => [n, i]));
  // Functions: helpers (imports), the exported dispatcher, the internal one
  // (`dispatch` relocs), the exit stub, then the fragments.
  const DISPATCHER = helperNames.length, INNER = DISPATCHER + 1, STUB = INNER + 1, FIRST = STUB + 1;
  const LOCAL_FUNCTIONS = 3 + fragments.length;

  // Entries -> fragment function index.
  const entryOwner = new Map();
  fragments.forEach((f, i) => {
    const entries = f.entries?.length ? f.entries : [f.entry];
    if (!entries.includes(f.entry)) throw new Error(`region: fragment ${f.entry.toString(16)} does not list its own entry`);
    for (const pc of entries) {
      if (!Number.isInteger(pc) || pc & 3) throw new Error(`region: bad entry ${pc}`);
      if (entryOwner.has(pc >>> 0)) throw new Error(`region: entry ${(pc >>> 0).toString(16)} declared twice`);
      entryOwner.set(pc >>> 0, FIRST + i);
    }
  });
  const sortedEntries = [...entryOwner].sort((a, b) => a[0] - b[0]);

  // Patch relocation sites.
  const TEMPLATE = paddedUleb(0);
  const bodies = fragments.map((f) => {
    const code = Uint8Array.from(f.code);
    const offsets = new Set();
    for (const r of f.relocs ?? []) {
      if (!Number.isInteger(r.offset) || r.offset < 1 || r.offset + 5 > code.length) throw new Error(`region: reloc outside the code at ${r.offset}`);
      // A site is a padded zero after the instruction it patches: call for a
      // helper, return_call for a jump or a dispatch. Sites never overlap.
      for (const o of offsets) if (Math.abs(o - r.offset) < 5) throw new Error(`region: overlapping relocs at ${r.offset}`);
      offsets.add(r.offset);
      if (TEMPLATE.some((b, i) => code[r.offset + i] !== b)) throw new Error(`region: reloc at ${r.offset} is not a padded zero`);
      const opcode = code[r.offset - 1];
      if ((r.kind === "import" && opcode !== 0x10) || ((r.kind === "jump" || r.kind === "dispatch") && opcode !== OP.returnCall) ||
          (r.kind === "global" && opcode !== OP.globalGet)) {
        throw new Error(`region: ${r.kind} reloc at ${r.offset} after opcode 0x${opcode.toString(16)}`);
      }
      let index;
      if (r.kind === "import") index = helperIndex.get(r.name);
      else if (r.kind === "jump") index = entryOwner.get(r.targetPc >>> 0) ?? STUB;
      else if (r.kind === "dispatch") index = INNER;
      else if (r.kind === "global") index = globalIndex.get(r.name);
      else throw new Error(`region: unknown reloc kind ${r.kind}`);
      code.set(paddedUleb(index), r.offset);
    }
    return code;
  });

  const out = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

  // Types: 0 = (i32)->i32, then one per helper signature.
  const sigs = [signature({ params: ["i32"], results: ["i32"] })];
  const sigIndex = new Map([[sigs[0].join(","), TYPE_STATE]]);
  const helperType = helperNames.map((n) => {
    const s = signature(helpers[n]);
    const key = s.join(",");
    if (!sigIndex.has(key)) { sigIndex.set(key, sigs.length); sigs.push(s); }
    return sigIndex.get(key);
  });
  const types = [];
  uleb(types, sigs.length);
  for (const s of sigs) types.push(...s);
  section(out, 1, types);

  const imports = [];
  uleb(imports, helperNames.length + 1 + globalNames.length);
  name(imports, "env"); name(imports, "memory");
  imports.push(0x02, sharedMemory ? 0x03 : 0x01);
  uleb(imports, memoryMinPages); uleb(imports, memoryPages);
  helperNames.forEach((n, i) => { name(imports, "env"); name(imports, n); imports.push(0x00); uleb(imports, helperType[i]); });
  for (const n of globalNames) { name(imports, "env"); name(imports, n); imports.push(0x03, VAL.i32, 0x00); }
  section(out, 2, imports);

  const funcs = [];
  uleb(funcs, LOCAL_FUNCTIONS);
  for (let i = 0; i < LOCAL_FUNCTIONS; i++) uleb(funcs, TYPE_STATE);
  section(out, 3, funcs);

  // A funcref table of the fragments, exported as "fragments": an off-thread
  // warm-up calls each of them (V8 compiles a function lazily, at its first
  // call); the core only ever calls `f`.
  const table = [0x01, 0x70, 0x00];
  uleb(table, fragments.length);
  section(out, 4, table);

  const exports = [];
  uleb(exports, 2);
  name(exports, "f"); exports.push(0x00); uleb(exports, DISPATCHER);
  name(exports, "fragments"); exports.push(0x01); uleb(exports, 0);
  section(out, 7, exports);

  const elem = [0x01, 0x00, OP.i32Const, 0x00, OP.end];
  uleb(elem, fragments.length);
  for (let i = 0; i < fragments.length; i++) uleb(elem, FIRST + i);
  section(out, 9, elem);

  const code = [];
  uleb(code, LOCAL_FUNCTIONS);
  const append = (bytes) => { for (const x of bytes) code.push(x); }; // no spread: large bodies
  for (const missing of [1, 0]) {
    const dispatcher = dispatcherBody(sortedEntries, pcOffset, missing);
    uleb(code, dispatcher.length); append(dispatcher);
  }
  const stub = [0x00, OP.i32Const, 0x00, OP.end]; // state.pc already written: continue there
  uleb(code, stub.length); append(stub);
  for (const b of bodies) { uleb(code, b.length); append(b); }
  section(out, 10, code);

  // Custom section "region-entries": every declared entry (u32 LE, sorted),
  // so a module loaded from the cache is mapped at all of them (returns
  // after a call land inside functions), without its fragments.
  const custom = [];
  name(custom, REGION_ENTRIES_SECTION);
  for (const [pc] of sortedEntries) custom.push(pc & 0xff, (pc >>> 8) & 0xff, (pc >>> 16) & 0xff, (pc >>> 24) & 0xff);
  section(out, 0, custom);
  const layouts = new Set(fragments.map((f) => (f.layout ?? 0) >>> 0));
  if (layouts.size !== 1) throw new Error("region: fragments translated for different layouts");
  const [layout] = layouts;
  if (layout) {
    const tag = [];
    name(tag, REGION_LAYOUT_SECTION);
    tag.push(layout & 0xff, (layout >>> 8) & 0xff, (layout >>> 16) & 0xff, (layout >>> 24) & 0xff);
    section(out, 0, tag);
  }

  return {
    bytes: Uint8Array.from(out),
    layout,
    entries: sortedEntries.map(([pc, fn]) => [pc, fn - FIRST]),
    helpers: helperNames
  };
}

// Functions of a region share blocks (tail-merged code, a function inside
// another's ranges): a PC is an entry of the first fragment that holds it,
// and a fragment whose own entry is taken is left out (the other one runs
// it). The core's translator lists every block start of a function.
export function claimEntries(fragments) {
  const claimed = new Set();
  const out = [];
  for (const fr of fragments) {
    if (claimed.has(fr.entry >>> 0)) continue;
    const entries = (fr.entries?.length ? fr.entries : [fr.entry]).filter((pc) => !claimed.has(pc >>> 0));
    for (const pc of entries) claimed.add(pc >>> 0);
    out.push({ ...fr, entries });
  }
  return out;
}

// Group the functions of a plan module into regions of at most
// `maxFunctions`, so that callers and callees share a region (a call inside a
// region is a return_call, ~4x cheaper than leaving the module).
//   1. Clusters: every function starts alone; caller/callee pairs are joined,
//      most call sites first, whenever the two clusters fit together.
//   2. Regions: clusters in compile order (`order`: function indexes,
//      orderedRegions; a cluster's place is its first member's) go into the
//      first region with room (first fit), each member in compile order.
// On a commercial disc (14 795 functions, 43 038 call edges, regions of 100):
// 53.1 % of call edges inside a region, 149 regions; 14.8 % with the first
// version (breadth-first from each function of the order, leaves first),
// 27.4 % depth-first from roots (harness/probes/aot-grouping.mjs).
// Returns [[functionIndex...]] for that module; functions absent from `order`
// are left out.
export function groupRegions(module, order, { maxFunctions = 100 } = {}) {
  const n = module.functions.length;
  const rank = new Int32Array(n).fill(-1);
  order.forEach((f, i) => { if (rank[f] < 0) rank[f] = i; });

  // Call sites per (caller, callee) pair, between functions of the order.
  const sites = new Map();
  const { from, to, kind } = module.edges;
  for (let i = 0; i < from.length; i++) {
    if (kind[i] !== 3 && kind[i] !== 4) continue; // call, tail
    const a = module.blocks.func[from[i]], b = module.blocks.func[to[i]];
    if (a < 0 || b < 0 || a === b || rank[a] < 0 || rank[b] < 0) continue;
    const key = a * n + b;
    sites.set(key, (sites.get(key) ?? 0) + 1);
  }
  const pairs = [...sites].map(([key, count]) => ({ a: Math.floor(key / n), b: key % n, count }));
  pairs.sort((x, y) => y.count - x.count || rank[x.a] - rank[y.a] || rank[x.b] - rank[y.b]);

  const parent = Int32Array.from({ length: n }, (_, i) => i);
  const size = new Int32Array(n).fill(1);
  const find = (x) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  for (const { a, b } of pairs) {
    const ra = find(a), rb = find(b);
    if (ra === rb || size[ra] + size[rb] > maxFunctions) continue;
    if (rank[ra] <= rank[rb]) { parent[rb] = ra; size[ra] += size[rb]; }
    else { parent[ra] = rb; size[rb] += size[ra]; }
  }

  const clusters = new Map(); // root -> members in compile order
  order.forEach((f, i) => {
    if (rank[f] !== i) return; // a repeat in the order
    const root = find(f);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root).push(f);
  });
  const regions = [];
  for (const members of clusters.values()) {
    const region = regions.find((r) => r.length + members.length <= maxFunctions);
    if (region) region.push(...members);
    else regions.push([...members]);
  }
  return regions;
}

// Cache key of an assembled region module (decision of 2026-10-19): the
// compiler version and codegen mask (the core's _DolphinWeb_AotKeyParts, u32
// each), then the SHA-256 of its members in module order, written
// "entry:sha256:extraEntries;" each (extra entries sorted, comma separated).
// A change in any member's guest code or entries, in membership or in order
// gives another key; it ends with ":" + 64 hex, as the cache requires.
// "region-v1" is the layout of this module and of this key text: bump it when
// either changes (dispatchers, exports, return codes, key fields); a change
// of code generation in the core is covered by compilerVersion instead.
export async function regionModuleKey(functions, { compilerVersion, codegenMask }) {
  for (const [what, v] of [["compilerVersion", compilerVersion], ["codegenMask", codegenMask]]) {
    if (!Number.isInteger(v) || v < 0 || v > 0xffffffff) throw new Error(`region: ${what} must be a u32`);
  }
  const hex8 = (v) => (v >>> 0).toString(16).padStart(8, "0");
  const text = functions.map((f) => {
    if (!/^[0-9a-f]{64}$/.test(f.sha256 ?? "")) throw new Error(`region: function ${f.entry?.toString(16)} has no sha256`);
    const extra = [...(f.extraEntries ?? [])].map((pc) => (pc >>> 0)).sort((a, b) => a - b).map((pc) => pc.toString(16)).join(",");
    return `${(f.entry >>> 0).toString(16)}:${f.sha256}:${extra};`;
  }).join("");
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  const hex = Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
  return `region-v1:${hex8(compilerVersion)}:${hex8(codegenMask)}:${hex}`;
}
