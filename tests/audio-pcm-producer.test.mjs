import test from "node:test";
import assert from "node:assert/strict";
import {
  AUDIO_PCM_HEADER,
  AUDIO_PCM_STATE_PREFILL,
  AUDIO_PCM_STATE_RUNNING,
  audioPcmAvailableFrames,
  createAudioPcmRing,
  consumeAudioPcm,
  mixerQueueMicroseconds,
  snapshotAudioPcmRing,
  writeAudioPcm,
} from "../src/audio-pcm-ring.js";
import {
  AUDIO_PCM_TARGET_FRAMES,
  AudioPcmProducer,
} from "../src/audio-pcm-producer.js";

function fixture() {
  const heapU8 = new Uint8Array(32768);
  const heap16 = new Int16Array(heapU8.buffer);
  let mixes = 0;
  const core = {
    heapU8,
    audioSampleRate: () => 48000,
    audioChannels: () => 2,
    audioBufferFrames: () => 4096,
    audioBuffer: () => 1024,
    mixAudio(frames) {
      mixes += 1;
      heap16.fill(mixes, 512, 512 + frames * 2);
      return frames;
    },
  };
  const producer = new AudioPcmProducer({ api: () => core, setTimer: () => 1, clearTimer() {} });
  return { producer, core, get mixes() { return mixes; } };
}

test("producer waits for epoch acknowledgement then fills to bounded target", () => {
  const ring = createAudioPcmRing();
  const f = fixture();
  assert.equal(f.producer.install(ring.sab, { muted: false }).active, true);
  assert.equal(f.producer.refill(), 0);
  assert.equal(f.mixes, 0);
  const left = new Float32Array(128);
  consumeAudioPcm(ring, left, new Float32Array(128));
  assert.equal(f.producer.refill(), AUDIO_PCM_TARGET_FRAMES);
  assert.equal(Atomics.load(ring.header, AUDIO_PCM_HEADER.STATE), AUDIO_PCM_STATE_RUNNING);
  assert.equal(f.producer.telemetry().workletRing.fillFrames, AUDIO_PCM_TARGET_FRAMES);
});

test("load transition excludes stale samples until a new ack", () => {
  const ring = createAudioPcmRing();
  const f = fixture();
  f.producer.install(ring.sab, { muted: false });
  consumeAudioPcm(ring, new Float32Array(1), new Float32Array(1));
  f.producer.refill();
  f.producer.transition();
  assert.equal(Atomics.load(ring.header, AUDIO_PCM_HEADER.STATE), AUDIO_PCM_STATE_PREFILL);
  assert.equal(f.producer.refill(), 0);
  const left = new Float32Array(16).fill(1);
  consumeAudioPcm(ring, left, new Float32Array(16).fill(1));
  assert.deepEqual([...left], new Array(16).fill(0));
  assert.equal(f.producer.refill(), AUDIO_PCM_TARGET_FRAMES);
});

test("producer rejects malformed header metadata and non-48k core", () => {
  const ring = createAudioPcmRing();
  Atomics.store(ring.header, AUDIO_PCM_HEADER.CAPACITY_FRAMES, 4096);
  const f = fixture();
  assert.match(f.producer.install(ring.sab).reason, /capacity/);
  const valid = createAudioPcmRing();
  f.core.audioSampleRate = () => 44100;
  assert.equal(f.producer.install(valid.sab).reason, "core-sample-rate");
});

