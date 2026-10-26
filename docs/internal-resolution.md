# Internal resolution and anisotropic filtering (WebGPU path)

Patch 0168. The hardware renderer (`video=wgpu`) can render at 1 to 4
times the native resolution and filter textures anisotropically. The
software renderer has a single resolution: both settings are ignored there.

## Using it

| Where | Internal resolution | Anisotropy |
| --- | --- | --- |
| URL, at boot | `?ir=1` to `?ir=4` (default 1) | `?aniso=1\|2\|4\|8\|16` (default: what the game asks for) |
| Page, while a game runs | `host.setEnhancements({ internalResolution, anisotropy })` | `anisotropy`: 1, 2, 4, 8 or 16, as `?aniso=`; anything else = the game's |
| Core | `DolphinWeb_SetEnhancements(scale, log2)`, returns the scale in effect (0 before the runtime is up) | log2: 0 = 1x … 4 = 16x, -1 = the game's |

Out-of-range values mean the default on both sides: a scale other than 1-4
is 1, an anisotropy other than the five levels is the game's.

`src/wgpu-enhancements.js` converts between the page's values and the
core's. A change while a game runs is applied by the video thread at its
next frame. A new scale makes Dolphin rebuild its shaders once (manual
texture sampling depends on scaled EFB copies), a short stutter.

## How it works

- `GFX_EFB_SCALE` is Dolphin's setting: the EFB, the viewport, the scissor
  and the XFB copies are scaled by N, the geometry is not
  (`VideoCommon`, unchanged).
- `GFX_HACK_COPY_EFB_SCALED` is now on, as in Dolphin: EFB copies to
  textures (blur, shadows, reflections, split screens) follow the scale.
  At 1x a scaled copy is the native copy: 1x is unchanged, byte for byte.
- EFB copies to RAM and EFB peeks keep their native size: Dolphin's encoder
  and readback cache read the scaled EFB (homebrew `ramcopy`, `efbpeek`).
- The backbuffer is 640N × 480N (`WebGPUGfx::GetSurfaceInfo`). On a new
  scale, `WebGPUGfx::OnConfigChanged` lays the presenter out again, and
  `BindBackbuffer` sends `BackbufferSize` (opcode 29) before the next
  backbuffer pass whose size differs from the last one sent (the canvas
  starts at 640x480, so nothing is sent at 1x); the worker resizes and reconfigures the canvas there
  (`resizeWgpuBackbuffer`). The canvas follows the core in order, never a
  frame early or late.
- Anisotropy: `GFX_ENHANCE_MAX_ANISOTROPY`. The sampler word already
  carried it (`PackSamplerState`, `src/wgpu-sampler-state.js`).
- `[Video_Hacks] VertexRounding` is kept from the discs' GameSettings
  (`tools/gamesettings-allowlist.json`): Dolphin's fix for seams at scales
  above 1; it does nothing at 1x.

Streaming keeps its own encoding size: the worker capture
(`src/stream-capture.js`) draws a canvas wider than 640 into a 640-wide one
before it makes the VideoFrame, so the encoder gets 640x480 at every scale
and across switches. The page's own `canvas.captureStream()` fallback
(`?capture=canvas`) still gets the full canvas; the site divides it back
with `scaleResolutionDownBy` there.

## Costs and limits

- GPU memory grows with N²: EFB colour and depth, every XFB copy and every
  scaled EFB copy. At 4x the EFB alone is 2560x2112 (about 43 MB for colour
  and depth), and a game with many render-to-texture copies holds several
  hundred MB more than at 1x. Savestates hold the EFB too, so they grow
  with N² inside the 1.5 GiB heap.
