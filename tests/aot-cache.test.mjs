import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

import {
  AOT_HASH_HEADER,
  AOT_SW_SEGMENT,
  aotEntryUrl,
  openAotCache,
  pruneAotCaches,
  readDiscKeyFromFile,
  registerAotServiceWorker,
  unregisterAotServiceWorker
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

import { fakeCacheStorage } from "./helpers/fake-cache-storage.mjs";

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

// Region keys end with the SHA-256 of the guest code they were compiled from.
const k = (n) => `r:${String(n).padStart(64, "0")}`;
let tick = 1000;
const clock = () => (tick += 1000);

test("put, has and load round-trip; the loaded module runs", async () => {
  const storage = fakeCacheStorage();
  const cache = await open(storage);
  const { failed } = await cache.put([{ key: k(1), bytes: MOD_A }, { key: k(2), bytes: MOD_B }]);
  assert.deepEqual(failed, []);
  assert.deepEqual(await cache.has([k(1), k(2), k(3)]), new Set([k(1), k(2)]));
  const loaded = await cache.load([k(1), k(2), k(3)]);
  assert.equal(new WebAssembly.Instance(loaded.get(k(1)).module).exports.f(5), 5);
  assert.equal(new WebAssembly.Instance(loaded.get(k(2)).module).exports.f(5), 6);
  assert.deepEqual(loaded.get(k(3)), { reason: "missing" });
  // the stored entry carries the hash of its bytes, and the headers the SW serves
  const stored = await (await storage.open(cache.cacheName)).match(aotEntryUrl(BASE, cache.cacheName, k(1)));
  assert.equal(stored.headers.get(AOT_HASH_HEADER), await sha256Hex(MOD_A));
  assert.equal(stored.headers.get("content-type"), "application/wasm");
  assert.equal(stored.headers.get("cross-origin-resource-policy"), "same-origin");
});

test("a region key must name the guest code's hash", async () => {
  const cache = await open(fakeCacheStorage());
  const { failed } = await cache.put([{ key: "r:1", bytes: MOD_A }, { key: `r:${"g".repeat(64)}`, bytes: MOD_A }]);
  assert.deepEqual(failed.map((f) => f.reason), ["bad-key", "bad-key"]);
  assert.deepEqual(await cache.load(["r:1"]), new Map([["r:1", { reason: "bad-key" }]]));
});

test("a key mismatch never reaches the entry: another core, compiler or flags is another cache; the oldest of a disc's are dropped", async () => {
  const storage = fakeCacheStorage();
  const first = await open(storage, {}, { clock });
  await first.put([{ key: k(1), bytes: MOD_A }]);
  const otherDisc = await open(storage, { discKey: OTHER_DISC }, { clock });
  const otherFlags = await open(storage, { flagsMask: 4 }, { clock });
  assert.notEqual(otherFlags.cacheName, first.cacheName);
  assert.deepEqual(await otherFlags.has([k(1)]), new Set());
  // two identities of one disc live side by side (tabs, flag sets in turn)
  assert.deepEqual(otherFlags.pruned, []);
  const newCore = await open(storage, { coreHash: "b".repeat(64) }, { clock });
  // a third: the least recently opened of the disc goes, the other disc stays
  assert.deepEqual(newCore.pruned, [first.cacheName]);
  assert.equal(storage.caches.has(otherFlags.cacheName), true);
  assert.equal(storage.caches.has(otherDisc.cacheName), true);
});

test("an edited stored identity starts the cache over; a missing one (a cache being created) does not", async () => {
  const storage = fakeCacheStorage();
  const cache = await open(storage);
  await cache.put([{ key: k(1), bytes: MOD_A }]);
  const raw = await storage.open(cache.cacheName);
  const idUrl = new URL(`${AOT_SW_SEGMENT}/${cache.cacheName}/identity.json`, BASE).href;
  raw.entries.delete(idUrl);
  const reopened = await open(storage);
  assert.equal(reopened.reset, null);
  assert.deepEqual(await reopened.has([k(1)]), new Set([k(1)]));
  await raw.put(idUrl, new Response(JSON.stringify({ ...cache.identity, flagsMask: 9 })));
  const again = await open(storage);
  assert.equal(again.reset, "flagsMask-mismatch");
  assert.deepEqual(await again.has([k(1)]), new Set());
});

test("corrupt entries are deleted and reported, never compiled", async () => {
  const storage = fakeCacheStorage();
  const cache = await open(storage);
  await cache.put([{ key: k(1), bytes: MOD_A }, { key: k(2), bytes: MOD_A }, { key: k(3), bytes: MOD_A }]);
  const raw = await storage.open(cache.cacheName);
  const flip = raw.entries.get(aotEntryUrl(BASE, cache.cacheName, k(1)));
  flip.body[flip.body.length - 2] ^= 1; // one flipped byte under the old hash
  raw.entries.get(aotEntryUrl(BASE, cache.cacheName, k(2))).headers = [["content-type", "application/wasm"]]; // no hash
  const junk = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 0x0a, 1]); // hashes right, engine rejects
  raw.entries.set(aotEntryUrl(BASE, cache.cacheName, k(3)), {
    body: junk,
    headers: [["content-type", "application/wasm"], [AOT_HASH_HEADER, await sha256Hex(junk)]]
  });
  const loaded = await cache.load([k(1), k(2), k(3)]);
  assert.deepEqual(loaded.get(k(1)), { reason: "corrupt" });
  assert.deepEqual(loaded.get(k(2)), { reason: "corrupt" });
  assert.deepEqual(loaded.get(k(3)), { reason: "engine-reject" });
  assert.deepEqual(await cache.has([k(1), k(2), k(3)]), new Set());
  assert.equal(cache.stats().corrupt, 2);
});

