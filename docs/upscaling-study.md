# Upscaling study: internal resolution against a presentation upscaler

Status: study and prototype (branch `study/upscaling`, patch 0082), not a
production change. Phase 2 of the programme asks for internal resolution 1×
to 4× on the WebGPU path and an output upscaler on both paths. This note
answers the question that comes before: what each one costs on this build,
and which one to ship first.

<!-- RESULTS -->

## 1. How Dolphin does internal resolution

One setting, `GFX_EFB_SCALE` (`[Settings] InternalResolution`, default 1;
0 = "auto", an integer multiple of the window), read into
`VideoConfig::iEFBScale` (`VideoCommon/VideoConfig.cpp:128`). Everything else
follows from the size of the EFB:

| Piece | Where | At scale N |
| --- | --- | --- |
| EFB colour and depth | `FramebufferManager::CreateEFBFramebuffer` (`FramebufferManager.cpp:210-222`) | 640N × 528N, capped by the backend's max texture size |
| Viewport, scissor | `VertexShaderManager.cpp:350`, `BPFunctions.cpp:206` (`EFBToScaledX/Y`) | the GX rectangles are multiplied by N, the geometry is unchanged |
| XFB copies (the frame) | `TextureCacheBase::CopyRenderTargetToTexture` (`TextureCacheBase.cpp:2193-2221`) | always at N (`is_xfb_copy`) |
| EFB copies to textures (render to texture: shadows, reflections, blur, minimap) | same function | at N only with `GFX_HACK_COPY_EFB_SCALED` (upstream default **true**); otherwise downsampled to native with a 2×2 box filter (`linear_filter`, exact only at 2×) |
| EFB peeks/pokes, bounding box | `FramebufferManager::CreateReadbackFramebuffer` (`:700-730`), `:806` | read from a native-size cache, filled by an extra downsampling copy when N ≠ 1 |
| Presentation | `Presenter::SetBackbuffer(g_gfx->GetSurfaceInfo())` (`Present.cpp:126`) | the XFB (N×) is blitted to the backbuffer's draw rectangle |

The CPU side of the emulator does not change with N: the same GX commands,
the same vertices, the same number of draws. The extra work is GPU fill rate
(N² pixels in every EFB pass and every XFB copy) and GPU memory (N² for every
render target). Two exceptions cost CPU in Dolphin: EFB copies to RAM (an
encode pass then a GPU→CPU readback, whose source is N² larger) and EFB
peeks (one downsampling copy per invalidated tile).

## 2. What blocks it in the web build

Four things, none in the GX emulation itself:

1. **Nothing sets `GFX_EFB_SCALE`.** `core/upstream/dolphin_web_core.cpp`
   configures Dolphin explicitly (backend, CPU, hacks) and never touches it, so
   it stays at its default, 1.
2. **The backbuffer is a constant 640×480 in the C++ backend.**
   `WebGPUGfx::GetSurfaceInfo` returns `{640, 480}`. The presenter would blit a
   2× XFB into that: supersampling, averaged away at presentation. Nothing
   visible would change, the cost would be paid.
3. **The canvas is a constant 640×480 in the worker.** `WGPU_BACKBUFFER_W/H`
   in `src/upstream-discio-worker.js` size the canvas once, the first time the
   backbuffer pass runs (the one-shot "bbresize").
4. **The browser defaults that make 1× cheap stay in place.**
   `GFX_HACK_COPY_EFB_SCALED` is forced to false (render-to-texture effects
   stay native), and EFB copies to RAM do nothing on WebGPU
   (`TextureCache::CopyEFB` is a stub, so is the staging texture). So the two
   CPU-side costs of section 1 do not exist on this backend, at any N.

The WebGPU backend itself has no hidden 640×528 assumption: textures,
viewports and scissors come from VideoCommon in scaled coordinates, and the
worker's replay sizes everything from the command stream. Diagnostics in the
worker key on "≤ 1024 wide" to recognise copy targets; they are logs only.

The software renderer has no internal resolution in Dolphin (it rasterises
the native EFB on the CPU). On that path only a presentation upscaler applies.

## 3. The prototype

Behind URL flags; the defaults change nothing.

| Flag | Effect | Where |
| --- | --- | --- |
| `ir=2`, `ir=3` (1 to 4) | `GFX_EFB_SCALE = N` on the WebGPU backend, backbuffer and canvas 640N × 480N | core: `dolphin_web_core.cpp`; patch 0082: `GetSurfaceInfo`; worker: canvas size |
| `upscale=easu` / `upscale=bilinear`, `upscalex=2\|3`, `sharp=0.2` | Dolphin's backbuffer pass draws into an offscreen texture; at present, FSR 1 (EASU then RCAS) or a bilinear pass writes the canvas, `upscalex` times larger. Software path: the same filter from the uploaded XFB | `src/wgpu-upscale-study.js`, worker |
| `gputime=1` | timestamp queries around every render pass of a present, summed per present (`upscaleStudyStats` worker request) | same |

EFB copies to textures stay native at every N (`COPY_EFB_SCALED` false, as
today): only the frame gets sharper. It is the conservative choice:
render-to-texture effects keep their native look and their native cost.
