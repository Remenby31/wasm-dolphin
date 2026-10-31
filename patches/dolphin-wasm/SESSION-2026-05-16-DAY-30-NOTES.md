# Session 2026-05-16 (Day 30) — cutover step 1 + a strategy-level finding

Day 30 began the cutover. Step 1 (highest-information, designed to
de-risk before the full plumbing): flip `g_backend_info.api_type`
`Nothing → Vulkan` and measure how much of Dolphin's **real** shader
set survives glslang→Naga→WGSL.

## What changed

- `WebGPU::VideoBackend::InitBackendInfo`: `api_type = APIType::Vulkan`
  (was `Nothing` since Day-21). This makes FramebufferShaderGen /
  PixelShaderGen / VertexShaderGen emit complete Vulkan-dialect GLSL
  (matching the Day-22 SHADER_HEADER) instead of declaration-less
  stubs. Necessarily breaks the Software-hybrid geometry (its
  transform wants `Nothing`) — expected, this is the cutover.
- Naga crate: capture + expose the failure reason
  (`naga_last_error()`, thread-local; `translate()` now
  `Result<String,String>` tagging spv-frontend / validate /
  wgsl-backend). C++ logs it one-shot.

## The finding (measured, decisive)

| api_type | shader coverage | failure stage |
|----------|-----------------|---------------|
| Nothing (Day-24..29) | 6/64 (~9%) | glslang (stubs) |
| **Vulkan (Day-30)** | **12/64 (~19%)** | **Naga spv-frontend** |

Flipping to Vulkan made glslang produce *complete* SPIR-V from the
real shaders — but Naga then rejects ~80% of them at the **parse**
stage:

    [webgpu-shader-fail] stage=2 SPIRV->WGSL (Naga) FAILED words=157 :: spv-frontend: invalid id %14
    ... words=214 :: spv-frontend: invalid id %14
    ... words=310 :: spv-frontend: invalid id %40
    ... words=552 :: spv-frontend: invalid id %20

`invalid id %N` from naga's `spv` frontend = an id referenced whose
defining instruction Naga's frontend didn't process (an unsupported
opcode/decoration skipped → result id never registered). This is a
genuine Naga SPIR-V-frontend coverage gap on Dolphin's complex
pixel/TEV shaders, not a config mistake:

- Validation layer is OFF (`bEnableValidationLayer` unset in
  dolphin_web_core.cpp) → `Spirv.cpp` takes
  `disableOptimizer=false` → glslang's SPIRV-Tools optimizer
  (`Externals/glslang/.../SpvTools.cpp`, in the build) **already
  runs**. The standard "run spirv-opt to canonicalise for Naga" fix
  is therefore already applied — and is not sufficient.
- The shaders Naga *does* translate compile cleanly in the browser
  (`webgpu-cmd-shader module … compiled OK`) — so Naga's output is
  correct; the problem is purely its **input coverage**.

A real hardware renderer needs ~100% pixel-shader coverage (every
TEV configuration must translate). 19% is not viable, and the cheap
mitigation is exhausted.

## This contradicts the Day-22 strategy choice (Naga), with evidence

The remaining realistic paths are large, divergent investments —
genuinely a user decision:

1. **Aggressive explicit spirv-opt legalisation** beyond glslang's
   default preset (the wgpu-recommended pass list:
   eliminate-dead-branches, merge-return, ssa-rewrite, flatten-decos,
   etc.) run as an extra C++ pass before Naga. SPIRV-Tools is in the
   build. Uncertain it closes the gap (Naga frontend gaps can be
   structural, not just optimisation-level); medium effort, unknown
   payoff.
2. **Tint instead of Naga.** Tint is Chrome's production
   SPIR-V/GLSL→WGSL compiler — it handles everything glslang emits.
   But vendoring + building Tint (large C++/Dawn subtree) for
   wasm32-emscripten is a heavy integration (bigger than the Day-23
   Naga staticlib was).
3. **Hand-written WGSL emitter** in Dolphin's shader-gen (the Day-22
   option the user did *not* pick). Total coverage by construction,
   no transpiler; ~6k lines, the longest path.
