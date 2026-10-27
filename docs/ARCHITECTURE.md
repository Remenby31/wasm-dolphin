# wasm-dolphin architecture

Orientation for someone (or some agent) arriving cold. It describes what the
system is, how a frame gets from a disc image to the canvas, and which parts are
load-bearing versus experimental. Everything here was verified against the tree,
not inherited from older notes.

## What this is

Upstream Dolphin, patched and compiled to WebAssembly with Emscripten, running
GameCube discs in a browser. The emulator core is real Dolphin — this repository
is a pinned upstream checkout plus a patch series plus a browser host.

It is **not** a recompiler. See [Execution model](#execution-model): PowerPC is
translated to WebAssembly at runtime, per hot block.

## Boot path

```
index.html
  └─ src/bootstrap.js          module entry; reaches app.js through a TOP-LEVEL AWAIT
       └─ src/app.js           DOM, settings UI, HUD, input wiring
            └─ src/core-host.js            EmulatorHost: URL flags -> options
                 └─ src/upstream-worker-adapter.js
                      └─ new Worker(src/upstream-discio-worker.js)
                           └─ cores/dolphin/dolphin-core-upstream.js + .wasm
                                └─ Emscripten pthreads (PTHREAD_POOL_SIZE=16)
```

Two things here bite anything automating the page:

- `app.js` evaluates **after** `domcontentloaded`, because bootstrap.js awaits its
  import. Anything that touches `#romInput` before then fires a change event at
  no listener: the input holds the file, nothing reads it, and the run dies on a
  mount timeout with `No file` still on screen. Wait for `#statusPill` to leave
  its initial `"Booting"` text.
- The HUD counters were renamed from `<metric>Counter` to `hud<Metric>`, and are
  not always updated. `window.__lastFrameInfo` carries the same values as
  structured fields, unconditionally. Prefer it. A stale id reads `""` -> 0, and
  0 is indistinguishable from a dead core.

## Execution model

Three tiers in `vendor/dolphin/Source/Core/Core/PowerPC/CachedInterpreter/CachedInterpreter.cpp`:

1. **Interpreter** — stock Dolphin fallback.
2. **CachedInterpreter** — stock Dolphin. Decodes a PPC block once into a list of
   C++ callback pointers and re-runs that list. No code generation.
3. **PPC -> WebAssembly JIT** — this project's own work, and the reason
   "cached interpreter" undersells it. For admitted hot blocks the C++ emits
   WebAssembly module bytes at runtime (the `{0x00,0x61,0x73,0x6d,...}` literal
   is `\0asm` plus version 1), hands them to JS through
   `EM_JS(DolphinWeb_CachedInterpreterCompileWasmBlock)`, which calls
   `new WebAssembly.Module()` / `new WebAssembly.Instance()` and invokes the
   result. Modules are keyed by hash and cached in IndexedDB across sessions.

So the pipeline is **PowerPC -> WebAssembly -> V8 native**: a double compile. The
JIT emits portable bytecode and relies on the browser engine to lower it. That
single fact explains most of the constraints:

- Each newly admitted block costs a *synchronous* `WebAssembly.Module()` compile
  on the CPU pthread, which is why admission is selective and why compile bursts
  are deliberately smeared.
- There are no cross-module direct jumps in WASM, so blocks return to a
  dispatcher instead of chaining. Block re-dispatch was the fix that recovered
  part of that cost.
- Host memory-trap fastmem cannot exist: the guest cannot catch host page faults,
  the engine owns the trap. The masked-bounds + direct-load path is the only
  in-browser fastmem available.

## Video paths

Two, selected by `?video=`:

| Path | Flags | What it does | State |
| --- | --- | --- | --- |
| Software hybrid | `video=software&presenter=webgpu` | Dolphin's software rasterizer writes the XFB; JS uploads and blits it | **Shipping default.** 43/45 discs; accurate but capped at ~7 mean unique visual fps |
| Hardware | `video=wgpu` | Dolphin's WebGPU backend drives a command ring consumed in JS | **Experimental but working.** 41/45 discs; mean unique visual fps 23.2 vs the software path's 7.1, eight titles locked at 60 — see [webgpu-hardware-renderer-bugs.md](webgpu-hardware-renderer-bugs.md) |

`createWebGpuPresenter()` is **shared by both**. A change made there for the
hardware path lands on the shipping path too; that has already caused one silent
regression that blanked any game whose XFB is not 640x480.

The presenter itself is chosen by `?presenter=` (`webgpu` or `webgl`), and
swapping it is the cheapest way to split "the core produced nothing" from "the
presenter failed to show it".

## Provenance and the build

The core binary is reproducible from committed inputs, and the tooling fails
closed rather than warning:

- `provenance/dolphin-source.lock.json` — pinned upstream commit
  (`e22551e`), 53 ordered patches, external repositories.
- `provenance/dolphin-vendor-snapshot-v1.json` — per-path evidence of the
  patched tree.
- `provenance/dolphin-core-abi-v1.json` — the core's exported ABI plus the
  artifact hash and the hashes of local C++ sources.

Documented order, and it matters:

```bash
npm run verify:toolchain
npm run fetch:dolphin        # restores external repos; needs a PRISTINE vendor tree
npm run patch:upstream       # applies the 53 locked patches
npm run configure:upstream
npm run build:upstream:full-core
npm run update:core-abi      # after ANY change to core sources or the artifact
```

Traps worth knowing before losing an hour to them:

- `npm run` searches upward for `package.json`. Running it from inside
  `vendor/dolphin` finds the root manifest but sets `process.cwd()` to the
  submodule, so every provenance path resolves against the wrong root and the
  errors are nonsense. **Always run from the repository root.**
- `classifyLockedCheckout` only takes its bootstrap path on a *completely* clean
  vendor tree. Dirty nested submodules (`Externals/SFML/SFML`,
  `Externals/xxhash/xxHash`) push it down the snapshot path, which then reports
  ~100 "missing" files that are simply not patched yet.
- The build leaves `__pycache__` inside the spirv-tools checkout. Provenance
  treats those as extras and fails. Delete them before re-running.
- `git clean -fd` inside `vendor/dolphin` deletes the untracked glslang
  externals. `npm run fetch:dolphin` puts them back.
- `update:core-abi` also rewrites the default core's hash,
  `cores/dolphin/core.lock.json` (read by `src/default-core.js`). Rebuild without it and the worker rejects
  the core at `loadCore-entry`, which looks like a hang but is a fingerprint
  mismatch.

### The toolchain lock does not capture everything

The core committed before this checkpoint recorded the same emscripten 5.0.7,
compiler commit and emsdk commit as a fresh build here, yet contained
`FS.filesystems={MEMFS,NODEFS,WORKERFS}` where a fresh build produces `{MEMFS}`.
It was built against a different Emscripten than the one it records. The naga
staticlib hash differs the same way, under a byte-identical toolchain record and
a build that is otherwise bit-reproducible on this machine. Treat the toolchain
lock as necessary but not sufficient.

## Test harnesses

- `tools/menu-progress-validate.mjs` — depth. Drives Melee through a scripted
  route, samples HUD and canvas, captures screenshots and save-state round-trips.
- `tools/boot-matrix.mjs` — breadth. Boots every disc in a library for a fixed
  window and classifies each. Verdicts are `mount-fail` / `black` / `stalled` /
  `static` / `boots`, ordered so core-liveness is judged before pixel-change —
  those two disagree in both directions.

Both read the emulator's own counters, so a surprising verdict should be checked
against the canvas screenshots before it is believed. Three separate "broken
game" findings during this checkpoint turned out to be probe or tooling bugs.

## Working in a git worktree (agents, parallel investigation)

Three independent investigations in this repository were nearly invalidated by
the same environment problems. Check all three before trusting a single
measurement taken in a worktree.

1. **Confirm which commit you are on.** Worktrees have arrived checked out at
   an unrelated commit rather than the branch that was asked for. One agent was
   16 commits behind and would have tested a *pre-fix* core, producing a
   confident "still broken" verdict for a bug that was already fixed. It caught
   this itself; the next one might not.

       git log --oneline -1
       git merge-base --is-ancestor <expected-commit> HEAD && echo on-lineage

   The core is a committed prebuilt `.wasm`, so being on the right commit is
   usually enough -- no rebuild needed to get the current renderer.

2. **`vendor/dolphin` does not exist in a worktree.** It is generated by
   `fetch:dolphin` + `patch:upstream` and deliberately untracked, so a worktree
   cannot rebuild the core and cannot read the patched Dolphin sources. Tests
   that inspect them will fail -- that is expected, not a regression. C++ work
   has to happen in the main checkout.

3. **Playwright lives in the main repo only**, at
   `.omx/browser-probe/node_modules`. `tools/boot-matrix.mjs` resolves it from
   there, so a worktree needs that path junctioned or `PLAYWRIGHT_MODULE` set
   before any browser run.

## Measurement discipline

Learned the expensive way, and worth keeping:

- **A single run is not evidence for an intermittent failure.** Animal Crossing
  renders 5/6 runs on one branch and 0/6 on another. Three consecutive good runs
  were once reported as "fixed"; it was not.
- **Speed is scene-dependent.** The window average and the steady-state tail
  disagree in both directions — one game reads 27% over a window and 99.5% warm,
  another reads 95% then 24.5% once it reaches an FMV. Neither number is a
  compatibility grade, and a 2-3 point difference in a 45-game mean is noise.
- **Verdicts plus screenshots** carry the signal. Counters alone do not.
- **Know what a counter counts.** The HUD's `prim/draw` badge is primitives
  over draw calls, both counted at submission. It was read for months as
  "submitted vs landed" and used as evidence that draws were being dropped. It
  reads 136/379 on a correct Wario World frame and 124/380 on a broken one.
- **Check the title that could falsify you, not the one that shows the win.**
  A scissored-clear change was reported as working after being checked only on
  Mario Kart Wii, whose frame was already broken, so "less broken" read as
  "fixed". A 45-disc sweep then found it had dropped Wario World from a
  detailed throne room at 60 fps to a near-black frame. The same mistake -- a
  frame rate measured on a menu with no 3D content -- shipped a wrong per-game
  renderer default earlier the same day.
- **Two long-standing "renderer" problems were tooling.** The ~50% Melee mount
  flakiness (issue #10) was both harnesses classifying the optional JIT-cache
  prewarm status as a fatal mount failure, because its text contains "failed";
  whether a run died depended on whether the 1 Hz poll landed in that window.
  And every speed number recorded before 2026-08-30 was understated, because
  the JIT disable guard compared presentation fps against a baseline captured
  on a lighter scene and fused the JIT off on entering gameplay. Suspect the
  harness before the renderer.
