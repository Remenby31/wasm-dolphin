// Pre-js: this file is concatenated INSIDE the Emscripten module's IIFE
// before any other Module code runs (per --pre-js link option). It runs
// in every Emscripten worker context — the main runtime thread (the
// discio worker), each pthread Worker, etc. We branch on
// `globalThis.name === 'em-pthread'` to scope behaviour to pthreads only.
//
// Purpose: Day-7 persistent JIT cache. The discio worker holds a master
// Map<hashHex, WebAssembly.Module> populated from IndexedDB at boot.
// When pthreads spawn, the discio worker postMessages the cache to each.
// Each pthread instantiates cached Modules locally on its own wasmTable
// (the cross-pthread-table problem from Day-6 is bypassed because the
// pthread does its own grow + set with its own Module).
//
// This file:
//   1. On pthread side, adds an event listener for "dolphin-jit-cache"
//      messages. When one arrives, stashes the cache map on Module so
//      the EM_JS compile body can use it.
//   2. On main runtime side, exposes Module.PThread so the discio
//      worker can iterate spawned pthreads after factory() returns.

(function dolphinJitCachePreJs() {
  // Detect environment. Emscripten pthread workers set `globalThis.name`
  // to "em-pthread" before this file is concatenated. The main runtime
  // thread (whichever thread called factory()) has no such name.
  const isPthread =
    typeof globalThis !== "undefined" &&
    globalThis.name === "em-pthread";

  if (isPthread) {
    // Pthread side: receive cache map and stash it.
    // We use addEventListener (not onmessage =) so we don't clobber
    // Emscripten's own onmessage handler that processes pthread control
    // messages (start function, exit, etc.).
    globalThis.addEventListener("message", (event) => {
      const data = event.data;
      if (!data) return;
      if (data.type === "dolphin-jit-cache") {
        // Bulk-set: discio worker pushes the entire map at boot.
        // Stash on globalThis first so that even if `Module` isn't ready
        // yet (pre-js timing), the cache survives until Module is.
        globalThis._dolphinPendingJitCache = data.cache || null;
        if (typeof Module !== "undefined") {
          Module._dolphinJitCache = globalThis._dolphinPendingJitCache;
        }
        // First-message diagnostic. Logged via console; will surface in the
        // browser console + the validator's worker-console capture.
        if (!globalThis._dolphinJitCacheLogged) {
          globalThis._dolphinJitCacheLogged = true;
          const size = data.cache && data.cache.size ? data.cache.size : 0;
          // eslint-disable-next-line no-console
          console.log("[jit-cache:pthread] received cache (size=" + size + ")");
        }
      } else if (data.type === "dolphin-jit-cache-add" && data.hash && data.module) {
        // §28ch incremental add: discio worker sends a single
        // {hash, module} entry as it lazy-loads more of the IDB beyond
        // the boot-load cap. Merge into the existing map (don't replace).
        const target =
          (typeof Module !== "undefined" && Module._dolphinJitCache) ||
          globalThis._dolphinPendingJitCache;
        if (target && target.set) {
          target.set(data.hash, data.module);
          globalThis._dolphinJitCacheAddCount =
            (globalThis._dolphinJitCacheAddCount || 0) + 1;
          // Log every 1000th add so we know lazy fill is making progress
          // without spamming.
          if (globalThis._dolphinJitCacheAddCount % 1000 === 0) {
            // eslint-disable-next-line no-console
            console.log(
              "[jit-cache:pthread] lazy adds=" +
                globalThis._dolphinJitCacheAddCount +
                " size=" +
                target.size
            );
          }
        }
      } else if (data.type === "dolphin-jit-cache-barrier") {
        // Worker messages are processed in FIFO order. Acknowledging this
        // marker proves that the initial cache and every preceding lazy add
        // have reached this pthread before a fixed-scene benchmark starts.
        if (
          typeof Module !== "undefined" &&
          !Module._dolphinJitCache &&
          globalThis._dolphinPendingJitCache
        ) {
          Module._dolphinJitCache = globalThis._dolphinPendingJitCache;
        }
        const installedCache =
          typeof Module !== "undefined" ? Module._dolphinJitCache : null;
        globalThis.postMessage({
          type: "dolphin-jit-cache-barrier-ack",
          generation: data.generation,
          installed: Boolean(installedCache?.get && installedCache?.set),
          cacheSize: Number(installedCache?.size) || 0,
        });
      }
    });
  } else {
    // Main runtime side (the discio worker). Stash a hook so JS code
    // outside this bundle can reach Module.PThread once the module is
    // initialized. We can't reference PThread directly here (it's a
    // file-scoped var declared later by Emscripten), so we just leave a
    // marker and the post-init code on the worker side will grab
    // Module.PThread itself.
    if (typeof Module !== "undefined") {
      Module._dolphinJitCacheReady = false;
    }
  }
})();
