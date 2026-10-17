// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
// One run → its performance report (QA-CHECKLIST.md §2-§3) and the
// correctness facts the gate needs. Timing comes from the complete
// timeline; the 1 Hz samples only add counters the timeline lacks (unique
// visual frames, audio underruns, CPU). Pure.
import { finite, mean, median, percentile } from "./stats.mjs";
import { coreStats, presentationStats } from "./timeline.mjs";

const delta = (a, b) => (Number.isFinite(a) && Number.isFinite(b) ? b - a : null);

export function summarizeRun({ samples = [], cpu = [], monitor = null, timeline = null, ticksPerSecond = null, windowEnd = null }) {
  const pick = (k) => samples.map((s) => s[k]);
  const first = samples[0] ?? {};
  const last = samples.at(-1) ?? {};
  const minutes = samples.length > 1 ? (last.t - first.t) / 60000 : 0;
  const present = timeline ? presentationStats(timeline) : null;
  const core = timeline ? coreStats(timeline, { ticksPerSecond, until: windowEnd }) : { supported: false };
  const errors = monitor?.errors;
  const transport = monitor?.transport;
  const swallowed = {
    uncaught: errors?.error ?? 0,
    unhandledRejections: errors?.unhandledrejection ?? 0,
    consoleErrors: errors?.consoleError ?? 0,
    unknownWorkerMessages: transport?.unknownMessagesReceived ?? 0,
    unmatchedWorkerErrors: transport?.unmatchedErrorRepliesReceived ?? 0
  };
  const underruns = delta(first.audioUnderruns, last.audioUnderruns);
  return {
    // Emulated speed from the VI timeline when the core has it; the app's
    // own (sampled) gameSpeed otherwise, flagged as such.
    speed: core.supported ? core.speed : median(pick("speed")),
    speedP5: core.supported ? core.speedP5 : percentile(pick("speed"), 5),
    speedMin: core.supported ? core.speedMin : finite(pick("speed")).length ? Math.min(...finite(pick("speed"))) : null,
    speedDips: core.supported ? core.speedDips : [],
    speedSource: core.supported ? "vi-timeline" : "sampled gameSpeed",
    vis: mean(pick("vis")),
    pres: present ? (present.presents / Math.max(1e-9, minutes * 60)) : mean(pick("pres")),
    frameP50: present?.frameP50 ?? null,
    frameP95: present?.frameP95 ?? null,
    frameP99: present?.frameP99 ?? null,
    frameMax: present?.frameMax ?? null,
    hitchesPerMin: present?.hitchesPerMin ?? null,
    presentFreezes: present?.freezes ?? [],
    coreFreezes: core.supported ? core.freezes : null,
    timelineComplete: timeline ? timeline.lost.presents === 0 && timeline.lost.vi === 0 : false,
    viTimeline: core.supported,
    frameAdvance: delta(first.frame, last.frame),
    jitc: last.jitc ?? null,
    audioUnderrunsPerMin: monitor?.audioAttached && minutes > 0 && underruns !== null ? underruns / minutes : null,
    audioPeak: monitor?.audioAttached ? monitor.audio?.peak ?? null : null,
    audioRms: monitor?.audioAttached ? monitor.audio?.rms ?? null : null,
    swallowed,
    errorCount: Object.values(swallowed).reduce((a, b) => a + (b ?? 0), 0),
    cpuTotal: median(cpu.map((c) => c.total)),
    cpuRenderer: median(cpu.map((c) => c.rendererMax)),
    cpuGpu: median(cpu.map((c) => c.gpu)),
    loadAvg: median(cpu.map((c) => c.load1))
  };
}