// A lower ring target (?audiolead on the AudioWorklet path) is a floor: the
// ring starts at 120 ms (a cold boot keeps the producer's worker busy: a
// 40 ms ring underran ~100 times in its first 6 s), comes down 10 ms a
// second once calm for 5 s, and goes up 20 ms at each underrun.
test("adaptive ring: starts at 120 ms, comes down to the page's floor when calm, back up on an underrun", async () => {
  const { ADAPT_CALM_MS } = await import("../src/audio-pcm-producer.js");
  const ring = createAudioPcmRing();
  const f = fixture();
  assert.equal(f.producer.install(ring.sab, { muted: false, targetFrames: 1920 }).active, true);
  assert.equal(f.producer.telemetry().targetFrames, AUDIO_PCM_TARGET_FRAMES);
  assert.equal(f.producer.telemetry().floorFrames, 1920);
  consumeAudioPcm(ring, new Float32Array(1), new Float32Array(1));
  assert.equal(f.producer.refill(), AUDIO_PCM_TARGET_FRAMES, "120 ms at first");
  assert.equal(Atomics.load(ring.header, AUDIO_PCM_HEADER.STATE), AUDIO_PCM_STATE_RUNNING, "playback from half the floor");
  // calm: 0.5 % of the time (240 frames a second) after 5 s, down to the floor
  let t = 1000;
  f.producer.adapt(t);
  t += ADAPT_CALM_MS;
  f.producer.adapt(t);
  assert.equal(f.producer.telemetry().targetFrames, AUDIO_PCM_TARGET_FRAMES, "not before 5 s of calm");
  t += 1000;
  f.producer.adapt(t);
  assert.equal(f.producer.telemetry().targetFrames, AUDIO_PCM_TARGET_FRAMES - 240);
  for (let i = 0; i < 30; i++) { t += 1000; f.producer.adapt(t); }
  assert.equal(f.producer.telemetry().targetFrames, 1920, "never under the floor");
  // an underrun: +20 ms, and the calm starts over
  Atomics.add(ring.header, AUDIO_PCM_HEADER.UNDERRUN_EVENTS, 1);
  f.producer.adapt(t += 10);
  assert.equal(f.producer.telemetry().targetFrames, 1920 + 960);
  f.producer.adapt(t += 1000);
  assert.equal(f.producer.telemetry().targetFrames, 1920 + 960, "no step down before 5 s of calm");
  // a late timer (over half the target) restarts the calm without raising
  f.producer.adapt(t += ADAPT_CALM_MS - 1000, 100);
  assert.equal(f.producer.telemetry().targetFrames, 1920 + 960);
  // the page asks 120 ms (or nothing): no adaptation
  const f2 = fixture(), r2 = createAudioPcmRing();
  f2.producer.install(r2.sab, { muted: false });
  f2.producer.adapt(1); f2.producer.adapt(1 + 10 * ADAPT_CALM_MS);
  assert.equal(f2.producer.telemetry().targetFrames, AUDIO_PCM_TARGET_FRAMES);
  // bounds of the floor
  const f3 = fixture(), r3 = createAudioPcmRing();
  f3.producer.install(r3.sab, { muted: false, targetFrames: 10 });
  assert.equal(f3.producer.telemetry().floorFrames, 480);
});

// 0186: the producer publishes the core mixer's queue in the ring's header,
// in µs; -1 while unknown (a core without the export, or before the boot).
test("the mixer's queue reaches the ring header; unknown is -1 (null in the snapshot)", () => {
  const ring = createAudioPcmRing();
  assert.equal(snapshotAudioPcmRing(ring).mixerQueueMs, null, "unknown before any refill");
  const f = fixture();
  f.producer.install(ring.sab, { muted: false });
  consumeAudioPcm(ring, new Float32Array(128), new Float32Array(128));
  f.producer.refill();
  assert.equal(snapshotAudioPcmRing(ring).mixerQueueMs, null, "a core without audioQueuedMs");
  f.core.audioQueuedMs = () => 42.667;
  f.producer.refill();
  assert.equal(Atomics.load(ring.header, AUDIO_PCM_HEADER.MIXER_QUEUE_US), 42667);
  assert.equal(snapshotAudioPcmRing(ring).mixerQueueMs, 42.667);
  f.core.audioQueuedMs = () => -1; // before the boot
  f.producer.refill();
  assert.equal(snapshotAudioPcmRing(ring).mixerQueueMs, null);
});

