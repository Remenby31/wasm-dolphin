// End to end, without the core: plan -> regions -> assembled modules -> cache
// -> loader -> the retained Modules run. The translator is a stand-in with the
// core's fragment contract (src/aot-region-module.js): each PowerPC function
// becomes a fragment that counts its own visit and leaves the region. What is
// real: discovery and plan (aot-plan), grouping and assembly
// (aot-region-module), the region cache and its keys (aot-cache), the loader
// (aot-region-loader), and the off-thread warm-up (aot-compiler-worker).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { openAotCache } from "../src/aot-cache.js";
import { compileAndWarm, createWarmer } from "../src/aot-compiler-worker.js";
import { imageFromDol } from "../src/aot-image.js";
import { orderedRegions, planDol, validatePlan } from "../src/aot-plan.js";
import { createAotRegionLoader } from "../src/aot-region-loader.js";
import { assembleRegion, groupRegions, paddedUleb } from "../src/aot-region-module.js";
import { asm, assemble, buildDol } from "./aot-asm.mjs";
import { fakeCacheStorage } from "./helpers/fake-cache-storage.mjs";

const TEXT = 0x80003100;
const BASE = "http://127.0.0.1:8090/";
const IDENTITY = { discKey: `disc-sha256-v1:${"1".repeat(64)}`, coreHash: "a".repeat(64), compilerVersion: "region-1", flagsMask: 0 };
// State layout of the stand-in: pc at +0, visit counter at +4, last visited
// function at +8; the state lives at 64 in a one-page memory.
const PC = 0, COUNT = 4, LAST = 8, STATE = 64, OUTSIDE = 0x80009000;
const HELPERS = { note: { params: ["i32", "i32"], results: [] } };

// main calls a, b and c; a calls d. Five functions, a call tree.
function program() {
  const t = assemble(TEXT, [
    "main", (pc, l) => asm.bl(pc, l.a), (pc, l) => asm.bl(pc, l.b), (pc, l) => asm.bl(pc, l.c), asm.blr(),
    "a", (pc, l) => asm.bl(pc, l.d), asm.li(3, 1), asm.blr(),
    "b", asm.li(3, 2), asm.blr(),
    "c", asm.li(3, 3), asm.addi(3, 3, 1), asm.blr(),
    "d", asm.li(3, 4), asm.blr()
  ]);
  return { dol: buildDol({ textAddr: TEXT, text: t.words, entry: t.labels.main }), labels: t.labels };
}

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

// Stand-in translator: state.count += 1; state.last = entry; note(state, entry);
// state.pc = OUTSIDE; return_call (jump to OUTSIDE: the region's exit stub).
function translate(f) {
  const get = [0x20, 0x00];
  const code = [0x00];
  const relocs = [];
  code.push(...get, ...get, 0x28, 0x02, COUNT, 0x41, 0x01, 0x6a, 0x36, 0x02, COUNT);
  code.push(...get, 0x41, ...sleb(f.entry), 0x36, 0x02, LAST);
  code.push(...get, 0x41, ...sleb(f.entry), 0x10);
  relocs.push({ offset: code.length, kind: "import", name: "note" });
  code.push(...paddedUleb(0));
  code.push(...get, 0x41, ...sleb(OUTSIDE), 0x36, 0x02, PC);
  code.push(...get, 0x12);
  relocs.push({ offset: code.length, kind: "jump", targetPc: OUTSIDE });
  code.push(...paddedUleb(0));
  code.push(0x0b);
  return { entry: f.entry, entries: [f.entry], code: Uint8Array.from(code), relocs };
}

// The cache key of a region module: its member functions' guest code, in
// order (each function's sha256 already covers its bytes), so any change in
// any member gives another key. Ends with a sha256, as the cache requires.
function regionModuleKey(functions) {
  const h = createHash("sha256");
  for (const f of functions) h.update(`${f.entry.toString(16)}:${f.sha256};`);
  return `region-v1:00000001:00000000:${h.digest("hex")}`;
}

