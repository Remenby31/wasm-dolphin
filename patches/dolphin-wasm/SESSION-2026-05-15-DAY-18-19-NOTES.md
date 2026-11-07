# Session 2026-05-15 (Days 18–19) — Real WebGPU backend + zero-copy present

Day 17 left `?video=wgpu` activating the real `WebGPU::VideoBackend`
class but only showing the EFB clear colour, because the backend's
Pipeline/Draw ops were no-ops. Days 18–19 made `?video=wgpu` render
real game content *and* present it faster than the Day-16 hybrid.

## Day 18 — WebGPUGfx delegates to Software's rasteriser

The WebGPU pipeline (WGSL shaders, GPU rasterisation of GameCube TEV)
is a multi-week build. To get real frames now, Day 18 wires the
WebGPU video backend to reuse Software's CPU rasteriser, presenting
through wgpu instead of Software's GL window:

- `WebGPU::VideoBackend::Initialize` now calls `Clipper::Init()` /
  `Rasterizer::Init()` and hands `InitializeShared` Software's pieces:
  `SWVertexLoader`, `SW::SWBoundingBox`, `SW::SWEFBInterface`,
  `SW::TextureCache`, plus a base `PerfQueryBase`. The AbstractGfx is
  our `WebGPUGfx`.
- `WebGPUGfx` is "SWGfx without a GL window": `CreateTexture` returns
  `SW::SWTexture`, `CreateFramebuffer` returns `SW::SWFramebuffer`,
  `ClearRegion`→`EfbCopy::ClearEfb()`, `SetScissorRect`→
  `Rasterizer::ScissorChanged()` — exactly SWGfx's behaviour so the
  rasteriser's `static_cast<SWTexture*>(...)` calls stay valid. The
  one divergence is `ShowImage`, which routes the XFB pixels to the
  discio worker for a real `wgpuRenderPass` blit rather than GL.
- `videowebgpu` now links `videosoftware` (CMakeLists). The unused
  Day-14 stubs (`WebGPUTexture`, `WebGPUVertexManager`,
  `WebGPUBoundingBox`, `PerfQuery`, `TextureCache`) were dropped from
  the target.

Namespace gotchas hit during the build: `Clipper`, `Rasterizer`,
`EfbCopy`, `SWVertexLoader` are at global scope; `SW::SWTexture`,
`SW::SWBoundingBox`, `SW::SWEFBInterface`, `SW::TextureCache` live in
namespace `SW`. Matched `VideoSoftware::Initialize` exactly.

Result: `?video=wgpu` shows the game's 1P-mode menu — 18 distinct
canvas hashes in a 20s probe (vs 11 for the Day-16 hybrid).

## Day 19 — zero-copy ShowImage (the perf win)

Day-18 `ShowImage` sliced the 1.2 MB XFB into a transferable
ArrayBuffer and postMessaged it every frame. Since the wasm heap is a
SharedArrayBuffer shared with the discio worker (`USE_PTHREADS=1`),
that copy is unnecessary: post only `{ptr, len, width, height}` and
let the worker read the pixels directly out of `moduleInstance.HEAPU8`
at the C++ pointer. Same zero-copy pattern `?video=software` already
uses for `s_framebuffer`.

`drawFrameBytesToWebGpu` only *reads* the view
(`queue.writeTexture` copies into the GPU texture), so no JS-side
allocation is needed at all. Small tear risk if C++ overwrites the
SWTexture before the worker reads it, but the XFB buffer is stable
for a full frame and the worker is driven off the same frame signal,
so reads stay coherent in practice.

### Measured impact (20s `VIDEO=wgpu PRESENTER=webgpu` probe)

| Metric            | Day 18      | Day 19          |
| ----------------- | ----------- | --------------- |
| Present fps       | ~28–31      | **57**          |
| Frame gap         | 32–50 ms    | **17.5 ms**     |
| Long frames / s   | 4–8         | **0**           |
| Drops / underruns | some        | **0 / 0**       |
| Distinct hashes   | 18/21       | 19/21           |

Near-perfect 60 Hz, dead-consistent pacing, zero dropped frames —
the per-frame 1.2 MB slice + structured-clone was the dominant
present-path cost.

## State of play

- `?video=webgpu` — Day-16 string-bridge hybrid (Software backend +
  JS WebGPU presenter). Still works; now redundant.
- `?video=wgpu` — real `WebGPU::VideoBackend` class, Software CPU
  rasteriser underneath, zero-copy present through a real
  `wgpuRenderPass`. **This is the recommended path.** Faster and
  smoother than the hybrid.

## What's still CPU-bound (the remaining big arc)

GameCube rasterisation (TEV stages, vertex transform, texture
sampling) still runs on the CPU via Software's `Rasterizer` /
`Tev` / `TextureSampler`. That's the ~90%-speed ceiling. Days 20+:
move pieces onto the GPU with real WGSL — start with the
fixed-function blit pipeline (already JS-side; pull into C++ once an
OffscreenCanvas-compatible surface path is sorted), then the TEV
pixel shader emitter (GLSL→WGSL via retarget or Naga/Tint). Each
piece shifts load from CPU to GPU and lifts the speed ceiling.

## Day 20 — fix the Day-19 tear race

Day-19's zero-copy posted the SWTexture pointer directly. The CPU
rasteriser overwrites that buffer for the next frame while the discio
worker is still reading it → visible diagonal tear/smear in-game
(user-reported: memory-card dialog, title screen, in-match all showed
mixed frame N / N+1 smearing).

