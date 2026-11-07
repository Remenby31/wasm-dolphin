# OGL Hardware Path — Performance Plan & Handoff

**Last updated:** 2026-05-11 (Day 2 JIT-corruption fix landed; addex/subfex/addcx/subfcx/addic/subfic RD-store reorder)

This document captures the multi-day work needed to get the OGL hardware
rendering path to native-emulation speed in the browser. Read this before
diving in; the session that produced commit `1e05b65` left a lot of context
that isn't obvious from the diff alone.

## TL;DR — current state

| Backend | gameSpeed | visualFps | distinct/s | Playable? |
|---------|----------:|----------:|-----------:|-----------|
| `video=software` + `wasmjit=1` + `fastsw=1` + `pacing=smooth` (NEW recommended) | **100.15 %** | **22.36** | 0.71 | **Yes — best** |
| `video=software` + `wasmjit=0` + `fastsw=1` + `pacing=smooth`                  |  99.43 % | 25.69 | 0.90 | Yes (old recommended) |
| `video=ogl` + `oglproxy=readback` + `forcejit=1` (Day-2 acceptance)            |  98.75 % |  1.27 | 0.34 | Visually slow + bursty CPU swings 10–327 %; not ideal for play |
| `video=ogl` + `oglproxy=readback` + JIT off                                    |  84 %    |  ~1.3 | ~0.3 | Slower CPU; visually similar to above |
| `video=ogl` + `oglproxy=worker` (Day-3 investigated)                            |  84.92 % | 83 (worker-internal) | 0 distinct on visible canvas | No — pthread `postMessage` swallowed by Emscripten |
| `video=ogl` + `oglproxy=proxy`                                                 |  75.2 %  | 8.16 | 0 distinct on visible canvas | No — OffscreenCanvas auto-mirror inactive |

**The Day-2 carry-op fix unlocked `software+wasmjit=1` (was previously
broken at 14 % + dot-matrix corruption — same root cause as the OGL JIT bug).
This is now the best playable config.** OGL paths reach near-full gameSpeed
but the visible canvas only repaints 1–4 ×/s, *and* the CPU thread experiences
10–327 % per-sample swings (bursty stalls) that feel like slow motion +
input lag in actual play. Software backend doesn't have either problem.

**Recommended playable URL right now (Day-2 fix + software+JIT + Day-8 queue bump, post-2026-05-12):**
```
http://127.0.0.1:8082/?core=upstream&video=software&cpu=dual&speed=1&present=full&presenter=webgpu&pacing=smooth&jittier=guarded&jitwarmup=700&wasmjit=1&oc=1&queue=4&fastsw=1&metrics=1
```

Day 8 (presentFps gap fix): bumped default presentation queue from 2 → 4
(`DEFAULT_PRESENTATION_QUEUE` in `src/upstream-discio-worker.js`,
`requestedPresentationQueueSize` in `src/core-host.js`). At queue=2 +
`pacing=direct` (the old validator default), the paint-loop p95 interval
hit 60ms+ whenever a JIT compile or worker-contention spike dropped a
frame, which clamped the reported `presentFps` to ~16-18. The actual
paint rate was already 59 fps — queue=4 + `pacing=smooth` absorbs the
jitter and the metric now reads 55+ fps to match. No latency cost:
`presentationQueueTarget = 1` keeps steady-state buffering at 1 frame;
the extra slots only kick in on transient spikes.

Only difference from the prior URL: `wasmjit=1` (was `0`). With the Day-2 carry-op
fix the JIT-on path no longer corrupts the title screen, so we get the
speedup without the previously-fatal rendering bug. The OGL hardware URL
also works visually but stutters under play; software is faster and smoother.

## What's blocking native-speed OGL

Three independent walls. Each needs its own day. They are NOT a single bug.

