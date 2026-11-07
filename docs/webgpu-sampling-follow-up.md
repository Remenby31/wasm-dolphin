# WebGPU sampling and cache follow-up — 2026-09-07

The follow-up to `0955d66` fixes three remaining correctness gaps without
changing the GameCube/Wii texture data:

- Clear pipelines remain bounded to 64 entries, but a full cache now evicts
  its oldest entry instead of dropping the next clear. Cache hits retain the
  cheap lookup path, and failed creation does not evict a working pipeline.
  A clear also restores the previous actual game pipeline and vertex-buffer
  requirement: the producer may omit a repeated `SET_PIPELINE`, so merely
  invalidating consumer draw state silently dropped subsequent game draws.
- Each texture slot now uses its own GX sampler state: point/linear filtering,
  clamp/repeat/mirror wrapping, fractional LOD limits and supported anisotropy.
  Native bind groups include all eight samplers and verify complete resource
  identities before reusing a cached group. LOD bias remains in the shader.
- Depth and R32 textures use actual texels through `unfilterable-float`
  bindings and point samplers. Group 0/2 layouts stay shared; group 1 and its
  pipeline layout vary with the texture types. A texture-group change updates
  the pipeline before drawing, even if the requested pipeline ID did not change.

The depth path reads the red component and preserves the 24 bits consumed by
Dolphin's depth-copy shaders. It does not convert depth to half-float color.
This follows the [WebGPU depth-format rules](https://gpuweb.github.io/gpuweb/#depth-formats).
Mixed color/depth operations keep independent linear-color and point-depth
samplers. Integer textures still require a separate typed shader path and
retain the existing placeholder fallback.

Chrome/Dawn exposed a second constraint during GPU testing: a shared helper
with texture and sampler parameters could be validated as pairing one call's
depth texture with another call's linear sampler. Native hardware-sampling
helpers now reference their own slot's global bindings directly. Manual
texture sampling and its integer coordinate/LOD calculations are unchanged.
The controlled failing helper and passing specialization are recorded locally.

Compatibility is explicit. Untagged sampler records retain the old shared
linear/repeat defaults; tagged records pack the new state into the same word.
Legacy shared-sampler shaders use point sampling when real depth is bound so
they remain valid. New cores retain per-slot color filtering. Existing guards
still prevent sampling a writable framebuffer attachment.

## Verification

- 878 tests pass, including compiled native packing/routing tests, consumer
  transitions, cache eviction, legacy records, mip views and clear masks.
- Syntax checks and exact source/core provenance checks pass.
- Real Chrome/AMD RDNA 4 tests pass 131 clear readbacks across eviction and
  revisit, 12 sampler pixel checks, and six depth jobs. The depth jobs include
  adjacent 24-bit values, R32 without `float32-filterable`, mixed filtering,
  legacy samplers and a second depth write in the same encoder.
- A separate GPU state test executes the actual clear and draw handlers:
  the old path skips the following game draw; the corrected path preserves
  all 70 game draws across 70 clears without additional pipeline commands.
  An absent prior pipeline remains invalid, and all pixels and caches agree.
- The same saved race in a Wii racing game was loaded on software and WebGPU,
  unpaused, and driven for 120-second runs. Both reach the grass/barrier scene
  with the kart and race HUD visible. WebGPU reports no renderer errors.
  These are scene-content comparisons: simulation speed differs, so they are
  not identical-frame pixel diffs or a claim of full-speed emulation.

Core: `63f102f5f7cb481ef92939ceb14099d4147c8e191d9784dadd79bc691d5b84cd`.
Native changes are in snapshot patches 0061 and 0062; consumer changes are in
`src/upstream-discio-worker.js` and `src/wgpu-sampler-state.js`.

Local evidence is under `.omx/render-next/`: `clear-cache-sampler-smoke.json`,
`depth-gpu-smoke.json`, `depth-shared-helper-before.json`, `focused-final.log`,
`all-tests.log`, and the software and hardware gameplay capture directories.
Game-derived captures remain local and are not included in source patches.

## Remaining visual discrepancy

**Resolved in the subsequent pass** by a uniform-source fix. The investigation
below records the state before that fix.

A 3D platformer's file-select background is not reliably correct. The current build
produced a white background, but the exact `0955d66` worker plus the previously
shipped `38808e3a…` core reproduced it at multiple checkpoints and at the end
of a 70-second control. The current software renderer showed the complete beach
scene. Thus the earlier successful screenshots do not establish a stable fix,
and this symptom has not been attributed to the new sampling changes.

Worker-only controls replacing real depth with the old placeholder or forcing
legacy samplers did not restore the scene. Restoring the old clear cache showed
3D at one checkpoint but white again later. The independent pipeline-state bug
was fixed and GPU-tested, but did not resolve the platformer's baseline discrepancy.

Evidence: the platformer control summary, software-control and
`0955d66` baseline directories under `.omx/render-next/`, and
`clear-state-smoke.json`. Baseline worker source and loaded WASM bytes were
verified. Existing GX depth-copy/depth-write convention workarounds were not
changed in this pass; the new tests establish physical-depth sampling precision,
not correctness of every depth-texture effect across the library.

## Performance profile

A 20.13-second capture across 18 page/worker targets verified the unpaused Wii
racing game, the final core/runtime hashes, advancing frames, JIT enabled, an
unchanged loaded checkpoint, and zero renderer errors before and after.
Frames advanced from 3077 to 3559. The JIT compiled 249 additional blocks.
An earlier 180-second warm-up never reached the required quiet period, so
this is an active-gameplay profile with compilation included, **not a
steady-state benchmark** or an optimization ceiling.

The disc-I/O/WebGPU worker had 10.054 seconds of non-idle sample weight:

| Work | Sample weight | Share of this worker's non-idle samples |
| --- | ---: | ---: |
| WebGPU replay stacks, including nested work | 6.325 s | 62.9% |
| Diagnostic functions, self-time | 2.181 s | 21.7% |
| Garbage collection, self-time | 2.460 s | 24.5% |

The replay row includes diagnostic work; these rows must not be added.
`vpDiagNoteUpload` alone used 1.081 seconds of self-time despite
`wgpudeepdiag=0`. Other diagnostic costs include per-draw and uniform-buffer
inspection. Diagnostic allocations may contribute to GC, but the capture
does not isolate their share. Disabling unnecessary diagnostic bookkeeping
is the next measured renderer-side performance target.

The guest-execution candidate had 19.029 seconds in the main core WASM and
1.021 seconds in smaller WASM modules. The main core also includes helpers,
subsystems and synchronization; it must not be labeled entirely as dispatch.
Several other pthread targets appear parked, so their sampled stack weights
are not evidence of busy CPUs. No GPU hardware execution timing was captured.

Detailed local evidence and reproducible ignored capture/analyzer scripts:
the profiling script under `.omx/render-next/`, `profile-summary.mjs`, and
`profile-validated/active-gameplay/` (including `run.json`, all CPU profiles,
before/after screenshots, `profile-summary.json`, and `profile-findings.md`).
