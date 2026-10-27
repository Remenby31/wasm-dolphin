import test from "node:test";
import assert from "node:assert/strict";
import {
  AUDIO_PCM_HEADER,
  AUDIO_PCM_STATE_PREFILL,
  AUDIO_PCM_STATE_RUNNING,
  createAudioPcmRing,
  consumeAudioPcm,
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

// A lower ring target (?audiolead on the AudioWorklet path): the producer
// keeps that fill, starts playback at half of it, and stays within bounds.
test("producer keeps the page's target fill and starts at half of it", () => {
  const ring = createAudioPcmRing();
  const f = fixture();
  assert.equal(f.producer.install(ring.sab, { muted: false, targetFrames: 1920 }).active, true);
  consumeAudioPcm(ring, new Float32Array(1), new Float32Array(1));
  assert.equal(f.producer.refill(), 1920, "40 ms at 48 kHz");
  assert.equal(f.producer.telemetry().targetFrames, 1920);
  assert.equal(Atomics.load(ring.header, AUDIO_PCM_HEADER.STATE), AUDIO_PCM_STATE_RUNNING);
  // 20 ms consumed: refilled to the target again, not to the default
  const out = new Float32Array(960);
  consumeAudioPcm(ring, out, new Float32Array(960));
  assert.equal(f.producer.refill(), 960);
  // bounds: never above the ring's default target, never under 10 ms
  const f2 = fixture(), r2 = createAudioPcmRing();
  f2.producer.install(r2.sab, { muted: false, targetFrames: 99999 });
  assert.equal(f2.producer.telemetry().targetFrames, AUDIO_PCM_TARGET_FRAMES);
  const f3 = fixture(), r3 = createAudioPcmRing();
  f3.producer.install(r3.sab, { muted: false, targetFrames: 10 });
  assert.equal(f3.producer.telemetry().targetFrames, 480);
});
