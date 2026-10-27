// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { createGamePacer, createRefreshHistogram, formatRefreshHistogram } from "../src/wgpu-game-pacer.js";

const NTSC_VI_MS = 1000 / 59.94;
import { createVsyncQueue } from "../src/wgpu-vsync-queue.js";

// A screen of `hz` showing a game that queues a frame every `fields` NTSC
// fields, each arrival moved by jitter(n) ms; BeginFrames at a fixed phase.
// Returns the refreshes each frame stayed on screen and the queue's stats.
function play({ hz, fields = 1, jitter = () => 0, paced, frames = 600, queueSize = 2 }) {
  const R = 1000 / hz;
  const q = createVsyncQueue({ queueSize, createTexture: () => ({}) });
  const pacer = createGamePacer();
  const arrivals = [];
  for (let n = 0, t = 0; n < frames; n++) {
    t = Math.max(t, 3 + n * fields * NTSC_VI_MS + jitter(n));
    arrivals.push(t);
  }
  const stays = [];
  const order = [];
  let ai = 0, tick = 0;
  for (let t = 0.37 * R; ai < arrivals.length || q.waiting; t += R) {
    while (ai < arrivals.length && arrivals[ai] <= t) {
      q.textureForPass("k", 1, 1);
      const f = q.queueFrame({ n: ai, tick, at: arrivals[ai] });
      pacer.stamp(arrivals[ai]);
      ai++;
    }
    tick++;
    const f = q.takeForDisplay(tick, paced ? (fr) => pacer.due(fr, t, R) : null);
    if (f) {
      if (paced) pacer.shown(f, t, R);
      q.shown(f);
      order.push(f.n);
      stays.push(1);
    } else if (stays.length) {
      stays[stays.length - 1] += 1;
    }
    if (t > arrivals.at(-1) + 1000) break;
  }
  return { stays: stays.slice(30, -2), order, stats: q.stats, pacer };
}

// Arrivals that straddle a BeginFrame: early, late, early, late...
const straddle = (n) => (n % 2 ? 2.5 : -2.5);

test("120 Hz, 60 fps straddling the BeginFrames: today 1 and 3 refreshes in turn, paced every frame 2", () => {
  const today = play({ hz: 120, jitter: straddle, paced: false });
  assert.ok(today.stays.filter((s) => s !== 2).length > today.stays.length / 3, "today: judder");
  const paced = play({ hz: 120, jitter: straddle, paced: true });
  // 59.94 fps on 120 Hz: one frame in ~500 must stay 3 refreshes, never 1
  assert.equal(paced.stays.filter((s) => s === 1).length, 0, "paced: no frame for 1 refresh");
  assert.ok(paced.stays.filter((s) => s !== 2).length <= 2, "paced: every game frame 2 refreshes, but the 59.94/60 drift");
  assert.equal(paced.stats.dropped, 0);
  assert.ok(paced.pacer.stats.paced > 500);
});

test("60 Hz, 30 fps (the same 2:1 ratio, measurable headless): paced every frame 2 refreshes", () => {
  const jitter = (n) => (n % 2 ? 5 : -5);
  const today = play({ hz: 60, fields: 2, jitter, paced: false });
  assert.ok(today.stays.some((s) => s !== 2), "today: judder");
  const paced = play({ hz: 60, fields: 2, jitter, paced: true });
  assert.equal(paced.stays.filter((s) => s === 1).length, 0);
  assert.ok(paced.stays.filter((s) => s !== 2).length <= 2, "every frame 2 refreshes, but the 59.94/60 drift");
  assert.equal(paced.stats.dropped, 0);
});

test("60 Hz, 60 fps: the switch changes nothing, frame for frame, whatever the jitter", () => {
  for (const jitter of [() => 0, straddle, (n) => ((n * 7919) % 13) - 6]) {
    const today = play({ hz: 60, jitter, paced: false });
    const paced = play({ hz: 60, jitter, paced: true });
    assert.deepEqual(paced.order, today.order);
    assert.deepEqual(paced.stays, today.stays);
    assert.deepEqual(paced.stats, today.stats);
    assert.equal(paced.pacer.stats.paced, 0);
  }
});

test("a full queue is never held for the pace: pacing drops no frame", () => {
  // the game a little faster than its fields (102 %): frames arrive early
  const paced = play({ hz: 120, jitter: (n) => -n * 0.33, paced: true, frames: 300 });
  assert.equal(paced.stats.dropped, 0);
  assert.equal(paced.order.length, 300);
});

