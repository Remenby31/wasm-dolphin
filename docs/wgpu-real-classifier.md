# True WebGPU replay classifier

The true hardware renderer (`video=wgpu`) replays Dolphin GPU commands from a
shared ring in `src/upstream-discio-worker.js`. Add `wgpuclassify=1` to a
validation URL to collect a bounded, machine-readable classifier alongside the
normal renderer diagnostics:

```text
?core=upstream&video=wgpu&presenter=webgpu&wgpuclassify=1&metrics=1
```

The perf harness stores the result in `renderer-diagnostics.json` and embeds it
in the raw summary/metadata bundle. Without the query flag that field is
`null`; the classifier does not run.

Atomic pass replay is enabled by default. `wgpuatomic=0` restores the legacy
snapshot behavior for a controlled A/B or immediate rollback; it is not the
recommended path. Since the 4 ms replay budget became the default
(2026-10-29), the budgeted drain always replays whole passes and ignores
`wgpuatomic`: the legacy snapshot needs `wgpuatomic=0&wgpureplayms=0`.

## What it classifies

The `wasm-dolphin.wgpu-replay-classifier.v2` payload records bounded ordered
checkpoints:

1. pass atomicity, including a pass forcibly ended at a drain boundary;
2. missing pipelines, bind groups, buffers, textures, or samplers;
3. EFB clear, real draw, and nonzero-readback observations;
4. the first EFB draw and first indexed EFB draw, including pipeline, bind
   groups, vertex/index buffers, viewport, scissor, and draw arguments;
5. an immediate readback after the first completed EFB pass containing a draw,
   independent of later present-time samples;
6. the first present-time EFB readback containing a nonzero byte, including
   its present sequence and readback ordinal;
7. present command submission and the first queue-completion result;
8. the save-load generation, ring indices, pending-pass state, bounded drain
   samples, backlog high-water mark, upload bytes, and upload-arena wraps;
9. separate EFB, presented-source/XFB, and backbuffer readbacks, including RGB
   and alpha counts so opaque black is not mistaken for color output.

Event storage and missing-resource ID samples are capped. Counters continue to
increase after those caps, so the payload remains useful without producing
shader dumps or an unbounded log. A `loadStateFile` request resets the payload
to scope `load-state-file`, preventing boot activity from being mistaken for
evidence about the loaded reference-battle scene. New payloads also carry a monotonic
classifier generation. Header word 3 is exposed as `uploadReadIndex` telemetry
but this JS diagnostic does not advance it; the producer/consumer upload-lifetime
protocol must own that release point.

Present-time EFB readbacks are encoded at `SUBMIT_PRESENT`. A later clear can
therefore legitimately precede those samples. The classifier now also performs
one opt-in copy immediately after the first completed EFB pass that contains a
draw. That pass-local sample proves only whether the output contains nonzero
bytes. Without a pre-pass baseline and source comparison, it does not prove
that the pass mutated the target.

| Classifier code | Meaning |
| --- | --- |
| `PASS_SPLIT_AT_DRAIN` | The consumer ended an open render pass because its current ring snapshot ended. |
| `MISSING_RESOURCES` | At least one replay record referenced a resource absent from the consumer maps. |
| `EFB_DRAW_NO_MUTATION` | Legacy name: a real EFB draw executed, but the sampled EFB readback remained all zero; this is not a before/after mutation test. |
| `WAITING_FOR_DRAW` | No fully bound real draw has executed yet. |
| `WAITING_FOR_EFB_READBACK` | A draw executed, but the bounded EFB readback checkpoint has not completed. |
| `WAITING_FOR_POST_DRAW_EFB_READBACK` | The available EFB sample predates the observed draws. |
| `WAITING_FOR_FIRST_EFB_PASS_READBACK` | The first completed EFB-pass copy is submitted but not mapped. |
| `FIRST_EFB_PASS_MUTATED` | Legacy name: the immediate completed-pass sample contains nonzero color bytes. |
| `FIRST_EFB_PASS_NO_MUTATION` | Legacy name: the immediate completed-pass sample contains no color bytes. |
| `FIRST_EFB_PASS_NO_MUTATION_LATER_PRESENT_MUTATION` | Legacy name: the first pass was zero but a later present-time EFB sample was nonzero. |
| `FIRST_EFB_PASS_READBACK_ERROR` | The immediate copy, submit, or map failed. |
| `PASS` | A nonzero EFB readback and a completed present submission were both observed. |

## Replay-boundary finding and fix

Static inspection found that the producer publishes `BEGIN_PASS`, state, draw,
and `END_PASS` as separate atomic ring records. The worker previously sampled
the producer write index once per drain and unconditionally ended any open pass
at that snapshot boundary. A snapshot can therefore split a valid producer
pass, discard the consumer's pass-local state, and replay later state or draw
records with no pass open.

Patch `0015` now stages a pass privately on the producer and publishes the
complete record batch with one release-store `PushBatch`. Timeout, poison, or
oversize failure leaves the public write index unchanged. Required
create/upload failure poisons and fails the pass closed, and the consumer
submits only committed passes. The older consumer prefix scan remains useful
for compatibility. Retain `wgpuatomic=0` only as a controlled legacy
diagnostic; it is not a recommended runtime mode.

This is a replay-correctness fix, not a claim that `video=wgpu` is playable.
The current evidence package contains synthetic boundary tests plus headed
atomic-replay diagnostics; it does not package the older legacy-replay research
runs and does not rely on their counters.

A separate transport defect made `nojitcache=1` skip the pthread command-ring
and show-image listeners together with the optional JIT cache. That coupling is
removed: renderer transport always installs, while cache work remains
optional.

