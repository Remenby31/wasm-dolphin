// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
// Rate limit for the worker's status relay (postStatus → page → console).
// A core stuck in a loop that logs (seen on 2026-10-21: an MMU "Invalid
// read" a million times in 31 s) floods the page and Chrome's browser
// process relays every line (about 45 MB/s): the browser swells past 10 GB
// and the worker stops answering. Here:
// - consecutive identical lines are folded: the first is relayed, the
//   repeats are counted, and "… repeated N times" is relayed when a
//   different line comes, or once per window while the repeats go on;
// - beyond `maxPerWindow` lines per `windowMs`, lines are counted without
//   being relayed, and one summary line is relayed when the window rolls;
// - lines `isFatal` says are fatal are always relayed.
// push(text) says whether the caller relays `text` now; the summaries go
// through `emit`. No timer: summaries are relayed on the next push once the
// window has passed (a loop keeps pushing; flush() relays what is pending).
// Pure: time and the relay are injected.

export function createStatusRateLimiter({
  emit,
  isFatal = () => false,
  maxPerWindow = 200,
  windowMs = 1000,
  now = () => performance.now(),
} = {}) {
  let last = null;
  let repeats = 0;
  let repeatsSince = 0;
  let windowStart = now();
  let sentInWindow = 0;
  let droppedInWindow = 0;
  const totals = { relayed: 0, folded: 0, dropped: 0 };

  const send = (text) => {
    totals.relayed += 1;
    emit(text);
  };
  const flushRepeats = (t) => {
    if (repeats > 0) send(`… repeated ${repeats} time${repeats > 1 ? "s" : ""}: ${last.slice(0, 200)}`);
    repeats = 0;
    repeatsSince = t;
  };
  const rollWindow = (t, force = false) => {
    if (!force && t - windowStart < windowMs) return;
    if (droppedInWindow > 0) {
      send(`[status] ${droppedInWindow} line(s) not relayed in ${Math.round(t - windowStart)} ms (rate cap ${maxPerWindow} per ${windowMs} ms)`);
    }
    windowStart = t;
    sentInWindow = 0;
    droppedInWindow = 0;
  };

  return {
    push(message) {
      const text = String(message);
      const t = now();
      rollWindow(t);
      if (isFatal(text)) {
        flushRepeats(t);
        last = text;
        totals.relayed += 1;
        return true;
      }
      if (text === last) {
        repeats += 1;
        totals.folded += 1;
        if (t - repeatsSince >= windowMs) flushRepeats(t); // a loop: the count goes out once per window
        return false;
      }
      flushRepeats(t);
      last = text;
      if (sentInWindow >= maxPerWindow) {
        droppedInWindow += 1;
        totals.dropped += 1;
        return false;
      }
      sentInWindow += 1;
      totals.relayed += 1;
      return true;
    },
    flush() {
      const t = now();
      flushRepeats(t);
      rollWindow(t, true);
    },
    stats: () => ({ ...totals }),
  };
}
