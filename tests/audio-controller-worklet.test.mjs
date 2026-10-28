import test from "node:test";
import assert from "node:assert/strict";

function installBrowser({ search = "?audiotransport=worklet", isolated = true, sampleRate = 48000 } = {}) {
  const modules = [];
  const contextOptions = [];
  const listeners = {};
  const nodes = [];
  let resumes = 0;
  class Context {
    constructor(options) {
      contextOptions.push(options);
      this.resume = async () => { resumes += 1; };
      this.sampleRate = sampleRate;
      this.currentTime = 0;
      this.state = "running";
      this.destination = {};
      this.audioWorklet = { addModule: async (url) => modules.push(url) };
    }
    createGain() {
      return { gain: { value: 0, setTargetAtTime() {} }, connect() {} };
    }
    createBuffer() { throw new Error("legacy scheduler should not run"); }
  }
  class Node {
    constructor(_context, _name, options) { this.options = options; nodes.push(this); }
    connect() {}
    disconnect() {}
  }
  globalThis.window = {
    location: { search }, AudioContext: Context,
    // unref'd: a worklet watchdog left running never holds the test process
    setInterval: (fn, ms) => { const t = setInterval(fn, ms); t.unref?.(); return t; }, clearInterval,
    addEventListener: (type, fn) => (listeners[type] ??= []).push(fn),
  };
  globalThis.crossOriginIsolated = isolated;
  globalThis.AudioWorkletNode = Node;
  return { modules, contextOptions, listeners, nodes, resumes: () => resumes };
}

test("worklet transport activates only after feature, module, rate, and producer gates", async () => {
  const { modules, contextOptions } = installBrowser();
  const { AudioController } = await import(`../src/audio.js?active=${Date.now()}`);
  const audio = new AudioController();
  const calls = [];
  audio.setTransportBridge(async (config) => { calls.push(config); return true; });
  audio.muted = false;
  await audio.ensureContext();
  assert.equal(audio.activeTransport, "worklet");
  assert.equal(modules.length, 1);
  assert.deepEqual(contextOptions, [{ sampleRate: 48000 }]);
  assert.ok(calls[0].sab instanceof SharedArrayBuffer);
});

test("worklet request falls back observably on missing isolation", async () => {
  installBrowser({ isolated: false });
  const { AudioController } = await import(`../src/audio.js?fallback=${Date.now()}`);
  const audio = new AudioController();
  audio.setTransportBridge(async () => true);
  await audio.ensureContext();
  assert.equal(audio.activeTransport, "legacy");
  assert.equal(audio.transportFallbackReason, "cross-origin-isolation-required");
});

test("worklet fallback preserves the disc-worker producer rejection reason", async () => {
  installBrowser();
  const { AudioController } = await import(`../src/audio.js?producer-fallback=${Date.now()}`);
  const audio = new AudioController();
  audio.setTransportBridge(async () => ({ active: false, reason: "core-channel-count" }));
  await audio.ensureContext();
  assert.equal(audio.activeTransport, "legacy");
  assert.equal(
    audio.transportFallbackReason,
    "worklet-init:producer-rejected:core-channel-count"
  );
});

// The AudioWorklet is the default since the 2026-10-27 pairs (latency 165 ->
// 64 ms, 0 underruns); ?audiotransport=legacy keeps the scheduled buffers
// and never loads a worklet module.
test("the AudioWorklet by default; ?audiotransport=legacy never loads a worklet module", async () => {
  installBrowser({ search: "" });
  const { AudioController: Default } = await import(`../src/audio.js?default=${Date.now()}`);
  const d = new Default();
  assert.equal(d.requestedTransport, "worklet");
  const { modules, contextOptions } = installBrowser({ search: "?audiotransport=legacy" });
  const { AudioController } = await import(`../src/audio.js?legacy=${Date.now()}`);
  const audio = new AudioController();
  await audio.ensureContext();
  assert.equal(audio.requestedTransport, "legacy");
  assert.equal(audio.activeTransport, "legacy");
  assert.equal(modules.length, 0);
  assert.deepEqual(contextOptions, [undefined]);
});

