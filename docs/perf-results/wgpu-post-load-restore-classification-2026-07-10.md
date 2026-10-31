# WGPU post-load restore classification - 2026-07-10

The first one-draw EFB pass in the two retained UBO-cache health runs is the
Dolphin save-state EFB restore, not a normal game draw. Both serialized source
payloads in the fixture are entirely zero. A zero color readback after that
pass is therefore the expected output and does not contradict the older
multi-draw WGPU smokes that produced nonzero EFB output.

This is a root-cause classification from a dirty research worktree, not a
clean-tree performance qualification.

## Fixture and run identity

| Field | Recorded value |
| --- | --- |
| Machine | AMD Ryzen 9 9950X3D, 32 logical CPUs, Windows `10.0.26200` x64 |
| Browser | Headed Chrome `143.0.7499.4` |
| Branch/commit | `perf/final-optimization` at `d851b336ca1c9de7da036b73145d3116aef6ec59`, dirty |
| ROM | Reference game, Rev 2 NKit, 1,430,679,552 bytes; SHA-256 `<reference disc SHA-256, not tracked>` |
| Core | `dolphin-core-upstream.wasm`, 12,873,138 bytes; SHA-256 `eaec73b4900d14635ddc2b5d3f825a5279ab6c222ae2890790586193328d3b09` |
| Compressed save | `__battle.sav`, 21,170,115 bytes; SHA-256 `<reference savestate SHA-256, not tracked>` |
| Decoded save stream | 92,835,136 bytes; SHA-256 `89ef3abb5fc9f1e6a76cb8bf305e9a9e9faca916c6702f552ff92800ba510bce` |
| Cache-off raw output | `.omx/final-opt/wgpu-ubo-health-cache0`, 20-second run |
| Cache-on raw output | `.omx/final-opt/wgpu-ubo-health-cache1`, 15-second run |

Both renderer queries used
`video=wgpu&presenter=webgpu&wasmjit=0&wgpuclassify=1&`
`wgpustatecache=0&metrics=1`; their renderer-flag delta was only
`wgpuubocache=0/1`. Harness duration and screenshot capture differed, so these
are classification runs rather than a performance A/B. The save loaded
successfully at time zero in both arms.

## What the first pass was

Both arms captured the same first post-load EFB state:

| Captured property | Value |
| --- | --- |
| Framebuffer | Color texture 14, depth texture 15, 640x528 |
| Formats | `rgba8unorm` color, `depth32float` depth |
| Pipeline | 22: vertex shader 1, fragment shader 21, color write mask 15 |
| Depth state | Write enabled, compare `always` |
| Primitive state | Triangle list, clockwise front face, no culling |
| Viewport/scissor | Full 640x528 target |
| Draw | Non-indexed `Draw(0, 3)`, one instance |

That signature maps to the save-state restore path in the patched Dolphin
source:

- `vendor/dolphin/Source/Core/VideoCommon/FramebufferManager.cpp:679-693`
  creates the EFB restore pipeline from the screen-quad vertex shader, restore
  fragment shader, always-write depth state, and EFB framebuffer state.
- `vendor/dolphin/Source/Core/VideoCommon/FramebufferShaderGen.cpp:658-670`
  samples texture 0 into `ocol0` and texture 1 `.r` into `gl_FragDepth`.
- `vendor/dolphin/Source/Core/VideoCommon/FramebufferManager.cpp:1143-1184`
  deserializes color and depth textures, begins utility drawing, binds the
  restore pipeline and both textures, and issues `Draw(0, 3)`.

The runtime pipeline IDs are local to each run, but the target, formats,
write/depth state, shader shape, and exact three-vertex draw form a
high-confidence match. The first pass began 83.05 ms after the cache-off load
ring boundary and 64.46 ms after the cache-on boundary.

## Save payload proof

The save was independently decoded as one LZ4 block. All offsets below are
zero-based byte offsets. Header parsing produced `u32@28 = 15` for the version
string length, extension offset 47, `u64@55 = 92,835,136` decoded bytes,
`i32@63 = 21,170,048` compressed bytes, and compressed data starting at 67.
The compressed length exactly reaches the 21,170,115-byte end of file.

| Serialized EFB field | Size word offset | Payload offset | Bytes | Nonzero bytes | Max byte | Payload SHA-256 |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Color | 3,170,201 | 3,170,205 | 1,351,680 | 0 | 0 | `23269ee7b1a964065e493ccad6f4b654ae9d71e1a3023121a57c8c2f8f040688` |
| Depth | 4,521,917 | 4,521,921 | 1,351,680 | 0 | 0 | `23269ee7b1a964065e493ccad6f4b654ae9d71e1a3023121a57c8c2f8f040688` |

The 1,351,680-byte size is exactly `640 * 528 * 4`. Both independently located
payloads have the SHA-256 of that many zero bytes. The restore shader therefore
has zero saved color and zero saved depth data to sample.

## Classifier result and downstream output

| Arm | First-pass end record | Draws in pass | Color readback | Classifier | Pass begin/end | Replay errors |
| --- | ---: | ---: | --- | --- | --- | ---: |
| `wgpuubocache=0` | 189,108 | 1 | 0 / 1,351,680 nonzero, max 0 | `FIRST_EFB_PASS_NO_MUTATION` | 7,630 / 7,630 | 0 |
| `wgpuubocache=1` | 40,363 | 1 | 0 / 1,351,680 nonzero, max 0 | `FIRST_EFB_PASS_NO_MUTATION` | 5,317 / 5,317 | 0 |