### Wall 1 — JIT mis-emits opcodes that corrupt 3D rendering
- With `wasmjit=1` (or `forcejit=1` on OGL), starting at frame ~700 (JIT
  engagement threshold), the game's 3D rendering paths break. Symptoms vary
  by mode:
  - Software: gameSpeed crashes to 14%, pixel-write opcodes mis-emit
    (dotted "skip every other pixel" pattern on title screen)
  - OGL: gameSpeed stays at 100% but `prim:1540 draw:250 verts:0 rast:0`
    — drawcalls submitted but vertex/raster state corrupt. Only 4
    distinct canvas hashes captured.
- We landed two partial fixes during the bisection (both reverted because
  they regressed):
  - idle-poll fast loop partial-state-commit on `guard_failed=true`
  - an idle-poll-loop batch of 256 coalescing CoreTiming events
- One non-reverted fix: bumped JIT block emitter's WASM memory page count
  16384→24576 to match the bumped 1.5 GiB heap. That killed a `LinkError`
  but didn't fix the rendering-corruption layer.
- Diagnosis pointer: prior tracer agent (now dead) suspected carry-bit
  propagation across same-block instructions like `addcx`/`addzex`. May
  be worth following up.

### Wall 2 — OffscreenCanvas mirror doesn't paint from worker thread
- `oglproxy=worker` mode renders the GL context's drawing buffer directly
  to the canvas that was `transferControlToOffscreen`'d from main thread.
  In theory the on-page placeholder auto-updates at each task boundary
  in the worker. In practice we see `visualFps:0` even when the worker
  reports it's pushing frames.
- We tried four architectures partially: explicit `requestAnimationFrame`
  yields, render-to-FBO + `transferToImageBitmap` + postMessage, raw
  `OffscreenCanvas.commit()`, SAB-backed pixel buffer. None landed at
  production quality in this session.
- Diagnosis pointer: most likely the worker simply doesn't yield to the
  event loop frequently enough; the GL context's implicit "swap on task
  boundary" semantics need an actual task boundary. Hardcoded yields
  feel hacky; need a clean architectural fix.

### Wall 3 — Readback path has unavoidable `glReadPixels` overhead
- The currently-working OGL config (`oglproxy=readback`) does
  `glReadPixels` every frame to copy GPU framebuffer to CPU memory, then
  hands the bytes to the worker's WebGPU presenter which paints the
  visible canvas. Round-trip is ~10-15ms per frame at 320×240, dropping
  gameSpeed from 100% to 84%.
- This is the *most likely* to yield results in a single day because the
  fix is a known pattern (async PBO + reduced internal res), but it
  caps us at "good not great" — Wall 2 is needed for "great."

## Five-day plan

### Day 1 — Instrumentation & bisection infrastructure ✅ (landed 2026-05-11)
Goal: stop speculating, start measuring.

1. **Per-helper disable URL flags**. ✅ Implemented as `?disable=<category,...>`.
   Categories: `idlepollloop`, `statuscall`, `osinterrupt`, `dcbxloop`, `fastbranch`,
   `fastfp`, `fastinteger`, `fastsystem`, `wasmblock`. Also accepts hex/decimal
   raw mask and aliases `fastinputpoll`→statuscall, `fastmem`→fastsystem,
   `all`→0x1ff. URL→adapter→worker→`_SetCachedInterpreterDisableMask` atomic;
   gates live in every `TryWrite*` in `CachedInterpreter.cpp`. Validator env
   var: `DISABLE=...`. **No rebuild needed between bisection runs.**
2. **Validator metric split** ✅. `tools/menu-progress-validate.mjs`
   `summarize()` now emits `overall`, `preJit`, `postJit` buckets plus a
   `jitEngagementSampleIndex` and `jitEngagementElapsedSeconds`. The split
   triggers on the first sample where any of: `statusPill` includes
   `"JIT enabled"`, helper stats contain `jit:on`, or `jitBlockCompileCount`
   goes nonzero (the validator now reads the latter directly from `#ppcWasmJit`).
3. **C++ per-frame ring buffer over SAB** ✅. 256-entry × 32-byte ring lives
   in `dolphin_web_discio.cpp` and is pushed from `DolphinWeb_OnOglSwap` with
   frame/prim/draw/verts/xfb_hash/glerr/commit_result/debug_bits. Exposed
   via four C entry points (`GetFrameRing{EntryPtr,Capacity,EntrySize,Head}`),
   drained 1Hz in the worker via `Module.HEAPU32` and printed to console as
   `[frame-ring] f=… prim=… draw=… verts=… xfb=… glerr=… commit=… dbg=…`.

