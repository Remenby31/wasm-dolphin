// Persistent cache of compiled regions (plan piste 3, P6).
//
// Region bytes live in CacheStorage, one cache per identity (disc, core,
// compiler version, JIT flags; see aotCacheIdentity). They are loaded with
// compileStreaming(fetch(url)) through the Service Worker of aot-sw.js, which
// answers from that same cache: that is the path on which V8 keeps the
// optimized code of a module it has tiered up, so a second launch starts on
// TurboFan code instead of compiling again. Without the Service Worker (first
// page load, or no SW support) the bytes are compiled directly: slower, never
// broken.
//
// Trust: an entry carries the SHA-256 of its bytes and is used only if the
// bytes it holds hash to it. A missing hash, a wrong hash, bytes the engine
// rejects: the entry is deleted and reported, the region stays with the JIT.
import { parseDolHeader } from "./dol.js";
import { decodePrebuiltCache, encodePrebuiltCache } from "./prebuilt-jit-cache-format.js";
import {
  AOT_ANY_DISC_KEY,
  AOT_CACHE_NAME_PREFIX,
  JIT_CACHE_ENTRY_KEY_SCHEMA,
  aotCacheIdentity,
  aotCacheName,
  canonicalDiscKey,
  classifyAotCacheIdentity,
  isAotEntryKey,
  sha256Hex
} from "./jit-cache-identity.js";

export const AOT_SW_SEGMENT = "__salon-aot";
export const AOT_SW_PING = "ping";
export const AOT_HASH_HEADER = "x-salon-aot-sha256";
export const AOT_SW_HEADER = "x-salon-aot-sw";
const IDENTITY_ENTRY = "identity.json";
const BLACKLIST_ENTRY = "blacklist.json";

const GC_DISC_MAGIC = 0xc2339f3d;
const MAX_DOL_BYTES = 32 << 20;
const MAX_FST_BYTES = 16 << 20;

// The disc key of a raw GameCube image (canonicalDiscKey), read in three
// slices of the File. Null for anything else (compressed containers, Wii):
// those discs simply get no AOT cache.
export async function readDiscKeyFromFile(file) {
  if (!file || typeof file.slice !== "function" || file.size < 0x440) return null;
  const read = async (offset, length) => new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
  const header = await read(0, 0x440);
  const view = new DataView(header.buffer);
  if (view.getUint32(0x1c, false) !== GC_DISC_MAGIC) return null;
  const dolOffset = view.getUint32(0x420, false);
  const fstOffset = view.getUint32(0x424, false);
  const fstSize = view.getUint32(0x428, false);
  if (dolOffset + 0x100 > file.size || fstSize > MAX_FST_BYTES || fstOffset + fstSize > file.size) return null;
  const dolHeader = parseDolHeader(await read(dolOffset, 0x100));
  const dolSize = Math.max(0x100, ...dolHeader.loadSections.map((s) => s.fileOffset + s.size));
  if (dolSize > MAX_DOL_BYTES || dolOffset + dolSize > file.size) return null;
  return canonicalDiscKey({ header, dol: await read(dolOffset, dolSize), fst: await read(fstOffset, fstSize) });
}

// Registered by the engine page when no site Service Worker controls it.
// Scope: the directory of the script (src/), which holds the workers that
// load regions. A site that has its own Service Worker imports aot-sw.js in
// it instead (see aot-sw.js) and never calls this.
export async function registerAotServiceWorker({ container = globalThis.navigator?.serviceWorker, scriptUrl = new URL("./aot-sw.js?standalone=1", import.meta.url) } = {}) {
  if (!container?.register) return null;
  // A site that serves aot-sw.js from its own Service Worker says so here; a
  // standalone registration left from a visit without the site would take
  // the engine's workers away from it, so it goes.
  if (globalThis.__salonAotServiceWorkerManaged === true) {
    await unregisterAotServiceWorker({ container });
    return null;
  }
  if (container.controller && !String(container.controller.scriptURL).includes("aot-sw.js")) return null;
  try {
    return await container.register(scriptUrl.href ?? String(scriptUrl));
  } catch {
    return null;
  }
}

