# Hardware-WGPU renderer isolation and upload packaging plan

Status: approved architecture; implementation not yet promoted.

This plan targets the remaining hardware-WGPU smoothness problem without
changing emulator or renderer defaults until repeated fixed-scene evidence
passes. The current fixed reference-battle campaign reached `99.716%` game
speed once, but adjacent repeats reached `81.894%` and `82.277%`. Stable
realtime has not been demonstrated.

## Evidence boundary

- The true hardware path is `video=wgpu`.
- Direct queue uploads improve the observed slow regime, but do not eliminate
  run-to-run bimodality.
- Geometry packing removes substantial queue-write CPU overhead, but its
  adjacent off/on speed effect was only `+0.383` percentage points.
- A previous giant batched write stalled synchronously for `1.728 s` and caused
  98 audio underruns. Large pass-sized writes are rejected.
- An upload-only nested worker was previously slower. A full renderer worker is
  justified to isolate unavoidable browser/Dawn stalls from disc, audio, input,
  and control work; it is not assumed to improve throughput.

## Target topology

```text
Main / UpstreamWorkerAdapter
 ├─ dolphin-upstream-discio
 │   ├─ Emscripten module and shared WebAssembly memory
 │   ├─ core, disc, JIT, audio, input, save/load control
 │   └─ renderer control MessagePort + small control SAB
 └─ dolphin-wgpu-renderer
     ├─ visible OffscreenCanvas
     ├─ GPUAdapter, GPUDevice, GPUCanvasContext
     ├─ sole WGPU command-ring consumer
     ├─ replay resources and mapped/direct upload transports
     └─ bounded telemetry snapshots
```

The Dolphin video pthread already owns the native producer-side thread-local
device abstraction; it is not a browser `GPUDevice`. Every browser `GPUDevice`
and browser GPU resource belongs only to the JS consumer and can be created in
the renderer worker. No browser `GPUDevice`, draw command, upload payload, or frame is
sent per draw with `postMessage`; the hot path remains the existing shared
ring/heap.

## Ownership invariants

- The visible OffscreenCanvas, browser WGPU device/context, and all browser GPU
  resources have exactly one owner: inline replay or the renderer worker.
- The Dolphin video pthread is the only producer of ring records and upload
  bytes.
- Exactly one consumer publishes ring read indices, upload watermarks, and
  consumer status.
- The discio worker retains only an emergency ring-header view so a crashed
  renderer can fail the consumer and unblock a waiting producer.
- Shared WASM heap attachment carries a generation. A changed heap buffer must
  rebind explicitly or fail closed.
- Audio and input SABs remain outside the renderer. A separate small control
  SAB carries checkpoint/input-marker generations and renderer completion
  acknowledgements without per-frame RPCs.
- No live fallback occurs after canvas transfer or ring attachment. Recovery is
  a page reload with the experimental flag disabled.
- The current C++ producer is a process-lifetime singleton: `EnsureRing()`
  allocates its header once and never replaces it. The inline extraction may
  ignore only an exact retransmission of that descriptor; any different second
  handoff fails closed and requires a page reload. A future restartable renderer
  must add an explicit native ring epoch before supporting in-worker replacement.
- Boot has no dual-consumer interval: transfer the canvas before any context is
  created, but first run the renderer canary while fallback is still possible.
  Transfer/init the visible canvas, await renderer device/context readiness,
  then boot discio/Emscripten and attach the later pthread ring. Dedicated mode
  never creates the discio-side presenter/device or passes it as a
  preinitialized browser WebGPU device. The producer stays paused/not started,
  inline replay is absent or quiesced and relinquished, and the renderer worker
  CAS-claims ownership before the producer resumes.

## Seven implementation items

| ID | Item | Completion gate | Status |
| ---: | --- | --- | --- |
| 1 | Lock replay behavior | Executable fixtures prove indices, upload watermarks, resource generations, op order, quiescence, GPU completion, and failure paths. | In progress |
| 2 | Extract renderer runtime, same thread | Inline hardware behavior uses the extracted runtime with byte/order/telemetry parity and no default change. | Pending |
| 3 | Add renderer protocol and canary | Versioned session/epoch RPCs, timeout/crash handling, and worker WebGPU clear/triangle/checker tests pass behind `wgpurenderworker=1`. | Pending |
| 4 | Move canvas/device ownership | Renderer worker directly owns the visible canvas and browser WGPU device; inline rollback remains available on next boot. | Pending |
| 5 | Move ring consumption | One-time SAB handoff activates exactly one consumer; synthetic replay and first real Dolphin draw match inline semantics. | Pending |
| 6 | Move lifecycle/telemetry bridges | Pause/quiesce/load epochs, GPU-complete screenshots, bounded telemetry, audio independence, and input-to-visible correlation pass. | Pending |
| 7 | Add bounded draw upload packages and validate | Package/page parity passes, physical writes fall by at least 95%, and balanced fixed-battle A/B plus audible/latency confirmation meet promotion gates. | Pending |

