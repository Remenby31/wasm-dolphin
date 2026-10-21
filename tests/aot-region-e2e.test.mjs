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
import { assembleRegion, groupRegions, paddedUleb, regionModuleKey } from "../src/aot-region-module.js";
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

const KEY_PARTS = { compilerVersion: 1, codegenMask: 0 };

async function buildRegions({ maxFunctions }) {
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
    regions: await Promise.all(groups.map(async (members) => {
      const functions = members.map((i) => module.functions[i]);
      const assembled = assembleRegion(functions.map(translate), { helpers: HELPERS, pcOffset: PC, memoryPages: 1 });
      return { key: await regionModuleKey(functions, KEY_PARTS), bytes: assembled.bytes, functions };
    }))
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
  const { labels, plan, regions } = await buildRegions({ maxFunctions: 2 });
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
  const first = await buildRegions({ maxFunctions: 5 });
  assert.equal(first.regions.length, 1);
  const [region] = first.regions;
  const patched = { ...region.functions[1], sha256: "f".repeat(64) };
  const newKey = await regionModuleKey([region.functions[0], patched, ...region.functions.slice(2)], KEY_PARTS);
  assert.notEqual(newKey, region.key);
  assert.match(region.key, /^region-v1:00000001:00000000:[0-9a-f]{64}$/);
  // membership and order are part of the key too
  assert.notEqual(await regionModuleKey(region.functions.slice(1), KEY_PARTS), region.key);
  assert.notEqual(await regionModuleKey([...region.functions].reverse(), KEY_PARTS), region.key);
  assert.notEqual(await regionModuleKey(region.functions, { ...KEY_PARTS, codegenMask: 4 }), region.key);

  const storage = fakeCacheStorage();
  const openCache = (identity) => openAotCache({ ...identity, baseUrl: BASE, cacheStorage: storage, serviceWorker: false });
  await (await openCache(IDENTITY)).put([{ key: region.key, bytes: region.bytes }]);
  const loader = createAotRegionLoader({ openCache, retain: () => {} });
  const report = await loader.load({ ...IDENTITY, keys: [newKey] });
  assert.equal(report.loaded, 0, "missing, so left to the JIT and compiled again");
});

test("assembled regions warm off-thread on a scratch memory and keep running correctly", async () => {
  const { regions } = await buildRegions({ maxFunctions: 5 });
  const warmer = createWarmer();
  for (const r of regions) {
    const result = await compileAndWarm(r.bytes, { warm: true }, warmer);
    assert.equal(result.warmed, true);
    assert.equal(result.calls, 1 + r.functions.length, "the dispatcher, then every fragment through the table");
    const run = runner(result.module);
    for (const f of r.functions) assert.equal(run.run(f.entry), 0);
    assert.equal(run.word(COUNT), r.functions.length);
  }
});

test("region modules declare a one-page memory minimum with the core's maximum", async () => {
  const { parseWasmImports } = await import("../src/aot-compiler-worker.js");
  const frag = translate({ entry: 0x80003100 });
  const { bytes } = assembleRegion([frag], { helpers: HELPERS, pcOffset: PC, memoryPages: 24576 });
  const memory = parseWasmImports(bytes).find((i) => i.kind === "memory");
  assert.deepEqual({ initial: memory.initial, maximum: memory.maximum, shared: memory.shared }, { initial: 1, maximum: 24576, shared: true });
  assert.throws(() => assembleRegion([frag], { helpers: HELPERS, pcOffset: PC, memoryPages: 1, memoryMinPages: 2 }), /memory limits/);
  assert.throws(() => assembleRegion([frag], { helpers: HELPERS, pcOffset: PC }), /memoryPages/);
});

// A second stand-in translator exercising every exit of the contract: member
// k jumps to member k+1 inside the region (jump reloc), the last member
// returns through a dispatch to a PC outside the region (internal
// dispatcher: 0), and HALT_ENTRY returns 2 (halted).
function chainTranslate(members, haltEntry = null) {
  const get = [0x20, 0x00];
  return members.map((f, k) => {
    const code = [0x00];
    const relocs = [];
    code.push(...get, ...get, 0x28, 0x02, COUNT, 0x41, 0x01, 0x6a, 0x36, 0x02, COUNT);
    code.push(...get, 0x41, ...sleb(f.entry), 0x36, 0x02, LAST);
    if (f.entry === haltEntry) {
      code.push(0x41, 0x02, 0x0b);
      return { entry: f.entry, entries: [f.entry], code: Uint8Array.from(code), relocs };
    }
    const next = members[k + 1];
    code.push(...get, 0x41, ...sleb(next ? next.entry : OUTSIDE), 0x36, 0x02, PC);
    code.push(...get, 0x12);
    relocs.push({ offset: code.length, ...(next ? { kind: "jump", targetPc: next.entry } : { kind: "dispatch" }) });
    code.push(...paddedUleb(0), 0x0b);
    return { entry: f.entry, entries: [f.entry], code: Uint8Array.from(code), relocs };
  });
}

