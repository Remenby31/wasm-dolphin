import assert from "node:assert/strict";
import test from "node:test";

import { DISPATCH_MAX_BITS, assembleRegion, chooseDispatchHash, dispatchSlot, groupRegions, paddedSleb, paddedUleb, patchRegionHeap, regionHeapOfBytes, regionModuleKey, regionModuleLayout } from "../src/aot-region-module.js";
import { checkBranchHintSection } from "./helpers/branch-hints.mjs";


// Synthetic fragments in the translator's shape. State layout of the tests:
// pc at +0, a counter at +4, LR at +8, state at address 64.
const PC = 0, COUNT = 4, LR = 8, STATE = 64;
const HELPERS = { bump: { params: ["i32"], results: [] }, read_u32: { params: ["i32", "i32"], results: ["i32"] } };

function sleb(v) {
  const out = [];
  v |= 0;
  for (;;) {
    const b = v & 0x7f;
    v >>= 7;
    if ((v === 0 && !(b & 0x40)) || (v === -1 && (b & 0x40))) { out.push(b); return out; }
    out.push(b | 0x80);
  }
}

// Tiny fragment assembler: items are byte arrays or reloc markers.
function fragment(entry, entries, items) {
  const code = [0x00]; // no locals
  const relocs = [];
  for (const it of items) {
    if (Array.isArray(it)) code.push(...it);
    else { relocs.push({ offset: code.length, ...it }); code.push(...paddedUleb(0)); }
  }
  code.push(0x0b);
  return { entry, entries, code: Uint8Array.from(code), relocs };
}
const get = [0x20, 0x00];
const load = (off) => [...get, 0x28, 0x02, off];
const store = (off, value) => [...get, ...value, 0x36, 0x02, off];
const konst = (v) => [0x41, ...sleb(v)];
const add = (off, n) => store(off, [...load(off), ...konst(n), 0x6a]);
const ifPc = (pc, body) => [...load(PC), ...konst(pc), 0x46, 0x04, 0x40, ...body, 0x0b];
const tail = (reloc) => [[...get, 0x12], reloc];

// A (0x1000, 0x1004, 0x1008) calls B (0x2000), which returns through LR.
function program() {
  const A = fragment(0x1000, [0x1000, 0x1004, 0x1008], [
    ifPc(0x1000, []).slice(0, -1), add(COUNT, 1), store(LR, konst(0x1004)), store(PC, konst(0x2000)),
    ...tail({ kind: "jump", targetPc: 0x2000 }), [0x0b],
    ifPc(0x1004, []).slice(0, -1), add(COUNT, 100), store(PC, konst(0x80009000)),
    ...tail({ kind: "jump", targetPc: 0x80009000 }), [0x0b],
    ifPc(0x1008, [...konst(2), 0x0f]),
    konst(1)
  ]);
  const B = fragment(0x2000, [0x2000], [
    get, [0x10], { kind: "import", name: "bump" },
    add(COUNT, 10), store(PC, load(LR)),
    ...tail({ kind: "dispatch" })
  ]);
  return [A, B];
}

// The core's side of region chaining (patch 0102): region_chain(state) picks
// the next region's table index in `table`, 0 to return to the dispatcher.
const noChain = () => ({ region_chain: () => 0, table: new WebAssembly.Table({ element: "anyfunc", initial: 1 }) });

async function instantiate(region, { onBump = () => {}, memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true }), chain = noChain() } = {}) {
  const { instance } = await WebAssembly.instantiate(region.bytes, {
    env: { memory, bump: onBump, read_u32: () => 0, ...chain }
  });
  const u32 = new Uint32Array(memory.buffer);
  return {
    f: instance.exports.f,
    run(pc) { u32[(STATE + PC) / 4] = pc; return instance.exports.f(STATE); },
    word: (off) => u32[(STATE + off) / 4],
    set: (off, v) => { u32[(STATE + off) / 4] = v; },
    reset() { u32.fill(0); }
  };
}

test("aot region: fragments are linked by return_call, LR returns go through the dispatcher", async () => {
  const region = assembleRegion(program(), { helpers: HELPERS, pcOffset: PC, memoryPages: 1 });
  assert.deepEqual(region.helpers, ["bump"], "only the helpers used are imported");
  assert.deepEqual(region.entries.map(([pc]) => pc), [0x1000, 0x1004, 0x1008, 0x2000]);
  let bumps = 0;
  const r = await instantiate(region, { onBump: () => { bumps++; } });
  // A(0x1000) -> B -> dispatcher(0x1004) -> A(0x1004) -> stub (outside).
  assert.equal(r.run(0x1000), 0, "continue at state.pc");
  assert.equal(r.word(COUNT), 111);
  assert.equal(r.word(PC), 0x80009000);
  assert.equal(bumps, 1);
});

