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
// late again every 10 frames). The game is paced once P reaches PACE_ON
// refreshes, until it falls under PACE_OFF: 60 fps on a 60 Hz screen keeps
// the presenter's own order, the same code path as without the switch.
//
// Arrival times only: the per-frame VI count (ViTag) exists with the harness
// only, and the product must pace the way the harness measures it.
// No timers, no WebGPU: times are the caller's (performance.now, rAF times).

// Pacing turns on when the game's frame period reaches PACE_ON refreshes and
// off when it falls under PACE_OFF: a game near 1.33 (45 fps on 60 Hz) with a
// single threshold switched 112 times in 4,000 frames and lost 3 frames to
// the catch-up at the switches.
export const PACE_ON = 1.45;
export const PACE_OFF = 1.25;
// After pacing turns off, this many BeginFrames still show the oldest frame
// without the catch-up: the frames the pacing held are not dropped as stale.
const PACE_OFF_DRAIN = 2;
// The phase's closed loop: the frames' wait is smoothed with this share of
// each new one; at PHASE_BEHIND refreshes of smoothed wait, a stay is cut by
// a refresh. Without it, the display grid kept whatever phase the first or a
// late frame gave it: 30 fps on 60 Hz waited 11.7 ms median against 8.3 for
// today's presenter (simulated, no jitter); with it 8.8. A lower threshold or
// a faster smoothing gave the judder back under jitter (120 Hz, 3 ms: 10.8 %
// of frames off cadence at 0.9 R and 1/8, 6.5 % here, 40 % today).
const PHASE_SMOOTHING = 1 / 16;
const PHASE_BEHIND = 1.0;
// P is measured over the last PERIOD_GAPS gaps, once there are PERIOD_MIN. A
// speed change is followed at once: when the last PERIOD_RECENT gaps give a
// period more than PERIOD_JUMP away from P, the window restarts from them (64
// gaps alone took 0.5 to 1 s to follow a change of speed).
const PERIOD_GAPS = 64;
const PERIOD_MIN = 16;
const PERIOD_RECENT = 8;
const PERIOD_JUMP = 0.15;

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
  // the stay was rounded up past floor(P / refresh): its last refresh is the
  // carry's, and it never holds a frame already queued a BeginFrame ago
  let extra = false;
  // closed loop on the phase: the smoothed wait of the frames shown (ms);
  // at a refresh or more the display runs behind the arrivals, and one stay
  // is cut short by a refresh (the grid moves a refresh earlier)
  let waitEma = 0;
  // Arrival side: the last arrival, the gaps, P.
  let lastAt = null;
  const gaps = [];
  let period = null;
  const stats = { paced: 0, held: 0, late: 0, shortened: 0, extraSkipped: 0, switches: 0, periodJumps: 0 };
  // pacing on (hysteresis), and BeginFrames left to drain after it went off
  let active = false;
  let draining = 0;

  const pacing = (refreshMs) => {
    const span = period !== null && refreshMs > 0 ? period / refreshMs : 0;
    if (!active && span >= PACE_ON) {
      active = true;
      stats.switches += 1;
    } else if (active && span < PACE_OFF) {
      active = false;
      draining = PACE_OFF_DRAIN;
      stats.switches += 1;
    }
    return active;
  };

  return {
    stats,
    // The game's frame period P (null before PERIOD_MIN gaps).
    get period() { return period; },

    // A frame queued at time `at` (P follows the gaps).
    stamp(at) {
      if (lastAt !== null && at > lastAt) {
        gaps.push(at - lastAt);
        if (gaps.length > PERIOD_GAPS) gaps.shift();
        if (gaps.length >= PERIOD_MIN) {
          const recent = periodOf(gaps.slice(-PERIOD_RECENT));
          if (period !== null && Math.abs(recent - period) > PERIOD_JUMP * period) {
            gaps.splice(0, gaps.length - PERIOD_RECENT);
            stats.periodJumps += 1;
          }
          period = periodOf(gaps);
        }
      }
      lastAt = at;
    },

    // The oldest queued frame at the BeginFrame of time `t` on a screen of
    // period `refreshMs`: "unpaced" (no count yet, or pacing off: the
    // presenter's own order), "due" or "early". The pacing state (its
    // hysteresis, the drain after it went off) moves here; the count moves in
    // shown().
    due(frame, t, refreshMs) {
      if (!frame) return "unpaced";
      if (!pacing(refreshMs)) {
        if (draining > 0) {
          draining -= 1;
          return "due";
        }
        return "unpaced";
      }
      if (shownAt === null || stay === null) return "unpaced";
      const elapsed = t - shownAt;
      // half a refresh of slack for the rAF's own jitter
      if (elapsed >= (stay - 0.5) * refreshMs) return "due";
      // closed loop: the carry's extra refresh does not hold back a frame
      // that was already waiting at the previous BeginFrame (the carry alone
      // kept every frame a refresh late: 30 fps on 60 Hz waited 16 ms, not 8)
      if (extra && elapsed >= (stay - 1.5) * refreshMs && Number.isFinite(frame.at) && frame.at <= t - 0.9 * refreshMs) return "due";
      return "early";
    },

    // `frame` went up at the BeginFrame of time `t` (`frame.at`: when it was
    // queued, same clock): the refreshes it stays.
    shown(frame, t, refreshMs) {
      if (!pacing(refreshMs)) {
        shownAt = t;
        stay = null;
        carry = 0;
        extra = false;
        return;
      }
      // the extra refresh was skipped: the fraction it stood for is dropped
      if (extra && stay !== null && shownAt !== null && t - shownAt < (stay - 0.5) * refreshMs) {
        stats.extraSkipped += 1;
        carry = 0;
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
      extra = stay > Math.max(1, Math.floor(period / refreshMs + 1e-9));
      // waited over a period in the queue: the display is behind the game
      // (at once), or the frames have waited a refresh on average (the phase)
      const waited = Number.isFinite(frame?.at) ? Math.max(0, t - frame.at) : 0;
      waitEma += PHASE_SMOOTHING * (waited - waitEma);
      if (stay > 1 && (waited >= period + refreshMs / 2 || waitEma >= PHASE_BEHIND * refreshMs)) {
        stay -= 1;
        carry = 0;
        extra = false;
        waitEma = Math.max(0, waitEma - refreshMs);
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
      extra = false;
      waitEma = 0;
      if (!arrival) return;
      active = false;
      draining = 0;
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
// count closes when the next one goes up. `shown`: the frames put up since
// the previous BeginFrame (a late present outside one, then this one's): all
// but the last never stayed a refresh and count as `unseen`. snapshot(now):
// buckets 1, 2, 3 and 4+, `repeats` (refreshes a frame stayed beyond its
// expected count), `short` (frames that stayed less, unseen ones included)
// and `unseen`, over the window.
export function createRefreshHistogram({ windowMs = 10000 } = {}) {
  // closed frames: [time, refreshes, expected], oldest first
  const closed = [];
  let current = 0;
  let currentExpected = 1;
  const prune = (now) => {
    while (closed.length && closed[0][0] < now - windowMs) closed.shift();
  };
  return {
    tick(expected = null, now = 0, shown = 1) {
      if (expected !== null) {
        if (current > 0) closed.push([now, current, currentExpected]);
        for (let i = 1; i < shown; i++) closed.push([now, 0, Math.max(1, Math.round(expected))]);
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
      let repeats = 0, short = 0, unseen = 0;
      for (const [, n, e] of closed) {
        if (n === 0) unseen += 1;
        else counts[Math.min(n, 4) - 1] += 1;
        if (n > e) repeats += n - e;
        else if (n < e) short += 1;
      }
      return { counts, repeats, short, unseen };
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
