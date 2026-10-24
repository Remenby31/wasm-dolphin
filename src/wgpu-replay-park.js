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
export function parkWgpuReplay(headerI32, observedWrite, timeoutMs) {
  if (typeof Atomics.waitAsync !== "function") return null;
  Atomics.or(headerI32, WGPU_PROTOCOL_FLAGS_HEADER_INDEX, WGPU_PROTOCOL_CONSUMER_PARKED_FLAG);
  const wait = Atomics.waitAsync(headerI32, WGPU_RING_WRITE_HEADER_INDEX, observedWrite | 0, timeoutMs);
  if (!wait.async) unparkWgpuReplay(headerI32);
  return wait;
}

export function unparkWgpuReplay(headerI32) {
  Atomics.and(headerI32, WGPU_PROTOCOL_FLAGS_HEADER_INDEX, ~WGPU_PROTOCOL_CONSUMER_PARKED_FLAG);
}

// The producer's side, as WebGPUCommandStream does it (for tests and the
// JS producers of the harness): publish, then wake a parked consumer.
export function publishWgpuWriteIndex(headerI32, write) {
  Atomics.store(headerI32, WGPU_RING_WRITE_HEADER_INDEX, write | 0);
  if ((Atomics.load(headerI32, WGPU_PROTOCOL_FLAGS_HEADER_INDEX) & WGPU_PROTOCOL_CONSUMER_PARKED_FLAG) !== 0) {
    Atomics.notify(headerI32, WGPU_RING_WRITE_HEADER_INDEX);
  }
}