**Day-1 verification (this session):**
- Regression sweep `VIDEO=software/WASMJIT=0/FASTSW=1` (120s): 96 distinct
  canvas hashes, avgGameSpeed 100.16%, no regression vs the documented
  playable baseline.
- Wiring smoke `DISABLE=idlepollloop` (60s): 53 distinct hashes, avgGameSpeed
  99.22%, helper stats no longer report idle-loop `attempts:N` (was 8 in
  baseline) → gate is firing.

**Open Day-2 polish item:** Playwright validator's `page.on("console")` only
captures main-thread logs — the worker's `[frame-ring]` and disable-mask
postStatus messages aren't currently saved to `console.log`. Add a worker
listener via `browserContext.on("worker", ...)` or expose `[frame-ring]`
through a getter the validator can poll directly.

### Day 2 — JIT corruption bisection ✅ (landed 2026-05-11)
Goal: pinpoint which fast-path category miscompiles.

**Root cause: WASM JIT emit ordering for the 6 carry-emitting ops.** All
of `addex`/`subfex`/`addcx`/`subfcx`/`addic`/`subfic` stored the result to
`GprOffset(RD)` first, then re-read `RA`/`RB` from memory to compute the
new XER.CA. PowerPC commonly emits these as in-place `adde rD, rA, rB`
with `rD == rA` (or `rB`), so the re-read picked up the post-store value,
producing a wrong carry. The corrupted CA cascaded through subsequent
`adde`/`subfe`/`addze` chains and broke 3D rendering at the first JIT
engagement (~frame 700).

`addzex` (SUBOP10=202) didn't share the bug — its emit caches `result` in
`local[3]` and never re-reads `RA`. That was the asymmetry the bisection
used: only-addzex-active was the *only* single-op configuration that
didn't freeze.

**Fix (six emit sites):** Reorder so the new XER.CA is computed and stored
**before** the `GprOffset(RD)` write. Full per-op diffs in
`patches/dolphin-wasm/SESSION-2026-05-11-DAY-2-NOTES.md`.

**Verification:**
- `FORCEJIT=1` OGL readback, no disable mask: **distinct=127**,
  postJit gameSpeed **98.75 %**, JIT engaged, 6405 blocks compiled.
- Software-mode regression sweep: 94 distinct / 100.08 % gameSpeed —
  statistically identical to Day-1 baseline (96 / 100.16 %).

**Diagnostic infra retained:** per-op carry disable bits stay in the build
so any future regression in this family is `?disable=wasmadde` away from
isolation, no rebuild required.

### Day 3 — OffscreenCanvas worker-mirror (investigated 2026-05-12, **NOT shipped**)
Goal: eliminate the readback round-trip.

**Status:** worker-mode painting still doesn't reach char select. The
existing `detachedOglFrame` scaffolding (option (b)) was built on a wrong
assumption: it expected the Emscripten GPU pthread's `self.postMessage`
to land on its parent worker. It doesn't — Emscripten's pthread runtime
intercepts user-level postMessage calls. Bitmap capture from the GPU
pthread *does* succeed via `GL.currentContext.GLctx.canvas.transferToImageBitmap()`
(3000+ frames per minute in tests) but the messages never reach the
discio-worker forwarder. Catch-all message counter on discio-worker shows
only `load`/`mixAudio` arrive; zero `detachedOglFrame`.

`oglproxy=proxy` (direct GL→transferred canvas, no readback) also produces
`distinct=1` — Chrome's OffscreenCanvas placeholder auto-mirror is not
firing under this build's pthread layout. `cpu=single` doesn't keep the
canvas on the worker thread because Emscripten's `OFFSCREENCANVAS_SUPPORT`
transfers it to whichever pthread first runs GL.