test("a CacheStorage that fails to read never fails the launch: the entry is dropped and reported", async () => {
  const storage = fakeCacheStorage();
  const cache = await open(storage);
  await cache.put([{ key: k(1), bytes: MOD_A }]);
  const raw = await storage.open(cache.cacheName);
  const match = raw.match;
  raw.match = async () => { throw new Error("UnknownError: read failed"); };
  raw.keys = async () => { throw new Error("UnknownError: read failed"); };
  assert.deepEqual(await cache.load([k(1)]), new Map([[k(1), { reason: "read-error" }]]));
  assert.deepEqual(await cache.has([k(1)]), new Set());
  raw.match = match;
  assert.deepEqual(await cache.load([k(1)]), new Map([[k(1), { reason: "missing" }]]));
  // a cache deleted while in use: misses, no throw
  await storage.delete(cache.cacheName);
  assert.equal((await cache.load([k(1)])).get(k(1)).reason, "missing");
});

test("quota full: the least recently opened caches are evicted first, then the entry fails with reason quota", async () => {
  const storage = fakeCacheStorage();
  const oldDisc = await open(storage, { discKey: OTHER_DISC }, { clock });
  await oldDisc.put([{ key: k(9), bytes: MOD_B }]);
  const recentDisc = await open(storage, { discKey: `disc-sha256-v1:${"3".repeat(64)}` }, { clock });
  const cache = await open(storage, {}, { clock });
  let failures = 1;
  storage.failPut = (name) => (name === cache.cacheName && failures-- > 0 ? Object.assign(new Error("Quota exceeded"), { name: "QuotaExceededError" }) : null);
  assert.deepEqual((await cache.put([{ key: k(1), bytes: MOD_A }])).failed, []);
  assert.equal(storage.caches.has(oldDisc.cacheName), false, "the least recently opened went first");
  assert.equal(storage.caches.has(recentDisc.cacheName), true);

  storage.failPut = (name) => (name === cache.cacheName ? Object.assign(new Error("Quota exceeded"), { name: "QuotaExceededError" }) : null);
  const result = await cache.put([{ key: k(2), bytes: MOD_B }, { key: "bad/key", bytes: MOD_B }, { key: k(3), bytes: new Uint8Array([1, 2]) }]);
  assert.deepEqual(result.failed, [
    { key: k(2), reason: "quota" },
    { key: "bad/key", reason: "bad-key" },
    { key: k(3), reason: "engine-reject" }
  ]);
  assert.equal(storage.caches.has(recentDisc.cacheName), false, "everything else was evicted before giving up");
  storage.failPut = null;
  assert.deepEqual(await cache.has([k(1), k(2)]), new Set([k(1)]), "what was written before stays valid");
});