test("aot region: unknown PC returns 1 without running anything, a stop returns 2", async () => {
  const r = await instantiate(assembleRegion(program(), { helpers: HELPERS, pcOffset: PC, memoryPages: 1 }));
  for (const pc of [0x0ffc, 0x100c, 0x2004, 0x80001000, 0]) {
    r.reset();
    assert.equal(r.run(pc), 1, pc.toString(16));
    assert.equal(r.word(COUNT), 0);
  }
  assert.equal(r.run(0x1008), 2);
});

test("aot region: the dispatcher finds every entry among hundreds (hashed br_table)", async () => {
  // 300 fragments with two entries each; every entry adds index+1 and exits.
  const frags = Array.from({ length: 300 }, (_, i) => {
    const pc = 0x80003000 + i * 0x40;
    return fragment(pc, [pc, pc + 8], [
      add(COUNT, i + 1), store(PC, konst(0x81000000)), ...tail({ kind: "jump", targetPc: 0x81000000 })
    ]);
  });
  const region = assembleRegion(frags, { helpers: HELPERS, pcOffset: PC, memoryPages: 1 });
  assert.equal(region.entries.length, 600);
  const r = await instantiate(region);
  for (const i of [0, 1, 149, 150, 298, 299]) {
    for (const pc of [0x80003000 + i * 0x40, 0x80003008 + i * 0x40]) {
      r.reset();
      assert.equal(r.run(pc), 0);
      assert.equal(r.word(COUNT), i + 1, pc.toString(16));
    }
    r.reset();
    assert.equal(r.run(0x80003004 + i * 0x40), 1);
  }
});

// Entries spread like a plan's (seeded): a module of many fragments, with
// slots holding several entries, so the compares after the br_table matter.
function spreadFragments(n, seed, entriesPer = 2) {
  let x = (seed * 0x9e3779b9) >>> 0 || 1;
  const next = () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return (x >>>= 0); }; // xorshift32 (an LCG's low bits are periodic)
  const pcs = new Set();
  while (pcs.size < n * entriesPer) pcs.add((0x80003000 + (next() % 0x3a0000) * 4) >>> 0);
  const sorted = [...pcs];
  return Array.from({ length: n }, (_, i) => {
    const entries = sorted.slice(i * entriesPer, (i + 1) * entriesPer);
    return fragment(entries[0], entries, [
      add(COUNT, i + 1), store(PC, konst(0x81700000)), ...tail({ kind: "jump", targetPc: 0x81700000 })
    ]);
  });
}

test("aot region: hashed dispatch reaches every entry, and a pc sharing an entry's slot is not run (collisions)", async () => {
  for (const [n, seed] of [[3, 1], [40, 2], [700, 3], [1100, 4]]) {
    const frags = spreadFragments(n, seed);
    const region = assembleRegion(frags, { helpers: HELPERS, pcOffset: PC, memoryPages: 1 });
    const r = await instantiate(region);
    const owner = new Map(frags.flatMap((f, i) => f.entries.map((pc) => [pc, i + 1])));
    for (const [pc, want] of owner) {
      r.reset();
      assert.equal(r.run(pc), 0, `${n}: ${pc.toString(16)}`);
      assert.equal(r.word(COUNT), want, `${n}: ${pc.toString(16)} ran its own fragment`);
    }
    if (n * 2 <= 4) continue; // compares in a row, no table
    const { mul, bits, max } = chooseDispatchHash([...owner.keys()]);
    if (n >= 700) assert.ok(max >= 2, `${n}: slots with several entries (max ${max})`);
    // Non-entries in occupied slots: neighbours, misaligned pcs, other aligned
    // pcs of the same slot, 0 and the top of memory.
    const occupied = new Set([...owner.keys()].map((pc) => dispatchSlot(pc, mul, bits)));
    const probes = [0, 0xfffffffc, 0x80003001];
    for (const pc of owner.keys()) probes.push(pc + 4, pc - 4, pc + 2, (pc + (4 << bits)) >>> 0);
    for (let pc = 0x80003000, k = 0; k < n; pc += 4) if (!owner.has(pc) && occupied.has(dispatchSlot(pc, mul, bits))) { probes.push(pc); k++; } // same slot, any hash
    let shared = 0;
    for (const pc of probes) {
      if (owner.has(pc >>> 0)) continue;
      if (occupied.has(dispatchSlot(pc >>> 0, mul, bits))) shared++;
      r.reset();
      assert.equal(r.run(pc >>> 0), 1, `${n}: ${(pc >>> 0).toString(16)} is not an entry`);
      assert.equal(r.word(COUNT), 0);
    }
    assert.ok(shared >= n, `${n}: ${shared} probes landed in an occupied slot`);
  }
});

