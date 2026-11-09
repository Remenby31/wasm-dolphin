// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { createViPhaseLock, MAX_PPM, MAX_RATIO, REENTRY_CUT_MARGIN, stableRefresh, viLockMode, WRITE_STEP_PPM } from "../src/wgpu-vi-phase-lock.js";
import { createVsyncQueue } from "../src/wgpu-vsync-queue.js";

const NTSC_VI_MS = 1000 / 59.94;

// A screen of `hz` (each BeginFrame moved by tickJitter(k) ms) showing a game
// that queues a frame every `fields` VI fields of `viMs` at the speed the lock
// asks (or 1 without it), each arrival moved by jitter(n) ms, through the
// presenter's real queue. Returns the frames shown/dropped/repeated after the
// first `settleSec`, and the lock.
function play({ hz = 60, viMs = NTSC_VI_MS, fields = 1, seconds = 120, settleSec = 20, jitter = (n) => ((n * 7919) % 5) - 2, tickJitter = () => 0, lock = true, arrivalOffsetMs = 3, cbLateMs = 0, stall = null, maxRatio }) {
  const R = 1000 / hz;
  const q = createVsyncQueue({ queueSize: 2, createTexture: () => ({}) });
  const vi = lock ? createViPhaseLock(maxRatio === undefined ? {} : { maxRatio }) : null;
  let factor = 1;
  let nextArrival = arrivalOffsetMs, n = 0, tick = 0, lastUpdate = 0;
  // the lock's phase after it was first taken, and the frames dropped or
  // repeated from then on (a crossing of the cut shows as both)
  const phases = [];
  let lockedAt = null, droppedAtLock = null, repeatsLocked = 0;
  let shown = 0, repeats = 0, counted = false, droppedAtSettle = 0;
  const end = seconds * 1000;
  for (let k = 0; k * R < end; k++) {
    const t = 0.37 * R + k * R + tickJitter(k);
    // a stall (hidden tab, a long task): no BeginFrame, the frames queue
    const stalled = stall && t >= stall[0] && t < stall[1];
    // the arrivals before this BeginFrame
    while (nextArrival + jitter(n) <= t) {
      const at = nextArrival + jitter(n);
      q.textureForPass("k", 1, 1);
      q.queueFrame({ n, tick, at });
      vi?.arrival(at);
      n++;
      nextArrival += (fields * viMs) / factor;
    }
    if (stalled) {
      if (vi && t - lastUpdate >= 500) {
        lastUpdate = t;
        factor = vi.update(t).factor;
      }
      continue;
    }
    tick++;
    // the BeginFrame's frameTime is cbLateMs before the callback runs (the cut, t)
    vi?.tick(t - cbLateMs, t);
    if (vi && t - lastUpdate >= 500) {
      lastUpdate = t;
      factor = vi.update(t).factor;
      if (vi.stats.on && lockedAt === null) lockedAt = t;
      // drops counted from 5 s after the lock: the acquisition from a phase
      // already in the jitter band next to the cut cannot avoid a few
      if (lockedAt !== null && droppedAtLock === null && t >= lockedAt + 5000) droppedAtLock = q.stats.dropped;
      if (lockedAt !== null && vi.stats.phase !== null) phases.push(vi.stats.phase);
    }
    const f = q.takeForDisplay(tick, null);
    if (!f && droppedAtLock !== null && !(stall && t < stall[1] + 5000)) repeatsLocked++;
    const measuring = t >= settleSec * 1000;
    if (measuring && !counted) {
      counted = true;
      droppedAtSettle = q.stats.dropped;
    }
    if (f) {
      q.shown(f);
      if (measuring) shown++;
    } else if (measuring) repeats++;
  }
  return { shown, repeats, dropped: q.stats.dropped - droppedAtSettle, factor, stats: vi?.stats, phases, lockedAt, droppedLocked: droppedAtLock === null ? null : q.stats.dropped - droppedAtLock, repeatsLocked };
}

test("NTSC on 60 Hz with a jittered arrival: free-running it drops and repeats at every crossing; locked, neither", () => {
  // arrivals jittered by up to +/-3 ms: the crossings of the 59.94/60 beat
  const jitter = (n) => (((n * 7919) % 7) - 3) * 1.0;
  const free = play({ lock: false, jitter });
  const locked = play({ jitter });
  // 100 s at 59.94 on 60 Hz: ~6 crossings, each a run of drops and repeats
  assert.ok(free.dropped >= 10, `free-running: catch-up drops at the crossings (${free.dropped})`);
  assert.equal(locked.dropped, 0, "locked: no catch-up drop");
  assert.ok(locked.repeats <= 2, `locked: no repeat (${locked.repeats})`);
  assert.ok(locked.stats.on, "locked");
  // the measured drift: 60 / 59.94 = +1001 ppm
  assert.ok(Math.abs(locked.stats.ppm - 1001) < 150, `ppm ${locked.stats.ppm}`);
  assert.equal(locked.stats.lost, 0);
});

