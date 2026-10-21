import assert from "node:assert/strict";
import test from "node:test";

import { assembleRegion, groupRegions, paddedUleb, regionModuleLayout } from "../src/aot-region-module.js";

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

async function instantiate(region, { onBump = () => {} } = {}) {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  const { instance } = await WebAssembly.instantiate(region.bytes, {
    env: { memory, bump: onBump, read_u32: () => 0 }
  });
  const u32 = new Uint32Array(memory.buffer);
  return {
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

test("aot region: the dispatcher finds every entry among hundreds (binary search)", async () => {
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
  const instance = new WebAssembly.Instance(module, { env: { memory: new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true }), bump: () => notes.push("bump"), read_u32: () => 0 } });
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

// Patch 0084: a fragment reads the RAM and L1 addresses from globals, set at
// instantiation; the same module runs against a heap laid out elsewhere.
test("aot region: global relocs import env.ram_base / env.l1_base, read at instantiation", async () => {
  // COUNT = mem[ram_base + 16] + l1_base
  const G = fragment(0x3000, [0x3000], [
    get, [0x23], { kind: "global", name: "ram_base" }, [0x28, 0x02, 16],
    [0x23], { kind: "global", name: "l1_base" }, [0x6a, 0x36, 0x02, COUNT],
    store(PC, konst(0x80009000)), konst(0)
  ]);
  const region = assembleRegion([G], { helpers: HELPERS, pcOffset: PC, memoryPages: 1 });
  const imports = WebAssembly.Module.imports(new WebAssembly.Module(region.bytes));
  assert.deepEqual(imports.filter((i) => i.kind === "global").map((i) => i.name), ["ram_base", "l1_base"]);
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  const u32 = new Uint32Array(memory.buffer);
  for (const ramBase of [1024, 2048]) {
    u32[(ramBase + 16) / 4] = ramBase + 7;
    const { instance } = await WebAssembly.instantiate(region.bytes, {
      env: { memory, ram_base: new WebAssembly.Global({ value: "i32" }, ramBase), l1_base: new WebAssembly.Global({ value: "i32" }, 5) }
    });
    u32[(STATE + PC) / 4] = 0x3000;
    assert.equal(instance.exports.f(STATE), 0);
    assert.equal(u32[(STATE + COUNT) / 4], ramBase + 12);
  }
  // Without global relocs, no global import (modules of older cores).
  const plain = WebAssembly.Module.imports(new WebAssembly.Module(assembleRegion(program(), { helpers: HELPERS, pcOffset: PC, memoryPages: 1 }).bytes));
  assert.ok(!plain.some((i) => i.kind === "global"));
  // Only after global.get, and only known names.
  const misplaced = fragment(0x3000, [0x3000], [[0x41], { kind: "global", name: "ram_base" }, [0x1a], konst(1)]);
  assert.throws(() => assembleRegion([misplaced], { helpers: HELPERS, pcOffset: PC, memoryPages: 1 }), /global reloc/);
  const unknown = fragment(0x3000, [0x3000], [[0x23], { kind: "global", name: "heap" }, [0x1a], konst(1)]);
  assert.throws(() => assembleRegion([unknown], { helpers: HELPERS, pcOffset: PC, memoryPages: 1 }), /unknown global/);
});
