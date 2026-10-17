// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
// In-page monitor, installed as an init script before the app loads. It
// counts what would otherwise be swallowed (uncaught errors, unhandled
// rejections, console.error) and, on request, taps the audio output for
// peak/RMS. Timing does not come from here: see timeline.mjs.

// Runs in the page; must stay self-contained (it is serialised).
export function installMonitor() {
  const fresh = () => ({
    errors: { error: 0, unhandledrejection: 0, consoleError: 0, last: [] },
    audio: { peak: 0, sumSquares: 0, samples: 0, silentWindows: 0, windows: 0 }
  });
  let state = fresh();
  const remember = (kind, text) => {
    if (state.errors.last.length < 20) state.errors.last.push({ kind, text: String(text).slice(0, 300), t: Math.round(performance.now()) });
  };
  window.addEventListener("error", (e) => { state.errors.error += 1; remember("error", e.message || e.error); });
  window.addEventListener("unhandledrejection", (e) => { state.errors.unhandledrejection += 1; remember("unhandledrejection", e.reason?.stack || e.reason); });
  const consoleError = console.error.bind(console);
  console.error = (...args) => { state.errors.consoleError += 1; remember("console.error", args.map(String).join(" ")); consoleError(...args); };

  window.__harnessMonitor = {
    async attachAudio() {
      const audio = window.__audio;
      if (!audio) return { attached: false, reason: "no window.__audio" };
      const enabled = await audio.setMuted(false);
      if (!audio.context || !audio.gain) return { attached: false, reason: "no audio context", enabled };
      const analyser = audio.context.createAnalyser();
      analyser.fftSize = 2048;
      audio.gain.connect(analyser);
      const buf = new Float32Array(analyser.fftSize);
      setInterval(() => {
        analyser.getFloatTimeDomainData(buf);
        let peak = 0, sq = 0;
        for (const v of buf) { const a = Math.abs(v); if (a > peak) peak = a; sq += v * v; }
        state.audio.windows += 1;
        if (peak < 1e-4) state.audio.silentWindows += 1;
        state.audio.peak = Math.max(state.audio.peak, peak);
        state.audio.sumSquares += sq;
        state.audio.samples += buf.length;
      }, 200);
      return { attached: true, enabled, transport: audio.activeTransport, contextState: audio.context.state };
    },
    snapshot(reset = false) {
      const out = {
        errors: { ...state.errors, last: state.errors.last.slice() },
        audio: { ...state.audio, rms: state.audio.samples ? Math.sqrt(state.audio.sumSquares / state.audio.samples) : null },
        transport: window.__host?.adapter?.transportTelemetry?.() ?? null,
        audioTelemetry: window.__audio?.causalTelemetry?.() ?? null
      };
      if (reset) state = fresh();
      return out;
    }
  };
}
