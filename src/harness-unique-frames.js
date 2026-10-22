// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later
// QA harness only: unique images per second. The presented-frame rate counts
// every present, including a game image shown again (a 15 fps game presents
// each image four times at 60 Hz); what the player sees move is the rate of
// presents whose image differs from the previous one. Off unless the harness
// starts it (validationUniqueFrames): then each present is sampled (a few
// full rows read back from the GPU), hashed, and compared, in present order,
// with the previous sampled present. Readbacks are asynchronous; at most
// MAX_IN_FLIGHT wait at once, the presents past that are not sampled
// (`skipped`) and break the chain of comparisons there.
export const SAMPLE_ROWS = 8;
export const MAX_IN_FLIGHT = 6;

// FNV-1a over the bytes of the sampled rows (32 bits).
export function hashRows(bytes, rowBytes, bytesPerRow, rows) {
  let h = 0x811c9dc5;
  for (let r = 0; r < rows; r += 1) {
    const base = r * bytesPerRow;
    for (let i = 0; i < rowBytes; i += 1) {
      h ^= bytes[base + i];
      h = Math.imul(h, 0x01000193);
    }
  }
  return h >>> 0;
}

// The rows sampled in a presented rectangle: evenly spaced, away from the edges.
export function sampleRowOffsets(height, rows = SAMPLE_ROWS) {
  const n = Math.max(1, Math.min(rows, height));
  return Array.from({ length: n }, (_, i) => Math.min(height - 1, Math.floor(((i + 0.5) * height) / n)));
}

// The counter: `sample()` is called at each present and returns a promise of
// the hash, or null when the present is not sampled.
export function createUniqueFrameCounter({ now = () => performance.now() } = {}) {
  let state = null;
  const fresh = () => ({ t0: now(), presents: 0, sampled: 0, compared: 0, changed: 0, skipped: 0, errors: 0, inFlight: 0, next: 0, done: 0, results: new Map(), last: null, lastError: null });
  // Results are folded in present order, whatever order the readbacks end in.
  const fold = () => {
    while (state.results.has(state.done)) {
      const h = state.results.get(state.done);
      state.results.delete(state.done);
      state.done += 1;
      if (h == null) { state.last = null; continue; } // a gap: no comparison across it
      if (state.last != null) {
        state.compared += 1;
        if (h !== state.last) state.changed += 1;
      }
      state.last = h;
    }
  };
  return {
    get active() { return state != null; },
    start() { state = fresh(); },
    onPresent(readback) {
      if (!state) return;
      const s = state;
      s.presents += 1;
      const seq = s.next++;
      if (s.inFlight >= MAX_IN_FLIGHT) {
        s.skipped += 1;
        s.results.set(seq, null);
        fold();
        return;
      }
      let p;
      try { p = readback(); } catch (error) { p = Promise.reject(error); }
      s.inFlight += 1;
      Promise.resolve(p).then((h) => {
        if (state !== s) return;
        s.sampled += 1;
        s.results.set(seq, h >>> 0);
      }, (error) => {
        if (state !== s) return;
        s.errors += 1;
        s.lastError = String(error?.message || error).slice(0, 200);
        s.results.set(seq, null);
      }).finally(() => {
        if (state !== s) return;
        s.inFlight -= 1;
        fold();
      });
    },
    // Waits (bounded) for the readbacks still in flight, then reports and stops.
    async stop({ waitMs = 2000 } = {}) {
      const s = state;
      if (!s) return { error: "unique-frame counter was not started" };
      const end = now() + waitMs;
      while (s.inFlight > 0 && now() < end) await new Promise((r) => setTimeout(r, 20));
      state = null;
      const windowMs = now() - s.t0;
      return {
        windowMs: Math.round(windowMs), presents: s.presents, sampled: s.sampled, compared: s.compared, changed: s.changed,
        skipped: s.skipped, errors: s.errors, lastError: s.lastError, stillInFlight: s.inFlight,
        // Share of presents showing a new image, over the compared pairs.
        uniqueShare: s.compared ? Math.round((s.changed / s.compared) * 10000) / 10000 : null,
        presentsPerSecond: windowMs > 0 ? Math.round((s.presents / windowMs) * 10000) / 10 : null,
        uniquePerSecond: windowMs > 0 && s.compared ? Math.round(((s.changed / s.compared) * s.presents / windowMs) * 10000) / 10 : null
      };
    }
  };
}
