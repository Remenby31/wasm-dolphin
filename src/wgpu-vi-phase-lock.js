// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// The VI phase lock: the emulated VI locked in phase on the screen's refresh.
// On by default at 1:1 ("auto"), ?vilock=1 forces it (2:1 too), ?vilock=0
// turns it off (viLockMode below).
//
// An NTSC game makes 59.94 frames a second; most screens refresh at 60 Hz.
// Free-running, the frames' arrival slides one refresh every ~16.7 s, and
// while it crosses a BeginFrame the jitter of the arrivals (a millisecond or
// two) makes the presenter alternate catch-up drops and repeats for 1-3 s
// instead of the one repeat the drift costs: on the Mac parcours (aa-6, six
// runs) the race's dips came back every 14-17 s with the core at speed 100,
// 60 frames made and 52-57 presented (33 ms gaps).
//
// Here the emulation speed is nudged (at most MAX_PPM, by SLEW_PPM_PER_SEC at
// most) so the arrivals keep a fixed phase in the refresh, TARGET_PHASE of
// it after a BeginFrame: no drift, no crossing. Emulated time is unchanged
// (only the wall pace of the throttle moves), so films and exact runs replay
// the same. Lock only where it means something:
//   - the screen's refresh measured from the rAF frame times, stable (a VRR
//     or ProMotion screen, a throttled rAF, a hidden tab: no lock);
//   - the frames' period an integer number (1 or 2) of refreshes, within
//     RATIO_TOLERANCE (1500 ppm) at the base speed (PAL 50 on 60 Hz, 60 on 144 Hz: no
//     lock), and the frames regular (a load, a core behind: no lock);
// else the speed goes back to the base, smoothly. A lock taken with the
// arrivals at 0.96-0.99 of the refresh (right before the cut, drifting
// toward it) crosses it once while the speed turns: the drift cannot be
// stopped faster within the bound and the slew; from 0.9 it turns at ~0.95. Pure: the worker feeds it
// the rAF frame times and the frames' arrivals and applies its speed.