// ?audiolead on the worklet path: the producer is told the ring fill to keep,
// and the latency read back is that fill plus the output's own latency.
test("worklet ring target from ?audiolead, and the latency it reports", async () => {
  installBrowser({ search: "?audiotransport=worklet&audiolead=0.04" });
  const { AudioController } = await import(`../src/audio.js?lead=${Date.now()}`);
  const { writeAudioPcm } = await import("../src/audio-pcm-ring.js");
  const audio = new AudioController();
  const calls = [];
  audio.setTransportBridge(async (config) => { calls.push(config); return true; });
  audio.muted = false;
  await audio.ensureContext();
  assert.equal(calls[0].targetFrames, 1920, "40 ms at 48 kHz");
  audio.context.outputLatency = 0.010;
  audio.context.baseLatency = 0.003;
  writeAudioPcm(audio.workletRing, new Int16Array(1920 * 2), 1920, 2);
  assert.equal(audio.causalTelemetry().latencyMs, 53, "40 ms ring + 13 ms output");
  // no ?audiolead: a 40 ms floor (the producer starts at 120 and comes down)
  installBrowser();
  const { AudioController: Default } = await import(`../src/audio.js?lead-default=${Date.now()}`);
  const d = new Default();
  const seen = [];
  d.setTransportBridge(async (config) => { seen.push(config); return true; });
  d.muted = false;
  await d.ensureContext();
  assert.equal(seen[0].targetFrames, 1920);
});

// Review of #301: the worklet path has no pump tick to resume a context the
// system suspended (iOS: a call, another app).
test("a suspended context is resumed on its state change, and on the next gesture", async () => {
  const b = installBrowser();
  const { AudioController } = await import(`../src/audio.js?resume=${Date.now()}`);
  const audio = new AudioController();
  audio.setTransportBridge(async () => true);
  await audio.setMuted(false);
  assert.equal(audio.activeTransport, "worklet");
  const before = b.resumes();
  audio.context.state = "suspended";
  audio.context.onstatechange();
  assert.equal(b.resumes(), before + 1, "resumed on the state change");
  audio.context.state = "interrupted";
  for (const fn of b.listeners.pointerdown) fn();
  for (const fn of b.listeners.keydown) fn();
  assert.equal(b.resumes(), before + 3, "and on a pointerdown or keydown");
  audio.context.state = "running";
  for (const fn of b.listeners.pointerdown) fn();
  audio.muted = true;
  audio.context.state = "suspended";
  audio.context.onstatechange();
  assert.equal(b.resumes(), before + 3, "never while running, nor muted");
});

// Review of #301: sound on before a disc -> the worker has no core yet; the
// worklet is tried again once the disc is mounted.
test("a worklet refused for core-not-loaded is tried again after the mount; other reasons stay legacy", async () => {
  const b = installBrowser();
  const { AudioController } = await import(`../src/audio.js?retry=${Date.now()}`);
  const audio = new AudioController();
  let core = false;
  const calls = [];
  audio.setTransportBridge(async (config) => { calls.push(config); return core ? true : { active: false, reason: "core-not-loaded" }; });
  audio.setSource(async () => ({ available: false }));
  await audio.setMuted(false);
  assert.equal(audio.activeTransport, "legacy");
  assert.equal(audio.transportFallbackReason, "worklet-init:producer-rejected:core-not-loaded");
  assert.ok(audio.pumpTimer, "legacy pumps meanwhile");
  core = true;
  assert.equal(await audio.retryWorkletTransport(), true);
  assert.equal(audio.activeTransport, "worklet");
  assert.equal(audio.pumpTimer, 0, "the legacy pump stopped");
  assert.equal(b.modules.length, 1, "the module is added once");
  assert.equal(calls.at(-1).enabled, true);
  assert.equal(await audio.retryWorkletTransport(), false, "already on the worklet");
  audio.stopWorkletWatchdog();
  // any other reason: no second try
  installBrowser();
  const { AudioController: Other } = await import(`../src/audio.js?retry-other=${Date.now()}`);
  const o = new Other();
  o.setTransportBridge(async () => ({ active: false, reason: "core-channel-count" }));
  await o.ensureContext();
  assert.equal(await o.retryWorkletTransport(), false);
  assert.equal(o.activeTransport, "legacy");
});

