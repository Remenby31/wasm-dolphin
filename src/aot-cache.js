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
import {
  AOT_CACHE_NAME_PREFIX,
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
  // A site that serves aot-sw.js from its own Service Worker says so here.
  if (globalThis.__salonAotServiceWorkerManaged === true) return null;
  if (container.controller && !String(container.controller.scriptURL).includes("aot-sw.js")) return null;
  try {
    return await container.register(scriptUrl.href ?? String(scriptUrl));
  } catch {
    return null;
  }
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

// Every cache of this schema whose name is not `keep`: other discs are kept,
// only caches of the same disc under another core, compiler or flag set are
// stale. `discOf` maps a cache name to its disc key (read from its identity
// entry); null means unreadable, so stale.
export async function pruneAotCaches({ cacheStorage = globalThis.caches, keep, baseUrl, discKey = null }) {
  if (!cacheStorage) return [];
  const removed = [];
  for (const name of await cacheStorage.keys()) {
    if (!name.startsWith(AOT_CACHE_NAME_PREFIX) || name === keep) continue;
    if (discKey) {
      let stored = null;
      try {
        const cache = await cacheStorage.open(name);
        stored = await (await cache.match(identityUrl(baseUrl, name)))?.json();
      } catch {
        stored = null;
      }
      if (stored && stored.discKey !== discKey) continue;
    }
    await cacheStorage.delete(name);
    removed.push(name);
  }
  return removed;
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
  onProgress = null
}) {
  if (!cacheStorage) return null;
  const identity = aotCacheIdentity({ discKey, coreHash, compilerVersion, flagsMask });
  const cacheName = await aotCacheName(identity);
  let cache = await cacheStorage.open(cacheName);
  const stored = await (await cache.match(identityUrl(baseUrl, cacheName)))?.json().catch(() => null);
  const check = classifyAotCacheIdentity({ stored: stored ?? null, current: identity });
  if (check.reset) {
    // A cache under this name with another (or no readable) identity: start
    // it over. A brand-new cache lands here too ("missing-stored-identity").
    await cacheStorage.delete(cacheName);
    cache = await cacheStorage.open(cacheName);
    await cache.put(identityUrl(baseUrl, cacheName), new Response(JSON.stringify(identity), {
      headers: { "content-type": "application/json" }
    }));
  }
  const pruned = await pruneAotCaches({ cacheStorage, keep: cacheName, baseUrl, discKey: identity.discKey });
  let swReady = serviceWorker;
  const viaServiceWorker = async () => {
    if (swReady === null) swReady = await probeAotServiceWorker(baseUrl, fetchImpl);
    return swReady;
  };

  let cancelled = false;
  const inflight = new Set();
  const stats = { puts: 0, putBytes: 0, loads: 0, streamed: 0, corrupt: 0, rejected: 0, quota: 0, missing: 0 };
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
    if (!isAotEntryKey(key)) return { key, reason: "bad-key" };
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (!WebAssembly.validate(view)) return { key, reason: "engine-reject" };
    const sha256 = await sha256Hex(view);
    const write = () => cache.put(urlOf(key), wasmResponse(view, sha256));
    try {
      await write();
    } catch (error) {
      if (!isQuotaError(error)) return { key, reason: "write-error" };
      // Make room once: stale caches of this disc first (already pruned at
      // open, so this is for caches made since), then give up on this entry.
      await pruneAotCaches({ cacheStorage, keep: cacheName, baseUrl, discKey: identity.discKey });
      try {
        await write();
      } catch {
        stats.quota += 1;
        return { key, reason: "quota" };
      }
    }
    stats.puts += 1;
    stats.putBytes += view.byteLength;
    return null;
  }

  async function loadOne(key) {
    if (!isAotEntryKey(key)) return { reason: "bad-key" };
    const stored = await cache.match(urlOf(key));
    if (!stored) {
      stats.missing += 1;
      return { reason: "missing" };
    }
    const claimed = stored.headers.get(AOT_HASH_HEADER);
    const bytes = new Uint8Array(await stored.arrayBuffer());
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
        return { reason: "engine-reject" };
      }
      return { reason: "compile-error" };
    }
  }

  return {
    identity,
    cacheName,
    reset: check.reset ? check.reason : null,
    pruned,
    viaServiceWorker,

    // The keys among `keys` that have an entry. An entry may still turn out
    // corrupt at load; has() only says what is worth not recompiling.
    async has(keys) {
      const present = new Set();
      const wanted = new Set(keys.filter(isAotEntryKey).map(urlOf));
      for (const request of await cache.keys()) {
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
      for (const key of keys) if (isAotEntryKey(key)) await dropEntry(key);
    },

    async drain() {
      while (inflight.size) await Promise.allSettled([...inflight]);
    },

    cancel() {
      cancelled = true;
    },

    stats: () => ({ ...stats })
  };
}
