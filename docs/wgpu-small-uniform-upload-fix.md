# Small uniform uploads: utility constants leaking into GX draws (fixed)

The white file-select background was caused by the WebGPU backend binding
ImGui utility data as GameCube pixel-shader constants. It was not a failed
beach draw: ordered GPU readbacks showed the complete beach immediately before
a full-screen composite overwrote it with white.

`OnScreenUI::DrawImGui` uploads a 16-byte viewport uniform before iterating
its draw lists. Empty lists therefore upload data without issuing a draw.
The backend treated any utility upload as a one-use flag for the next draw.
That flag survived the empty UI frame and redirected the next GX draw's
binding 0 away from its 1,536-byte pixel constants.

The failing capture identifies the exact owner: the selected offset contained
the fresh utility values `[2/640, 2/480, 0, 0]`. The larger shader binding also
exposed bytes left over beyond that short upload. In one capture, TEV register 1
read four `1065353216` integers—the bit pattern of float `1.0`. The composite
shader's color and alpha clamps consequently produced opaque white. Copies
and presentation faithfully displayed that result, so no GPU validation error
was generated. Different old contents explain the misleading intermittent
successful screenshots.

## Changes

- Pipeline objects now retain their `AbstractPipelineConfig`. `SetPipeline`
  selects the uniform domain from its declared usage: GX and GX Uber use pixel
  constants; utility pipelines use utility constants.
- Removed the upload-driven one-use flag. Zero utility draws cannot redirect
  later game draws, and several utility draws can reuse one uniform upload.
- A utility upload can initialize the uniform buffer before the first GX draw.
- Separately fixed retained VS/PS/GS slice expiration when optional content
  caching is disabled. A compiled ring-wrap regression reproduces that defect;
  fixing it alone did not resolve the platformer's incorrect source selection.

Native changes are captured in patches 0064 and 0065. The built core, ABI pin,
source lock and vendor snapshot are updated together. The new core SHA-256 is
`1b99a62abb8c74b9f3cd215b1feca69bac1901b5045ac69e8837238d85d35a13`.

## Direct verification

The corrected first draw selects a fresh 1,536-byte ordinary Uniform upload,
with TEV register 1 `[0,0,0,0]`. All captured PS, VS, index and vertex bytes
match between CPU upload shadows and the GPU. The EFB RGB images before and
after the composite are byte-identical.

A 90-second replay of the same saved scene, with no gameplay input, no GPU
trace and optional UBO caching disabled, retains the complete beach at t40,
t71 and the final frame. The former core loses it within the same scene.
Both native regressions exercise actual production code: empty UI uploads,
repeated utility draws, pipeline transitions, initialization and epoch changes;
and retained uniforms across 84 ring wraps under 24 cache/fast/dense scenarios.

Two independent 75-second cold boots also reach the complete file-select
background. A 60-second saved-scene check on the Wii racing game and a 50-second boot of
another platformer retain their rendered scenes. All five acceptance runs use the
expected hardware core and report zero renderer errors. `npm run check`,
all 880 tests, and `npm run verify:provenance` pass.

Validation covers the reported file-select/dialog failure and these
regression scenes; it is not a full playthrough.

Local evidence is under `.omx/uniform-fix/`: `firstdraw-source-kind/`,
`fixed-firstdraw-source-kind/findings.json`, `fixed-long-replay/findings.json`,
`cold-boot-1/`, `cold-boot-2/`, `verification-summary.json`, and
`all-tests-final.log`. The saved state and game-derived captures remain
local and are excluded from the source patches.

## Re-validated after the rebase onto main (2026-09-11)

The work above was written against a prototype branch and sat uncommitted
until it was salvaged and rebased. The core it names no longer exists, so the
claim was re-tested from scratch rather than carried over.

Same ROM, same input script, same machine, 150 s, hardware WebGPU:

| core | file-select background | distinct sampled frames | validation errors |
| --- | --- | ---: | ---: |
| `650308c2` (main) | **white** | 71 / 151 | 0 |
| `286e7287` (this branch) | beach, the player character, A/B/C boxes, OPTIONS sign | **149 / 151** | 0 |

Reaching the failure needs menu input. With `INPUT_SCRIPT=none` both cores
render the attract-mode background correctly and the bug does not appear --
an earlier check that stopped there would have cleared a core that is in fact
broken, which is worth knowing before trusting any future result on that game.

Regressions: the Wii racing game from the deterministic race state renders its full
3D scene, and a fighting game reaches character select with every portrait drawn; both
report zero validation errors. Throughput on the Wii racing game is unchanged --
eight pairs, median +0.35%, five of eight positive, sign p = 0.73 -- so the
per-texture samplers cost nothing measurable.

This also corrects `a41b1de`, which retracted a claim about this background
and recorded it as unexplained.

## Throughput, measured across two rigs and three titles

Paired core swaps, A = main `650308c2`, B = this branch `286e7287`, backend
guarded, warm-ups discarded.

| workload | rig | pairs | A median | B median | median delta | positive | sign p |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| The Wii racing game | Radeon RX 9070 XT | 8 | 2452.3 | 2467.2 | +0.35% | 5/8 | 0.73 |
| The Wii racing game | RTX 3090 | 8 | 1521.1 | 1473.4 | +0.20% | 4/8 | 1.00 |
| Platformer (attract) | Radeon RX 9070 XT | 6 | 2102.9 | 2096.2 | -0.40% | 2/6 | 0.69 |
| Fighting game (battle stage) | Radeon RX 9070 XT | 6 | 1753.4 | 1926.4 | -0.03% | 3/6 | 1.00 |
| Platformer (file select, save state) | Radeon RX 9070 XT | 6 | 3602.1 | 3546.6 | **-1.08%** | 1/6 | 0.22 |

No regression on the Wii racing game on either rig. The platformer reads slightly
negative and is not resolved; its first two pairs ran while both arms were
still drifting upward, and the four pairs after that settled are -0.3, -2.0,
-0.5 and -0.6 -- all negative, which at four pairs is p = 0.125 and cannot be
called. If there is a cost there it is under one percent.

Worth noting for that number: the no-input boot run used here renders the
attract-mode background correctly on both cores, so it is not measuring the
extra work of drawing a background that used to be white.

Backward compatibility was checked separately, because the consumer and the
core version independently: the new worker against the old core `650308c2`
renders the Wii racing game correctly with zero validation errors. An untagged
sampler word still decodes to the old shared linear/repeat state.

### The one place it costs something

The deterministic file-select fixture is the only workload where the sign is
consistent: five of six pairs negative, median -1.08%. It is not resolved at
six pairs, but it is the workload where the fix does the most extra work, and
the reason is the point of the change: on the old core that screen renders a
white rectangle, and on this one it renders the beach, the player character, the file boxes
and the signpost. About one percent is what drawing the scene costs.

A single run of that fixture first read main at 3014 frames/60s against 3609
for this branch, which looks like a 20% win. It is not one. In the paired run
main's arm sits at 3602 -- the 3014 was a cold first run after a core swap,
before the JIT cache warmed. Only the within-pair deltas mean anything here,
and they say this branch is about a percent slower on that screen and level
everywhere else.