// Removes the engine's own standalone registration (never a site's): the
// engine page calls it whenever it does not ask for the Service Worker, so a
// visit with ?aotsw=1 does not leave it controlling every later visit.
export async function unregisterAotServiceWorker({ container = globalThis.navigator?.serviceWorker } = {}) {
  let removed = 0;
  try {
    for (const registration of await container?.getRegistrations?.() ?? []) {
      const url = registration.active?.scriptURL ?? registration.installing?.scriptURL ?? registration.waiting?.scriptURL ?? "";
      if (url.includes("aot-sw.js") && url.includes("standalone=1") && await registration.unregister()) removed += 1;
    }
  } catch {
    // nothing to clean
  }
  return removed;
}

export function aotEntryUrl(baseUrl, cacheName, key) {
  return new URL(`${AOT_SW_SEGMENT}/${cacheName}/${encodeURIComponent(key)}.wasm`, baseUrl).href;
}

function identityUrl(baseUrl, cacheName) {
  return new URL(`${AOT_SW_SEGMENT}/${cacheName}/${IDENTITY_ENTRY}`, baseUrl).href;
}

const isQuotaError = (error) => error?.name === "QuotaExceededError" || /quota/i.test(String(error?.message || ""));

function wasmResponse(bytes, sha256) {
  return new Response(bytes, {
    headers: {
      "content-type": "application/wasm",
      "cross-origin-resource-policy": "same-origin",
      [AOT_HASH_HEADER]: sha256
    }
  });
}

async function readIdentity(cacheStorage, name, baseUrl) {
  try {
    const cache = await cacheStorage.open(name);
    return (await (await cache.match(identityUrl(baseUrl, name)))?.json()) ?? null;
  } catch {
    return null;
  }
}

// Caches of the same disc under another core, compiler or flag set: all but
// the `keepPerDisc - 1` most recently opened go (so two tabs, or two flag
// sets in turn, do not wipe each other's cache). Other discs are kept. A
// cache without a readable identity may be one another tab is creating
// right now: it is left alone.
export async function pruneAotCaches({ cacheStorage = globalThis.caches, keep, baseUrl, discKey, keepPerDisc = 2 }) {
  if (!cacheStorage) return [];
  const sameDisc = [];
  for (const name of await cacheStorage.keys().catch(() => [])) {
    if (!name.startsWith(AOT_CACHE_NAME_PREFIX) || name === keep) continue;
    const stored = await readIdentity(cacheStorage, name, baseUrl);
    if (!stored || stored.discKey !== discKey) continue;
    sameDisc.push({ name, openedAt: Number(stored.openedAt) || 0 });
  }
  sameDisc.sort((a, b) => b.openedAt - a.openedAt);
  const removed = [];
  for (const { name } of sameDisc.slice(Math.max(0, keepPerDisc - 1))) {
    if (await cacheStorage.delete(name).catch(() => false)) removed.push(name);
  }
  return removed;
}

// Quota full: drop the least recently opened cache of this schema other than
// `keep`, any disc. Returns its name, or null when there is nothing left.
export async function evictLeastRecentAotCache({ cacheStorage = globalThis.caches, keep, baseUrl }) {
  let oldest = null;
  for (const name of await cacheStorage.keys().catch(() => [])) {
    if (!name.startsWith(AOT_CACHE_NAME_PREFIX) || name === keep) continue;
    const stored = await readIdentity(cacheStorage, name, baseUrl);
    const openedAt = Number(stored?.openedAt) || 0;
    if (!oldest || openedAt < oldest.openedAt) oldest = { name, openedAt };
  }
  if (!oldest) return null;
  await cacheStorage.delete(oldest.name).catch(() => false);
  return oldest.name;
}

// Opens the cache of `identity`. Its name is derived from the identity, so a
// stored identity that differs means an edited or colliding cache: started
// over. A missing one is a new cache (or one another tab is creating): the
// identity is written, nothing deleted. `openedAt` orders caches for pruning
// and quota eviction.
async function openIdentityCache({ cacheStorage, identity, baseUrl, keepPerDisc, clock = Date.now }) {
  const cacheName = await aotCacheName(identity);
  let cache = await cacheStorage.open(cacheName);
  const stored = await readIdentity(cacheStorage, cacheName, baseUrl);
  const check = classifyAotCacheIdentity({ stored, current: identity });
  let reset = null;
  if (stored && check.reset) {
    reset = check.reason;
    await cacheStorage.delete(cacheName);
    cache = await cacheStorage.open(cacheName);
  }
  await cache.put(identityUrl(baseUrl, cacheName), new Response(JSON.stringify({ ...identity, openedAt: clock() }), {
    headers: { "content-type": "application/json" }
  }));
  const pruned = await pruneAotCaches({ cacheStorage, keep: cacheName, baseUrl, discKey: identity.discKey, keepPerDisc });
  return { cache, cacheName, reset, pruned };
}

