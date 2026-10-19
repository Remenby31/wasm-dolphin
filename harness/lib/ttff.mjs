// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
// Time to first frame (KPI "expérience joueur", target < 10 s): from the
// moment the disc is handed to the engine (the Play click) to the first
// presentation, cold (new profile) and warm (same profile, second visit).
// Pure: the probe (probes/ttff.mjs) feeds it timestamps, all on one clock
// (performance.timeOrigin + performance.now(), as the harness rings).
import { describe, round } from "./stats.mjs";

export const TTFF_TARGET_MS = 10000;

// One launch: `clickAt` the hand-over, `presents` the drained presentations
// ({ t, vi }: vi = VI outputs since boot at that present, -1 when the core
// cannot say), `loadedAt` when the adapter said the core was loaded,
// `contentTimes` when the page saw a new, non-uniform picture (the first one
// at or after the first core frame counts; earlier ones are the page's own
// loading screens). The worker presents before the core has output anything
// (vi 0, the boot's empty frames, measured on 2026-10-19): the first frame
// is the first present that carries a VI output of the core.
export function launchTtff({ clickAt, presents = [], loadedAt = null, contentTimes = [], error = null }) {
  const after = presents.filter((p) => p.t >= clickAt);
  const first = after.find((p) => p.vi !== 0);
  const since = (t) => (Number.isFinite(t) && t >= clickAt ? round(t - clickAt, 0) : null);
  return {
    firstPresentMs: first == null ? null : round(first.t - clickAt, 0),
    firstEmptyPresentMs: after.length ? round(after[0].t - clickAt, 0) : null,
    coreLoadedMs: since(loadedAt),
    firstContentMs: first == null ? null : since(contentTimes.find((t) => t >= first.t)),
    error
  };
}

// Medians over the runs, per phase, and the verdict on the cold median. A
// run that started on an overloaded machine (load gate not passed) is left
// out, as race-perf leaves out overloaded windows.
export function summarizeTtff(runs, { target = TTFF_TARGET_MS } = {}) {
  const phase = (name) => {
    const got = runs.filter((r) => r.loadGate?.ok !== false).map((r) => r[name]).filter((l) => l && !l.error);
    if (!got.length) return null;
    return {
      runs: got.length,
      firstPresentMs: describe(got.map((l) => l.firstPresentMs), 0),
      coreLoadedMs: describe(got.map((l) => l.coreLoadedMs), 0),
      firstContentMs: describe(got.map((l) => l.firstContentMs), 0)
    };
  };
  const cold = phase("cold"), warm = phase("warm");
  const med = (p) => p?.firstPresentMs?.median ?? null;
  return {
    targetMs: target,
    overloadedRuns: runs.filter((r) => r.loadGate?.ok === false).map((r) => r.run),
    cold, warm,
    pass: med(cold) == null ? null : med(cold) < target && (med(warm) == null || med(warm) < target)
  };
}

// Page-side watcher, injected as an init script: once armed, it samples the
// screen canvas 10 times a second on a 16×16 grid and records when the
// picture changes to a non-uniform one (up to 200 times). Indicative only
// (±100 ms, and the canvas may refuse to be read); the KPI is the first
// presentation of a core frame.
export function installContentWatcher() {
  const w = window;
  w.__ttff = { armedAt: null, changes: [], error: null };
  const grid = async () => {
    const canvas = document.getElementById("screen");
    if (!canvas?.width) return null;
    const bitmap = await createImageBitmap(canvas);
    const small = new OffscreenCanvas(16, 16);
    const g = small.getContext("2d", { willReadFrequently: true });
    g.drawImage(bitmap, 0, 0, 16, 16);
    bitmap.close();
    const d = g.getImageData(0, 0, 16, 16).data;
    const lum = [];
    for (let i = 0; i < d.length; i += 4) lum.push((d[i] + d[i + 1] + d[i + 2]) / 3);
    return lum;
  };
  w.__ttffArm = async () => {
    let last = null;
    try { last = await grid(); } catch (e) { w.__ttff.error = String(e?.message || e); }
    w.__ttff.armedAt = performance.timeOrigin + performance.now();
    const tick = async () => {
      try {
        const lum = await grid();
        if (lum) {
          const spread = Math.max(...lum) - Math.min(...lum);
          const moved = !last || lum.some((v, i) => Math.abs(v - last[i]) > 16);
          if (spread > 24 && moved) w.__ttff.changes.push(performance.timeOrigin + performance.now());
          last = lum;
        }
      } catch (e) {
        w.__ttff.error = String(e?.message || e);
      }
      if (w.__ttff.changes.length < 200) setTimeout(tick, 100);
    };
    tick();
  };
}
