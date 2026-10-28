import {
  AUDIO_PCM_HEADER,
  AUDIO_PCM_STATE_RUNNING,
  audioPcmAvailableFrames,
  createAudioPcmRing,
  snapshotAudioPcmRing,
} from "./audio-pcm-ring.js";

// The worklet's ring RUNNING, holding frames, and not read while the
// context's clock advanced this long: a processor gone.
export const WORKLET_STALL_MS = 1000;

export class AudioController {
  constructor() {
    this.context = null;
    this.gain = null;
    this.source = null;
    this.muted = true;
    // 0..1, driven by the volume dial. Mute is kept separate so the dial
    // position survives a mute/unmute round trip.
    this.volume = 1;
    this.available = false;
    this.pumpTimer = 0;
    this.pumpPending = false;
    this.nextPlayTime = 0;
    // §28cm/cu audio buffer tuning. 120ms holds clean once the CPU
    // throttle uses sleep_until (§28cr3 reverted busy-spin → audio thread
    // gets CPU during throttle waits → no starvation). 80ms is too tight
    // (probe showed 5u/4d at 80ms). 120ms is the sweet spot for audio
    // latency vs robustness. URL param ?audiolead=N (seconds, 0.05-1.0)
    // overrides. ?audiopump=N (ms, 5-100) tunes pump interval.
    const params = new URLSearchParams(window.location.search);
    // The AudioWorklet by default (2026-10-27 pairs: latency 165 -> 64 ms
    // from the title on, 0 underruns, no drop regression); ?audiotransport=
    // legacy keeps the scheduled buffers. Without isolation or AudioWorklet
    // it falls back to them anyway.
    this.requestedTransport = params.get("audiotransport") === "legacy" ? "legacy" : "worklet";
    this.activeTransport = "legacy";
    this.transportFallbackReason = this.requestedTransport === "worklet" ? "not-initialized" : "";
    this.workletRing = null;
    this.workletNode = null;
    this.workletModuleLoaded = false;
    this.workletWatchdog = 0;
    this.workletWatch = null;
    this.transportBridge = null;
    const leadParam = Number.parseFloat(params.get("audiolead") || "");
    this.targetLeadSeconds =
      Number.isFinite(leadParam) && leadParam >= 0.05 && leadParam <= 1
        ? leadParam
        : 0.12;
    // The AudioWorklet path: the ring's fill the worker keeps. Its producer
    // pulls exactly what the ring lacks from the mixer, which stretches its
    // own queue (no clock drift to correct), so the fill IS the latency
    // before the mixer's queue. ?audiolead (0.02-0.12 s) for this path too:
    // the ring's floor. It starts at 120 ms and comes down to this once the
    // producer keeps time (audio-pcm-producer.js); 40 ms by default. A lead
    // over 0.12 s is held at 0.12 (the ring never starts above it).
    this.workletLeadSeconds =
      Number.isFinite(leadParam) && leadParam >= 0.02 && leadParam <= 1 ? Math.min(leadParam, 0.12) : 0.04;
    this.startLeadSeconds = 0.05;
    this.chunkFrames = 1024;
    const pumpParam = Number.parseInt(params.get("audiopump") || "", 10);
    this.pumpIntervalMs =
      Number.isFinite(pumpParam) && pumpParam >= 5 && pumpParam <= 100
        ? pumpParam
        : 15;
    this.stats = "audio:off";

    // §28cx main-thread contention diagnostics. The pump is driven by a
    // setInterval on the main thread; when the main thread is blocked the
    // interval is starved and the AudioContext schedule runs dry → underrun.
    // These counters (a few numbers per pump call — negligible cost) let the
    // main-thread profiler (?mainprof=1) distinguish "setInterval starved on
    // main thread" (large pump gaps) from "worker slow to answer mixAudio"
    // (large mix latency). Read via window.__audio.profile.
    this.lastPumpAt = 0;
    this.profile = {
      pumpCount: 0,
      pumpMisses: 0,
      maxGapMs: 0,
      sumGapMs: 0,
      gapSamples: 0,
      lastGapMs: 0,
      maxMixMs: 0,
      sumMixMs: 0,
      mixSamples: 0,
      pumpPendingSkipCount: 0,
      underrunCount: 0,
      overrunCount: 0,
      scheduleLeadSeconds: 0,
      scheduleDriftSeconds: 0
    };
  }

