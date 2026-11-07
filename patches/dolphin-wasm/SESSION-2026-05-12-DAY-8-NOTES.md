# Session 2026-05-12 (Day 8) — presentFps gap + fastsw shadow propagation

Two visible wins this session, plus a validator default cleanup.

## 1. presentFps gap — queue + pacing defaults

**Symptom:** under the recommended URL the HUD reported `presentFps ~17`
even though `coreFps = 60` and `gameSpeed = 100%`. The game ran at full
speed but the metric looked broken.

**Root cause:** the reported `presentationFps` is
`Math.min(rawFps, Math.round(1000 / p95_interval))` — a conservative cap
that clamps to the worst 5 % of paint intervals. With the validator's
historical defaults (`pacing=direct`, `queue=2`), a single JIT compile
or worker-contention spike landing in the 500 ms profile window would
shove the p95 interval to 60 ms+, capping the metric to ~16 fps even
though `rawFps` was 59. With `queue=2` the paced presentation loop
couldn't absorb the spike — `underrun` and `drop` events triggered, and
the long-frame count grew.

**Fix:**

- `src/upstream-discio-worker.js`: `DEFAULT_PRESENTATION_QUEUE` 2 → 4.
  `presentationQueueTarget` stays at 1, so steady-state queue depth
  stays at 1-2; the extra slots only kick in on transient spikes.
- `src/core-host.js`: `requestedPresentationQueueSize` fallback 2 → 4
  to match.
- `tools/menu-progress-validate.mjs`: validator defaults now match the
  user-facing recommended URL (`pacing=smooth`, `queue=4`) instead of
  the historical `pacing=direct, queue=2`. Probe metrics now reflect
  what users actually see.

**Measured:**

| Config | presentFps | rawFps | p95 gap | gameSpeed |
|--------|-----------:|-------:|--------:|----------:|
| Before (direct, queue=2) | 19 | 59 | 62.6 ms | 98.7 % |
| smooth, queue=2 | 26 | 46 | 35.1 ms | 100.2 % |
| smooth, queue=4 (new default) | **55** | 59 | 17.9 ms | 99.8 % |

## 2. fastsw shadow propagation — Rasterizer.cpp

**Symptom:** with `fastsw=1` (the recommended optimization level), the
dome of one battle stage and the shadow walls of another rendered as dotted
black holes — only every other pixel had the correct shaded color, the
rest stayed at the clear color.

**Root cause:** `fastsw=1` in
`vendor/dolphin/Source/Core/VideoBackends/Software/Rasterizer.cpp::Draw`
returns early for any pixel where `(x|y) & 1 != 0` — literally a
"render 1 in 4 pixels" hack. The other 3 pixels in each 2x2 quad were
left at whatever the previous clear/draw had written, which for TEV-
shaded surfaces against a black-cleared EFB meant pure black.

**Fix:** after `tev.Draw()` lands the rendered fragment at the (even,
even) cell, replicate its post-blend EFB color to the 3 skipped
neighbors in the same 2x2 raster block. Level 2 (step=4) gets the same
treatment over a 4x4 region, with bounds-clamping at EFB_WIDTH/HEIGHT.
Depth is intentionally not propagated — fastsw guarantees the skipped
cells won't be re-rasterized this frame, so their stale depth has no
effect on correctness.

Gated on `bpmem.blendmode.color_update` so we don't waste work
propagating stale color when BlendTev wasn't going to write anyway.

**Measured (the two stages after fix):**

| Config | Visuals | presentFps | gap | gameSpeed |
|--------|---------|-----------:|-----|----------:|
| `fastsw=1` before fix | Black dots in shadows | 30 | 34/51 ms | 100 % |
| `fastsw=0` (no fix needed) | Clean | 20 | 50/51 ms | 100 % |
| `fastsw=1` + propagation | **Clean** | **54** | **17.7 ms** | 100 % |
| `fastsw=2` + propagation | Chunky 4x4 blocks, no holes | 55 | 18.1 ms | 94.5 % |

Note that `fastsw=1` + propagation is *faster* than the no-fix version,
likely because sequential EFB writes to neighbor cells are cache-
friendlier than leaving them at stale memory and dirtying it on the
next clear.

## Edge cases / known limitations

- Partial-coverage triangles where the rasterized (even, even) cell is
  outside the triangle but a skipped odd cell is inside: not handled.
  Visual impact is thin triangle edges may show small gaps. Acceptable
  for a fast-path optimization.
- Level 2 (step=4) propagation may bleed slightly past the scissor
  rectangle in partial-coverage cases (we clamp to EFB bounds, not the
  per-triangle scissor). Mild edge artifacts; level 2 is already an
  aggressive low-quality mode.

## Files touched (project)

- `src/upstream-discio-worker.js` — queue default 2 → 4
- `src/core-host.js` — queue default 2 → 4
- `tools/menu-progress-validate.mjs` — pacing/queue probe defaults
- `docs/ogl-performance-plan.md` — Day 8 note + URL update

## Files touched (vendor, gitignored)

- `vendor/dolphin/Source/Core/VideoBackends/Software/Rasterizer.cpp`
  — fastsw post-pass propagation in `Draw()`