test("cancel stops at the next entry; put resolves only once entries are written", async () => {
  const storage = fakeCacheStorage();
  const cache = await open(storage);
  const pending = cache.put([{ key: k(1), bytes: MOD_A }, { key: k(2), bytes: MOD_B }]);
  cache.cancel();
  const { failed } = await pending;
  assert.deepEqual(failed, [{ key: k(2), reason: "cancelled" }]);
  await cache.drain();
  assert.deepEqual(await cache.has([k(1), k(2)]), new Set([k(1)]));
});

test("with the Service Worker, modules come from compileStreaming(fetch) of an untouched response; a 'no' is asked again later", async () => {
  const storage = fakeCacheStorage();
  const fetched = [];
  let controlled = false;
  let cacheName = null;
  const fetchImpl = async (url) => {
    fetched.push(url);
    if (url.endsWith("/ping")) return new Response(null, { status: controlled ? 204 : 404, headers: controlled ? { "x-salon-aot-sw": "1" } : {} });
    const hit = await (await storage.open(cacheName)).match(url);
    return hit ?? new Response(null, { status: 404 });
  };
  const realNow = Date.now;
  let now = 0;
  Date.now = () => now;
  try {
    const cache = await openAotCache({ ...ident(), baseUrl: BASE, cacheStorage: storage, fetchImpl,
      compileStreaming: async (response) => WebAssembly.compile(await response.arrayBuffer()) });
    cacheName = cache.cacheName;
    await cache.put([{ key: k(1), bytes: MOD_A }]);
    assert.equal((await cache.load([k(1)])).get(k(1)).streamed, false);
    controlled = true; // the Service Worker took control meanwhile
    assert.equal((await cache.load([k(1)])).get(k(1)).streamed, false, "not asked again so soon");
    now = 20_000;
    assert.equal((await cache.load([k(1)])).get(k(1)).streamed, true);
    assert.equal(fetched.filter((u) => u.endsWith("/ping")).length, 2);
    assert.equal(cache.stats().streamed, 1);
  } finally {
    Date.now = realNow;
  }
});

test("pruneAotCaches leaves other discs, foreign caches and caches being created alone", async () => {
  const storage = fakeCacheStorage();
  const a = await open(storage, {}, { clock });
  const b = await open(storage, { discKey: OTHER_DISC }, { clock });
  await storage.open("someone-else");
  await storage.open("salon-aot-v1-" + "f".repeat(40)); // no identity yet: another tab is creating it
  const removed = await pruneAotCaches({ cacheStorage: storage, keep: "salon-aot-v1-none", baseUrl: BASE, discKey: DISC, keepPerDisc: 1 });
  assert.deepEqual(removed, [a.cacheName]);
  assert.ok(storage.caches.has(b.cacheName) && storage.caches.has("someone-else") && storage.caches.has("salon-aot-v1-" + "f".repeat(40)));
});