test("every exit of the contract through cache and loader: internal jumps, dispatch out of the region (0), halt (2), not an entry (1)", async () => {
  const { regions } = await buildRegions({ maxFunctions: 5 });
  const [region] = regions;
  const members = region.functions;
  const halt = members[members.length - 1].entry;
  const variants = [
    { name: "chain", bytes: assembleRegion(chainTranslate(members), { helpers: HELPERS, pcOffset: PC, memoryPages: 1 }).bytes },
    { name: "halt", bytes: assembleRegion(chainTranslate(members, halt), { helpers: HELPERS, pcOffset: PC, memoryPages: 1 }).bytes }
  ];
  const storage = fakeCacheStorage();
  const openCache = (identity) => openAotCache({ ...identity, baseUrl: BASE, cacheStorage: storage, serviceWorker: false });
  const keys = await Promise.all(variants.map((v, i) => regionModuleKey(members, { ...KEY_PARTS, codegenMask: i })));
  await (await openCache(IDENTITY)).put(variants.map((v, i) => ({ key: keys[i], bytes: v.bytes })));
  const retained = new Map();
  const loader = createAotRegionLoader({ openCache, retain: (k, m) => retained.set(k, m) });
  assert.equal((await loader.load({ ...IDENTITY, keys })).loaded, 2);

  const chain = runner(retained.get(keys[0]));
  assert.equal(chain.run(members[0].entry), 0, "ran every member through internal jumps, then dispatched out");
  assert.equal(chain.word(COUNT), members.length);
  assert.equal(chain.word(PC), OUTSIDE);
  assert.equal(chain.word(LAST), members.at(-1).entry);
  assert.equal(chain.run(0x80000000), 1, "not an entry");
  assert.equal(chain.word(COUNT), members.length, "and nothing ran");

  const halting = runner(retained.get(keys[1]));
  assert.equal(halting.run(members[0].entry), 2, "halted in the last member");
  assert.equal(halting.word(COUNT), members.length);
});

test("module keys: extra entries are part of the key, versions must be u32", async () => {
  const { regions } = await buildRegions({ maxFunctions: 5 });
  const members = regions[0].functions;
  const base = await regionModuleKey(members, KEY_PARTS);
  const withExtra = await regionModuleKey([{ ...members[0], extraEntries: [members[0].entry + 8] }, ...members.slice(1)], KEY_PARTS);
  assert.notEqual(withExtra, base);
  await assert.rejects(regionModuleKey(members, { compilerVersion: "region-1", codegenMask: 0 }), /u32/);
  await assert.rejects(regionModuleKey(members, { compilerVersion: 1, codegenMask: -1 }), /u32/);
});

test("optimizer -> cache -> bootKeys -> loader: the first launch's modules come back on the next one", async () => {
  const { AotOptimizer } = await import("../src/aot-optimizer.js");
  const { dol } = program();
  const { image, entryPoint } = imageFromDol(dol);
  const plan = planDol({ image, entryPoint, gameId: "TEST01", dolBytes: dol, options: { gapFill: false } });
  const storage = fakeCacheStorage();
  const openCache = (identity) => openAotCache({ ...identity, ...IDENTITY, baseUrl: BASE, cacheStorage: storage, serviceWorker: false });
  // the core's translator, stood in for: one fragment per function
  const translator = { translate: async (fns) => fns.map((f) => ({ entry: f.entry, fragment: translate(f) })) };
  // the plan store keeps the plan for the next launch: boot keys never plan
  const plans = new Map();
  const planStore = { load: async (k) => plans.get(k) ?? null, save: async (k, p) => { plans.set(k, p); } };
  const make = () => new AotOptimizer({
    discKey: "disc", buildPlan: async () => plan, translator, openCache, keyParts: KEY_PARTS, maxFunctions: 2, planStore,
    assembleOptions: { helpers: HELPERS, pcOffset: PC, memoryPages: 1 }
  });
  const first = make();
  await first.start();
  assert.deepEqual(await first.status(), { state: "complete", fraction: 1 });

  const next = make();
  const keys = await next.bootKeys();
  assert.deepEqual(keys, next.regions.map((u) => u.key), "every module, in compile order");
  const retained = new Map();
  const loader = createAotRegionLoader({ openCache, retain: (k, m) => retained.set(k, m) });
  const report = await loader.load({ ...IDENTITY, keys, budgetMs: 1000 });
  assert.equal(report.loaded, keys.length);
  for (const u of next.regions) {
    const run = runner(retained.get(u.key));
    for (const f of u.members) assert.equal(run.run(f.entry), 0);
    assert.equal(run.word(COUNT), u.members.length);
  }
});
