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
//            "heap"     a 5-byte padded LEB holding the host address of the
//                       emulated RAM or L1 (`name`, one of REGION_HEAP_NAMES):
//                       the immediate of an i32.const (`form` "const", signed
//                       LEB, the base itself; what the core emits) or,
//                       reserved for x64 and never emitted today, the memarg
//                       offset of an access ("offset", unsigned, base + byte
//                       offset). Left as is, listed in the module's
//                       "region-heap" section, so a module can be patched for
//                       another heap (patch 0084)
//
// Module: imports env.memory (shared) and the helpers used, exports one
// function `f` = the dispatcher: (state) -> 0 continue at state.pc, 1 state.pc
// is not an entry of the region (nothing ran), 2 stopped. The dispatcher
// searches state.pc over the declared entries only, so a fragment is never
// entered on a PC it did not declare.
//
// Exit stub: reached by a jump out of the region and by a `dispatch` to a PC
// that is not one of its entries, with the state written. It returns 0
// (continue at state.pc). With `chain` (a core with patch 0102), it first
// calls env.region_chain(state), the core's choice of the next region (a
// table index, 0 for none), and tail-calls that region's dispatcher through
// env.table, the core's function table, without going back to the core's
// dispatcher.

// Heap sites by the index the core's reloc carries (kind 3).
export const REGION_HEAP_NAMES = Object.freeze(["ram_base", "l1_base"]);

const TYPE_STATE = 0; // (i32) -> i32: dispatcher, stub, fragments
const OP = { localGet: 0x20, localSet: 0x21, localTee: 0x22, call: 0x10, i32Load: 0x28, i32Const: 0x41, i32Eq: 0x46, i32LtU: 0x49, i32And: 0x71, i32Mul: 0x6c, i32ShrU: 0x76, block: 0x02, if: 0x04, brIf: 0x0d, brTable: 0x0e, end: 0x0b, return: 0x0f, returnCall: 0x12, returnCallIndirect: 0x13 };
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

