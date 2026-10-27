# Picture: display filter, widescreen, anti-aliasing (WebGPU path)

Three generic picture settings of the hardware renderer (`video=wgpu`),
nothing specific to a game. The software renderer ignores all three.

| Setting | URL, at boot | While a game runs | Default |
| --- | --- | --- | --- |
| Sharpness (FSR1) | `?fsr=off\|light\|strong` | `host.setDisplayFilter({ sharpness })` | off |
| Filtered fit to the display | `?displayfit=1` | `host.setDisplayFilter({ fit })` | off (implied by any sharpness) |
| Widescreen 16:9 | `?widescreen=1` | `host.setEnhancements({ widescreen })` | off |
| Anti-aliasing (supersampling) | `?ir=N&displayfit=1` | `setEnhancements({ internalResolution })` + `fit` | off |

## Display filter (`src/wgpu-display-filter.js`, no core change)

With presentvsync (the default) every frame is a pooled texture at the
core's backbuffer size (640N x 480N), copied to the canvas at the worker's
rAF. With the filter on, the canvas is sized to the page's display pixels
(the canvas element's `devicePixelContentBoxSize`, observed by the host
and sent to the worker), and the copy becomes:

1. a scale to the display: FSR1 **EASU** (edge-adaptive upscale, 12 taps)
   when the display is larger than the backbuffer, an **area** filter
   (n x n bilinear samples per display pixel, an exact box at integer ratios)
   when it is smaller, nothing when equal;
2. FSR1 **RCAS** (contrast-adaptive sharpening): light = 1.0 stop,
   strong = 0.2 stop (AMD's default).

EASU and RCAS are a WGSL port of AMD's `ffx_fsr1.h` (MIT, notice in the
file). Without the filter the canvas is the backbuffer and the browser
scales it (bilinear), as before: the present is the same copy, byte for
byte.

The stream is captured from the pooled texture (presentvsync v3), so guests
never get the filter nor the display size. The harness's exact captures
read the core's frames, not the canvas: unchanged. `grabFrame` (canvas
capture) sees the filtered canvas.

Limits: needs presentvsync (`?presentvsync=0` presents into the canvas
directly: no filter). The canvas is at most 5120 per side.

Checks: `harness/probes/display-filter-check.mjs` (synthetic picture, no
disc: copy exact, EASU flat and bounded, area = 2x2 mean, RCAS flat and
not clipping; `--bench N` GPU time per plan under the perf lock) and
`harness/probes/display-filter-live.mjs` (a game: canvas size, frames
filtered, hot switches).

## Widescreen 16:9 (patch 0178)

Dolphin's generic widescreen hack (`GFX_WIDESCREEN_HACK`): the 3D
projection is widened to 16:9 (Hor+), and the presenter draws at 16:9
(`AspectMode::ForceWide`). `WebGPUGfx::GetSurfaceInfo` makes the
backbuffer 16:9 (480N lines, 854 / 1706 / 2560 / 3414 wide) and announces
it like any internal resolution (`BackbufferSize`); the canvas follows. A
game that already renders 16:9 (anamorphic) is detected by Dolphin and not
widened twice. Off is the stretch to a 4:3 backbuffer the path always had.

Known artefacts (generic hack): 2D elements drawn with the 3D projection
(HUD, menus, split-screen borders) are stretched; objects can pop in or be
cut at the left and right edges, where the game culls what a 4:3 screen
does not show. The stream follows the aspect (640x360 at 16:9).

## Anti-aliasing

The WebGPU backend has no MSAA (`AAModes = {1}`: multisampled EFB, resolves
for EFB copies and depth, multisampled shader inputs: not implemented).
Anti-aliasing is supersampling instead: the internal resolution above the
display, then the display filter's area downscale (`fit`), which averages
every rendered pixel (the browser's bilinear downscale skips pixels beyond
2:1 and shimmers). The internal resolution ceiling per adapter (#288) caps
it.
