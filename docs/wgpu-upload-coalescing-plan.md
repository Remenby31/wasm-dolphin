# WGPU upload coalescing plan

This is the scoped follow-up for hardware-WGPU replay performance. It is not
implemented on `perf/final-optimization`; that branch establishes the
measurement boundary and keeps all new renderer optimizations opt-in.

## Measured problem

The fixed reference-battle screen recorded 593,660-819,806
`UPLOAD_BUFFER` calls and 833-1,161 MiB per eight emulated seconds. Upload
replay consumed 4.47-5.28 seconds, while the measured shared-memory payload
copy accounted for only 0.89-1.23 seconds. Three of eight runs stalled long
enough to exhaust the 32 MiB upload watermark, poison one transaction, and
abort one pass.

Cache-on attribution separates the calls:

| Source | Share of upload calls | Interpretation |
| --- | ---: | --- |
| Vertex plus index | About 70-72% | Best first coalescing target |
| UBO cache misses | Nearly all remaining calls | Second, higher-risk target |
| Other uploads | Less than 0.3% in retained runs | Not the current call-count bottleneck |

The objective is fewer WebGPU upload calls without weakening upload lifetime,
pass atomicity, or byte correctness. None of the changes below should be
described as a byte-volume optimization unless new measurements prove that.

## Option ranking

| Order | Change | Expected effect | Risk | Decision |
| ---: | --- | --- | --- | --- |
| 1 | Combined vertex/index streaming upload | Remove roughly one upload per indexed draw, about 207k-247k calls per retained run | Medium/high | Implement first, default-off |
| 2 | 64 MiB producer upload arena with 32 MiB fallback | Timeout headroom only | Low/medium | Test independently after coalescing |
| 3 | Time-budgeted adaptive replay window | Fewer drain schedules and less suffix staging | Medium | Test after call volume falls |
| 4 | Packed variable-slice UBO upload | Fewer UBO calls when multiple classes miss together | High | Defer until geometry result is measured |

Increasing a timeout is rejected: the observed 1.8-2.4 second stalls would
become longer visible lag while still preserving excessive call volume.

## Follow-up branch and commits

Use branch `perf/wgpu-geometry-upload-pack` with three reviewable commits:

1. Add destination-role and payload-size attribution.
2. Add a default-off `wgpugeompack=1` geometry upload path and deterministic
   parity/wrap tests.
3. Add balanced headed evidence and the promotion decision.

Do not mix the arena-size or adaptive-window experiments into the geometry
commit.

## Stage 1: close attribution gaps

Add calls, bytes, maximum payload, and size buckets for these destination
roles:

- UBO;
- utility uniforms;
- vertex;
- index;
- texture-adjacent buffers; and
- unknown.

Also record per-pass upload calls, bytes, destination-span high-water, and
whether a producer timeout occurred before or after the verified save load.
The raw JSON/CSV fields must be cumulative and monotonic.

Likely files:

- `vendor/dolphin/Source/Core/VideoBackends/WebGPU/WebGPUCommandStream.cpp`;
- `WebGPUGfx.cpp` and `WebGPUVertexManager.cpp` for role labels;
- `src/upstream-discio-worker.js` and `src/causal-telemetry.js` for replay
  publication; and
- focused parser/schema tests.

## Stage 2: combined geometry packet

The smallest viable design keeps the legacy two-upload path as rollback:

1. Create one GPU buffer with `VERTEX | INDEX | COPY_DST` usage.
2. Reserve one producer upload-arena packet per committed geometry batch.
3. Place vertex bytes at relative offset zero.
4. Place index bytes at the next four-byte-aligned offset and zero the padding.
5. Copy the two source spans directly into that one reservation without a
   temporary per-draw allocation.
6. Emit one existing `PushUploadBuffer` record.
7. Bind vertex and index views at their packet offsets; preserve equivalent
   base-vertex and first-index semantics.
8. Publish the rolling cursor and last offsets only after allocation and
   command publication both succeed.

Likely implementation points:

- `WebGPUVertexManager.cpp`: `EnsureBuffers` and `CommitBuffer`;
- `WebGPUVertexManager.h`: shared buffer ID, cursor, and last-batch placement;
- `WebGPUCommandStream.cpp/.h`: two-segment arena reservation/copy helper; and
- `WebGPUGfx.cpp`: `Draw` and `DrawIndexed` binding offsets.

### Required invariants

- Vertex and index bytes reconstructed by the consumer are byte-identical to
  the legacy uploads.
- Offsets satisfy WebGPU vertex/index alignment and bounds rules.
- An empty segment does not shift or corrupt the other segment.
- Publication failure leaves cursors, last offsets, and draw state unchanged.
- A private pass cannot wrap and overwrite destination bytes referenced by an
  earlier draw in the same unpublished pass.
- Save load, abort, device loss, and mode toggles invalidate packet state.
- Old GPU buffer generations are not reused before the corresponding submit
  boundary is complete.

The last two invariants require either buffer-generation rotation on wrap or an
explicit submit/rollover barrier. A large buffer alone is not a proof of safe
lifetime.

### Required tests

- randomized packet layout and byte reconstruction;
- alignment, empty segment, maximum segment, and exact-end cases;
- tiny-ring repeated-wrap stress;
- publication/allocation failure rollback;
- indexed and non-indexed draws;
- save-load and pass-abort invalidation;
- fake-consumer comparison against the two-upload legacy path; and
- headed fixed-save validation with zero drops, aborts, timeouts, missing
  resources, and pass splits.

Mechanical acceptance is approximately one removed upload per indexed draw
with byte growth limited to deterministic alignment padding.

## Stage 3: independent capacity and scheduling screens

After geometry coalescing:

- test a 64 MiB producer arena with a 32 MiB allocation fallback;
- keep the JS held-upload cap at 32 MiB unless its own limit counter proves a
  larger cap necessary; and
- test a time-budgeted replay controller rather than an unbounded record
  window. Target 4-6 ms, sample elapsed time periodically, and always finish an
  opened atomic pass.

These experiments must record audio/input fairness and worker long tasks. A
lower backlog is not sufficient if it increases input latency or audio gaps.

## Stage 4: UBO packetization only if still justified

Plan cache hits before mutating offsets or dirty flags, allocate changed
classes in one 256-byte-aligned packet, emit one upload, and publish cache
entries only after success. Liveness must be tracked in monotonic ring bytes,
not the current fixed 8 KiB slice count. Preserve binding order
`{PS or utility, VS, PS, GS}` and the `b0 == b2` relationship.

This is higher risk than geometry packing and should not start until the first
refactor's remaining call distribution is measured.

## Promotion gate and rollback

Use the exact direct-loaded battle with balanced blocks and fixed emulated
work. Require:

- verified fixture, commit, core, browser, and backend identity;
- zero upload timeouts, batch aborts/drops/oversize events, missing resources,
  replay errors, and pass splits;
- nonzero XFB and backbuffer readbacks;
- manual battle screenshots with no black/green/menu-only output;
- raw JSON/CSV/events plus final artifact hashes; and
- a confirmation experiment before enabling any path by default.

Rollback is `wgpugeompack=0` plus one revert of the opt-in implementation
commit. Keep `wgpuubocache` and producer state suppression default-off until
their own strict confirmation gates pass.
