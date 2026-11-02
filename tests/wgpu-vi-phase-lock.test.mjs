// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { createViPhaseLock, MAX_PPM, stableRefresh } from "../src/wgpu-vi-phase-lock.js";
import { createVsyncQueue } from "../src/wgpu-vsync-queue.js";

const NTSC_VI_MS = 1000 / 59.94;

// A screen of `hz` (each BeginFrame moved by tickJitter(k) ms) showing a game
// that queues a frame every `fields` VI fields of `viMs` at the speed the lock
// asks (or 1 without it), each arrival moved by jitter(n) ms, through the
// presenter's real queue. Returns the frames shown/dropped/repeated after the
// first `settleSec`, and the lock.
function play({ hz = 60, viMs = NTSC_VI_MS, fields = 1, seconds = 120, settleSec = 20, jitter = (n) => ((n * 7919) % 5) - 2, tickJitter = () => 0, lock = true }) {
  const R = 1000 / hz;
  const q = createVsyncQueue({ queueSize: 2, createTexture: () => ({}) });
  const vi = lock ? createViPhaseLock() : null;
  let factor = 1;
  let nextArrival = 3, n = 0, tick = 0, lastUpdate = 0;
  let shown = 0, repeats = 0, counted = false, droppedAtSettle = 0;
  const end = seconds * 1000;
  for (let k = 0; k * R < end; k++) {
    const t = 0.37 * R + k * R + tickJitter(k);
    // the arrivals before this BeginFrame
    while (nextArrival + jitter(n) <= t) {
      const at = nextArrival + jitter(n);
      q.textureForPass("k", 1, 1);
      q.queueFrame({ n, tick, at });
      vi?.arrival(at);
      n++;
      nextArrival += (fields * viMs) / factor;
    }
    tick++;
    vi?.tick(t);
    if (vi && t - lastUpdate >= 500) {
      lastUpdate = t;
      factor = vi.update(t).factor;
    }
    const f = q.takeForDisplay(tick, null);
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
  return { shown, repeats, dropped: q.stats.dropped - droppedAtSettle, factor, stats: vi?.stats };
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
  assert.ok(near.maxStep <= 400 * 0.55, `step ${near.maxStep} ppm per update`);
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