The only working OGL path remains `oglproxy=readback`, which carries the
Day-2-fix's gameSpeed (≈ 98 %) but a low `visualFps` (1–4/s) versus
software-mode's 22–26/s. That's a real ~20× gap in actual visible paint
rate even though the emulator runs at full speed.

**What was learned (see `patches/dolphin-wasm/SESSION-2026-05-12-DAY-3-NOTES.md`):**
- GPU pthread bitmap capture works; the *transport* is the broken piece.
- `cpu=single` is not a workaround.
- Lower readback resolution (`present=half`) is faster than full-res;
  WebGL presenter beats 2D presenter; WebGPU close to WebGL.

**Next session's first move (Day 4 candidate):** SAB-backed pixel transport.
GPU pthread `glReadPixels` into a shared `Uint8ClampedArray`, bump a
generation counter via `Atomics.add`, main thread runs a `requestAnimationFrame`
loop that `putImageData`s the pixels onto the visible canvas when the
generation changes. Bypasses both the pthread-message problem and the
OffscreenCanvas auto-mirror problem in one shot.

**Done when:** `oglproxy=worker` (or whatever replaces it) reaches char
select at `gameSpeed ≥ 60 %` *and* `visualFps ≥ 15` on the validator.

### Day 4 — Readback-path optimization (fallback)
Goal: if Day 3 hits a Chrome/Emscripten wall, make readback 2× faster.

1. Profile `DolphinWebPublishAsyncReadback` in
   `vendor/dolphin/Source/Core/Common/GL/GLInterface/Emscripten.cpp`.
   Time the `glReadPixels` call vs the memcpy to `s_framebuffer`. If GPU
   sync dominates: pipeline with PBOs.
2. Implement async readback: kick off `glReadPixels` for frame N into a
   PBO, fence-wait on frame N-1's PBO, copy that to `s_framebuffer`. One
   frame of latency in exchange for parallel GPU/CPU work.
3. Drop internal readback res to 160×120 (currently 320×240). 4× fewer
   pixels.
   **Done when:** `oglproxy=readback` gameSpeed ≥ 95%.

### Day 5 — Integration, polish, documentation
1. Merge winning changes coherently.
2. Full validator sweep across both backends and all OGL proxy modes.
3. Test in real Chrome AND real Firefox (with someone's actual installs,
   not Playwright bundled — Playwright Firefox lacks WASM/WebGL).
4. Update `patches/dolphin-wasm/` with clean per-feature patches extracted
   properly (the session that ended at commit 21636b4 ducked this by
   writing `SESSION-2026-05-10-NOTES.md` instead — that needs to become
   real patches).
5. Update top-level `README.md` with recommended URLs + architecture
   notes.

## Files most relevant to this work

### In-repo (committed)
- `src/core-host.js` — URL param parsing, adapter wiring
- `src/upstream-discio-worker.js` — Emscripten module factory, worker
  presentation loop, OGL canvas plumbing
- `src/upstream-worker-adapter.js` — main-thread side of the worker
  interface; `detachedOglFrame` handler
- `src/app.js` — page logic; gamepad poll loop; auto-screenshot when
  DBG on
- `core/upstream/dolphin_web_core.cpp` — exported C entry points;
  WASM-JIT block compiler half (other half is in vendor/dolphin)
- `tools/menu-progress-validate.mjs` — Playwright validation harness;
  the one you'll run constantly
- `tools/build-upstream-target.mjs` — `npm run build:upstream` wrapper

### In `vendor/dolphin/` (gitignored)
- `Source/Core/Common/GL/GLInterface/Emscripten.{h,cpp}` — WebGL2 context
  creation, swap, commit_frame handling
- `Source/Core/VideoBackends/OGL/OGLMain.cpp` — OGL backend init,
  `FillBackendInfo`, conservative defaults
- `Source/Core/VideoBackends/OGL/OGLConfig.cpp` — `PopulateConfig`,
  extension probing
- `Source/Core/VideoBackends/OGL/OGLGfx.cpp` — `BindBackbuffer`,
  `PresentBackbuffer`, `RenderXFBToScreen`