- **Ceiling per adapter.** `internalResolutionCeiling(adapter, { deviceMemory })`
  (`src/wgpu-enhancements.js`) gives the highest scale a machine is trusted
  with, by adapter class since WebGPU says nothing about GPU memory: 1 for
  no adapter or a CPU one; 2 for `navigator.deviceMemory` ≤ 4 GB (1 at
  ≤ 2), an adapter offering buffers under 1 GiB, a mobile GPU vendor
  (Chrome's names: qualcomm, arm, img-tec, huawei, verisilicon…), an
  integrated Intel GPU (Dawn's `gen-*` but `gen-12hp`, or any `lp`:
  `gen-12lp`, `xe-lpg`, `xe-2lpg`, `xe-3lpg`…; Arc `gen-12hp`/`xe-2hpg` or
  unnamed keeps 4) or an Apple GPU without `deviceMemory` (Safari and
  Firefox, a Mac included: an iPhone or iPad cannot be told from it there);
  the texture limit / 640; else 4
  (M4 Pro in Chrome: 4). The worker holds the boot scale and every
  `setEnhancements` to its adapter's ceiling, answers the scale in effect
  and posts its ceiling (`wgpu-scale-ceiling`);
  `host.internalResolutionCeiling()` gives `{ ceiling, reason }`: the
  worker's once known, before that the same rule on an adapter the page
  asks with the worker's power preference. `host.setEnhancements` clamps to
  it too.
- **Device loss.** A lost `GPUDevice` stops the game (no rendering without
  it). Lost above 1x, the worker posts `wgpu-device-lost` with the scale;
  the host's ceiling drops to 1 for the rest of the page (next boot and
  every `setEnhancements` at 1x) and `onGpuDeviceLost({ internalResolution,
  fallback: 1, reason, detail })` tells the page, which restarts the game at
  1x instead of at the same scale. Lost at 1x: `fallback` is null.
- **Measured costs** (2026-10-26/27, M4 Pro, Chrome headless, mains power,
  local commercial disc, race, 3 runs per scale, perf lock):

  | Scale | Stream capture ms/frame, mean (max) | Sizes sent | Savestate | Save | Load |
  | --- | --- | --- | --- | --- | --- |
  | 1x | 0.027 (0.23) | 640x480 only | 28 MB | 0.8-1.0 s | 1.21 s |
  | 2x | 0.053 (0.46) | 640x480 only | 35 MB | 0.8-1.0 s | 1.22 s |
  | 4x | 0.054 (0.39) | 640x480 only | 56-61 MB | 0.8-1.0 s | 1.22 s |

  `harness/probes/stream-capture-cost.mjs` and `savestate-scale.mjs`; save
  times have the 200 ms granularity of `saveStateFile`'s polls. The capture
  costs nothing that matters at 4x; a savestate at 4x is about twice the 1x
  one. The heap is reserved at 1.5 GiB from the start, so its size says
  nothing about the headroom: that needs a malloc counter in the core.
- `streamCaptureStats` counts every size it sent over the capture
  (`minWidth`/`maxWidth`, `sizes`: frames per `source:WxH` with the last
  core frame, `inputMaxWidth`): a stray size, as the 320x240 seen once at
  4x (2026-10-26, not reproduced in 9 runs since), shows with its count.
- The semantic capture (`?wgpusemanticruntime`, diagnostics) does not know
  opcode 29: a scale change invalidates that capture, as any opcode above
  24 does. At 1x nothing changes for it.

## Checking it

`harness/probes/upscale-check.mjs` captures the same VI output
(`cpu=single`) at each scale, downsamples it and compares it with 1x
(mean difference, best offset within ±2 pixels), then switches the scale
while the game runs and checks the canvas and the frame follow.

```sh
node harness/probes/upscale-check.mjs --iso harness/homebrew/out/gxscene.iso --port N \
  --scales 1,2,4 --vi 120 --switch 2,4,1
node harness/probes/upscale-check.mjs --iso harness/homebrew/out/ramcopy.iso --port N \
  --scales 1,2,4 --vi 120 --query efbcopyram=1
```

Results (2026-10-25, M4 Pro, Chrome headless, local darwin core):

| Disc | 2x vs 1x | 4x vs 1x | Offset |
| --- | --- | --- | --- |
| gxscene | 1.14 / 255 | 1.04 / 255 | 0, 0 |
| ramcopy (`efbcopyram=1`, RAM readback) | 0.44 | 0.36 | 0, 0 |
| efbpeek (`efbaccess=1`) | 0.71 | 0.58 | 0, 0 |
| local commercial disc, race | 1.87 | 2.07 | 0, 0 |
| local commercial disc, 2-player split screen | 2.63 | 2.79 | 0, 0 |

The residue is edge antialiasing from the box filter. Switching 1 → 2 → 4
→ 1 while running: canvas and frame at the expected size each time. At 1x
the race frame is identical to main's core.