function ulebLength(v) {
  let n = 1;
  for (v >>>= 7; v; v >>>= 7) n++;
  return n;
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

// Dispatcher hash (decision of 2026-10-24): a binary search over a module's
// hundreds of entries cost 9.9 % of the CPU thread on a heavy scene, in
// mispredicted compares. Instead, slot = hash(state.pc) in a power-of-two
// table, then one `br_table` (one indirect jump) to the compares of that
// slot's entries. The table has a slot per entry (the next power of two, a
// load of 0.5 to 1) and at most DISPATCH_MAX_BITS bits: V8 lowers a br_table
// to a jump table of 8-byte addresses on x64, so a table of twice the entries
// (16k slots, 128 KB per dispatcher at 4,721 entries) cost 1.5-2.8 % on x64
// (Neoverse N2, Zen 3) where arm64's 4-byte branches gained 2 %. The hash is chosen from a
// fixed list by the entries alone (fewest compares in the fullest slot, then
// in all), so a module's bytes depend only on its members, as the cache key.
//   mul 0      slot = (pc >>> 2) & (size - 1)
//   mul M      slot = Math.imul(pc >>> 2, M) >>> (32 - bits)
export const DISPATCH_HASH_MULS = Object.freeze([0, 0x9e3779b1, 0x85ebca6b, 0xc2b2ae35, 0x27d4eb2f, 0x165667b1]);
const DISPATCH_LINEAR_MAX = 4; // up to 4 entries: compares in a row
export const DISPATCH_MAX_BITS = 10; // 1,024 slots: 8 KB of jump table on x64

export function dispatchSlot(pc, mul, bits) {
  const w = (pc >>> 2) >>> 0;
  return mul === 0 ? w & ((1 << bits) - 1) : Math.imul(w, mul) >>> (32 - bits);
}

export function chooseDispatchHash(pcs) {
  let bits = 4;
  while ((1 << bits) < pcs.length && bits < DISPATCH_MAX_BITS) bits++;
  let best = null;
  for (const mul of DISPATCH_HASH_MULS) {
    const count = new Uint32Array(1 << bits);
    for (const pc of pcs) count[dispatchSlot(pc, mul, bits)]++;
    let max = 0, cost = 0;
    for (const c of count) { if (c > max) max = c; cost += (c * (c + 1)) / 2; }
    if (!best || max < best.max || (max === best.max && cost < best.cost)) best = { mul, bits, max, cost };
  }
  return best;
}

// Dispatcher body over sorted [pc, funcIndex]: a PC that is not an entry
// returns 1 from the exported dispatcher (nothing ran); the internal one that
// `dispatch` relocs reach (code already ran and wrote state.pc) leaves
// through the exit stub (`missing` = { stub }). Only a declared entry is ever
// tail-called: every slot compares the full pc.
function dispatcherBody(entries, pcOffset, missing) {
  const miss = (out) => {
    if (typeof missing === "object") { out.push(OP.localGet, 0, OP.returnCall); uleb(out, missing.stub); }
    else out.push(OP.i32Const, missing, OP.return);
  };
  const body = [0x01, 0x01, VAL.i32]; // one i32 local: pc
  body.push(OP.localGet, 0, OP.i32Load, 2);
  uleb(body, pcOffset);
  body.push(OP.localSet, 1);
  const compares = (list) => {
    for (const [pc, fn] of list) {
      body.push(OP.localGet, 1, OP.i32Const);
      sleb(body, pc);
      body.push(OP.i32Eq, OP.if, 0x40, OP.localGet, 0, OP.returnCall);
      uleb(body, fn);
      body.push(OP.end);
    }
  };
  if (entries.length <= DISPATCH_LINEAR_MAX) {
    compares(entries);
  } else {
    // block $miss { block $s(k-1) ... block $s0 { br_table } slot 0 ... } miss
    // Slot j's block is the j-th non-empty slot; an empty slot goes to $miss.
    const { mul, bits } = chooseDispatchHash(entries.map(([pc]) => pc));
    const slots = new Map();
    for (const e of entries) {
      const s = dispatchSlot(e[0], mul, bits);
      if (!slots.has(s)) slots.set(s, []);
      slots.get(s).push(e);
    }
    const used = [...slots.keys()].sort((a, b) => a - b);
    const depth = new Map(used.map((s, j) => [s, j]));
    body.push(OP.block, 0x40);
    for (let j = 0; j < used.length; j++) body.push(OP.block, 0x40);
    body.push(OP.localGet, 1, OP.i32Const, 2, OP.i32ShrU);
    if (mul === 0) { body.push(OP.i32Const); sleb(body, (1 << bits) - 1); body.push(OP.i32And); }
    else { body.push(OP.i32Const); sleb(body, mul | 0); body.push(OP.i32Mul, OP.i32Const); sleb(body, 32 - bits); body.push(OP.i32ShrU); }
    body.push(OP.brTable);
    uleb(body, 1 << bits);
    for (let s = 0; s < 1 << bits; s++) uleb(body, depth.get(s) ?? used.length);
    uleb(body, used.length); // never taken: the slot is below the table size
    for (const s of used) {
      body.push(OP.end);
      compares(slots.get(s));
      miss(body); // a pc of this slot that is not an entry
    }
    body.push(OP.end); // $miss
  }
  if (typeof missing === "object") miss(body);
  else body.push(OP.i32Const, missing);
  body.push(OP.end);
  return body;
}

// Assemble fragments into a region module.
//   helpers     { name: { params: ["i32", ...], results: [...] } } for every
//               helper a fragment may import (the core's fixed list)
//   pcOffset    offset of pc in PowerPCState (_DolphinWeb_JitStateLayout)
//   heapBases   [ramBase, l1Base] the fragments' heap sites hold; by default
//               the fragments' own `heapBases` (the core's when it translated
//               them), which must agree
//   memoryPages maximum pages of the shared memory (the core's); the declared
//               minimum is memoryMinPages (1): the emulator's memory satisfies
//               it, and an off-thread warm-up then needs only a small scratch
//               memory (V8 commits a Memory's initial pages at allocation, which
//               on Windows counts against the commit charge; decision of #30)
// Returns { bytes, entries: [[pc, fragmentIndex]] sorted, helpers: [name] }.
export const REGION_ENTRIES_SECTION = "region-entries";
// Custom section "region-layout": the u32 hash of the core's heap layout the
// fragments were translated for (WasmLayoutHash: offsets in the CPU state and
// sizes their code embeds; the RAM and L1 addresses are heap sites, out of
// the hash since 0084). The core installs the module only under the same
// layout; a module without it is never installed.
export const REGION_LAYOUT_SECTION = "region-layout";

// Custom section "region-heap": the RAM and L1 addresses the module's heap
// sites hold, then its sites: u32 LE each, [ramBase, l1Base, count,
// (kind << 31 | form << 30 | byte offset in the module) ...]; kind 0 RAM,
// 1 L1; form 0 an i32.const's signed LEB (the base), 1 a memarg offset's
// unsigned LEB (base + a byte offset under 64 KiB). Each is 5 bytes padded.
export const REGION_HEAP_SECTION = "region-heap";

// { ramBase, l1Base, sites: [{ offset, kind, form }] } of a module's bytes
// (read from the section headers, without compiling), or null without the
// section. Throws on a "region-heap" section that does not parse, or on
// bytes whose sections run past their end: never read as "no section".
export function regionHeapOfBytes(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const fail = (why) => { throw new Error(`region: malformed module (${why})`); };
  const leb = (at, limit) => {
    let v = 0, shift = 0, x;
    do {
      if (at.p >= limit || shift > 28) fail("LEB past its end");
      x = b[at.p++];
      v += (x & 0x7f) * 2 ** shift;
      shift += 7;
    } while (x & 0x80);
    return v;
  };
  const at = { p: 8 };
  while (at.p < b.length) {
    const id = b[at.p++];
    const size = leb(at, b.length);
    const end = at.p + size;
    if (end > b.length) fail("a section past the end");
    if (id === 0) {
      const nameLength = leb(at, end);
      if (at.p + nameLength > end) fail("a section name past its section");
      const label = new TextDecoder().decode(b.subarray(at.p, at.p + nameLength));
      at.p += nameLength;
      if (label === REGION_HEAP_SECTION) {
        const length = end - at.p;
        if (length % 4 || length < 12) fail(`${REGION_HEAP_SECTION} of ${length} bytes`);
        const words = new DataView(b.buffer, b.byteOffset + at.p, length);
        const word = (i) => words.getUint32(4 * i, true);
        const count = word(2);
        if (3 + count !== length / 4) fail(`${REGION_HEAP_SECTION} counts ${count} sites in ${length} bytes`);
        const sites = Array.from({ length: count }, (_, i) => ({ offset: word(3 + i) & 0x3fffffff, kind: word(3 + i) >>> 31, form: (word(3 + i) >>> 30) & 1 }));
        for (const site of sites) if (site.offset < 1 || site.offset + 5 > b.length) fail(`a heap site at ${site.offset}`);
        return { ramBase: word(0), l1Base: word(1), sites };
      }
    }
    at.p = end;
  }
  return null;
}

// A 5-byte padded LEB at `at`, as a u32 (signed: an i32.const's immediate).
function readPadded(b, at, signed = false) {
  const low = ((b[at] & 0x7f) | ((b[at + 1] & 0x7f) << 7) | ((b[at + 2] & 0x7f) << 14) | ((b[at + 3] & 0x7f) << 21)) >>> 0;
  const top = b[at + 4];
  if (b[at] < 0x80 || b[at + 1] < 0x80 || b[at + 2] < 0x80 || b[at + 3] < 0x80 || top & 0x80) return null; // not padded to 5 bytes
  if (signed) {
    const high = top & 0x0f, ext = top & 0x70; // bits 28..31, then the sign extension of bit 31
    if (ext !== (high & 0x08 ? 0x70 : 0)) return null;
    return (low + high * 2 ** 28) >>> 0;
  }
  return top & 0x70 ? null : (low + (top & 0x0f) * 2 ** 28) >>> 0;
}

// 5-byte padded signed LEB of a u32 taken as an i32 (an i32.const's immediate).
export function paddedSleb(v) {
  const s = v | 0;
  return [0x80 | (s & 0x7f), 0x80 | ((s >> 7) & 0x7f), 0x80 | ((s >> 14) & 0x7f), 0x80 | ((s >> 21) & 0x7f), (s >> 28) & 0x7f];
}

const HEAP_FORMS = ["const", "offset"];
// The base a site holds and its slack: an i32.const holds the base itself, a
// memarg offset the base plus a byte offset under 64 KiB.
function siteHolds(b, at, form, base) {
  const value = readPadded(b, at, form === 0);
  if (value === null) return false;
  return form === 0 ? value === base >>> 0 : ((value - base) >>> 0) < 0x10000;
}

// A copy of the module's bytes with its heap sites (and its "region-heap"
// section) moved to `ramBase` / `l1Base`; the bytes themselves when nothing
// moves. Throws on a site that is not a padded LEB of its base.
export function patchRegionHeap(bytes, { ramBase, l1Base }) {
  const heap = regionHeapOfBytes(bytes);
  if (!heap) return bytes;
  const bases = [heap.ramBase, heap.l1Base];
  // Every site is checked, whether it moves or not.
  for (const { offset, kind, form } of heap.sites) {
    if (!siteHolds(bytes, offset, form, bases[kind])) throw new Error(`region: heap site at ${offset} does not hold its base`);
  }
  const delta = [(ramBase - heap.ramBase) >>> 0, (l1Base - heap.l1Base) >>> 0];
  if (!delta[0] && !delta[1]) return bytes;
  const out = Uint8Array.from(bytes);
  for (const { offset, kind, form } of heap.sites) {
    const value = (readPadded(out, offset, form === 0) + delta[kind]) >>> 0;
    out.set(form === 0 ? paddedSleb(value) : paddedUleb(value), offset);
  }
  // the section's two bases (its content follows its name)
  const marker = new TextEncoder().encode(REGION_HEAP_SECTION);
  for (let i = out.length - 12 - marker.length; i >= 8; i--) {
    if (out[i - 1] !== marker.length || !marker.every((c, k) => out[i + k] === c)) continue;
    const words = new DataView(out.buffer, out.byteOffset + i + marker.length, 8);
    if (words.getUint32(0, true) !== heap.ramBase || words.getUint32(4, true) !== heap.l1Base) continue;
    words.setUint32(0, ramBase >>> 0, true);
    words.setUint32(4, l1Base >>> 0, true);
    return out;
  }
  throw new Error("region: heap section not found");
}

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

//   chain       the exit stub chains to the next region (env.region_chain,
//               env.table): only for a core that exports them (patch 0102)
export function assembleRegion(fragments, { helpers, pcOffset, memoryPages, memoryMinPages = 1, sharedMemory = true, heapBases = null, names = true, chain = false }) {
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
  // Functions: helpers (imports), region_chain (import, with `chain`), the
  // exported dispatcher, the internal one (`dispatch` relocs), the exit stub,
  // then the fragments.
  const CHAIN = helperNames.length, DISPATCHER = CHAIN + (chain ? 1 : 0), INNER = DISPATCHER + 1, STUB = INNER + 1, FIRST = STUB + 1;
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
  const heapSites = []; // [fragment, offset in its body, kind, form]
  if (!heapBases) {
    const all = new Set(fragments.filter((f) => f.heapBases).map((f) => `${f.heapBases[0] >>> 0}:${f.heapBases[1] >>> 0}`));
    if (all.size > 1) throw new Error("region: fragments translated for different heaps");
    heapBases = fragments.find((f) => f.heapBases)?.heapBases ?? null;
  }
  const bodies = fragments.map((f, fi) => {
    const code = Uint8Array.from(f.code);
    const offsets = new Set();
    for (const r of f.relocs ?? []) {
      if (r.kind === "hint") continue; // branch hints patch nothing (metadata.code.branch_hint below)
      if (!Number.isInteger(r.offset) || r.offset < 1 || r.offset + 5 > code.length) throw new Error(`region: reloc outside the code at ${r.offset}`);
      // A site is a padded zero after the instruction it patches: call for a
      // helper, return_call for a jump or a dispatch. Sites never overlap.
      for (const o of offsets) if (Math.abs(o - r.offset) < 5) throw new Error(`region: overlapping relocs at ${r.offset}`);
      offsets.add(r.offset);
      if (r.kind === "heap") {
        // Left as is and listed: an i32.const of its base (after 0x41), or a
        // memarg offset of its base plus a byte offset.
        const kind = REGION_HEAP_NAMES.indexOf(r.name);
        const form = HEAP_FORMS.indexOf(r.form ?? "const");
        if (kind < 0) throw new Error(`region: unknown heap site ${r.name}`);
        if (form < 0) throw new Error(`region: unknown heap site form ${r.form}`);
        if (form === 0 && code[r.offset - 1] !== OP.i32Const) throw new Error(`region: heap site at ${r.offset} is not an i32.const`);
        if (!Array.isArray(heapBases) || heapBases.length !== 2) throw new Error("region: heapBases required for heap sites");
        if (!siteHolds(code, r.offset, form, heapBases[kind])) throw new Error(`region: heap site at ${r.offset} does not hold ${r.name}`);
        heapSites.push([fi, r.offset, kind, form]);
        continue;
      }
      if (TEMPLATE.some((b, i) => code[r.offset + i] !== b)) throw new Error(`region: reloc at ${r.offset} is not a padded zero`);
      const opcode = code[r.offset - 1];
      if (((r.kind === "import" || r.kind === "call") && opcode !== OP.call) || ((r.kind === "jump" || r.kind === "dispatch") && opcode !== OP.returnCall)) {
        throw new Error(`region: ${r.kind} reloc at ${r.offset} after opcode 0x${opcode.toString(16)}`);
      }
      let index;
      if (r.kind === "import") index = helperIndex.get(r.name);
      else if (r.kind === "jump") index = entryOwner.get(r.targetPc >>> 0) ?? STUB;
      else if (r.kind === "dispatch") index = INNER;
      // 0142: a guest call as a wasm call, to the fragment holding the
      // callee here, else the exit stub (which chains on to its region).
      else if (r.kind === "call") index = entryOwner.get(r.targetPc >>> 0) ?? STUB;
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
  uleb(imports, helperNames.length + 1 + (chain ? 2 : 0));
  name(imports, "env"); name(imports, "memory");
  imports.push(0x02, sharedMemory ? 0x03 : 0x01);
  uleb(imports, memoryMinPages); uleb(imports, memoryPages);
  helperNames.forEach((n, i) => { name(imports, "env"); name(imports, n); imports.push(0x00); uleb(imports, helperType[i]); });
  if (chain) {
    name(imports, "env"); name(imports, "region_chain"); imports.push(0x00); uleb(imports, TYPE_STATE);
    // Table 0: the core's function table, where the next region's dispatcher
    // is (any size).
    name(imports, "env"); name(imports, "table"); imports.push(0x01, 0x70, 0x00, 0x00);
  }
  section(out, 2, imports);

  const funcs = [];
  uleb(funcs, LOCAL_FUNCTIONS);
  for (let i = 0; i < LOCAL_FUNCTIONS; i++) uleb(funcs, TYPE_STATE);
  section(out, 3, funcs);

  // A funcref table of the fragments (table 1 after the core's with `chain`),
  // exported as "fragments": an off-thread warm-up calls each of them (V8
  // compiles a function lazily, at its first call); the core only ever calls
  // `f`.
  const FRAGMENTS_TABLE = chain ? 1 : 0;
  const table = [0x01, 0x70, 0x00];
  uleb(table, fragments.length);
  section(out, 4, table);

  const exports = [];
  uleb(exports, 2);
  name(exports, "f"); exports.push(0x00); uleb(exports, DISPATCHER);
  name(exports, "fragments"); exports.push(0x01); uleb(exports, FRAGMENTS_TABLE);
  section(out, 7, exports);

  const elem = chain
    ? [0x01, 0x02, 0x01, OP.i32Const, 0x00, OP.end, 0x00] // active, table 1, funcref indexes
    : [0x01, 0x00, OP.i32Const, 0x00, OP.end];
  uleb(elem, fragments.length);
  for (let i = 0; i < fragments.length; i++) uleb(elem, FIRST + i);
  section(out, 9, elem);

  const code = [];
  uleb(code, LOCAL_FUNCTIONS);
  const append = (bytes) => { for (const x of bytes) code.push(x); }; // no spread: large bodies
  for (const missing of [1, chain ? { stub: STUB } : 0]) {
    const dispatcher = dispatcherBody(sortedEntries, pcOffset, missing);
    uleb(code, dispatcher.length); append(dispatcher);
  }
  // State written: the next region, or 0 (continue at state.pc).
  const stub = chain ? [0x01, 0x01, VAL.i32, OP.localGet, 0, OP.call] : [0x00, OP.i32Const, 0x00, OP.end];
  if (chain) {
    uleb(stub, CHAIN);
    stub.push(OP.localTee, 1, OP.if, 0x40, OP.localGet, 0, OP.localGet, 1, OP.returnCallIndirect, TYPE_STATE, 0x00, OP.end, OP.i32Const, 0x00, OP.end);
  }
  uleb(code, stub.length); append(stub);
  const bodyAt = [];
  for (const b of bodies) { uleb(code, b.length); bodyAt.push(code.length); append(b); }
  // Custom section "metadata.code.branch_hint" (wasm branch hinting, before
  // the code section): per fragment, the `if` opcodes the core marked and
  // whether their true arm is likely (a fast path) or not (a halt, the
  // downcount running out), so V8 lays the cold arms out of line, away from
  // the hot code in the instruction cache. Offsets are from the start of the
  // function body, as the fragment's own code starts. A hint off an `if` is
  // dropped and counted (hintsDropped: V8 drops a malformed section silently,
  // so a drift of the core's offsets must show); an engine that doesn't know
  // the section ignores it.
  let hintsDropped = 0;
  // An `if` or a `br_if` (0135: the downcount check branches to the shared exit).
  const onIf = (f, r) => Number.isInteger(r.offset) && r.offset >= 0 && r.offset < f.code.length && (f.code[r.offset] === OP.if || f.code[r.offset] === OP.brIf);
  // Offsets must be strictly increasing within a function (V8 drops the
  // whole section otherwise, silently). Hints on the same offset that agree
  // are kept once; hints that disagree are all dropped (no guess), counted
  // in hintsDropped and hintsConflicting.
  let hintsConflicting = 0;
  const once = (hs) => {
    const out = [];
    for (let j = 0; j < hs.length;) {
      let k = j;
      while (k < hs.length && hs[k].offset === hs[j].offset) k++;
      if (hs.slice(j, k).every((h) => h.likely === hs[j].likely)) {
        out.push(hs[j]);
        hintsDropped += k - j - 1;
      } else {
        hintsConflicting += k - j;
        hintsDropped += k - j;
      }
      j = k;
    }
    return out;
  };
  const hinted = fragments.map((f, i) => [FIRST + i, (f.relocs ?? []).filter((r) => r.kind === "hint")
    .filter((r) => onIf(f, r) || (hintsDropped++, false))
    .sort((a, b) => a.offset - b.offset)]).map(([fn, hs]) => [fn, once(hs)]).filter(([, hs]) => hs.length);
  if (hinted.length) {
    const hints = [];
    name(hints, "metadata.code.branch_hint");
    uleb(hints, hinted.length);
    for (const [fn, hs] of hinted) {
      uleb(hints, fn);
      uleb(hints, hs.length);
      for (const h of hs) { uleb(hints, h.offset); hints.push(0x01, h.likely ? 0x01 : 0x00); }
    }
    section(out, 0, hints);
  }
  const codeAt = out.length + 1 + ulebLength(code.length); // the section's id and size first
  section(out, 10, code);

  // Custom section "region-entries": every declared entry (u32 LE, sorted),
  // so a module loaded from the cache is mapped at all of them (returns
  // after a call land inside functions), without its fragments.
  const custom = [];
  name(custom, REGION_ENTRIES_SECTION);
  for (const [pc] of sortedEntries) custom.push(pc & 0xff, (pc >>> 8) & 0xff, (pc >>> 16) & 0xff, (pc >>> 24) & 0xff);
  section(out, 0, custom);
  // Written whenever the bases are known, sites or not: a module of this
  // translator without the section is never installed (discio queues it
  // with no bases, which the core refuses).
  if (heapSites.length || Array.isArray(heapBases)) {
    if (!Array.isArray(heapBases) || heapBases.length !== 2) throw new Error("region: heapBases required for heap sites");
    const words = [heapBases[0] >>> 0, heapBases[1] >>> 0, heapSites.length,
      ...heapSites.map(([fi, offset, kind, form]) => ((kind << 31) | (form << 30) | (codeAt + bodyAt[fi] + offset)) >>> 0)];
    const tag = [];
    name(tag, REGION_HEAP_SECTION);
    for (const w of words) tag.push(w & 0xff, (w >>> 8) & 0xff, (w >>> 16) & 0xff, (w >>> 24) & 0xff);
    section(out, 0, tag);
  }
  const layouts = new Set(fragments.map((f) => (f.layout ?? 0) >>> 0));
  if (layouts.size !== 1) throw new Error("region: fragments translated for different layouts");
  const [layout] = layouts;
  if (layout) {
    const tag = [];
    name(tag, REGION_LAYOUT_SECTION);
    tag.push(layout & 0xff, (layout >>> 8) & 0xff, (layout >>> 16) & 0xff, (layout >>> 24) & 0xff);
    section(out, 0, tag);
  }

  // Custom section "name" (wasm spec, appendix "Name Section"): profilers see
  // the region and the guest PC instead of wasm-function[N]. V8 names code
  // with it (WasmCode::DebugName, wasm-code-manager.cc:280-293) in its
  // jitdump / perf map / DevTools profiles; codegen ignores it. Region id =
  // its lowest entry PC: stable across sessions, unique (an entry belongs to
  // one region), no plumbing. Names: r<id>_f<entry PC> for a fragment,
  // r<id>_dispatch / _inner / _exit for the three local helpers.
  if (names) {
    const hex = (pc) => (pc >>> 0).toString(16).padStart(8, "0");
    const rid = `r${hex(sortedEntries[0][0])}`;
    const fnNames = [[DISPATCHER, `${rid}_dispatch`], [INNER, `${rid}_inner`], [STUB, `${rid}_exit`],
      ...fragments.map((f, i) => [FIRST + i, `${rid}_f${hex(f.entry)}`])];
    const sub = (id, body) => { const o = [id]; uleb(o, body.length); for (const b of body) o.push(b); return o; };
    const modName = []; name(modName, rid);
    const fnMap = []; uleb(fnMap, fnNames.length);
    for (const [index, n] of fnNames) { uleb(fnMap, index); name(fnMap, n); }
    const ns = []; name(ns, "name");
    for (const b of sub(0, modName)) ns.push(b);
    for (const b of sub(1, fnMap)) ns.push(b);
    section(out, 0, ns);
  }

  return {
    bytes: Uint8Array.from(out),
    layout,
    entries: sortedEntries.map(([pc, fn]) => [pc, fn - FIRST]),
    helpers: helperNames,
    hintsDropped,
    hintsConflicting
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
// "region-v2": the same with the chaining exit stub (`chain`, patch 0102),
// which imports env.region_chain and env.table.
// formation: how a member's fragments are formed, hashed with the members
// from 2 on (2: continuation fragments from a capped fragment's frontier,
// aot-orchestrator translateWithContinuations), so that a cache built with
// another formation is translated again rather than reused.
// dispatch: the dispatchers' shape, hashed with the members from 2 on (2: a
// hashed br_table, DISPATCH_HASH_MULS; 3: its table a slot per entry, at most
// 2^DISPATCH_MAX_BITS), so a module cached with another shape is assembled
// again.
export const REGION_DISPATCH = 3;
export const REGION_FORMATION = 7; // 3: frontier by nearest held entry, module budget by water-filling; 4: a continuation stops at blocks already held; 5: the plan's extra entries seed the frontier; 6: continuations when the frontier is not empty, the first fragment uncapped; 7: that only when the code it leads to loops
// functionCap: the wasm function body cap the fragments were formed under
// (JSC, REGION_JSC_FUNCTION_CAP); in the key only when there is one, so the
// keys without it (V8, SpiderMonkey) are those of before.
export async function regionModuleKey(functions, { compilerVersion, codegenMask, chain = false, formation = REGION_FORMATION, functionCap = 0, dispatch = REGION_DISPATCH }) {
  for (const [what, v] of [["compilerVersion", compilerVersion], ["codegenMask", codegenMask]]) {
    if (!Number.isInteger(v) || v < 0 || v > 0xffffffff) throw new Error(`region: ${what} must be a u32`);
  }
  const hex8 = (v) => (v >>> 0).toString(16).padStart(8, "0");
  if (!Number.isInteger(functionCap) || functionCap < 0) throw new Error("region: functionCap must be a non-negative integer");
  const text = (dispatch > 1 ? `dispatch:${dispatch};` : "") + (formation > 1 ? `formation:${formation};` : "") + (functionCap > 0 ? `cap:${functionCap};` : "") + functions.map((f) => {
    if (!/^[0-9a-f]{64}$/.test(f.sha256 ?? "")) throw new Error(`region: function ${f.entry?.toString(16)} has no sha256`);
    const extra = [...(f.extraEntries ?? [])].map((pc) => (pc >>> 0)).sort((a, b) => a - b).map((pc) => pc.toString(16)).join(",");
    return `${(f.entry >>> 0).toString(16)}:${f.sha256}:${extra};`;
  }).join("");
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  const hex = Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${chain ? "region-v2" : "region-v1"}:${hex8(compilerVersion)}:${hex8(codegenMask)}:${hex}`;
}
