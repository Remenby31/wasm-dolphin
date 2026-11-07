# Session 2026-05-13 (Day 9) — JIT cache build fingerprinting

Follow-up to Day 7. The persistent JIT cache previously had no way to
detect that the dolphin-core-upstream.wasm binary had changed between
sessions, so stale entries from a previous build would persist in
IndexedDB forever — harmless (the per-block hash inputs are the wasm
bytes themselves, so collisions across builds are negligible) but they
took up IDB quota and never evicted.

This session adds a build-fingerprint check that compares the current
wasm's hash with the one stored alongside the modules. Mismatch clears
the modules store before loading; same fingerprint loads normally.

## Mechanism

1. `loadCore` pre-fetches the wasm binary up front (instead of letting
   Emscripten's `locateFile` do it). Same single fetch on the wire —
   we hand the bytes to Emscripten via `wasmBinary: <ArrayBuffer>` and
   it skips its own fetch.
2. Stride-64 FNV-1a hash over the full wasm (~1 ms on 8 MB) produces a
   compact fingerprint string of the form
   `${hashHex}:${lengthHex}`. The length suffix gives extra entropy on
   the rare case where two builds hash-collide at stride 64.
3. New IDB schema (`DOLPHIN_JIT_IDB_VERSION = 2`) adds a `metadata`
   object store alongside the existing `modules` store. The v1 → v2
   migration deletes the modules store one time — pre-v2 entries have
   no associated fingerprint and would otherwise be treated as belonging
   to the current build forever.
4. `reconcileJitCacheWithBuild(fingerprint)` runs before module load:
   reads the stored fingerprint, clears modules on mismatch, writes the
   current fingerprint, then loads modules. Called from `loadCore`
   after the wasm fetch and before `factory()`.

## Verification

Three back-to-back probes against the same `PROBE_PERSIST_DIR` chrome
profile:

| Run | Fingerprint | Pre-loaded modules | Action |
|-----|-------------|-------------------:|--------|
| 1 (cold) | computed | 0 | First-boot path: stored fingerprint written |
| 2 (same build) | computed (same as 1) | 738 | Match path: cache pre-loaded, no clear |
| 3 (perturbed) | computed (XOR seed ^ 1) | 0 | Mismatch path: cache cleared, fresh fingerprint stored |

After reverting the perturbation, a follow-up probe would re-clear
(since the stored "perturbed" fingerprint now mismatches the
unperturbed one) and rebuild — exactly the desired behaviour when
switching between two builds.

## Schema migration

The v1 → v2 IDB migration runs once per user. Their pre-Day-9 cache
(if any) is dropped on first boot post-Day-9. Acceptable cost: one
session of recomputed cache, no behaviour regression.

## What's NOT covered

- Multi-build coexistence: stored fingerprint is a single value, so
  switching between two builds rapidly will keep clearing and
  rebuilding instead of caching each. Solving this would need a
  per-fingerprint modules store. Not worth the complexity for the
  expected use case (one active build at a time).
- LRU eviction across the cache-cap boundary (DOLPHIN_JIT_CACHE_MAX =
  8192). Still hard-cap dropping new entries when full. A real LRU
  would track per-entry access time. Not load-bearing yet — the reference game
  produces well under 8192 unique compile-blocks.

## Files touched

- `src/upstream-discio-worker.js`:
  - `openDolphinJitIdb` — schema v1 → v2, adds `metadata` store, drops
    `modules` on upgrade
  - `readDolphinJitMetadata` / `writeDolphinJitMetadata` /
    `clearDolphinJitModulesStore` — new helpers
  - `fetchWasmAndFingerprint(coreUrlValue)` — pre-fetches wasm and
    hashes it
  - `reconcileJitCacheWithBuild(fingerprint)` — replaces the eager IIFE
    load with a deferred path that runs after the fingerprint is known
  - `loadCore` — calls `fetchWasmAndFingerprint`, awaits
    `reconcileJitCacheWithBuild`, passes `wasmBinary` into `factory`
- `patches/dolphin-wasm/SESSION-2026-05-13-DAY-9-NOTES.md` — this file
