import assert from "node:assert/strict";
import test from "node:test";

import { imageFromDol } from "../src/aot-image.js";
import { AotOptimizer, fakeCache, fakeTranslator } from "../src/aot-optimizer.js";
import { planDol } from "../src/aot-plan.js";
import { asm, assemble, buildDol } from "./aot-asm.mjs";

const TEXT = 0x80003100;

// Entry calling N small functions of growing size.
function plan(n = 40) {
  const items = ["entry"];
  for (let i = 0; i < n; i++) items.push((pc, l) => asm.bl(pc, l[`f${i}`]));
  items.push(asm.blr());
  for (let i = 0; i < n; i++) {
    items.push(`f${i}`);
    for (let k = 0; k <= i; k++) items.push(asm.li(3, i * 100 + k));
    items.push(asm.blr());
  }
  const t = assemble(TEXT, items);
  const { image, entryPoint } = imageFromDol(buildDol({ textAddr: TEXT, text: t.words, entry: t.labels.entry }));
  return planDol({ image, entryPoint, options: { gapFill: false } });
}

function optimizer({ cache = fakeCache(), translator = fakeTranslator(), ...extra } = {}) {
  const p = plan();
  let builds = 0;
  // regions of 8 functions: the 41 functions of the plan make several modules
  const o = new AotOptimizer({
    discKey: "disc", cacheIdentity: { compilerVersion: "fake-1" }, openCache: cache, translator, maxFunctions: 8,
    assembleOptions: { helpers: {}, pcOffset: 0, memoryPages: 1 }, buildPlan: async () => { builds++; return p; }, ...extra
  });
  const events = [];
  for (const type of ["optimization-progress", "optimization-done", "optimization-error"]) o.addEventListener(type, (e) => events.push([type, e.detail]));
  return { o, events, builds: () => builds };
}

test("aot optimizer: first launch compiles every region, second launch is complete", async () => {
  const cache = fakeCache();
  const { o, events } = optimizer({ cache });
  assert.deepEqual(await o.status(), { state: "none", fraction: 0 });
  await o.start();
  const fractions = events.filter(([t]) => t === "optimization-progress").map(([, d]) => d.fraction);
  assert.ok(fractions.every((f, i) => !i || f >= fractions[i - 1]), "progress is monotonic");
  assert.equal(fractions.at(-1), 1);
  assert.equal(events.at(-1)[0], "optimization-done");
  const again = optimizer({ cache });
  assert.deepEqual(await again.o.status(), { state: "complete", fraction: 1 });
});

test("aot optimizer: cancel keeps what was compiled and a restart resumes", async () => {
  const cache = fakeCache();
  const translator = fakeTranslator({ msPerKiB: 40 });
  const first = optimizer({ cache, translator, batchSize: 4 });
  first.o.addEventListener("optimization-progress", (e) => { if (e.detail.done > 0) first.o.cancel(); });
  await first.o.start();
  assert.ok(!first.events.some(([t]) => t === "optimization-done"));
  const st = await first.o.status();
  assert.equal(st.state, "partial");
  const before = cache.persisted.size;
  const second = optimizer({ cache, translator });
  await second.o.start({ resume: true });
  assert.deepEqual(await second.o.status(), { state: "complete", fraction: 1 });
  const submitted = second.events.filter(([t]) => t === "optimization-progress")[0][1].done;
  assert.ok(submitted >= before - 1, "the restart starts from the persisted regions");
});

