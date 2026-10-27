import test from "node:test";
import assert from "node:assert/strict";
import {
  AUDIO_PCM_HEADER,
  AUDIO_PCM_STATE_PREFILL,
  AUDIO_PCM_STATE_RUNNING,
  createAudioPcmRing,
  consumeAudioPcm,
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
  assert.equal(Atomics.load(ring.header, AUDIO_PCM_HEADER.TARGET_FRAMES), AUDIO_PCM_TARGET_FRAMES - 240, "published for the worklet");
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

// Review of #301: coming down from 120 to 40 ms must not be heard: the
// worklet plays 0.5 % faster while over the target, interpolated, never a
// skipped sample (a ramp read back moves at most 1.005 a frame, never back).
test("draining over the target: no skipped sample, the fill comes down", async () => {
  const { AUDIO_PCM_DRAIN_RATIO } = await import("../src/audio-pcm-ring.js");
  const ring = createAudioPcmRing();
  const frames = 6000;
  const ramp = new Int16Array(frames * 2);
  for (let i = 0; i < frames; i++) { ramp[2 * i] = i; ramp[2 * i + 1] = i; }
  writeAudioPcm(ring, ramp, frames, 2);
  Atomics.store(ring.header, AUDIO_PCM_HEADER.STATE, AUDIO_PCM_STATE_RUNNING);
  Atomics.store(ring.header, AUDIO_PCM_HEADER.TARGET_FRAMES, 1920);
  const out = [];
  const result = {};
  for (let q = 0; q < 30; q++) {
    const l = new Float32Array(128), r = new Float32Array(128);
    consumeAudioPcm(ring, l, r, 128, result);
    for (const v of l) out.push(Math.round(v * 32768 * 1000) / 1000);
  }
  for (let i = 1; i < out.length; i++) {
    const step = out[i] - out[i - 1];
    assert.ok(step > 0 && step <= AUDIO_PCM_DRAIN_RATIO + 1e-6, `frame ${i}: step ${step} (a skip or a repeat)`);
  }
  const consumed = Atomics.load(ring.header, AUDIO_PCM_HEADER.CONSUMED_FRAMES);
  assert.ok(consumed > 30 * 128, `drained: ${consumed} frames for ${30 * 128} played`);
  // at the target: back to plain copy (exactly one frame per frame)
  const l = new Float32Array(128), r = new Float32Array(128);
  Atomics.store(ring.header, AUDIO_PCM_HEADER.TARGET_FRAMES, 99999);
  const before = Atomics.load(ring.header, AUDIO_PCM_HEADER.CONSUMED_FRAMES);
  consumeAudioPcm(ring, l, r, 128, result);
  assert.equal(Atomics.load(ring.header, AUDIO_PCM_HEADER.CONSUMED_FRAMES) - before, 128);
});
