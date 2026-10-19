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
//
// Module: imports env.memory (shared) and the helpers used, exports one
// function `f` = the dispatcher: (state) -> 0 continue at state.pc, 1 state.pc
// is not an entry of the region (nothing ran), 2 stopped. The dispatcher
// searches state.pc over the declared entries only, so a fragment is never
// entered on a PC it did not declare. The exit stub returns 0.

const TYPE_STATE = 0; // (i32) -> i32: dispatcher, stub, fragments
const OP = { localGet: 0x20, localSet: 0x21, i32Load: 0x28, i32Const: 0x41, i32Eq: 0x46, i32LtU: 0x49, if: 0x04, end: 0x0b, return: 0x0f, returnCall: 0x12 };
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
function dispatcherBody(entries, pcOffset) {
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
      body.push(OP.i32Const, 1, OP.return); // not an entry of the region
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
  body.push(OP.i32Const, 1, OP.end);
  return body;
}

// Assemble fragments into a region module.
//   helpers     { name: { params: ["i32", ...], results: [...] } } for every
//               helper a fragment may import (the core's fixed list)
//   pcOffset    offset of pc in PowerPCState (_DolphinWeb_JitStateLayout)
//   memoryPages min = max pages of the shared memory (the core's)
// Returns { bytes, entries: [[pc, fragmentIndex]] sorted, helpers: [name] }.
export function assembleRegion(fragments, { helpers, pcOffset, memoryPages = 24576, sharedMemory = true }) {
  if (!Array.isArray(fragments) || !fragments.length) throw new Error("region: no fragments");
  if (!Number.isInteger(pcOffset) || pcOffset < 0) throw new Error("region: pcOffset required");

  // Helpers actually used, in name order: their function index is their rank.
  const used = new Set();
  for (const f of fragments) for (const r of f.relocs ?? []) if (r.kind === "import") used.add(r.name);
  const helperNames = [...used].sort();
  for (const n of helperNames) if (!helpers?.[n]) throw new Error(`region: unknown helper ${n}`);
  const helperIndex = new Map(helperNames.map((n, i) => [n, i]));
  const DISPATCHER = helperNames.length, STUB = DISPATCHER + 1, FIRST = STUB + 1;

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
  const bodies = fragments.map((f) => {
    const code = Uint8Array.from(f.code);
    for (const r of f.relocs ?? []) {
      if (!Number.isInteger(r.offset) || r.offset < 0 || r.offset + 5 > code.length) throw new Error(`region: reloc outside the code at ${r.offset}`);
      let index;
      if (r.kind === "import") index = helperIndex.get(r.name);
      else if (r.kind === "jump") index = entryOwner.get(r.targetPc >>> 0) ?? STUB;
      else if (r.kind === "dispatch") index = DISPATCHER;
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
  uleb(imports, helperNames.length + 1);
  name(imports, "env"); name(imports, "memory");
  imports.push(0x02, sharedMemory ? 0x03 : 0x01);
  uleb(imports, memoryPages); uleb(imports, memoryPages);
  helperNames.forEach((n, i) => { name(imports, "env"); name(imports, n); imports.push(0x00); uleb(imports, helperType[i]); });
  section(out, 2, imports);

  const funcs = [];
  uleb(funcs, 2 + fragments.length);
  for (let i = 0; i < 2 + fragments.length; i++) uleb(funcs, TYPE_STATE);
  section(out, 3, funcs);

  const exports = [];
  uleb(exports, 1);
  name(exports, "f"); exports.push(0x00); uleb(exports, DISPATCHER);
  section(out, 7, exports);

  const code = [];
  uleb(code, 2 + fragments.length);
  const dispatcher = dispatcherBody(sortedEntries, pcOffset);
  uleb(code, dispatcher.length); code.push(...dispatcher);
  const stub = [0x00, OP.i32Const, 0x00, OP.end]; // state.pc already written: continue there
  uleb(code, stub.length); code.push(...stub);
  for (const b of bodies) { uleb(code, b.length); for (const x of b) code.push(x); }
  section(out, 10, code);

  return {
    bytes: Uint8Array.from(out),
    entries: sortedEntries.map(([pc, fn]) => [pc, fn - FIRST]),
    helpers: helperNames
  };
}

// Group the functions of a plan module into regions of `maxFunctions`, in
// compile order (`order`: function indexes, orderedRegions), pulling each
// function's callees in breadth first so callers and callees share a region.
// A region is filled up with the next functions of the order once its call
// tree is exhausted, so small leaf functions do not end up alone.
// Returns [[functionIndex...]] for that module.
export function groupRegions(module, order, { maxFunctions = 100 } = {}) {
  const n = module.functions.length;
  const callees = Array.from({ length: n }, () => new Set());
  const { from, to, kind } = module.edges;
  for (let i = 0; i < from.length; i++) {
    if (kind[i] !== 3 && kind[i] !== 4) continue; // call, tail
    const a = module.blocks.func[from[i]], b = module.blocks.func[to[i]];
    if (a >= 0 && b >= 0 && a !== b) callees[a].add(b);
  }
  const taken = new Uint8Array(n);
  const regions = [];
  let next = 0;
  const nextSeed = () => {
    while (next < order.length && taken[order[next]]) next++;
    return next < order.length ? order[next] : -1;
  };
  for (let seed = nextSeed(); seed >= 0; seed = nextSeed()) {
    const region = [];
    const queue = [];
    const enqueue = (f) => { taken[f] = 1; queue.push(f); };
    enqueue(seed);
    while (region.length < maxFunctions) {
      if (!queue.length) {
        const s = nextSeed();
        if (s < 0) break;
        enqueue(s);
      }
      const f = queue.shift();
      region.push(f);
      for (const c of callees[f]) if (!taken[c]) enqueue(c);
    }
    for (const f of queue) taken[f] = 0; // not placed: free for a later region
    regions.push(region);
  }
  return regions;
}