test("aot optimizer: a refused function is left out of its module; refused modules are not fatal; progress ends at 1", async () => {
  const p = plan();
  const refuse = new Set([p.modules[0].functions[3].hash]);
  const quotaCache = fakeCache();
  const probe = optimizer({ cache: quotaCache });
  await probe.o.status();
  const quotaKey = probe.o.regions[1].key;
  const cache = fakeCache({ quotaKeys: new Set([quotaKey]) });
  const { o, events } = optimizer({ translator: fakeTranslator({ refuse }), cache });
  await o.start();
  const errors = events.filter(([t]) => t === "optimization-error").map(([, d]) => d);
  assert.equal(errors.length, 2, "one function refused by the translator, one module by the cache");
  assert.ok(errors.every((e) => e.fatal === false));
  assert.equal(events.at(-1)[0], "optimization-done");
  // a full quota is no verdict: retried at the next launch, not blacklisted
  assert.deepEqual([events.at(-1)[1].refused, events.at(-1)[1].deferred], [0, 1]);
  assert.equal(cache.persisted.size, o.regions.length - 1);
  // the module holding the refused function was still stored, without it
  const holder = o.regions.find((u) => u.members.some((f) => f.hash === p.modules[0].functions[3].hash));
  assert.ok(cache.persisted.has(holder.key));
  assert.equal((await o.status()).state, "partial");
});

test("aot optimizer: the plan is cached and a stale or broken cached plan is rebuilt", async () => {
  const saved = new Map();
  const planStore = { load: async (k) => saved.get(k) ?? null, save: async (k, p) => { saved.set(k, p); } };
  const a = optimizer({ planStore });
  await a.o.status();
  assert.equal(a.builds(), 1);
  const b = optimizer({ planStore });
  await b.o.status();
  assert.equal(b.builds(), 0, "second launch reuses the cached plan");
  saved.set("disc", { ...saved.get("disc"), analyzer: -1 });
  const c = optimizer({ planStore });
  await c.o.status();
  assert.equal(c.builds(), 1);
});

test("aot optimizer: a compiler that cannot open is a fatal error, never a throw", async () => {
  const { o, events } = optimizer({ cache: async () => { throw new Error("no worker"); } });
  await o.start();
  assert.deepEqual(events.at(-1), ["optimization-error", { message: "no worker", fatal: true }]);
});

test("aot optimizer: core slices (budget), waits before boot (not-ready), skips blacklisted keys", async () => {
  const p = plan();
  void p;
  const probe = optimizer();
  await probe.o.status();
  const blackKey = probe.o.regions[2].key;
  let sleeps = 0;
  const cache = fakeCache({ blacklist: new Set([blackKey]) });
  const { o, events } = optimizer({ cache, keyParts: { compilerVersion: 0, codegenMask: 0 }, translator: fakeTranslator({ perCall: 3, notReadyCalls: 2 }), sleep: async () => { sleeps++; } });
  await o.start();
  assert.equal(events.at(-1)[0], "optimization-done");
  assert.equal(events.at(-1)[1].refused, 1, "the blacklisted key is skipped, not retried");
  assert.ok(sleeps >= 2, "not-ready waits before retrying");
  assert.ok([...cache.persisted.keys()].every((k) => /^region-v1:00000000:00000000:[0-9a-f]{64}$/.test(k)), "module keys");
  assert.equal(cache.persisted.size, o.regions.length - 1);
  assert.deepEqual(await o.status(), { state: "complete", fraction: 1 });
});

// A core with region chaining (patch 0102) gets chained modules under their
// own keys: a module cached before it (region-v1, no chaining stub) is never
// found for it, nor a chained one for an older core.
test("aot optimizer: with chain the modules are keyed region-v2 and chain; a region-v1 cache entry is never taken", async () => {
  const cache = fakeCache();
  const plain = optimizer({ cache: fakeCache(), keyParts: { compilerVersion: 5, codegenMask: 0 } });
  await plain.o.start();
  const v1 = new Set(plain.o.regions.map((u) => u.key));
  assert.ok([...v1].every((k) => k.startsWith("region-v1:")));
  const { o } = optimizer({ cache, keyParts: { compilerVersion: 5, codegenMask: 0 }, assembleOptions: { helpers: {}, pcOffset: 0, memoryPages: 1, chain: true } });
  await o.start();
  assert.ok(o.regions.length > 0);
  for (const u of o.regions) {
    assert.match(u.key, /^region-v2:00000005:00000000:[0-9a-f]{64}$/);
    assert.equal(v1.has(u.key), false, "never a region-v1 key");
    const names = WebAssembly.Module.imports(new WebAssembly.Module(cache.persisted.get(u.key))).map((i) => i.name);
    assert.ok(names.includes("region_chain") && names.includes("table"), "a chained module");
  }
});