export const MAX_PPM = 2000;
export const SLEW_PPM_PER_SEC = 1000;
export const TARGET_PHASE = 0.5;
// PI on the phase error (in refreshes): the phase moves by ppm x 1e-6 x the
// frames a second; gains for a ~20 s loop, damped (zeta ~0.8). The integral
// starts from the drift fitted on the arrivals when the lock is taken.
export const PHASE_GAIN_PPM = 8000;
export const PHASE_INTEGRAL_PPM_PER_SEC = 1500;
// The trim's activity at steady lock (each write rebases the throttle and
// moves the mixer's resampling step): the P term reacted to the phase's
// noise, ~170-260 ppm a second in the race seconds with audio skips
// (parcours A/B of #412). The output's P term sees the error smoothed
// (ERR_ALPHA per update; the anti-windup and the out-of-reach watch keep the
// raw error), and the trim is written only once it moved by WRITE_STEP_PPM:
// in simulation (Mac-like jitter, sd 0.8 ms) 2.0 -> 0.6 writes and 90 -> 25
// ppm a second, still no drop.
export const ERR_ALPHA = 0.3;
export const WRITE_STEP_PPM = 25;
// the drift must be within reach of the bound: 59.94 on 60 Hz is 1001 ppm; a
// game 1 % behind (a core that cannot keep up) is no lock
// (a 60.05 Hz panel needs 1835 ppm): taken up to 1900 ppm, leaving the P
// term some room under the bound; kept up to the bound itself (the ratio's
// estimate wobbles: no flapping), dropped past it (the phase would slide)
export const RATIO_TOLERANCE = 0.0019;
// Once locked, the ratio is still checked, against a bound far wider than its
// wobble (+/-700 ppm) and than the trim (2000 ppm): a game that falls to 50
// or 45 fps on a 60 Hz screen (ratio 1.2, 1.33) rounds to 1:1 too, and with
// no ratio check the lock held on and the trim wandered from -2000 to +1738
// ppm (review of #449, a weak machine on WebGPU); dropped past it, the speed
// back to the base. Not at once: a 1 s stall (a load, the race's entry) reads
// in the ratio for the whole ARRIVAL_WINDOW_MS (speeds of 50-90 % gave 1-5.5 %
// for 1-3 s in 14 of 8,716 locked seconds of the parcours series), so the
// ratio must stay off for RATIO_OFF_MS (leaky, like OUT_OF_REACH_MS); until
// then the controller holds its output and its integral (the phase means
// nothing while the frames' period is off).
export const RATIO_TOLERANCE_LOCKED = 0.01;
export const RATIO_OFF_MS = 5000;
// The count runs only while the last RECENT_MS of arrivals are off too
// (irregular, or their own ratio past the bound), else it decays: the 3 s
// window still holds a slowdown that is over, and a game with a 1 s dip every
// 8 s read off half the time, the count reached the bound and the lock let go
// and was taken again (6 locks, 5 lost, the trim at +/-2000 ppm, review of
// #449). Locked, irregular frames (a 1 s stall at 50 %) are held the same way
// instead of letting go at once (27 locks in 5 minutes of such stalls).
export const RECENT_MS = 1000;
const MIN_RECENT_ARRIVALS = 20;
// Once locked, the frames' period measured over a window at a moving speed
// wobbles (+/-700 ppm): the lock is kept on the PI's own output instead, and
// dropped when that output has been held at the bound for OUT_OF_REACH_MS
// (a leaky count: time at the bound adds, time under it takes half as much
// off; the output cycles bound -> under -> bound when the drift is out of
// reach, e.g. a screen changed to 60.08 Hz or a game slowed 0.3 % after the
// lock), counted only while the phase error does not shrink (an acquisition
// holds the output at the bound too, with an error that shrinks). The
// integral is frozen at the bound (anti-windup), so the count is on the
// output, never on the integral.
export const OUT_OF_REACH_MS = 3000;
// a lock is taken only after ENTRY_UPDATES updates in a row found the ratio
// within RATIO_TOLERANCE (its estimate wobbles: a drift past it was taken now
// and then, and dropped again)
export const ENTRY_UPDATES = 4;
// a lock taken without the base window (a session's first, or again after a
// drift out of reach) is not taken with the arrivals within this share of a
// refresh of the cut
export const REENTRY_CUT_MARGIN = 0.1;
// the refresh: a least-squares line through the last REFRESH_TICKS rAF frame
// times, each numbered by the refreshes since the first (a missed vsync counts
// as whole periods): 0.0007 Hz over 7,200 ticks, where a filtered mean of the
// gaps was 0.07 Hz off with 2 ms of jitter (review of #411). Stable when at
// least REFRESH_INLIERS of the gaps are single refreshes (within REFRESH_BAND, 30 %,
// of the median) and the residuals' spread is under REFRESH_JITTER of the
// period, between 45 and 165 Hz
export const REFRESH_TICKS = 600;
// 1 s of rAF before the refresh is trusted (was 2 s: the first lock came
// 9.5 s into a boot, after the logo's load, the phase free meanwhile); the
// inlier share and the jitter checks hold on these 60 as on more
const MIN_REFRESH_TICKS = 120;
export const REFRESH_INLIERS = 0.8;
export const REFRESH_BAND = 0.3;
// with hysteresis: a lock is taken under REFRESH_JITTER_ENTER and kept up to
// REFRESH_JITTER (a 120 Hz screen with +/-1.5 ms of jitter sits near 0.1 and
// flapped every few seconds with one threshold)
export const REFRESH_JITTER = 0.15;
export const REFRESH_JITTER_ENTER = 0.08;
// a gap more than this far from a whole number of refreshes, or more than
// MAX_MISSED of them, splits the regression
const AMBIGUOUS_GAP = 0.3;
const MAX_MISSED = 8;
const MIN_REFRESH_MS = 1000 / 165;
const MAX_REFRESH_MS = 1000 / 45;
// the frames: their arrivals over the last ARRIVAL_WINDOW_MS; regular when
// at most IRREGULAR_SHARE of the gaps are over 1.5 periods
export const ARRIVAL_WINDOW_MS = 3000;
export const IRREGULAR_SHARE = 0.1;
const MIN_ARRIVALS = 60;
// no rAF for this long: hidden, unlocked at once
export const NO_TICK_MS = 100;

