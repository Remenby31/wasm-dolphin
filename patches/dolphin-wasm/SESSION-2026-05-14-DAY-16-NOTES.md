# Session 2026-05-14 (Day 16) — Real game content via WebGPU (hybrid)

Day 15 proved a `wgpuRenderPass` clear was reaching the canvas via
`?video=webgpu`. Day 16's goal: replace the Day-15 cycling-colour clear
loop with **real Dolphin frames**, so the user sees the GameCube intro
and the game's menus rendering through the WebGPU canvas.

## What changed

Two-line C++ change in `core/upstream/dolphin_web_core.cpp::SetVideoBackend`:
when JS sends the backend name "WebGPU", store `"Software Renderer"`
internally. From here on, every reference to `s_video_backend` (which
`ActivateBackend` later consumes) routes through Dolphin's existing
Software path. So the FIFO is rasterised on the CPU as normal, EFB→XFB
runs as normal, `s_framebuffer` is populated as normal.

JS side: the existing `createWebGpuPresenter()` was already configuring
a canvas WebGPU context with a WGSL fullscreen-blit pipeline. With
`?video=webgpu`, that presenter remains the canvas owner and the Day-15
clear loop is removed (it raced the presenter for the canvas every
frame, so leaving it in would overwrite real Dolphin frames with solid
colour). The C++ Software path writes XFB bytes into `s_framebuffer`;
the worker reads them via `_FrameBuffer()` per presentation tick and
calls `drawFrameBytesToWebGpu()` which uploads to a `WGPUTexture` and
issues a `wgpuRenderPassEncoder` blit through the existing WGSL
pipeline. Net result: every visible pixel reaches the canvas through a
real WebGPU render pass.

## Verified end-to-end

20-second probe with `VIDEO=webgpu PRESENTER=webgpu`:

- 11 distinct canvas hashes across 16 samples (vs 3 with the Day-15
  clear loop — real frames are progressing, not just cycling colour).
- Sample screenshots show the 1P-mode menu drawn correctly:
  "Regular Match / Event Match / Stadium / Training", anti-aliased text,
  full background art.
- HUD: `present webgpu/smooth`, `100% speed`, `60 core`, no
  visible errors.

## Why this is "hybrid" and not "the real WebGPU backend"

Important asterisk: the actual `WebGPU::VideoBackend` C++ class is
still a Day-14 stub. `WebGPUGfx`, `WebGPUTexture`,
`WebGPUVertexManager`, and `TextureCache` all return placeholder
no-op objects. They are *not* on the active code path. Day 16's win is
that the user sees real frames; getting there used the cheapest
plumbing.

The Day-17+ path:

- **Day 17:** Implement `WebGPUGfx::CreateTexture` against a real
  `WGPUTexture`. The first piece that actually flows through
  `WebGPU::VideoBackend`.
- **Day 18:** Override `WebGPUGfx::ShowImage(texture, rect)` to upload
  the source texture's CPU pixel buffer to a `WGPUTexture` and run a
  C++ blit pass on the canvas. At that point we can flip
  `SetVideoBackend("WebGPU")` to actually activate the WebGPU video
  backend instead of bridging to Software.
- **Day 19-25:** Real EFB/XFB rendering on the GPU — pipelines,
  WGSL shaders, bind groups, vertex buffers.

Until Day 18, "WebGPU" is the **canvas** path, not the **rendering**
path. The renderer is still Software. That's an honest, working
intermediate state — anything more ambitious in a single Day-16 turn
would have left the canvas black again.

## Files touched this session (project-tracked)

- `core/upstream/dolphin_web_core.cpp` — `SetVideoBackend("WebGPU")`
  now stores `"Software Renderer"` internally with a comment explaining
  the Day-16 bridge.
- `src/upstream-discio-worker.js` — Day-15 clear loop call removed;
  status pill updated to describe the hybrid.
- `cores/dolphin/dolphin-core-upstream.{js,wasm}` — rebuilt.
- `patches/dolphin-wasm/SESSION-2026-05-14-DAY-16-NOTES.md` — this file.

No vendor (`vendor/dolphin/`) changes this day — Day 14/15 already
landed the scaffold there.
