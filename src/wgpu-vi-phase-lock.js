// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// ?vilock=1: the emulated VI locked in phase on the screen's refresh.
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
// else the speed goes back to the base, smoothly. Pure: the worker feeds it
// the rAF frame times and the frames' arrivals and applies its speed.

export const MAX_PPM = 2000;
export const SLEW_PPM_PER_SEC = 400;
export const TARGET_PHASE = 0.5;
// PI on the phase error (in refreshes): the phase moves by ppm x 1e-6 x the
// frames a second; gains for a ~20 s loop, damped (zeta ~0.8). The integral
// starts from the drift fitted on the arrivals when the lock is taken.
export const PHASE_GAIN_PPM = 8000;
export const PHASE_INTEGRAL_PPM_PER_SEC = 1500;
// the drift must be within reach of the bound: 59.94 on 60 Hz is 1001 ppm; a
// game 1 % behind (a core that cannot keep up) is no lock
export const RATIO_TOLERANCE = 0.0015;
// once locked, kept up to twice that (the ratio's estimate wobbles: no flapping)
export const RATIO_KEEP = 0.003;
// the refresh: the last REFRESH_GAPS rAF gaps; stable when at least
// REFRESH_INLIERS of them sit within REFRESH_BAND of their median and the
// inliers' spread is under REFRESH_JITTER of it, between 45 and 165 Hz
export const REFRESH_GAPS = 120;
export const REFRESH_INLIERS = 0.8;
export const REFRESH_BAND = 0.05;
export const REFRESH_JITTER = 0.02;
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

/** The screen's refresh period from rAF gaps, or why it cannot be trusted. */
export function stableRefresh(gaps) {
  if (gaps.length < REFRESH_GAPS / 2) return { refreshMs: null, why: "few rAF" };
  const m = median(gaps);
  const inl = gaps.filter((g) => Math.abs(g - m) <= m * REFRESH_BAND);
  if (inl.length < gaps.length * REFRESH_INLIERS) return { refreshMs: null, why: "rAF irregular" };
  const mean = inl.reduce((a, b) => a + b, 0) / inl.length;
  const sd = Math.sqrt(inl.reduce((a, b) => a + (b - mean) ** 2, 0) / inl.length);
  if (sd > mean * REFRESH_JITTER) return { refreshMs: null, why: "rAF jitter" };
  if (mean < MIN_REFRESH_MS || mean > MAX_REFRESH_MS) return { refreshMs: null, why: "rAF rate out of range" };
  return { refreshMs: mean, why: null };
}

export function createViPhaseLock({ maxPpm = MAX_PPM, slewPpmPerSec = SLEW_PPM_PER_SEC, target = TARGET_PHASE } = {}) {
  const gaps = [];
  let lastFrameTime = null;
  let lastTickAt = null;
  // the arrivals of the window, and the speed factor each came at
  const arrivals = [];
  let ppm = 0;
  let integral = 0;
  let lastUpdate = null;
  const stats = { on: false, ppm: 0, locks: 0, lost: 0, why: "starting", driftPpm: null, refreshMs: null, frameMs: null, ratio: null, phase: null };

  function tick(frameTime, now = frameTime) {
    if (lastFrameTime !== null && frameTime > lastFrameTime) {
      gaps.push(frameTime - lastFrameTime);
      if (gaps.length > REFRESH_GAPS) gaps.shift();
    }
    lastFrameTime = frameTime;
    lastTickAt = now;
  }

  function arrival(at) {
    arrivals.push(at);
    while (arrivals.length && arrivals[0] < at - ARRIVAL_WINDOW_MS) arrivals.shift();
  }

  /** Why no lock now (null: lockable), with the measures it needs. */
  function assess(now, speed) {
    if (lastTickAt === null || now - lastTickAt > NO_TICK_MS) return { why: "no rAF" };
    const { refreshMs, why } = stableRefresh(gaps);
    if (!refreshMs) return { why };
    const a = arrivals.filter((t) => t >= now - ARRIVAL_WINDOW_MS);
    if (a.length < MIN_ARRIVALS) return { why: "few frames", refreshMs };
    const ag = a.slice(1).map((t, i) => t - a[i]);
    const p = median(ag);
    if (ag.filter((g) => g > 1.5 * p).length > ag.length * IRREGULAR_SHARE) return { why: "frames irregular", refreshMs };
    // the frames' period at the base speed: a least-squares fit of the
    // arrivals (their jitter averages out), with the speed taken out
    const n = a.length, mi = (n - 1) / 2, mt = a.reduce((x, y) => x + y, 0) / n;
    let sxy = 0, sxx = 0;
    for (let i = 0; i < n; i++) {
      sxy += (i - mi) * (a[i] - mt);
      sxx += (i - mi) ** 2;
    }
    const frameMs = (sxy / sxx) * speed;
    const ratio = frameMs / refreshMs;
    const m = Math.round(ratio);
    if (m < 1 || m > 2 || Math.abs(ratio - m) > m * (stats.on ? RATIO_KEEP : RATIO_TOLERANCE)) return { why: "no integer ratio", refreshMs, frameMs, ratio };
    // the arrivals' phase in the refresh (circular mean, last second)
    let sx = 0, sy = 0;
    for (const t of a.filter((t) => t >= now - 1000)) {
      const ph = (((t - lastFrameTime) / refreshMs) % 1 + 1) % 1;
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
    const speed = 1 + ppm / 1e6;
    const s = assess(now, speed);
    let want = 0;
    if (s.why === null) {
      // late in the refresh (phase above the target): a little faster
      let err = s.phase - target;
      if (err > 0.5) err -= 1;
      if (err < -0.5) err += 1;
      if (!stats.on) {
        stats.locks += 1;
        // the drift the lock has to cancel: m refreshes per frame
        integral = Math.max(-maxPpm, Math.min(maxPpm, (s.frameMs / (s.m * s.refreshMs) - 1) * 1e6));
      }
      stats.on = true;
      const p = PHASE_GAIN_PPM * err;
      // anti-windup: the integral moves only while the output is not clamped
      const next = integral + PHASE_INTEGRAL_PPM_PER_SEC * err * dt;
      if (Math.abs(next + p) <= maxPpm) integral = next;
      want = Math.max(-maxPpm, Math.min(maxPpm, integral + p));
    } else {
      if (stats.on) stats.lost += 1;
      stats.on = false;
    }
    stats.driftPpm = stats.on ? Math.round(integral) : null;
    const step = slewPpmPerSec * dt;
    const before = ppm;
    ppm = s.why === "no rAF" ? 0 : ppm + Math.max(-step, Math.min(step, want - ppm));
    Object.assign(stats, {
      ppm: Math.round(ppm), why: s.why,
      refreshMs: s.refreshMs == null ? null : Math.round(s.refreshMs * 1000) / 1000,
      frameMs: s.frameMs == null ? null : Math.round(s.frameMs * 1000) / 1000,
      ratio: s.ratio == null ? null : Math.round(s.ratio * 10000) / 10000,
      phase: s.phase == null ? null : Math.round(s.phase * 100) / 100
    });
    return { factor: base * (1 + ppm / 1e6), changed: Math.abs(ppm - before) >= 1 };
  }

  return { tick, arrival, update, stats };
}
