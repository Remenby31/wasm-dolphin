# Hardware-WGPU queue-pressure relief experiment

Status: rejected experiment; runtime removed before release. This is an evidence
and design record, not an available rendering mode.

## Problem statement

Direct reference-battle measurements isolate the recurring 1.7-second worker
freeze to `GPUQueue.writeBuffer` after the WASM heap copy. The blocking write
is small (roughly 1.5–12 KiB) and its producer role changes between UBO and
packed geometry. This indicates cumulative browser/Dawn upload-staging
backpressure rather than one pathological payload.

The same worker event loop handles replay, audio RPCs, and input application.
When `writeBuffer` blocks, audio underruns and input-marker supersession follow.
Outer 4/6 ms replay budgets cannot interrupt a single synchronous queue call.

## Experiment that was tested

The removed `wgpuqueuewait=1` flag enabled asynchronous pressure relief. The
experiment armed after either:

- 8,192 successful queue upload calls, or
- 16 MiB of successful queue upload payloads.

Both thresholds are below the first measured backpressure cliff.

When armed, replay continues through the current atomic render pass. At the
next safe pass/submission boundary it submits encoded work, publishes the
consumed command index, and returns to the event loop without consuming or
releasing the next upload. It starts `queue.onSubmittedWorkDone()` as a promise,
not a blocking wait. Audio, input, presentation, and host callbacks can run
while the GPU queue drains. Replay resumes through the existing pump only after
the same renderer/load generation completes the wait.

## Safety invariants

- Never yield or wait inside an open render pass.
- Submit encoded work before requesting queue completion.
- Never stage or release an unconsumed upload suffix during a relief stop.
- Preserve monotonic command and upload-watermark ownership.
- Suppress replay pump and presentation redrains while waiting.
- Ignore stale completion callbacks after load, reset, or device replacement.
- On rejection, record the failure, disable relief for the run, and resume the
  legacy pump rather than deadlocking.
- The experiment had to preserve the current path when disabled.

The producer may block on the bounded upload arena while the asynchronous wait
is pending. That is intentional: the GPU queue progresses independently and
the worker event loop remains free.

## Required evidence

Raw telemetry must record thresholds, trigger reason, interval calls/bytes,
boundary overshoot, wait count/duration/failure/stale callbacks, backlog and
watermark at arm/resume, suppressed drains, and audio/input activity while
waiting.

Promotion requires balanced direct-save A/B evidence with:

- materially lower maximum queue-write and drain duration;
- zero WebGPU errors, upload timeouts, batch aborts/drops, or pass splits;
- nonzero indexed-EFB, XFB, and backbuffer evidence;
- improved audio gaps and exact input propagation;
- game-speed noninferiority lower 95% bound above -1%.

The measured variants traded the synchronous stall for timeout, abort/drop,
audio, or input failures. The runtime was therefore removed. A dedicated
renderer worker with bounded producer backpressure or a mapped staging pool is
the next architectural option.
