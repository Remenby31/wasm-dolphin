# Session 2026-05-13 (Day 10) — OGL Wall 2: renderBackend=ogl + stall loggers

User picked "OGL Wall 2" from the next-step menu. The perf plan describes
Wall 2 as "OffscreenCanvas mirror doesn't paint from worker thread" with
several partially-tried architectures (RAF yields, transferToImageBitmap,
OffscreenCanvas.commit(), SAB pixel buffer). The Day-5 commit shipped the
SAB pixel transport (opt-in via `?oglsab=1`) but the OGL backend with
SAB still rendered to a stuck canvas in the perf plan's measurements.

## The bug

In `src/upstream-discio-worker.js`'s setup, the SAB+OGL branch did this:

    } else if (oglSabEnabledForLoad && moduleCanvas) {
      renderCanvas = moduleCanvas;
      workerOwnsCanvas = true;
      postStatus("Worker SAB OGL: standalone OffscreenCanvas, pixels via SharedArrayBuffer");
    }

The adjacent `detachedOgl` branch correctly sets `renderBackend = "ogl"`
but the SAB branch forgot to. Without it, `renderBackend` stayed at the
file-scope default `"none"`, so when the presentation loop reached the
backend-dispatch block:

    if (coreBoot.accepted && frameSignalHeap && renderBackend === "ogl") {
      const oglSwap = parseOglSwapStats(...).swap >>> 0;
      const oglFrameKey = oglSwap > 0 ? oglSwap : coreFrame;
      ...
      presentFrame(width, height, pointer, ..., oglFrameKey);
    } else if (coreBoot.accepted && frameSignalHeap && presentationPacingMode === "direct") {
      presentFrame(width, height, pointer, ..., coreFrame);

we fell through to the *non*-OGL branch and used `coreFrame` as the
present-dedup key. OGL bypasses the XFB code that ticks `api.getFrame()`
per visible frame, so `coreFrame` stayed at 0 for the entire run — every
`presentFrame` after the first early-returned on `coreFrame ===
lastPresentedCoreFrame`, `publishOglSabFrame` was never called, the SAB
generation counter never incremented, and the main thread's RAF read
the same generation forever.

Net effect: pthread reports thousands of OGL swaps, but the visible
canvas has exactly **one** distinct hash across a 60-second probe.

## The fix

One line: set `renderBackend = "ogl"` in the SAB branch alongside
`renderCanvas` and `workerOwnsCanvas`. Now the dispatch hits the OGL
branch, oglFrameKey ticks per swap, presentFrame dedups correctly,
publishOglSabFrame fires per swap, and main-thread RAF picks up the
updated generation.

## Measured

| Config | gameSpeed | visualFps | distinct hashes / 60s |
|--------|----------:|----------:|----------------------:|
| OGL+SAB+forcejit BEFORE | 61.7 % | 0.12 | 1 |
| OGL+SAB+forcejit AFTER  | **107.8 %** | **3.59** | **48** |
| OGL+SAB+forcejit, 180s validator | 102 % | 2.9 | 133 |

User-side live confirmation: the character-select screen now renders
with full 3D textures, character portraits, UI overlays. First time
the OGL backend has shown game content end-to-end through the SAB
pipeline.

## Stall loggers (left in place for follow-up)

The fix lifts OGL to functional but the user reports occasional 2-second
freezes during scene transitions (max paint-gap = 2190 ms with p95 = 6
ms — a single outlier). Three 180-second validator probes (one HEADED,
one cold-IDB, one warm) failed to reproduce; the freeze appears tied to
interactive input timing the scripted walkthrough doesn't hit.

Two diagnostic loggers were added so the next live reproduction tells
us where the stall lives:

  - `[stall#N*]` — fires when a single `runPresentationLoop` iteration
    exceeds 100 ms. Prints per-stage breakdown (`pump`, `api`,
    `present`). Catches in-loop stalls (e.g. an expensive pumpHostJobs).
  - `[signal-stall#N*]` — fires when `Atomics.waitAsync` on the frame
    signal resolves after >200 ms. Prints just the wait duration.
    Catches pthread-side stalls (e.g. glReadPixels blocking on a deep
    GPU queue during texture upload) that the discio worker only
    experiences as a long signal gap.

Both are throttled to log the new-worst sample and every 5th after
that, so a sustained slow patch surfaces in the console without
overwhelming it.

## Known follow-ups

- Reproduce the 2 s freeze on the user's live setup and read the
  console for `[stall]` / `[signal-stall]`. Next session.
- `parseOglSwapStats` reads `ogl_swap:N` from the videoStats string,
  but `DolphinWeb_OnGlBackbuffer`'s `s_video_stats` doesn't include
  that field (only `PadDebugStats` + `XfbProfileStats` get appended).
  So `oglSwap` returns 0 and `oglFrameKey` falls back to `coreFrame`.
  This still works because in OGL+readback mode, `coreFrame`
  (= `s_frame`) ticks per swap via OnGlBackbuffer + OnOglSwap (two
  bumps per swap). Adding `OglSwapStats()` to the OnGlBackbuffer
  output would make `parseOglSwapStats` work properly — a tidy
  follow-up but not load-bearing.
- HEADED Chrome probe at 47 samples in 180s with gameSpeed=63.71%
  (vs headless 133 samples, gameSpeed=100%). Real Chrome has more
  overhead. Not surprising; worth noting if we ever benchmark
  "real-world headed" performance.

## Files touched

- `src/upstream-discio-worker.js`
  - SAB+OGL branch: `renderBackend = "ogl"`
  - `runPresentationLoop`: per-stage timing + `[stall]` logger
  - `scheduleFrameSignalWait`: wait-duration timing + `[signal-stall]`
    logger
- `patches/dolphin-wasm/SESSION-2026-05-13-DAY-10-NOTES.md` — this file