// A write that hit the quota: evict least recently opened caches, one at a
// time, and try again; false once there is nothing left to evict.
async function writeWithEviction(write, { cacheStorage, keep, baseUrl, maxEvictions = 8 }) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await write();
      return "ok";
    } catch (error) {
      if (!isQuotaError(error)) return "write-error";
      if (attempt >= maxEvictions || !(await evictLeastRecentAotCache({ cacheStorage, keep, baseUrl }))) return "quota";
    }
  }
}

// Region keys must name the guest code they were compiled from: a key ends
// with the SHA-256 (hex) of that code (and whatever else the region depends
// on). The disc key leaves RELs out; this is what keeps a region compiled
// from another revision of a REL from ever being looked up.
const HASHED_KEY_RE = /:[0-9a-f]{64}$/;
export function isHashedAotKey(key) {
  return isAotEntryKey(key) && HASHED_KEY_RE.test(key);
}

// Whether fetches from this context reach aot-sw.js. A page that loaded
// before the Service Worker took control is not controlled, nor its workers.
export async function probeAotServiceWorker(baseUrl, fetchImpl = globalThis.fetch) {
  try {
    const response = await fetchImpl(new URL(`${AOT_SW_SEGMENT}/${AOT_SW_PING}`, baseUrl).href, { cache: "no-store" });
    return response.headers.get(AOT_SW_HEADER) === "1";
  } catch {
    return false;
  }
}

