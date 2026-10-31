# NEXT-SESSION PLAN — WebGPU hardware renderer: full executor + retire SW

Read this top to bottom before touching anything. Then read
`patches/dolphin-wasm/DESIGN-webgpu-command-protocol.md` (the wire
protocol + the `AbstractPipelineConfig → GPURenderPipeline` mapping)
and `SESSION-2026-05-16-DAY-30-NOTES.md` (root-causes + the gated-fix
method). Skim DAY-27/28/29 notes for the bridge mechanics.

## Where things stand (all committed, branch `webgpu-hardware-renderer`, HEAD `bf99320`)

The WebGPU hardware-renderer R&D is **done**. Every architectural
unknown is retired and proven on real Dolphin shaders:

- **Transport (D27):** single-producer/consumer command ring in the
  shared wasm heap. Video pthread records opcodes; the discio worker
  (owns `renderGpu.device`, event-loop driven) drains every
  presentation tick and replays on the real device. `WebGPUCommandStream.{h,cpp}`.
- **Resources (D28):** `CREATE_SHADER` + blob payload + id→object map →
  real `GPUShaderModule`, browser-compiled.
- **Pipeline/draw (D29, D32-slice1):** real Dolphin VS+FS pair →
  browser-valid `GPURenderPipeline` + real draw, via the bridge.
- **Shader translation (D30):** Dolphin GLSL → glslang → SPIR-V →
  Naga → WGSL, **64/64 (100%)**, **0 browser WGSL compile errors**
  (D31). Naga staticlib `tools/naga-spirv-wgsl/` (Rust).

`?video=webgpu` (Day-16 Software→WGSL-presenter hybrid) is UNTOUCHED
and still plays the reference game — that is the shipping fallback; never break it.
`?video=wgpu` is the under-construction real backend (currently shows
the bridge test pipeline/draw, not game content).

## The goal of the next session(s)

Make `?video=wgpu` render real GameCube content on the GPU. This is
"build the rest of the remote WebGPU backend against proven
primitives" — substantial implementation volume, **no research risk
left**. Three phases, in order, checkpoint-commit each:

### Phase A — full AbstractGfx opcode set (producer: WebGPUGfx)

Today `WebGPUGfx` delegates Create*/raster to Software's classes
(Day-18 hybrid) and `SupportsUtilityDrawing()==false`, so
VideoCommon takes the ShowImage fallback and never issues real
Draw/Pipeline calls. To get real GPU rendering you must move
`WebGPUGfx` off the SW delegation and record the real AbstractGfx
calls as opcodes. Widen `WebGPUCommandStream` opcodes (design doc has
the full table) and have `WebGPUGfx` emit them:

- `CREATE_BUFFER`(id,size,usageFlags) / `UPLOAD_BUFFER`(id,dstOff,
  srcOff-in-upload-ring,len). Add the per-frame **upload ring**
  (design doc §payload) — do NOT malloc per frame; bump-allocate a
  shared-heap arena, recycle after N frames (mirror the Day-20 XFB
  ring idea).
- `CREATE_TEXTURE`(id,w,h,wgpuFormat,usageFlags) / `UPLOAD_TEXTURE`.
- `CREATE_PIPELINE` with a **serialized `AbstractPipelineConfig`
  blob** (blend/depth/raster/vertex-layout). The exact
  Dolphin→WebGPU enum mapping is already worked out in the DESIGN
  doc — use it verbatim (PrimitiveType, CullMode, DepthState,
  BlendingState src/dst factors, vertex formats, FB formats).
- `CREATE_SAMPLER`, `CREATE_BIND_GROUP` (UBO + sampled texture +
  sampler — bindings mirror Dolphin's SHADER_HEADER:
  `UBO_BINDING`/`SAMPLER_BINDING`; note Day-30 split textures to
  separate `texture2DArray` + `sampler`, bindings 0-7 + 8).
- State+draw: `BEGIN_PASS`/`SET_PIPELINE`/`SET_BIND_GROUP`/
  `SET_VERTEX_BUFFER`/`SET_INDEX_BUFFER`/`SET_VIEWPORT`/`SET_SCISSOR`/
  `DRAW`/`DRAW_INDEXED`/`END_PASS`.
- Vertex data comes from `WebGPUVertexManager` (currently
  `SWVertexLoader`). It needs a real `VertexManagerBase` that writes
  into the upload ring + records `UPLOAD_BUFFER`+`DRAW`.

### Phase B — consumer executor (discio worker)

Extend `drainWebGpuCmdRing` / the `webGpuObjects` map in
`src/upstream-discio-worker.js` to build & bind real GPU objects per
opcode: buffers, textures, samplers, bind groups, pipelines from the
serialized config, and replay `BEGIN_PASS…DRAW…END_PASS` into an
EFB color+depth `GPUTexture` pair, then present XFB to the canvas.
Shader-module build already works (`replayCreateShader`); pipelines
already work (`replayCreatePipeline`) — generalize from "auto" layout
+ test pipeline to Dolphin's real state.

