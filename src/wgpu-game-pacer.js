// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later

// ?presentpace=game: the vsync presenter's frames shown at the game's own
// pace, not at the first BeginFrame after they are queued. On a screen faster
// than the game (60 fps on 120 Hz ProMotion, 30 fps on 60 Hz) showing the
// oldest frame at every BeginFrame puts a frame that lands just after one
// BeginFrame and the next just before another on screen for 1 refresh, then
// 3: judder, where every frame should stay 2.
//
// The game's frame period P is the mean of the gaps between queued frames
// within half and twice their median (a stall or a burst's sliver left out,
// both sides alike: a late frame's long gap kept and its bunched successor's
// short one dropped made P 17.15 ms, a third refresh every 9 frames;
// alternating jitter averages out, which a trimmed mean does not: 23/43 ms
// gaps gave 34.3 for 33.4; the emulation speed is in it). Each frame
// then stays on screen a whole number of refreshes, P / refresh on average:
// an accumulator carries the fraction (2.002 at 59.94 fps on 120 Hz: 2, and
// 3 once in ~500 frames), so the cadence lives in BeginFrames, not in a time
// a jittery arrival can straddle (a clock in ms put frames 1 and 3 refreshes
// in turn once it sat near a BeginFrame). A frame not there at its
// BeginFrame (a slow frame, a dip) is shown when it comes, the previous
// picture repeated, and the count starts again from there (no burst to catch
// up). A frame that waited more than a period and a half refresh in the
// queue (the display fell behind the game) stays one refresh less (at one
// period flat, a display a tick behind after a late frame shortened and went
// late again every 10 frames). The game is paced only when P is
// at least PACE_MIN_SPAN refreshes: 60 fps on a 60 Hz screen keeps the
// presenter's own order, the same code path as without the switch.
//
// Arrival times only: the per-frame VI count (ViTag) exists with the harness
// only, and the product must pace the way the harness measures it.
// No timers, no WebGPU: times are the caller's (performance.now, rAF times).

// The game is paced when its frame period is at least this many refreshes.
export const PACE_MIN_SPAN = 1.33;
// P is measured over the last PERIOD_GAPS gaps, once there are PERIOD_MIN.
const PERIOD_GAPS = 64;
const PERIOD_MIN = 16;

// The mean of `gaps` within half and twice their median.
function periodOf(gaps) {
  const sorted = [...gaps].sort((a, b) => a - b);
  const median = sorted[sorted.length >> 1];
  let sum = 0, n = 0;
  for (const g of gaps) {
    if (g >= median / 2 && g <= 2 * median) {
      sum += g;
      n += 1;
    }
  }
  return sum / n;
}