// Review of #301: a processor that throws while being built reports it
// before the producer has answered; the handler must already be there.
test("a processor error during the producer's answer: legacy, the producer stopped", async () => {
  const b = installBrowser();
  const { AudioController } = await import(`../src/audio.js?procerr=${Date.now()}`);
  const audio = new AudioController();
  const calls = [];
  audio.setTransportBridge(async (config) => {
    calls.push(config);
    if (config.enabled) b.nodes.at(-1).onprocessorerror?.();
    return true;
  });
  audio.muted = false;
  await audio.ensureContext();
  assert.equal(audio.activeTransport, "legacy");
  assert.equal(audio.transportFallbackReason, "worklet-init:processor-error");
  assert.equal(calls.at(-1).enabled, false, "the producer told to stop");
  assert.equal(audio.workletNode, null);
});

// Review of #301: a worklet that stops reading without an error. Stalled
// only on the context's own clock, with frames waiting: a frozen render
// thread (sleep, a Bluetooth switch), a starved producer, a suspended or
// muted context never count.
test("the worklet watchdog: stalled on the context clock with frames queued; frozen clock, empty ring, wake, mute -> kept", async () => {
  installBrowser();
  const { AudioController } = await import(`../src/audio.js?stall=${Date.now()}`);
  const { AUDIO_PCM_HEADER, AUDIO_PCM_STATE_RUNNING, writeAudioPcm } = await import("../src/audio-pcm-ring.js");
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const audio = new AudioController();
  const calls = [];
  audio.setTransportBridge(async (config) => { calls.push(config); return true; });
  await audio.setMuted(false);
  assert.ok(audio.workletWatchdog, "running while sound is on");
  audio.startWorkletWatchdog(200);
  const { header } = audio.workletRing;
  const ctx = audio.context;
  Atomics.store(header, AUDIO_PCM_HEADER.STATE, AUDIO_PCM_STATE_RUNNING);
  // an empty ring (a starved producer), the clock running: kept
  for (let i = 0; i < 6; i++) { ctx.currentTime += 0.1; await wait(60); }
  assert.equal(audio.activeTransport, "worklet", "empty ring");
  writeAudioPcm(audio.workletRing, new Int16Array(960 * 2), 960, 2);
  // frames queued, the clock frozen (render thread stopped: sleep, A2DP<->HFP) while wall time passes: kept
  await wait(400);
  assert.equal(audio.activeTransport, "worklet", "frozen context clock");
  // a wake: the clock jumps, but the statechange resets the watch first
  ctx.currentTime += 30;
  ctx.onstatechange();
  await wait(60);
  assert.equal(audio.activeTransport, "worklet", "wake");
  // read while the clock runs: kept
  for (let i = 0; i < 6; i++) { ctx.currentTime += 0.1; Atomics.add(header, AUDIO_PCM_HEADER.CONSUMED_FRAMES, 128); await wait(60); }
  assert.equal(audio.activeTransport, "worklet", "read");
  // suspended: kept
  ctx.state = "suspended";
  for (let i = 0; i < 6; i++) { ctx.currentTime += 0.1; await wait(60); }
  assert.equal(audio.activeTransport, "worklet", "suspended");
  ctx.state = "running";
  ctx.onstatechange();
  // muted: the watchdog stops; unmuted: it is back
  await audio.setMuted(true);
  assert.equal(audio.workletWatchdog, 0, "stopped while muted");
  await audio.setMuted(false);
  assert.ok(audio.workletWatchdog, "back with the sound");
  audio.startWorkletWatchdog(200);
  // the clock runs, frames queued, nothing read: legacy
  for (let i = 0; i < 8 && audio.activeTransport === "worklet"; i++) { ctx.currentTime += 0.1; await wait(60); }
  assert.equal(audio.activeTransport, "legacy");
  assert.equal(audio.transportFallbackReason, "worklet-stalled");
  assert.equal(calls.at(-1).enabled, false);
  assert.equal(audio.workletWatchdog, 0);
  audio.stopPump();
});

