// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
// Pure decisions of the consumer-machine runner (probes/consumer-perf.mjs),
// kept apart so they are unit-tested.
import { compareFrames, DEFAULT_THRESHOLDS } from "./image-diff.mjs";

// Features the WebGPU renderer asks for (src/upstream-discio-worker.js).
export const WGPU_FEATURES = Object.freeze(["clip-distances", "depth-clip-control", "dual-source-blending"]);

// Which backends to run. `adapter` is what the page read from
// navigator.gpu: { available, why?, fallback, missingFeatures }.
// auto: wgpu on a real adapter with every feature, the software renderer otherwise.
export function pickBackends(adapter, backend = "auto") {
  if (!["auto", "wgpu", "soft", "both"].includes(backend)) throw new Error(`--backend ${backend}: auto, wgpu, soft or both`);
  const missing = adapter?.missingFeatures ?? [];
  const wgpuOk = Boolean(adapter?.available) && !adapter.fallback && missing.length === 0;
  const why = wgpuOk ? null
    : !adapter?.available ? (adapter?.why ?? "no WebGPU adapter")
      : adapter.fallback ? "fallback (software) adapter"
        : `missing ${missing.join(", ")}`;
  const backends = { both: ["wgpu", "soft"], wgpu: ["wgpu"], soft: ["soft"], auto: wgpuOk ? ["wgpu"] : ["soft"] }[backend];
  return { backends, wgpuOk, why };
}

// A label that is safe as one path segment on every system.
export function sanitizeLabel(label) {
  const clean = String(label ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^\w.-]+/g, "_").replace(/^[._]+|_+$/g, "").slice(0, 64);
  return clean || "machine";
}

// CPU busy over an interval, from two os.cpus() samples: the share of
// non-idle time, and the same in cores. The 1-minute load average is 0 on
// Windows; this works on every system.
export function cpuBusy(before, after) {
  let busy = 0, total = 0;
  after.forEach((cpu, i) => {
    const a = before[i]?.times, b = cpu.times;
    if (!a) return;
    const d = Object.fromEntries(Object.keys(b).map((k) => [k, b[k] - a[k]]));
    const t = Object.values(d).reduce((s, v) => s + v, 0);
    total += t;
    busy += t - d.idle;
  });
  const share = total > 0 ? busy / total : 0;
  return { percent: Math.round(share * 1000) / 10, cores: Math.round(share * after.length * 10) / 10 };
}

// The presenter the page really used, from its telemetry string
// (`present <backend>`), or null.
export function presenterOf(helperStats) {
  return /\bpresent (\S+)/.exec(String(helperStats ?? ""))?.[1] ?? null;
}

// A black or uniform picture: the renderer drew nothing worth measuring.
export function isBlankFrame(frame) {
  return compareFrames(frame, frame).candidateSigma < DEFAULT_THRESHOLDS.blankSigma;
}

// Projected race speed (%) of a machine from its single-core score, by
// proportionality to a calibration point measured on the development Mac
// (the emulated CPU thread is saturated, so speed follows single-core
// performance). `spread` widens the range for everything a single score does
// not capture (memory, browser engine, thermals). Speed never exceeds 100 %:
// the emulator does not run the game faster than the console.
export function projectSpeed(score, { refScore, refSpeed, spread = 0.2 }) {
  if (!(score > 0) || !(refScore > 0) || !(refSpeed > 0)) throw new Error("projectSpeed: scores and speed must be positive");
  if (!(spread >= 0 && spread < 1)) throw new Error(`projectSpeed: spread must be in [0, 1), got ${spread}`);
  const mid = (refSpeed * score) / refScore;
  const cap = (v) => Math.round(Math.min(100, v));
  return { low: cap(mid * (1 - spread)), mid: cap(mid), high: cap(mid * (1 + spread)) };
}

// The class of the middle of the range: real time from REALTIME_SPEED (the
// game keeps the console's pace), playable from PLAYABLE_SPEED (slower than
// the console, still a game), slow below. The range is shown beside it.
export const REALTIME_SPEED = 95;
export const PLAYABLE_SPEED = 60;
export function speedClass({ mid }) {
  if (mid >= REALTIME_SPEED) return "real time";
  if (mid >= PLAYABLE_SPEED) return "playable";
  return "slow";
}
