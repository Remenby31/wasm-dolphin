# Audio path and its switches

The core's mixer (Dolphin's `Mixer`, two granule FIFOs: DMA for sound effects
and voices, streaming for disc audio) is pulled by a producer in the worker
(`src/audio-pcm-producer.js`) into a shared ring that an AudioWorklet plays
(`src/audio-pcm-ring.js`, `src/audio-worklet-processor.js`).

## Rate control (`?audiorate`)

Without it, the latency the ring sheds (its target comes down from 120 ms to
its floor) and the catch-up after a slow stretch (a state load: the JIT wave
runs the core at 70-90 % for a few seconds) both go out through the mixer:
its queue overflows (an audible skip) or runs dry (a looped granule, a fill).

With it:

- the worklet plays the latency over its target up to `audioratemax` ppm
  faster (linear interpolation, slewed, a 4 ms dead band), a copy at 0 ppm;
- a pull never takes more than the shorter FIFO holds while the ring has
  20 ms, and the longer FIFO is pulled back before it overflows (patch 0216
  reports each FIFO's depth).

| switch | values | default |
|---|---|---|
| `?audiorate` | `1` on, `0` off | on under V8 (Chrome, Edge) and SpiderMonkey (Firefox); off under JavaScriptCore (Safari, iPhone, and Chrome, Edge or Firefox on iOS) and unknown engines. The engine is detected (`src/wasm-engine.js`); the test override `?wasmengine=v8` turns the rate control on as well |
| `?audioratemax` | 1000-10000 ppm | 10000 (+1 %, +17 cents) |

Measured on a Mac (drop-meter `--audio-trace`, 2026-11-03, per visit, skips /
fills / seconds over 100 ms of latency): 1P 61.5 / 168.8 / 18.0 -> 7.0 /
108.2 / 16.4; 2P 54.4 / 236.0 / 18.2 -> 5.2 / 184.5 / 16.8; in the race 0
skips, 0 fills, latency 75 ms (79 without). The fills left are the slow
seconds after a load, when the game makes less sound than is played.

Firefox (headless, `drop-meter --browser firefox`, state loaded at +6 s,
6 + 6, warm visit): 215.8 / 292.2 / 16.1 -> 2.2 / 11.0 / 12.7; in the race 61
skips and 82 fills -> 0.8 and 1.5, latency 69 ms (75 without). Without it,
Firefox skips even in the race (the cause not investigated).

TODO before turning it on elsewhere: Safari on a Mac and an iPhone (the
worklet runs only at 48 kHz under JavaScriptCore), each an A/B with
`--audio-trace`.

## Other switches

| switch | what |
|---|---|
| `?audiotransport=legacy` | scheduled buffers instead of the AudioWorklet |
| `?audiolead=S` | the ring's floor, seconds (0.02-0.12 on the worklet path; 40 ms default) |
| `?audiobuffer=MS` | the mixer's AudioBufferSize (16-200; 40 ms with the worklet, else the core's 80) |

Diagnostics: `validationAudioTrace` (harness) records the producer every
100 ms (ring target and fill, each FIFO's depth, skips, fills, pulls, rate);
`validationReadAudioQueue` the mixer's skips and fills, the throttle trim and
the VI phase lock.