test("aot region: a dispatch from code to a non-entry of an occupied slot leaves through the exit (0, state.pc kept)", async () => {
  const frags = spreadFragments(300, 7);
  const pcs = frags.flatMap((f) => f.entries);
  const { mul, bits } = chooseDispatchHash(pcs);
  const entries = new Set(pcs);
  const occupied = new Set(pcs.map((pc) => dispatchSlot(pc, mul, bits)));
  let target = 0x80003000;
  while (entries.has(target) || !occupied.has(dispatchSlot(target, mul, bits))) target += 4;
  // An extra fragment writes that pc and dispatches (a blr to it).
  const jumper = fragment(0x81000000, [0x81000000], [add(COUNT, 1000), store(PC, konst(target | 0)), ...tail({ kind: "dispatch" })]);
  for (const chain of [false, true]) {
    const region = assembleRegion([...frags, jumper], { helpers: HELPERS, pcOffset: PC, memoryPages: 1, chain });
    const r = await instantiate(region);
    r.reset();
    assert.equal(r.run(0x81000000), 0, `chain ${chain}: code ran, continue at state.pc`);
    assert.equal(r.word(COUNT), 1000, `chain ${chain}: only the jumper ran`);
    assert.equal(r.word(PC), target);
  }
});

test("aot region: the dispatch hash depends on the entries only (same members, same bytes)", () => {
  const frags = spreadFragments(500, 11);
  const opts = { helpers: HELPERS, pcOffset: PC, memoryPages: 1 };
  const a = assembleRegion(frags, opts).bytes, b = assembleRegion(frags.map((f) => ({ ...f, code: Uint8Array.from(f.code) })), opts).bytes;
  assert.deepEqual(Buffer.from(a), Buffer.from(b));
  const pcs = frags.flatMap((f) => f.entries);
  assert.deepEqual(chooseDispatchHash(pcs), chooseDispatchHash([...pcs].reverse()), "order of the entries does not matter");
  const h = chooseDispatchHash(pcs);
  assert.ok(1 << h.bits >= pcs.length && 1 << (h.bits - 1) < pcs.length, "a slot per entry: the next power of two of the entries");
  assert.equal(chooseDispatchHash(Array.from({ length: 5000 }, (_, i) => 0x80003000 + 4 * i)).bits, DISPATCH_MAX_BITS, "at most 2^DISPATCH_MAX_BITS slots (x64 jump tables)");
});

test("aot region: malformed input is refused", () => {
  const [A, B] = program();
  const opts = { helpers: HELPERS, pcOffset: 0, memoryPages: 1 };
  assert.throws(() => assembleRegion([], opts), /no fragments/);
  assert.throws(() => assembleRegion([A, B], { helpers: HELPERS, pcOffset: 0 }), /memoryPages/);
  assert.throws(() => assembleRegion([A, { ...B, entries: [0x2000, 0x1000] }], opts), /declared twice/);
  assert.throws(() => assembleRegion([A, { ...B, relocs: B.relocs.map((r) => (r.kind === "import" ? { ...r, name: "nope" } : r)) }], opts), /unknown helper/);
  assert.throws(() => assembleRegion([{ ...A, relocs: [{ offset: A.code.length - 2, kind: "dispatch" }] }], opts), /outside the code/);
  assert.throws(() => assembleRegion([{ ...A, entries: [0x1004] }], opts), /own entry/);
  // relocation sites: a padded zero, after the opcode they patch, never overlapping
  const site = B.relocs.find((r) => r.kind === "dispatch");
  assert.throws(() => assembleRegion([A, { ...B, relocs: [...B.relocs, { ...site }] }], opts), /overlapping/);
  assert.throws(() => assembleRegion([A, { ...B, relocs: B.relocs.map((r) => (r === site ? { ...r, kind: "import", name: "bump" } : r)) }], opts), /after opcode/);
  const dirty = Uint8Array.from(B.code);
  dirty[site.offset] = 0x81;
  assert.throws(() => assembleRegion([A, { ...B, code: dirty }], opts), /padded zero/);
});

test("aot region: a dispatch to a PC outside the region returns 0 (code ran), the exported f returns 1 only before anything ran", async () => {
  const [A, B] = program();
  const r = await instantiate(assembleRegion([A, B], { helpers: HELPERS, pcOffset: PC, memoryPages: 1 }));
  // B returns through LR: with LR outside the region, its dispatch misses
  r.reset();
  const u32 = (off, v) => r.set(off, v);
  u32(LR, 0x80001234);
  assert.equal(r.run(0x2000), 0, "B ran, then dispatched out of the region: continue at state.pc");
  assert.equal(r.word(PC), 0x80001234);
  assert.equal(r.word(COUNT), 10);
  r.reset();
  assert.equal(r.run(0x80001234), 1, "not an entry, nothing ran");
  assert.equal(r.word(COUNT), 0);
});