test("30 fps on 60 Hz (2:1) locks too; 120 Hz with 60 fps (2:1) too", () => {
  const a = play({ fields: 2 });
  assert.ok(a.stats.on && a.stats.ratio > 1.9, JSON.stringify(a.stats));
  assert.equal(a.dropped, 0);
  const b = play({ hz: 120 });
  assert.ok(b.stats.on, JSON.stringify(b.stats));
  assert.equal(b.dropped, 0);
});

test("the default (auto, MAX_RATIO.auto): locks at 1:1, never at 2:1 (30 fps on 60 Hz, 60 fps on 120 Hz); ?vilock=1 (on) takes 2:1", () => {
  assert.equal(MAX_RATIO.auto, 1);
  assert.equal(MAX_RATIO.on, 2);
  const one = play({ maxRatio: MAX_RATIO.auto });
  assert.ok(one.stats.on && one.stats.locks >= 1, JSON.stringify(one.stats));
  assert.equal(one.dropped, 0);
  for (const twoToOne of [{ fields: 2 }, { hz: 120 }]) {
    const auto = play({ ...twoToOne, maxRatio: MAX_RATIO.auto });
    assert.equal(auto.stats.on, false, JSON.stringify(auto.stats));
    assert.equal(auto.stats.locks, 0);
    assert.equal(auto.stats.why, "2:1 only with ?vilock=1");
    assert.equal(auto.stats.ppm, 0, "the speed stays the base");
    const on = play({ ...twoToOne, maxRatio: MAX_RATIO.on });
    assert.ok(on.stats.on, JSON.stringify(on.stats));
  }
});

test("the switch: ?vilock=1 on, ?vilock=0 off, else auto (viLockMode)", () => {
  assert.equal(viLockMode("on"), "on");
  assert.equal(viLockMode(true), "on");
  assert.equal(viLockMode("auto"), "auto");
  for (const v of ["off", false, undefined, null, "1", "yes"]) assert.equal(viLockMode(v), "off", String(v));
});

test("not lockable: PAL 50 on 60 Hz, 60 fps on 144 Hz: the speed stays the base", () => {
  const pal = play({ viMs: 20 });
  assert.equal(pal.stats.on, false);
  assert.equal(pal.stats.why, "no integer ratio");
  assert.equal(pal.factor, 1);
  const hz144 = play({ hz: 144 });
  assert.equal(hz144.stats.on, false);
  assert.equal(hz144.factor, 1);
});

test("a VRR / jittery rAF is no stable refresh: no lock", () => {
  const vrr = play({ tickJitter: (k) => ((k * 104729) % 9) - 4 });
  assert.equal(vrr.stats.on, false);
  assert.match(vrr.stats.why, /rAF/);
  assert.equal(vrr.factor, 1);
  // alternating 8.3 / 16.7 ms gaps (a VRR screen): no refresh
  let t = 0;
  assert.equal(stableRefresh(Array.from({ length: 600 }, (_, i) => (t += i % 2 ? 8.3 : 16.7))).refreshMs, null);
  // 60.000 Hz with 2 ms of jitter and 5 % missed vsyncs: the regression finds it within 0.01 Hz
  const R = 1000 / 60;
  const times = [];
  for (let k = 0; times.length < 600; k++) if ((k * 7919) % 20 !== 0) times.push(k * R + (((k * 104729) % 41) / 10 - 2));
  const est = stableRefresh(times);
  assert.ok(Math.abs(1000 / est.refreshMs - 60) < 0.01, `${1000 / est.refreshMs} Hz`);
});

