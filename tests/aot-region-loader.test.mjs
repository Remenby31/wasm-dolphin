import assert from "node:assert/strict";
import test from "node:test";

import { openAotCache } from "../src/aot-cache.js";
import { createAotRegionLoader } from "../src/aot-region-loader.js";
import { fakeCacheStorage } from "./helpers/fake-cache-storage.mjs";

const BASE = "http://127.0.0.1:8090/";
const IDENTITY = { discKey: `disc-sha256-v1:${"1".repeat(64)}`, coreHash: "a".repeat(64), compilerVersion: "region-1", flagsMask: 0 };
const key = (n) => `region-v1:00000001:00000000:${String(n).padStart(64, "0")}`;
// (i32) -> i32 returning param + n
const mod = (n) => Uint8Array.from([
  0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 1, 6, 1, 0x60, 1, 0x7f, 1, 0x7f, 3, 2, 1, 0,
  7, 5, 1, 1, 0x66, 0, 0, 10, 9, 1, 7, 0, 0x20, 0, 0x41, n, 0x6a, 0x0b
]);

async function setup(count, { clock } = {}) {
  const storage = fakeCacheStorage();
  const openCache = (identity) => openAotCache({ ...identity, baseUrl: BASE, cacheStorage: storage, serviceWorker: false });
  const writer = await openCache(IDENTITY);
  await writer.put(Array.from({ length: count }, (_, i) => ({ key: key(i), bytes: mod(i % 100) })));
  const retained = new Map();
  const loader = createAotRegionLoader({ openCache, retain: (k, m) => retained.set(k, m), ...(clock ? { now: clock } : {}) });
  return { storage, writer, loader, retained, openCache };
}

test("loads regions in the given order and retains each Module under its key", async () => {
  const { loader, retained } = await setup(5);
  const report = await loader.load({ ...IDENTITY, keys: [key(3), key(0), key(9)] });
  assert.equal(report.loaded, 2);
  assert.deepEqual(report.failed, [], "a region not compiled yet is not a failure");
  assert.deepEqual([...retained.keys()], [key(3), key(0)]);
  assert.equal(new WebAssembly.Instance(retained.get(key(3))).exports.f(10), 13);
  assert.equal(loader.stats().missing, 1);
});

test("the boot budget is checked before every region, opening included; the rest loads after boot, in order", async () => {
  let t = 0;
  // the clock reads +10 ms each time: opening the cache and each region cost time
  const { loader, retained } = await setup(10, { clock: () => (t += 10) });
  const keys = Array.from({ length: 10 }, (_, i) => key(i));
  const cut = await loader.load({ ...IDENTITY, keys, budgetMs: 45, batchSize: 3 });
  assert.ok(cut.loaded >= 1 && cut.loaded < 10, `loaded ${cut.loaded}`);
  assert.equal(cut.deferred, 10 - cut.loaded);
  assert.deepEqual([...retained.keys()], keys.slice(0, cut.loaded), "hot first");
  const rest = await loader.loadRest({ batchSize: 3 });
  assert.equal(rest.loaded, 10 - cut.loaded);
  assert.deepEqual([...retained.keys()], keys);
  assert.equal(loader.stats().deferred, 0);
});

test("budgetMs 0 loads nothing before boot; missing keys are an empty list", async () => {
  const { loader, retained } = await setup(3);
  const none = await loader.load({ ...IDENTITY, keys: [key(0), key(1)], budgetMs: 0 });
  assert.equal(none.loaded, 0);
  assert.equal(none.deferred, 2);
  assert.equal(retained.size, 0);
  const noKeys = await loader.load({ ...IDENTITY });
  assert.equal(noKeys.loaded, 0);
  assert.equal(noKeys.deferred, 0);
  assert.equal(noKeys.error, undefined);
});

test("caps: what a launch may retain, in modules and bytes, stops loading (not deferred)", async () => {
  const { loader, retained } = await setup(6);
  const keys = Array.from({ length: 6 }, (_, i) => key(i));
  const capped = await loader.load({ ...IDENTITY, keys, maxModules: 4 });
  assert.equal(capped.loaded, 4);
  assert.equal(capped.overCap, 2);
  assert.equal(capped.deferred, 0);
  const byBytes = await setup(6);
  const bytesCapped = await byBytes.loader.load({ ...IDENTITY, keys, maxBytes: 3 * mod(0).length, batchSize: 1 });
  assert.equal(bytesCapped.loaded, 3);
  assert.equal(byBytes.loader.stats().retainedBytes, 3 * mod(0).length);
  void retained;
});

