import assert from "node:assert/strict";
import test from "node:test";

import { assembleRegion, groupRegions, paddedUleb } from "../src/aot-region-module.js";

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
  assert.throws(() => assembleRegion([], { helpers: HELPERS, pcOffset: 0 }), /no fragments/);
  assert.throws(() => assembleRegion([A, { ...B, entries: [0x2000, 0x1000] }], { helpers: HELPERS, pcOffset: 0 }), /declared twice/);
  assert.throws(() => assembleRegion([A, { ...B, relocs: [{ offset: 0, kind: "import", name: "nope" }] }], { helpers: HELPERS, pcOffset: 0 }), /unknown helper/);
  assert.throws(() => assembleRegion([{ ...A, relocs: [{ offset: A.code.length - 2, kind: "dispatch" }] }], { helpers: HELPERS, pcOffset: 0 }), /outside the code/);
  assert.throws(() => assembleRegion([{ ...A, entries: [0x1004] }], { helpers: HELPERS, pcOffset: 0 }), /own entry/);
});

test("aot region: grouping follows calls in compile order", () => {
  // f0 calls f2, f2 calls f3; f1 alone. Blocks: one per function.
  const module = {
    functions: [{}, {}, {}, {}],
    blocks: { func: [0, 1, 2, 3] },
    edges: { from: [0, 2], to: [2, 3], kind: [3, 3] }
  };
  assert.deepEqual(groupRegions(module, [0, 1, 2, 3], { maxFunctions: 3 }), [[0, 2, 3], [1]]);
  assert.deepEqual(groupRegions(module, [1, 0, 2, 3], { maxFunctions: 2 }), [[1, 0], [2, 3]], "filled up with the next seeds");
  assert.deepEqual(groupRegions(module, [3, 2, 1, 0], { maxFunctions: 100 }), [[3, 2, 1, 0]]);
});
