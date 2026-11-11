// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Patch 0224 (harness only): the real GPU time of each replay command buffer,
// by timestamp-query. Every render pass of a timed encoder gets a begin/end
// timestamp pair (up to MAX_PASSES); before finish the pairs are resolved and
// copied into one of READ_SLOTS mappable buffers; after the submit that buffer
// is mapped and the encoder's span (first pass begin -> last pass end) and busy
// time (sum of its passes) are logged with a sequence number and the submit's epoch time
// (performance.timeOrigin + now, the producedT clock) and reason. An encoder
// begun while every slot is still being read back is not timed (counted).
// The browser quantizes timestamps (Chrome: 100 us without
// --enable-webgpu-developer-features): the smallest non-zero step seen is
// published as minStepUs. No timestamp-query on the device: "absent".
export const MAX_PASSES = 64;
export const READ_SLOTS = 16;
export const LOG_SIZE = 1200;
const REASONS = ["present", "drain-boundary", "staging-oversize", "other"];

export function createGpuFrameTimer(device, { now = () => performance.timeOrigin + performance.now(), bufferUsage = globalThis.GPUBufferUsage, mapMode = globalThis.GPUMapMode } = {}) {
  if (!device?.features?.has?.("timestamp-query")) return { absent: true, snapshot: () => ({ gpuTimer: "absent" }) };
  const querySet = device.createQuerySet({ label: "0224-gpu-frame-time", type: "timestamp", count: 2 * MAX_PASSES });
  const resolve = device.createBuffer({ label: "0224-gpu-frame-resolve", size: 16 * MAX_PASSES, usage: bufferUsage.QUERY_RESOLVE | bufferUsage.COPY_SRC });
  const slots = Array.from({ length: READ_SLOTS }, (_, i) => ({ busy: false, buffer: device.createBuffer({ label: `0224-gpu-frame-read-${i}`, size: 16 * MAX_PASSES, usage: bufferUsage.MAP_READ | bufferUsage.COPY_DST }) }));
  const log = [];
  let current = null, untimed = 0, overflowPasses = 0, minStepNs = null, readErrors = 0, seq = 0;
  const noteStep = (d) => { if (d > 0n && (minStepNs == null || d < minStepNs)) minStepNs = d; };
  return {
    absent: false,
    // a new replay encoder: timed when a read-back slot is free
    beginEncoder() {
      const slot = slots.find((s) => !s.busy);
      if (!slot) { untimed += 1; current = null; return; }
      slot.busy = true;
      current = { slot, passes: 0 };
    },
    // the timestampWrites of the encoder's next render pass (null: untimed)
    passWrites() {
      if (!current) return null;
      if (current.passes >= MAX_PASSES) { overflowPasses += 1; return null; }
      const i = current.passes++;
      return { querySet, beginningOfPassWriteIndex: 2 * i, endOfPassWriteIndex: 2 * i + 1 };
    },
    // before finish(): resolve the encoder's pairs into its slot
    beforeFinish(encoder) {
      if (!current) return;
      if (current.passes === 0) { current.slot.busy = false; current = null; return; }
      encoder.resolveQuerySet(querySet, 0, 2 * current.passes, resolve, 0);
      encoder.copyBufferToBuffer(resolve, 0, current.slot.buffer, 0, 16 * current.passes);
    },
    // after the submit (submitted false: the slot is released unread)
    afterSubmit(reason, submitted) {
      const c = current;
      current = null;
      if (!c) return;
      if (!submitted || c.passes === 0) { c.slot.busy = false; return; }
      const t = now();
      const code = REASONS.includes(reason) ? REASONS.indexOf(reason) : 3;
      c.slot.buffer.mapAsync(mapMode.READ, 0, 16 * c.passes).then(() => {
        const v = new BigUint64Array(c.slot.buffer.getMappedRange(0, 16 * c.passes).slice(0));
        c.slot.buffer.unmap();
        c.slot.busy = false;
        let busy = 0n, first = null, last = null;
        for (let i = 0; i < c.passes; i += 1) {
          const b = v[2 * i], e = v[2 * i + 1];
          if (e >= b) { busy += e - b; noteStep(e - b); }
          if (first == null || b < first) first = b;
          if (last == null || e > last) last = e;
        }
        log.push([t, Number(last - first) / 1e6, Number(busy) / 1e6, c.passes, code, seq++]);
        if (log.length > LOG_SIZE) log.splice(0, log.length - LOG_SIZE);
      }).catch(() => { readErrors += 1; c.slot.busy = false; });
    },
    // the last n entries: [submit epoch ms, span ms, busy ms, passes, reason code, sequence]
    // (the sequence lets a reader of overlapping snapshots drop repeats and see losses)
    snapshot(n = 600) {
      return { gpuTimer: "timestamp-query", gpuTimerMinStepUs: minStepNs == null ? null : Number(minStepNs) / 1000, gpuTimerUntimed: untimed, gpuTimerOverflowPasses: overflowPasses, gpuTimerReadErrors: readErrors, gpuFrameLog: log.slice(-n), gpuFrameLogReasons: REASONS };
    }
  };
}