export async function openAotCache({
  discKey,
  coreHash,
  compilerVersion,
  flagsMask,
  baseUrl,
  cacheStorage = globalThis.caches,
  fetchImpl = globalThis.fetch,
  compile = (bytes) => WebAssembly.compile(bytes),
  compileStreaming = (response) => WebAssembly.compileStreaming(response),
  serviceWorker = null,
  onProgress = null,
  keepPerDisc = 2,
  clock = Date.now
}) {
  if (!cacheStorage) return null;
  const identity = aotCacheIdentity({ discKey, coreHash, compilerVersion, flagsMask });
  const { cache, cacheName, reset, pruned } = await openIdentityCache({ cacheStorage, identity, baseUrl, keepPerDisc, clock });
  // The Service Worker may take control after this session opened (first
  // visit): a negative answer is asked again after a while.
  let swReady = serviceWorker;
  let swCheckedAt = -Infinity;
  const viaServiceWorker = async () => {
    if (serviceWorker !== null) return serviceWorker;
    if (swReady !== true && Date.now() - swCheckedAt > 10_000) {
      swCheckedAt = Date.now();
      swReady = await probeAotServiceWorker(baseUrl, fetchImpl);
    }
    return swReady === true;
  };

  let cancelled = false;
  const inflight = new Set();
  const stats = { puts: 0, putBytes: 0, loads: 0, streamed: 0, corrupt: 0, rejected: 0, quota: 0, missing: 0, readErrors: 0, blacklisted: 0 };
  // Regions left to the JIT for good under this identity: bytes the engine
  // rejects, and what the first-launch optimiser reports (untranslatable,
  // too large). It lives in the identity's cache, so a new core, compiler or
  // flag set starts with a clean list.
  const blacklistUrl = new URL(`${AOT_SW_SEGMENT}/${cacheName}/${BLACKLIST_ENTRY}`, baseUrl).href;
  const blacklist = new Map(); // key -> reason
  try {
    const stored = await (await cache.match(blacklistUrl))?.json();
    if (stored && typeof stored === "object") {
      for (const [key, reason] of Object.entries(stored)) if (isHashedAotKey(key)) blacklist.set(key, String(reason));
    }
  } catch {
    // unreadable: start empty, the regions are just tried again
  }
  let blacklistWrite = Promise.resolve();
  function addToBlacklist(entries) {
    let added = 0;
    for (const { key, reason } of entries) {
      if (!isHashedAotKey(key) || blacklist.has(key)) continue;
      blacklist.set(key, String(reason || "refused"));
      added += 1;
    }
    if (!added) return blacklistWrite;
    stats.blacklisted += added;
    const body = JSON.stringify(Object.fromEntries(blacklist));
    blacklistWrite = blacklistWrite.then(() => cache.put(blacklistUrl, new Response(body, {
      headers: { "content-type": "application/json" }
    }))).catch(() => {});
    return blacklistWrite;
  }
  const track = (promise) => {
    inflight.add(promise);
    promise.finally(() => inflight.delete(promise));
    return promise;
  };
  const urlOf = (key) => aotEntryUrl(baseUrl, cacheName, key);
  const progress = (event) => {
    try {
      onProgress?.(event);
    } catch {
      // a listener never breaks the cache
    }
  };

  async function dropEntry(key) {
    try {
      await cache.delete(urlOf(key));
    } catch {
      // already gone
    }
  }

  async function putOne({ key, bytes }) {
    if (!isHashedAotKey(key)) return { key, reason: "bad-key" };
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (!WebAssembly.validate(view)) {
      await addToBlacklist([{ key, reason: "engine-reject" }]);
      return { key, reason: "engine-reject" };
    }
    const sha256 = await sha256Hex(view);
    const outcome = await writeWithEviction(() => cache.put(urlOf(key), wasmResponse(view, sha256)), {
      cacheStorage, keep: cacheName, baseUrl
    });
    if (outcome === "quota") stats.quota += 1;
    if (outcome !== "ok") return { key, reason: outcome };
    stats.puts += 1;
    stats.putBytes += view.byteLength;
    return null;
  }

  async function loadOne(key) {
    if (!isHashedAotKey(key)) return { reason: "bad-key" };
    // Any read that fails drops the entry: the region goes back to the JIT,
    // the launch goes on.
    let stored;
    let bytes;
    try {
      stored = await cache.match(urlOf(key));
      if (stored) bytes = new Uint8Array(await stored.arrayBuffer());
    } catch {
      stats.readErrors += 1;
      await dropEntry(key);
      return { reason: "read-error" };
    }
    if (!stored) {
      stats.missing += 1;
      return { reason: "missing" };
    }
    const claimed = stored.headers.get(AOT_HASH_HEADER);
    if (!claimed || claimed !== await sha256Hex(bytes)) {
      stats.corrupt += 1;
      await dropEntry(key);
      return { reason: "corrupt" };
    }
    try {
      // The bytes are checked above from their own read; the module is then
      // compiled from an untouched response, the one V8 attaches code to.
      let module;
      let streamed = false;
      if (await viaServiceWorker()) {
        const response = await fetchImpl(urlOf(key));
        if (response.ok && response.headers.get(AOT_HASH_HEADER) === claimed) {
          module = await compileStreaming(response);
          streamed = true;
        }
      }
      module ??= await compile(bytes);
      stats.loads += 1;
      if (streamed) stats.streamed += 1;
      return { module, streamed, byteLength: bytes.byteLength };
    } catch (error) {
      if (error instanceof WebAssembly.CompileError || error?.name === "CompileError") {
        stats.rejected += 1;
        await dropEntry(key);
        await addToBlacklist([{ key, reason: "engine-reject" }]);
        return { reason: "engine-reject" };
      }
      return { reason: "compile-error" };
    }
  }

  return {
    identity,
    cacheName,
    reset,
    pruned,
    viaServiceWorker,

    // Synchronous, for the optimiser's skip test.
    isBlacklisted: (key) => blacklist.has(key),
    blacklistReason: (key) => blacklist.get(key) ?? null,
    // [{ key, reason }]: left to the JIT from now on, under this identity.
    // Resolves once written (an unwritable list is kept for this session).
    blacklist: (entries) => addToBlacklist(entries),

    // The keys among `keys` that have an entry. An entry may still turn out
    // corrupt at load; has() only says what is worth not recompiling.
    async has(keys) {
      const present = new Set();
      const wanted = new Set(keys.filter(isHashedAotKey).map(urlOf));
      for (const request of await cache.keys().catch(() => [])) {
        if (!wanted.has(request.url)) continue;
        const name = request.url.slice(request.url.lastIndexOf("/") + 1, -".wasm".length);
        present.add(decodeURIComponent(name));
      }
      return present;
    },

    // Resolves once every entry is either written (one cache.put each, so
    // never half-written) or listed in `failed`. After cancel() the entries
    // not yet started are reported as "cancelled".
    put(entries) {
      return track((async () => {
        const failed = [];
        let done = 0;
        for (const entry of entries) {
          if (cancelled) {
            failed.push({ key: entry.key, reason: "cancelled" });
            continue;
          }
          const failure = await putOne(entry);
          if (failure) failed.push(failure);
          done += 1;
          progress({ type: "put", done, total: entries.length, failed: failed.length });
        }
        return { failed };
      })());
    },

    // Map of key -> {module, streamed} or {reason}. Reasons: missing,
    // corrupt and engine-reject (both deleted), bad-key, compile-error,
    // cancelled.
    load(keys) {
      return track((async () => {
        const out = new Map();
        for (const key of keys) {
          out.set(key, cancelled ? { reason: "cancelled" } : await loadOne(key));
        }
        return out;
      })());
    },

    async delete(keys) {
      for (const key of keys) if (isHashedAotKey(key)) await dropEntry(key);
    },

    async drain() {
      while (inflight.size) await Promise.allSettled([...inflight]);
      await blacklistWrite;
    },

    cancel() {
      cancelled = true;
    },

    stats: () => ({ ...stats })
  };
}

