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

// A module the core refused at install (translated for another heap layout,
// review of #62 P1-3): translated again, live, and its entry overwritten,
// instead of being lost for every launch. Once per key and session.
test("aot optimizer: a stale module is translated again and its entry overwritten, once", async () => {
  const cache = fakeCache();
  await optimizer({ cache }).o.start();
  const installs = [];
  let translated = 0;
  const base = fakeTranslator();
  const translator = { translate: (batch) => { translated += batch.length; return base.translate(batch); } };
  const { o, events } = optimizer({ cache, translator, install: (r) => installs.push(r.key) });
  await o.start();
  assert.equal(translated, 0, "a second launch translates nothing");
  const [stale] = await o.bootKeys();
  cache.persisted.set(stale, Uint8Array.of(0)); // stands for the refused module
  assert.equal(await o.markStale(stale), true);
  assert.equal(await o.markStale(stale), false, "once per session");
  assert.equal(await o.markStale("region-v1:unknown"), false, "only modules of the plan");
  await o.start();
  assert.ok(translated > 0 && translated <= 8, "only the stale module's members");
  assert.deepEqual(installs, [stale], "the new module goes to the core");
  assert.notDeepEqual(cache.persisted.get(stale), Uint8Array.of(0), "entry overwritten");
  assert.equal(o.stale.size, 0);
  assert.equal(events.at(-1)[0], "optimization-done");
});

// Marked while a run goes: the same run takes it after its own work.
test("aot optimizer: a module marked stale during a run is done by that run", async () => {
  const cache = fakeCache();
  await optimizer({ cache }).o.start();
  const { o, events } = optimizer({ cache, translator: fakeTranslator({ msPerKiB: 5 }) });
  await o.getPlan(); // bootKeys never plans
  const [first, second] = await o.bootKeys();
  cache.persisted.delete(first); // the run has one module to do
  o.addEventListener("optimization-start", () => o.markStale(second), { once: true });
  const before = cache.persisted.get(second);
  await o.start();
  assert.ok(cache.persisted.has(first), JSON.stringify(events));
  assert.ok(second);
  assert.notEqual(cache.persisted.get(second), before, "rewritten by the same run");
  assert.equal(o.stale.size, 0);
});

// Research deep-first-minute: module n+1 is translated while module n
// compiles and goes to the cache; modules still install in order, each
// before its cache write.
test("aot optimizer: the next module translates while the previous one compiles; installs stay in order", async () => {
  const log = [];
  const base = fakeTranslator();
  const translator = { translate: async (batch) => { log.push(`translate ${batch[0].entry.toString(16)}`); return base.translate(batch); } };
  const releases = [];
  const compile = (key) => new Promise((resolve) => { log.push(`compile ${key.slice(-6)}`); releases.push(() => resolve({ module: {} })); });
  const installed = [];
  const { o } = optimizer({ translator, compile, install: (r) => { installed.push(r.key); log.push(`install ${r.key.slice(-6)}`); } });
  const run = o.start();
  // The first module waits in its compile: the second one translates meanwhile.
  const translations = () => log.filter((l) => l.startsWith("translate")).length;
  for (let i = 0; i < 400 && !(releases.length && translations() >= 2); i++) await new Promise((r) => setTimeout(r, 0));
  assert.equal(installed.length, 0, "the first module has not compiled yet");
  assert.equal(releases.length, 1, "one compile pending");
  assert.ok(translations() >= 2, `the next module translated meanwhile (${translations()})`);
  // Release the compiles as they come: everything ends, in order.
  for (let i = 0; i < 2000; i++) {
    if (releases.length) releases.shift()();
    await new Promise((r) => setTimeout(r, 0));
    if (o.regions && installed.length === o.regions.length) break;
  }
  await run;
  assert.deepEqual(installed, o.regions.map((u) => u.key), "installed in compile order");
});

// Review of #144: a cancel during a module's compile is no verdict. The
// module still installs (this session runs it), but it is neither stored
// nor blacklisted, and the next launch translates it again.
test("aot optimizer: a cancel during a compile installs the module, never blacklists it, and the next launch retries it", async () => {
  const cache = fakeCache();
  const installed = [];
  let first = null;
  let o;
  const compile = async (key) => {
    if (!first) { first = key; o.cancel(); }
    return { module: {} };
  };
  ({ o } = optimizer({ cache, compile, install: (r) => installed.push(r.key) }));
  await o.start();
  assert.deepEqual(installed, [first], "installed for this session");
  const session = await cache({});
  assert.equal(session.isBlacklisted?.(first) ?? false, false, "not blacklisted");
  assert.equal((await session.has([first])).has(first), false, "not stored");
  const again = optimizer({ cache });
  const retried = [];
  again.o.install = (r) => retried.push(r.key);
  await again.o.start();
  assert.ok(retried.includes(first), "translated again at the next launch");
});

test("aot optimizer: a finishing step that fails is reported and the run still ends", async () => {
  const base = fakeCache();
  const cache = async (identity) => {
    const s = await base(identity);
    return { ...s, has: s.has.bind(s), put: s.put.bind(s), cancel: s.cancel?.bind(s), isBlacklisted: s.isBlacklisted?.bind(s), blacklist: async () => { throw new Error("disk full"); } };
  };
  const { o, events } = optimizer({ cache, compile: async () => ({ reason: "compile" }) }); // every module refused: blacklist throws
  await o.start();
  assert.ok(events.some(([t, d]) => t === "optimization-error" && /disk full/.test(d.message)), "reported");
  assert.equal(events.at(-1)[0], "optimization-done", "the run ends");
});

test("aot optimizer: a profile that fails to load is no profile (today's formation), never a failed run", async () => {
  const { o, events } = optimizer({ loadProfile: async () => { throw new Error("corrupt profile"); } });
  await o.start();
  assert.equal(events.at(-1)[0], "optimization-done");
  assert.ok(o.regions.every((u) => u.members.every((f) => !f.hotRanges)));
});