The later upload-watermark rebuild changed the rendering diagnosis. An older
headed run sampled 182,949 nonzero color bytes after a completed 120-draw EFB
pass, and the canvas showed the changing battle once legacy repaint paths
stopped overwriting the WGPU-owned canvas. The current direct-save run starts
with a different one-draw utility pass: Dolphin restores the save's all-zero
EFB color/depth, so a zero result is correct. The classifier's historical
`MUTATED` names describe nonzero output, not a before/after proof. See
[the post-load restore classification](perf-results/wgpu-post-load-restore-classification-2026-07-10.md).

Historical Day-28 shader/UV dumps and per-draw EFB maps are now default-off;
they were still running in the replay hot path after their investigations had
finished. Use `wgpudeepdiag=1` only to reproduce those probes. Two diagnostic
15-second pairs moved replay cost per command in the favorable direction with
the probes disabled, but the runs remain non-qualifying and do not establish a
stable gameplay-performance gain.

The classifier is the dynamic check for that condition. It does not establish
that every black frame has the same cause: after pass atomicity is clean, use
the missing-resource and pass-local nonzero-output stages to identify the next
failure.

## Upload lifetime and replay backlog

An earlier run reached 117,979 pending records and referenced 63,369,752 upload
bytes through a 32 MiB arena with two wraps. Pending commands could therefore
consume vertex, index, uniform, or texture bytes after the producer overwrote
them.

The command-stream protocol now carries a monotonic upload read watermark.
The producer waits before reusing upload space; the consumer releases bytes
only after a synchronous `writeBuffer`, `writeTexture`, or preserved heap copy.
Incomplete-pass uploads are staged in producer order under a 32 MiB cap, and a
dropped command record rolls its upload allocation back. Focused models cover
uint32 wrap, handshake, ordering, and dropped-tail recovery.

After image correctness was established, two fixed-battle runs per arm compared
the replay pump. Pump-off backlog high-water averaged 58,850.5 records;
pump-on was exactly 16,384. Submitted presentation cadence rose from 19.68 to
29.94 FPS and p95 interval fell from 50.20 to 32.85 ms, while mean game speed
changed from 67.12% to 68.205%. The real WGPU backend now enables the bounded
pump by default; `wgpupump=0` is the rollback. This reduces replay age, not the
underlying replay cost, and does not make the renderer full speed. Since
2026-10-29 `wgpupump=0` alone only stops the polling: the drains stay cut in
4 ms budgets. The old pump-off replay (one unbounded 16,384-record window per
drain) needs `wgpupump=0&wgpureplayms=0`.

Exact producer-side state suppression is separately available with
`wgpustatecache=1`. It suppresses only successfully published exact repeats of
pipeline, bind-group, vertex-buffer, and index-buffer state. Cache state resets
on abort, pass boundaries, destruction, and load fencing; a failed state apply
never populates it. New cores use the producer counters as authoritative;
consumer caching is only an older-core compatibility fallback.

Three final balanced pairs cut commands/s 39.75% and backlog high-water 38.62%,
but did not improve game or presentation cadence. The cache therefore remains
default-off. This is a record-volume diagnostic, not a performance promotion.

The later clean UBO-cache screen exposed the remaining cost more directly:
593,660-819,806 buffer uploads and 833-1,161 MiB per eight emulated seconds.
Upload replay consumed 4.47-5.28 seconds, and three of eight runs exhausted the
watermark wait and aborted one pass. `wgpuubocache=1` suppressed 219-269 MiB
per cache-on run but produced contradictory block effects, so it also remains
default-off. The next renderer branch should combine vertex/index streaming
uploads under the lifetime invariants in
[the upload coalescing plan](wgpu-upload-coalescing-plan.md).

Machine-readable current evidence is in
`perf-results/wgpu-replay-and-latency-2026-07-10.json`. The older
`wgpu-first-efb` and `wgpu-replay-epoch` files remain historical diagnostics,
not current status.

## Experimental query flags

| Flag | Purpose | Default |
| --- | --- | --- |
| `wgpuclassify=1` | Enable bounded v2 replay/load/presentation classification | Off |
| `wgpudeepdiag=1` | Restore historical high-volume shader and draw probes | Off |
| `wgpuatomic=0` | Roll back atomic-pass replay for controlled comparison; ignored by the budgeted drain, add `wgpureplayms=0` | Atomic replay is on |
| `wgpuloadfence=1` | Discard a pre-load incomplete pass through its first end marker | Off |
| `wgpupump=0` | Disable frequent replay polling; the 16,384-record unbudgeted window needs `wgpureplayms=0` too | On for `video=wgpu` |
| `wgpureplayms=0` | Drain the replay without a time budget (`=6`: 6 ms budgets) | 4 ms budgets, whole passes |
| `wgpustatecache=1` | Suppress exact successfully-published stable state records | Off |
| `wgpuubocache=1` | Reuse exact live producer UBO slices | Off |
| `wgpuubometrics=1` | Enable detailed per-draw UBO clocks and atomic histograms; requires `metrics=1` | Off |
| `wgpudetached=1` | Send GPU-completed worker-canvas bitmaps to the main canvas | Off |

## Validation discipline

Use the version-matched reference battle save state and repeat the same headed
Chrome run. Preserve the raw JSON, URL, repository commit, core artifact hash,
browser/GPU identity, scene, and duration. Do not infer a rendering or
performance improvement from the classifier alone; compare canvas hashes,
unique visual FPS, and game-speed metrics before and after a behavior change.

When the known WGPU XFB checkpoint prevents a diagnostic run from reaching the
timed scene, set `PERF_CONTINUE_INVALID_CHECKPOINT=1`. The harness will resume
and capture evidence but keeps the run invalid and non-qualifying.