test("aot region: an exit tail-calls the region region_chain picks, in the core's table (patch 0102)", async () => {
  // Region 1 = A alone: its call to B (0x2000) leaves the region. Region 2 =
  // B: returns through LR (0x1004), outside region 2, back into region 1.
  const [A, B] = program();
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  const table = new WebAssembly.Table({ element: "anyfunc", initial: 3 });
  const owner = new Map([[0x1000, 1], [0x1004, 1], [0x1008, 1], [0x2000, 2]]);
  const asked = [];
  let budget = Infinity; // exits the core lets chain
  const region_chain = (state) => {
    const pc = new Uint32Array(memory.buffer)[(state + PC) / 4];
    asked.push(pc);
    return budget-- > 0 ? owner.get(pc) ?? 0 : 0;
  };
  const opts = { helpers: HELPERS, pcOffset: PC, memoryPages: 1, chain: true };
  const r1 = await instantiate(assembleRegion([A], opts), { memory, chain: { region_chain, table } });
  const r2 = await instantiate(assembleRegion([B], opts), { memory, chain: { region_chain, table } });
  table.set(1, r1.f);
  table.set(2, r2.f);
  // A(0x1000) -> stub -> region 2: B -> dispatch miss -> stub -> region 1:
  // A(0x1004) -> stub (0x80009000: no region) -> 0.
  assert.equal(r1.run(0x1000), 0);
  assert.equal(r1.word(COUNT), 111, "both regions ran within one call");
  assert.equal(r1.word(PC), 0x80009000);
  assert.deepEqual(asked, [0x2000, 0x1004, 0x80009000]);
  // Refused: the first exit returns to the dispatcher, state.pc written.
  r1.reset(); asked.length = 0; budget = 0;
  assert.equal(r1.run(0x1000), 0);
  assert.equal(r1.word(COUNT), 1);
  assert.equal(r1.word(PC), 0x2000);
  assert.deepEqual(asked, [0x2000]);
});

test("aot region: chained modules are keyed region-v2, the others region-v1", async () => {
  const members = [{ entry: 0x1000, sha256: "a".repeat(64) }, { entry: 0x2000, sha256: "b".repeat(64) }];
  const parts = { compilerVersion: 5, codegenMask: 0 };
  assert.match(await regionModuleKey(members, parts), /^region-v1:00000005:00000000:[0-9a-f]{64}$/);
  const chained = await regionModuleKey(members, { ...parts, chain: true });
  assert.match(chained, /^region-v2:00000005:00000000:[0-9a-f]{64}$/);
  assert.equal(chained.slice(10), (await regionModuleKey(members, parts)).slice(10), "same members, same hash");
});

test("aot region: without chain (a core before 0102) the module imports neither region_chain nor the table", () => {
  const opts = { helpers: HELPERS, pcOffset: PC, memoryPages: 1 };
  const names = (o) => WebAssembly.Module.imports(new WebAssembly.Module(assembleRegion(program(), o).bytes)).map((i) => i.name);
  assert.deepEqual(names(opts), ["memory", "bump"]);
  assert.deepEqual(names({ ...opts, chain: true }), ["memory", "bump", "region_chain", "table"]);
  // both expose the fragments for the warm-up
  for (const o of [opts, { ...opts, chain: true }]) {
    assert.deepEqual(WebAssembly.Module.exports(new WebAssembly.Module(assembleRegion(program(), o).bytes)).map((e) => e.name), ["f", "fragments"]);
  }
});

test("aot region: a name section names the region's functions r<lowest entry>_f<entry> (profiles), and costs nothing to the code", async () => {
  const opts = { helpers: HELPERS, pcOffset: PC, memoryPages: 1 };
  const named = assembleRegion(program(), opts).bytes, bare = assembleRegion(program(), { ...opts, names: false }).bytes;
  const [section] = WebAssembly.Module.customSections(new WebAssembly.Module(named), "name");
  assert.ok(section, "a name section");
  const text = new TextDecoder().decode(section);
  for (const n of ["r00001000_dispatch", "r00001000_inner", "r00001000_exit", "r00001000_f00001000", "r00001000_f00002000"]) assert.ok(text.includes(n), n);
  assert.equal(WebAssembly.Module.customSections(new WebAssembly.Module(bare), "name").length, 0);
  // The code is the same: the module without names is a prefix of the one with them.
  assert.deepEqual(Array.from(named.slice(0, bare.length)), Array.from(bare));
  const r = await instantiate(assembleRegion(program(), opts));
  assert.equal(r.run(0x1000), 0);
  assert.equal(r.word(COUNT), 111);
});

