import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

import {
  AOT_HASH_HEADER,
  AOT_SW_SEGMENT,
  aotEntryUrl,
  openAotCache,
  pruneAotCaches
} from "../src/aot-cache.js";
import {
  AOT_ANY_DISC_KEY,
  aotCacheIdentity,
  aotCacheName,
  canonicalDiscKey,
  classifyAotCacheIdentity,
  discKeyHex,
  sha256Hex
} from "../src/jit-cache-identity.js";

const BASE = "http://127.0.0.1:8090/";
const CORE = "a".repeat(64);
// (i32) -> i32 identity and (i32) -> i32 +1
const MOD_A = Uint8Array.from(Buffer.from("0061736d0100000001060160017f017f03020100070501016600000a0601040020000b", "hex"));
const MOD_B = Uint8Array.from(Buffer.from("0061736d0100000001060160017f017f03020100070501016600000a09010700200041016a0b", "hex"));

// CacheStorage as the browser has it, in memory. Entries keep the stored
// Response's bytes and headers; `failPut` simulates a full quota.
function fakeCacheStorage() {
  const caches = new Map();
  const storage = {
    failPut: null,
    caches,
    async open(name) {
      if (!caches.has(name)) {
        const entries = new Map();
        caches.set(name, {
          entries,
          async put(url, response) {
            if (storage.failPut) {
              const error = storage.failPut(name, url);
              if (error) throw error;
            }
            entries.set(String(url), { body: new Uint8Array(await response.arrayBuffer()), headers: [...response.headers] });
          },
          async match(url) {
            const hit = entries.get(String(url?.url ?? url));
            return hit ? new Response(hit.body.slice(), { headers: hit.headers }) : undefined;
          },
          async delete(url) {
            return entries.delete(String(url?.url ?? url));
          },
          async keys() {
            return [...entries.keys()].map((url) => ({ url }));
          }
        });
      }
      return caches.get(name);
    },
    async has(name) {
      return caches.has(name);
    },
    async delete(name) {
      return caches.delete(name);
    },
    async keys() {
      return [...caches.keys()];
    }
  };
  return storage;
}

const DISC = `disc-sha256-v1:${"1".repeat(64)}`;
const OTHER_DISC = `disc-sha256-v1:${"2".repeat(64)}`;
const ident = (over = {}) => ({ discKey: DISC, coreHash: CORE, compilerVersion: "region-1", flagsMask: 0, ...over });
const open = (storage, over = {}, opts = {}) =>
  openAotCache({ ...ident(over), baseUrl: BASE, cacheStorage: storage, serviceWorker: false, ...opts });

test("disc key: header, boot DOL and FST, hex form for file names", async () => {
  const header = new Uint8Array(0x440).fill(7);
  const key = await canonicalDiscKey({ header, dol: new Uint8Array([1, 2]), fst: new Uint8Array([3]) });
  assert.match(key, /^disc-sha256-v1:[0-9a-f]{64}$/);
  assert.equal(discKeyHex(key), key.split(":")[1]);
  assert.notEqual(key, await canonicalDiscKey({ header, dol: new Uint8Array([1, 2]), fst: new Uint8Array([4]) }));
  await assert.rejects(canonicalDiscKey({ header: new Uint8Array(10), dol: new Uint8Array(), fst: new Uint8Array() }));
  assert.equal(discKeyHex(AOT_ANY_DISC_KEY), "any");
  assert.throws(() => discKeyHex("disc:../x"));
});

test("identity: every field is part of the cache name, and bad identities are refused", async () => {
  const base = await aotCacheName(aotCacheIdentity(ident()));
  assert.match(base, /^salon-aot-v1-[0-9a-f]{40}$/);
  for (const over of [{ discKey: OTHER_DISC }, { coreHash: "b".repeat(64) }, { compilerVersion: "region-2" }, { flagsMask: 4 }]) {
    assert.notEqual(await aotCacheName(aotCacheIdentity(ident(over))), base, JSON.stringify(over));
  }
  // the core may be given bare or as the canonical fingerprint
  assert.equal(await aotCacheName(aotCacheIdentity(ident({ coreHash: `dolphin-core-sha256-v1:${CORE}` }))), base);
  assert.throws(() => aotCacheIdentity(ident({ coreHash: "abc" })));
  assert.throws(() => aotCacheIdentity(ident({ discKey: "x" })));
  assert.throws(() => aotCacheIdentity(ident({ compilerVersion: "a/b" })));
  assert.throws(() => aotCacheIdentity(ident({ flagsMask: -1 })));
  const current = aotCacheIdentity(ident());
  assert.deepEqual(classifyAotCacheIdentity({ stored: current, current }), { reset: false, reason: "match" });
  assert.equal(classifyAotCacheIdentity({ stored: { ...current, flagsMask: 1 }, current }).reason, "flagsMask-mismatch");
  assert.equal(classifyAotCacheIdentity({ stored: null, current }).reason, "missing-stored-identity");
});