### Phase C — retire Software delegation (Day-33)

Flip `WebGPUGfx::SupportsUtilityDrawing()` true; stop
`CreateTexture/CreateFramebuffer` returning SW classes; drop
`Clipper::Init/Rasterizer::Init/SWVertexLoader/SWBoundingBox/
SWEFBInterface/SW::TextureCache` from `WebGPU::VideoBackend::Initialize`
(VideoBackend.cpp). EFB/XFB become real `WGPUTexture`s. End state:
`?video=wgpu` shows GameCube content rendered on the GPU, no CPU
rasteriser. Keep `?video=webgpu` hybrid intact.

## Hard-won gotchas (do not relearn these)

- **Vendor is gitignored.** `vendor/dolphin/**` changes are NOT
  committed; they are captured only via the rebuilt
  `cores/dolphin/dolphin-core-upstream.{js,wasm}`. Commit:
  the rebuilt wasm+js, `src/**`, `core/upstream/**`,
  `tools/naga-spirv-wgsl/{Cargo.toml,src,.cargo}`, and a
  `patches/dolphin-wasm/SESSION-*-NOTES.md`. Never commit `.claude/`,
  `logs/`, `.bottleneck-01-rebased.patch`,
  `tools/naga-spirv-wgsl/target/` or `Cargo.lock` (gitignored).
- **Stay on branch `webgpu-hardware-renderer`** (not main). Commit a
  checkpoint after every verified increment, before risky steps.
- **Build:** `npm run build:upstream:full-core` (~5-8 min; redirect
  to a tmp log and grep, the tail scrolls). If you change the Rust
  crate: `cd tools/naga-spirv-wgsl && cargo +nightly build --release
  --target wasm32-unknown-emscripten` FIRST (nightly + `-Z build-std`
  pinned in its `.cargo/config.toml` — needed for atomics/shared-mem;
  do not remove). Rust is at `%USERPROFILE%\.cargo\bin` (not on bash
  PATH — invoke via PowerShell with the full path).
- **If you ever clear CMakeCache.txt**, you must
  `npm run configure:upstream` before `build:upstream:full-core`.
- **Dev server:** `npm start` (background). It picks a free port —
  it has been **8081** (8082 was taken). Always
  `curl http://127.0.0.1:8081/` to confirm; pass
  `BASE_URL=http://127.0.0.1:8081/` to the validator.
- **Validation/probe:** `BASE_URL=http://127.0.0.1:8081/ VIDEO=wgpu
  PRESENTER=webgpu DURATION=55 SHOT_EVERY=50 node
  tools/menu-progress-validate.mjs`. Artifacts in
  `.omx/menu-progress/<stamp>/`; the captured `console.log` is your
  signal channel.
- **Logging:** Dolphin's `INFO_LOG`/`postStatus` do NOT survive in
  the validator (LogManager not wired; status pill only keeps the
  latest). Use `EM_ASM(console.log(...))` from C++ and `console.log`
  (NOT `postStatus`) from the discio worker for anything you need to
  read back.
- **TextDecoder rejects SharedArrayBuffer views** — copy blob bytes
  into a plain `Uint8Array` before `.decode()` (see
  `replayCreateShader`).
- **api_type gating:** all shadergen changes are gated on
  `api_type == APIType::Vulkan` (the WebGPU backend sets this; OGL/
  Software keep the old path — never regress them). `WebGPU::
  VideoBackend::InitBackendInfo` capability flags drive shadergen
  AND VideoCommon transform; mismatches there were the cause of
  several whole-class failures (bitfield, dual-source-blend). When
  flipping `SupportsUtilityDrawing`/retiring SW, expect to revisit
  these flags — match what's truly rendering.
- **Naga name sanitizer** (`tools/naga-spirv-wgsl/src/lib.rs`
  `sanitize_function_names`) is load-bearing — keeps WGSL out of the
  `function` reserved-word cyclic-dependency trap. Don't remove.
- **Method that works:** probe → read the captured
  `console.log`/disasm → identify the ONE offending construct →
  smallest gated fix → rebuild → re-probe → commit. Don't batch
  speculative fixes; each layer reveals the next.

## Verification bar before claiming a phase done

A probe must show, in `console.log`: real Dolphin geometry on the
canvas screenshot (not the test triangle, not the SW hybrid output),
`?video=wgpu`, with the SW delegation off (Phase C) — and
`?video=webgpu` still plays the reference game. Capture screenshots; the user
wants a fresh cache-busted `http://127.0.0.1:8081/?...&cb=<ms>` link
to verify themselves after any build.

## Do NOT

- Do not vendor Tint (decided against; Naga path is 100%).
- Do not touch the `?video=webgpu` hybrid path.
- Do not commit vendor/, target/, Cargo.lock, .claude/, logs/.
- Do not claim done without a probe + screenshot proving it.