test("bounded and smooth: never past MAX_PPM, at most SLEW a second; out of reach is no lock; a hidden tab unlocks at once, counted", () => {
  const run = (viMs, seconds = 60) => {
    const vi = createViPhaseLock();
    let factor = 1, prev = 1, maxStep = 0, maxPpm = 0, next = 0, t = 0, lastUpdate = 0;
    for (; t < seconds * 1000; t += 1000 / 60) {
      while (next <= t) {
        vi.arrival(next + (((Math.round(next) * 7919) % 5) - 2));
        next += viMs / factor;
      }
      vi.tick(t);
      if (t - lastUpdate >= 500) {
        lastUpdate = t;
        factor = vi.update(t).factor;
        maxStep = Math.max(maxStep, Math.abs(factor - prev) * 1e6);
        maxPpm = Math.max(maxPpm, Math.abs(factor - 1) * 1e6);
        prev = factor;
      }
    }
    return { vi, t, factor, maxStep, maxPpm };
  };
  // 0.12 % off a 60 Hz refresh: within reach, locked (once), bounded and smooth
  const near = run(1000 / 60 * 1.0012);
  assert.ok(near.vi.stats.on, JSON.stringify(near.vi.stats));
  assert.equal(near.vi.stats.locks, 1, "no flapping");
  assert.ok(near.maxPpm <= MAX_PPM + 0.5, `max ${near.maxPpm} ppm`);
  assert.ok(near.maxStep <= 1000 * 0.55, `step ${near.maxStep} ppm per update`);
  // a game 1 % behind: no lock, the base speed
  const slow = run(NTSC_VI_MS * 1.01);
  assert.equal(slow.vi.stats.on, false);
  assert.equal(slow.factor, 1);
  // hidden: no rAF for 200 ms, at once back to the base, the lock counted lost
  const r = near.vi.update(near.t + 200);
  assert.equal(near.vi.stats.on, false);
  assert.equal(near.vi.stats.why, "no rAF");
  assert.equal(r.factor, 1);
  assert.equal(near.vi.stats.lost, 1);
});

// the first arrival's offset (ms) for a lock taken near `phase` (~5 s in: 3 s
// of the speed at the base, 4 stable updates; the free drift +0.06 cycle/s)
const at = (phase) => 0.37 * (1000 / 60) + (((phase - 0.3) % 1) + 1) % 1 * (1000 / 60);

// the phase never wraps through the cut (0 / 1) once locked
const noCrossing = (phases) => phases.every((p, i) => i === 0 || Math.abs(p - phases[i - 1]) < 0.5) && Math.min(...phases.map((p) => Math.min(p, 1 - p))) > 0.04;

test("acquisition from a phase near the cut on either side (0.13, 0.9): settles to the middle without crossing it", () => {
  // the first arrival placed so the lock is taken (~4 s in: 2 s of rAF, 4
  // stable updates; the drift +0.06 cycle/s) near 0.13 and near 0.9
  for (const [offset, near] of [[at(0.13), 0.13], [at(0.9), 0.9]]) {
    const r = play({ arrivalOffsetMs: offset, jitter: (n) => (((n * 7919) % 7) - 3) * 0.6 });
    assert.ok(r.lockedAt !== null, `${near}: locked`);
    assert.ok(Math.abs(r.phases[0] - near) < 0.12, `${near}: taken at ${r.phases[0]}`);
    assert.ok(noCrossing(r.phases), `${near}: no crossing ${r.phases.slice(0, 40).join(" ")}`);
    assert.equal(r.droppedLocked, 0, `${near}: no catch-up drop once settled`);
    assert.ok(Math.abs(r.phases.at(-1) - 0.5) < 0.08, `${near}: settled at ${r.phases.at(-1)}`);
  }
});

test("a 1 s stall (hidden tab, long task): unlocked at once, locked again after, without crossing", () => {
  const r = play({ stall: [40_000, 41_000], seconds: 90, arrivalOffsetMs: at(0.4) });
  assert.equal(r.stats.lost, 1);
  assert.equal(r.stats.locks, 2);
  assert.ok(r.stats.on);
  assert.ok(noCrossing(r.phases), r.phases.join(" "));
  assert.ok(Math.abs(r.phases.at(-1) - 0.5) < 0.08);
});

test("the phase is taken against the cut (the callback's run), not frameTime: a callback 6 ms late still locks mid-refresh", () => {
  const r = play({ cbLateMs: 6, jitter: (n) => (((n * 7919) % 7) - 3) * 0.6 });
  assert.ok(r.stats.on);
  assert.equal(r.droppedLocked, 0);
  assert.ok(r.repeatsLocked <= 1, `repeats ${r.repeatsLocked}`);
});

test("a 60.05 Hz panel (1835 ppm) locks; one miscounted tick does not cost the lock", () => {
  const a = play({ hz: 60.05 });
  assert.ok(a.stats.on, JSON.stringify(a.stats));
  assert.equal(a.stats.locks, 1);
  assert.equal(a.droppedLocked, 0);
  // one BeginFrame half a refresh late at 30 s (a miscounted tick mid-window)
  const b = play({ tickJitter: (k) => (k === 1800 ? 0.5 * (1000 / 60) : 0) });
  assert.equal(b.stats.lost, 0, JSON.stringify(b.stats));
  assert.equal(b.stats.locks, 1);
});