// Review of #316: muted, or a transition not yet acknowledged, the producer
// does not pull: the mixer's queue is unknown, not the last value read.
test("refill's early exits mark the mixer's queue unknown", () => {
  const ring = createAudioPcmRing();
  const f = fixture();
  f.core.audioQueuedMs = () => 80;
  f.producer.install(ring.sab, { muted: false });
  consumeAudioPcm(ring, new Float32Array(128), new Float32Array(128));
  f.producer.refill();
  assert.equal(snapshotAudioPcmRing(ring).mixerQueueMs, 80);
  f.producer.setMuted(true);
  f.producer.refill();
  assert.equal(snapshotAudioPcmRing(ring).mixerQueueMs, null, "muted");
  f.producer.setMuted(false);
  consumeAudioPcm(ring, new Float32Array(128), new Float32Array(128));
  f.producer.refill();
  assert.equal(snapshotAudioPcmRing(ring).mixerQueueMs, 80);
  f.producer.transition(); // a state load: epoch not acknowledged yet
  f.producer.refill();
  assert.equal(snapshotAudioPcmRing(ring).mixerQueueMs, null, "epoch not acknowledged");
});

// Review of #316: 0186's arithmetic, the same expression as the patch.
test("0186's queue time: 4,000 µs a granule for the 32 kHz DMA FIFO, 2,666 at 48 kHz", async () => {
  const dividend = 108000000; // Mixer::FIXED_SAMPLE_RATE_DIVIDEND
  assert.equal(mixerQueueMicroseconds(1, dividend / 32000, dividend), 4000);
  assert.equal(mixerQueueMicroseconds(20, dividend / 32000, dividend), 80000, "AudioBufferSize 80 ms: 20 granules");
  assert.equal(mixerQueueMicroseconds(1, dividend / 48000, dividend), 2666);
  assert.equal(mixerQueueMicroseconds(255, dividend / 32000, dividend), 1020000, "the queue's mask, no overflow");
  assert.equal(mixerQueueMicroseconds(5, 3375, 0), 0, "no dividend: 0");
  const { readFile } = await import("node:fs/promises");
  const patch = await readFile(new URL("../patches/dolphin-wasm/snapshot/0186-mixer-queue-depth.patch", import.meta.url), "utf8");
  assert.match(patch, /granules \* \(GRANULE_SIZE \/ 2\) \* divisor \* 1000000 \/ m_input_sample_rate_dividend/);
  assert.match(patch, /\(head - tail\) & GRANULE_QUEUE_MASK/);
  // without a mixer (or before the boot) the export says -1
  const core = await readFile(new URL("../core/upstream/dolphin_web_core.cpp", import.meta.url), "utf8");
  const fn = core.slice(core.indexOf("double DolphinWeb_AudioQueuedMs()"));
  assert.match(fn.slice(0, fn.indexOf("\n}\n")), /if \(!s_runtime_initialized\)\n\s*return -1;[\s\S]*: -1;/);
});

test("trace: off until started, one sample per period with the pulls since the last, skips and fills from the core, drained", () => {
  const ring = createAudioPcmRing();
  const f = fixture();
  let skips = 3, fills = 7;
  f.core.audioQueueEvents = (which) => (which === 0 ? skips : fills);
  f.core.audioQueuedMs = () => 12.34;
  f.producer.install(ring.sab, { muted: false, targetFrames: 1920 });
  consumeAudioPcm(ring, new Float32Array(1), new Float32Array(1));
  // not started: nothing recorded
  f.producer.traceTick(0);
  assert.deepEqual(f.producer.traceDrain(), { samples: [], lost: 0, active: false });
  assert.deepEqual(f.producer.traceStart({ everyMs: 100, max: 2 }), { started: true, everyMs: 100, max: 2 });
  f.producer.refill(1);
  f.producer.traceTick(1000);
  f.producer.traceTick(1050); // within the period: no sample
  skips = 5;
  f.producer.traceTick(1100);
  f.producer.traceTick(1200);
  const out = f.producer.traceDrain();
  assert.equal(out.samples.length, 2, "max 2 kept");
  assert.equal(out.lost, 1);
  const [a, b] = out.samples;
  assert.equal(a.skips, 5);
  assert.equal(a.fills, 7);
  assert.equal(a.mixerMs, 12.3);
  assert.equal(a.target, AUDIO_PCM_TARGET_FRAMES);
  assert.equal(a.floor, 1920);
  assert.equal(b.asked, 0, "pulls counted since the previous sample");
  assert.deepEqual(f.producer.traceDrain({ stop: true }).samples, []);
  assert.equal(f.producer.trace, null);
});