test("aot region: branch hints from the core become a metadata.code.branch_hint section (0131)", async () => {
  // A: if (state.pc == 0x1000) { ... } with its `if` hinted unlikely; a hint on a non-`if` byte is dropped.
  const [A, B] = program();
  const ifAt = Array.from(A.code).indexOf(0x04);
  const hinted = { ...A, relocs: [...A.relocs, { offset: ifAt, kind: "hint", likely: false }, { offset: 1, kind: "hint", likely: true }] };
  const opts = { helpers: HELPERS, pcOffset: PC, memoryPages: 1 };
  const region = assembleRegion([hinted, B], opts);
  const [section] = WebAssembly.Module.customSections(new WebAssembly.Module(region.bytes), "metadata.code.branch_hint");
  assert.ok(section, "section present");
  const bytes = new Uint8Array(section);
  assert.equal(bytes[0], 1, "one function hinted");
  assert.deepEqual(Array.from(bytes.slice(2)), [1, ifAt, 1, 0], "one hint: offset, size 1, unlikely");
  assert.equal(region.hintsDropped, 1, "the hint off an `if` is counted");
  assert.deepEqual(checkBranchHintSection(region.bytes).errors, [], "a section V8 keeps");
  // Two hints on the same `if` (offsets must be strictly increasing, or V8
  // drops the whole section): that agree, one is kept; that disagree, both
  // are dropped (no guess) and counted as conflicting.
  const twice = assembleRegion([{ ...A, relocs: [...A.relocs, { offset: ifAt, kind: "hint", likely: false }, { offset: ifAt, kind: "hint", likely: false }] }, B], opts);
  assert.equal(twice.hintsDropped, 1, "the duplicate is counted");
  assert.equal(twice.hintsConflicting, 0);
  assert.deepEqual({ ...checkBranchHintSection(twice.bytes), entries: undefined }, { hints: 1, errors: [], entries: undefined });
  const clash = assembleRegion([{ ...A, relocs: [...A.relocs, { offset: ifAt, kind: "hint", likely: false }, { offset: ifAt, kind: "hint", likely: true }] }, B], opts);
  assert.equal(clash.hintsDropped, 2, "both dropped");
  assert.equal(clash.hintsConflicting, 2, "counted as conflicting");
  assert.equal(WebAssembly.Module.customSections(new WebAssembly.Module(clash.bytes), "metadata.code.branch_hint").length, 0, "no hint left: no section");
  // The checker sees a duplicate offset V8 would reject: a module built by
  // hand, one function `(if (i32.const 0) (then))` hinted twice at its `if`.
  const leb = (n) => [n];
  const sec = (id, body) => [id, ...leb(body.length), ...body];
  const nameBytes = [...new TextEncoder().encode("metadata.code.branch_hint")];
  const fnBody = [0x00, 0x41, 0x00, 0x04, 0x40, 0x0b, 0x0b]; // no locals; i32.const 0; if; end; end
  const handMade = (hintEntries) => Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
    ...sec(1, [1, 0x60, 0, 0]), ...sec(3, [1, 0]),
    ...sec(0, [nameBytes.length, ...nameBytes, 1, 0, hintEntries.length, ...hintEntries.flat()]),
    ...sec(10, [1, fnBody.length, ...fnBody])]);
  assert.deepEqual(checkBranchHintSection(handMade([[3, 1, 0]])), { hints: 1, errors: [], entries: [{ fn: 0, offset: 3, likely: false }] }, "one hint on the `if`: valid");
  assert.ok(checkBranchHintSection(handMade([[3, 1, 0], [3, 1, 0]])).errors.some((e) => /offset 3 after 3/.test(e)), "a duplicate offset is caught");
  // The checker sees what V8 would reject: a hint off an `if`, a duplicate.
  const bad = Uint8Array.from(twice.bytes);
  const [sectionBytes] = WebAssembly.Module.customSections(new WebAssembly.Module(bad), "metadata.code.branch_hint");
  const at = bad.findIndex((_, k) => new Uint8Array(sectionBytes).every((x, m) => bad[k + m] === x));
  bad[at + new Uint8Array(sectionBytes).length - 3] = 1; // the offset: on the body's local count, not an `if`
  assert.ok(checkBranchHintSection(bad).errors.length > 0, "a hint off an `if` is caught");
  const r = await instantiate(region);
  assert.equal(r.run(0x1000), 0, "runs as before");
  assert.equal(r.word(COUNT), 111);
  // without hints, no section
  assert.equal(WebAssembly.Module.customSections(new WebAssembly.Module(assembleRegion([A, B], opts).bytes), "metadata.code.branch_hint").length, 0);
});

test("aot region: the fragments table lets a warm-up call every fragment", async () => {
  const { compileAndWarm, createWarmer } = await import("../src/aot-compiler-worker.js");
  const [A, B] = program();
  const { bytes } = assembleRegion([A, B], { helpers: HELPERS, pcOffset: PC, memoryPages: 1 });
  const module = new WebAssembly.Module(bytes);
  assert.deepEqual(WebAssembly.Module.exports(module).map((e) => e.name), ["f", "fragments"]);
  const warmer = createWarmer();
  const notes = [];
  const result = await compileAndWarm(bytes, { warm: true }, warmer);
  // f, and each of the two fragments through the table
  assert.equal(result.calls, 3);
  // B's call to its helper proves a fragment body ran (the warm-up's helpers are stubs);
  // check directly that the table holds the fragments in order
  const instance = new WebAssembly.Instance(module, { env: { memory: new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true }), bump: () => notes.push("bump"), read_u32: () => 0, ...noChain() } });
  assert.equal(instance.exports.fragments.length, 2);
  instance.exports.fragments.get(1)(STATE);
  assert.deepEqual(notes, ["bump"], "table entry 1 is fragment B");
});