  workletTargetFrames() {
    return Math.round(this.workletLeadSeconds * 48000);
  }

  // What is queued between the game and the speaker, in ms: on the worklet
  // path the mixer's granule queue (AudioBufferSize; a core with 0186
  // reports it, else it is left out), the ring's fill and the output's own
  // latency; on the legacy path the schedule's lead and the output (the
  // mixer's queue is not known there).
  latencyMs(workletRing) {
    const out = ((this.context?.outputLatency || 0) + (this.context?.baseLatency || 0)) * 1000;
    if (this.activeTransport === "worklet" && workletRing) {
      return Math.round(workletRing.fillFrames / 48 + (workletRing.mixerQueueMs ?? 0) + out);
    }
    return this.context ? Math.round(this.profile.scheduleLeadSeconds * 1000 + out) : null;
  }

  setTransportBridge(bridge) {
    this.transportBridge = typeof bridge === "function" ? bridge : null;
  }

  setSource(source) {
    this.source = typeof source === "function" ? source : null;
    this.available = Boolean(this.source);
    this.stats = this.source ? "audio:ready" : "audio:off";
    if (!this.muted) {
      this.startPump();
      void this.pump();
    }
  }

  async setMuted(muted) {
    this.muted = Boolean(muted);
    if (!muted) {
      await this.ensureContext();
      if (this.activeTransport === "worklet") {
        await this.transportBridge?.({ enabled: true, muted: false, sab: this.workletRing.sab, targetFrames: this.workletTargetFrames() });
        if (!this.workletWatchdog) this.startWorkletWatchdog();
      } else {
        this.startPump();
        await this.pump();
      }
    } else {
      this.stopPump();
      this.stopWorkletWatchdog();
      if (this.activeTransport === "worklet") {
        await this.transportBridge?.({ enabled: true, muted: true, sab: this.workletRing.sab, targetFrames: this.workletTargetFrames() });
      }
    }
    this.update();
    return !this.muted && this.available;
  }

  async ensureContext() {
    if (this.context) {
      if (this.context.state === "suspended") {
        await this.context.resume();
      }
      return;
    }

    const AudioContext = window.AudioContext ?? window.webkitAudioContext;
    if (!AudioContext) {
      return;
    }

    if (this.requestedTransport === "worklet") {
      try {
        this.context = new AudioContext({ sampleRate: 48000 });
      } catch {
        this.context = new AudioContext();
      }
    } else {
      this.context = new AudioContext();
    }
    this.gain = this.context.createGain();
    this.gain.gain.value = this.muted ? 0 : this.volume;
    this.gain.connect(this.context.destination);
    this.keepContextRunning();
    if (this.requestedTransport === "worklet") {
      await this.tryEnableWorkletTransport();
    }
  }

  // A context the system suspends (iOS: a call, another app) stays
  // suspended: the legacy pump resumes it on each tick, the worklet path has
  // no tick. Resumed when its state changes, and on the next pointerdown or
  // keydown if the browser wants a gesture for it.
  keepContextRunning() {
    const context = this.context;
    const resume = () => {
      this.workletWatch = null;
      if (this.muted || context.state === "running" || context.state === "closed") return;
      context.resume?.()?.catch?.(() => {});
    };
    context.onstatechange = resume;
    for (const type of ["pointerdown", "keydown"]) {
      window.addEventListener?.(type, resume, { capture: true, passive: true });
    }
    globalThis.document?.addEventListener?.("visibilitychange", () => { this.workletWatch = null; });
  }