## Module boundaries

Planned modules:

- `src/wgpu-renderer-protocol.js`: versioned messages and lifecycle states.
- `src/wgpu-renderer-client.js`: discio-side bounded RPC client and cached
  telemetry.
- `src/wgpu-renderer-runtime.js`: device, context, ring, replay, resources,
  uploads, completion, and diagnostics. It is instantiated inline first.
- `src/wgpu-renderer-worker.js`: thin dedicated-worker entry.
- `src/wgpu-draw-upload-package.js`: strict package decoder, validator, and
  physical page builder.
- `src/wgpu-visible-replay-executor.js`: the real per-record execute/state
  logic shared by inline and worker modes after ownership extraction.

`src/wgpu-renderer-worker-probe.js` remains a canary. It is not expanded into
the production runtime.

## Renderer protocol

Discio to renderer:

- `attach-ring`: session, epoch, heap generation/SAB, pointers, capacities, and
  protocol version.
- `snapshot`, `quiesce`, `begin-load-epoch`, `commit-load-epoch`.
- `configure-diagnostics`, `destroy`.

Renderer to discio:

- RPC replies bound to request/session/epoch.
- `ring-attached`, fixed-size bounded telemetry (maximum 5 Hz), `status`, `fatal`,
  `device-lost`.
- Rare native-control requests needed by semantic ownership/checkpoint
  diagnostics.

Unknown versions, stale sessions/epochs, duplicate ring consumers, missing
completion support, and timeouts fail closed.
Telemetry delivery is never required for ring progress. Final/quiesce RPCs may
return a separate full frozen snapshot.
Until the native-control bridge exists, dedicated mode rejects
`wgpusemantic`/ownership diagnostics instead of silently producing incomplete
evidence.

## Pause and load ordering

Every `loadState` and `loadStateFile` transaction must, when dedicated replay is
active:

1. Record the prior core state, pause, and verify `Paused`.
2. Quiesce replay, mapped work, remaps, and ring indices.
3. Await `queue.onSubmittedWorkDone()` and revalidate the empty ring.
4. Begin a new renderer load epoch and clear transient held state.
5. Transition audio so stale samples cannot cross the load.
6. Load the save and await the existing CPU-pthread checkpoint.
7. Commit the renderer epoch with the checkpoint generation.
8. Resume only if the core was running before the transaction.

Normal user slot-save behavior stays unchanged during initial extraction.

The extracted renderer never calls `workletAudioProducer.refill`. Audio remains
owned by its independent 10 ms producer timer; the inline-to-worker A/B must
explicitly validate underruns before promotion.

## Extraction sequence

The first same-thread seam is ring ownership and quiescence, not the opcode
switch. `WgpuRendererRuntime` first owns descriptor/SAB attachment, session and
heap-generation guards, current read/upload-read publication, snapshot, and
stable-empty/GPU-completion orchestration. It receives injected drain,
mapped-finalizer, queue, clock/timer, status, and fatal callbacks while the
existing opcode/resource executor remains inline.

Next, extend the existing command-ring fixture with a deterministic fake GPU
device/context and move the current per-record execution/state logic into
`wgpu-visible-replay-executor.js`. Both inline and future worker modes must call
that exact executor. Its golden snapshot locks opcode/API order, payload bytes,
draw state, resource generations, upload releases, pass/submission digests,
semantic digest, fatal scope, and deterministic clear/triangle/checker pixel
hashes. Scheduling and worker ownership move only after this executor passes.

## Bounded draw upload package

The native producer eventually emits a new explicit protocol capability and
opcode. It must not overload the removed UBO package experiment.

One immutable package owns the vertex, index, and changed VS/PS/GS UBO spans
needed by one draw. V1 excludes textures, readbacks, and utility uploads. Its
header carries schema/version, total bytes, span count, load/device epoch,
ownership transaction, and draw identity. Each span descriptor carries resource
ID and generation, destination offset, payload offset, logical size, and role.

Hard limits:

- package payload: at most 128 KiB;
- spans: at most 8;
- physical CPU page: 256 KiB;
- packages per page: at most 32;
- page build/collection target: 0.5 ms, checked only between whole packages;
- GPU staging ring: 8 MiB, 32 pages;
- no package splits across pages.

