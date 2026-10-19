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
  10-14 rendered frames per second: speed and game fps must be read together.
- The GPU side weighs about 4 points on this Mac (presentation scale 0.25
  vs 1; the internal resolution is native-only in this build).

Browser single-core benchmark (`harness/probes/cpu-bench/cpu-bench.mjs`, a
deterministic interpreter loop in WASM and JS, same checksum): P-cores
444-453 Mops/s (WASM), E-cores (`taskpolicy -b`, every Chrome thread at
background QoS) 116-122 Mops/s, a ratio of 0.26.

## Model

Speed is projected in proportion to Geekbench 6 single-core score,
calibrated on the Mac: 77 % at 3299 (M4 Pro Mac mini, Geekbench Browser
average). The range is ±20 % for what one score does not capture (memory,
browser engine, thermals, power plan), capped at 100 % (the emulator never
runs the game faster than the console). Classes: **real time** if even the
low end reaches 95 %, **playable** if the middle reaches 60 %, **slow**
otherwise (`harness/lib/consumer.mjs`, unit-tested).

| Machine class | GB6 single-core | Projected speed | Class |
|---|---|---|---|
| Chromebook, Intel Celeron N4500 | ~480 | 9-13 % | slow |
| Chromebook, MediaTek Kompanio 520 | ~410 (16 % below the N4500) | 8-11 % | slow |
| 2020 laptop, Intel Core i5-1135G7 | ~1783 | 33-50 % | slow |
| 2022 laptop, AMD Ryzen 5 6600U / 6600H | ~1977 / ~2002 | 37-56 % | slow |
| Intel iGPU laptop, Core i5-1235U (Iris Xe) | ~2095 | 39-59 % | slow |
| Reference: Apple M4 Pro | 3299 | 62-92 % (measured 77 %) | playable |

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
- **Scores are approximate.** Geekbench Browser, cpu-monkey and Notebookcheck
  refuse automated fetches; the figures below come from their pages as
  summarised by a web search, and each class mixes many laptops (the same
  i5-1135G7 differs by up to 60 % between chassis).
- The Mac runs were on a loaded machine (other agents): ±3 points.

## Sources

- Apple M4 Pro, Mac mini (2024): Geekbench 6 single-core 3,299 (average of
  293 results), [Geekbench Browser](https://browser.geekbench.com/macs/mac-mini-2024-14c-cpu).
- Intel Core i5-1135G7: ~1,783 (775 samples),
  [cpu-monkey](https://www.cpu-monkey.com/en/benchmark-intel_core_i5_1135g7-geekbench_6_single_core),
  [Geekbench Browser](https://browser.geekbench.com/processors/intel-core-i5-1135g7).
- AMD Ryzen 5 6600H ~2,002, 6600U ~1,977,
  [cpu-monkey](https://www.cpu-monkey.com/en/benchmark-amd_ryzen_5_6600h-geekbench_6_single_core),
  [Geekbench Browser](https://browser.geekbench.com/processors/amd-ryzen-5-6600u).
- Intel Core i5-1235U: ~2,095,
  [LaptopMedia](https://laptopmedia.com/processor/intel-core-i5-1235u/).
- Intel Celeron N4500: ~480,
  [cpu-monkey](https://www.cpu-monkey.com/en/benchmark-intel_celeron_n4500-geekbench_6_single_core);
  MediaTek Kompanio 520 about 16 % below it in single core,
  [cpu-monkey](https://www.cpu-monkey.com/en/compare_cpu-mediatek_kompanio_520_mt8186-vs-intel_celeron_n4500).

## Redo it

```sh
node harness/probes/race-perf.mjs --iso <disc> --state <race.sav> --port N --runs 4
node harness/probes/cpu-bench/cpu-bench.mjs
HARNESS_CHROME_PATH=harness/probes/chrome-ecores.sh node harness/probes/cpu-bench/cpu-bench.mjs
```

On a real consumer machine, `harness/probes/consumer-perf.mjs`
(`docs/consumer-perf.md`) measures directly and replaces the projection.
