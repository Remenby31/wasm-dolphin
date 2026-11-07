# Session 2026-05-16 (Day 28) — resource opcodes: CREATE_SHADER proven

Day 27 proved the transport (OP_CLEAR). Day 28 proves the
resource-opcode pattern — variable-length blob payload + producer-id →
consumer-object map — with CREATE_SHADER end-to-end, and in doing so
validates that the Day-22/23 shader-translation chain emits
browser-valid WGSL.

## Parallel agents (this session, read-only, no merge risk)

- **API reference agent** (done): precise emdawnwebgpu/JS WebGPU
  descriptor shapes + a field/enum `AbstractPipelineConfig →
  GPURenderPipeline` mapping with Dolphin file:line cites. Folded into
  `DESIGN-webgpu-command-protocol.md`.
- **Transport-audit agent** (done): audited the Day-27 ring. Verdict
  "correct and ready as a foundation", no blocking issues. Two
  guardrails applied: `static_assert(sizeof(CmdRingHeader)==16)`; a
  comment documenting the deliberate wasm-SAB-fence reliance for the
  non-atomic slot reads.

## Protocol additions

`DESIGN-webgpu-command-protocol.md` written first (opcode tables, id
scheme, blob/upload-ring payload design) — the contract both halves
build to.

- `CmdOp::CreateShader = 2`. arg: u0=id, u1=blobPtr, u2=blobLen,
  u3=stage.
- `WebGPUCommandStream::PushCreateShader(wgsl,len,stage)` — mallocs a
  persistent shared-heap blob, copies the WGSL, assigns a monotonic
  id (`m_next_id`, 0=sentinel), pushes the record; frees the blob +
  returns 0 if the ring is full.
- `WebGPUShader` now holds `m_bridge_id` (the consumer-side module
  key) + the WGSL text, not a pthread-side `WGPUShaderModule` (the
  pthread has no device — Day-26).
- `WebGPUGfx::CreateShaderFromSource`: `GlslToWgsl` (C++, on the
  pthread) → `PushCreateShader`. No device touched on the pthread.

Consumer (`src/upstream-discio-worker.js`):

- `webGpuObjects = { shaders:Map, shaderOk, shaderFail }` — the
  id→object table (buffers/textures/pipelines join it Day-29).
- `replayCreateShader(id,ptr,len,stage)` — decode WGSL from the
  shared heap, `device.createShaderModule`, store by id, async
  `getCompilationInfo()` → count + log.

## Two bugs found & fixed during bring-up

1. **postStatus is transient** — the validator only keeps the final
   status pill, so discio-side `postStatus` verification was
   invisible. Switched to `console.log` (captured in the console
   stream, like the C++ `EM_ASM` logs).
2. **TextDecoder rejects SharedArrayBuffer views** ("cannot decode
   from a shared ArrayBuffer") in this engine — the decode `catch`
   was silent, so it looked like the opcode never arrived. Fix: copy
   the blob into a plain non-shared `Uint8Array` before `decode()`
   (small, one-time per shader), and log the decode catch.

## Verified end-to-end

40s `VIDEO=wgpu` probe console.log:

    [webgpu-cmd-shader] GPUShaderModule created id=1 stage=0 wgslLen=1520 hasCompileInfo=1
    [webgpu-cmd-shader] GPUShaderModule created id=2 ... wgslLen=1957
    [webgpu-cmd-shader] GPUShaderModule created id=4 ... wgslLen=10569
    [webgpu-cmd-shader] module id=1 stage=0 compiled OK [ok=1 fail=0]
    ... id=2,3,4 compiled OK [ok=4 fail=0]

C++ side: `[webgpu-shader] ok=6 fail=58`. The 6 that translate become
real `GPUShaderModule`s on the discio device and **compile in the
browser's WebGPU with zero errors**. This validates the whole
Day-22/23 chain (glslang→SPIR-V→Naga→WGSL) produces browser-valid
WGSL — a major de-risk.

The `fail=58` are the `APIType::Nothing` stub shaders (Day-24
finding): shadergen emits declaration-less stubs while the Software
hybrid forces api_type=Nothing. They translate-fail, expected; the
Day-30 api_type→Vulkan flip unlocks the full shader set. Day-28's
job was proving the *mechanism*, which whatever-translates suffices
for.

## Significance

The resource-opcode pattern is proven: blob payloads, id→object map,
real GPU object creation across the pthread→discio bridge, and
confirmation that Naga's WGSL is accepted by real browser WebGPU.
Day-29 (CREATE_BUFFER / CREATE_TEXTURE / CREATE_PIPELINE / state +
DRAW) is the same pattern widened — no new architecture.

## State

No regression: `?video=webgpu` hybrid untouched (ships the reference game).
`?video=wgpu` shows the Day-27 cycling clear + now also builds real
shader modules in the background. WIP toward the single big
GPU-pipeline commit; checkpoint at `7a7b322`.

## Files touched (project-tracked)

- `src/upstream-discio-worker.js` — webGpuObjects table,
  `replayCreateShader`, CREATE_SHADER drain case, audit comment.
- `cores/dolphin/dolphin-core-upstream.{js,wasm}` — rebuilt.
- `patches/dolphin-wasm/DESIGN-webgpu-command-protocol.md` — new.
- `patches/dolphin-wasm/SESSION-2026-05-16-DAY-28-NOTES.md` — this.

Vendor (gitignored): `WebGPUCommandStream.{h,cpp}` (CreateShader +
audit static_assert), `WebGPUGfx.{cpp,h}`.
