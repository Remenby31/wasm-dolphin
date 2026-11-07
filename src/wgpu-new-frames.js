// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later
//
// New frames: the pictures whose Dolphin XFB is new, not the duplicate VI
// swaps that repeat one. Patch 0208 tags each SubmitPresent with the
// presenter's frame count (moves only on a new XFB) and a tag epoch (moves
// when the count goes back: a state load restores it, a boot restarts it).
// A tag of 0 is unknown (an older core, the software renderer, a smoke).
//
// - produced: a frame entering the present queue whose tag differs from the
//   last queued one;
// - shown: a frame put on the canvas whose tag differs from the last SHOWN
//   one, so a tag shown twice counts once;
// - out of order: a frame shown whose (epoch, tag) is older than the last
//   shown one: an older picture after a newer one. Counted, never as new,
//   and the last shown tag stays the newer one.
//
// Per present: two integer compares, no allocation.

export function createNewFrameCounter() {
  let queuedTag = 0, queuedEpoch = 0;
  let shownTag = 0, shownEpoch = 0;
  let produced = 0, shown = 0;
  // Since the last reset, for a mean over any span (the probes).
  let producedTotal = 0, shownTotal = 0;
  // A tagged present since the last reset: the rates mean something.
  let tagged = false;
  // Lifetime (never reset: the integrity gate takes deltas): null until the
  // first tagged present, so an untagged backend reports no counter at all.
  let outOfOrder = null;

  return {
    // A frame entering the present queue. True when its XFB is new.
    queued(tag, epoch = 0) {
      if (!tag) return false;
      tagged = true;
      if (tag === queuedTag && epoch === queuedEpoch) return false;
      queuedTag = tag;
      queuedEpoch = epoch;
      produced += 1;
      producedTotal += 1;
      return true;
    },

    // A frame put on the canvas: "new", "repeat" (the tag on screen
    // already), "older" (out of order) or "unknown" (no tag).
    shown(tag, epoch = 0) {
      if (!tag) return "unknown";
      tagged = true;
      outOfOrder ??= 0;
      if (tag === shownTag && epoch === shownEpoch) return "repeat";
      if (shownTag && (epoch < shownEpoch || (epoch === shownEpoch && tag < shownTag))) {
        outOfOrder += 1;
        return "older";
      }
      shownTag = tag;
      shownEpoch = epoch;
      shown += 1;
      shownTotal += 1;
      return "new";
    },

    // The rates over a window of `elapsedMs`, then the window restarts.
    // null for both while no tagged frame came since the last reset.
    window(elapsedMs) {
      const rate = (n) => (tagged && elapsedMs > 0 ? Math.round((n * 10000) / elapsedMs) / 10 : null);
      const out = { newFramesPerSec: rate(shown), newFramesProducedPerSec: rate(produced) };
      produced = 0;
      shown = 0;
      return out;
    },

    get outOfOrder() {
      return outOfOrder;
    },

    // New frames shown / produced since the last reset; null untagged.
    get shownTotal() {
      return tagged ? shownTotal : null;
    },
    get producedTotal() {
      return tagged ? producedTotal : null;
    },

    // A boot: the window, the last tags and whether frames are tagged go;
    // the lifetime out-of-order count stays.
    reset() {
      queuedTag = queuedEpoch = shownTag = shownEpoch = 0;
      produced = shown = producedTotal = shownTotal = 0;
      tagged = false;
    }
  };
}
