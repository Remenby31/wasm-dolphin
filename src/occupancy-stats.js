// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Occupancy per stats window (500 ms, updatePresentationFps), 0..1 or null:
//
// - cpuThreadBusy: share of host time the emulated CPU thread was busy, from
//   the headroom counters (patch 0113, DolphinWeb_HeadroomStats, layout v1).
//   Same definition as harness/lib/headroom.mjs: busy = window - throttle
//   sleep - FlushGpu wait, over the window (host time of the CPU thread).
// - replayBusy: share of host time this worker spent replaying: draining
//   the WebGPU command ring (webGpuCausalStats.drainTotalMs) plus the mapped
//   staging pool's remap callbacks (getMappedRange, outside any drain), over
//   the host window.
//
// Deltas against the previous read, never a reset: the harness resets the
// headroom counters per measurement window (n >= 0). A reset between two
// reads makes a counter go back (null for that window), or, when every
// counter is already past the previous read again, the window grows by far
// less than the host time (null too). A CPU thread that did not throttle for
// most of the window (paused, stalled) gives null the same way.
// No per-frame cost: two counter reads per window.

export const HEADROOM_LAYOUT_VERSION = 1;
export const HEADROOM_LAYOUT_BYTES = 96;
// f64 fields after the 16-byte header (harness/lib/headroom.mjs F64).
const WINDOW_US = 0, CPU_SLEEP_US = 1, FLUSH_GPU_WAIT_US = 5, GUEST_TICKS = 8;
const FIELDS = 10;

const round3 = (v) => Math.round(v * 1000) / 1000;

// busy over span, clamped to 0..1; null when either is unusable.
export function clampShare(busy, span) {
  if (!Number.isFinite(busy) || !Number.isFinite(span) || !(span > 0)) return null;
  return round3(Math.min(1, Math.max(0, busy / span)));
}

// The CPU-thread counters of the 0113 struct at ptr in buffer: null when the
// struct is missing, of another layout, invalid or torn (copied twice as
// whole f64s, as harnessHeadroomStats does; a field that went back between
// the copies is a reset in between); { on: false } while the counters are off.
export function readHeadroomCpu(buffer, ptr) {
  if (!buffer || !ptr || ptr % 8 !== 0 || ptr + HEADROOM_LAYOUT_BYTES > buffer.byteLength) return null;
  const head = new Uint32Array(buffer, ptr, 4);
  if (head[0] !== HEADROOM_LAYOUT_VERSION || head[1] < HEADROOM_LAYOUT_BYTES) return null;
  if (head[2] !== 1) return { on: false };
  const view = new Float64Array(buffer, ptr + 16, FIELDS);
  const a = view.slice(), b = view.slice();
  for (let i = 0; i < FIELDS; i += 1) {
    if (!Number.isFinite(a[i]) || a[i] < 0 || b[i] < a[i]) return null;
  }
  return { on: true, windowUs: a[WINDOW_US], cpuSleepUs: a[CPU_SLEEP_US], flushGpuWaitUs: a[FLUSH_GPU_WAIT_US], guestTicks: a[GUEST_TICKS] };
}

// prev, cur: readHeadroomCpu results; hostMs: host time between the reads.
export function cpuThreadBusyShare(prev, cur, hostMs) {
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
  // the sleep is added after the window's last update: a few % either way
  // at the edges, clamped
  return clampShare(dWindow - dSleep - dFlush, dWindow);
}

// prevMs, curMs: cumulative drain time (null when not collected).
export function replayBusyShare(prevMs, curMs, hostMs) {
  if (prevMs == null || curMs == null) return null;
  const d = curMs - prevMs;
  if (!(d >= 0)) return null;
  return clampShare(d, hostMs);
}

// One read per window; the shares of the span since the previous read.
export function createOccupancyMeter() {
  let prev = null;
  return {
    // atMs: host time of the read; cpu: readHeadroomCpu(); drainMs:
    // cumulative drain time or null.
    window({ atMs, cpu = null, drainMs = null }) {
      const out = prev
        ? {
            cpuThreadBusy: cpuThreadBusyShare(prev.cpu, cpu, atMs - prev.atMs),
            replayBusy: replayBusyShare(prev.drainMs, drainMs, atMs - prev.atMs)
          }
        : { cpuThreadBusy: null, replayBusy: null };
      prev = { atMs, cpu, drainMs };
      return out;
    },
    reset() {
      prev = null;
    }
  };
}
