import {
  AUDIO_PCM_HEADER,
  AUDIO_PCM_SAMPLE_RATE,
  AUDIO_PCM_STATE_MUTED,
  AUDIO_PCM_STATE_PREFILL,
  AUDIO_PCM_STATE_RUNNING,
  audioPcmAvailableFrames,
  audioPcmFreeFrames,
  openAudioPcmRing,
  requestAudioPcmEpoch,
  snapshotAudioPcmRing,
  validateAudioPcmRing,
  writeAudioPcm,
} from "./audio-pcm-ring.js";

export const AUDIO_PCM_TARGET_FRAMES = 5760;
export const AUDIO_PCM_START_FRAMES = 2400;
export const ADAPT_CALM_MS = 5000;
// The target's descent once calm: 0.5 % of the time, 5 ms of ring a second.
export const ADAPT_DESCENT = 0.005;

function atomicMax(header, index, value) {
  let before = Atomics.load(header, index);
  while ((before >>> 0) < (value >>> 0)) {
    const observed = Atomics.compareExchange(header, index, before, value | 0);
    if (observed === before) break;
    before = observed;
  }
}

export class AudioPcmProducer {
  constructor({
    api = () => null,
    recordMix = () => {},
    setTimer = (callback, delay) => globalThis.setInterval(callback, delay),
    clearTimer = (timer) => globalThis.clearInterval(timer),
  } = {}) {
    this.api = api;
    this.recordMix = recordMix;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.ring = null;
    this.timer = 0;
    this.muted = true;
    this.lastTimerAt = 0;
    this.requestedTransport = "legacy";
    this.activeTransport = "legacy";
    this.fallbackReason = "";
  }

  // targetFrames: the ring's fill the producer keeps (the AudioWorklet
  // path's latency, before the mixer's own queue); 120 ms by default, the
  // page passes ?audiolead. Playback starts at half of it (at most 50 ms).
  install(sab, { muted = true, targetFrames = AUDIO_PCM_TARGET_FRAMES } = {}) {
    this.requestedTransport = "worklet";
    try {
      const ring = validateAudioPcmRing(openAudioPcmRing(sab));
      const core = this.api();
      if (!core?.mixAudio || !core?.audioBuffer || !core?.heapU8) throw new Error("core-audio-unavailable");
      if ((core.audioSampleRate?.() || 0) !== AUDIO_PCM_SAMPLE_RATE) throw new Error("core-sample-rate");
      if ((core.audioChannels?.() || 0) !== 2) throw new Error("core-channel-count");
      this.stop();
      this.ring = ring;
      // The page's target is a floor: the ring starts at 120 ms and comes
      // down to it once the producer keeps time (a cold boot keeps this
      // worker busy: a 40 ms ring underran ~100 times in its first 6 s).
      this.floorFrames = Math.max(480, Math.min(AUDIO_PCM_TARGET_FRAMES, targetFrames | 0 || AUDIO_PCM_TARGET_FRAMES));
      this.targetFrames = AUDIO_PCM_TARGET_FRAMES;
      this.startFrames = Math.min(AUDIO_PCM_START_FRAMES, this.floorFrames >> 1);
      this.calmSince = 0;
      this.underrunsSeen = 0;
      this.activeTransport = "worklet";
      this.fallbackReason = "";
      this.muted = Boolean(muted);
      requestAudioPcmEpoch(ring, this.muted ? AUDIO_PCM_STATE_MUTED : AUDIO_PCM_STATE_PREFILL);
      this.timer = this.setTimer(() => this.timerTick(), 10);
      return { active: true, reason: "" };
    } catch (error) {
      this.stop();
      this.activeTransport = "legacy";
      this.fallbackReason = error instanceof Error ? error.message : String(error);
      return { active: false, reason: this.fallbackReason };
    }
  }

  stop() {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = 0;
    this.ring = null;
    this.activeTransport = "legacy";
  }

  setMuted(muted) {
    const next = Boolean(muted);
    if (!this.ring) return false;
    if (next === this.muted && (Atomics.load(this.ring.header, AUDIO_PCM_HEADER.EPOCH) >>> 0) !== 0) {
      return true;
    }
    this.muted = next;
    requestAudioPcmEpoch(this.ring, next ? AUDIO_PCM_STATE_MUTED : AUDIO_PCM_STATE_PREFILL);
    return true;
  }

  transition() {
    if (!this.ring) return false;
    requestAudioPcmEpoch(
      this.ring,
      this.muted ? AUDIO_PCM_STATE_MUTED : AUDIO_PCM_STATE_PREFILL
    );
    return true;
  }