function buildRegions({ maxFunctions }) {
  const { dol, labels } = program();
  const { image, entryPoint } = imageFromDol(dol);
  const plan = validatePlan(planDol({ image, entryPoint, gameId: "TEST01", dolBytes: dol, options: { gapFill: false } }));
  const [module] = plan.modules;
  const ordered = orderedRegions(plan).filter((r) => r.module === module.id);
  const order = ordered.map((r) => module.functions.indexOf(r.f));
  const groups = groupRegions(module, order, { maxFunctions });
  return {
    labels,
    plan,
    regions: groups.map((members) => {
      const functions = members.map((i) => module.functions[i]);
      const assembled = assembleRegion(functions.map(translate), { helpers: HELPERS, pcOffset: PC, memoryPages: 1 });
      return { key: regionModuleKey(functions), bytes: assembled.bytes, functions };
    })
  };
}

function runner(module) {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  const notes = [];
  const instance = new WebAssembly.Instance(module, { env: { memory, note: (_state, pc) => notes.push(pc >>> 0) } });
  const u32 = new Uint32Array(memory.buffer);
  return {
    run(pc) {
      u32[(STATE + PC) / 4] = pc;
      return instance.exports.f(STATE);
    },
    word: (off) => u32[(STATE + off) / 4],
    notes
  };
}

test("plan -> regions -> cache -> loader: every function runs from the module the loader retained", async () => {
  const { labels, plan, regions } = buildRegions({ maxFunctions: 2 });
  assert.equal(plan.modules[0].functions.length, 5);
  assert.ok(regions.length >= 3, `${regions.length} regions of at most 2 functions`);
  // every function of the plan is in exactly one region
  const placed = regions.flatMap((r) => r.functions.map((f) => f.entry)).sort();
  assert.deepEqual(placed, Object.values(labels).sort());

  // First launch: the optimiser stores what it compiled.
  const storage = fakeCacheStorage();
  const openCache = (identity) => openAotCache({ ...identity, baseUrl: BASE, cacheStorage: storage, serviceWorker: false });
  const writer = await openCache(IDENTITY);
  assert.deepEqual((await writer.put(regions.map(({ key, bytes }) => ({ key, bytes })))).failed, []);

  // Next launch: the loader brings them back, in plan order, and retains them.
  const retained = new Map();
  const loader = createAotRegionLoader({ openCache, retain: (key, module) => retained.set(key, module) });
  const report = await loader.load({ ...IDENTITY, keys: regions.map((r) => r.key), budgetMs: 1000 });
  assert.equal(report.loaded, regions.length);
  assert.deepEqual(report.failed, []);

  // Every function of the program runs from its region's retained Module.
  for (const r of regions) {
    const run = runner(retained.get(r.key));
    for (const f of r.functions) {
      assert.equal(run.run(f.entry), 0, "continue at state.pc");
      assert.equal(run.word(PC), OUTSIDE, "left the region through the exit stub");
      assert.equal(run.word(LAST), f.entry);
    }
    assert.equal(run.word(COUNT), r.functions.length);
    assert.deepEqual(run.notes, r.functions.map((f) => f.entry));
    // a PC the region did not declare runs nothing
    assert.equal(run.run(0x80000000), 1);
    assert.equal(run.word(COUNT), r.functions.length);
  }
});

test("a changed function gives its region another key: the old module is never loaded for it", async () => {
  const first = buildRegions({ maxFunctions: 5 });
  assert.equal(first.regions.length, 1);
  const [region] = first.regions;
  const patched = { ...region.functions[1], sha256: "f".repeat(64) };
  const newKey = regionModuleKey([region.functions[0], patched, ...region.functions.slice(2)]);
  assert.notEqual(newKey, region.key);

  const storage = fakeCacheStorage();
  const openCache = (identity) => openAotCache({ ...identity, baseUrl: BASE, cacheStorage: storage, serviceWorker: false });
  await (await openCache(IDENTITY)).put([{ key: region.key, bytes: region.bytes }]);
  const loader = createAotRegionLoader({ openCache, retain: () => {} });
  const report = await loader.load({ ...IDENTITY, keys: [newKey] });
  assert.equal(report.loaded, 0, "missing, so left to the JIT and compiled again");
});

test("assembled regions warm off-thread on a scratch memory and keep running correctly", async () => {
  const { regions } = buildRegions({ maxFunctions: 5 });
  const warmer = createWarmer();
  for (const r of regions) {
    const result = await compileAndWarm(r.bytes, { warm: true }, warmer);
    assert.equal(result.warmed, true);
    assert.ok(result.calls >= 1, "the dispatcher was called");
    const run = runner(result.module);
    for (const f of r.functions) assert.equal(run.run(f.entry), 0);
    assert.equal(run.word(COUNT), r.functions.length);
  }
});
