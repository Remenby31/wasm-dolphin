import {
  AUDIO_PCM_HEADER,
  AUDIO_PCM_MAX_RATE_PPM,
  AUDIO_PCM_RATE_CEILING_PPM,
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
// ?audiorate=1 (rate control): the consumer plays up to +0.5 % faster while
// the latency is over its target, the rate proportional to the excess (1000
// ppm a ms over the dead band, so 5 ms more is the bound), under a 4 ms dead
// band, moving at most 100 ppm a 10 ms tick (no step). The latency is the
// ring's fill AND the mixer's queue (smoothed over ~200 ms), against the
// ring's target plus half the mixer's size: the mixer's queue is pulled down
// to that half into the ring whenever it comes within 10 ms of overflowing,
// which moves latency between the two without changing it.
export const RATE_PPM_PER_MS = 1000;
export const RATE_DEAD_BAND_MS = 4;
export const RATE_SMOOTHING = 0.05;
export const RATE_SLEW_PPM = 100;
export const SURPLUS_MARGIN_MS = 10;

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
  install(sab, { muted = true, targetFrames = AUDIO_PCM_TARGET_FRAMES, rateControl = false, mixerCapMs = 80, rateMaxPpm = AUDIO_PCM_MAX_RATE_PPM } = {}) {
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
      this.rateControl = Boolean(rateControl);
      this.mixerCapMs = Math.max(16, Number(mixerCapMs) || 80);
      this.rateMaxPpm = Math.max(0, Math.min(AUDIO_PCM_RATE_CEILING_PPM, Math.round(Number(rateMaxPpm) || AUDIO_PCM_MAX_RATE_PPM)));
      this.ratePpm = 0;
      this.excessMs = null;
      Atomics.store(ring.header, AUDIO_PCM_HEADER.RATE_PPM, 0);
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

  // Harness trace (validationAudioTrace): every `everyMs` one sample of the
  // ring's target and fill, its underruns, the mixer's queue and its
  // overflow skips and underrun fills (patch 0212), and the frames pulled
  // since the previous sample (asked, returned, the largest single pull).
  // Off unless started; at most `max` samples kept (the oldest dropped).
  traceStart({ everyMs = 100, max = 6000 } = {}) {
    this.trace = { everyMs, max, samples: [], lost: 0, nextAt: 0, asked: 0, got: 0, pulls: 0, maxPull: 0, empty: 0 };
    return { started: true, everyMs, max };
  }

  traceDrain({ stop = false } = {}) {
    const t = this.trace;
    if (!t) return { samples: [], lost: 0, active: false };
    const out = { samples: t.samples, lost: t.lost, everyMs: t.everyMs, active: !stop };
    t.samples = [];
    t.lost = 0;
    if (stop) this.trace = null;
    return out;
  }

  traceTick(now) {
    const t = this.trace;
    if (!t || now < t.nextAt) return;
    t.nextAt = now + t.everyMs;
    const ring = this.ring;
    const core = this.api();
    const events = core?.audioQueueEvents;
    const queuedMs = core?.audioQueuedMs?.();
    t.samples.push({
      t: performance.timeOrigin + now,
      target: Math.round(this.targetFrames ?? 0),
      floor: this.floorFrames ?? null,
      fill: ring ? audioPcmAvailableFrames(ring.header) : null,
      underruns: ring ? Atomics.load(ring.header, AUDIO_PCM_HEADER.UNDERRUN_EVENTS) >>> 0 : null,
      mixerMs: Number.isFinite(queuedMs) && queuedMs >= 0 ? Math.round(queuedMs * 10) / 10 : null,
      skips: typeof events === "function" ? events(0) : null,
      fills: typeof events === "function" ? events(1) : null,
      asked: t.asked, got: t.got, pulls: t.pulls, maxPull: t.maxPull, empty: t.empty,
      ratePpm: ring ? Atomics.load(ring.header, AUDIO_PCM_HEADER.RATE_PPM) | 0 : null,
      surplus: ring ? Atomics.load(ring.header, AUDIO_PCM_HEADER.PRODUCER_SURPLUS_FRAMES) >>> 0 : null,
      resampled: ring ? Atomics.load(ring.header, AUDIO_PCM_HEADER.RESAMPLED_FRAMES) >>> 0 : null,
      resampleExtra: ring ? Atomics.load(ring.header, AUDIO_PCM_HEADER.RESAMPLE_EXTRA_FRAMES) >>> 0 : null,
      muted: this.muted,
    });
    t.asked = t.got = t.pulls = t.maxPull = t.empty = 0;
    if (t.samples.length > t.max) { t.samples.shift(); t.lost += 1; }
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
    if (this.rateControl) this.rate();
    if (this.trace) this.traceTick(now);
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

  // rate control: the consumer's rate from the ring's excess over its target
  rate() {
    const ring = this.ring;
    if (!ring) return;
    const queuedMs = this.api()?.audioQueuedMs?.();
    const mixerMs = Number.isFinite(queuedMs) && queuedMs >= 0 ? queuedMs : this.mixerCapMs / 2;
    const rawMs = (audioPcmAvailableFrames(ring.header) - (this.targetFrames ?? AUDIO_PCM_TARGET_FRAMES)) / 48 + mixerMs - this.mixerCapMs / 2;
    this.excessMs = this.excessMs == null ? rawMs : this.excessMs + RATE_SMOOTHING * (rawMs - this.excessMs);
    const excessMs = this.excessMs;
    const goal = excessMs > RATE_DEAD_BAND_MS ? Math.min(this.rateMaxPpm ?? AUDIO_PCM_MAX_RATE_PPM, Math.round((excessMs - RATE_DEAD_BAND_MS) * RATE_PPM_PER_MS)) : 0;
    const next = this.ratePpm + Math.max(-RATE_SLEW_PPM, Math.min(RATE_SLEW_PPM, goal - this.ratePpm));
    this.ratePpm = next;
    Atomics.store(ring.header, AUDIO_PCM_HEADER.RATE_PPM, next | 0);
  }

  // rate control: frames to pull from the mixer beyond the ring's target, so
  // its queue never reaches AudioBufferSize (an overflow skips half of it)
  surplusFrames(core) {
    if (!this.rateControl) return 0;
    const queuedMs = core.audioQueuedMs?.();
    if (!(Number.isFinite(queuedMs) && queuedMs > this.mixerCapMs - SURPLUS_MARGIN_MS)) return 0;
    return Math.max(0, Math.round((queuedMs - this.mixerCapMs / 2) * 48));
  }

  refill(maxMixes = 2) {
    const ring = this.ring;
    if (!ring) return 0;
    // not pulled now (muted, a transition, no core): the mixer's queue is
    // unknown, never the last value read
    const unknown = () => { Atomics.store(ring.header, AUDIO_PCM_HEADER.MIXER_QUEUE_US, -1); return 0; };
    if (this.muted) return unknown();
    const epoch = Atomics.load(ring.header, AUDIO_PCM_HEADER.EPOCH) >>> 0;
    if ((Atomics.load(ring.header, AUDIO_PCM_HEADER.EPOCH_ACK) >>> 0) !== epoch) return unknown();
    const core = this.api();
    if (!core?.mixAudio || !core?.audioBuffer || !core?.heapU8) return unknown();
    let wrote = 0;
    for (let attempt = 0; attempt < maxMixes; attempt += 1) {
      const fill = audioPcmAvailableFrames(ring.header);
      const free = audioPcmFreeFrames(ring.header);
      const target = Math.round(this.targetFrames ?? AUDIO_PCM_TARGET_FRAMES);
      const surplus = this.surplusFrames(core);
      const want = Math.max(target - fill, surplus);
      if (want <= 0 || free <= 0) break;
      const maxFrames = Math.max(1, core.audioBufferFrames?.() || 4096);
      const requested = Math.min(maxFrames, want, free);
      if (target - fill < requested) Atomics.add(ring.header, AUDIO_PCM_HEADER.PRODUCER_SURPLUS_FRAMES, requested - Math.max(0, target - fill));
      const started = performance.now();
      const mixed = Math.max(0, Math.min(requested, core.mixAudio(requested) | 0));
      this.recordMix(requested, mixed, performance.now() - started);
      if (this.trace) {
        this.trace.asked += requested;
        this.trace.got += mixed;
        this.trace.pulls += 1;
        this.trace.maxPull = Math.max(this.trace.maxPull, requested);
        if (mixed <= 0) this.trace.empty += 1;
      }
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
    // the mixer's own queue, for the page's latency (0186; -1 unknown)
    const queuedMs = core.audioQueuedMs?.();
    Atomics.store(ring.header, AUDIO_PCM_HEADER.MIXER_QUEUE_US, Number.isFinite(queuedMs) && queuedMs >= 0 ? Math.round(queuedMs * 1000) : -1);
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
      rateControl: Boolean(this.rateControl),
      ratePpm: this.ratePpm ?? 0,
      rateMaxPpm: this.rateMaxPpm ?? null,
      workletRing: this.ring ? snapshotAudioPcmRing(this.ring) : null,
    };
  }
}