// A screen and a game whose rates change at `changeAt` (ms): the lock's
// state each update, from a closed loop (the arrivals follow the lock's speed).
function drive({ seconds = 60, changeAt = 20_000, hzBefore = 60, hzAfter = 60, viBefore = NTSC_VI_MS, viAfter = NTSC_VI_MS, tickJitter = () => 0, maxRatio, slow = null, viAt = null }) {
  const vi = createViPhaseLock(maxRatio === undefined ? {} : { maxRatio });
  let factor = 1, next = 3, n = 0, t = 0.37 * (1000 / hzBefore), lastUpdate = 0, k = 0;
  const trace = [];
  while (t < seconds * 1000) {
    const viMs = viAt?.(t) ?? (slow && t >= slow.from && t < slow.to ? slow.viMs : t < changeAt ? viBefore : viAfter);
    while (next <= t) {
      vi.arrival(next + (((n * 7919) % 5) - 2) * 0.5);
      n++;
      next += viMs / factor;
    }
    vi.tick(t + tickJitter(k), t + tickJitter(k));
    if (t - lastUpdate >= 500) {
      lastUpdate = t;
      factor = vi.update(t).factor;
      trace.push({ t, on: vi.stats.on, why: vi.stats.why, ppm: vi.stats.ppm, phase: vi.stats.phase });
    }
    t += 1000 / (t < changeAt ? hzBefore : hzAfter);
    k++;
  }
  return { vi, trace };
}

test("out of reach after the lock (screen 60 -> 60.08 Hz, a game slowed 0.3 %): released within seconds, not cycling at the bound", () => {
  for (const [name, o] of [["60.08 Hz", { hzAfter: 60.08 }], ["game -0.3 %", { viAfter: NTSC_VI_MS * 1.003 }]]) {
    const { vi, trace } = drive(o);
    const before = trace.filter((x) => x.t < 20_000).at(-1);
    assert.ok(before.on, `${name}: locked before the change`);
    const released = trace.find((x) => x.t > 20_000 && !x.on);
    assert.ok(released, `${name}: released ${JSON.stringify(trace.slice(-3))}`);
    console.log(`${name}: released after ${Math.round(released.t - 20_000)} ms`);
    assert.ok(released.t - 20_000 <= 8_000, `${name}: released after ${released.t - 20_000} ms`);
    assert.equal(released.why, "drift out of reach", name);
    // and not taken again: the drift is past the entry tolerance
    assert.equal(vi.stats.on, false, name);
    assert.equal(vi.stats.locks, 1, name);
  }
});

test("locked at 1:1, then the game falls to 50 or 45 fps (ratio 1.2, 1.33): released, the speed back to the base, not taken again", () => {
  for (const mode of ["auto", "on"]) {
    for (const [name, viAfter] of [["50 fps", 20], ["45 fps", 1000 / 45]]) {
      const { vi, trace } = drive({ seconds: 70, changeAt: 40_000, viAfter, maxRatio: MAX_RATIO[mode] });
      const label = `${mode} ${name}`;
      assert.ok(trace.filter((x) => x.t < 40_000).at(-1).on, `${label}: locked before`);
      const released = trace.find((x) => x.t > 40_000 && !x.on);
      assert.ok(released && released.t - 40_000 <= 10_000, `${label}: released ${JSON.stringify(released)}`);
      assert.equal(released.why, "no integer ratio", label);
      const after = trace.filter((x) => x.t >= released.t + 3_000);
      assert.ok(after.length && after.every((x) => !x.on && x.ppm === 0), `${label}: ${JSON.stringify(after.slice(0, 3))}`);
      assert.equal(vi.stats.locks, 1, label);
    }
  }
});

test("a short slowdown while locked (1-2 s at 80-85 % speed, a load): held through it, not released (the ratio reads off for the arrival window)", () => {
  for (const [ms, viMs] of [[1000, NTSC_VI_MS / 0.8], [2000, NTSC_VI_MS / 0.85]]) {
    const { vi, trace } = drive({ seconds: 70, changeAt: 1e9, slow: { from: 40_000, to: 40_000 + ms, viMs } });
    assert.ok(trace.filter((x) => x.t < 40_000).at(-1).on, "locked before");
    assert.ok(trace.some((x) => x.t > 40_000 && x.why === "ratio off"), `${ms} ms: the ratio read off ${JSON.stringify(trace.filter((x) => x.t > 40_000).slice(0, 8))}`);
    assert.equal(vi.stats.lost, 0, `${ms} ms: ${JSON.stringify(vi.stats)}`);
    assert.ok(vi.stats.on, `${ms} ms: still on at the end`);
  }
});

// a dip of `ms` at `speed` every `every` ms, from 30 s on
const dips = (every, ms, speed) => (t) => (t >= 30_000 && (t - 30_000) % every < ms ? NTSC_VI_MS / speed : null);