  // Sound turned on before a disc: the worker had no core and the worklet
  // fell back to legacy (core-not-loaded). Called once a disc is mounted:
  // the worklet is tried again; legacy stays if it fails again.
  async retryWorkletTransport() {
    if (!this.context || this.requestedTransport !== "worklet" || this.activeTransport === "worklet") return false;
    if (!this.transportFallbackReason.includes("core-not-loaded")) return false;
    this.stopPump();
    const ok = await this.tryEnableWorkletTransport();
    if (!ok && !this.muted) {
      this.startPump();
      void this.pump();
    }
    return ok;
  }

  async tryEnableWorkletTransport() {
    const fail = (reason) => {
      this.activeTransport = "legacy";
      this.transportFallbackReason = reason;
      this.stats = `audio:legacy-fallback:${reason}`;
      return false;
    };
    if (globalThis.crossOriginIsolated !== true || typeof SharedArrayBuffer !== "function") {
      return fail("cross-origin-isolation-required");
    }
    if (!this.context?.audioWorklet || typeof globalThis.AudioWorkletNode !== "function") {
      return fail("audio-worklet-unavailable");
    }
    if (this.context.sampleRate !== 48000) return fail(`sample-rate-${this.context.sampleRate}`);
    if (!this.transportBridge) return fail("producer-bridge-unavailable");
    try {
      this.workletRing = createAudioPcmRing();
      if (!this.workletModuleLoaded) {
        await this.context.audioWorklet.addModule(
          new URL("./audio-worklet-processor.js", import.meta.url).href
        );
        this.workletModuleLoaded = true;
      }
      const node = new AudioWorkletNode(this.context, "dolphin-pcm", {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        processorOptions: { sab: this.workletRing.sab },
      });
      // at once: a processor that throws in its constructor reports it
      // before the producer has answered
      let processorError = false;
      node.onprocessorerror = () => {
        processorError = true;
        if (this.workletNode === node && this.activeTransport === "worklet") void this.fallbackFromWorklet("processor-error");
      };
      node.connect(this.gain);
      this.workletNode = node;
      const activation = await this.transportBridge({
        enabled: true,
        muted: this.muted,
        sab: this.workletRing.sab,
        targetFrames: this.workletTargetFrames(),
      });
      const activated = typeof activation === "object" ? activation?.active : activation;
      if (!activated) {
        const reason = typeof activation === "object" ? activation?.reason : "";
        throw new Error(`producer-rejected${reason ? `:${reason}` : ""}`);
      }
      if (processorError) {
        await this.transportBridge({ enabled: false, muted: this.muted, sab: null });
        throw new Error("processor-error");
      }
      this.activeTransport = "worklet";
      this.transportFallbackReason = "";
      this.stats = "audio:worklet-ready";
      this.stopPump();
      if (!this.muted) this.startWorkletWatchdog();
      return true;
    } catch (error) {
      this.workletNode?.disconnect?.();
      this.workletNode = null;
      this.workletRing = null;
      return fail(`worklet-init:${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // A worklet that stops reading without an error (a processor gone while
  // its render thread runs): stalled only when, since the last reset, the
  // context's own clock advanced WORKLET_STALL_MS with frames in the ring and
  // CONSUMED_FRAMES never moved. Never on wall time: a Mac waking from sleep
  // or a Bluetooth profile switch freezes the render thread (and with it
  // currentTime) while the state stays "running"; an empty ring is a starved
  // producer, not the worklet. A frozen render thread would silence legacy
  // on the same context too. Reset on statechange and visibilitychange;
  // stopped while muted.
  startWorkletWatchdog(stallMs = WORKLET_STALL_MS) {
    this.stopWorkletWatchdog();
    this.workletWatch = null;
    this.workletWatchdog = window.setInterval(() => {
      const ring = this.workletRing;
      if (this.activeTransport !== "worklet" || !ring || this.muted) return this.stopWorkletWatchdog();
      const { header } = ring;
      const consumed = Atomics.load(header, AUDIO_PCM_HEADER.CONSUMED_FRAMES);
      const at = this.context?.currentTime ?? 0;
      const queued = audioPcmAvailableFrames(header) > 0;
      const running = Atomics.load(header, AUDIO_PCM_HEADER.STATE) === AUDIO_PCM_STATE_RUNNING;
      const watch = this.workletWatch;
      if (!watch || watch.consumed !== consumed || !queued || !running || this.context?.state !== "running") {
        this.workletWatch = { consumed, at };
      } else if (at - watch.at >= stallMs / 1000) {
        void this.fallbackFromWorklet("worklet-stalled");
      }
    }, Math.max(50, stallMs / 4));
  }

  stopWorkletWatchdog() {
    if (this.workletWatchdog) window.clearInterval(this.workletWatchdog);
    this.workletWatchdog = 0;
    this.workletWatch = null;
  }

  async fallbackFromWorklet(reason) {
    this.stopWorkletWatchdog();
    this.workletNode?.disconnect?.();
    this.workletNode = null;
    await this.transportBridge?.({ enabled: false, muted: this.muted, sab: null });
    this.activeTransport = "legacy";
    this.transportFallbackReason = reason;
    this.stats = `audio:legacy-fallback:${reason}`;
    if (!this.muted) {
      this.startPump();
      await this.pump();
    }
  }

  update() {
    if (!this.context || !this.gain) {
      return;
    }

    const now = this.context.currentTime;
    this.gain.gain.setTargetAtTime(this.muted ? 0 : this.volume, now, 0.01);
  }

  startPump() {
    if (this.pumpTimer || this.muted || !this.source) {
      return;
    }

    this.pumpTimer = window.setInterval(() => {
      void this.pump();
    }, this.pumpIntervalMs);
  }

  stopPump() {
    if (!this.pumpTimer) {
      return;
    }

    window.clearInterval(this.pumpTimer);
    this.pumpTimer = 0;
  }

  async pump() {
    // Record cadence BEFORE the early-return guards so we capture every
    // setInterval firing — including the ticks that no-op because a prior
    // pump is still pending. A gap ≫ pumpIntervalMs means the main thread
    // starved this timer (the underrun smoking gun).
    const pumpEnteredAt = performance.now();
    if (this.lastPumpAt) {
      const gap = pumpEnteredAt - this.lastPumpAt;
      const p = this.profile;
      p.lastGapMs = gap;
      p.sumGapMs += gap;
      p.gapSamples += 1;
      if (gap > p.maxGapMs) p.maxGapMs = gap;
      if (gap > this.pumpIntervalMs * 2) p.pumpMisses += 1;
    }
    this.lastPumpAt = pumpEnteredAt;
    this.profile.pumpCount += 1;

    if (this.pumpPending) {
      this.profile.pumpPendingSkipCount += 1;
      return;
    }
    if (this.muted || !this.source || !this.context || !this.gain) {
      return;
    }

    this.pumpPending = true;
    try {
      if (this.context.state === "suspended") {
        await this.context.resume();
      }

      const now = this.context.currentTime;
      const leadBeforeFill = this.nextPlayTime - now;
      if (this.nextPlayTime > 0 && leadBeforeFill < 0) this.profile.underrunCount += 1;
      if (leadBeforeFill > this.targetLeadSeconds + this.chunkFrames / 48000) {
        this.profile.overrunCount += 1;
      }
      if (this.nextPlayTime < now + this.startLeadSeconds) {
        this.nextPlayTime = now + this.startLeadSeconds;
      }

      let scheduled = 0;
      const horizon = now + this.targetLeadSeconds;
      // the worklet took over meanwhile (a retry after the mount)
      while (!this.muted && this.activeTransport !== "worklet" && this.nextPlayTime < horizon && scheduled < 6) {
        // mixAudio is a postMessage round-trip to the worker; time it so the
        // profiler can attribute slow chunks to a busy worker vs. main-thread
        // starvation (which shows up as pump-gap, recorded above).
        const mixT0 = performance.now();
        const chunk = await this.source(this.chunkFrames);
        const mixMs = performance.now() - mixT0;
        const p = this.profile;
        p.sumMixMs += mixMs;
        p.mixSamples += 1;
        if (mixMs > p.maxMixMs) p.maxMixMs = mixMs;
        if (!this.scheduleChunk(chunk)) {
          break;
        }
        scheduled += 1;
      }
    } catch (error) {
      this.available = false;
      this.stats = error instanceof Error ? error.message : String(error);
    } finally {
      this.pumpPending = false;
    }
  }

  scheduleChunk(chunk) {
    if (!chunk?.available || !chunk.samples || !this.context || !this.gain) {
      this.available = false;
      this.stats = chunk?.stats || "audio:unavailable";
      return false;
    }

    const channels = Math.min(2, Math.max(1, Number(chunk.channels) || 2));
    const sampleRate = Math.max(8000, Number(chunk.sampleRate) || this.context.sampleRate || 48000);
    const frames = Math.max(0, Math.min(Number(chunk.frames) || 0, this.chunkFrames * 4));
    const samples = chunk.samples instanceof Int16Array ? chunk.samples : new Int16Array(chunk.samples);
    const usableFrames = Math.min(frames, Math.floor(samples.length / channels));
    if (usableFrames <= 0) {
      this.available = Boolean(chunk.available);
      this.stats = chunk.stats || "audio:empty";
      return false;
    }

    const buffer = this.context.createBuffer(channels, usableFrames, sampleRate);
    for (let channel = 0; channel < channels; channel += 1) {
      const output = buffer.getChannelData(channel);
      for (let frame = 0; frame < usableFrames; frame += 1) {
        output[frame] = samples[frame * channels + channel] / 32768;
      }
    }

    const node = this.context.createBufferSource();
    node.buffer = buffer;
    node.connect(this.gain);
    const startAt = Math.max(this.context.currentTime + this.startLeadSeconds, this.nextPlayTime);
    node.start(startAt);
    this.nextPlayTime = startAt + usableFrames / sampleRate;
    this.profile.scheduleLeadSeconds = this.nextPlayTime - this.context.currentTime;
    this.profile.scheduleDriftSeconds = this.profile.scheduleLeadSeconds - this.targetLeadSeconds;
    this.available = true;
    this.stats = chunk.stats || `audio:frames:${usableFrames}`;
    return true;
  }

  setVolume(value) {
    const next = Math.min(1, Math.max(0, Number(value) || 0));
    this.volume = next;
    // Turning the dial up from silence implies wanting sound.
    if (next > 0 && this.muted) this.muted = false;
    if (next === 0) this.muted = true;
    this.update();
    return this.volume;
  }

  label() {
    return this.available ? (this.muted ? "Muted" : "Audio") : "Audio off";
  }

  causalTelemetry() {
    const p = this.profile;
    const workletRing = this.workletRing ? snapshotAudioPcmRing(this.workletRing) : null;
    return {
      requestedTransport: this.requestedTransport,
      activeTransport: this.activeTransport,
      transportFallbackReason: this.transportFallbackReason,
      // the core mixer's queue it was booted with (ms; null: not told)
      mixerBufferMs: this.mixerBufferMs ?? null,
      workletRing,
      pumpCount: p.pumpCount,
      pumpPendingSkipCount: p.pumpPendingSkipCount,
      pumpMissCount: p.pumpMisses,
      pumpGapLastMs: p.lastGapMs,
      pumpGapAverageMs: p.gapSamples > 0 ? p.sumGapMs / p.gapSamples : 0,
      pumpGapMaxMs: p.maxGapMs,
      mixRoundTripAverageMs: p.mixSamples > 0 ? p.sumMixMs / p.mixSamples : 0,
      mixRoundTripMaxMs: p.maxMixMs,
      underrunCount: this.activeTransport === "worklet"
        ? workletRing?.underrunEvents || 0
        : p.underrunCount,
      overrunCount: p.overrunCount,
      scheduleLeadSeconds: p.scheduleLeadSeconds,
      scheduleDriftSeconds: p.scheduleDriftSeconds,
      latencyMs: this.latencyMs(workletRing),
      mixerQueueMs: this.activeTransport === "worklet" ? workletRing?.mixerQueueMs ?? null : null,
      outputLatencyMs: this.context ? Math.round(((this.context.outputLatency || 0) + (this.context.baseLatency || 0)) * 1000) : null
    };
  }
}
