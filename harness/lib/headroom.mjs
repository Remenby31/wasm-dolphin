// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
// The headroom KPI (research/deep-headroom-kpi.md §3): how fast the game
// could run, measured at speed=1 where it runs as the player sees it.
//   maxSpeedCpu = guest seconds / (host seconds - throttle sleep of the CPU
//                 thread)   (Dolphin's own "Max", PerformanceMetrics.cpp)
//   maxSpeedGpu = guest seconds / GPU-thread work
//   headroom    = min(maxSpeedCpu, maxSpeedGpu)
// The counters come from the core (patch 0113, DolphinWeb_HeadroomStats),
// reset just before the window and read just after; the guest seconds from
// the core ticks read at the same two moments.
// Layout v1 (96 bytes, little-endian): u32 version, sizeBytes, on, reserved;
// f64 windowUs (host time since the reset), cpuSleepUs (throttle sleep of
// the CPU thread), gpuWorkUs (GPU-thread passes that ran the FIFO or pulled
// events), xfbCopies, rushSkips, flushGpuWaitUs and flushGpuWaits (the CPU
// thread waiting for the GPU in FlushGpu, with SyncOnSkipIdle on),
// gpuConsumerWaitUs (inside those passes, the GPU thread waiting for ring or
// upload space from the render worker), guestTicks (core ticks since the
// reset, written at the same instant as windowUs), one spare.
// maxSpeedGpu = guest s / (GPU work - consumer wait): waiting on the render
// worker is not the emulated GPU's work. With the deterministic GPU thread
// the GPU loop does not run: maxSpeedGpu is null. PushBlockingEvent and
// SyncGPU waits count as CPU busy time (they are off by default).
// maxSpeedCpu leaves the CPU's waits out (sleep and FlushGpu): what limits it
// then is the GPU, which maxSpeedGpu covers.
import { round } from "./stats.mjs";

export const HEADROOM_VERSION = 1;
export const HEADROOM_BYTES = 96;
const F64 = ["windowUs", "cpuSleepUs", "gpuWorkUs", "xfbCopies", "rushSkips", "flushGpuWaitUs", "flushGpuWaits", "gpuConsumerWaitUs", "guestTicks"];

export function decodeHeadroomStats(bytes) {
  if (!bytes || bytes.length < 16) return { error: `headroom stats: ${bytes?.length ?? 0} bytes, no header` };
  const view = new DataView(Uint8Array.from(bytes).buffer);
  const version = view.getUint32(0, true), size = view.getUint32(4, true);
  if (version !== HEADROOM_VERSION) return { error: `headroom stats: layout version ${version}, this harness reads ${HEADROOM_VERSION}` };
  if (size < HEADROOM_BYTES || bytes.length < HEADROOM_BYTES) return { error: `headroom stats: struct of ${size} bytes (${bytes.length} copied), v1 needs ${HEADROOM_BYTES}` };
  const out = { on: view.getUint32(8, true) === 1 };
  F64.forEach((name, i) => { out[name] = view.getFloat64(16 + i * 8, true); });
  for (const name of F64) if (!Number.isFinite(out[name]) || out[name] < 0) return { error: `headroom stats: ${name} = ${out[name]}` };
  if (out.cpuSleepUs + out.flushGpuWaitUs > out.windowUs * 1.001) return { error: `headroom stats: CPU waits ${out.cpuSleepUs + out.flushGpuWaitUs} µs > windowUs ${out.windowUs}` };
  return out;
}

export function consistentHeadroomRead(a, b) {
  if (a.error) return a;
  if (b.error) return b;
  const back = F64.filter((f) => b[f] < a[f]);
  return back.length ? { error: `headroom stats: torn read (${back.join(", ")} went backwards)` } : a;
}