test("a late frame is shown when it comes, the previous repeated, then 2 refreshes a frame again; no drop", () => {
  // frame 100 arrives 30 ms late (frame 101 bunched behind it), the rest on time
  const one = play({ hz: 120, jitter: (n) => (n === 100 ? 30 : 0), paced: true, frames: 200 });
  assert.equal(one.stats.dropped, 0);
  assert.ok(one.pacer.stats.late >= 1);
  const odd = one.stays.map((s, i) => (s !== 2 ? i : null)).filter((i) => i !== null);
  assert.ok(odd.length <= 4 && odd.every((i) => i >= 65 && i <= 75), `the hiccup only (stays off 2 at ${odd})`);
  // from frame 100 on, every frame 30 ms later: the stream moved
  const moved = play({ hz: 120, jitter: (n) => (n >= 100 ? 30 : 0), paced: true, frames: 200 });
  assert.equal(moved.stats.dropped, 0);
  assert.ok(moved.stays.slice(75).every((s) => s === 2));
});

test("the game's period: alternating jitter averages out, a stall or a burst is left out", () => {
  const p = createGamePacer();
  let t = 0;
  for (let n = 0; n < 21; n++) p.stamp((t = n * 33.37 + (n % 2 ? 5 : -5)));
  assert.ok(Math.abs(p.period - 33.37) < 0.01, "alternating 23 / 43 ms gaps: P stays 33.4");
  p.stamp((t += 400));
  p.stamp((t += 1));
  assert.ok(Math.abs(p.period - 33.37) < 0.01, "a 400 ms stall and the burst after it change nothing");
});

test("reset(): the display clock alone after a frame shown out of order; with arrival, the game's rate too", () => {
  const p = createGamePacer();
  for (let n = 0; n < 20; n++) p.stamp(n * NTSC_VI_MS);
  assert.ok(Math.abs(p.period - NTSC_VI_MS) < 0.01);
  p.reset();
  assert.ok(p.period !== null, "a late frame keeps the game's rate");
  p.reset({ arrival: true });
  assert.equal(p.period, null);
});

test("refresh histogram: refreshes per game frame over the last 10 s, repeats beyond its share, short stays; the HUD cell", () => {
  const h = createRefreshHistogram();
  const R = 1000 / 120;
  let t = 0;
  // 120 Hz, 60 fps: stays 2, 2, 3, 1, 2 then the next frame closes the last
  for (const stay of [2, 2, 3, 1, 2]) {
    h.tick(2, (t += R));
    for (let i = 1; i < stay; i++) h.tick(null, (t += R));
  }
  h.tick(2, (t += R));
  const s = h.snapshot(t);
  assert.deepEqual(s.counts, [1, 3, 1, 0]);
  assert.equal(s.repeats, 1);
  assert.equal(s.short, 1);
  assert.equal(formatRefreshHistogram(`a refresh:${s.counts.join("/")}/rep${s.repeats}/hz120/pace b`), "20/60/20/0% rep1 120Hz pace");
  assert.equal(formatRefreshHistogram("presentvsync off"), "-");
  // 10 s later the window holds none of them: not a count since boot
  assert.deepEqual(h.snapshot(t + 10001).counts, [0, 0, 0, 0]);
});

// The refreshes each frame is given by shown(), read back through due():
// period P (stamped), screen period R, frames shown as soon as due.
function stays({ P, R, frames = 6, waited = () => 0 }) {
  const p = createGamePacer();
  for (let n = 0; n <= 20; n++) p.stamp(n * P);
  const out = [];
  let t = 1000;
  p.shown({ at: t - waited(0) }, t, R);
  for (let i = 1; i < frames; i++) {
    let k = 1;
    while (p.due({}, t + k * R, R) !== "due") k += 1;
    out.push(k);
    t += k * R;
    p.shown({ at: t - waited(i) }, t, R);
  }
  return out;
}

test("pacer stays: rounded with the fraction carried (2.4 refreshes a frame: 2, 3, 2, 3, 2), not truncated, not dropped", () => {
  // PAL 50 fps on 120 Hz. Truncating (Math.floor) gives 2, 2, 3, 2, 3; no
  // carry gives 2, 2, 2, 2, 2 (the display falls behind the game).
  assert.deepEqual(stays({ P: 20, R: 1000 / 120 }), [2, 3, 2, 3, 2]);
});

test("pacer stays: a frame that waited over a period and half a refresh in the queue stays one refresh less", () => {
  const P = 1000 / 59.94, R = 1000 / 120;
  assert.deepEqual(stays({ P, R, frames: 4 }), [2, 2, 2], "on time: 2 refreshes each");
  // the second frame shown had waited P + R: its stay is shortened to 1
  assert.deepEqual(stays({ P, R, frames: 4, waited: (i) => (i === 1 ? P + R : 0) }), [2, 1, 2]);
});