// The retry after the mount: a second refusal restarts the legacy pump
// (sound on), never while muted; and app.js calls it once the disc is in.
test("retry after the mount: refused again -> the legacy pump back when sound is on, none when muted; wired in mountFile", async () => {
  installBrowser();
  const { AudioController } = await import(`../src/audio.js?retry-fail=${Date.now()}`);
  const audio = new AudioController();
  audio.setTransportBridge(async () => ({ active: false, reason: "core-not-loaded" }));
  audio.setSource(async () => ({ available: false }));
  await audio.setMuted(false);
  assert.equal(await audio.retryWorkletTransport(), false);
  assert.equal(audio.activeTransport, "legacy");
  assert.ok(audio.pumpTimer, "the legacy pump restarted");
  await audio.setMuted(true);
  assert.equal(await audio.retryWorkletTransport(), false);
  assert.equal(audio.pumpTimer, 0, "no pump while muted");
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const mount = app.slice(app.indexOf("async function mountFile("));
  const mounted = mount.indexOf("await host.mountFile(file)");
  const retry = mount.indexOf("await audio.retryWorkletTransport()");
  assert.ok(mounted > 0 && retry > mounted, "mountFile retries the worklet after the disc is mounted");
  assert.ok(retry < mount.indexOf("host.start()"), "before the emulation starts");
});

// pump() in flight when the worklet takes over: it schedules nothing more.
test("a legacy pump in flight stops scheduling once the worklet is active", async () => {
  installBrowser();
  const { AudioController } = await import(`../src/audio.js?pump-switch=${Date.now()}`);
  const audio = new AudioController();
  audio.setTransportBridge(async () => true);
  audio.muted = false;
  await audio.ensureContext();
  audio.stopWorkletWatchdog();
  audio.activeTransport = "worklet";
  let pulled = 0;
  audio.setSource(async () => { pulled += 1; return { available: true, frames: 1024, samples: new Int16Array(2048) }; });
  audio.stopPump();
  await audio.pump();
  assert.equal(pulled, 0, "createBuffer would throw: nothing scheduled");
});

// 0186: on the worklet path the latency counts the core mixer's queue too.
test("the worklet latency adds the mixer's queue when the core reports it", async () => {
  installBrowser();
  const { AudioController } = await import(`../src/audio.js?mixerq=${Date.now()}`);
  const { writeAudioPcm, AUDIO_PCM_HEADER } = await import("../src/audio-pcm-ring.js");
  const audio = new AudioController();
  audio.setTransportBridge(async () => true);
  audio.muted = false;
  await audio.ensureContext();
  audio.stopWorkletWatchdog();
  audio.context.outputLatency = 0.010;
  audio.context.baseLatency = 0.003;
  writeAudioPcm(audio.workletRing, new Int16Array(1920 * 2), 1920, 2);
  assert.equal(audio.causalTelemetry().latencyMs, 53, "unknown mixer queue: left out");
  assert.equal(audio.causalTelemetry().mixerQueueMs, null);
  Atomics.store(audio.workletRing.header, AUDIO_PCM_HEADER.MIXER_QUEUE_US, 80000);
  assert.equal(audio.causalTelemetry().mixerQueueMs, 80);
  assert.equal(audio.causalTelemetry().latencyMs, 133, "80 ms mixer + 40 ms ring + 13 ms output");
});

// Review of #327: the mixer's queue the core booted with is reported next to
// the transport and its fallback reason.
test("telemetry reports the mixer queue next to the fallback reason", async () => {
  installBrowser({ isolated: false });
  const { AudioController } = await import(`../src/audio.js?mixerbuf=${Date.now()}`);
  const audio = new AudioController();
  assert.equal(audio.causalTelemetry().mixerBufferMs, null, "not told");
  audio.setTransportBridge(async () => true);
  audio.mixerBufferMs = 80;
  await audio.ensureContext();
  const t = audio.causalTelemetry();
  assert.equal(t.activeTransport, "legacy");
  assert.equal(t.transportFallbackReason, "cross-origin-isolation-required");
  assert.equal(t.mixerBufferMs, 80);
});
