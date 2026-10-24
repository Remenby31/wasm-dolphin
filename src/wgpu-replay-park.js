// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

// The replay pump parks on an empty ring instead of polling it (patch 0148).
// The consumer sets WGPU_PROTOCOL_CONSUMER_PARKED_FLAG in protocol_flags, then
// waits (Atomics.waitAsync) on the write index for the value it last saw. The
// producer (WebGPUCommandStream::WakeParkedConsumer) stores the write index,
// then reads the flag and notifies only when it is set. Both sides are
// sequentially consistent, so either the producer sees the flag, or the wait
// sees the new write index and does not sleep: no wakeup is lost. A core
// without 0148 never notifies: the wait times out, as the old 4 ms poll.

import { WGPU_PROTOCOL_FLAGS_HEADER_INDEX } from "./wgpu-ring-backpressure.js";

export const WGPU_RING_WRITE_HEADER_INDEX = 0;
export const WGPU_PROTOCOL_CONSUMER_PARKED_FLAG = 1 << 31;

// Parks on the write index while it still reads `observedWrite`. Returns
// { async: true, value: Promise<"ok"|"timed-out"> } when it sleeps, or
// { async: false, value: "not-equal" } when the producer already moved (the
// flag is then cleared). Null without Atomics.waitAsync (caller polls).
// Tests: `waitAsync` replaces Atomics.waitAsync; `afterFlag` runs between the
// two steps (the flag set, the wait registered).
export function parkWgpuReplay(headerI32, observedWrite, timeoutMs, { waitAsync = Atomics.waitAsync, afterFlag } = {}) {
  if (typeof waitAsync !== "function") return null;
  Atomics.or(headerI32, WGPU_PROTOCOL_FLAGS_HEADER_INDEX, WGPU_PROTOCOL_CONSUMER_PARKED_FLAG);
  afterFlag?.();
  const wait = waitAsync.call(Atomics, headerI32, WGPU_RING_WRITE_HEADER_INDEX, observedWrite | 0, timeoutMs);
  if (!wait.async) unparkWgpuReplay(headerI32);
  return wait;
}

export function unparkWgpuReplay(headerI32) {
  Atomics.and(headerI32, WGPU_PROTOCOL_FLAGS_HEADER_INDEX, ~WGPU_PROTOCOL_CONSUMER_PARKED_FLAG);
}

// The producer's side, as WebGPUCommandStream does it (for tests and the
// JS producers of the harness): publish, then wake a parked consumer.
// Tests: `afterStore` runs between the two steps.
export function publishWgpuWriteIndex(headerI32, write, { afterStore } = {}) {
  Atomics.store(headerI32, WGPU_RING_WRITE_HEADER_INDEX, write | 0);
  afterStore?.();
  if ((Atomics.load(headerI32, WGPU_PROTOCOL_FLAGS_HEADER_INDEX) & WGPU_PROTOCOL_CONSUMER_PARKED_FLAG) !== 0) {
    Atomics.notify(headerI32, WGPU_RING_WRITE_HEADER_INDEX);
  }
}

// The pump's side: one park at a time, with its counters. A cancel makes a
// pending park stale (its wake runs nothing) and clears the flag.
//   park(ring, observedWrite, pump): false when this engine cannot wait (the
//     caller polls); otherwise the pump runs once the producer publishes, the
//     wait times out, or at once (schedule(pump, 0)) if the producer already
//     moved.
export function createWgpuReplayParker({ stats, schedule, isCurrentRing = () => true, waitAsync = Atomics.waitAsync, timeoutMs = 4 }) {
  let generation = 0;
  let parked = false;
  return {
    get parked() { return parked; },
    park(ring, observedWrite, pump) {
      const wait = ring?.headerI32 ? parkWgpuReplay(ring.headerI32, observedWrite, timeoutMs, { waitAsync }) : null;
      if (!wait) return false;
      stats.replayPumpParkCount += 1;
      if (!wait.async) {
        stats.replayPumpParkNotEqualCount += 1;
        schedule(pump, 0);
        return true;
      }
      const mine = generation;
      parked = true;
      wait.value.then((outcome) => {
        if (mine !== generation || !isCurrentRing(ring)) return;
        parked = false;
        unparkWgpuReplay(ring.headerI32);
        if (outcome === "ok") stats.replayPumpParkNotifiedCount += 1;
        else {
          stats.replayPumpParkTimedOutCount += 1;
          if ((Atomics.load(ring.headerI32, WGPU_RING_WRITE_HEADER_INDEX) >>> 0) !== (observedWrite >>> 0)) {
            stats.replayPumpParkTimedOutWithDataCount += 1;
          }
        }
        pump();
      });
      return true;
    },
    cancel(ring) {
      generation += 1;
      if (parked && ring?.headerI32) unparkWgpuReplay(ring.headerI32);
      parked = false;
    },
  };
}