test("trace: a pull's frames, its size and an empty mix land in the next sample", () => {
  const ring = createAudioPcmRing();
  const f = fixture();
  f.producer.install(ring.sab, { muted: false });
  consumeAudioPcm(ring, new Float32Array(1), new Float32Array(1));
  f.producer.traceStart({ everyMs: 100 });
  f.producer.refill(1);
  f.producer.traceTick(0);
  const [s] = f.producer.traceDrain().samples;
  assert.equal(s.pulls, 1);
  assert.equal(s.asked, Math.min(4096, AUDIO_PCM_TARGET_FRAMES));
  assert.equal(s.got, s.asked);
  assert.equal(s.maxPull, s.asked);
  assert.equal(s.empty, 0);
  assert.equal(s.skips, null, "a core without patch 0212");
});

test("worker: validationAudioTrace is harness-gated and reaches the producer; the producer reads the core's queue events", async () => {
  const { readFile } = await import("node:fs/promises");
  const worker = await readFile(new URL("../src/upstream-discio-worker.js", import.meta.url), "utf8");
  assert.match(worker, /case "validationAudioTrace":\n\s+\/\/[^\n]*\n\s+if \(!harnessEnabled\) return \{ error: "harness hooks are off" \};/);
  assert.match(worker, /audioQueueEvents: api\?\.audioQueueEvents,\n\s+audioQueuedFifoMs: api\?\.audioQueuedFifoMs,\n\s+heapU8: moduleInstance\?\.HEAPU8,/);
});

// ---- ?audiorate=1: rate control ----
import { AUDIO_PCM_MAX_RATE_PPM } from "../src/audio-pcm-ring.js";
import { RATE_SLEW_PPM } from "../src/audio-pcm-producer.js";

test("consumer: at 0 ppm the plain copy; at +5000 ppm 0.5 % more input per output, interpolated, the fraction carried then dropped", () => {
  const ring = createAudioPcmRing();
  const fill = (n, f = (i) => i) => {
    const src = new Int16Array(n * 2);
    for (let i = 0; i < n; i += 1) { src[2 * i] = f(i); src[2 * i + 1] = -f(i); }
    return writeAudioPcm(ring, src, n, 2);
  };
  Atomics.store(ring.header, AUDIO_PCM_HEADER.STATE, AUDIO_PCM_STATE_RUNNING);
  fill(4000);
  const L = new Float32Array(1000), R = new Float32Array(1000), res = {};
  consumeAudioPcm(ring, L, R, 1000, res);
  assert.equal(res.consumedFrames, 1000);
  assert.equal(L[999] * 32768, 999, "plain copy");
  Atomics.store(ring.header, AUDIO_PCM_HEADER.RATE_PPM, AUDIO_PCM_MAX_RATE_PPM);
  consumeAudioPcm(ring, L, R, 1000, res);
  assert.equal(res.consumedFrames, 1005);
  assert.ok(Math.abs(L[500] * 32768 - (1000 + 500 * 1.005)) < 1e-6, `${L[500] * 32768}`);
  assert.ok(Math.abs(R[500] * 32768 + (1000 + 500 * 1.005)) < 1e-6);
  const snap = snapshotAudioPcmRing(ring);
  assert.equal(snap.resampledFrames, 1000);
  assert.equal(snap.resampleExtraFrames, 5);
  // back to 0: the fraction is dropped, the plain copy resumes
  Atomics.store(ring.header, AUDIO_PCM_HEADER.RATE_PPM, 0);
  consumeAudioPcm(ring, L, R, 10, res);
  assert.equal(res.frac, 0);
  assert.equal(L[0] * 32768, 2005);
  // a rate over the ceiling (+1 %) is held at it
  Atomics.store(ring.header, AUDIO_PCM_HEADER.RATE_PPM, 99999);
  consumeAudioPcm(ring, L, R, 1000, res);
  assert.equal(res.consumedFrames, 1010);
});