test("aot region: grouping keeps callers with their callees, most call sites first", () => {
  // f0 calls f2 (twice), f2 calls f3; f1 alone. Blocks: one per function.
  const module = {
    functions: [{}, {}, {}, {}],
    blocks: { func: [0, 1, 2, 3] },
    edges: { from: [0, 0, 2], to: [2, 2, 3], kind: [3, 3, 3] }
  };
  assert.deepEqual(groupRegions(module, [0, 1, 2, 3], { maxFunctions: 3 }), [[0, 2, 3], [1]]);
  // in compile order f1 first; still f0-f2 together (2 call sites) before f2-f3
  assert.deepEqual(groupRegions(module, [1, 0, 2, 3], { maxFunctions: 2 }), [[1, 3], [0, 2]], "first fit fills the earlier region");
  assert.deepEqual(groupRegions(module, [3, 2, 1, 0], { maxFunctions: 100 }), [[3, 2, 0, 1]]);
  // a function outside the order is left out
  assert.deepEqual(groupRegions(module, [0, 2, 3], { maxFunctions: 100 }), [[0, 2, 3]]);
});

test("aot region: a hub called from everywhere joins one region, the rest stay with their callers", () => {
  // f0..f5 each call hub f6; f0 calls f1, f2 calls f3, f4 calls f5 (two sites each)
  const edges = { from: [], to: [], kind: [] };
  const call = (a, b, times = 1) => { for (let i = 0; i < times; i++) { edges.from.push(a); edges.to.push(b); edges.kind.push(3); } };
  for (let f = 0; f < 6; f++) call(f, 6);
  call(0, 1, 2); call(2, 3, 2); call(4, 5, 2);
  const module = { functions: Array(7).fill({}), blocks: { func: [0, 1, 2, 3, 4, 5, 6] }, edges };
  const regions = groupRegions(module, [6, 0, 1, 2, 3, 4, 5], { maxFunctions: 3 });
  const regionOf = (f) => regions.findIndex((r) => r.includes(f));
  assert.equal(regionOf(0), regionOf(1));
  assert.equal(regionOf(2), regionOf(3));
  assert.equal(regionOf(4), regionOf(5));
  assert.ok(regions.every((r) => r.length <= 3));
  assert.equal(regions.flat().length, 7);
});

// The heap layout the fragments were translated for (the core's WasmLayoutHash:
// their code embeds RAM and L1 addresses) travels in a custom section; the
// core installs a module only under the same layout.
test("aot region: the translation layout is carried by the module, mixed layouts are refused", () => {
  const withLayout = (layout) => program().map((f) => ({ ...f, layout }));
  const region = assembleRegion(withLayout(0x8badf00d), { helpers: HELPERS, pcOffset: PC, memoryPages: 1 });
  assert.equal(region.layout, 0x8badf00d);
  assert.equal(regionModuleLayout(new WebAssembly.Module(region.bytes)), 0x8badf00d);
  assert.equal(regionModuleLayout(new WebAssembly.Module(assembleRegion(program(), { helpers: HELPERS, pcOffset: PC, memoryPages: 1 }).bytes)), 0, "no layout: 0, never installed");
  const [a, b] = withLayout(1);
  assert.throws(() => assembleRegion([a, { ...b, layout: 2 }], { helpers: HELPERS, pcOffset: PC, memoryPages: 1 }), /different layouts/);
});

