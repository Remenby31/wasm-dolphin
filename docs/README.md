# Documentation

- [Hardware-WGPU renderer worker and upload package plan](wgpu-renderer-worker-plan.md) - seven staged implementation items, ownership/lifecycle invariants, bounded package design, validation gates, and rollback.
- [Hardware WebGPU performance audit (2026-07-13)](performance-audit-2026-07-13.md) - applied-save semantic proof, reproducible candidate, current bottleneck classification, rejected refactors, and next optimization plan.
- [WGPU semantic replay evidence](wgpu-semantic-replay-evidence.md) - default-off runtime ownership/legacy correlation, trusted startup reset attestation, independent WDS2 decoding, and current parity limits.

- [Current status](current-status.md) — supported scope, recommended path, and
  confidence levels.
- [Causal performance telemetry](causal-telemetry.md) — versioned core,
  raster, presentation, worker, WebGPU, audio, and input measurements.
- [Software raster phase profiling](software-raster-profiling.md) —
  metrics-gated traversal, TEV, texture, FIFO, XFB, and stale-frame evidence.
- [Rendering modes](rendering-modes.md) — canonical meanings of `video` and
  `presenter` URL flags.
- [JIT flags](jit-flags.md) — PPC-to-WASM JIT controls, safety defaults, and
  metric interpretation.
- [Reproducible build](repro-build.md) — toolchain record and upstream-core
  build sequence.
- [Performance audit (2026-07-09)](performance-audit-2026-07-09.md) —
  provenance-complete fixed-battle measurements and ranked optimization work.
- [Performance audit (2026-07-10)](performance-audit-2026-07-10.md) — current
  bottleneck classification, five-priority follow-up, decisions, and rollback
  paths.
- [WGPU upload coalescing plan](wgpu-upload-coalescing-plan.md) — scoped
  geometry-packing refactor, lifetime invariants, tests, promotion gate, and
  rollback.
- [WGPU queue-pressure design record](wgpu-queue-pressure-relief.md) —
  removed experiment, safety invariants, and next architecture.
- [WGPU replay and hardware-latency diagnostics](perf-results/wgpu-replay-and-latency-2026-07-10.md) —
  historical nonzero EFB-pass output, repeated replay-pump A/B, GPU
  completion, and GPU-readback input-to-visible evidence.
- [WGPU post-load restore classification](perf-results/wgpu-post-load-restore-classification-2026-07-10.md) —
  zero-payload save proof, first-pass source mapping, classifier semantics,
  and remaining depth/staging risks.
- [Worker transport A/B](worker-transport.md) — one-way reply suppression,
  rollback flag, and measurement counters.
- [WebGPU Naga bridge](webgpu-naga-bridge.md) — SPIR-V-to-WGSL ABI, ownership,
  failure handling, and patched C++ integration.
- [True WebGPU replay classifier](wgpu-real-classifier.md) — bounded pass,
  resource, pass-local EFB output, draw, and present diagnostics for
  `video=wgpu`.
- [Historical first-EFB WGPU evidence](perf-results/wgpu-first-efb-2026-07-10.json) —
  older present-time draw state and nonzero observations retained for context.
- [WGPU replay epoch evidence](perf-results/wgpu-replay-epoch-2026-07-10.json) —
  save-load boundary, upload-arena pressure, EFB/source/backbuffer chain, and
  detached-presentation evidence.
- [Core roadmap](core-roadmap.md) — longer-term core work.
- [OGL performance plan](ogl-performance-plan.md) — diagnostic OGL research.
- [Upstream WASM probe](upstream-wasm-probe.md) — upstream integration notes.

Historical session notes under `patches/dolphin-wasm/` are research records,
not the canonical user-facing reference. Prefer the documents above for the
current contract.