test("put, has and load round-trip; the loaded module runs", async () => {
  const storage = fakeCacheStorage();
  const cache = await open(storage);
  const events = [];
  const { failed } = await cache.put([{ key: "r:1", bytes: MOD_A }, { key: "r:2", bytes: MOD_B }]);
  assert.deepEqual(failed, []);
  assert.deepEqual(await cache.has(["r:1", "r:2", "r:3"]), new Set(["r:1", "r:2"]));
  const loaded = await cache.load(["r:1", "r:2", "r:3"]);
  assert.equal(new WebAssembly.Instance(loaded.get("r:1").module).exports.f(5), 5);
  assert.equal(new WebAssembly.Instance(loaded.get("r:2").module).exports.f(5), 6);
  assert.deepEqual(loaded.get("r:3"), { reason: "missing" });
  // the stored entry carries the hash of its bytes, and the headers the SW serves
  const stored = await (await storage.open(cache.cacheName)).match(aotEntryUrl(BASE, cache.cacheName, "r:1"));
  assert.equal(stored.headers.get(AOT_HASH_HEADER), await sha256Hex(MOD_A));
  assert.equal(stored.headers.get("content-type"), "application/wasm");
  assert.equal(stored.headers.get("cross-origin-resource-policy"), "same-origin");
  void events;
});

test("a key mismatch never reaches the entry: other core, compiler or flags means another cache, and the stale one is dropped", async () => {
  const storage = fakeCacheStorage();
  const first = await open(storage);
  await first.put([{ key: "r:1", bytes: MOD_A }]);
  const otherDisc = await open(storage, { discKey: OTHER_DISC });
  await otherDisc.put([{ key: "r:1", bytes: MOD_B }]);

  const newCore = await open(storage, { coreHash: "b".repeat(64) });
  assert.notEqual(newCore.cacheName, first.cacheName);
  assert.deepEqual(await newCore.has(["r:1"]), new Set());
  // the same disc's cache under the old core is gone, the other disc's is kept
  assert.deepEqual(newCore.pruned, [first.cacheName]);
  assert.equal(storage.caches.has(first.cacheName), false);
  assert.equal(storage.caches.has(otherDisc.cacheName), true);
});

test("a cache whose stored identity is missing or differs is started over", async () => {
  const storage = fakeCacheStorage();
  const cache = await open(storage);
  await cache.put([{ key: "r:1", bytes: MOD_A }]);
  const raw = await storage.open(cache.cacheName);
  const idUrl = new URL(`${AOT_SW_SEGMENT}/${cache.cacheName}/identity.json`, BASE).href;
  await raw.put(idUrl, new Response(JSON.stringify({ ...cache.identity, flagsMask: 9 })));
  const again = await open(storage);
  assert.equal(again.reset, "flagsMask-mismatch");
  assert.deepEqual(await again.has(["r:1"]), new Set());
});

test("corrupt entries are deleted and reported, never compiled", async () => {
  const storage = fakeCacheStorage();
  const cache = await open(storage);
  await cache.put([{ key: "flip", bytes: MOD_A }, { key: "nohash", bytes: MOD_A }, { key: "junk", bytes: MOD_A }]);
  const raw = await storage.open(cache.cacheName);
  // one flipped byte under the old hash
  const flip = raw.entries.get(aotEntryUrl(BASE, cache.cacheName, "flip"));
  flip.body[flip.body.length - 2] ^= 1;
  // an entry written without its hash
  raw.entries.get(aotEntryUrl(BASE, cache.cacheName, "nohash")).headers = [["content-type", "application/wasm"]];
  // bytes that hash right but the engine rejects
  const junk = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 0x0a, 1]);
  raw.entries.set(aotEntryUrl(BASE, cache.cacheName, "junk"), {
    body: junk,
    headers: [["content-type", "application/wasm"], [AOT_HASH_HEADER, await sha256Hex(junk)]]
  });
  const loaded = await cache.load(["flip", "nohash", "junk"]);
  assert.deepEqual(loaded.get("flip"), { reason: "corrupt" });
  assert.deepEqual(loaded.get("nohash"), { reason: "corrupt" });
  assert.deepEqual(loaded.get("junk"), { reason: "engine-reject" });
  assert.deepEqual(await cache.has(["flip", "nohash", "junk"]), new Set());
  assert.deepEqual(cache.stats().corrupt, 2);
});