- `Source/Core/VideoCommon/Present.cpp` — the `Renderer::Present` flow
  (BindBackbuffer → RenderXFBToScreen → PresentBackbuffer)
- `Source/Core/Core/PowerPC/CachedInterpreter/CachedInterpreter.cpp` —
  WASM JIT block compiler; all `TryWrite*` / `TryEmit*` fast-paths;
  the idle-poll fast loop, the inline input-status helper, etc.
- `Source/Core/Core/CMakeLists.txt` — `target_link_options` for
  `dolphin_web_core` (memory size, exports list)

### Patches (re-applied on clean vendor/dolphin)
- `patches/dolphin-wasm/0001`–`0009` — existing patch chain
- `patches/dolphin-wasm/SESSION-2026-05-10-NOTES.md` — five session edits
  not yet captured as patches (must be re-applied on top of 0001–0009)

## How to actually start work

1. Restore environment:
   ```
   cd C:\Users\douglaswhittingham\wasm-dolphin
   git pull
   npm install
   npm run serve   # in another shell — serves on 8082
   ```
2. Skim `commit 1e05b65` and `commit 21636b4` to absorb session context.
3. Skim `patches/dolphin-wasm/SESSION-2026-05-10-NOTES.md` for the
   vendor changes.
4. Pick Day 1 — it's pure tooling work, low risk, high leverage. Even
   if Days 2–4 hit walls, Day 1's instrumentation makes the next
   investigation 10× faster.
5. Validator runs:
   ```
   node tools/menu-progress-validate.mjs --duration 180 \
     --out-dir .omx/menu-progress/<run-name>
   ```
   Env vars: `VIDEO=software|ogl`, `OGL_PROXY_MODE=readback|worker|proxy`,
   `FORCEJIT=1`, `WASMJIT=0|1`, `JITTIER=guarded|mixed`, `FASTSW=0|1|2`,
   `PRESENTER=webgpu|webgl|2d`, `PACING=direct|smooth`,
   `BROWSER=firefox|chromium`, `HEADED=1`, `QUEUE_SIZE=`, `OC=`,
   `JITWARMUP=`, `PRESENT=full|half`.
6. Rebuild:
   ```
   node tools/build-upstream-target.mjs dolphin_web_core
   ```
   3 min wall clock on a warm cache. Targets `discio` and others available
   but `dolphin_web_core` is the one that produces the final
   `cores/dolphin/dolphin-core-upstream.{js,wasm}`.

## Things to NOT do

- Don't trust the validator's `avgGameSpeed` over a JIT-on run — it
  averages pre-JIT (good) and post-JIT (broken) samples. Wait for Day 1's
  split-by-JIT-status metric.
- Don't launch unsupervised subagents without a clear bisection mandate.
  One ran 4.5h speculating about carry-bit propagation without making
  progress.
- Don't increase `INITIAL_MEMORY` above 2 GiB — Firefox has a per-worker
  cap there.
- Don't bisect via the idle-poll-loop batch size — already tried, too
  aggressive at small values, broke gameSpeed.
- Don't commit the 14K-line full `git diff HEAD` from `vendor/dolphin`
  as a patch — already tried, useless as a versioned artifact. The
  per-feature patches need to be extracted with proper isolation.

## Open questions you'll want to answer

1. Does Chrome's `OffscreenCanvas.placeholder` automatically repaint when
   GL renders to its drawingBuffer from a pthread spawned via Emscripten's
   pthread runtime? Or does it need a yield/RAF/commit?
2. Is the JIT corruption deterministic in WHICH instruction kind it
   miscompiles, or stochastic / timing-dependent? Day 1 instrumentation
   should answer this.
3. Can we get a `transferToImageBitmap` to actually return a non-zero
   bitmap from a `Module.canvas` accessed via Emscripten pthread? Earlier
   attempt returned 0×0 dimensions even though the canvas reported 640×480.

## Where the diagnostics live

Most of the diagnostic value from this investigation is in the distinct-hash
screenshot trees under `.omx/menu-progress/<name>/`.