  timerTick() {
    const now = performance.now();
    const gapMs = this.lastTimerAt ? now - this.lastTimerAt : 0;
    if (this.lastTimerAt) {
      const gapUs = Math.max(0, Math.round((now - this.lastTimerAt) * 1000));
      if (this.ring) {
        atomicMax(this.ring.header, AUDIO_PCM_HEADER.PRODUCER_TIMER_GAP_MAX_US, gapUs);
      }
    }
    this.lastTimerAt = now;
    this.adapt(now, gapMs);
    this.refill(2);
  }

  // The ring's target between the page's floor and 120 ms: +20 ms at each
  // underrun (a timer gap over half the target restarts the calm); once
  // calm for ADAPT_CALM_MS it comes down ADAPT_DESCENT of the time (5 ms a
  // second). The producer then pulls that much less from the mixer, whose
  // granule queue grows past AudioBufferSize; the mixer jumps its playhead
  // back to half the queue (Mixer::MixerFifo::Dequeue): granules are skipped,
  // the jump smoothed by their overlapping windows.
  adapt(now, gapMs = 0) {
    const ring = this.ring;
    if (!ring || this.floorFrames == null || this.floorFrames >= AUDIO_PCM_TARGET_FRAMES) return;
    const underruns = Atomics.load(ring.header, AUDIO_PCM_HEADER.UNDERRUN_EVENTS) >>> 0;
    const late = gapMs > (this.targetFrames / 48) / 2;
    if (underruns !== this.underrunsSeen || late) {
      if (underruns !== this.underrunsSeen) this.targetFrames = Math.min(AUDIO_PCM_TARGET_FRAMES, this.targetFrames + 960);
      this.underrunsSeen = underruns;
      this.calmSince = now;
      this.lastAdaptAt = now;
      return;
    }
    if (!this.calmSince) this.calmSince = now;
    // only the time since the calm was long enough counts
    const from = Math.max(this.lastAdaptAt ?? now, this.calmSince + ADAPT_CALM_MS);
    const dt = Math.max(0, now - from);
    this.lastAdaptAt = now;
    if (now - this.calmSince >= ADAPT_CALM_MS && this.targetFrames > this.floorFrames) {
      this.targetFrames = Math.max(this.floorFrames, this.targetFrames - ADAPT_DESCENT * dt * 48);
    }
  }

  refill(maxMixes = 2) {
    const ring = this.ring;
    if (!ring || this.muted) return 0;
    const epoch = Atomics.load(ring.header, AUDIO_PCM_HEADER.EPOCH) >>> 0;
    if ((Atomics.load(ring.header, AUDIO_PCM_HEADER.EPOCH_ACK) >>> 0) !== epoch) return 0;
    const core = this.api();
    if (!core?.mixAudio || !core?.audioBuffer || !core?.heapU8) return 0;
    let wrote = 0;
    for (let attempt = 0; attempt < maxMixes; attempt += 1) {
      const fill = audioPcmAvailableFrames(ring.header);
      const free = audioPcmFreeFrames(ring.header);
      const target = Math.round(this.targetFrames ?? AUDIO_PCM_TARGET_FRAMES);
      if (fill >= target || free <= 0) break;
      const maxFrames = Math.max(1, core.audioBufferFrames?.() || 4096);
      const requested = Math.min(maxFrames, target - fill, free);
      const started = performance.now();
      const mixed = Math.max(0, Math.min(requested, core.mixAudio(requested) | 0));
      this.recordMix(requested, mixed, performance.now() - started);
      if (mixed <= 0) {
        Atomics.add(ring.header, AUDIO_PCM_HEADER.PRODUCER_EMPTY_MIXES, 1);
        break;
      }
      const pointer = core.audioBuffer() >>> 0;
      if (!pointer || pointer + mixed * 4 > core.heapU8.byteLength) break;
      const samples = new Int16Array(core.heapU8.buffer, pointer, mixed * 2);
      const published = writeAudioPcm(ring, samples, mixed, 2);
      wrote += published;
      Atomics.add(ring.header, AUDIO_PCM_HEADER.PRODUCER_REFILLS, 1);
      const afterFill = audioPcmAvailableFrames(ring.header);
      atomicMax(ring.header, AUDIO_PCM_HEADER.PRODUCER_FILL_HIGH_WATER, afterFill);
      if (published !== mixed) break;
    }
    if (audioPcmAvailableFrames(ring.header) >= (this.startFrames ?? AUDIO_PCM_START_FRAMES)) {
      Atomics.store(ring.header, AUDIO_PCM_HEADER.STATE, AUDIO_PCM_STATE_RUNNING);
    }
    return wrote;
  }

  telemetry() {
    return {
      requestedTransport: this.requestedTransport,
      activeTransport: this.activeTransport,
      transportFallbackReason: this.fallbackReason,
      targetFrames: Math.round(this.targetFrames ?? AUDIO_PCM_TARGET_FRAMES),
      floorFrames: this.floorFrames ?? null,
      workletRing: this.ring ? snapshotAudioPcmRing(this.ring) : null,
    };
  }
}
