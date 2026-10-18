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
