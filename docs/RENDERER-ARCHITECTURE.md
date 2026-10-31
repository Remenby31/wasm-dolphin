# The 3D renderer: upstream Dolphin, wasm-dolphin, and the gap

Written while issue #8 (3D geometry flat/black while 2D draws land correctly) was
still open. Part 3 is the argument for what would have to change.

---

## 1. How a normal Dolphin build renders 3D

The JIT's role in rendering is smaller than the name suggests. It runs the
game's PowerPC code; the game's code writes GX commands into a FIFO in guest
RAM. That is the whole of the JIT's involvement. Everything below happens on
the GPU thread, driven by the FIFO contents, and is identical whether the CPU
is interpreted, cached-interpreted, or JIT-compiled.

### 1.1 FIFO -> register state

`Fifo.cpp` runs `OpcodeDecoder` over the FIFO. It maintains three register files
that together are the GameCube/Wii's fixed-function graphics pipeline:

| File | Meaning | Examples |
|---|---|---|
| **CP** | Command Processor | vertex descriptor: which attributes are present, direct vs index8/index16 |
| **XF** | Transform unit | position/normal matrices, viewport, projection, lighting, texgen |
| **BP** | Blitting Processor | 8 TEV stages, texture setup, blend/z modes, scissor, EFB copies |

### 1.2 Vertices

`VertexLoader` (itself JIT-compiled -- `VertexLoaderX64`/`ARM64`) reads the
game's packed, indexed vertex stream and writes a flat host-friendly layout
described by a `PortableVertexDeclaration`: position, up to 3 normals, 2
colours, 8 texcoords, and `posmtx`. Output goes straight into
`VertexManagerBase`'s streaming vertex/index buffers.

### 1.3 Flush

A flush happens on a state change, an EFB copy, or a full buffer.
`VertexManagerBase::Flush()`:

1. `VertexShaderManager` / `GeometryShaderManager` / `PixelShaderManager` fold
   the current XF/BP state into three uniform blocks (~4112 B VS, ~1536 B PS,
   64 B GS).
2. `ShaderCache` bit-packs the whole relevant BP/XF/CP state into a **UID** and
   looks it up. On a miss, `VertexShaderGen`/`PixelShaderGen` emit GLSL/HLSL
   that *reimplements GX fixed-function as a shader* -- texgen, per-vertex
   lighting, the 8 TEV stages, alpha test, fog -- and the backend compiles it
   into a pipeline.
3. The backend binds the pipeline, the three uniform buffers, textures and
   samplers, sets viewport and scissor, and issues `Draw`/`DrawIndexed`.

### 1.4 EFB -> XFB -> screen

Draws land in the **EFB**, a 640x528 colour+depth render target (multiplied by
the internal resolution). The game periodically issues an EFB copy -- to a
texture, for reflections and shadows, or to the **XFB**, the scan-out buffer.
The presenter blits the most recent XFB to the backbuffer.

The backend surface is `AbstractGfx` -- roughly twenty virtual calls
(`CreatePipeline`, `SetPipeline`, `SetTexture`, `SetViewport`, `Draw`,
`ClearRegion`, ...). D3D12, Vulkan, OpenGL and Software each implement it.

---

## 2. How wasm-dolphin does it

**Everything in section 1 is unmodified upstream.** We fork at `AbstractGfx`.

Our backend does not talk to a GPU at all. It is a **serializer**.

```
  wasm (C++)                    shared heap                JS worker
  ----------                    -----------                ---------
  VideoCommon                 +--------------+
      |                       | command ring |
  WebGPUGfx  -- PushXxx() --> | 32-B records | -->  upstream-discio-worker.js
      |                       +--------------+          |
  WebGPUVertexManager ------> | upload arena | -->  real GPUDevice objects
                              +--------------+
```