test("quota full: stale caches go first, then the entry fails with reason quota", async () => {
  const storage = fakeCacheStorage();
  const old = await open(storage, { compilerVersion: "region-0" });
  await old.put([{ key: "r:1", bytes: MOD_A }]);
  const cache = await open(storage);
  // the stale one was pruned at open; make a new stale cache appear later
  const stale = await open(storage, { compilerVersion: "region-9" });
  await stale.put([{ key: "r:9", bytes: MOD_B }]);
  let freed = false;
  storage.failPut = (name) => {
    if (name !== cache.cacheName || freed) return null;
    if (!storage.caches.has(stale.cacheName)) {
      freed = true;
      return null;
    }
    return Object.assign(new Error("Quota exceeded"), { name: "QuotaExceededError" });
  };
  assert.deepEqual((await cache.put([{ key: "r:1", bytes: MOD_A }])).failed, []);
  assert.equal(storage.caches.has(stale.cacheName), false, "the stale cache made room");

  storage.failPut = () => Object.assign(new Error("Quota exceeded"), { name: "QuotaExceededError" });
  const result = await cache.put([{ key: "r:2", bytes: MOD_B }, { key: "bad/key", bytes: MOD_B }, { key: "r:3", bytes: new Uint8Array([1, 2]) }]);
  assert.deepEqual(result.failed, [
    { key: "r:2", reason: "quota" },
    { key: "bad/key", reason: "bad-key" },
    { key: "r:3", reason: "engine-reject" }
  ]);
  // what was written before stays valid
  assert.deepEqual(await cache.has(["r:1", "r:2"]), new Set(["r:1"]));
});

test("cancel stops at the next entry; put resolves only once entries are written", async () => {
  const storage = fakeCacheStorage();
  const cache = await open(storage);
  const pending = cache.put([{ key: "a", bytes: MOD_A }, { key: "b", bytes: MOD_B }]);
  cache.cancel();
  const { failed } = await pending;
  // the first entry was already started when cancel() came
  assert.deepEqual(failed, [{ key: "b", reason: "cancelled" }]);
  await cache.drain();
  assert.deepEqual(await cache.has(["a", "b"]), new Set(["a"]));
});

test("with the Service Worker, modules come from compileStreaming(fetch) of an untouched response", async () => {
  const storage = fakeCacheStorage();
  const fetched = [];
  const streamed = [];
  let cacheName = null;
  const fetchImpl = async (url) => {
    fetched.push(url);
    const hit = await (await storage.open(cacheName)).match(url);
    return hit ?? new Response(null, { status: 404 });
  };
  const cache = await open(storage, {}, {
    serviceWorker: true,
    fetchImpl,
    compileStreaming: async (response) => {
      streamed.push(response.url ?? "");
      return WebAssembly.compile(await response.arrayBuffer());
    }
  });
  cacheName = cache.cacheName;
  await cache.put([{ key: "r:1", bytes: MOD_A }]);
  const loaded = await cache.load(["r:1"]);
  assert.equal(loaded.get("r:1").streamed, true);
  assert.deepEqual(fetched, [aotEntryUrl(BASE, cacheName, "r:1")]);
  assert.equal(streamed.length, 1);
  assert.equal(cache.stats().streamed, 1);
});

test("pruneAotCaches leaves other discs and foreign caches alone", async () => {
  const storage = fakeCacheStorage();
  const a = await open(storage);
  const b = await open(storage, { discKey: OTHER_DISC });
  await storage.open("someone-else");
  const removed = await pruneAotCaches({ cacheStorage: storage, keep: "salon-aot-v1-none", baseUrl: BASE, discKey: DISC });
  assert.deepEqual(removed, [a.cacheName]);
  assert.ok(storage.caches.has(b.cacheName) && storage.caches.has("someone-else"));
});

