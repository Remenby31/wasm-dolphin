// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later
//
// ?replaywake= (research/no-present-2p.md, lever 2): which 0 ms links of the
// replay pump's drain chain run from a MessageChannel task instead of
// setTimeout(0), clamped to 4 ms once five deep (a ViTag published meanwhile
// waited for it). Every fast link is one more drain, each with a fixed cost
// (replayBusy), so the modes bound them:
//   chain   every link
//   first   one link per burst: re-armed when the pump finds the ring empty
//           and parks; the links after it are timers again
//   spaced  a fast link only once the backlog grew by `records` since the
//           last fast one, or `ms` after it; a timer otherwise
//   off     none
// The worker supplies the write index and the time: no WebGPU, no timers here.
export const REPLAY_WAKE_MODES = Object.freeze(["chain", "first", "spaced"]);

export function createReplayWakePolicy(mode = "off", { records = 64, ms = 0.5 } = {}) {
  const m = REPLAY_WAKE_MODES.includes(mode) ? mode : "off";
  let armed = false, lastWrite = null, lastAt = -Infinity;
  return {
    mode: m,
    // the ring was found empty (the pump parks): =first may take a fast link again
    parked() { armed = true; },
    // a 0 ms link is due: fast (MessageChannel) or not (timer)
    fast(write, now) {
      if (m === "chain") return true;
      if (m === "first") {
        if (!armed) return false;
        armed = false;
        return true;
      }
      if (m === "spaced") {
        if (lastWrite != null && ((write - lastWrite) >>> 0) < records && now - lastAt < ms) return false;
        lastWrite = write >>> 0;
        lastAt = now;
        return true;
      }
      return false;
    }
  };
}
