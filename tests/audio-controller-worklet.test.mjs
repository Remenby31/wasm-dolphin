import test from "node:test";
import assert from "node:assert/strict";

function installBrowser({ search = "?audiotransport=worklet", isolated = true, sampleRate = 48000 } = {}) {
  const modules = [];
  const contextOptions = [];
  class Context {
    constructor(options) {
      contextOptions.push(options);
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
    constructor(_context, _name, options) { this.options = options; }
    connect() {}
    disconnect() {}
  }
  globalThis.window = {
    location: { search }, AudioContext: Context,
    setInterval, clearInterval,
  };
  globalThis.crossOriginIsolated = isolated;
  globalThis.AudioWorkletNode = Node;
  return { modules, contextOptions };
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