Neither arm split a pass at a drain, recorded work outside a pass, or reported
a missing resource. The first-pass readback was encoded in the same command
encoder immediately after `pass.end()`, then submitted and mapped without an
error (`src/upstream-discio-worker.js:5863-5948`). Ordering is therefore not
the explanation for the zero result.

The downstream chain continued to produce nonzero color:

| Arm | XFB nonzero color / sampled bytes | Backbuffer last nonzero color / sampled bytes | Distinct canvas hashes |
| --- | ---: | ---: | ---: |
| `wgpuubocache=0` | 918,640 / 1,228,800 at present 311 | 209,279 / 307,200 at present 311 | 21 / 21 |
| `wgpuubocache=1` | 918,640 / 1,228,800 at present 162 | 209,279 / 307,200 at present 162 | 16 / 16 |

The cache-off final screenshot also visibly contains the reference
battle. This establishes that later XFB and backbuffer presentation worked;
it does not retroactively make the earlier zero restore pass nonzero.

## Why `nonzero` is not the same as `mutated`

The current diagnostic does not capture and compare a pre-pass EFB baseline.
`src/wgpu-replay-diagnostics.js:527-542` marks the readback as passing only
when `nonzeroColorBytes > 0`, and lines 761-788 convert a zero result into
`FIRST_EFB_PASS_NO_MUTATION`. That is a nonzero-output predicate, not a
before/after mutation test.

Consequences:

- A correct draw that writes zeros to a zero target receives the legacy
  no-mutation classifier label.
- A nonzero post-pass target proves nonzero output, but without a baseline it
  does not by itself prove which draw changed a byte.
- The older zero-error 120-draw smoke remains useful evidence that the WGPU
  path produced 182,949 nonzero EFB color bytes and visible game output. It is
  a different pass from this one-draw save restore and is not contradicted by
  the current result.

A true mutation classifier should capture a pre-pass baseline or seed a known
sentinel, then compare post-pass bytes. Restore-pass expectations should also
be derived from the serialized source payload.

## Separate correctness risks

The zero color result is explained, but it does not clear two adjacent risks.

### Depth restore binding

`src/upstream-discio-worker.js:5020-5042` gives the fixed group-1 layout
filterable-float texture bindings. Lines 5136-5149 replace non-filterable
textures, explicitly including EFB depth `r32float`, with a dummy
`rgba8unorm` view. The restore shader samples binding 1 into `gl_FragDepth`.
The color-only classifier therefore cannot show that saved depth reached the
restore shader. Validate depth separately with a compatible binding layout and
depth readback before calling EFB restore complete.

### WebGPU staging readback

`TextureCacheBase::SerializeTexture` uses a staging texture to copy and read
GPU texture bytes (`vendor/dolphin/Source/Core/VideoCommon/TextureCacheBase.cpp:442-498`).
The current WebGPU staging implementation allocates a zero-filled host buffer,
does no copy in `CopyFromTexture`, returns success from `Map`, and only clears
the flush flag (`vendor/dolphin/Source/Core/VideoBackends/WebGPU/WebGPUTexture.cpp:204-245`).
Consequently, a save created through this WebGPU path can serialize zeros even
when the live EFB is nonzero. The retained fixture proves zero payloads; it
does not retain enough creation provenance to prove why they became zero.

Implement and validate real GPU-to-mapped-buffer staging readback, or reject
WGPU save-state creation explicitly until it exists. That issue is independent
of command replay and UBO caching.

## Raw evidence integrity

| Artifact | SHA-256 |
| --- | --- |
| `wgpu-ubo-health-cache0/run-metadata.json` | `28fdd312a7029a9a4361f65fd8d45e8ce7a689075fe4f6a74efe1b38e8393d73` |
| `wgpu-ubo-health-cache0/renderer-diagnostics.json` | `e0b498d27e1bc471bfcb569b350e0a2146198eb3a5222aeb8415620a6c6795a7` |
| `wgpu-ubo-health-cache0/summary.json` | `19c96dbb52c6c1f509c18b628764620081ecb6190c8e7bfd4ffa27318a7e5f39` |
| `wgpu-ubo-health-cache0/zz-final.png` | `4c1b2322f89ec3b159e784ccdd317bceabbcd1b249b3de935aef8f14a45336aa` |
| `wgpu-ubo-health-cache1/run-metadata.json` | `bf32f7fcd8dbdfa3b1599793dbc981d063b2f5cd03297c43cacaa9e7fd7431b4` |
| `wgpu-ubo-health-cache1/renderer-diagnostics.json` | `226c3c77da474c5165cad38bf66f01c475e85d52df679e4d4351012cd5aa3fdf` |
| `wgpu-ubo-health-cache1/summary.json` | `f1f63b233b8ddd11119a5ffd062fa63e79f22e1fb1b52ab5eefa0292e7c53a56` |

These paths are local retained artifacts under `.omx/final-opt/`. Reproduce
from a clean commit before promoting any result to a regression threshold.
