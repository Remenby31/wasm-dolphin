// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Occupancy per stats window (500 ms, updatePresentationFps), 0..1 or null.
// The site needs margin on all three (each under ~0.7) before it trusts a
// cadence below the VI rate.
//
// - cpuThreadBusy: share of host time the emulated CPU thread was busy, from
//   the headroom counters (patch 0113, DolphinWeb_HeadroomStats, layout v1).
//   Same definition as harness/lib/headroom.mjs: busy = window - throttle
//   sleep - FlushGpu wait, over the window (host time of the CPU thread).
// - gpuThreadBusy: share of the same window the emulated GPU thread worked:
//   GPU work - waits for the render worker - present sleep (the harness's
//   maxSpeedGpu work). With SyncOnSkipIdle off (the product) the CPU thread
//   runs ahead and sleeps while the GPU thread may be saturated: this is the
//   share that says so. null when the GPU loop did not run in the window
//   (deterministic GPU thread, single core, idle GPU: no GPU work counted).
// - replayBusy: share of host time this worker (the WebGPU replay worker)
//   was busy, from a busy clock (createBusyClock) around its product entry
//   points plus the mapped staging pool's remap callbacks. Counted (each
//   once, the outermost wins): the presentation loop (each run, every
//   scheduler: MessageChannel, timers, frame-signal waits), the replay pump,
//   every command-ring drain whoever calls it, the vsync present (rAF tick
//   and fallback timer), the page's messages (their synchronous part), the
//   CPU thread's JIT messages (new compile, compile request: synchronous
//   part), the EFB readbacks' completion (WgpuReadback: texels written to
//   RAM), the disc reads served here (WORKERFS), and the pool's
//   getMappedRange (its own metric, a promise callback: never nested).
//   Not counted: the continuations after an await (the JIT's async compile,
//   message handlers that await), Emscripten's own pthread proxying, the
//   user-data mirror timer, the GPU timestamp readback of the display filter
//   (a few µs), and diagnostic or harness paths (visual cadence samples,
//   input visual markers, the detached presenter, harness captures, dtrace,
//   first-EFB-pass and classifier probes). Cost: two performance.now() per
//   counted entry, nothing per command.
//
// Deltas against the previous read, never a reset: the harness resets the
// headroom counters per measurement window (n >= 0). A reset between two
// reads makes a counter go back (null for that window), or, when every
// counter is already past the previous read again, the window grows by far
// less than the host time (null too). A CPU thread that did not throttle for
// most of the window (paused, stalled) gives null the same way. The GPU
// thread zeroes its own counters at its first pass after the reset: its
// counters going back one read later give null too.

export const HEADROOM_LAYOUT_VERSION = 1;
export const HEADROOM_LAYOUT_BYTES = 96;
// f64 fields after the 16-byte header (harness/lib/headroom.mjs F64).
const WINDOW_US = 0, CPU_SLEEP_US = 1, GPU_WORK_US = 2, FLUSH_GPU_WAIT_US = 5, GPU_CONSUMER_WAIT_US = 7, GUEST_TICKS = 8, PRESENT_SLEEP_US = 9;
const FIELDS = 10;

const round3 = (v) => Math.round(v * 1000) / 1000;

// busy over span, clamped to 0..1; null when either is unusable.
export function clampShare(busy, span) {
  if (!Number.isFinite(busy) || !Number.isFinite(span) || !(span > 0)) return null;
  return round3(Math.min(1, Math.max(0, busy / span)));
}

// The counters of the 0113 struct at ptr in buffer: null when the
// struct is missing, of another layout, invalid or torn (copied twice as
// whole f64s, as harnessHeadroomStats does; a field that went back between
// the copies is a reset in between); { on: false } while the counters are off.
export function readHeadroomStats(buffer, ptr) {
  if (!buffer || !ptr || ptr % 8 !== 0 || ptr + HEADROOM_LAYOUT_BYTES > buffer.byteLength) return null;
  const head = new Uint32Array(buffer, ptr, 4);
  if (head[0] !== HEADROOM_LAYOUT_VERSION || head[1] < HEADROOM_LAYOUT_BYTES) return null;
  if (head[2] !== 1) return { on: false };
  const view = new Float64Array(buffer, ptr + 16, FIELDS);
  const a = view.slice(), b = view.slice();
  for (let i = 0; i < FIELDS; i += 1) {
    if (!Number.isFinite(a[i]) || a[i] < 0 || b[i] < a[i]) return null;
  }
  return {
    on: true, windowUs: a[WINDOW_US], cpuSleepUs: a[CPU_SLEEP_US], flushGpuWaitUs: a[FLUSH_GPU_WAIT_US], guestTicks: a[GUEST_TICKS],
    gpuWorkUs: a[GPU_WORK_US], gpuConsumerWaitUs: a[GPU_CONSUMER_WAIT_US], presentSleepUs: a[PRESENT_SLEEP_US]
  };
}

