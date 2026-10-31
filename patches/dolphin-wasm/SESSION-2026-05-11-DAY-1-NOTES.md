# Session 2026-05-11 (Day 1) — vendor/dolphin source changes for the new instrumentation knobs

This session's WASM rebuild embeds two new edits to `vendor/dolphin/` not yet
captured as numbered patches. They support the Day-1 instrumentation work
described in `docs/ogl-performance-plan.md`:

1. A per-helper disable bitmask gating each `TryWrite*` fast path in the
   cached-interpreter, so the *same* build can bisect JIT fast-path categories
   without rebuilding between runs.
2. (Not vendored — handled entirely in `core/upstream/dolphin_web_discio.cpp`
   which is in-repo: a per-OGL-swap ring buffer drained over Module.HEAPU32
   by the worker on a 1Hz timer.)

If you're rebuilding from a clean upstream Dolphin clone, apply the changes
in `SESSION-2026-05-10-NOTES.md` first, then the changes below, then run
`npm run build:upstream`.

---

## 1. `Source/Core/Core/CMakeLists.txt` — export the new entry points

Inside the `target_link_options(dolphin_web_core ...)` block, in
`EXPORTED_FUNCTIONS`, after `'_SetPpcProfileEnabled'`:

```diff
-'_SetFastSoftwareRaster','_SetPpcWasmJitEnabled','_SetPpcProfileEnabled'
+'_SetFastSoftwareRaster','_SetPpcWasmJitEnabled','_SetPpcProfileEnabled',
+'_SetCachedInterpreterDisableMask','_GetCachedInterpreterDisableMask',
+'_GetFrameRingEntryPtr','_GetFrameRingCapacity','_GetFrameRingEntrySize',
+'_GetFrameRingHead'
```

**Why:** Each `_Foo` name in `EXPORTED_FUNCTIONS` is what the JS side reaches
via `Module._Foo` / `cwrap("Foo", …)`. Adding the names is what makes the
new C entry points reachable from `src/upstream-discio-worker.js`'s
`bindApi()`. The four `_GetFrameRing*` symbols expose the storage + head
counter for the in-RAM ring buffer pushed by `DolphinWeb_OnOglSwap` in
`core/upstream/dolphin_web_discio.cpp` (in-repo, no vendor patch needed
for the storage side).

---

## 2. `Source/Core/Core/PowerPC/CachedInterpreter/CachedInterpreter.cpp` — per-helper disable bitmask

### 2a. Top-of-file `<atomic>` include

Add `<atomic>` to the standard-library includes block near line 6:

```diff
 #include <algorithm>
 #include <array>
+#include <atomic>
 #include <bit>
```

### 2b. Disable-mask globals + helper inside the anonymous namespace

After the `namespace { ` opening (around line 103), at the start of the
file-local statics:

```cpp
// Bitmask of CachedInterpreter fast-path categories the host has asked us to
// skip. Set via the SetCachedInterpreterDisableMask extern "C" entry (wired
// up through `?disable=...` URL flag → worker → Module → setter) so the same
// build can bisect categories without rebuilding. Cleared = nothing disabled,
// emit everything as usual.
//
// Atomic because the setter is callable from the JS main thread while the
// JIT compiler runs on the Dolphin CPU thread. Relaxed ordering is fine.
std::atomic<u32> s_dolphin_web_disable_mask{0};

constexpr u32 DOLPHIN_WEB_DISABLE_IDLEPOLLLOOP   = 1u << 0;
constexpr u32 DOLPHIN_WEB_DISABLE_STATUSCALL   = 1u << 1;
constexpr u32 DOLPHIN_WEB_DISABLE_OSINTERRUPT = 1u << 2;
constexpr u32 DOLPHIN_WEB_DISABLE_DCBXLOOP    = 1u << 3;
constexpr u32 DOLPHIN_WEB_DISABLE_FASTBRANCH  = 1u << 4;
constexpr u32 DOLPHIN_WEB_DISABLE_FASTFP      = 1u << 5;
constexpr u32 DOLPHIN_WEB_DISABLE_FASTINT     = 1u << 6;
constexpr u32 DOLPHIN_WEB_DISABLE_FASTSYSTEM  = 1u << 7;
constexpr u32 DOLPHIN_WEB_DISABLE_WASMBLOCK   = 1u << 8;

inline bool DolphinWebHelperDisabled(u32 bit)
{
  return (s_dolphin_web_disable_mask.load(std::memory_order_relaxed) & bit) != 0;
}
```

### 2c. Public setter / getter at file scope (outside namespace)

After the closing `}  // namespace` of the long anonymous block (around
line 6700, just before `CachedInterpreter::CachedInterpreter`):

```cpp
extern "C" std::uint32_t DolphinWeb_SetCachedInterpreterDisableMask(std::uint32_t mask)
{
  return s_dolphin_web_disable_mask.exchange(mask, std::memory_order_relaxed);
}

extern "C" std::uint32_t DolphinWeb_GetCachedInterpreterDisableMask()
{
  return s_dolphin_web_disable_mask.load(std::memory_order_relaxed);
}
```

### 2d. Gate the fast-path emitters

Add a single early-`return false` to the start of each helper function. For
the multi-branch `TryWriteFastInstruction`, gate each sub-category inline
using a once-loaded `disable_mask` local. The full diff is in the working
tree — search for `DolphinWebHelperDisabled(` and `DOLPHIN_WEB_DISABLE_`
references in `CachedInterpreter.cpp`. Gated functions:

- the idle-poll-loop and title-loop writers → `DOLPHIN_WEB_DISABLE_IDLEPOLLLOOP`
- `TryWriteOsInterruptFunction` → `DOLPHIN_WEB_DISABLE_OSINTERRUPT`
- `TryWriteDcbxLoop` → `DOLPHIN_WEB_DISABLE_DCBXLOOP`
- `TryWriteFastInstruction` → per-sub-path gates on `STATUSCALL`, `OSINTERRUPT`,
  `FASTBRANCH`, `FASTFP`, `FASTINT`, `FASTSYSTEM`
- `TryWriteWasmBlock` → `DOLPHIN_WEB_DISABLE_WASMBLOCK`

**Why:** Day-1 wall-1 bisection (`docs/ogl-performance-plan.md` Day 2)
requires toggling fast-path categories at runtime via `?disable=...` so a
single build can sweep ~10 configurations in ~30 min instead of rebuilding
for each. Bit assignments are stable; new categories should append, not
renumber.

---

## How to use the new disable knob (no vendor changes needed)

```
http://127.0.0.1:8082/?...&disable=wasmblock
http://127.0.0.1:8082/?...&disable=idlepollloop,statuscall
http://127.0.0.1:8082/?...&disable=0x1ff   # all-on
```

Validator env var: `DISABLE=idlepollloop,statuscall node tools/menu-progress-validate.mjs ...`

Aliases preserved for the plan's TL;DR-listed knobs:
- `fastinputpoll` → `statuscall` (input-poll lives inside the status call-branch family)
- `fastmem` → `fastsystem` (load/store-ish helpers cluster here)