test("producer rate: proportional to the latency's excess (ring and mixer) over the target, smoothed, a dead band, bounded, slewed", () => {
  const ring = createAudioPcmRing();
  const f = fixture();
  f.producer.install(ring.sab, { muted: false, rateControl: true });
  const setFill = (frames) => { Atomics.store(ring.header, AUDIO_PCM_HEADER.READ_INDEX, 0); Atomics.store(ring.header, AUDIO_PCM_HEADER.WRITE_INDEX, frames); };
  f.producer.targetFrames = 1920;
  setFill(1920 + 48); // 1 ms over: inside the dead band
  f.producer.rate();
  assert.equal(f.producer.ratePpm, 0);
  setFill(1920 + 48 * 40); // 40 ms over: the bound, reached by slew
  for (let i = 0; i < 3; i += 1) f.producer.rate();
  assert.ok(f.producer.ratePpm > 0 && f.producer.ratePpm <= 3 * RATE_SLEW_PPM, "slewed up, smoothed");
  for (let i = 0; i < 100; i += 1) f.producer.rate();
  assert.equal(f.producer.ratePpm, AUDIO_PCM_MAX_RATE_PPM);
  assert.equal(Atomics.load(ring.header, AUDIO_PCM_HEADER.RATE_PPM), AUDIO_PCM_MAX_RATE_PPM);
  setFill(1920);
  let prev = f.producer.ratePpm, steps = 0;
  while (f.producer.ratePpm > 0 && steps < 1000) {
    f.producer.rate();
    assert.ok(prev - f.producer.ratePpm <= RATE_SLEW_PPM, "down by slew, no step");
    prev = f.producer.ratePpm;
    steps += 1;
  }
  assert.equal(f.producer.ratePpm, 0, "back to 0 at the target");
  // the mixer's queue counts: a full mixer with the ring at its target is
  // latency over the target too
  f.core.audioQueuedMs = () => 40;
  for (let i = 0; i < 200; i += 1) f.producer.rate();
  assert.ok(f.producer.ratePpm > 0);
  // off: never written
  const g = fixture();
  const ring2 = createAudioPcmRing();
  g.producer.install(ring2.sab, { muted: false });
  g.producer.timerTick();
  assert.equal(Atomics.load(ring2.header, AUDIO_PCM_HEADER.RATE_PPM), 0);
  assert.equal(g.producer.rateControl, false);
});

test("producer mixer bounds: never more than the queue holds while the ring has slack; the queue pulled back down once high", () => {
  const ring = createAudioPcmRing();
  const f = fixture();
  let queued = 20;
  f.core.audioQueuedMs = () => queued;
  f.producer.install(ring.sab, { muted: false, rateControl: true });
  // ring at 60 ms: at most the queue less a granule (16 ms), at least down to 8 ms (12 ms)
  assert.deepEqual(f.producer.mixerBounds(f.core, 60 * 48), { maxFrames: 16 * 48, minFrames: 12 * 48 });
  // ring nearly empty: the mixer may loop (no cap)
  assert.equal(f.producer.mixerBounds(f.core, 10 * 48).maxFrames, Infinity);
  // low queue: nothing forced
  queued = 10;
  assert.equal(f.producer.mixerBounds(f.core, 60 * 48).minFrames, 0);
  // a pull at the ring's target takes the forced part, counted as surplus
  queued = 30;
  consumeAudioPcm(ring, new Float32Array(1), new Float32Array(1));
  Atomics.store(ring.header, AUDIO_PCM_HEADER.WRITE_INDEX, 60 * 48);
  f.producer.targetFrames = 60 * 48;
  f.producer.refill(1);
  assert.equal(snapshotAudioPcmRing(ring).producerSurplusFrames, 22 * 48);
  // off, or a core without 0186: no bounds
  const g = fixture();
  g.producer.install(createAudioPcmRing().sab, { muted: false });
  assert.equal(g.producer.mixerBounds(g.core, 0), null);
});