test("aot-sw.js answers only its own URLs, from CacheStorage, and is importScripts-safe", async () => {
  const source = await readFile(new URL("../src/aot-sw.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /^\s*(import|export)\s/m, "classic script");
  const storage = fakeCacheStorage();
  const cache = await openAotCache({ ...ident(), baseUrl: BASE, cacheStorage: storage, serviceWorker: false });
  await cache.put([{ key: "r:1", bytes: MOD_A }]);

  function load(location) {
    const listeners = {};
    const context = {
      self: null,
      caches: storage,
      URL,
      Response,
      Promise
    };
    context.self = {
      location: { href: location, origin: new URL(location).origin },
      addEventListener: (type, fn) => {
        (listeners[type] ??= []).push(fn);
      },
      skipWaiting() {},
      clients: { claim: async () => {} }
    };
    vm.runInNewContext(source, context);
    return listeners;
  }
  const fetchThrough = async (listeners, url, method = "GET") => {
    let answered = null;
    for (const fn of listeners.fetch) fn({ request: { url, method }, respondWith: (p) => { answered = p; } });
    return answered ? await answered : null;
  };

  const imported = load("http://127.0.0.1:8090/sw.js");
  assert.deepEqual(Object.keys(imported), ["fetch"], "no install/activate when imported by a site");
  const standalone = load("http://127.0.0.1:8090/src/aot-sw.js?standalone=1");
  assert.deepEqual(Object.keys(standalone).sort(), ["activate", "fetch", "install"]);

  const hit = await fetchThrough(imported, aotEntryUrl(BASE, cache.cacheName, "r:1"));
  assert.equal(hit.status, 200);
  assert.equal(hit.headers.get(AOT_HASH_HEADER), await sha256Hex(MOD_A));
  assert.deepEqual(new Uint8Array(await hit.arrayBuffer()), MOD_A);
  const ping = await fetchThrough(imported, `${BASE}engine/${AOT_SW_SEGMENT}/ping`);
  assert.equal(ping.status, 204);
  assert.equal(ping.headers.get("x-salon-aot-sw"), "1");
  assert.equal((await fetchThrough(imported, aotEntryUrl(BASE, cache.cacheName, "nope"))).status, 404);
  assert.equal((await fetchThrough(imported, `${BASE}${AOT_SW_SEGMENT}/not-a-cache/x.wasm`)).status, 404);
  // everything else goes to the network untouched
  assert.equal(await fetchThrough(imported, `${BASE}cores/dolphin/dolphin-core-upstream.wasm`), null);
  assert.equal(await fetchThrough(imported, "https://example.com/__salon-aot/ping"), null);
  assert.equal(await fetchThrough(imported, aotEntryUrl(BASE, cache.cacheName, "r:1"), "POST"), null);
});

// ---- block store (the IndexedDB block cache, moved) ----
import { LEGACY_JIT_IDB_NAME, migrateLegacyJitIdb, openAotBlockStore } from "../src/aot-cache.js";
import { canonicalWasmBlockKey } from "../src/jit-cache-identity.js";

const manualTimer = () => {
  const timers = [];
  return { timers, setTimer: (fn) => (timers.push(fn), timers.length), clearTimer: () => {} };
};

test("block store: packs of blocks, read back in order, reopened by the next session", async () => {
  const storage = fakeCacheStorage();
  const t = manualTimer();
  const store = await openAotBlockStore({ coreHash: CORE, baseUrl: BASE, cacheStorage: storage, packSize: 2, ...t });
  const blocks = await Promise.all([MOD_A, MOD_B, MOD_A.slice()].map(async (bytes) => ({ key: await canonicalWasmBlockKey(bytes), bytes })));
  await store.append(blocks[0].key, blocks[0].bytes);
  await store.append(blocks[1].key, blocks[1].bytes); // fills a pack
  store.append(blocks[2].key, blocks[2].bytes); // waits for the timer
  assert.equal(store.stats().packsWritten, 1);
  assert.equal(store.stats().buffered, 1);
  t.timers.at(-1)();
  await store.flush();
  assert.equal(store.stats().packsWritten, 2);
  const again = await openAotBlockStore({ coreHash: CORE, baseUrl: BASE, cacheStorage: storage, packSize: 2, ...t });
  assert.equal(again.cacheName, store.cacheName);
  assert.deepEqual((await again.entries()).map((e) => e.key), blocks.map((b) => b.key));
  await again.appendMany([blocks[1]]);
  assert.equal((await again.entries()).length, 4, "new packs follow the old ones");
});

test("block store: a corrupt pack is dropped, another core starts empty and prunes the old store", async () => {
  const storage = fakeCacheStorage();
  const store = await openAotBlockStore({ coreHash: CORE, baseUrl: BASE, cacheStorage: storage });
  await store.appendMany([{ key: await canonicalWasmBlockKey(MOD_A), bytes: MOD_A }]);
  await store.appendMany([{ key: await canonicalWasmBlockKey(MOD_B), bytes: MOD_B }]);
  const raw = await storage.open(store.cacheName);
  const firstPack = [...raw.entries.keys()].find((u) => u.endsWith("00000000.pack"));
  raw.entries.get(firstPack).body[30] ^= 0xff;
  const entries = await store.entries();
  assert.deepEqual(entries.map((e) => e.key), [await canonicalWasmBlockKey(MOD_B)]);
  assert.equal(store.stats().corruptPacks, 1);
  assert.equal(raw.entries.has(firstPack), false);

  const regions = await open(storage); // a disc's region cache is not a block store
  const next = await openAotBlockStore({ coreHash: "b".repeat(64), baseUrl: BASE, cacheStorage: storage });
  assert.deepEqual(next.pruned, [store.cacheName]);
  assert.deepEqual(await next.entries(), []);
  assert.ok(storage.caches.has(regions.cacheName));
});

test("block store: quota full loses the pack, not the session", async () => {
  const storage = fakeCacheStorage();
  const store = await openAotBlockStore({ coreHash: CORE, baseUrl: BASE, cacheStorage: storage });
  storage.failPut = () => Object.assign(new Error("full"), { name: "QuotaExceededError" });
  await store.appendMany([{ key: await canonicalWasmBlockKey(MOD_A), bytes: MOD_A }]);
  assert.equal(store.stats().quota, 1);
  storage.failPut = null;
  assert.deepEqual(await store.entries(), []);
});

// IndexedDB as the legacy cache used it: open (with upgrade abort), cursor,
// databases(), deleteDatabase.
function fakeIndexedDb(initial = null) {
  let db = initial ? { stores: new Map(Object.entries(initial)) } : null;
  const later = (fn) => setTimeout(fn, 0);
  return {
    get exists() {
      return db !== null;
    },
    async databases() {
      return db ? [{ name: LEGACY_JIT_IDB_NAME, version: 3 }] : [];
    },
    open() {
      const request = {};
      later(() => {
        if (!db) {
          request.transaction = { abort() { request.aborted = true; } };
          request.onupgradeneeded?.();
          if (request.aborted) return request.onerror?.();
          db = { stores: new Map() };
        }
        request.result = {
          objectStoreNames: [...db.stores.keys()],
          close() {},
          transaction: (name) => ({
            objectStore: () => ({
              openCursor() {
                const cursorRequest = {};
                const rows = [...db.stores.get(name).entries()];
                let i = 0;
                const step = () => later(() => cursorRequest.onsuccess({
                  target: { result: i < rows.length ? { key: rows[i][0], value: rows[i][1], continue() { i += 1; step(); } } : null }
                }));
                step();
                return cursorRequest;
              }
            })
          })
        };
        request.onsuccess?.();
      });
      return request;
    },
    deleteDatabase() {
      const request = {};
      later(() => {
        db = null;
        request.onsuccess?.();
      });
      return request;
    }
  };
}

test("the IndexedDB block cache moves into the store under the same core, and is deleted", async () => {
  const fingerprint = `dolphin-core-sha256-v1:${CORE}`;
  const keyA = await canonicalWasmBlockKey(MOD_A);
  const keyB = await canonicalWasmBlockKey(MOD_B);
  const idb = fakeIndexedDb({
    metadata: new Map([["buildFingerprint", fingerprint], ["entryKeySchema", "wasm-block-sha256-v1"]]),
    modules: new Map([[keyA, MOD_A], [keyB, MOD_B.buffer.slice(0)]])
  });
  const store = await openAotBlockStore({ coreHash: CORE, baseUrl: BASE, cacheStorage: fakeCacheStorage() });
  const result = await migrateLegacyJitIdb({ store, coreFingerprint: fingerprint, idb });
  assert.deepEqual(result, { found: true, moved: 2, dropped: 0, reason: "moved" });
  assert.equal(idb.exists, false);
  assert.deepEqual((await store.entries()).map((e) => e.key).sort(), [keyA, keyB].sort());

  // another core's rows are dropped with the database
  const stale = fakeIndexedDb({
    metadata: new Map([["buildFingerprint", "dolphin-core-sha256-v1:" + "f".repeat(64)], ["entryKeySchema", "wasm-block-sha256-v1"]]),
    modules: new Map([[keyA, MOD_A]])
  });
  const store2 = await openAotBlockStore({ coreHash: CORE, baseUrl: BASE, cacheStorage: fakeCacheStorage() });
  assert.deepEqual(await migrateLegacyJitIdb({ store: store2, coreFingerprint: fingerprint, idb: stale }), { found: true, moved: 0, dropped: 1, reason: "other-core" });
  assert.equal(stale.exists, false);
  assert.deepEqual(await store2.entries(), []);

  // no database: nothing created
  const none = fakeIndexedDb();
  assert.equal((await migrateLegacyJitIdb({ store: store2, coreFingerprint: fingerprint, idb: none })).found, false);
  assert.equal(none.exists, false);
});
