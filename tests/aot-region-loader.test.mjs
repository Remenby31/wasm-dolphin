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

test("the boot budget cuts between batches; the rest loads after boot, still in order", async () => {
  let t = 0;
  // the clock advances 50 ms per reading: the budget runs out after a few batches
  const { loader, retained } = await setup(10, { clock: () => (t += 50) });
  const keys = Array.from({ length: 10 }, (_, i) => key(i));
  const cut = await loader.load({ ...IDENTITY, keys, budgetMs: 150, batchSize: 3 });
  assert.ok(cut.loaded >= 3 && cut.loaded < 10, `loaded ${cut.loaded}`);
  assert.equal(cut.deferred, 10 - cut.loaded);
  assert.deepEqual([...retained.keys()], keys.slice(0, cut.loaded), "hot first");
  const rest = await loader.loadRest({ batchSize: 3 });
  assert.equal(rest.loaded, 10 - cut.loaded);
  assert.deepEqual([...retained.keys()], keys);
  assert.equal(loader.stats().deferred, 0);
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

test("cancel stops at the next batch; what was retained stays; a later load opens a fresh session", async () => {
  const { loader, retained } = await setup(6);
  const pending = loader.load({ ...IDENTITY, keys: Array.from({ length: 6 }, (_, i) => key(i)), batchSize: 2 });
  loader.cancel();
  const report = await pending;
  assert.ok(report.loaded <= 2);
  assert.equal(report.deferred, 0);
  const again = await loader.load({ ...IDENTITY, keys: [key(5)] });
  assert.equal(again.loaded, 1);
  assert.ok(retained.has(key(5)));
});
