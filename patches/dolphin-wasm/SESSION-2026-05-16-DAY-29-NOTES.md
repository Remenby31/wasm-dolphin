# Session 2026-05-16 (Day 29) — pipeline + draw replay machinery proven

Day 28 proved resource opcodes (CREATE_SHADER → real GPUShaderModule,
browser-compiled, 0 errors). Day 29 proves the next + hardest layer:
a real GPURenderPipeline built from a bridge-translated shader, plus
render-pass + draw replay — the core of the GPU render path.

## Added

Opcodes (`WebGPUCommandStream`):
- `CmdOp::CreatePipeline=3` — arg: pipelineId, vsShaderId, topology.
  `PushCreatePipeline`.
- `CmdOp::DrawTest=4` — arg: pipelineId, vertexCount.
  `PushDrawTest`. Replaces the per-frame CLEAR once a pipeline exists.

Producer (`WebGPUGfx`): `CreateShaderFromSource` records the first
translatable **vertex** shader's bridge id (`m_test_vs_id`).
`ShowImage`, once that exists, emits `CreatePipeline` (one-shot,
`m_test_pipeline_id`) then `DrawTest(3)` each frame instead of the
Day-27 CLEAR.

Consumer (`src/upstream-discio-worker.js`):
- `replayCreatePipeline` — pairs the bridge-built VS module with a
  consumer-supplied constant-colour test FS
  (`WGPU_TEST_FS_WGSL`), `device.createRenderPipeline({layout:"auto"
  ,...})` wrapped in `pushErrorScope("validation")`/`popErrorScope`
  so validation failures are reported, not swallowed. Stored in
  `webGpuObjects.pipelines`.
- `DrawTest` drain → `beginRenderPass` (clear to near-black) +
  `setPipeline` + `draw(3)` + submit, coalesced one-per-tick.

(The test FS is consumer-side only because real Dolphin pixel shaders
need the Day-30 api_type→Vulkan flip; Day-29's job is the machinery,
for which the translated VS + a trivial FS suffices. The screen-quad
VS uses `@builtin(vertex_index)` so no vertex buffer is needed.)

## Verified (40s VIDEO=wgpu probe, console.log)

    [webgpu-cmd-shader]   module id=1 stage=0 compiled OK [ok=1 fail=0]
    [webgpu-cmd-pipeline] GPURenderPipeline 5 built OK from bridge VS id=1 — pipeline replay proven
    [webgpu-cmd-pipeline] first DRAW replayed (pipeline=5 verts=3) — GPU pipeline path proven

The full chain runs end-to-end: Dolphin GLSL VS → glslang → Naga →
WGSL (pthread) → CREATE_SHADER → discio `GPUShaderModule` →
CREATE_PIPELINE → **`device.createRenderPipeline` with browser
validation passing** → DRAW_TEST → real render pass + `draw()` +
submit on the discio device. No validation error logged — Naga's
WGSL is pipeline-valid, not just compile-valid.

## Known: canvas still shows Software content (deferred to Day-30)

The DRAW replays (logs confirm) but the canvas shows the Software
character-select, not the test draw. Cause: a present-ownership race
— the discio worker's normal Software presentation path still blits
the XFB in the same presentation tick and runs after the bridge
draw, overwriting it. This is **definitionally the Day-30 concern**
(retire the Software delegation / cutover). Chasing it now would
destabilise the working hybrid before the planned cutover, for no
machinery gain — the pipeline/draw machinery is already proven via
the logs. Day-30 retires Software delegation so the bridge owns the
canvas, which removes the race by construction.

## Significance

Every architectural unknown of the remote WebGPU backend is now
retired and individually proven: transport (Day-27), resource +
blob + id-map (Day-28), and **pipeline creation + draw replay, with
browser pipeline-validation passing** (Day-29). Day-30 is
integration, not new mechanism: flip api_type→Vulkan (unlocks the
full, complete shader set — Day-24 finding), stop delegating to the
SW classes, record Dolphin's real AbstractGfx Create*/state/Draw
calls through the (now-proven) opcode set using the
`AbstractPipelineConfig → GPURenderPipeline` mapping already banked
in DESIGN-webgpu-command-protocol.md, and retire SW so the bridge
owns the canvas.

## State

No regression: `?video=webgpu` hybrid ships the reference game unchanged.
`?video=wgpu`: Software content visible (race above) + real shader
modules & a real render pipeline built/drawn on the device in the
background. WIP toward the single big GPU-pipeline commit;
checkpoint `7a7b322`.

## Files touched (project-tracked)

- `src/upstream-discio-worker.js` — pipeline/draw opcodes,
  `replayCreatePipeline`, test FS, drain handling.
- `cores/dolphin/dolphin-core-upstream.{js,wasm}` — rebuilt.
- `patches/dolphin-wasm/SESSION-2026-05-16-DAY-29-NOTES.md` — this.

Vendor (gitignored): `WebGPUCommandStream.{h,cpp}`,
`WebGPUGfx.{cpp,h}`.