test("repeated dips while locked (1 s at 85 % every 8 s; 1 s at 50 % every 10 s): one lock, held through them, the trim bounded", () => {
  for (const [name, viAt] of [["85 % / 8 s", dips(8_000, 1_000, 0.85)], ["50 % / 10 s", dips(10_000, 1_000, 0.5)]]) {
    const { vi, trace } = drive({ seconds: 150, changeAt: 1e9, viAt });
    const late = trace.filter((x) => x.t > 30_000);
    assert.ok(late.some((x) => x.why === "ratio off"), `${name}: the dips were seen`);
    assert.equal(vi.stats.locks, 1, `${name}: ${JSON.stringify(vi.stats)}`);
    assert.equal(vi.stats.lost, 0, `${name}: ${JSON.stringify(vi.stats)}`);
    const maxPpm = Math.max(...late.map((x) => Math.abs(x.ppm)));
    console.log(`${name}: max |ppm| after 30 s ${maxPpm}`);
    assert.ok(maxPpm <= 1600, `${name}: trim ${maxPpm}`);
  }
});

test("auto never takes a ratio near 2 (1.98, 2.02), and lets go when the screen goes 60 -> 120 Hz mid-session", () => {
  for (const ratio of [1.98, 2.02]) {
    const r = play({ viMs: (1000 / 60) * ratio, maxRatio: MAX_RATIO.auto });
    assert.equal(r.stats.on, false, `${ratio}: ${JSON.stringify(r.stats)}`);
    assert.equal(r.stats.locks, 0, String(ratio));
    assert.equal(r.stats.ppm, 0, String(ratio));
  }
  const { vi, trace } = drive({ seconds: 60, changeAt: 30_000, hzAfter: 120, maxRatio: MAX_RATIO.auto });
  assert.ok(trace.filter((x) => x.t < 30_000).at(-1).on, "locked at 60 Hz");
  const released = trace.find((x) => x.t > 30_000 && !x.on);
  assert.ok(released && released.t - 30_000 <= 5_000, JSON.stringify(released));
  const after = trace.filter((x) => x.t >= released.t + 3_000);
  assert.ok(after.length && after.every((x) => !x.on && x.ppm === 0), JSON.stringify(after.slice(0, 3)));
  assert.equal(vi.stats.why, "2:1 only with ?vilock=1");
  assert.equal(vi.stats.locks, 1);
});

test("a 120 Hz screen with +/-1.5 ms of rAF jitter: the jitter check has hysteresis, no flapping", () => {
  const { vi } = drive({ hzBefore: 120, hzAfter: 120, seconds: 90, tickJitter: (k) => (((k * 104729) % 31) / 10 - 1.5) });
  assert.ok(vi.stats.locks + vi.stats.lost <= 2, JSON.stringify(vi.stats));
});

test("a calm trim at steady lock: the phase noise moves the written trim little (each write rebases the throttle and the mixer's step)", () => {
  // NTSC on 60 Hz, arrivals jittered like the Mac's VI outputs (sd ~0.8 ms)
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const gauss = () => { let x = 0; for (let i = 0; i < 6; i++) x += rnd(); return (x - 3) / Math.sqrt(0.5); };
  const R = 1000 / 60;
  const vi = createViPhaseLock();
  const q = createVsyncQueue({ queueSize: 2, createTexture: () => ({}) });
  let factor = 1, next = 3, tick = 0, last = 0, writes = 0, prev = 0, moved = 0, updates = 0, drops0 = null;
  for (let k = 0; k * R < 180_000; k++) {
    const t = 0.37 * R + k * R;
    while (next <= t) {
      const at = next + gauss() * 0.8;
      q.textureForPass("k", 1, 1);
      q.queueFrame({ tick, at });
      vi.arrival(at);
      next += NTSC_VI_MS / factor;
    }
    tick++;
    vi.tick(t, t + 1.2);
    if (t - last >= 500) {
      last = t;
      factor = vi.update(t).factor;
      if (t > 60_000) {
        drops0 ??= q.stats.dropped;
        if (vi.stats.ppm !== prev) writes++;
        moved += Math.abs(vi.stats.ppm - prev);
        updates++;
      }
      prev = vi.stats.ppm;
    }
    const f = q.takeForDisplay(tick, null);
    if (f) q.shown(f);
  }
  const seconds = updates / 2;
  assert.ok(vi.stats.on);
  assert.equal(q.stats.dropped - drops0, 0, "no drop once locked");
  // the merged controller: 2.0 writes and 90 ppm a second here
  assert.ok(writes / seconds <= 1, `${(writes / seconds).toFixed(2)} writes a second`);
  assert.ok(moved / seconds <= 40, `${(moved / seconds).toFixed(1)} ppm a second`);
  assert.ok(WRITE_STEP_PPM >= 20);
});