Fix: `WebGPUGfx` owns a 4-slot ring of `std::vector<u8>` buffers.
`ShowImage` memcpys the just-finished XFB into the next slot and posts
*that* slot's pointer. We only cycle back to a slot 4 frames later —
long after the worker (driven off the same frame signal, ~57 fps) has
blitted it. Net cost vs Day-19: one linear-memory memcpy (~1 ms avg
gap, 17.5 → 18.5 ms); still far below Day-18's JS slice +
structured-clone (32–50 ms, 4–8 long frames/s).

70s `VIDEO=wgpu` probe: `fps:54 gap:18.5/32.5ms long:1 drop:0` over
8601 frames, 63 distinct hashes — smooth, no tear artifacts on the
menus/character-select.

## Day 21 — exploded-geometry fix (the real bug) + linear present filter

User reported (after Day 20) severe artifacts on BOTH fastsw=0 and
fastsw=1, on menus *and* in-match: triangles radiating from a
vanishing point, diagonal light-streaks across the whole frame. This
was NOT the Day-19 tear race (that was fixed) — it's corrupt
clip-space geometry.

Root cause: `WebGPU::VideoBackend::InitBackendInfo` was a hand-written
"WebGPU capabilities" template (MaxTextureSize 8192, dual-source blend
off, primitive-restart on, compute on, clip-control/reversed-depth on,
`bUsesLowerLeftOrigin` unset, …). But the actual renderer under
`?video=wgpu` is Software's CPU rasteriser. VideoCommon's
`VertexShaderManager` / projection setup reads these flags to decide
clip-space origin, depth range, and Y-flip. With WebGPU-shaped values
feeding the Software transform path, every vertex landed in garbage
clip space → the explosion artifact.

Fix: `InitBackendInfo` is now a byte-for-byte copy of
`VideoSoftware::InitBackendInfo` (SWmain.cpp) — `api_type=Nothing`,
`MaxTextureSize=16384`, `bUsesLowerLeftOrigin=false`,
`bSupportsDualSourceBlend=true`, `bSupportsPrimitiveRestart=false`,
`bSupportsLogicOp=true`, etc. Backend info must describe what's truly
rendering. (Flips to real WebGPU caps when Days 22+ land WGSL
rasterisation.)

60s `VIDEO=wgpu` probe after the fix: character-select renders clean
— no streaking, no exploded triangles. (Lesson for the Day-18
delegation approach: any backend that delegates to Software's
rasteriser must also mirror Software's `InitBackendInfo`, not just its
Gfx/texture classes.)

Also Day-21 (JS-only, no rebuild): the WGPU presenter's XFB→canvas
sampler switched `nearest` → `linear`. GameCube is 640x480; the
canvas is larger, so nearest hard-blocked every texel. Linear smooths
the upscale at zero GPU cost.

## Day 21 (cont.) — JIT no longer flaps off ("feels slower" fix)

After the geometry fix the user said it looked right but "feels
slower". HUD showed the cause: *"Experimental WASM JIT temporarily
off (fps:20 gap:50ms; cooldown 300 frames)"* — recurring.

`maybeDisablePpcWasmJit` fused the WASM JIT whenever
`presentationFps < 25 || p95Gap > 40ms`. Those absolute thresholds
assumed a GPU-class renderer. Under `?video=wgpu` the CPU software
rasteriser caps present fps at ~20 (fastsw=0 full-res) — so the guard
fired every cooldown, flapping the JIT off → PPC ran the slow
interpreter → the perceived slowdown. The JIT *helps* CPU throughput
regardless of render fps; fusing it there was strictly harmful.

Rewrote the fuse to be regression-relative: snapshot
`presentationFps` immediately before the JIT engages
(`ppcWasmJitPreEngageFps`), and only disable if presentation fell to
< 65% of that baseline (a regression the JIT caused) or fps is
catastrophically low in absolute terms (< 6, a real freeze, distinct
from a merely heavy renderer). The 5s post-activation stall check
(compile-burst freezes) is unchanged. Removed the now-unused
`WASM_JIT_MIN_ACTIVE_PRESENTATION_FPS` /
`WASM_JIT_MAX_ACTIVE_PRESENTATION_GAP_MS` constants.

90s `VIDEO=wgpu FASTSW=1` probe: `jit:on` stays engaged the whole
run (zero "temporarily off" messages), `fps:57 gap:17.5/17.5ms
long:0 drop:0` over 9136 frames. JS-only change — no rebuild.

Lesson: any guard with absolute presentation thresholds breaks when
the renderer (not the thing being guarded) sets the fps ceiling.
Guard on regression vs a baseline captured under the same renderer.

## Files touched (project-tracked)

- `core/upstream/dolphin_web_core.cpp` — `SetVideoBackend`
  "WebGPU-Real" → "WebGPU" (Day 17.1, carried).
- `src/core-host.js` — `?video=wgpu` → "WebGPU-Real" (Day 17.1).
- `src/upstream-discio-worker.js` — `handleWebGpuShowImage` now reads
  the shared heap directly (Day 19); device forwarded for both
  webgpu/wgpu.
- `cores/dolphin/dolphin-core-upstream.{js,wasm}` — rebuilt.
- `patches/dolphin-wasm/SESSION-2026-05-15-DAY-18-19-NOTES.md` — this.

Vendor (gitignored, captured by the wasm rebuild):

- `VideoBackends/WebGPU/{VideoBackend,WebGPUGfx}.{cpp,h}` — rewritten
  to delegate to Software's rasteriser; ShowImage zero-copy post.
- `VideoBackends/WebGPU/CMakeLists.txt` — links `videosoftware`,
  drops Day-14 stub files.