// The CPU window between two reads, in µs: null when unusable (off,
// missing, a reset in between, a CPU thread that did not throttle).
function windowDeltaUs(prev, cur, hostMs) {
  if (!prev?.on || !cur?.on) return null;
  const dWindow = cur.windowUs - prev.windowUs;
  const dSleep = cur.cpuSleepUs - prev.cpuSleepUs;
  const dFlush = cur.flushGpuWaitUs - prev.flushGpuWaitUs;
  const dTicks = cur.guestTicks - prev.guestTicks;
  // a counter went back: reset in between
  if (!(dWindow > 0) || dSleep < 0 || dFlush < 0 || dTicks < 0) return null;
  // reset in between with every counter past the previous read again, or a
  // CPU thread that did not throttle for most of the window
  if (Number.isFinite(hostMs) && hostMs > 0 && dWindow < hostMs * 500) return null;
  return dWindow;
}

// prev, cur: readHeadroomStats results; hostMs: host time between the reads.
export function cpuThreadBusyShare(prev, cur, hostMs) {
  const dWindow = windowDeltaUs(prev, cur, hostMs);
  if (dWindow == null) return null;
  const dSleep = cur.cpuSleepUs - prev.cpuSleepUs;
  const dFlush = cur.flushGpuWaitUs - prev.flushGpuWaitUs;
  // the sleep is added after the window's last update: a few % either way
  // at the edges, clamped
  return clampShare(dWindow - dSleep - dFlush, dWindow);
}

// Same reads, same window: the GPU thread's work over the CPU thread's
// window (the harness's denominator too). null when the GPU loop did not run.
export function gpuThreadBusyShare(prev, cur, hostMs) {
  const dWindow = windowDeltaUs(prev, cur, hostMs);
  if (dWindow == null) return null;
  const dWork = cur.gpuWorkUs - prev.gpuWorkUs;
  const dConsumer = cur.gpuConsumerWaitUs - prev.gpuConsumerWaitUs;
  const dPresent = (cur.presentSleepUs ?? 0) - (prev.presentSleepUs ?? 0);
  // the GPU thread zeroed its counters (a reset) or did not run
  if (!Number.isFinite(dWork) || !(dWork > 0) || !(dConsumer >= 0) || !(dPresent >= 0)) return null;
  return clampShare(dWork - dConsumer - dPresent, dWindow);
}

// prevMs, curMs: the worker's cumulative busy time (null when unavailable).
export function replayBusyShare(prevMs, curMs, hostMs) {
  if (prevMs == null || curMs == null) return null;
  const d = curMs - prevMs;
  if (!(d >= 0)) return null;
  return clampShare(d, hostMs);
}

// The worker's busy time: run(fn, ...args) times fn unless another run is
// already timing (a drain inside the presentation loop counts once).
// totalMs(at) includes the run in progress, so it never goes back.
export function createBusyClock(now = () => performance.now()) {
  let depth = 0, startedAt = 0, total = 0;
  return {
    run(fn, ...args) {
      if (depth > 0) return fn(...args);
      depth = 1;
      startedAt = now();
      try {
        return fn(...args);
      } finally {
        total += Math.max(0, now() - startedAt);
        depth = 0;
      }
    },
    totalMs(at = now()) {
      return total + (depth > 0 ? Math.max(0, at - startedAt) : 0);
    }
  };
}

// One read per window; the shares of the span since the previous read.
export function createOccupancyMeter() {
  let prev = null;
  return {
    // atMs: host time of the read; headroom: readHeadroomStats(); busyMs:
    // the worker's cumulative busy time or null.
    window({ atMs, headroom = null, busyMs = null }) {
      const span = prev ? atMs - prev.atMs : 0;
      const out = prev
        ? {
            cpuThreadBusy: cpuThreadBusyShare(prev.headroom, headroom, span),
            gpuThreadBusy: gpuThreadBusyShare(prev.headroom, headroom, span),
            replayBusy: replayBusyShare(prev.busyMs, busyMs, span)
          }
        : { cpuThreadBusy: null, gpuThreadBusy: null, replayBusy: null };
      prev = { atMs, headroom, busyMs };
      return out;
    },
    reset() {
      prev = null;
    }
  };
}