test("aot optimizer: a module's key is regionModuleKey of its planned members; stored bytes are an assembled module", async () => {
  const { regionModuleKey } = await import("../src/aot-region-module.js");
  const cache = fakeCache();
  const { o } = optimizer({ cache, keyParts: { compilerVersion: 3, codegenMask: 0x10 } });
  await o.start();
  for (const u of o.regions) {
    assert.equal(u.key, await regionModuleKey(u.members, { compilerVersion: 3, codegenMask: 0x10 }));
    assert.ok(u.members.length <= 8);
    const module = new WebAssembly.Module(cache.persisted.get(u.key));
    assert.deepEqual(WebAssembly.Module.exports(module).map((e) => e.name), ["f", "fragments"]);
  }
  // every function of the plan is in exactly one module
  const all = o.regions.flatMap((u) => u.members.map((f) => f.entry)).sort((a, b) => a - b);
  assert.equal(new Set(all).size, all.length);
  assert.equal(all.length, o.plan.modules[0].functions.length);
});

test("aot optimizer: translator results out of batch order are a fatal error, nothing stored", async () => {
  const cache = fakeCache();
  const translator = { translate: async (fns) => fns.map((r, i) => ({ entry: fns[(i + 1) % fns.length].entry, fragment: null })) };
  const { o, events } = optimizer({ cache, translator });
  await o.start();
  assert.deepEqual(events.at(-1), ["optimization-error", { message: "translator results out of order", fatal: true }]);
  assert.equal(cache.persisted.size, 0);
});

test("aot optimizer: refusals are blacklisted in the cache, boot keys follow the compile order", async () => {
  const p = plan();
  // every function of one module refused: that module is blacklisted
  const probe = optimizer();
  await probe.o.status();
  const target = probe.o.regions[1];
  const refuse = new Set(target.members.map((f) => f.hash));
  const blacklist = new Set();
  const cache = fakeCache({ blacklist });
  const { o } = optimizer({ cache, translator: fakeTranslator({ refuse }) });
  await o.start();
  assert.ok(blacklist.has(target.key), "a module with nothing translatable is remembered across reloads");
  void p;
  const keys = await o.bootKeys();
  assert.deepEqual(keys, o.regions.map((r) => r.key).filter((k) => !blacklist.has(k)));
});

test("aot optimizer: groups survive a plan rebuilt with a new profile, so the cache keeps hitting", async () => {
  const groups = new Map();
  const planStore = {
    load: async () => null, save: async () => {},
    loadGroups: async (k) => groups.get(k) ?? null, saveGroups: async (k, g) => { groups.set(k, g); }
  };
  const cache = fakeCache();
  const first = optimizer({ cache, planStore });
  await first.o.start();
  const keysBefore = await first.o.bootKeys();
  assert.equal(keysBefore.length, first.o.regions.length);
  // a new profile reorders the functions: hot ones first
  const p = plan();
  p.modules[0].functions.forEach((f, i) => { f.profileHits = i; });
  const rebuilt = optimizer({ cache, planStore, buildPlan: async () => p });
  await rebuilt.o.getPlan(); // after the boot: boot keys never plan
  assert.deepEqual(new Set(await rebuilt.o.bootKeys()), new Set(keysBefore), "same modules, same keys");
  // without stored groups, the new order regroups and the keys change
  const fresh = optimizer({ cache, buildPlan: async () => p });
  await fresh.o.getPlan();
  const freshKeys = await fresh.o.bootKeys();
  assert.ok(freshKeys.length < keysBefore.length, "regrouping misses the cache");
  // a stored group whose member changed is regrouped, the others kept
  const changed = plan();
  changed.modules[0].functions[5].sha256 = "e".repeat(64);
  const partly = optimizer({ cache, planStore, buildPlan: async () => changed });
  await partly.o.getPlan();
  const kept = new Set(await partly.o.bootKeys());
  assert.equal(kept.size, keysBefore.length - 1, "only the group holding the changed function misses");
});
