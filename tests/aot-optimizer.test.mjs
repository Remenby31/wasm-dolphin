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
  const o = new AotOptimizer({ discKey: "disc", cacheIdentity: { compilerVersion: "fake-1" }, openCache: cache, translator, buildPlan: async () => { builds++; return p; }, ...extra });
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

test("aot optimizer: refused regions are not fatal and progress still ends at 1", async () => {
  const p = plan();
  const refuse = new Set([p.modules[0].functions[3].hash]);
  const quota = new Set([p.modules[0].functions[5].sha256]);
  const { o, events } = optimizer({ translator: fakeTranslator({ refuse }), cache: fakeCache({ quotaKeys: quota }) });
  await o.start();
  const errors = events.filter(([t]) => t === "optimization-error").map(([, d]) => d);
  assert.equal(errors.length, 2, "one refused by the translator, one by the cache");
  assert.equal(errors[0].fatal, false);
  assert.equal(events.at(-1)[0], "optimization-done");
  assert.equal(events.at(-1)[1].refused, 2);
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
  const keyOf = (f) => `k-${f.sha256}`;
  const black = p.modules[0].functions[2];
  let sleeps = 0;
  const cache = fakeCache({ blacklist: new Set([keyOf(black)]) });
  const { o, events } = optimizer({ cache, keyOf, translator: fakeTranslator({ perCall: 3, notReadyCalls: 2 }), sleep: async () => { sleeps++; } });
  await o.start();
  assert.equal(events.at(-1)[0], "optimization-done");
  assert.equal(events.at(-1)[1].refused, 1, "the blacklisted key is skipped, not retried");
  assert.ok(sleeps >= 2, "not-ready waits before retrying");
  assert.ok([...cache.persisted.keys()].every((k) => k.startsWith("k-")), "the cache sees the core's keys");
  assert.equal(cache.persisted.size, o.regions.length - 1);
  assert.deepEqual(await o.status(), { state: "complete", fraction: 1 });
});

test("aot optimizer: region cache key follows the core formula", async () => {
  const { regionKeyOf } = await import("../src/aot-optimizer.js");
  const sha = "ab".repeat(32);
  assert.equal(regionKeyOf({ compilerVersion: 3, codegenMask: 0x10 })({ sha256: sha }), `region-v1:00000003:00000010:${sha}`);
});

test("aot optimizer: translator results out of batch order are a fatal error, nothing stored", async () => {
  const cache = fakeCache();
  const translator = { translate: async (regions) => regions.map((r, i) => ({ entry: regions[(i + 1) % regions.length].entry, bytes: new Uint8Array(4) })) };
  const { o, events } = optimizer({ cache, translator });
  await o.start();
  assert.deepEqual(events.at(-1), ["optimization-error", { message: "translator results out of order", fatal: true }]);
  assert.equal(cache.persisted.size, 0);
});

test("aot optimizer: refusals are blacklisted in the cache, boot keys follow the compile order", async () => {
  const p = plan();
  const refuse = new Set([p.modules[0].functions[4].hash]);
  const blacklist = new Set();
  const cache = fakeCache({ blacklist });
  const { o } = optimizer({ cache, translator: fakeTranslator({ refuse }) });
  await o.start();
  assert.ok(blacklist.has(p.modules[0].functions[4].sha256), "an untranslatable region is remembered across reloads");
  const keys = await o.bootKeys();
  assert.deepEqual(keys, o.regions.map((r) => r.key).filter((k) => !blacklist.has(k)));
});
