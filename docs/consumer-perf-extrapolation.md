# Race speed on consumer machines, extrapolated from one Mac (P9)

No third-party machine was used (operator's decision). The local race was
measured on the development Mac, headless, in a MEASURE slot under the perf
lock, and projected onto typical machine classes from their published
single-core scores. To be redone after P4 (JIT regions) with the same
commands; the table below describes main at `6dd107ed` (2026-10-19).

## Measured on the Mac (Apple M4 Pro, Chrome 155)

| | Speed | Game fps | Emulated CPU thread |
|---|---|---|---|
| WebGPU renderer, P-cores | 77 % | ~50 | 99 % (saturated) |
| Software renderer, P-cores | 100 % | 10-12 | 69 % |
| WebGPU, presentation scale 0.25 / 1 | 79 % / 75 % | 47-50 | 99 % |

- `harness/probes/race-perf.mjs`, `speed=1`, 2 runs of 20 s after 25 s in
  the race, load 4-9 (other agents): ±3 points between runs.
- With the WebGPU renderer the emulated CPU thread is saturated: speed
  follows that thread, that is single-core performance.
- The software renderer reaches full speed only because the game drops to
  10-12 rendered frames per second: speed and game fps must be read together.
- The GPU side weighs about 4 points on this Mac (presentation scale 0.25
  vs 1; the internal resolution is native-only in this build).

Browser single-core benchmark (`harness/probes/cpu-bench/cpu-bench.mjs`, a
deterministic interpreter loop in WASM and JS, same checksum): P-cores
444-453 Mops/s (WASM), E-cores (`taskpolicy -b`, every Chrome thread at
background QoS) 116-122 Mops/s, a ratio of 0.26.

## Model

Speed is projected in proportion to the Geekbench 6 single-core score,
calibrated on the Mac: 77 % at 3940, the M4 Pro's score on cpu-monkey, the
source of every other score below (Geekbench Browser's own average for the
Mac mini is 3299: calibrating there would raise every projection by about
19 %). The range is ±20 % for what one score does not capture (memory,
browser engine, thermals, power plan), capped at 100 % (the emulator never
runs the game faster than the console). The class is that of the middle of
the range: **real time** from 95 % (the game keeps the console's pace),
**playable** from 60 % (slower than the console, still a game), **slow**
below (`harness/lib/consumer.mjs`, unit-tested; a test checks this table
against it).

| Machine class | GB6 single-core | Projected speed | Middle | Class |
|---|---|---|---|---|
| Chromebook, Intel Celeron N4500 | ~480 | 8-11 % | 9 % | slow |
| Chromebook, MediaTek Kompanio 520 | ~633 | 10-15 % | 12 % | slow |
| 2020 laptop, Intel Core i5-1135G7 | ~1783 | 28-42 % | 35 % | slow |
| 2022 laptop, AMD Ryzen 5 6600U | ~1977 | 31-46 % | 39 % | slow |
| 2022 laptop, AMD Ryzen 5 6600H | ~2002 | 31-47 % | 39 % | slow |
| Intel iGPU laptop, Core i5-1235U (Iris Xe) | ~2095 | 33-49 % | 41 % | slow |
| Reference: Apple M4 Pro (measured 77 %) | ~3940 | 62-92 % | 77 % | playable |

At these speeds the game itself slows down; with the software renderer it
keeps time but renders few frames. On today's main, no consumer class plays
this race in real time: the emulated CPU path (P1, P4) is the lever, not the
GPU.

## Limits

- **One calibration point.** The E-core profile was meant as the second:
  confined to background QoS, the race degenerates (0 game fps, the busiest
  thread at 30-70 %, "speed" above 100 %) instead of slowing down, so it is
  not a stand-in for a slow laptop. The 0.26 benchmark ratio checks the
  benchmark, not the race. Proportionality to single-core score is a
  hypothesis that the CPU-bound profile supports, not a measurement.
- **The GPU side was measured on Apple's GPU only.** On an Intel iGPU or a
  Chromebook it may weigh more than 4 points; WebGPU itself may be missing
  or a fallback adapter there (then the software renderer runs:
  `consumer-perf.mjs` detects it).
- **Scores are approximate.** cpu-monkey, Geekbench Browser and Notebookcheck
  refuse automated fetches; the figures come from their pages as summarised
  by a web search and from the review of this document, and each class mixes
  many laptops (the same i5-1135G7 differs by up to 60 % between chassis).
  One source for all of them (cpu-monkey), except the i5-1235U (LaptopMedia).
- The Mac runs were on a loaded machine (other agents): ±3 points.

## Sources

Geekbench 6 single-core, cpu-monkey unless stated:

- Apple M4 Pro: ~3,940 (cpu-monkey); for comparison, Geekbench Browser's
  average for the Mac mini (2024) is 3,299 (293 results),
  [Geekbench Browser](https://browser.geekbench.com/macs/mac-mini-2024-14c-cpu).
- Intel Core i5-1135G7: ~1,783,
  [cpu-monkey](https://www.cpu-monkey.com/en/benchmark-intel_core_i5_1135g7-geekbench_6_single_core).
- AMD Ryzen 5 6600H ~2,002, 6600U ~1,977,
  [cpu-monkey](https://www.cpu-monkey.com/en/benchmark-amd_ryzen_5_6600h-geekbench_6_single_core).
- Intel Core i5-1235U: ~2,095,
  [LaptopMedia](https://laptopmedia.com/processor/intel-core-i5-1235u/).
- Intel Celeron N4500: ~480,
  [cpu-monkey](https://www.cpu-monkey.com/en/benchmark-intel_celeron_n4500-geekbench_6_single_core).
- MediaTek Kompanio 520: ~633,
  [cpu-monkey](https://www.cpu-monkey.com/en/compare_cpu-mediatek_kompanio_520_mt8186-vs-intel_celeron_n4500);
  655 in [MediaTek's benchmark sheet](https://i.mediatek.com/hubfs/MediaTek%20Kompanio%20520%20528%20838%20Benchmarking_0624.pdf).

## Redo it

```sh
node harness/probes/race-perf.mjs --iso <disc> --state <race.sav> --port N --runs 4
node harness/probes/cpu-bench/cpu-bench.mjs
HARNESS_CHROME_PATH=harness/probes/chrome-ecores.sh node harness/probes/cpu-bench/cpu-bench.mjs
```

On a real consumer machine, `harness/probes/consumer-perf.mjs`
(`docs/consumer-perf.md`) measures directly and replaces the projection.