test("readDiscKeyFromFile: header, boot DOL and FST of a raw image; anything else gets no key", async () => {
  const image = new Uint8Array(0x10000);
  const view = new DataView(image.buffer);
  view.setUint32(0x1c, 0xc2339f3d);
  view.setUint32(0x420, 0x2000); // DOL
  view.setUint32(0x424, 0x8000); // FST
  view.setUint32(0x428, 0x40);
  view.setUint32(0x2000 + 0x00, 0x100); // text0 file offset
  view.setUint32(0x2000 + 0x90, 0x200); // text0 size
  image.fill(7, 0x2100, 0x2300);
  image.fill(9, 0x8000, 0x8040);
  const key = await readDiscKeyFromFile(new Blob([image]));
  const expected = await canonicalDiscKey({ header: image.slice(0, 0x440), dol: image.slice(0x2000, 0x2300), fst: image.slice(0x8000, 0x8040) });
  assert.equal(key, expected);
  image[0x2150] ^= 1; // a change in the DOL changes the key
  assert.notEqual(await readDiscKeyFromFile(new Blob([image])), expected);
  const notGc = image.slice();
  new DataView(notGc.buffer).setUint32(0x1c, 0);
  assert.equal(await readDiscKeyFromFile(new Blob([notGc])), null);
  const truncated = image.slice(0, 0x2100);
  assert.equal(await readDiscKeyFromFile(new Blob([truncated])), null);
});