// Block store: the per-block JIT cache that lived in IndexedDB
// ("dolphin-jit-cache"), moved under the same CacheStorage identity scheme.
// Blocks are content-addressed (key = SHA-256 of their bytes), so the store
// is shared by every disc of one core (disc key AOT_ANY_DISC_KEY). Thousands
// of small entries are written as packs of up to `packSize` blocks in the
// prebuilt-cache format, so a boot reads a few dozen entries, not 20 000.
// The caller still verifies every block key against its bytes.
export const BLOCK_STORE_COMPILER_VERSION = JIT_CACHE_ENTRY_KEY_SCHEMA;
const PACK_PREFIX = "blocks-";

export async function openAotBlockStore({
  coreHash,
  baseUrl,
  cacheStorage = globalThis.caches,
  packSize = 512,
  flushMs = 2000,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id)
}) {
  if (!cacheStorage) return null;
  const identity = aotCacheIdentity({
    discKey: AOT_ANY_DISC_KEY,
    coreHash,
    compilerVersion: BLOCK_STORE_COMPILER_VERSION,
    flagsMask: 0
  });
  // Another core's block store is stale (blocks of one core never run on
  // another); keepPerDisc 1 drops it.
  const { cache, cacheName, reset, pruned } = await openIdentityCache({ cacheStorage, identity, baseUrl, keepPerDisc: 1 });
  // Pack names carry this session's id after the sequence number, so two
  // tabs never write the same name; order is by sequence, then session.
  const session = Array.from(globalThis.crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, "0")).join("");
  const packUrl = (seq) => new URL(`${AOT_SW_SEGMENT}/${cacheName}/${PACK_PREFIX}${String(seq).padStart(8, "0")}-${session}.pack`, baseUrl).href;
  const stats = {
    packsRead: 0, packsWritten: 0, blocksWritten: 0, corruptPacks: 0, readErrors: 0, quota: 0, writeErrors: 0,
    duplicatesSkipped: 0, duplicatesRead: 0, compactions: 0
  };
  // Keys already stored (learnt when the packs are read, and as they are
  // written) or waiting in the buffer: a block is written once, however many
  // sessions compile it again before the lazy fill reaches it.
  const known = new Set();
  let nextSeq = 0;
  let buffered = [];
  let timer = null;
  let writing = Promise.resolve(true);
  let lastRead = null;

  async function packRequests() {
    let requests;
    try {
      requests = await cache.keys();
    } catch {
      stats.readErrors += 1;
      return [];
    }
    const urls = requests.map((r) => r.url).filter((u) => u.includes(`/${PACK_PREFIX}`) && u.endsWith(".pack"));
    urls.sort();
    return urls;
  }
  const seqOf = (url) => Number(url.slice(url.lastIndexOf(PACK_PREFIX) + PACK_PREFIX.length).split(/[-.]/)[0]);
  for (const url of await packRequests()) {
    const seq = seqOf(url);
    if (Number.isInteger(seq)) nextSeq = Math.max(nextSeq, seq + 1);
  }

  async function writePack(entries) {
    if (!entries.length) return true;
    try {
      const bytes = encodePrebuiltCache({
        fingerprint: identity.coreFingerprint,
        entryKeySchema: JIT_CACHE_ENTRY_KEY_SCHEMA,
        entries: entries.map(({ key, bytes: b }) => [key, b])
      });
      const sha256 = await sha256Hex(bytes);
      const url = packUrl(nextSeq++);
      const outcome = await writeWithEviction(() => cache.put(url, new Response(bytes, {
        headers: { "content-type": "application/octet-stream", [AOT_HASH_HEADER]: sha256 }
      })), { cacheStorage, keep: cacheName, baseUrl });
      if (outcome === "quota") stats.quota += 1;
      if (outcome !== "ok") {
        if (outcome === "write-error") stats.writeErrors += 1;
        return false;
      }
    } catch {
      stats.writeErrors += 1;
      return false;
    }
    stats.packsWritten += 1;
    stats.blocksWritten += entries.length;
    return true;
  }

  // Resolves true when every pack of what was buffered got written. A failed
  // write never blocks the ones after it.
  function flush() {
    if (timer !== null) clearTimer(timer);
    timer = null;
    const chunk = buffered;
    buffered = [];
    writing = writing.catch(() => true).then(async () => {
      let ok = true;
      for (let i = 0; i < chunk.length; i += packSize) ok = (await writePack(chunk.slice(i, i + packSize))) && ok;
      return ok;
    });
    return writing;
  }

  return {
    identity,
    cacheName,
    reset,
    pruned,

    // Every stored block, packs in write order. A pack that cannot be read,
    // whose bytes do not hash to its header, or that does not decode for this
    // core is deleted: those blocks are compiled again, the launch goes on.
    async entries() {
      await writing.catch(() => true);
      const out = [];
      const seen = new Set();
      const duplicatesBefore = stats.duplicatesRead;
      const urls = await packRequests();
      for (const url of urls) {
        let decoded = null;
        try {
          const response = await cache.match(url);
          if (!response) continue;
          const claimed = response.headers.get(AOT_HASH_HEADER);
          const bytes = new Uint8Array(await response.arrayBuffer());
          if (claimed && claimed === await sha256Hex(bytes)) decoded = decodePrebuiltCache(bytes);
        } catch {
          stats.readErrors += 1;
          decoded = null;
        }
        if (!decoded || decoded.fingerprint !== identity.coreFingerprint) {
          stats.corruptPacks += 1;
          await cache.delete(url).catch(() => {});
          continue;
        }
        stats.packsRead += 1;
        for (const { hash, bytes: b } of decoded.entries) {
          if (seen.has(hash)) {
            stats.duplicatesRead += 1;
            continue;
          }
          seen.add(hash);
          known.add(hash);
          out.push({ key: hash, bytes: b });
        }
      }
      lastRead = { packs: urls.length, entries: out.length, duplicates: stats.duplicatesRead - duplicatesBefore };
      return out;
    },

    // Rewrites the store as full packs of unique blocks once it has become
    // wasteful: duplicates above `maxDuplicateShare` of what was read, or
    // more packs than `maxPacks` (the idle flush writes small ones). The new
    // packs are written before the old ones are deleted, so an interruption
    // leaves duplicates, never a loss. `entries` is what entries() returned.
    async compactIfWasteful(entries, { maxDuplicateShare = 0.2, maxPacks = 64 } = {}) {
      if (!lastRead) return false;
      const total = lastRead.entries + lastRead.duplicates;
      const wasteful = (total > 0 && lastRead.duplicates / total > maxDuplicateShare) || lastRead.packs > maxPacks;
      if (!wasteful) return false;
      await writing.catch(() => true);
      const old = await packRequests();
      let ok = true;
      for (let i = 0; i < entries.length; i += packSize) ok = (await writePack(entries.slice(i, i + packSize))) && ok;
      if (!ok) return false;
      const fresh = new Set(await packRequests());
      for (const url of old) await cache.delete(url).catch(() => {});
      stats.compactions += 1;
      lastRead = { packs: fresh.size - old.length, entries: entries.length, duplicates: 0 };
      return true;
    },

    async count() {
      return (await this.entries()).length;
    },

    // Buffered: a pack is written once `packSize` blocks wait, or `flushMs`
    // after the last one.
    append(key, bytes) {
      if (known.has(key)) {
        stats.duplicatesSkipped += 1;
        return writing;
      }
      known.add(key);
      buffered.push({ key, bytes });
      if (buffered.length >= packSize) return flush();
      if (timer === null) {
        timer = setTimer(() => {
          timer = null;
          flush();
        }, flushMs);
        timer?.unref?.();
      }
      return writing;
    },

    // True once every block of `list` is written.
    appendMany(list) {
      for (const entry of list) {
        if (known.has(entry.key)) {
          stats.duplicatesSkipped += 1;
          continue;
        }
        known.add(entry.key);
        buffered.push(entry);
      }
      return flush();
    },

    flush,

    async clear() {
      buffered = [];
      if (timer !== null) clearTimer(timer);
      timer = null;
      await writing.catch(() => true);
      for (const url of await packRequests()) await cache.delete(url).catch(() => {});
      known.clear();
    },

    stats: () => ({ ...stats, buffered: buffered.length })
  };
}