const median = (v) => {
  const s = [...v].sort((a, b) => a - b);
  return s.length ? s[s.length >> 1] : null;
};

/**
 * The screen's refresh period from rAF frame times (a least-squares line over
 * their refresh numbers, missed vsyncs counted), or why it cannot be trusted.
 */
export function stableRefresh(times, { jitter = REFRESH_JITTER } = {}) {
  if (times.length < MIN_REFRESH_TICKS) return { refreshMs: null, why: "few rAF" };
  const gaps = times.slice(1).map((t, i) => t - times[i]);
  const m = median(gaps);
  if (!(m > 0)) return { refreshMs: null, why: "rAF irregular" };
  if (gaps.filter((g) => Math.abs(g - m) <= m * REFRESH_BAND).length < gaps.length * REFRESH_INLIERS) return { refreshMs: null, why: "rAF irregular" };
  // segments of refresh-numbered ticks; a gap that is no clear number of
  // refreshes (a tick miscounted, a stall) starts a new segment instead of
  // shifting every later number: one bad interval is left out, not the window
  const segs = [[{ k: 0, t: times[0] }]];
  for (let i = 0; i < gaps.length; i++) {
    const r = gaps[i] / m;
    const seg = segs[segs.length - 1];
    if (Math.abs(r - Math.round(r)) > AMBIGUOUS_GAP || Math.round(r) > MAX_MISSED) segs.push([{ k: 0, t: times[i + 1] }]);
    else seg.push({ k: seg[seg.length - 1].k + Math.max(1, Math.round(r)), t: times[i + 1] });
  }
  // pooled least squares: one slope, each segment its own intercept
  let skt = 0, skk = 0, n = 0;
  const means = segs.map((sg) => {
    const mk = sg.reduce((a, p) => a + p.k, 0) / sg.length, mt = sg.reduce((a, p) => a + p.t, 0) / sg.length;
    for (const p of sg) {
      skt += (p.k - mk) * (p.t - mt);
      skk += (p.k - mk) ** 2;
    }
    n += sg.length;
    return { mk, mt };
  });
  if (!(skk > 0) || n < MIN_REFRESH_TICKS) return { refreshMs: null, why: "few rAF" };
  const R = skt / skk;
  let sr = 0;
  segs.forEach((sg, j) => { for (const p of sg) sr += (p.t - (means[j].mt + R * (p.k - means[j].mk))) ** 2; });
  if (Math.sqrt(sr / n) > R * jitter) return { refreshMs: null, why: "rAF jitter" };
  if (R < MIN_REFRESH_MS || R > MAX_REFRESH_MS) return { refreshMs: null, why: "rAF rate out of range" };
  return { refreshMs: R, why: null };
}

// The switch: ?vilock=1 forces the lock ("on", at 1:1 and 2:1), ?vilock=0
// turns it off, else the default ("auto"): on at 1:1 only. At 1:1 (a game at
// ~60 fps on a ~60 Hz screen) the parcours A/B (20 valid pairs, Mac) showed
// no more audio skips in the race (median 0, worse 4 / better 5) and +10.45
// points of smoothness p5 (20/20 pairs). At 2:1 (120 Hz, ProMotion) there
// is no lock-against-base measure yet: off by default there, forced with
// ?vilock=1.
export function viLockMode(v) {
  return v === true || v === "on" ? "on" : v === "auto" ? "auto" : "off";
}
// The largest frames-per-refresh ratio the lock takes in each mode.
export const MAX_RATIO = Object.freeze({ on: 2, auto: 1 });