// Patch 0084: a load's memarg offset holds the RAM address plus a byte
// offset (a heap site); the module lists its sites, and a copy patched for
// another heap runs there.
test("aot region: memarg-offset heap sites are listed and a module patched for another heap runs there", async () => {
  const site = (base) => ({ kind: "heap", name: "ram_base", base });
  // COUNT = mem[ram_base + 16]; state.pc = outside; return 0
  const code = [0x00, ...get, ...konst(0), 0x28, 0x02]; // store address; guest offset 0; i32.load
  const at = code.length;
  code.push(...paddedUleb(1024 + 16), 0x36, 0x02, COUNT, ...store(PC, konst(0x80009000)), ...konst(0), 0x0b);
  const G = { entry: 0x3000, entries: [0x3000], code: Uint8Array.from(code), relocs: [{ offset: at, ...site(), form: "offset" }], heapBases: [1024, 4096] };
  const region = assembleRegion([G], { helpers: HELPERS, pcOffset: PC, memoryPages: 1 });
  const heap = regionHeapOfBytes(region.bytes);
  assert.equal(heap.ramBase, 1024);
  assert.equal(heap.l1Base, 4096);
  assert.equal(heap.sites.length, 1);
  assert.deepEqual(Array.from(region.bytes.subarray(heap.sites[0].offset, heap.sites[0].offset + 5)), paddedUleb(1040), "the site, in place in the module");
  assert.equal(WebAssembly.Module.imports(new WebAssembly.Module(region.bytes)).filter((i) => i.kind === "global").length, 0, "no global");
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  const u32 = new Uint32Array(memory.buffer);
  for (const ramBase of [1024, 2048]) {
    const bytes = patchRegionHeap(region.bytes, { ramBase, l1Base: 4096 });
    assert.equal(regionHeapOfBytes(bytes).ramBase, ramBase);
    u32[(ramBase + 16) / 4] = ramBase + 7;
    const { instance } = await WebAssembly.instantiate(bytes, { env: { memory, bump: () => {}, read_u32: () => 0 } });
    u32[(STATE + PC) / 4] = 0x3000;
    assert.equal(instance.exports.f(STATE), 0);
    assert.equal(u32[(STATE + COUNT) / 4], ramBase + 7, `reads at ${ramBase}`);
  }
  assert.equal(patchRegionHeap(region.bytes, { ramBase: 1024, l1Base: 4096 }), region.bytes, "nothing to move: the same bytes");
  // Without heap sites, no section (modules with no memory access).
  assert.equal(regionHeapOfBytes(assembleRegion(program(), { helpers: HELPERS, pcOffset: PC, memoryPages: 1 }).bytes), null);
  // A site must hold its base (plus less than 64 KiB), and the bases are given.
  assert.throws(() => assembleRegion([{ ...G, heapBases: [8192, 4096] }], { helpers: HELPERS, pcOffset: PC, memoryPages: 1 }), /does not hold ram_base/);
  assert.throws(() => assembleRegion([{ ...G, heapBases: undefined }], { helpers: HELPERS, pcOffset: PC, memoryPages: 1 }), /heapBases required/);
  assert.throws(() => assembleRegion([G, { ...G, entry: 0x4000, entries: [0x4000], heapBases: [2048, 4096] }], { helpers: HELPERS, pcOffset: PC, memoryPages: 1 }), /different heaps/);
});

// Chaining (0102), heap sites (0084) and names together: the chained module's
// sites are listed at their place, it is patched for another heap, carries
// its names, and its exit still asks region_chain.
test("aot region: a chained module with heap sites and names is patched and runs (0102 with 0084)", async () => {
  const code = [0x00, ...get, ...konst(0), 0x28, 0x02];
  const at = code.length;
  code.push(...paddedUleb(1024 + 16), 0x36, 0x02, COUNT, ...store(PC, konst(0x80009000)), ...get, 0x12, ...paddedUleb(0), 0x0b);
  const G = { entry: 0x3000, entries: [0x3000], code: Uint8Array.from(code), relocs: [{ offset: at, kind: "heap", name: "ram_base", form: "offset" }, { offset: code.length - 6, kind: "jump", targetPc: 0x80009000 }], heapBases: [1024, 4096] };
  const region = assembleRegion([G], { helpers: HELPERS, pcOffset: PC, memoryPages: 1, chain: true });
  const heap = regionHeapOfBytes(region.bytes);
  assert.deepEqual(Array.from(region.bytes.subarray(heap.sites[0].offset, heap.sites[0].offset + 5)), paddedUleb(1040));
  assert.ok(new TextDecoder().decode(WebAssembly.Module.customSections(new WebAssembly.Module(region.bytes), "name")[0]).includes("r00003000_f00003000"));
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  const u32 = new Uint32Array(memory.buffer);
  const asked = [];
  const chain = { region_chain: (state) => { asked.push(u32[(state + PC) / 4]); return 0; }, table: new WebAssembly.Table({ element: "anyfunc", initial: 1 }) };
  const bytes = patchRegionHeap(region.bytes, { ramBase: 2048, l1Base: 4096 });
  u32[(2048 + 16) / 4] = 2055;
  const { instance } = await WebAssembly.instantiate(bytes, { env: { memory, bump: () => {}, read_u32: () => 0, ...chain } });
  u32[(STATE + PC) / 4] = 0x3000;
  assert.equal(instance.exports.f(STATE), 0);
  assert.equal(u32[(STATE + COUNT) / 4], 2055, "read through the patched site");
  assert.deepEqual(asked, [0x80009000], "the exit asked for the next region");
});