test("blacklisted regions are skipped; corrupt and rejected entries are reported, never retained", async () => {
  const { loader, retained, writer, storage } = await setup(4);
  await writer.blacklist([{ key: key(1), reason: "untranslatable" }]);
  const raw = await storage.open(writer.cacheName);
  const url = [...raw.entries.keys()].find((u) => u.includes(encodeURIComponent(key(2))));
  raw.entries.get(url).body[raw.entries.get(url).body.length - 2] ^= 1;
  const report = await loader.load({ ...IDENTITY, keys: [key(0), key(1), key(2), key(3)] });
  assert.equal(report.loaded, 2);
  assert.deepEqual(report.failed, [{ key: key(2), reason: "corrupt" }]);
  assert.deepEqual([...retained.keys()], [key(0), key(3)]);
  assert.equal(loader.stats().skipped, 1);
});

test("never throws: no cache, a cache that cannot open, a retain that throws", async () => {
  const none = createAotRegionLoader({ openCache: async () => null, retain: () => {} });
  assert.equal((await none.load({ ...IDENTITY, keys: [key(0)] })).error, "no-cache");
  const broken = createAotRegionLoader({ openCache: async () => { throw new Error("SecurityError"); }, retain: () => {} });
  assert.match((await broken.load({ ...IDENTITY, keys: [key(0)] })).error, /SecurityError/);
  const { openCache } = await setup(2);
  const throwing = createAotRegionLoader({ openCache, retain: () => { throw new Error("full"); } });
  const report = await throwing.load({ ...IDENTITY, keys: [key(0), key(1)] });
  assert.deepEqual(report.failed.map((f) => f.reason), ["retain-error", "retain-error"]);
});

test("cancel in the middle of a batch: nothing more is retained; a later load opens a fresh session", async () => {
  const { loader, retained } = await setup(6);
  const pending = loader.load({ ...IDENTITY, keys: Array.from({ length: 6 }, (_, i) => key(i)), batchSize: 6 });
  loader.cancel(); // while the first (and only) batch is being read
  const report = await pending;
  assert.equal(report.loaded, 0);
  assert.equal(report.deferred, 0);
  assert.equal(retained.size, 0);
  const again = await loader.load({ ...IDENTITY, keys: [key(5)] });
  assert.equal(again.loaded, 1);
  assert.ok(retained.has(key(5)));
});

test("a new load supersedes the previous one's loadRest: no stray retains, its own deferred kept", async () => {
  let t = 0;
  const { loader, retained } = await setup(40, { clock: () => (t += 10) });
  const boot1 = Array.from({ length: 20 }, (_, i) => key(i));
  await loader.load({ ...IDENTITY, keys: boot1, budgetMs: 40 });
  const rest1 = loader.loadRest({ batchSize: 2 }); // running when boot 2 starts
  const boot2 = Array.from({ length: 20 }, (_, i) => key(20 + i));
  const r2 = await loader.load({ ...IDENTITY, keys: boot2, budgetMs: 40 });
  const r1 = await rest1;
  assert.ok(r1.loaded < 20, "the old loadRest stopped");
  const rest2 = await loader.loadRest();
  assert.equal(r2.loaded + rest2.loaded, 20, "every region of boot 2 loads, none lost to the old run");
  for (const k of boot2) assert.ok(retained.has(k), k);
});

test("a region the engine rejects at load is blacklisted and skipped next time", async () => {
  const { loader, writer, storage } = await setup(2);
  // valid wasm bytes that fail to compile only at load: swap the stored body
  const raw = await storage.open(writer.cacheName);
  const url = [...raw.entries.keys()].find((u) => u.includes(encodeURIComponent(key(1))));
  const junk = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 0x0a, 1]);
  const { sha256Hex } = await import("../src/jit-cache-identity.js");
  raw.entries.set(url, { body: junk, headers: [["content-type", "application/wasm"], ["x-salon-aot-sha256", await sha256Hex(junk)]] });
  const first = await loader.load({ ...IDENTITY, keys: [key(0), key(1)] });
  assert.deepEqual(first.failed, [{ key: key(1), reason: "engine-reject" }]);
  const second = await loader.load({ ...IDENTITY, keys: [key(0), key(1)] });
  assert.equal(second.failed.length, 0);
  assert.equal(loader.stats().skipped, 1);
});