4. **Accept the hybrid as the shipping ceiling.** Days 18-21 already
   deliver correct, smooth, GPU-presented game frames (57fps, 17.5ms, 0
   drops) with the CPU rasterising. The full WebGPU command bridge
   (Days 27-29, proven) + shader infra remain on the branch for if a
   transpiler path is revisited.

## Step 2 — spirv-opt legalization (user-chosen), CONCLUSIVE NEGATIVE

Refined the Day-30 finding: glslang's optimizer was never compiled in
— `Externals/glslang/CMakeLists.txt` had `set(ENABLE_OPT OFF)` AND
`set(BUILD_EXTERNAL OFF)` (the latter skips glslang's
`add_subdirectory(External)` so SPIRV-Tools is never built). So Naga
had been fed *raw* glslang SPIR-V — the standard mitigation was never
applied, making this experiment worth running.

Did it properly:
- Vendored SPIRV-Tools @ `7f2d9ee9` + SPIRV-Headers @ `01e0577` (the
  commits glslang's `known_good.json` pins) into
  `Externals/glslang/glslang/External/spirv-tools{,/external/spirv-headers}`.
- `ENABLE_OPT ON` + `BUILD_EXTERNAL ON` in
  `Externals/glslang/CMakeLists.txt`. Full reconfigure+rebuild
  (1351 steps, SPIRV-Tools compiled fresh for wasm32-emscripten).
  CMake: `-- optimizer enabled`.

Result — **no change**: coverage stayed **12/64 (~19%)**. The
optimizer IS running (SPIR-V word counts shifted: 157→119, 214→172,
etc. — proof the bytecode was rewritten) but Naga fails with the
**identical** `spv-frontend: invalid id %14` (/%20/%40) errors.

Conclusion: the wgpu-standard "spirv-opt before Naga" mitigation,
fully applied, does **not** fix it. The failure is a structural gap
in Naga's SPIR-V *frontend*, not optimisation-level. **Option 1 is
empirically exhausted.**

Clue for the next decision: the same id (`%14`) fails across many
different shaders (varying word counts). Systematic, not per-shader
feature variance — points to one common construct glslang emits in
*every* Dolphin pixel shader that Naga's frontend can't parse (a
capability/decoration/type early in the module → later ids never
registered → "invalid id"). If pursued, identifying that single
construct could be a cheap last probe before committing to the
heavier Tint / hand-written-emitter paths.

The remaining options are unchanged from the Day-30 question:
2. Tint (Chrome's production SPIR-V→WGSL; heavy wasm integration).
3. Hand-written WGSL emitter in Dolphin shadergen (~6k lines).
4. Accept the hybrid (Days 18-21) as the shipping ceiling.
(2a — cheap last probe: pin down the common `%14` construct first.)

## Step 3 — the probe + targeted fixes (user-chosen), WORKING

The "cheap probe" disassembled the first Naga-rejected shader
(SPIRV-Tools disassembler, now in-build). Root cause was concrete and
systematic, not random: **combined image-samplers**
(`sampler2DArray` → `OpTypeSampledImage` global + `OpLoad`), which
WGSL has no concept of and Naga's spv frontend can't split for the
arrayed case → `invalid id %14` in every pixel shader.

Targeted, API-gated shadergen fixes (Vulkan dialect = WebGPU only;
desktop Vulkan isn't built in wasm; OGL/GLSL-ES keep combined form,
behaviour-identical):

1. **Separate texture+sampler in PixelShaderGen / UberShaderPixel**
   via a `SAMP_AT(i)` macro (`sampler2DArray(tex[i], samp_ss)`) — all
   readTexture/sampleTexture helpers keep their `in sampler2DArray`
   params (combined constructed at the call site).
2. **Same for FramebufferShaderGen** (separate `fbtex{i}`/`fbsmp{i}`;
   samplerless `texelFetch`; `GL_EXT_samplerless_texture_functions`
   added to the translator SHADER_HEADER).
3. **`dolphin_isnan`** (ShaderGenCommon `WriteIsNanHeader`): Naga's
   WGSL backend can't lower SPIR-V `IsNan` — switched the Vulkan
   path to the portable `((f) != (f))`.

### Coverage trajectory (real Dolphin shader set)

| state | ok/64 | first blocker |
|-------|-------|---------------|
| api_type=Nothing (pre-Day-30) | 6 (~9%) | shadergen stubs |
| api_type=Vulkan (raw) | 12 | combined sampler (spv-frontend) |
| + spirv-opt | 12 | (no change — not opt-level) |
| + separate samplers (Pixel/Uber/FB) | 15 | isnan (wgsl-backend) |
| + isnan→(f!=f) | **29 (~45%)** | combined sampler in *more* gens |

Two small targeted fixes took coverage 9% → 45%. The method is
proven and now mechanical: disasm-probe → identify the one construct
→ gated shadergen fix → coverage climbs. Remaining: more combined-
sampler emitters (post-processing / texture-conversion utility
shaders) + whatever the next spv/backend layer surfaces. Bounded,
enumerable, same pattern each time.

Also vendored to make this possible: SPIRV-Tools @ `7f2d9ee9` +
SPIRV-Headers @ `01e0577` under glslang/External; glslang
`ENABLE_OPT ON` + `BUILD_EXTERNAL ON`.

## Step 4 — the grind to 100% translation coverage (user: stay Naga/Rust)

User chose to stay on the Naga/Rust path ("copy what Tint does …
rust reward speed … continue that path"). Continued the mechanical
loop. Each fix is Vulkan-gated (WebGPU only; OGL/Software untouched):

| fix | coverage |
|-----|----------|
| (start) | 6/64 |
| api_type=Vulkan | 12 |
| separate samplers: Pixel/Uber + object-macro Framebuffer/PostProc/TexConv | 36 |
| isnan → (f!=f); bSupportsBitfield=true | (within above) |
| TEV helper chain: SAMP_PARAM/USE/FWD macros (separate tex+samp threaded, combined only at builtin) | 36 (glslang-level solved) |
| separate textures tex_0u..tex_7u + token-paste SAMP_AT (no texture array) | 36 |
| **bSupportsDualSourceBlend=false** | **64/64 (100%)** |

Every real Dolphin shader now goes
GLSL→glslang→SPIR-V→Naga→WGSL with zero failures. The Naga strategy
is fully viable for the entire shader set — Tint not needed. The
naga crate now walks the error source-chain so generic Naga messages
("Entry point invalid") reveal the real cause
("Multiple bindings at location 0" = dual-source blend).

Root causes were all either (a) combined image-samplers (WGSL has
none — split in shadergen, Vulkan-gated) or (b) capability-flag
mismatches in the InitBackendInfo copied from Software (bitfield,
dual-source-blend) or (c) a Naga frontend gap worked around in
shadergen (texture-array indexing, isnan).

### Next layer (not yet done)

Translation is 100%, but the *browser's* WGSL validator is stricter
than Naga's emitter: simple shaders `compiled OK`, some complex TEV
pixel shaders hit `cyclic dependency found: 'function' -> 'function'`
(WGSL forbids recursion; Naga emits a forward/mutual pattern Chrome
rejects). So remaining: (1) browser-WGSL validity for the complex
subset, (2) wire the real pipeline/draw path (Dolphin vertex+state →
GPURenderPipeline via the bridge) so game content actually renders,
(3) retire the Software delegation. Commits: 84fa7b9, 1ecf2c2,
1b75173, 205cd01.

## State

`?video=wgpu` is mid-cutover (api_type=Vulkan): Software geometry now
wrong by design, only ~19% shaders translate — **not usable**, as
expected for this phase. `?video=webgpu` hybrid is **untouched and
still ships the reference game**. Checkpoint `c1c0576` is the clean restore point;
the bridge machinery (Days 27-29) is all proven and committed.

## Files touched (project-tracked)

- `tools/naga-spirv-wgsl/src/lib.rs` — error capture + accessor.
- `cores/dolphin/dolphin-core-upstream.{js,wasm}` — rebuilt.
- `patches/dolphin-wasm/SESSION-2026-05-16-DAY-30-NOTES.md` — this.

Vendor (gitignored): `VideoBackend.cpp` (api_type),
`WebGPUShaderTranslator.cpp` (error surfacing).