// The film start of the 2P parcours (2p-4, c157): locked, then a few
// seconds out of reach (the game ~0.2 % slower, its first second at 99 %),
// the lock let go, then the drift back within reach. Through the presenter's
// real queue, the frames lost (drops and repeats) after the film's start,
// with the quick re-entry (default) and with the base window first (before).
function filmStart({ offset, quickReentry, sw = 15_000, hot = 1.0012, dur = 7_000, seconds = 40 }) {
  const viAt = (t) => (t < sw ? NTSC_VI_MS * 0.999 : t < sw + 1000 ? (NTSC_VI_MS * hot) / 0.99 : t < sw + dur ? NTSC_VI_MS * hot : NTSC_VI_MS);
  const R = 1000 / 60;
  const q = createVsyncQueue({ queueSize: 2, createTexture: () => ({}) });
  const vi = createViPhaseLock({ quickReentry });
  let factor = 1, next = offset, n = 0, tick = 0, last = 0, repeats = 0, dropped0 = null, unlockedMs = 0;
  for (let k = 0; k * R < seconds * 1000; k++) {
    const t = 0.37 * R + k * R;
    const j = (m) => (((m * 7919) % 7) - 3) * 0.6;
    while (next + j(n) <= t) {
      const at = next + j(n);
      q.textureForPass("k", 1, 1);
      q.queueFrame({ n, tick, at });
      vi.arrival(at);
      n++;
      next += viAt(at) / factor;
    }
    tick++;
    vi.tick(t, t);
    if (t - last >= 500) {
      last = t;
      factor = vi.update(t).factor;
      if (t >= sw && !vi.stats.on) unlockedMs += 500;
    }
    if (t >= sw - 1000 && dropped0 === null) dropped0 = q.stats.dropped;
    const f = q.takeForDisplay(tick, null);
    if (f) q.shown(f);
    else if (t >= sw - 1000) repeats++;
  }
  return { lost: repeats + q.stats.dropped - dropped0, released: vi.stats.lost, unlockedMs };
}

test("after a drift out of reach, the lock is taken again once the drift is back within reach (not after a base window): fewer frames lost, never more", () => {
  let before = 0, after = 0, worse = 0, released = 0, unlockedBefore = 0, unlockedAfter = 0;
  for (let offset = 0; offset < 16.5; offset += 0.5) {
    const a = filmStart({ offset, quickReentry: false }), b = filmStart({ offset, quickReentry: true });
    if (!a.released) continue;
    released++;
    before += a.lost; after += b.lost;
    unlockedBefore += a.unlockedMs; unlockedAfter += b.unlockedMs;
    if (b.lost > a.lost + 2) worse++;
  }
  console.log(`film start: ${released} releases; frames lost ${before} -> ${after}; unlocked ${unlockedBefore / 1000} -> ${unlockedAfter / 1000} s; worse in ${worse}`);
  assert.ok(released >= 10, `the scenario lets go (${released})`);
  assert.ok(after < 0.7 * before, `frames lost ${before} -> ${after}`);
  assert.ok(unlockedAfter < 0.7 * unlockedBefore, `unlocked ${unlockedBefore} -> ${unlockedAfter} ms`);
  assert.equal(worse, 0, "never worse by more than 2 frames");
});

// Locked on NTSC at 60 Hz, then out of reach (the game 0.4 % slow) until the
// lock lets go, then NTSC again. Each update's state; `hiddenMs`: no rAF for
// that long right after the release (a hidden tab).
function outAndBack({ offset = 3, hiddenMs = 0, seconds = 50, viAt = null }) {
  const R = 1000 / 60;
  const vi = createViPhaseLock();
  let factor = 1, next = offset, n = 0, last = 0, releasedAt = null, backAt = null;
  const trace = [];
  for (let k = 0; k * R < seconds * 1000; k++) {
    const t = 0.37 * R + k * R;
    // out of reach from 20 s until the release, then back at NTSC
    const viMs = viAt ? viAt(t, releasedAt) : t >= 20_000 && releasedAt === null ? NTSC_VI_MS * 1.004 : NTSC_VI_MS;
    while (next <= t) {
      vi.arrival(next + (((n * 7919) % 5) - 2) * 0.5);
      n++;
      next += viMs / factor;
    }
    const hidden = releasedAt !== null && t < releasedAt + hiddenMs;
    if (!hidden) vi.tick(t, t);
    if (t - last >= 500) {
      last = t;
      const wasOn = vi.stats.on;
      factor = vi.update(t).factor;
      if (wasOn && !vi.stats.on && releasedAt === null && vi.stats.why === "drift out of reach") releasedAt = t;
      if (releasedAt !== null && backAt === null && t > releasedAt && t >= releasedAt + hiddenMs) backAt = t;
      trace.push({ t, on: vi.stats.on, why: vi.stats.why, phase: vi.stats.phase, ppm: vi.stats.ppm });
    }
  }
  const relock = releasedAt === null ? null : trace.find((x, i) => x.t > releasedAt && x.on && !trace[i - 1].on);
  return { vi, trace, releasedAt, backAt, relock };
}