// A model of the mixer (Mixer::MixerFifo): a queue of input in ms, capped at
// AudioBufferSize; a pull over the cap jumps back to half (an overflow skip),
// a pull from an empty queue loops (an underrun fill). The core produces at
// `speed` of real time; the worklet consumes 128 frames every 2.67 ms; the
// producer ticks every 10 ms.
function simulate({ rateControl, speedAt, seconds = 30, capMs = 40, rateMaxPpm, trackOverMs = 100, lateTicks = false }) {
  const ring = createAudioPcmRing();
  const heapU8 = new Uint8Array(65536);
  let queueMs = 20, skips = 0, fills = 0;
  const core = {
    heapU8, audioSampleRate: () => 48000, audioChannels: () => 2, audioBufferFrames: () => 4096, audioBuffer: () => 1024,
    audioQueuedMs: () => queueMs,
    mixAudio(frames) {
      // per granule of 4 ms: overflow check, then take it (or loop when empty)
      let left = frames / 48;
      while (left > 0) {
        if (queueMs > capMs) { skips += 1; queueMs = capMs / 2 + 4; }
        const take = Math.min(4, left);
        if (queueMs < take) { fills += 1; queueMs += capMs / 2 - 4; }
        queueMs -= take;
        left -= take;
      }
      return frames;
    },
  };
  const producer = new AudioPcmProducer({ api: () => core, setTimer: () => 1, clearTimer() {} });
  producer.install(ring.sab, { muted: false, targetFrames: 1920, rateControl, rateMaxPpm });
  const L = new Float32Array(128), R = new Float32Array(128), res = {};
  consumeAudioPcm(ring, L, R, 128, res); // ack the epoch
  let now = 0, nextTick = 0, nextQuantum = 0, overMs = 0, ticks = 0;
  const realNow = performance.now;
  try {
    while (now < seconds * 1000) {
      const dt = 0.5;
      queueMs += speedAt(now) * dt;
      if (now >= nextQuantum) { consumeAudioPcm(ring, L, R, 128, res); nextQuantum += 128 / 48; }
      // lateTicks: a busy worker, every third tick 25 ms late in the first 25 s
      if (now >= nextTick) { performance.now = () => now; producer.timerTick(); ticks += 1; nextTick += lateTicks && now < 25000 && ticks % 3 === 0 ? 25 : 10; }
      if (audioPcmAvailableFrames(ring.header) / 48 + queueMs > trackOverMs) overMs += dt;
      now += dt;
    }
  } finally { performance.now = realNow; }
  const snap = snapshotAudioPcmRing(ring);
  return { skips, fills, overMs, underruns: snap.underrunEvents, fillMs: snap.fillFrames / 48, targetMs: producer.targetFrames / 48, resampledMs: snap.resampledFrames / 48, surplusMs: snap.producerSurplusFrames / 48 };
}

test("model of the load: a 3 s slow core then a catch-up, and the ring's descent: rate control removes the mixer skips", () => {
  const speedAt = (t) => (t < 3000 ? 0.75 : t < 4000 ? 1.14 : 1);
  const off = simulate({ rateControl: false, speedAt });
  const on = simulate({ rateControl: true, speedAt });
  // off: the mixer skips during the catch-up and the 120 -> 40 ms descent
  assert.ok(off.skips >= 10, JSON.stringify(off));
  // on: the catch-up goes into the ring, the excess is played up to 0.5 %
  // faster, the mixer is never over-pulled while the ring has slack
  assert.ok(on.skips <= off.skips / 2, JSON.stringify({ on, off }));
  assert.ok(on.fills <= off.fills, JSON.stringify({ on, off }));
  assert.ok(on.resampledMs > 0 && on.surplusMs > 0, JSON.stringify(on));
  // and the latency comes down to the floor within the 30 s
  assert.ok(on.fillMs < on.targetMs + 10 && on.targetMs <= 41, JSON.stringify(on));
  // a busy worker (late ticks): what the first real run showed, skips with
  // fills off; on, the mixer kept low absorbs a 25 ms tick
  const offLate = simulate({ rateControl: false, speedAt, lateTicks: true });
  const onLate = simulate({ rateControl: true, speedAt, lateTicks: true });
  assert.ok(onLate.skips <= Math.max(1, offLate.skips / 4) && onLate.fills <= offLate.fills, JSON.stringify({ onLate, offLate }));
});

