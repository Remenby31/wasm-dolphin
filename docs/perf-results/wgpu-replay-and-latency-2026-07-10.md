# WGPU replay and latency diagnostics — 2026-07-10

These are diagnostic headed-Chrome runs, not a claim that `video=wgpu` is
release-ready or full speed. Every run directly loaded the version-matched
reference battle save; none stopped at character select.

| Field | Value |
| --- | --- |
| Machine | Windows `10.0.26200`, Ryzen 9 9950X3D, 32 logical CPUs, 128 GiB RAM |
| Browser | Headed Chrome `143.0.7499.4` |
| Branch/commit | `perf/next-program` / `c175006b…625f8`, dirty diagnostic tree |
| Core | 12,813,188 bytes; SHA-256 `4fddc41d…ea85` |
| ROM/save | SHA-256 not tracked (local reference config) |
| Mode | `video=wgpu`, `presenter=webgpu`, `wasmjit=0`, fixed battle |

The matching machine-readable record is
[`wgpu-replay-and-latency-2026-07-10.json`](wgpu-replay-and-latency-2026-07-10.json).

## Historical nonzero EFB output

The previous classifier read the EFB at a later present boundary, where a
subsequent clear could erase earlier work. A new opt-in readback now runs
immediately after the first completed EFB pass containing a draw.

That pass targeted texture 14, contained 108 draws, and returned 182,949
nonzero color bytes out of 1,351,680 sampled bytes (`max=255`). The classifier
reported the legacy code `FIRST_EFB_PASS_MUTATED`. Without a retained pre-pass
baseline, this proves nonzero output after the completed hardware pass, not a
before/after mutation. It does not assign output to one individual draw. Raw output:
`.omx/next/candidate-c-wgpu-first-efb-pass-1`.

The later direct-save classifier observes an earlier one-draw save-restore
pass whose source and output are correctly all zero. See
[the post-load restore classification](wgpu-post-load-restore-classification-2026-07-10.md).

The visible battle also rendered correctly after the legacy tick/show-image
paths stopped overwriting the WGPU-owned canvas. The earlier green/checker
output was therefore a competing presentation source, not evidence that the
GPU command stream never drew.

## Replay-pump A/B

Two runs per arm used the same core, save, duration, JIT-off setting, and
headed browser. These are descriptive means over two runs, not a statistical
qualification.

| Pump | Run | Game speed % | Core FPS | Presentation FPS | p95 interval ms | Backlog high-water | Errors |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Off | `pump0-r1` | 68.71 | 41.00 | 20.12 | 48.7 | 58,799 | 0 |
| Off | `pump0-r2` | 65.53 | 39.59 | 19.24 | 51.7 | 58,902 | 0 |
| On | `pump1-r1` | 69.00 | 41.47 | 30.76 | 32.4 | 16,384 | 0 |
| On | `pump1-r2` | 67.41 | 40.35 | 29.12 | 33.3 | 16,384 | 0 |
| Off mean | — | 67.12 | — | 19.68 | 50.20 | 58,850.5 | 0 |
| On mean | — | 68.205 | — | 29.94 | 32.85 | 16,384 | 0 |

The pump reduced backlog high-water by 72.16%, raised submitted presentation
cadence by 52.13%, and reduced the p95 submission interval by 34.56%. Mean game
speed changed by only +1.085 percentage points. This supports enabling the
bounded 16,384-record replay window for the real WGPU backend, with
`wgpupump=0` retained as rollback. It improves replay age/cadence; it does not
remove the underlying replay cost or deliver full speed.

Raw directories are under `.omx/next/wgpu-pump-ab/`.

## GPU completion and input-to-visible

The valid input run enabled `gpucomplete=1&inputlatency=1`. Six scripted A
button state changes were all observed by the core and followed by a distinct
mapped WGPU backbuffer frame. No input was superseded, replay errors were zero,
and audio underruns were zero.

| Measurement | Result |
| --- | ---: |
| Input transport average | 1.17 ms |
| Host-to-core-poll average / p95 | 67.17 / 268 ms |
| Host-to-next-distinct-GPU-frame average / p95 / max | 67.17 / 268 / 268 ms |
| GPU completion samples | 97 of 2,910 submits |
| GPU completion average / p95 / max | 26.15 / 80.84 / 1,622.22 ms |

GPU completion is sampled and whole-run values include boot/save-load
transients. Input measurement is explicitly
`causalVisualAttribution: false`: it observes the next distinct GPU-readback
frame after the matching core poll, but cannot prove that the input caused the
pixel difference. Raw output: `.omx/next/wgpu-input-visible-2`.

An earlier attempt, `.omx/next/wgpu-input-visible-1`, is rejected. It copied a
swapchain texture configured without `COPY_SRC`, emitted validation errors, and
turned the canvas black. The context is now given `COPY_SRC` only when
classifier or input-readback diagnostics require it; that failed run supplies
no performance or latency result.

## Interpretation

- Game speed measures emulation progress.
- Presentation FPS here counts successful WGPU queue submissions.
- Unique visual FPS is not yet continuously sampled on WGPU; canvas hashes in
  the harness prove changing visible output but are not a 60 Hz unique-frame
  counter.
- The current experimental renderer is limited by both ~67% emulation speed
  with JIT off and expensive command replay. It is not presently a full-speed
  replacement for the software-hybrid default.

## Final atomic replay and stable-state diagnostic

The final `f7ce5672…` smoke supersedes the rejected run that logged three
`upload-stage-order` errors. The broad check incorrectly rejected retained
uploads belonging to a later incomplete suffix after an earlier pass was
consumed. The replacement is wrap-safe and still rejects an upload retained
from the consumed prefix.

The corrected smoke had zero replay errors, missing resources, drops, batch
aborts, oversize batches, upload timeouts, pass splits, and records outside a
pass. Pass begin/end counts were 10,925/10,925. The first completed 120-draw
EFB pass contained 182,949 nonzero color bytes; XFB and backbuffer samples were
also nonzero. It averaged 69.18% game speed, 41.76 core FPS, and 35.88
presentation FPS, with backlog high-water 62,737.

Three balanced `wgpustatecache=0/1`, `1/0`, `0/1` pairs then measured exact
producer-side state suppression:

| Arm mean | Game speed % | Presentation FPS | Commands/s | Commands/EFB draw | Backlog high-water | Drain total ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Cache off | 70.277 | 36.803 | 227,730 | 10.010 | 62,795 | 6,281.567 |
| Cache on | 69.960 | 36.237 | 137,206 | 6.063 | 38,543 | 6,069.530 |
| Change | −0.317 pp | −0.567 | −39.75% | −39.43% | −38.62% | −3.38% |

All six arms had zero replay/resource/atomicity failures and changing,
nonzero downstream output. Cache-on suppressed about 1.65 million records per
run, but did not improve cadence; median paired game-speed and presentation
changes were −0.77 points and −0.47 FPS. GPU p95 also worsened in two pairs.
`wgpustatecache` therefore remains default-off.

Five arms sampled a legitimate one-draw post-load EFB pass with all-zero
output, so this six-run set misses the strict first-pass classifier gate and
is not a performance promotion. The separate corrected smoke and third
cache-on arm produced nonzero completed-pass output. No arm retained a
pre-pass baseline, so neither result is before/after mutation proof.