test("a quick re-entry is never taken with the arrivals within REENTRY_CUT_MARGIN of the cut: it waits for them past it", () => {
  let relocks = 0, waitedNearCut = 0;
  for (let offset = 0; offset < 16.6; offset += 0.25) for (const hot of [1.0012, 1.0016]) {
    const sw = 15_000, viAt = (t) => (t < sw ? NTSC_VI_MS * 0.999 : t < sw + 1000 ? (NTSC_VI_MS * hot) / 0.99 : t < sw + 7000 ? NTSC_VI_MS * hot : NTSC_VI_MS);
    const r = outAndBack({ offset, viAt, seconds: 45 });
    if (r.releasedAt === null) continue;
    if (!r.relock) continue;
    relocks++;
    // the phase the lock was taken at (the update that took it)
    assert.ok(Math.min(r.relock.phase, 1 - r.relock.phase) >= REENTRY_CUT_MARGIN - 0.005, `${offset}: taken at ${r.relock.phase} (stats round to 0.01)`);
    // the updates before it that were lockable but held near the cut
    if (r.trace.some((x) => x.t > r.releasedAt && x.t < r.relock.t && x.why === "settling" && x.phase !== null && Math.min(x.phase, 1 - x.phase) < REENTRY_CUT_MARGIN)) waitedNearCut++;
  }
  console.log(`out and back: ${relocks} re-entries, ${waitedNearCut} held near the cut first`);
  assert.ok(relocks >= 20, `re-entries ${relocks}`);
  assert.ok(waitedNearCut >= 3, `the gate held some (${waitedNearCut})`);
});

test("a hidden tab after the release (no rAF): the next lock waits for the base window, as the first one", () => {
  // the film start (filmStart), let go with the arrivals late in the refresh;
  // then the game a little fast, the phase moving away from the cut (the
  // near-cut hold out of the way): only the base window can delay the lock
  const sw = 15_000, viAt = (t, releasedAt) => (releasedAt !== null ? NTSC_VI_MS * 0.9995 : t < sw ? NTSC_VI_MS * 0.999 : t < sw + 1000 ? (NTSC_VI_MS * 1.0012) / 0.99 : t < sw + 7000 ? NTSC_VI_MS * 1.0012 : NTSC_VI_MS);
  let compared = 0;
  for (let offset = 0; offset < 16.5; offset += 0.5) {
    const quick = outAndBack({ offset, viAt, seconds: 45 });
    if (!quick.relock) continue;
    const hidden = outAndBack({ offset, viAt, seconds: 45, hiddenMs: 1200 });
    assert.ok(hidden.relock, `${offset}: locks again after the hidden tab`);
    // hidden: the speed back at the base for ARRIVAL_WINDOW_MS (3 s) first, then 4 updates
    const sinceBack = hidden.relock.t - hidden.backAt;
    assert.ok(sinceBack >= 3_000, `${offset}: hidden, taken ${sinceBack} ms after the rAF came back`);
    compared++;
  }
  assert.ok(compared >= 10, `cases ${compared}`);
  // and quick re-entries do come sooner than that base window on this scenario
  const quickDelays = [];
  for (let offset = 0; offset < 16.5; offset += 0.5) {
    const q = outAndBack({ offset, viAt, seconds: 45 });
    if (q.relock) quickDelays.push(q.relock.t - q.releasedAt);
  }
  quickDelays.sort((a, b) => a - b);
  assert.ok(quickDelays[quickDelays.length >> 1] < 3_000, `quick re-entry median ${quickDelays[quickDelays.length >> 1]} ms`);
  // out of reach for good (60.08 Hz): released and never taken again
  const { vi } = drive({ hzAfter: 60.08 });
  assert.equal(vi.stats.locks, 1);
  assert.equal(vi.stats.on, false);
});

test("a sustained drift past reach after the lock (the game 1 % slow for good): released within 10 s, the speed back to the base", () => {
  const { vi, trace } = drive({ seconds: 60, changeAt: 20_000, viAfter: NTSC_VI_MS * 1.01 });
  assert.ok(trace.filter((x) => x.t < 20_000).at(-1).on, "locked before");
  const released = trace.find((x) => x.t > 20_000 && !x.on);
  assert.ok(released && released.t - 20_000 <= 10_000, `released ${JSON.stringify(released)}`);
  console.log(`1 % slow: released after ${Math.round(released.t - 20_000)} ms (${released.why})`);
  const later = trace.filter((x) => x.t >= released.t + 3_000);
  assert.ok(later.length && later.every((x) => !x.on && x.ppm === 0), JSON.stringify(later.slice(0, 3)));
  assert.equal(vi.stats.locks, 1);
});