test("plumbing: ?audiorate and ?audioratemax reach the producer", async () => {
  const { readFile } = await import("node:fs/promises");
  const read = (p) => readFile(new URL(p, import.meta.url), "utf8");
  const [audio, adapter, worker] = await Promise.all([read("../src/audio.js"), read("../src/upstream-worker-adapter.js"), read("../src/upstream-discio-worker.js")]);
  assert.equal(audio.match(/rateControl: this\.workletRateControl/g).length, 3);
  assert.equal(audio.match(/rateMaxPpm: this\.workletRateMaxPpm/g).length, 3);
  assert.match(adapter, /rateMaxPpm: Number\(rateMaxPpm\) \|\| 5000,/);
  assert.match(worker, /rateMaxPpm: Number\(payload\.rateMaxPpm\) \|\| undefined,/);
  assert.match(adapter, /async configureAudioWorklet\(\{ enabled, muted, sab, targetFrames, rateControl = false, rateMaxPpm = 5000 \}\)/);
  assert.match(adapter, /rateControl: Boolean\(rateControl\),/);
  assert.match(worker, /rateControl: Boolean\(payload\.rateControl\),\n\s+rateMaxPpm: Number\(payload\.rateMaxPpm\) \|\| undefined,/);
  assert.doesNotMatch(worker, /mixerCapMs/);
});

test("rate bound: 0.5 % by default, up to the 1 % ceiling when asked, never above", () => {
  const ring = createAudioPcmRing();
  const mk = (opts) => { const f = fixture(); f.producer.install(ring.sab, { muted: false, rateControl: true, ...opts }); return f.producer; };
  const fill = () => { Atomics.store(ring.header, AUDIO_PCM_HEADER.READ_INDEX, 0); Atomics.store(ring.header, AUDIO_PCM_HEADER.WRITE_INDEX, 8000); };
  for (const [opts, bound] of [[{}, 5000], [{ rateMaxPpm: 10000 }, 10000], [{ rateMaxPpm: 50000 }, 10000]]) {
    const p = mk(opts);
    p.targetFrames = 1920;
    fill();
    for (let i = 0; i < 400; i += 1) p.rate();
    assert.equal(p.ratePpm, bound, JSON.stringify(opts));
  }
});

test("model: the 1 % bound brings the latency back about twice as fast", () => {
  const speedAt = (t) => (t < 3000 ? 0.75 : t < 4000 ? 1.14 : 1);
  const b = simulate({ rateControl: true, speedAt, seconds: 30, trackOverMs: 100 });
  const c = simulate({ rateControl: true, speedAt, seconds: 30, trackOverMs: 100, rateMaxPpm: 10000 });
  assert.ok(c.overMs < b.overMs * 0.7, JSON.stringify({ b, c }));
});

test("0216: pulls sized on the shorter FIFO, the overflow guard on the longer, a FIFO at 0 beside a fed one ignored, 0186 without 0216", () => {
  const ring = createAudioPcmRing();
  const f = fixture();
  let dma = 6, streaming = 30;
  f.core.audioQueuedMs = () => Math.max(dma, streaming);
  f.core.audioQueuedFifoMs = (which) => (which === 0 ? dma : which === 1 ? streaming : -1);
  f.producer.install(ring.sab, { muted: false, rateControl: true });
  assert.deepEqual(f.producer.mixerQueues(f.core), { lo: 6, hi: 30, dma: 6, streaming: 30 });
  // at most the DMA's 6 ms less a granule; the streaming's 30 ms asks for 22: capped at 2
  const b = f.producer.mixerBounds(f.core, 60 * 48);
  assert.equal(b.maxFrames, 2 * 48);
  assert.equal(b.minFrames, 22 * 48);
  // a FIFO that is not playing (0) does not hold the pulls at 0
  streaming = 0; dma = 20;
  assert.equal(f.producer.mixerQueues(f.core).lo, 20);
  // a core without 0216: 0186's longer for both
  delete f.core.audioQueuedFifoMs;
  assert.deepEqual(f.producer.mixerQueues(f.core), { lo: 20, hi: 20, dma: null, streaming: null });
});