test("registerAotServiceWorker: registers standalone, or clears it when a site manages its own", async () => {
  const registered = [];
  const unregistered = [];
  const container = {
    controller: null,
    register: async (url) => (registered.push(url), { url }),
    getRegistrations: async () => [
      { active: { scriptURL: "http://x/engine/src/aot-sw.js?standalone=1" }, unregister: async () => unregistered.push("aot") },
      { active: { scriptURL: "http://x/sw.js?engine=1" }, unregister: async () => unregistered.push("site") }
    ]
  };
  await registerAotServiceWorker({ container, scriptUrl: new URL("http://x/src/aot-sw.js?standalone=1") });
  assert.deepEqual(registered, ["http://x/src/aot-sw.js?standalone=1"]);
  globalThis.__salonAotServiceWorkerManaged = true;
  try {
    assert.equal(await registerAotServiceWorker({ container }), null);
    assert.deepEqual(unregistered, ["aot"]);
    assert.equal(registered.length, 1);
  } finally {
    delete globalThis.__salonAotServiceWorkerManaged;
  }
  // a later visit without ?aotsw=1 removes the engine's standalone registration only
  unregistered.length = 0;
  assert.equal(await unregisterAotServiceWorker({ container }), 1);
  assert.deepEqual(unregistered, ["aot"]);
  assert.equal(await unregisterAotServiceWorker({ container: {} }), 0);
  const bootstrap = await readFile(new URL("../src/bootstrap.js", import.meta.url), "utf8");
  assert.match(bootstrap, /aot\.unregisterAotServiceWorker\(\)/);
  assert.match(bootstrap, /aotsw"\) === "1"\) \{\s*import\("\.\/aot-cache\.js"\)\.then\(\(aot\) => aot\.registerAotServiceWorker\(\)\)/);
  // another Service Worker already controls the page: leave it be
  assert.equal(await registerAotServiceWorker({ container: { ...container, controller: { scriptURL: "http://x/sw.js" } } }), null);
});

test("aot-sw.js answers only its own URLs, from CacheStorage, and is importScripts-safe", async () => {
  const source = await readFile(new URL("../src/aot-sw.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /^\s*(import|export)\s/m, "classic script");
  const storage = fakeCacheStorage();
  const cache = await openAotCache({ ...ident(), baseUrl: BASE, cacheStorage: storage, serviceWorker: false });
  await cache.put([{ key: k(1), bytes: MOD_A }]);

  function load(location) {
    const listeners = {};
    const context = { self: null, caches: storage, URL, Response, Promise, URLPattern: class { constructor(init) { this.pathname = init.pathname ?? "*"; } } };
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
  // standalone: static routes send everything but its own URLs straight to the network
  let routes = null;
  standalone.install[0]({ addRoutes: (r) => { routes = r; } });
  assert.equal(routes?.length, 2);
  assert.equal(routes[0].source, "fetch-event");
  assert.equal(JSON.stringify(routes[0].condition.or.map((c) => c.urlPattern.pathname)), JSON.stringify(["/__salon-aot/*", "/*/__salon-aot/*"]));
  assert.equal(routes[1].source, "network");

  const hit = await fetchThrough(imported, aotEntryUrl(BASE, cache.cacheName, k(1)));
  assert.equal(hit.status, 200);
  assert.equal(hit.headers.get(AOT_HASH_HEADER), await sha256Hex(MOD_A));
  assert.deepEqual(new Uint8Array(await hit.arrayBuffer()), MOD_A);
  const ping = await fetchThrough(imported, `${BASE}engine/${AOT_SW_SEGMENT}/ping`);
  assert.equal(ping.status, 204);
  assert.equal(ping.headers.get("x-salon-aot-sw"), "1");
  assert.equal((await fetchThrough(imported, aotEntryUrl(BASE, cache.cacheName, k(2)))).status, 404);
  assert.equal((await fetchThrough(imported, `${BASE}${AOT_SW_SEGMENT}/not-a-cache/x.wasm`)).status, 404);
  // everything else goes to the network untouched
  assert.equal(await fetchThrough(imported, `${BASE}cores/dolphin/dolphin-core-upstream.wasm`), null);
  assert.equal(await fetchThrough(imported, "https://example.com/__salon-aot/ping"), null);
  assert.equal(await fetchThrough(imported, aotEntryUrl(BASE, cache.cacheName, k(1)), "POST"), null);
});

// ---- block store (the IndexedDB block cache, moved) ----
import { LEGACY_JIT_IDB_NAME, migrateLegacyJitIdb, openAotBlockStore } from "../src/aot-cache.js";
import { canonicalWasmBlockKey } from "../src/jit-cache-identity.js";

const manualTimer = () => {
  const timers = [];
  return { timers, setTimer: (fn) => (timers.push(fn), timers.length), clearTimer: () => {} };
};

const MOD_C = Uint8Array.from(Buffer.from("0061736d0100000001060160017f017f03020100070501016600000a09010700200041026a0b", "hex"));

test("block store: packs of blocks, read back in order, reopened by the next session", async () => {
  const storage = fakeCacheStorage();
  const t = manualTimer();
  const store = await openAotBlockStore({ coreHash: CORE, baseUrl: BASE, cacheStorage: storage, packSize: 2, ...t });
  const blocks = await Promise.all([MOD_A, MOD_B, MOD_C].map(async (bytes) => ({ key: await canonicalWasmBlockKey(bytes), bytes })));
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
});

test("block store: a block is written once, and a wasteful store is compacted without loss", async () => {
  const storage = fakeCacheStorage();
  const t = manualTimer();
  const keyA = await canonicalWasmBlockKey(MOD_A);
  const keyB = await canonicalWasmBlockKey(MOD_B);
  const keyC = await canonicalWasmBlockKey(MOD_C);
  const first = await openAotBlockStore({ coreHash: CORE, baseUrl: BASE, cacheStorage: storage, packSize: 2, ...t });
  await first.appendMany([{ key: keyA, bytes: MOD_A }, { key: keyA, bytes: MOD_A }, { key: keyB, bytes: MOD_B }]);
  assert.equal(first.stats().duplicatesSkipped, 1);
  first.append(keyB, MOD_B);
  assert.equal(first.stats().buffered, 0, "already written in this session");
  // a session that never read the store writes what it compiles again: duplicates on disk
  const blind = await openAotBlockStore({ coreHash: CORE, baseUrl: BASE, cacheStorage: storage, packSize: 2, ...t });
  await blind.appendMany([{ key: keyA, bytes: MOD_A }, { key: keyC, bytes: MOD_C }]);
  // the next session reads each block once, then compacts
  const next = await openAotBlockStore({ coreHash: CORE, baseUrl: BASE, cacheStorage: storage, packSize: 2, ...t });
  const entries = await next.entries();
  assert.deepEqual(entries.map((e) => e.key), [keyA, keyB, keyC]);
  assert.equal(next.stats().duplicatesRead, 1);
  next.append(keyC, MOD_C);
  assert.equal(next.stats().buffered, 0, "a block read from the store is not written again");
  assert.equal(await next.compactIfWasteful(entries, { maxDuplicateShare: 0.2 }), true);
  const raw = await storage.open(next.cacheName);
  assert.equal([...raw.entries.keys()].filter((u) => u.endsWith(".pack")).length, 2, "3 unique blocks in packs of 2");
  const after = await openAotBlockStore({ coreHash: CORE, baseUrl: BASE, cacheStorage: storage, packSize: 2, ...t });
  assert.deepEqual((await after.entries()).map((e) => e.key), [keyA, keyB, keyC]);
  assert.equal(after.stats().duplicatesRead, 0);
  assert.equal(await after.compactIfWasteful(await after.entries()), false, "nothing to do any more");
});

test("block store: a corrupt pack is dropped, another core starts empty and prunes the old store", async () => {
  const storage = fakeCacheStorage();
  const store = await openAotBlockStore({ coreHash: CORE, baseUrl: BASE, cacheStorage: storage });
  await store.appendMany([{ key: await canonicalWasmBlockKey(MOD_A), bytes: MOD_A }]);
  await store.appendMany([{ key: await canonicalWasmBlockKey(MOD_B), bytes: MOD_B }]);
  const raw = await storage.open(store.cacheName);
  const firstPack = [...raw.entries.keys()].find((u) => u.includes("/blocks-00000000-"));
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

test("block store: two tabs write packs side by side without overwriting each other", async () => {
  const storage = fakeCacheStorage();
  const [tabA, tabB] = await Promise.all([
    openAotBlockStore({ coreHash: CORE, baseUrl: BASE, cacheStorage: storage }),
    openAotBlockStore({ coreHash: CORE, baseUrl: BASE, cacheStorage: storage })
  ]);
  assert.equal(tabA.cacheName, tabB.cacheName);
  const keyA = await canonicalWasmBlockKey(MOD_A);
  const keyB = await canonicalWasmBlockKey(MOD_B);
  await Promise.all([tabA.appendMany([{ key: keyA, bytes: MOD_A }]), tabB.appendMany([{ key: keyB, bytes: MOD_B }])]);
  const keys = (await tabA.entries()).map((e) => e.key).sort();
  assert.deepEqual(keys, [keyA, keyB].sort());
});

test("block store: a pack that cannot be read is dropped, and a failed write does not block the next", async () => {
  const storage = fakeCacheStorage();
  const store = await openAotBlockStore({ coreHash: CORE, baseUrl: BASE, cacheStorage: storage });
  const keyA = await canonicalWasmBlockKey(MOD_A);
  assert.equal(await store.appendMany([{ key: keyA, bytes: MOD_A }]), true);
  // a block the pack format refuses: encoding throws, the write fails
  assert.equal(await store.appendMany([{ key: "not-a-block-key", bytes: MOD_A }]), false);
  assert.equal(await store.appendMany([{ key: await canonicalWasmBlockKey(MOD_B), bytes: MOD_B }]), true);
  const raw = await storage.open(store.cacheName);
  const match = raw.match;
  raw.match = async (url) => (String(url).includes("/blocks-00000000-") ? Promise.reject(new Error("UnknownError")) : match(url));
  const entries = await store.entries();
  assert.deepEqual(entries.map((e) => e.key), [await canonicalWasmBlockKey(MOD_B)]);
  assert.equal(store.stats().readErrors, 1);
});

test("migration keeps the IndexedDB database when the store cannot take it (quota)", async () => {
  const fingerprint = `dolphin-core-sha256-v1:${CORE}`;
  const keyA = await canonicalWasmBlockKey(MOD_A);
  const idb = fakeIndexedDb({
    metadata: new Map([["buildFingerprint", fingerprint], ["entryKeySchema", "wasm-block-sha256-v1"]]),
    modules: new Map([[keyA, MOD_A]])
  });
  const storage = fakeCacheStorage();
  const store = await openAotBlockStore({ coreHash: CORE, baseUrl: BASE, cacheStorage: storage });
  storage.failPut = () => Object.assign(new Error("full"), { name: "QuotaExceededError" });
  const result = await migrateLegacyJitIdb({ store, coreFingerprint: fingerprint, idb });
  assert.equal(result.reason, "store-write-failed");
  assert.equal(idb.exists, true, "nothing lost: the next boot tries again");
  storage.failPut = null;
  assert.equal((await migrateLegacyJitIdb({ store, coreFingerprint: fingerprint, idb })).reason, "moved");
  assert.equal(idb.exists, false);
});

test("the block store's buffer goes out when the saves do (page hidden or closed) and on stop", async () => {
  const worker = await readFile(new URL("../src/upstream-discio-worker.js", import.meta.url), "utf8");
  assert.match(worker, /if \(type === "flushUserData" \|\| type === "stop"\) void dolphinJitBlockStore\?\.flush\(\)/);
  const adapter = await readFile(new URL("../src/upstream-worker-adapter.js", import.meta.url), "utf8");
  assert.match(adapter, /addEventListener\?\.\("pagehide", \(\) => this\.flushUserData\(\)/);
});

test("blacklist: engine rejects and refusals are remembered under the identity, and a new identity starts clean", async () => {
  const storage = fakeCacheStorage();
  const key = (n) => `r:${String(n).padStart(64, "0")}`;
  const cache = await open(storage);
  const { failed } = await cache.put([{ key: key(1), bytes: new Uint8Array([1, 2, 3]) }]);
  assert.deepEqual(failed, [{ key: key(1), reason: "engine-reject" }]);
  await cache.blacklist([{ key: key(2), reason: "untranslatable" }, { key: "not-hashed", reason: "x" }]);
  assert.equal(cache.isBlacklisted(key(1)), true);
  assert.equal(cache.blacklistReason(key(2)), "untranslatable");
  assert.equal(cache.isBlacklisted("not-hashed"), false);
  await cache.drain();
  // the next session of the same identity knows it
  const again = await open(storage);
  assert.equal(again.isBlacklisted(key(1)) && again.isBlacklisted(key(2)), true);
  assert.deepEqual(await again.has([key(1), key(2)]), new Set(), "the list is not an entry");
  // another compiler version: a clean list
  const other = await open(storage, { compilerVersion: "region-2" });
  assert.equal(other.isBlacklisted(key(1)), false);
  // an engine reject holds only for the browser build that rejected
  const realNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { value: { userAgent: "another browser build" }, configurable: true });
  try {
    const newer = await open(storage);
    assert.equal(newer.isBlacklisted(key(1)), false, "engine-reject from another build is dropped");
    assert.equal(newer.isBlacklisted(key(2)), true, "a refusal of the translator holds on any build");
  } finally {
    if (realNavigator) Object.defineProperty(globalThis, "navigator", realNavigator);
    else delete globalThis.navigator;
  }
});

test("blacklist: two sessions of one identity add keys side by side, and a blacklisted region's bytes go", async () => {
  const storage = fakeCacheStorage();
  const key = (n) => `r:${String(n).padStart(64, "0")}`;
  const tabA = await open(storage);
  const tabB = await open(storage);
  await tabA.put([{ key: key(7), bytes: MOD_A }]);
  await Promise.all([tabA.blacklist([{ key: key(7), reason: "too-large" }]), tabB.blacklist([{ key: key(8), reason: "untranslatable" }])]);
  await Promise.all([tabA.drain(), tabB.drain()]);
  const next = await open(storage);
  assert.equal(next.isBlacklisted(key(7)) && next.isBlacklisted(key(8)), true, "neither tab's list overwrote the other");
  assert.deepEqual(await next.has([key(7)]), new Set(), "the bytes of a blacklisted region are deleted");
  assert.equal(next.blacklistReason(key(7)), "too-large");
});