export function createViPhaseLock({ quickReentry = true, earlyFirstLock = true, maxPpm = MAX_PPM, slewPpmPerSec = SLEW_PPM_PER_SEC, target = TARGET_PHASE, errAlpha = ERR_ALPHA, writeStep = WRITE_STEP_PPM, maxRatio = MAX_RATIO.on } = {}) {
  // the error the output's P term sees (smoothed), and the trim written
  // (held until the controller's moved by writeStep)
  let errSmooth = null;
  let out = 0;
  const times = [];
  let lastFrameTime = null;
  let lastTickAt = null;
  // the presenter takes its frame when the rAF callback runs, a little after
  // the BeginFrame's frameTime: the phase is measured against that cut, the
  // offset smoothed (its jitter would move the phase)
  let cutOffset = null;
  // the arrivals of the window, and the speed factor each came at (the trim
  // written when it arrived: the gap before it ran at that speed)
  const arrivals = [];
  const arrivalSpeeds = [];
  let ppm = 0;
  let integral = 0;
  let lastUpdate = null;
  let entryStreak = 0;
  let prevErr = null;
  // since when the speed has been the base while unlocked (null: it is not)
  let baseSince = null;
  // unlocked after a drift out of reach: the next lock needs no base window
  let reentry = false;
  // the leaky count of time the output spent at the bound (ms)
  let saturatedMs = 0;
  // the leaky count of time the locked ratio spent off RATIO_TOLERANCE_LOCKED (ms)
  let ratioOffMs = 0;
  const stats = { on: false, ppm: 0, locks: 0, lost: 0, why: "starting", driftPpm: null, refreshMs: null, frameMs: null, ratio: null, phase: null };

  function tick(frameTime, now = frameTime) {
    if (lastFrameTime === null || frameTime > lastFrameTime) {
      times.push(frameTime);
      if (times.length > REFRESH_TICKS) times.shift();
    }
    lastFrameTime = frameTime;
    lastTickAt = now;
    const off = Math.max(0, now - frameTime);
    cutOffset = cutOffset === null ? off : cutOffset + (off - cutOffset) * 0.05;
  }

  function arrival(at) {
    arrivals.push(at);
    arrivalSpeeds.push(1 + out / 1e6);
    while (arrivals.length && arrivals[0] < at - ARRIVAL_WINDOW_MS) { arrivals.shift(); arrivalSpeeds.shift(); }
  }

  // The frames' period at the base speed over arrivals `a` (sp: the speed
  // each came at): a least-squares fit (their jitter averages out) on base time,
  // each gap times the speed it ran at, so a window spanning a change of the
  // trim (a release, its slew back to the base) reads the base period, not
  // a mix; irregular when more than IRREGULAR_SHARE of the gaps are over 1.5
  // times the median.
  function period(a, sp) {
    const ag = a.slice(1).map((t, i) => t - a[i]);
    const p = median(ag);
    const irregular = ag.filter((g) => g > 1.5 * p).length > ag.length * IRREGULAR_SHARE;
    const b = [0];
    for (let i = 1; i < a.length; i++) b.push(b[i - 1] + (a[i] - a[i - 1]) * sp[i]);
    const n = b.length, mi = (n - 1) / 2, mt = b.reduce((x, y) => x + y, 0) / n;
    let sxy = 0, sxx = 0;
    for (let i = 0; i < n; i++) {
      sxy += (i - mi) * (b[i] - mt);
      sxx += (i - mi) ** 2;
    }
    const frameMs = sxy / sxx;
    return { irregular, frameMs, ratio: (refreshMs) => frameMs / refreshMs };
  }

  /** Why no lock now (null: lockable), with the measures it needs. */
  function assess(now) {
    if (lastTickAt === null || now - lastTickAt > NO_TICK_MS) return { why: "no rAF" };
    const { refreshMs, why } = stableRefresh(times, { jitter: stats.on ? REFRESH_JITTER : REFRESH_JITTER_ENTER });
    if (!refreshMs) return { why };
    const from = arrivals.findIndex((t) => t >= now - ARRIVAL_WINDOW_MS);
    const a = from < 0 ? [] : arrivals.slice(from), sp = from < 0 ? [] : arrivalSpeeds.slice(from);
    if (a.length < MIN_ARRIVALS) return { why: "few frames", refreshMs };
    const full = period(a, sp);
    // locked, the last RECENT_MS judged on their own: is the slowdown still on?
    const recentOff = () => {
      const k = a.findIndex((t) => t >= now - RECENT_MS);
      if (k < 0 || a.length - k < MIN_RECENT_ARRIVALS) return true;
      const q = period(a.slice(k), sp.slice(k));
      const mr = Math.round(q.ratio(refreshMs));
      return q.irregular || mr < 1 || mr > 2 || Math.abs(q.ratio(refreshMs) - mr) > mr * RATIO_TOLERANCE_LOCKED;
    };
    if (full.irregular) return stats.on ? { why: "ratio off", recentOff: recentOff(), refreshMs } : { why: "frames irregular", refreshMs };
    const frameMs = full.frameMs;
    const ratio = frameMs / refreshMs;
    const m = Math.round(ratio);
    if (stats.on && (m < 1 || m > 2 || Math.abs(ratio - m) > m * RATIO_TOLERANCE_LOCKED)) return { why: "ratio off", recentOff: recentOff(), refreshMs, frameMs, ratio };
    if (m < 1 || m > 2 || (!stats.on && Math.abs(ratio - m) > m * RATIO_TOLERANCE)) return { why: "no integer ratio", refreshMs, frameMs, ratio };
    // the default (auto) stops at 1:1: 2:1 only with ?vilock=1
    if (m > maxRatio) return { why: "2:1 only with ?vilock=1", refreshMs, frameMs, ratio };
    // the arrivals' phase in the refresh (circular mean, last second)
    let sx = 0, sy = 0;
    for (const t of a.filter((t) => t >= now - 1000)) {
      const ph = (((t - lastFrameTime - cutOffset) / refreshMs) % 1 + 1) % 1;
      sx += Math.cos(2 * Math.PI * ph);
      sy += Math.sin(2 * Math.PI * ph);
    }
    const phase = ((Math.atan2(sy, sx) / (2 * Math.PI)) + 1) % 1;
    return { why: null, refreshMs, frameMs, ratio, m, phase };
  }

  /**
   * Once in a while (every ~250-500 ms): the speed factor to run at (the
   * base times 1 + ppm), and whether it moved since the last call.
   */
  function update(now, { base = 1 } = {}) {
    const dt = lastUpdate === null ? 0.5 : Math.min(2, (now - lastUpdate) / 1000);
    lastUpdate = now;
    const s = assess(now);
    if (!stats.on) {
      // ENTRY_UPDATES lockable updates in a row; after a lock let go (other
      // than for a drift out of reach), once the speed has been the base for
      // the whole window first. After a lock
      // let go for a drift out of reach, no wait for the base: the period
      // is read on base time (each gap at the speed it ran, period()), so a
      // window spanning the release and the slew back reads right. That
      // wait made a re-entry take 5 s at least: on the 2P parcours (2p-4,
      // c157) the lock let go at a film's start (a few seconds out of
      // reach), the drift came back within reach, and the phase crossed the
      // cut while it settled, 22 frames lost.
      if (ppm !== 0) baseSince = null;
      else baseSince ??= now;
      // the first lock of a session neither: every arrival so far came at
      // the base speed (no trim was ever written). On a boot it came 9.5 s
      // in, after the logo's load, the phase free meanwhile (2P parcours:
      // 76 % of the startup seconds' lost frames before the first lock);
      // now ~3.5 s (2 s of rAF, 4 updates), and a load that follows is
      // held through ("ratio off")
      const clean = reentry || (earlyFirstLock && stats.locks === 0) || (baseSince !== null && now - baseSince >= ARRIVAL_WINDOW_MS);
      // a quick (re-)entry is not taken with the arrivals next to the cut: the
      // drift that let go would carry them across it while the trim turns
      // (then the acquisition crosses back: two crossings for one); they
      // cross unlocked and the lock is taken past it
      const nearCut = (reentry || (earlyFirstLock && stats.locks === 0)) && s.why === null && Math.min(s.phase, 1 - s.phase) < REENTRY_CUT_MARGIN;
      entryStreak = s.why === null && clean && !nearCut ? entryStreak + 1 : 0;
      if (s.why === null && entryStreak < ENTRY_UPDATES) s.why = "settling";
    }
    // locked, the output held at the bound OUT_OF_REACH_MS (leaky): out of reach
    if (s.why === null && stats.on && saturatedMs >= OUT_OF_REACH_MS) s.why = "drift out of reach";
    // locked, the ratio off: held for up to RATIO_OFF_MS (leaky), then let go
    let holding = false;
    if (stats.on && s.why === "ratio off") {
      ratioOffMs = s.recentOff ? ratioOffMs + dt * 1000 : Math.max(0, ratioOffMs - dt * 500);
      if (ratioOffMs < RATIO_OFF_MS) holding = true;
      else s.why = "no integer ratio";
    } else if (s.why === null) ratioOffMs = Math.max(0, ratioOffMs - dt * 500);
    let want = 0;
    if (holding) {
      // the output and the integral as they are; the phase is not used
      want = ppm;
    } else if (s.why === null) {
      // late in the refresh (phase above the target): a little faster
      let err = s.phase - target;
      if (err > 0.5) err -= 1;
      if (err < -0.5) err += 1;
      if (!stats.on) {
        stats.locks += 1;
        entryStreak = 0;
        prevErr = null;
        // the drift the lock has to cancel: m refreshes per frame
        integral = Math.max(-maxPpm, Math.min(maxPpm, (s.frameMs / (s.m * s.refreshMs) - 1) * 1e6));
      }
      stats.on = true;
      reentry = false;
      // P limited to what the slew can follow from the current output, and
      // the integral frozen while the clamp or the slew holds the output
      // back (it wound up at the acquisition: an overshoot to 0.8, a
      // crossing when the lock was taken at 0.85 or more)
      const step = slewPpmPerSec * dt;
      const p = PHASE_GAIN_PPM * err;
      const next = integral + PHASE_INTEGRAL_PPM_PER_SEC * err * dt;
      const raw = next + p;
      const limited = Math.abs(raw) > maxPpm || Math.abs(raw - ppm) > step;
      if (!limited) integral = next;
      errSmooth = errSmooth === null ? err : errSmooth + (err - errSmooth) * errAlpha;
      want = Math.max(-maxPpm, Math.min(maxPpm, integral + PHASE_GAIN_PPM * errSmooth));
      // the output wanted past the bound (the clamp limits it) while the
      // phase error does not shrink: the bound cannot hold the drift (an
      // acquisition also holds the output at the bound, but its error shrinks)
      const atBound = Math.abs(raw) >= maxPpm || Math.abs(integral + p) >= maxPpm;
      const notShrinking = prevErr !== null && Math.abs(err) >= Math.abs(prevErr) - 0.002;
      saturatedMs = atBound && notShrinking ? saturatedMs + dt * 1000 : Math.max(0, saturatedMs - dt * 500);
      prevErr = err;
    } else {
      if (stats.on) stats.lost += 1;
      stats.on = false;
      saturatedMs = 0;
      ratioOffMs = 0;
      prevErr = null;
      errSmooth = null;
      if (s.why === "drift out of reach") { entryStreak = 0; reentry = quickReentry; }
      // hidden (no rAF): a new start, the base window first
      if (s.why === "no rAF") reentry = false;
    }
    stats.driftPpm = stats.on ? Math.round(integral) : null;
    const step = slewPpmPerSec * dt;
    const before = out;
    ppm = s.why === "no rAF" ? 0 : ppm + Math.max(-step, Math.min(step, want - ppm));
    // the written trim moves by writeStep or more, and back to the base
    // whenever the lock is let go
    if (!stats.on && Math.abs(ppm) < writeStep) out = 0;
    else if (Math.abs(ppm - out) >= writeStep) out = ppm;
    Object.assign(stats, {
      ppm: Math.round(out), why: s.why,
      refreshMs: s.refreshMs == null ? null : Math.round(s.refreshMs * 1000) / 1000,
      frameMs: s.frameMs == null ? null : Math.round(s.frameMs * 1000) / 1000,
      ratio: s.ratio == null ? null : Math.round(s.ratio * 10000) / 10000,
      phase: s.phase == null ? null : Math.round(s.phase * 100) / 100
    });
    return { factor: base * (1 + out / 1e6), changed: Math.abs(out - before) >= 1 };
  }

  return { tick, arrival, update, stats };
}