The renderer performs one `queue.writeBuffer` per physical page and emits
ordered `copyBufferToBuffer` scatters before the dependent render pass. It
flushes at any package/page/time limit, pass boundary, present, readback,
destroy, load, device loss, or fatal condition. It also flushes before every
excluded or legacy upload/dependency boundary, including texture/legacy buffer
uploads, copies, readbacks, resource mutation/destruction, and any command that
can observe the destination. Global command order is never crossed. The time
target cannot preempt one package; overshoot/max are recorded and `BEGIN_PASS`
forces a synchronous flush. The design never emits the rejected 6–16 MiB
pass-sized write.

Alignment and lifetime:

- pages start at 256-byte boundaries; descriptors are 16-byte aligned;
- buffer-copy source, destination, and size remain 4-byte aligned;
- UBO destination/dynamic offsets retain 256-byte alignment;
- vertex/index offsets, stride, format, and draw order remain exact;
- padding bytes are zero and excluded from logical accounting;
- a CPU page may reset only after `writeBuffer` returns;
- a GPU page offset may be reused only after `queue.submit()` has actually
  enqueued the command buffer containing its copy commands; `encoder.finish()`
  is not sufficient;
- destroy, generation change, load, device loss, or validation failure
  invalidates the whole pending package/page.

Producer publication is transactional. It reserves one contiguous upload-arena
tail, initializes all bytes/descriptors, advances only the producer-local arena
cursor, then release-publishes the package record. Publication failure rolls
back that last reservation. Successful ring publication is the point of no
return; only then do geometry offsets, UBO cache shadows, and dirty flags
commit. The consumer advances `upload_read` only after copying the entire
immutable package into private page memory. Runtime fallback after partial
mutation or publication is forbidden.

The package record becomes consumer-visible before the dependent atomic
`BEGIN_PASS`. Every page write and scatter copy is enqueued/encoded before
`beginRenderPass`, matching the current rule that public uploads precede the
private pass records published by `PushEndPass`.

Descriptor order is exact. Overlapping destination ranges are never reordered
or merged. Coalescing is allowed only for the same resource and generation,
contiguous source and destination ranges, identical role, and no intervening
dependency.

If CPU page copy, `queue.writeBuffer`, copy encoding, or `queue.submit` throws,
the consumer does not release the still-owned package suffix or reuse its GPU
page. The entire renderer session fails closed.

## Measurement and promotion gates

Passive projection first, simulating exact legacy-boundary flushes and physical
page fill in command-stream order:

- at least 95% projected physical queue-write reduction;
- no more than 5% byte/padding inflation;
- zero order, ownership, generation, or lifetime hazards;
- zero package fallbacks for promotion (less than 0.1% is diagnostic screening
  only);
- physical writes at most 5% of the measured baseline, targeting fewer than
  30,000 per 12 emulated seconds.

Correctness/fairness:

- exact expanded semantic digest and resource-generation parity;
- zero WGPU errors, drops, aborts, timeouts, missing resources, pass splits,
  page-reuse violations, or fallback after mutation;
- correct GPU-complete battle screenshot and changing visual cadence;
- zero new audible AudioWorklet underruns;
- GPU completion, worker long slices, presentation tails, and input-to-visible
  p95/max no worse than 5%.
- maximum physical write payload 256 KiB; queue-write p99 target 2 ms; reject
  any write above 20 ms and hard-reject any above 50 ms, with
  `>2/>8/>20/>50 ms` counters. Small writes have stalled before, so the payload
  cap does not claim to prevent Dawn stalls or hide visual/input latency and
  producer backpressure.

Performance:

- at least two valid balanced ABBA/BAAB blocks for screening;
- identical machine, Chrome, core/cache hashes, affinity, save, fixed 12-core-
  second work unit, and post-run correctness fence;
- median game-speed effect at least `+3%`, paired confidence lower bound above
  zero, and no paired regression worse than `-2%`;
- final clean confirmation meets the project realtime PRD and includes an
  audible fairness block.

Required package/worker tests include randomized byte parity, exact capacity
and uint32 wrap, overlapping writes, indexed/non-indexed draws, empty UBO
classes, oversize preflight fallback, publication rollback, pass poison/abort,
load/device epoch changes, destroy-before-flush, page exhaustion with
upload-only submit, write/encode/submit throws with held-watermark evidence,
worker crash/ownership conflict, and expansion to the exact ordered legacy
semantic events.

## Rollback

- `wgpurenderworker=1` and the future draw-package flag are independent and
  default off until promotion.
- Runtime extraction, worker ownership, native package production, browser
  page aggregation, and default promotion remain separate commits.
- Initialization/capability failure may select inline behavior only before
  canvas transfer and producer mutation. After transfer, runtime fatal/device
  loss pauses and fails closed; recovery requires page reload with the flag
  disabled and never live-switches mid-pass.
- Main observes renderer `error`/termination, notifies discio, and discio uses
  its emergency ring-header view to set consumer failure and wake a producer
  blocked on capacity.