test("0216 export: per FIFO, read-only, beside 0186; the worker reaches it", async () => {
  const { readFile } = await import("node:fs/promises");
  const read = (p) => readFile(new URL(p, import.meta.url), "utf8");
  const [core, patch, worker] = await Promise.all([read("../core/upstream/dolphin_web_core.cpp"), read("../patches/dolphin-wasm/snapshot/0216-mixer-queue-depth-per-fifo.patch"), read("../src/upstream-discio-worker.js")]);
  assert.match(core, /EMSCRIPTEN_KEEPALIVE\n#endif\ndouble DolphinWeb_AudioQueuedFifoMs\(int which\)\n\{\n  if \(!s_runtime_initialized \|\| \(which != 0 && which != 1\)\)\n    return -1;/);
  assert.match(core, /which == 0 \? mixer->GetDMAQueuedMicroseconds\(\) : mixer->GetStreamingQueuedMicroseconds\(\)/);
  assert.match(core, /double DolphinWeb_AudioQueuedMs\(\)/, "0186 kept");
  assert.match(patch, /\+  u64 GetDMAQueuedMicroseconds\(\) const \{ return m_dma_mixer\.QueuedMicroseconds\(\); \}/);
  assert.match(patch, /\+  u64 GetStreamingQueuedMicroseconds\(\) const \{ return m_streaming_mixer\.QueuedMicroseconds\(\); \}/);
  assert.doesNotMatch(patch, /Mixer\.cpp/, "the mixer itself is unchanged");
  assert.match(worker, /audioQueuedFifoMs:\n\s+typeof module\._DolphinWeb_AudioQueuedFifoMs === "function"/);
});

test("review of #430: an epoch flush drops the resampler's fraction; the trace keeps an unknown FIFO null", () => {
  const ring = createAudioPcmRing();
  Atomics.store(ring.header, AUDIO_PCM_HEADER.STATE, AUDIO_PCM_STATE_RUNNING);
  const res = { frac: 0.4 };
  Atomics.add(ring.header, AUDIO_PCM_HEADER.EPOCH, 1);
  consumeAudioPcm(ring, new Float32Array(4), new Float32Array(4), 4, res);
  assert.equal(res.flushed, true);
  assert.equal(res.frac, 0);
  const f = fixture();
  f.core.audioQueuedFifoMs = () => -1;
  f.producer.install(createAudioPcmRing().sab, { muted: false });
  f.producer.traceStart({ everyMs: 1 });
  f.producer.traceTick(10);
  const [s] = f.producer.traceDrain().samples;
  assert.equal(s.dmaMs, null);
  assert.equal(s.streamingMs, null);
});

test("rate control default: on under V8, off under JavaScriptCore, SpiderMonkey and unknown; ?audiorate=1|0 forces it; the bound 1 %", async () => {
  const { defaultAudioRate, requestedAudioRate, DEFAULT_AUDIO_RATE_MAX_PPM } = await import("../src/audio.js");
  assert.equal(defaultAudioRate("v8"), true);
  for (const e of ["jsc", "spidermonkey", "unknown"]) assert.equal(defaultAudioRate(e), false, e);
  assert.equal(requestedAudioRate("", "v8"), true);
  assert.equal(requestedAudioRate("?audiorate=0", "v8"), false, "the old behaviour forced");
  assert.equal(requestedAudioRate("?audiorate=1", "jsc"), true);
  assert.equal(requestedAudioRate("?audiorate=yes", "jsc"), false);
  assert.equal(DEFAULT_AUDIO_RATE_MAX_PPM, 10000);
  const { readFile } = await import("node:fs/promises");
  const audio = await readFile(new URL("../src/audio.js", import.meta.url), "utf8");
  assert.match(audio, /this\.workletRateControl = requestedAudioRate\(window\.location\.search, wasmEngine\(\)\);/);
  assert.match(audio, /rateMax <= 10000 \? rateMax : DEFAULT_AUDIO_RATE_MAX_PPM;/);
});
