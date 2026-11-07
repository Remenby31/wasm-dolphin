# Session 2026-05-12 (Day 7) — persistent JIT cache via pthread-receive design

Day 7 shipped a persistent JIT cache for the CachedInterpreter's WASM
compile path, bypassing the cross-pthread-table dead-end from Day 6.

## Result

Cross-session reload empirically works. Three consecutive 60s probes
against the same persistent Chromium profile:

| Session | Pre-loaded modules | New compiles this session |
|---------|--------------------|---------------------------|
| 1 (cold) | 0 | 131 |
| 2 | 130 | 1 |
| 3 | 141 | (further growth) |

GameSpeed stays at ~99% across all sessions. IDB on disk: 1.4KB after
session 1's `WebAssembly.Module`-storage attempt; 189KB after switching
to raw-bytes storage.

## Architecture

Three pieces, all reachable from `tools/jit-cache-prejs.js` (pthread
receiver), `src/upstream-discio-worker.js` (master cache + IDB), and
`vendor/dolphin/Source/Core/Core/PowerPC/CachedInterpreter/CachedInterpreter.cpp`
(EM_JS cache lookup).

1. **Pthread receiver (pre-js).** Concatenated into the Emscripten
   bundle via `--pre-js`. On pthread workers (detected via
   `globalThis.name === "em-pthread"`) it adds a message listener that
   stashes the discio worker's master cache onto `Module._dolphinJitCache`.
2. **EM_JS cache lookup.** `DolphinWeb_CachedInterpreterCompileWasmBlock`
   now FNV-1a-hashes the incoming wasm bytes, checks
   `Module._dolphinJitCache` for a cached `WebAssembly.Module`, and
   instantiates it locally on the pthread's own `wasmTable` on hit.
   This avoids the Day-6 cross-thread table problem entirely.
3. **Discio master cache + IDB.** Discio worker holds `Map<hashHex, Module>`,
   loaded from IndexedDB at boot. Pthreads `self.postMessage`
   cache-miss notifications back to discio (caught via
   `worker.addEventListener("message", ...)` on each pthread Worker
   handle — runs alongside Emscripten's `worker.onmessage`). Discio
   async-compiles + writes the raw bytes to IDB. The cache map is sent
   to each pthread once at factory() return time (after IDB load
   completes).

## Sub-bugs found and fixed

- **Hash collisions.** Initial stride-8 sampling for the FNV-1a hash
  caused different PowerPC blocks to share keys, leading to wrong-Module
  cache hits → infinite block re-execution → JIT cooldown. Fix: hash
  every byte. Collision risk now negligible.
- **WebAssembly.Module IDB storage.** `store.put(mod, hash)` returned
  `tx.oncomplete` but `req.onsuccess` never fired and the data didn't
  survive a reload. Empirically unreliable on the Chromium version in
  Playwright. Fix: persist raw `Uint8Array` bytes and recompile via
  `WebAssembly.compile(bytes)` at boot. ~1ms × N compiles is well
  inside the boot budget.
- **Build target scope.** `npm run build:upstream:discio` recompiled
  the bridge but NOT the core `.wasm`, so EM_JS edits silently went
  stale. `npm run build:upstream:full-core` is the right command after
  CachedInterpreter.cpp changes.

## What was left out (later work)

- **Cross-build cache invalidation.** Right now a new dolphin core
  build will produce different wasm bytes for the same PowerPC block,
  so cache lookups will miss (correct behavior). The stale entries
  remain in IDB indefinitely. A "build fingerprint" key + bulk-clear
  on mismatch would tidy this up, but isn't load-bearing.
- **LRU eviction.** Hard cap at `DOLPHIN_JIT_CACHE_MAX = 8192`. Past
  that, new entries are dropped silently. For a typical session
  this is well above what the JIT ever compiles, so it's only relevant
  for long-running sessions across many games.

## Code pointers

- `tools/jit-cache-prejs.js` — pthread message receiver
- `vendor/dolphin/Source/Core/Core/CMakeLists.txt:link-options` — adds
  `--pre-js` link option and exposes `PThread` in EXPORTED_RUNTIME_METHODS
- `vendor/dolphin/Source/Core/Core/PowerPC/CachedInterpreter/CachedInterpreter.cpp`
  — EM_JS body with cache lookup + cache-miss postMessage
- `src/upstream-discio-worker.js` — IDB load/store, master cache map,
  bidirectional pthread channel installation
- `tools/menu-progress-validate.mjs` — new `PROBE_PERSIST_DIR` env to
  use a persistent Chromium profile (so IDB survives across probe runs)