* `WebGPUCommandStream` writes a 32-byte `CmdRecord` -- an opcode plus a
  seven-word `arg` union. Bulk payloads (WGSL text, vertex data, uniform
  packets, texture pixels) go into a separate upload arena and are referenced
  by wasm-heap offset.
* 25 opcodes. Resource creation: `CreateShader`, `CreateBuffer`,
  `CreateTexture`, `CreatePipelineCfg`, `CreateSampler`, `CreateBindGroup`.
  Per-frame: `BeginPass`, `SetPipeline`, `SetBindGroup`, `SetVertexBuffer`,
  `SetIndexBuffer`, `SetViewport`, `SetScissor`, `Draw`, `DrawIndexed`,
  `EndPass`, `SubmitPresent`, plus `Destroy`, `BlitTexture`, `ClearRect`.
* `src/upstream-discio-worker.js` is the consumer. It replays the ring against
  a real `GPUDevice`, keeping id->object maps.

### 2.1 Shaders

Upstream's generated GLSL is translated at runtime, four stages:

```
VertexShaderGen/PixelShaderGen (GLSL)
    |  + Vulkan SHADER_HEADER (copied verbatim from VideoBackends/Vulkan)
    v
glslang --> SPIR-V --> Naga (Rust staticlib, wasm32) --> WGSL
    v
createShaderModule
```

So the *shader logic* is upstream's, unchanged. This is why TEV, texgen and
lighting are not on the suspect list.

### 2.2 Deliberate configuration differences

`VideoBackend.cpp` sets `api_type = APIType::Vulkan` so the generators emit
Vulkan-dialect GLSL, then diverges where WebGPU forces it:

| Flag | Value | Reason |
|---|---|---|
| `bSupportsClipControl` | `true` | WebGPU NDC z is `[0,1]`, not GL's `[-1,1]` |
| `bSupportsDualSourceBlend` | `false` | Naga rejects a second output at `location=0, index=1` |
| `bSupportsBitfield` | `true` | `#version 450` has a native `bitfieldExtract`; the polyfill collides |
| `bSupportsGeometryShaders` | `false` | WebGPU has no geometry stage |
| `bSupportsComputeShaders` | `false` | not wired up |
| `bSupportsCopyToVram` | `true` | we have real render-to-texture; the RAM path needs a texture encoder we don't have |

Each of these is load-bearing and was arrived at by measurement -- the
`bSupportsClipControl` line in particular is what made any geometry appear at
all.

---

## 3. Where the replay is *not* faithful

Ranked by whether the divergence can produce the observed split -- 2D correct,
3D flat.

### 3.1 CORRECTION: the reverse-Z convention was right; my reading of it was not

**Two falsifications live here. The first hypothesis (WebGPU cannot express an
inverted viewport) was wrong, and so was the conclusion I drew from the
measurement that replaced it.**

The per-draw tally below is accurate: every EFB viewport arrives non-inverted.
I read that as "these passes are normal-Z, so the consumer's clear-to-0.0 and
global compare flip are wrong". That inference does not follow.

`BPFunctions` emits `near_depth = 1 - max_depth`, `far_depth = 1 - min_depth`.
The `1-x` reverses the sense: the game's near plane lands at the viewport's
*larger* value. Larger depth means nearer -- reverse-Z -- which is precisely
what clear-to-0.0 plus a flipped compare assumes. A viewport arriving with
near < far is what reverse-Z looks like *after* that transform, not evidence
against it.

The measured consequence of inverting it: a Wii racing game's world sits at
`z(0.00,0.84)` and its HUD at `z(0.89,0.99)`, so the HUD is nearer. Under the
"corrected" convention the world occludes the HUD and the pause menu and
controller overlay disappear from the frame entirely. Restoring the original
convention brings them back, matching the software reference. `GX_NATIVE_DEPTH`
stays in the consumer as a switch, defaulting false.

### The measurement itself (still valid)

**The earlier hypothesis in this section -- that GX programs inverted viewport
depth ranges which WebGPU cannot express -- was falsified by measurement on
2026-09-03.** It is kept below only as a record of what was ruled out.