// The IndexedDB block cache this store replaces, read once and deleted:
// its rows under the current core move into the store, anything else is
// dropped. `indexedDB` is injectable for tests.
export const LEGACY_JIT_IDB_NAME = "dolphin-jit-cache";
export async function migrateLegacyJitIdb({ store, coreFingerprint, idb = globalThis.indexedDB }) {
  const result = { found: false, moved: 0, dropped: 0, reason: "none" };
  if (!idb || !store) return result;
  if (typeof idb.databases === "function") {
    try {
      const dbs = await idb.databases();
      if (!dbs.some((d) => d.name === LEGACY_JIT_IDB_NAME)) return result;
    } catch {
      // fall through and open it
    }
  }
  const db = await new Promise((resolve) => {
    let request;
    try {
      request = idb.open(LEGACY_JIT_IDB_NAME);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      // It did not exist: nothing to migrate. Abort the creation.
      request.transaction?.abort();
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
  if (!db) return result;
  result.found = true;
  const stores = [...db.objectStoreNames];
  const readAll = (name) => new Promise((resolve) => {
    const out = [];
    try {
      const cursor = db.transaction(name, "readonly").objectStore(name).openCursor();
      cursor.onsuccess = (event) => {
        const c = event.target.result;
        if (!c) return resolve(out);
        out.push({ key: c.key, value: c.value });
        c.continue();
      };
      cursor.onerror = () => resolve(out);
    } catch {
      resolve(out);
    }
  });
  const meta = stores.includes("metadata") ? await readAll("metadata") : [];
  const fingerprint = meta.find((m) => m.key === "buildFingerprint")?.value ?? null;
  const schema = meta.find((m) => m.key === "entryKeySchema")?.value ?? null;
  const rows = stores.includes("modules") ? await readAll("modules") : [];
  if (fingerprint === coreFingerprint && schema === JIT_CACHE_ENTRY_KEY_SCHEMA) {
    const moved = [];
    for (const { key, value } of rows) {
      const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : value;
      if (typeof key === "string" && bytes instanceof Uint8Array) moved.push({ key, bytes });
    }
    if (!(await store.appendMany(moved))) {
      // Not all of it reached the store (quota, write error): keep the
      // database as it is, the next boot tries again.
      db.close();
      return { ...result, reason: "store-write-failed" };
    }
    result.moved = moved.length;
    result.dropped = rows.length - moved.length;
    result.reason = "moved";
  } else {
    result.dropped = rows.length;
    result.reason = fingerprint ? "other-core" : "no-identity";
  }
  db.close();
  await new Promise((resolve) => {
    try {
      const del = idb.deleteDatabase(LEGACY_JIT_IDB_NAME);
      del.onsuccess = del.onerror = del.onblocked = () => resolve();
    } catch {
      resolve();
    }
  });
  return result;
}