export function createGamePacer() {
  // Display: the BeginFrame time the last frame went up, the refreshes it
  // stays (null: not paced, the next frame starts the count), the fraction.
  let shownAt = null;
  let stay = null;
  let carry = 0;
  // Arrival side: the last arrival, the gaps, P.
  let lastAt = null;
  const gaps = [];
  let period = null;
  const stats = { paced: 0, held: 0, late: 0, shortened: 0 };

  const pacing = (refreshMs) => period !== null && refreshMs > 0 && period >= PACE_MIN_SPAN * refreshMs;

  return {
    stats,
    // The game's frame period P (null before PERIOD_MIN gaps).
    get period() { return period; },

    // A frame queued at time `at` (P follows the gaps).
    stamp(at) {
      if (lastAt !== null && at > lastAt) {
        gaps.push(at - lastAt);
        if (gaps.length > PERIOD_GAPS) gaps.shift();
        if (gaps.length >= PERIOD_MIN) period = periodOf(gaps);
      }
      lastAt = at;
    },

    // The oldest queued frame at the BeginFrame of time `t` on a screen of
    // period `refreshMs`: "unpaced" (no count yet, or a game not slower than
    // PACE_MIN_SPAN refreshes: the presenter's own order), "due" or
    // "early". Pure: the count moves in shown().
    due(frame, t, refreshMs) {
      if (!frame || !pacing(refreshMs) || shownAt === null || stay === null) return "unpaced";
      // half a refresh of slack for the rAF's own jitter
      return t - shownAt >= (stay - 0.5) * refreshMs ? "due" : "early";
    },

    // `frame` went up at the BeginFrame of time `t` (`frame.at`: when it was
    // queued, same clock): the refreshes it stays.
    shown(frame, t, refreshMs) {
      if (!pacing(refreshMs)) {
        shownAt = t;
        stay = null;
        carry = 0;
        return;
      }
      // the previous frame stayed longer than its count: this one was late,
      // the count starts again from it
      if (stay !== null && shownAt !== null && t - shownAt >= (stay + 0.5) * refreshMs) {
        stats.late += 1;
        carry = 0;
      }
      if (stay !== null) stats.paced += 1;
      const exact = carry + period / refreshMs;
      stay = Math.max(1, Math.floor(exact + 0.5));
      carry = exact - stay;
      // waited over a period in the queue: the display is behind the game
      if (stay > 1 && Number.isFinite(frame?.at) && t - frame.at >= period + refreshMs / 2) {
        stay -= 1;
        carry = 0;
        stats.shortened += 1;
      }
      shownAt = t;
    },

    // A BeginFrame held an early frame back (the picture on screen stays).
    held() { stats.held += 1; },

    // The display order is broken (a frame shown outside a BeginFrame: a gap,
    // a late rAF, a hidden tab): the next frame starts the count. `arrival`:
    // the game's period too (a new core, a new device).
    reset({ arrival = false } = {}) {
      shownAt = null;
      stay = null;
      carry = 0;
      if (!arrival) return;
      lastAt = null;
      gaps.length = 0;
      period = null;
    }
  };
}

// Refreshes each game frame stayed on screen, for the HUD, over the last
// `windowMs` (10 s): at every BeginFrame tick(expected, now) when a new frame
// went up (`expected`: the refreshes its period covers, 1 at 60 fps on 60 Hz,
// 2 at 60 fps on 120 Hz), tick(null, now) when the picture stayed. A frame's
// count closes when the next one goes up. snapshot(now): buckets 1, 2, 3 and
// 4+, `repeats` (refreshes a frame stayed beyond its expected count) and
// `short` (frames that stayed less), over the window.
export function createRefreshHistogram({ windowMs = 10000 } = {}) {
  // closed frames: [time, refreshes, expected], oldest first
  const closed = [];
  let current = 0;
  let currentExpected = 1;
  const prune = (now) => {
    while (closed.length && closed[0][0] < now - windowMs) closed.shift();
  };
  return {
    tick(expected = null, now = 0) {
      if (expected !== null) {
        if (current > 0) closed.push([now, current, currentExpected]);
        prune(now);
        current = 1;
        currentExpected = Math.max(1, Math.round(expected));
      } else if (current > 0) {
        current += 1;
      }
    },
    snapshot(now = 0) {
      prune(now);
      const counts = [0, 0, 0, 0];
      let repeats = 0, short = 0;
      for (const [, n, e] of closed) {
        counts[Math.min(n, 4) - 1] += 1;
        if (n > e) repeats += n - e;
        else if (n < e) short += 1;
      }
      return { counts, repeats, short };
    },
    reset() {
      closed.length = 0;
      current = 0;
    }
  };
}

// The HUD's refresh cell from the worker's helper string (`refresh:` field):
// the shares of game frames that stayed 1/2/3/4+ refreshes, the repeats,
// the screen's rate and the pace, e.g. "0/99/1/0% rep3 120Hz pace"; "-"
// without the field (presentvsync off).
export function formatRefreshHistogram(helper) {
  const m = /\brefresh:(\d+)\/(\d+)\/(\d+)\/(\d+)\/rep(\d+)\/hz(\d+)\/(pace|nopace)/.exec(String(helper || ""));
  if (!m) return "-";
  const counts = m.slice(1, 5).map(Number);
  const total = counts.reduce((a, b) => a + b, 0);
  const shares = counts.map((c) => (total ? Math.round((100 * c) / total) : 0));
  return `${shares.join("/")}% rep${m[5]} ${m[6]}Hz ${m[7]}`;
}
