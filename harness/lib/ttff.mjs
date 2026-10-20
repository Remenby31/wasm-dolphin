// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
// Time to first frame (KPI "expérience joueur", target < 10 s): from the
// moment the disc is handed to the engine (the Play click) to the first
// picture of the game, cold (new profile) and warm (same profile, second
// visit). Pure: the probe (probes/ttff.mjs) feeds it timestamps, all on one
// clock (performance.timeOrigin + performance.now(), as the harness rings).
import { describe, round } from "./stats.mjs";

export const TTFF_TARGET_MS = 10000;

// One launch: `clickAt` the hand-over, `presents` the drained presentations
// ({ t, vi }: vi = VI outputs since boot at that present, -1 when the core
// cannot say), `loadedAt` when the adapter said the core was loaded,
// `contentTimes` when the page saw a new non-uniform picture (so neither
// black nor blank). The worker presents before the core has output anything
// (vi 0, the boot's empty frames, measured on 2026-10-19), and the page
// changes the canvas while loading: the KPI is the first non-uniform picture
// at or after the first present that carries a VI output of the core (vi > 0).
// A launch without one is a failure, with its reason.
export function launchTtff({ clickAt, presents = [], loadedAt = null, contentTimes = [], watcherError = null, timeoutSec = null }) {
  const after = presents.filter((p) => p.t >= clickAt);
  const first = after.find((p) => p.vi > 0);
  const since = (t) => (Number.isFinite(t) && t >= clickAt ? round(t - clickAt, 0) : null);
  const firstContentMs = first == null ? null : since(contentTimes.find((t) => t >= first.t));
  const within = timeoutSec ? ` within ${timeoutSec} s` : "";
  const error = first == null ? `no core frame presented${within}${after.some((p) => p.vi < 0) ? " (the core does not report VI outputs)" : ""}`
    : firstContentMs == null ? `no picture after the first core frame${within}${watcherError ? ` (canvas: ${watcherError})` : ""}`
      : null;
  return {
    firstContentMs,
    firstPresentMs: first == null ? null : round(first.t - clickAt, 0),
    firstEmptyPresentMs: after.length ? round(after[0].t - clickAt, 0) : null,
    coreLoadedMs: since(loadedAt),
    error
  };
}

// Per phase: medians over the successful launches and every failed one. A
// failure counts: the phase does not pass while any launch failed. A run
// that started on an overloaded machine (load gate not passed) is left out
// and listed, as race-perf leaves out overloaded windows; so is a launch the
// harness lost Chrome in (infraCrash, a CDP pipe fault).
export function summarizeTtff(runs, { target = TTFF_TARGET_MS } = {}) {
  const judged = runs.filter((r) => r.loadGate?.ok !== false);
  const phase = (name) => {
    const all = judged.map((r) => ({ run: r.run, l: r[name] ?? { error: "not run" } }));
    const infra = all.filter((x) => x.l.infraCrash).map((x) => ({ run: x.run, why: x.l.infraCrash }));
    const launches = all.filter((x) => !x.l.infraCrash);
    if (!launches.length) return infra.length ? { runs: 0, failed: [], infra, firstContentMs: null, pass: null } : null;
    const ok = launches.filter((x) => !x.l.error).map((x) => x.l);
    const failed = launches.filter((x) => x.l.error).map((x) => ({ run: x.run, error: x.l.error }));
    const firstContentMs = describe(ok.map((l) => l.firstContentMs), 0);
    return {
      runs: launches.length, failed, infra,
      firstContentMs,
      firstPresentMs: describe(ok.map((l) => l.firstPresentMs), 0),
      coreLoadedMs: describe(ok.map((l) => l.coreLoadedMs), 0),
      pass: failed.length ? false : firstContentMs.median == null ? null : firstContentMs.median < target
    };
  };
  const cold = phase("cold"), warm = phase("warm");
  return {
    targetMs: target,
    overloadedRuns: runs.filter((r) => r.loadGate?.ok === false).map((r) => r.run),
    cold, warm,
    pass: !cold || !warm ? null : cold.pass === false || warm.pass === false ? false : cold.pass && warm.pass
  };
}

// Page-side watcher, injected as an init script: once armed, it samples the
// screen canvas 10 times a second on a 16×16 grid and records when the
// picture changes to a non-uniform one (up to 200 times): ±100 ms. A canvas
// that cannot be read leaves no picture, so the launch fails with the reason.
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

// The first-launch optimisation (P7) as one launch saw it, from
// validationReadAotProgress (lib/aot-progress.mjs): its state, and the
// regions installed from the cache before boot (the "install" event: a
// second launch with the cache has loaded > 0). Null for an engine without P7.
export function aotLaunchInfo(reply) {
  if (!reply || reply.error || !reply.schema) return null;
  const install = (reply.events ?? []).find((e) => e.type === "install");
  const done = (reply.events ?? []).find((e) => e.type === "done");
  return {
    state: reply.state ?? null,
    install: install ? { loaded: install.loaded ?? null, failed: install.failed ?? null, deferred: install.deferred ?? null, ms: install.ms ?? null } : null,
    done: done ? { ms: done.ms ?? null, compiled: done.compiled ?? null, total: done.total ?? null } : null
  };
}

// Whether a state means the recompiler does not run (off, or a core without it).
export const aotInactive = (state) => state == null || state === "disabled" || state === "unsupported";

// Per phase: the optimisation states seen, and the regions installed at boot
// (a warm launch measured with the region cache has them all > 0).
export function summarizeAot(runs) {
  const phase = (name) => {
    const infos = runs.map((r) => r[name]?.aot).filter(Boolean);
    if (!infos.length) return null;
    const loaded = infos.map((a) => a.install?.loaded ?? 0);
    return {
      states: [...new Set(infos.map((a) => a.state))],
      regionsInstalled: loaded,
      withRegionCache: infos.every((a) => !aotInactive(a.state)) && loaded.every((n) => n > 0),
      settled: infos.map((a) => a.settled ?? null)
    };
  };
  const cold = phase("cold"), warm = phase("warm");
  return cold || warm ? { cold, warm } : null;
}
