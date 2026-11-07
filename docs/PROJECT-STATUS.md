# Project status — measured checkpoint

This is the current checkpoint after the evidence-driven browser performance
program and its five-priority follow-up. For exact machines, fixtures, commits,
raw paths, and attribution limits, use the
[current performance audit](performance-audit-2026-07-10.md) and
[hardware-WGPU evidence](perf-results/wgpu-replay-and-latency-2026-07-10.md).

## Product direction

The recommended path remains Dolphin's software rasterizer presented through
browser WebGPU:

```text
?core=upstream&video=software&presenter=webgpu&cpu=dual&speed=1&wasmjit=1&jitwarmup=700&oc=1&pacing=tick&fastsw=1&metrics=1
```

One fighting game, used as the reference workload, is the only best-supported target. Near-100% game speed describes core
timing, not 60 distinct visual frames per second. The true hardware renderer is
`video=wgpu`; it now renders the fixed battle on the validation GPU, but remains
slow, experimental, and not the recommended path.

## What the fixed-battle evidence established

- Every current validation run loads the exact reference-battle save directly.
  It does not navigate menus or stop at character select.
- The dominant visible limit on the recommended path is distinct software
  frame production. Prior repeated screens held about 100% game speed and 60
  presentation FPS while `fastsw=1` produced about 13.6 unique visual FPS.
- The rebuilt raster profiler now activates traversal, TEV, texture, FIFO,
  EFB-to-XFB encode, source-generation, and stale-reuse counters. Its activation
  smoke measured a 79.7% sampled stale-source ratio; the run overlapped a clean
  build and is not a performance benchmark.
- The first completed hardware-WGPU EFB pass mutated its target: an immediate
  readback after 108 draws contained 182,949 nonzero color bytes. The visible
  green/checker output came from legacy software repaint paths overwriting the
  hardware-owned canvas; those paths are now suppressed after hardware present.
- WGPU upload bytes can no longer be overwritten while pending commands still
  reference them. A monotonic producer/consumer watermark and bounded staging
  preserve upload lifetime across ring wrap.
- After correctness, the 16,384-record replay pump reduced two-run mean backlog
  high-water from 58,850.5 to 16,384 and raised submitted present cadence from
  19.68 to 29.94 FPS. Mean game speed moved only from 67.12% to 68.205%; this is
  still far from full speed.
- All eight old JIT emit failures were attempts at one opcode, `addzex`, which
  had been disabled accidentally at compile time. The rebuilt diagnostic
  recorded zero emit failures. The longest sampled CPU slices were VI/CoreTiming
  work, not JIT compile bursts.
- GPU completion and input-to-visible boundaries are now measurable. The first
  hardware input run matched six applied/core-polled/visible generations, but
  its next-distinct-frame result is not yet causal input-to-photon.
- Sound is working; retained software and hardware diagnostics had no audio
  underruns.
- The clean promoted-core gate averaged 100.077% game speed, 59.333
  presentation FPS, and 14.095 unique visual FPS, but failed because one slice
  fell to 91.696%, below the 95% minimum target.

## Current decisions

| Area | Decision |
| --- | --- |
| Software hybrid | Keep as the default playable route |
| `fastsw=1` | Keep as balanced default; visual cadence remains limited |
| Raster profiling | Metrics-gated; use only to choose a measured hot phase |
| JIT defaults | Keep correctness-sensitive features off; retain runtime escape hatches |
| Audio buffering | Keep until a separate latency A/B preserves zero underruns |
| Hardware WGPU | Continue experimentally; bounded replay pump on, `wgpupump=0` rollback |
| Generated core artifacts | Promote only after independent parity, exact-save validation, and provenance checks |

## Next engineering order

1. Specialize one measured high-volume TEV/texture pixel case with strict
   pixel/XFB parity and repeated visual-cadence evidence.
2. Coalesce redundant WGPU state/command records and cache stable replay state,
   one reversible change at a time.
3. Attribute long VI/CoreTiming slices against raster, XFB, and wait phases.
4. Window GPU-completion samples to the steady battle and classify queue spikes.
5. Add a deterministic input-caused visual marker before calling the current
   next-distinct-frame metric input-to-photon.

No strict end-to-end qualification currently supports a claim that the browser
build is universally lag-free or that hardware WGPU is ready as the default.
