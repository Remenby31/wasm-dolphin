// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later
//
// What the screen got, not what the worker submitted
// (research/deep-frame-pacing.md §3.1, step 0). Chrome pushes an
// OffscreenCanvas to the compositor at its BeginFrame and keeps only the
// last picture presented since the previous one: every other submission in
// between is dropped without a signal. A requestAnimationFrame of the worker
// runs at each BeginFrame; counting the submissions between two of them
// gives the pictures shown (one per BeginFrame that had any) and the ones
// dropped. Harness only: nothing runs unless the harness turns it on.

export function createDisplayCounter({ capacity = 16384 } = {}) {
  const t = new Float64Array(capacity);
  const submits = new Uint16Array(capacity);
  const vi = new Float64Array(capacity);
  let head = 0, read = 0, pending = 0, lastVi = -1, dropped = 0;
  return {
    // One presentation submitted to the canvas, showing VI output `viIndex`.
    submit(viIndex = -1) { pending += 1; lastVi = viIndex; },
    // A BeginFrame (the worker's rAF callback), at `now` on the harness
    // clock. One entry each: submits 0 = nothing new on screen, 1 = one
    // picture shown, n > 1 = shown one, dropped n - 1.
    beginFrame(now) {
      const slot = head % capacity;
      t[slot] = now;
      submits[slot] = Math.min(pending, 0xFFFF);
      vi[slot] = pending > 0 ? lastVi : -1;
      head += 1;
      if (pending > 1) dropped += pending - 1;
      pending = 0;
    },
    // The BeginFrames since the previous drain (shape of validationReadTimeline).
    drain() {
      const first = Math.max(read, head - capacity);
      const out = { t: [], submits: [], vi: [] };
      for (let n = first; n < head; n += 1) {
        out.t.push(t[n % capacity]);
        out.submits.push(submits[n % capacity]);
        out.vi.push(vi[n % capacity]);
      }
      const lost = first - read;
      read = head;
      return { displayed: out, displayedLost: lost, dropped };
    }
  };
}

// rAF of the worker, while `active()` holds. Returns a stop function.
export function startDisplayLoop(counter, { raf = globalThis.requestAnimationFrame, timeOrigin = performance.timeOrigin, active = () => true } = {}) {
  if (typeof raf !== "function") return null;
  let stopped = false;
  const tick = (frameTime) => {
    if (stopped || !active()) return;
    counter.beginFrame(timeOrigin + frameTime);
    raf(tick);
  };
  raf(tick);
  return () => { stopped = true; };
}