`vpDiagNoteDraw` in the consumer tallies, per draw, the viewport depth range as
the producer sent it (read *before* the `mn > mx` swap) together with the
pipeline's depth compare. The Wii racing game, `video=wgpu presenter=webgpu`, dumped
every 500 presents. A representative in-race frame (present #4000, 764 draws):

```
fb#14 (EFB), ONE render pass:
  635x  vp(0.000, 0.840)  normal  depth=less-equal     <- the 3D world
   38x  vp(0.890, 0.990)  normal  depth=less-equal
   34x  vp(0.000, 0.840)  normal  depth=greater-equal
   23x  vp(0.000, 0.840)  normal  depth=always
   16x  vp(0.840, 0.890)  normal  depth=always
    1x  vp(0.000, 1.000)  normal  depth=none           <- 2D, blits, present
```

Findings:

1. **No inverted range occurs, in any frame, at any point in the run.** Every
   viewport arrives with near < far. The `mn > mx` swap never fires, and
   WebGPU's `minDepth <= maxDepth` restriction is never reached. The
   depth-clamp / `UseVertexDepthRange()` analysis below is therefore not the
   active defect.
2. **No viewport is `(0,1)`.** The game carves depth into disjoint bands --
   `(0, 0.84)` for the world, `(0.84, 0.89)`, `(0.89, 0.99)` -- and several
   coexist in a single pass. This contradicts the note at the `depthClearValue`
   site claiming `[s28at-vp]` proved "EVERY viewport arrives T(near=0,far=1)".
   That probe reported a *transformed* `1-x` value for a different producer
   configuration, and its `s28` tag is dropped by
   `diagnostic-log-filter.js`, so its output never reached the captured console.
3. **The game's own depth compare varies per draw** -- `less-equal`,
   `greater-equal` and `always` all appear on the same framebuffer.

The consequence is the actual defect. Every pass is normal-Z, but the consumer
hardcodes the *reverse-Z* convention:

```js
const dcv = 0.0;                  // depth clear for the whole pass
const REVZ_COMPARE_FLIP_ALL = true;  // less<->greater on every flippable draw
```

The rule stated in the code's own comment at that site is "reverse-Z => clear
depth to far 0.0; normal-Z => far 1.0 (the GX/Dolphin default)". With normal-Z
viewports, near maps to the low end, so clearing to 0.0 and flipping
`less-equal` to `greater-equal` inverts occlusion: the *farther* fragment wins.
Draws with `depth=none` -- 2D, HUD, blits, present -- are untouched, which is
precisely the reported "2D correct, 3D wrong" split. The clear value 0.0 also
sits outside every observed range except the world band's near edge.

Switching to `GX_NATIVE_DEPTH` (clear 1.0, compare unflipped) visibly changes
the Wii racing game's output from washed-out flat regions to saturated textured
terrain, and leaves a GameCube racing game rendering correctly (it renders
correctly under *both* conventions, so it does not discriminate). **It is not a
complete fix**: the Wii racing game still shows large rectangular bands with a hard vertical
seam and an apparently over-zoomed camera, under both conventions. That
remaining defect is geometry/viewport, not depth.

<details>
<summary>Falsified hypothesis, kept for the record</summary>

GX games use the reversed-Z trick: they program `xfmem.viewport.zRange < 0`, so
near = 1 and far = 0. Upstream has **two** ways to carry that, and a backend is
expected to support one of them.

**Carrier A -- the viewport.** Vulkan's `VkViewport` and D3D12's viewport both
permit `minDepth > maxDepth`, so those backends pass the game's values straight
through and the GX depth compare works verbatim. This is gated on
`bSupportsReversedDepthRange`, which we set `false`.

**Carrier B -- the vertex shader.** For backends that can't do carrier A,
`VertexShaderManager::UseVertexDepthRange()` returns true when the range is
inverted, `BPFunctions` then pins the viewport to a uniform
`[0, MAX_EFB_DEPTH]`, and the real range is handed to the vertex shader in
`pixelcentercorrection[2]/[3]`. This is exactly our case -- and it is
short-circuited three lines earlier:

```cpp
  // VertexShaderManager.cpp
  if (g_backend_info.bSupportsUnrestrictedDepthRange) return false;
  if (!g_backend_info.bSupportsDepthClamp) return false;   // <-- we exit here
  ...
  if (!g_backend_info.bSupportsReversedDepthRange) {
    if (xfmem.viewport.zRange < 0.0f) return true;         // never reached
```

`bSupportsDepthClamp` defaults to `false` and the WebGPU backend never sets it.
That is currently *honest*: `requestDevice()` requests no features, so the
optional `depth-clip-control` feature is off and we genuinely cannot clamp
depth. But the consequence is that **neither carrier is available**, so
`BPFunctions` falls through to

```cpp
  near_depth = 1.0f - max_depth;
  far_depth  = 1.0f - min_depth;
```

with the game's own `farZ`/`zRange` still in `min_depth`/`max_depth`. When
`zRange < 0` that yields `near > far` -- an inverted viewport, delivered to a
backend that cannot express one.

WebGPU validation requires `minDepth <= maxDepth`. The consumer therefore clamps
and swaps:

```js
if (mn > mx) { const t = mn; mn = mx; mx = t; }   // upstream-discio-worker.js
```

and compensates globally, in two places that have no upstream counterpart:

* every depth attachment is cleared to `0.0` (`const dcv = 0.0`), and
* every depth compare is inverted (`REVZ_COMPARE_FLIP` + `REVZ_COMPARE_FLIP_ALL`:
  `less<->greater`, `less-equal<->greater-equal`).

**This is a single global convention applied to every draw in every pass.** It
is correct only if every draw in the frame actually uses the reversed range.
The `?framecap` trace of one Wii racing game frame shows the opposite: a single
`BEGINPASS fb#14 (EFB 640x528)` containing roughly 540 draws that mix 3D world
geometry with 2D HUD. The HUD draws use the identity range and mostly disable
depth testing, so the flip does not touch them -- they render correctly. The 3D
draws depend on the range, and one clear value plus one flipped compare cannot
serve both conventions in the same pass.

That is exactly the reported symptom, and it is consistent with the over-clear
having already been exonerated as a cause: the *geometry* of the clear is not
the problem, the *depth semantics* are.

</details>

### 3.2 Clears ignore the scissor -- fixed, on by default

A `loadOp: "clear"` clears the whole attachment and ignores `setScissorRect`,
and Dolphin issues partial clears constantly, so this backend used to over-clear:
a clear requested for 128x128 wiped the whole 640x528 EFB.

`ClearRect` (opcode 25) fixes it by drawing a scissored full-screen triangle
inside the open pass, so the pass is never torn down. **It is on by default.**
The backend owns the default: `DOLPHIN_WEB_RENDERER_FEATURE_DEFAULT` in
`WebGPUGfx.cpp` sets the bit, so a host that never calls the setter still gets
the corrected path.

It did blank the frame when first added, for two reasons, both since fixed:

1. it wrote the producer's clear depth (`0.9999999403953552`) where the `loadOp`
   path writes `dcv = 0.0` for the reverse-Z convention in 3.1, so every later
   draw failed the depth test;
2. the clear triangle is a draw, so its depth was remapped by whatever viewport
   the game had bound. The Wii racing game clears while its HUD viewport
   `z(0.89, 0.99)` is active, which wrote 0.89 across the EFB -- nearer than the
   whole world band `z(0.00, 0.84)` -- and rejected every world fragment. It now
   draws through a full-pass `[0, 1]` viewport and restores the game's.

To turn it off for bisection, use `?wgpuclearrect=0` (the older
`?disable=0x2000000` spelling still works). Doing so restores the over-clearing
legacy path and reproduces the original patchwork frame; it is a bisection knob,
not a fallback.

### 3.3 Capabilities advertised but not implemented

| Flag | Advertised | Reality |
|---|---|---|
| `bSupportsBBox` | `true` | `WebGPUBoundingBox::Read` returns zeros, `Write` discards |
| `bSupportsLogicOp` | `true` | WebGPU has no logic-op blending at all |
| `bSupportsEarlyZ` | `true` | WGSL cannot force early fragment tests |
| -- | -- | `PerfQuery` fully stubbed; occlusion results are always 0 |

None of these produce flat 3D on their own, but each silently mis-renders a
class of effect, and each makes a bisect harder by adding a second explanation
for any wrong pixel.

### 3.4 Smaller structural gaps

* `RasterizationState::cullmode` has four values; the consumer's
  `CULL = ["none","back","front"]` has three. `CullMode::All` -- cull everything
  -- falls through to `"none"`, so geometry that should be invisible is drawn.
  WebGPU has no front-and-back cull mode; it needs an explicit draw skip.
* `VarToWgpuVertexFormat` widens any 1- or 3-component 8/16-bit attribute to
  x2/x4, because WebGPU has no single-component small formats. Correct for the
  formats currently in use, but latent.
* `GetSurfaceInfo()` returns a hardcoded `{640, 480, 1.0, BGRA8}`, and WebGPU
  is the only backend that never calls `g_presenter->SetBackbuffer()`.
* No depth readback and no partial depth copies, so zfreeze and EFB depth peeks
  return wrong values.

---

## 4. What replicating upstream would look like

The order matters -- later steps are unmeasurable until earlier ones land.

**1. Turn carrier B back on.** This is the one that matters, and it needs no new
invention -- upstream already implements the per-draw path we want. In order:

1. Request the optional `depth-clip-control` feature in `requestDevice()` when
   the adapter reports it, and set `unclippedDepth: true` in the pipeline
   primitive state.
2. Set `bSupportsDepthClamp = true` -- honest once (1) is done.
3. `UseVertexDepthRange()` then returns true for inverted and oversized ranges,
   so `BPFunctions` emits a uniform `[0, MAX_EFB_DEPTH]` viewport that WebGPU
   can express, and the real per-draw range travels in the vertex shader.
4. Delete the consumer's compensations: the hardcoded `dcv = 0.0`,
   `REVZ_COMPARE_FLIP`, `REVZ_COMPARE_FLIP_ALL`, and the `mn > mx` swap. The GX
   depth compare goes back to being used verbatim.

If the adapter does not expose `depth-clip-control`, the fallback is to emit the
depth remap in the vertex shader ourselves, which is the same idea without
upstream's help.

Cheap falsification first, before any of that: log the viewport depth range per
draw for one Wii racing game frame (`vpDiagNoteDraw`, tallied over the `?framecap=N` frame).
If a single pass contains both inverted and normal ranges, the diagnosis holds.
If every draw reports the same range, it does not and this section is wrong.

**2. Land `ClearRect` properly.** With step 1 done the depth clear value is no
longer a global constant, so the scissored clear can write the correct depth
directly and the "blanks the frame" failure should go with it.

**3. Stop advertising what we don't implement.** `bSupportsBBox`,
`bSupportsLogicOp`, `bSupportsEarlyZ` -> `false`. Each removes a whole class of
alternative explanation from every future bisect. Bounding box can come back
later via a storage buffer written from the fragment shader.

**4. Make the surface real.** Report the actual canvas size from
`GetSurfaceInfo()` and call `SetBackbuffer()` on resize, as every other backend
does.

**5. Handle `CullMode::All`** by skipping the draw.

Only after 1-3 is a per-draw EFB probe worth re-running: today any wrong pixel
has at least four candidate explanations, and that is why the last several
bisects each ended in a retraction.
