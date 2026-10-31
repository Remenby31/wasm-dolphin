# Causal performance telemetry

`?metrics=1` exposes `window.__causalTelemetry` and includes the same object in
`window.__lastFrameInfo.causalTelemetry`. The object has
`schemaVersion: 3`; consumers must reject unknown versions rather than guessing
at field meanings. Existing `ppcWasmHelperStats` and `frameProfileStats`
strings remain available for compatibility.

Schema v2 added metrics-gated software-raster phase and sampled stale-frame
fields. Schema v3 adds producer-tagged WGPU upload roles, fixed payload-size
buckets, pass-associated upload-window high-water marks, and verified-save
upload-timeout deltas. See
[Software raster phase profiling](software-raster-profiling.md) for raster
sampling semantics and [the WGPU upload coalescing plan](wgpu-upload-coalescing-plan.md)
for the upload attribution contract.

The performance gate writes the complete object to `samples.json` and each
`sample` event in `events.jsonl`. `samples.csv` contains the JSON object plus
fixed `causal*` columns for the main classification fields. A run manifest
records `causalTelemetrySchema.version` separately from the harness event
schema.

## Measurement groups

| Group | Measurements |
| --- | --- |
| `core` | frame, live worker-observed ticks/PC, tick rate, and CPU-thread after-load checkpoint generation/ticks/PC |
| `softwareRaster` | source XFB identity/timing, software encode/convert/copy, sampled traversal/TEV/texture phases, FIFO age/bytes, XFB and frame generation, and sampled stale-frame reuse |
| `presentation` | backend, pacing and fresh-frame route, immediate/queued/tick-repaint counts, queue current/high-water depth and last/average/max age, lag, underruns/drops, interval and FPS fields, structured JS stage windows, and opt-in asynchronous GPU-completion samples |
| `webgpu` | command-ring registration, drain/empty/processed counts, drain duration, backlog/high-water, atomic pass/drop/abort/oversize/upload-timeout counters, verified-load timeout deltas, producer state-suppression counts, fixed upload-role/size attribution, pass-associated upload-window pressure, deferrals, and errors |
| `workerTraffic` | request/one-way/response/notification counts, actual transferable bytes, estimated payload bytes, and per-type counts |
| `audio` | worker mix duration/count/frames, pump gaps/skips, mix round-trip, observable schedule underrun/overrun, lead, and drift |
| `input` | seqlock SAB/message generations, duplicate/stale/retry counts, worker applies, transport age, legacy next-distinct-frame bounds, and the exact-generation deterministic marker |
| `host` | rAF loop/render/publish duration and main-thread RGBA copy, `putImageData`, and `drawImage` duration |

Counts and directly available byte totals are kept cheaply. Stage timers,
payload estimates, structured parsing, and snapshot cloning are enabled only
by `metrics=1`. The structured snapshot is throttled to at most five updates
per second so normal frame and audio messages do not carry a large telemetry
object.

GPU completion is default-off and enabled with `gpucomplete=1`. It calls
`GPUQueue.onSubmittedWorkDone()` once per 30 successful submits without awaiting
the promise in the presentation loop.

`inputlatency=1` exposes two deliberately different measurements:

- `input.visible` is the legacy host→core-poll→next-distinct-frame bound.
  Animated scenes can change without the input causing that frame, so
  `causalVisualAttribution` is false. WGPU backbuffer readback for this legacy
  route is independently gated by `inputreadback=1`.
- `input.marker` waits for the exact input generation to be core-polled, then
  draws a generation-coded 32×32 marker and records submit and GPU-completion
  timestamps. Its `causalVisualAttribution` is true for that marker.

The headed harness can observe the marker's uniform top-left 8×8 region at rAF
cadence. That result ends at browser-canvas readback; compositor scheduling,
scanout, the display panel, and photon emission are excluded. The observer's
per-rAF `drawImage`/`getImageData` can perturb rendering. For an external
camera or photodiode run, set `INPUTMARKEROBSERVE=0` while keeping
`inputlatency=1` so the 32×32 marker remains visible without the browser
readback observer.

## Save-state checkpoint timing

`CoreTiming::GetTicks()` is CPU-thread-only, while the legacy `coreTicks` field
is polled by the disc-I/O worker. The existing
`State::SetOnAfterLoadCallback` now captures ticks and PPC PC into atomics as
its first action, before GPU/FIFO resynchronization. A rebuilt core exposes:

- `GetLastLoadedCoreTicksLow`
- `GetLastLoadedCoreTicksHigh`
- `GetLastLoadedPPCPC`
- `GetLastLoadedCheckpointGeneration`

The worker reads a generation-stable snapshot and publishes
`loadedCheckpoint*` fields. Fixed-scene validation prefers that authoritative
CPU-thread capture and retains `legacyCoreTicks` and `legacyPpcPc` for
diagnosis. Older artifacts do not expose these functions; their generation is
zero and validation retains the legacy behavior. Do not loosen the fixed
reference-battle checkpoint to hide a worker-thread tick discrepancy.

The current `a239ee47…` core and ABI manifest include these exports. Any future
source-only change still requires a rebuild and ABI/provenance refresh before
qualification.

## Interpretation

Compare deltas over the same fixed battle and use several interleaved A/B
blocks. A high game-speed value does not clear the software renderer: high
`softwareRaster.encodeTotalMs`, low source XFB cadence, or high XFB decode time
can still limit distinct frames. Likewise, a high presentation FPS does not
mean commands reached the GPU; inspect command-ring processed counts/backlog
and renderer errors. Audio presence does not prove smooth audio; pump gaps,
schedule underruns, and mix round-trip time classify different failure modes.

For `pacing=tick`, compare the default immediate route against
`legacytickqueue=1` in complete interleaved blocks. Confirm
`freshFrameDelivery`, the three delivery counters, queue depth high-water, and
average/max queue age before attributing a latency or smoothness change to the
queue removal.