// One window's headroom. guestSeconds: by default the core's own guestTicks
// / ticksPerSecond (same instant as windowUs); viOutputs: VI outputs in the
// window.
export function headroomOf(s, { guestSeconds = null, ticksPerSecond = null, viOutputs = null } = {}) {
  if (s && !s.error && ticksPerSecond > 0 && s.guestTicks > 0) guestSeconds = s.guestTicks / ticksPerSecond;
  if (!s || s.error) return { error: s?.error ?? "no headroom stats" };
  if (!s.on) return { error: "headroom stats: counters not on" };
  if (!(guestSeconds > 0) || !(s.windowUs > 0)) return { error: `headroom stats: ${guestSeconds} guest s over ${s.windowUs} µs` };
  const hostS = s.windowUs / 1e6, sleepS = s.cpuSleepUs / 1e6, flushS = s.flushGpuWaitUs / 1e6;
  const consumerS = s.gpuConsumerWaitUs / 1e6, gpuS = Math.max(0, s.gpuWorkUs / 1e6 - consumerS);
  const sleepShare = sleepS / hostS;
  const busyS = hostS - sleepS - flushS;
  const maxSpeedCpu = busyS > 0 ? guestSeconds / busyS : null;
  const maxSpeedGpu = gpuS > 0 ? guestSeconds / gpuS : null;
  const parts = [maxSpeedCpu, maxSpeedGpu].filter((v) => v != null);
  return {
    speed: round(guestSeconds / hostS, 4),
    maxSpeedCpu: maxSpeedCpu == null ? null : round(maxSpeedCpu, 4),
    maxSpeedGpu: maxSpeedGpu == null ? null : round(maxSpeedGpu, 4),
    headroom: parts.length ? round(Math.min(...parts), 4) : null,
    // Under 2 % of sleep the game runs below 100 %: speed is the number then.
    headroomApplies: sleepShare >= 0.02,
    throttleSleepShare: round(sleepShare, 4),
    gpuBusyShare: round(gpuS / hostS, 4),
    flushGpuWaitShare: round(flushS / hostS, 4),
    gpuConsumerWaitShare: round(consumerS / hostS, 4),
    rushSkips: s.rushSkips,
    xfbCopiesPerVi: viOutputs > 0 ? round(s.xfbCopies / viOutputs, 4) : null,
    guestSeconds: round(guestSeconds, 3)
  };
}

// Why a run cannot be used (deep-headroom-kpi.md §3.4), or [].
//   target: the query's speed (1, 1.6, …); framesPerViRef: game frames per
//   VI of the same config at speed=1, when known.
export function invalidReasons(rec, { target = null, framesPerViRef = null } = {}) {
  const why = [];
  if (!rec) return ["no record"];
  if (rec.complete === false || rec.timelineLost?.vi > 0 || rec.timelineLost?.presents > 0) {
    why.push(`timeline incomplete (a ring overflowed: ${rec.timelineLost?.vi ?? "?"} VI, ${rec.timelineLost?.presents ?? "?"} presents lost)`);
  }
  if (target != null && rec.speed != null && rec.speed > target * 100 * 1.02) why.push(`speed ${rec.speed} % above the target ${target * 100} % × 1.02: the throttle did not hold`);
  if (rec.uniqueFrames && rec.uniqueFrames.uniqueShare === 0) why.push("no unique image in the unique-frames window");
  const fpv = rec.headroom?.xfbCopiesPerVi;
  if (framesPerViRef != null && fpv != null && Math.abs(fpv / framesPerViRef - 1) > 0.1) why.push(`game frames per VI ${fpv} outside ±10 % of ${framesPerViRef} (emulated time decoupled from rendering)`);
  return why;
}

// The speed a query asks for: a number, "unlimited", or null (default 1).
// unlimited is a speed only with SyncOnSkipIdle on (?synconidle=1): with it
// off (the product today), emulated time runs ahead of the rendering.
export const unlimitedAllowed = (query) => new URLSearchParams(String(query ?? "")).get("synconidle") === "1";

export function querySpeed(query) {
  const v = new URLSearchParams(String(query ?? "")).get("speed");
  if (v == null) return 1;
  if (v === "unlimited") return "unlimited";
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}
