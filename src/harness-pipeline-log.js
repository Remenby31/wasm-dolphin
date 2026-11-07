// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Harness pipeline diag (validationEnableHarness { pipeline: true }): the
// worker's side of a VI output's way to the screen, for the no-present
// analysis (harness/lib/no-present.mjs). With the core's swap ring (patch
// 0214: when the video thread pulled the swap, how far it was behind the
// FIFO), it says where a picture that missed its BeginFrame was late.
//   tag     the swap's ViTag record replayed by the worker (VI output, time)
//   queued  its present queued for the rAF (?presentvsync=1) or submitted
//   tick    a presenter rAF callback: its BeginFrame's frame time, the time
//           the callback ran, the output it showed (-1: none)
// Times on the harness clock (timeOrigin + now). One ring for the three,
// drained whole by validationReadTimeline; an overwritten entry is counted
// in `lost`, never dropped silently. Nothing is written unless the harness
// asked for it (the worker tests its flag before each call).
export const PIPELINE_TAG = 1;
export const PIPELINE_QUEUED = 2;
export const PIPELINE_TICK = 3;

export function createPipelineLog({ capacity = 32768 } = {}) {
  const ring = new Float64Array(capacity * 4);
  let head = 0, read = 0;
  const push = (kind, vi, t, a) => {
    const slot = (head % capacity) * 4;
    ring[slot] = kind;
    ring[slot + 1] = vi;
    ring[slot + 2] = t;
    ring[slot + 3] = a;
    head += 1;
  };
  return {
    tag(vi, t) { push(PIPELINE_TAG, vi ?? -1, t, 0); },
    queued(vi, t) { push(PIPELINE_QUEUED, vi ?? -1, t, 0); },
    tick(frameTime, cb, vi) { push(PIPELINE_TICK, vi ?? -1, frameTime, cb); },
    // Everything since the previous drain. An output the worker did not know
    // (no ViTag yet) is -1: the reader leaves it out.
    drain() {
      const first = Math.max(read, head - capacity);
      const out = { tags: { vi: [], t: [] }, queued: { vi: [], t: [] }, ticks: { t: [], cb: [], vi: [] }, lost: first - read };
      for (let n = first; n < head; n += 1) {
        const slot = (n % capacity) * 4;
        const kind = ring[slot], vi = ring[slot + 1], t = ring[slot + 2], a = ring[slot + 3];
        if (kind === PIPELINE_TAG) { out.tags.vi.push(vi); out.tags.t.push(t); }
        else if (kind === PIPELINE_QUEUED) { out.queued.vi.push(vi); out.queued.t.push(t); }
        else if (kind === PIPELINE_TICK) { out.ticks.t.push(t); out.ticks.cb.push(a); out.ticks.vi.push(vi); }
      }
      read = head;
      return out;
    }
  };
}
