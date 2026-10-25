# Internal resolution and anisotropic filtering (WebGPU path)

Patch 0168. The hardware renderer (`video=wgpu`) can render at 1 to 4
times the native resolution and filter textures anisotropically. The
software renderer has a single resolution: both settings are ignored there.

## Using it

| Where | Internal resolution | Anisotropy |
| --- | --- | --- |
| URL, at boot | `?ir=1` to `?ir=4` (default 1) | `?aniso=1\|2\|4\|8\|16` (default: what the game asks for) |
| Page, while a game runs | `host.setEnhancements({ internalResolution, maxAnisotropy })` | `maxAnisotropy`: log2 (0 = 1x … 4 = 16x), -1 = the game's |
| Core | `DolphinWeb_SetEnhancements(scale, log2)`, returns the scale in effect | same call |

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
  backbuffer pass; the worker resizes and reconfigures the canvas there
  (`resizeWgpuBackbuffer`). The canvas follows the core in order, never a
  frame early or late.
- Anisotropy: `GFX_ENHANCE_MAX_ANISOTROPY`. The sampler word already
  carried it (`PackSamplerState`, `src/wgpu-sampler-state.js`).
- `[Video_Hacks] VertexRounding` is kept from the discs' GameSettings
  (`tools/gamesettings-allowlist.json`): Dolphin's fix for seams at scales
  above 1; it does nothing at 1x.

Streaming keeps its own encoding size: the site sets
`scaleResolutionDownBy` on the video sender (the canvas is N times larger).

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