// After the logo's load the frames' ARRIVALS at the presenter can lag and
// then drain (the replay catching up), the emulation itself regular: a
// window over the drain reads the frames faster than they are (2P parcours:
// 0.9981 against 1.001, a lock started at -1860 ppm the wrong way and walked
// the phase to the cut at the film's start). The lock starts from the
// window's drift only when its last second agrees, else from none.
// `arrivalOffset(t, n)`: ms added to the n-th arrival (a drain, a ripple, a jitter).
function arrivalsBoot({ offset, arrivalOffset, seconds = 16 }) {
  const R = 1000 / 60;
  const vi = createViPhaseLock();
  let factor = 1, next = offset, n = 0, last = 0, first = null, drift = null, start = null, lockedMs = 0;
  for (let k = 0; k * R < seconds * 1000; k++) {
    const t = 0.37 * R + k * R;
    const at = () => next + arrivalOffset(next, n);
    while (at() <= t) { vi.arrival(at()); n++; next += NTSC_VI_MS / factor; }
    vi.tick(t, t);
    if (t - last >= 500) {
      last = t;
      factor = vi.update(t).factor;
      if (vi.stats.on) lockedMs += 500;
      if (vi.stats.on && first === null) { first = t; drift = vi.stats.driftPpm; start = vi.stats.startDrift; }
    }
  }
  return { first, drift, start, lockedMs };
}
const drainAt = (lagMs, drainMs, load = 3000) => (t, n) => (t < load ? 0 : t < load + 300 ? (lagMs * (t - load)) / 300 : Math.max(0, lagMs * (1 - (t - load - 300) / drainMs))) + (((n * 7919) % 7) - 3) * 0.6;

test("a drain of the arrivals after a load: no lock starts the wrong way (it starts from the window's drift only on a settled window, else from none)", () => {
  let boots = 0, fromWindow = 0, fromNone = 0;
  for (const [lagMs, drainMs] of [[8, 600], [8, 1500], [12, 600]]) for (let offset = 0; offset < 16.6; offset += 0.5) {
    const r = arrivalsBoot({ offset, arrivalOffset: drainAt(lagMs, drainMs) });
    boots++;
    assert.ok(r.first !== null, `${lagMs}/${drainMs} ${offset}: locked`);
    // the drift after the lock's first update: its start plus one step of the
    // integral (at most PHASE_INTEGRAL_PPM_PER_SEC x 0.5 x 0.5 = 375 ppm)
    if (r.start === "window") { fromWindow++; assert.ok(Math.abs(r.drift - 1001) <= 700, `${offset}: from the window at ${r.drift}`); }
    else { fromNone++; assert.ok(Math.abs(r.drift) <= 375, `${offset}: from none at ${r.drift}`); }
  }
  console.log(`drain after a load: ${boots} boots, none started the wrong way; from the window ${fromWindow}, from none ${fromNone}`);
  assert.ok(fromNone >= boots / 2, `the unsettled windows were not trusted (${fromNone})`);
});

test("a ripple or a jitter of the arrivals never keeps the lock off: it locks as often as without the starting-drift check", () => {
  const sine = (ampMs, periodMs) => (t) => ampMs * Math.sin((2 * Math.PI * t) / periodMs);
  const saw = (ampMs, periodMs) => (t) => ampMs * (((t % periodMs) / periodMs) - 0.5);
  // a Gaussian jitter (Box-Muller on a fixed sequence)
  const gauss = (sdMs) => (t, n) => { const u = ((n * 7919 + 13) % 1000 + 0.5) / 1000, v = ((n * 104729 + 7) % 997 + 0.5) / 997; return sdMs * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  for (const [name, f] of [["sine 1.5 ms / 1.5 s", sine(1.5, 1500)], ["sine 1.5 ms / 4 s", sine(1.5, 4000)], ["saw 4 ms / 1.5 s", saw(4, 1500)], ["gauss 5 ms", gauss(5)]]) {
    let locked = 0, boots = 0, never = 0;
    for (let offset = 0; offset < 16.6; offset += 2) {
      const r = arrivalsBoot({ offset, arrivalOffset: f, seconds: 60 });
      boots++; locked += r.lockedMs; if (r.first === null) never++;
    }
    console.log(`${name}: locked ${(locked / boots / 1000).toFixed(1)} s of 60 a boot, never locked ${never}/${boots}`);
    assert.equal(never, 0, `${name}: never locked in ${never} boots`);
    assert.ok(locked / boots >= (name.startsWith("gauss") ? 15_000 : 40_000), `${name}: locked ${locked / boots} ms of 60 s`);
  }
});