// The form the core emits (0084): main's i32.const base; offset; i32.add,
// with the base as a 5-byte padded signed LEB listed as a site.
test("aot region: i32.const heap sites hold the base itself and are patched in place", async () => {
  // COUNT = mem[ram_base + 16]
  const code = [0x00, ...get, 0x41];
  const at = code.length;
  code.push(...paddedSleb(1024), ...konst(16), 0x6a, 0x28, 0x02, 0x00, 0x36, 0x02, COUNT, ...store(PC, konst(0x80009000)), ...konst(0), 0x0b);
  const G = { entry: 0x3000, entries: [0x3000], code: Uint8Array.from(code), relocs: [{ offset: at, kind: "heap", name: "ram_base" }], heapBases: [1024, 4096] };
  const region = assembleRegion([G], { helpers: HELPERS, pcOffset: PC, memoryPages: 1 });
  const [s0] = regionHeapOfBytes(region.bytes).sites;
  assert.deepEqual([s0.kind, s0.form], [0, 0]);
  assert.equal(region.bytes[s0.offset - 1], 0x41, "an i32.const");
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  const u32 = new Uint32Array(memory.buffer);
  for (const ramBase of [1024, 2048, 0x7ff0]) {
    const bytes = patchRegionHeap(region.bytes, { ramBase, l1Base: 4096 });
    assert.deepEqual(Array.from(bytes.subarray(s0.offset, s0.offset + 5)), paddedSleb(ramBase), "the immediate is the base");
    // outside the 5 bytes of the site and the section's two bases, the bytes do not move
    const marker = new TextEncoder().encode("region-heap");
    const basesAt = bytes.findIndex((_, i) => marker.every((c, k) => bytes[i + k] === c)) + marker.length;
    const diff = Array.from(bytes).flatMap((b, i) => (b !== region.bytes[i] ? [i] : []));
    assert.ok(diff.every((i) => (i >= s0.offset && i < s0.offset + 5) || (i >= basesAt && i < basesAt + 8)), `only the site and the section change (${diff})`);
    u32[(ramBase + 16) / 4] = ramBase + 7;
    const { instance } = await WebAssembly.instantiate(bytes, { env: { memory, bump: () => {}, read_u32: () => 0 } });
    u32[(STATE + PC) / 4] = 0x3000;
    assert.equal(instance.exports.f(STATE), 0);
    assert.equal(u32[(STATE + COUNT) / 4], ramBase + 7, `reads at ${ramBase}`);
  }
  // A negative base (a heap over 2 GiB) keeps its sign extension.
  assert.deepEqual(paddedSleb(0x80001000), [0x80, 0xa0, 0x80, 0x80, 0x78]);
  // The site must hold the base exactly.
  assert.throws(() => assembleRegion([{ ...G, heapBases: [1040, 4096] }], { helpers: HELPERS, pcOffset: PC, memoryPages: 1 }), /does not hold ram_base/);
});

// Review of #71: a region-heap section that does not parse is an error, never
// "no section" (the module would go unpatched); sites are checked even when
// nothing moves.
test("aot region: a malformed heap section throws; sites are checked even when nothing moves", () => {
  const code = [0x00, ...get, 0x41];
  const at = code.length;
  code.push(...paddedSleb(1024), ...konst(16), 0x6a, 0x28, 0x02, 0x00, 0x36, 0x02, COUNT, ...store(PC, konst(0x80009000)), ...konst(0), 0x0b);
  const G = { entry: 0x3000, entries: [0x3000], code: Uint8Array.from(code), relocs: [{ offset: at, kind: "heap", name: "ram_base" }], heapBases: [1024, 4096] };
  const { bytes } = assembleRegion([G], { helpers: HELPERS, pcOffset: PC, memoryPages: 1 });
  const heap = regionHeapOfBytes(bytes);
  // the count word (third word of the section): one site too many
  const name = new TextEncoder().encode("region-heap");
  const nameAt = bytes.findIndex((_, i) => name.every((c, k) => bytes[i + k] === c));
  const bad = Uint8Array.from(bytes);
  bad[nameAt + name.length + 8] += 1;
  assert.throws(() => regionHeapOfBytes(bad), /malformed module/);
  assert.throws(() => patchRegionHeap(bad, { ramBase: 2048, l1Base: 4096 }), /malformed module/);
  // a section running past the end of the bytes (cut inside region-heap)
  assert.throws(() => regionHeapOfBytes(bytes.subarray(0, nameAt + name.length + 6)), /malformed module/);
  // a site that does not hold its base, same bases: still refused
  const tampered = Uint8Array.from(bytes);
  tampered.set(paddedSleb(1028), heap.sites[0].offset);
  assert.throws(() => patchRegionHeap(tampered, { ramBase: 1024, l1Base: 4096 }), /does not hold its base/);
  // fragments with known bases and no site: the section is still written
  const none = { entry: 0x3000, entries: [0x3000], code: Uint8Array.from([0x00, ...konst(0), 0x0b]), relocs: [], heapBases: [1024, 4096] };
  assert.deepEqual(regionHeapOfBytes(assembleRegion([none], { helpers: HELPERS, pcOffset: PC, memoryPages: 1 }).bytes), { ramBase: 1024, l1Base: 4096, sites: [] });
});
