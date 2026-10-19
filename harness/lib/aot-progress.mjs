// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
// First-launch optimisation (plan piste 3, P7) as the harness sees it.
// Contract agreed with the P7 owner on 2026-10-19:
//   URL switch aot=1 (off by default): the worker installs the cached regions
//   before boot, then starts the optimisation (resume) once the disc boots.
//   validationReadAotProgress {drain?} → { schema: "wasm-dolphin.aot-progress.v1",
//     state: "none"|"running"|"partial"|"complete"|"unsupported"|"disabled",
//     events: [{ t, type: "start"|"progress"|"done"|"error"|"install",
//                fraction, done, total, unit: "regions", ms, message, fatal,
//                total/refused/compiled/deferred (done), loaded/failed/deferred (install) }] }
//   t = timeOrigin + now; ms = time since the start. The adapter also pushes
//   every event into window.__aotProgressLog.
// Pure: the probe (probes/first-launch.mjs) feeds it the events.
import { median, round } from "./stats.mjs";

export const AOT_PROGRESS_SCHEMA = "wasm-dolphin.aot-progress.v1";
export const OPTIMISATION_TARGET_MS = 60000;

// Why there is nothing to measure, or null when the engine has P7.
export function unavailable(reply, pageLog) {
  if (reply && !reply.error) {
    if (reply.schema !== AOT_PROGRESS_SCHEMA) return `progress schema ${reply.schema ?? "missing"}, this harness reads ${AOT_PROGRESS_SCHEMA}`;
    if (reply.state === "unsupported") return "the core has no production translation export yet (state unsupported)";
    if (reply.state === "disabled") return "the optimisation is off (state disabled: aot=1 not taken)";
    return null;
  }
  if (Array.isArray(pageLog)) return null;
  return `no P7 progress in this engine (${reply?.error ?? "no reply"}; no window.__aotProgressLog)`;
}

// One launch: duration, progress shape, what was compiled or installed.
export function summarizeLaunch(events) {
  const ev = [...events].sort((a, b) => a.t - b.t);
  const start = ev.find((e) => e.type === "start");
  const done = ev.find((e) => e.type === "done");
  const errors = ev.filter((e) => e.type === "error");
  const install = ev.find((e) => e.type === "install") ?? null;
  const progress = ev.filter((e) => e.type === "progress");
  const fractions = progress.map((e) => e.fraction).filter(Number.isFinite);
  const monotonic = fractions.every((f, i) => i === 0 || f >= fractions[i - 1]);
  const durationMs = done
    ? (Number.isFinite(done.ms) ? done.ms : start ? done.t - start.t : null)
    : null;
  return {
    started: Boolean(start),
    finished: Boolean(done),
    durationMs: round(durationMs, 0),
    startFraction: round(fractions[0] ?? null, 3),
    lastFraction: round(fractions.at(-1) ?? (done ? 1 : null), 3),
    total: done?.total ?? progress.at(-1)?.total ?? null,
    compiled: done?.compiled ?? null,
    progressEvents: progress.length,
    monotonic,
    install: install && { loaded: install.loaded ?? null, failed: install.failed ?? null, deferred: install.deferred ?? null, ms: install.ms ?? null },
    errors: errors.map((e) => ({ message: e.message, fatal: Boolean(e.fatal) })),
    window: start ? { from: start.t, to: done?.t ?? ev.at(-1).t } : null
  };
}

// Why a launch did not give its number, or null.
function launchFailure(l, what) {
  if (!l) return `${what}: not run`;
  if (l.error) return `${what}: ${l.error}`;
  if (l.unavailable) return `${what}: ${l.unavailable}`;
  const fatal = l.errors?.find((e) => e.fatal);
  if (fatal) return `${what}: fatal error "${fatal.message}"`;
  if (!l.finished) return `${what}: no "done" event${l.timedOut ? " before the timeout" : ""}`;
  if (what === "second launch" && !Number.isFinite(l.compiled)) return `${what}: "done" without a compiled count`;
  return null;
}

// The summary.json p7 block from the runs (first and second launch each).
// Every judged run counts: a launch that did not finish (or a second launch
// without its compiled count) is listed in `failed` and the block does not
// pass; the numbers are those of the launches that finished. Runs started on
// an overloaded machine (load gate not passed) are left out and listed. Null
// when no run could be judged.
export function summarizeP7(allRuns, { target = OPTIMISATION_TARGET_MS } = {}) {
  const runs = allRuns.filter((r) => r.loadGate?.ok !== false);
  if (!runs.length) return null;
  const failedFirst = [], failedSecond = [];
  const first = [], second = [];
  for (const r of runs) {
    const f = r.error ? `first launch: ${r.error}` : launchFailure(r.first, "first launch");
    if (f) { failedFirst.push({ run: r.run, why: f }); continue; }
    first.push(r.first);
    const s = launchFailure(r.second, "second launch");
    if (s) failedSecond.push({ run: r.run, why: s });
    else second.push(r.second);
  }
  const durationMs = median(first.map((l) => l.durationMs));
  const recompiled = second.map((l) => l.compiled);
  const secondLaunchCompiled = recompiled.length ? Math.max(...recompiled) : null;
  return {
    runs: runs.length,
    overloadedRuns: allRuns.filter((r) => r.loadGate?.ok === false).map((r) => r.run),
    durationMs: round(durationMs, 0),
    durationRuns: first.map((l) => l.durationMs),
    total: first[0]?.total ?? null,
    speedDuring: round(median(first.map((l) => l.speedDuring)), 1),
    failedFirst,
    secondLaunchCompiled,
    secondLaunchInstalled: median(second.map((l) => l.install?.loaded)),
    failedSecond,
    targetMs: target,
    pass: failedFirst.length || failedSecond.length || durationMs == null || secondLaunchCompiled == null ? false : durationMs < target && secondLaunchCompiled === 0
  };
}
