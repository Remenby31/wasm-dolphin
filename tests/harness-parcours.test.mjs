// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import { analyzeRun, classifySecond, filmPhaseLabels, newFramesPerSecond, contentSecond, gapDetail, completionOf, currentPhase, deriveSeconds, GAME_DRAWS_PER_FRAME, LOAD_DISC_BPS, markerIndexes, MIN_PHASE_SEC, parcoursVerdict, phaseLabels, phaseMetrics, phaseNoise, renderTimeline, sectionsOf, segmentsOf, summarizeSeconds, windowCadence } from "../harness/lib/parcours.mjs";
import { filmMarkers, filmPhases, filmWithMarks, keyToPad, padStateOf, recordPorts, runRecordSteps, validateFilm, validateRecordSteps } from "../harness/lib/pad-film.mjs";
import { analyzeRaw, countersOf, otherCpuOf, presentGaps, samplerTicksOf, viTimesOf, exitCodeOf, humanSummary, markerStep } from "../harness/probes/parcours.mjs";
import { decodePng, encodePng } from "../harness/lib/png.mjs";

const TPS = 486e6;
const MiB = 1 << 20;
// Phases of a synthetic run, one entry a second: what the signals look like.
const LOOK = {
  boot: { newFps: 0, draws: 0, disc: 4 * MiB, xfb: 0 },
  cinematic: { newFps: 60, draws: 11, disc: 1.8 * MiB, xfb: 60 },
  menu: { newFps: 60, draws: 120, disc: 0, xfb: 60 },
  loading: { newFps: 8, draws: 120, disc: 6 * MiB, xfb: 8 },
  game: { newFps: 60, draws: 400, disc: 0.1 * MiB, xfb: 60 },
  still: { newFps: 0, draws: 0, disc: 0, xfb: 0 }
};
// n presents evenly in the second ending at t: (t - 1000, t]
const presentsIn = (t, n) => Array.from({ length: n }, (_, i) => t - 1000 + ((i + 1) * 1000) / n);
// Raw samples (as the probe records them) for a list of [look, seconds].
function samplesOf(plan, { speed = 100, busy = 0.3, presentGap = null } = {}) {
  const out = [];
  let t = 1000, ticks = 0, shown = 0, draws = 0, disc = 0, xfb = 0;
  out.push({ t, info: { newShown: 0, draws: 0, producedFps: 0 }, counters: { t, ticks, discBytes: 0, xfbCopies: 0 }, presents: [], vi: 0 });
  let sec = 0;
  for (const [look, n] of plan) {
    for (let k = 0; k < n; k += 1, sec += 1) {
      const L = LOOK[look];
      t += 1000; ticks += TPS * (speed / 100); shown += L.newFps; draws += L.draws * L.newFps; disc += L.disc; xfb += L.xfb;
      // the second's new frames, evenly in (t - 1000, t]
      const presents = presentsIn(t, L.newFps);
      if (presentGap?.at === sec) { presents.splice(10, 7); }
      out.push({ t, info: { speed, newShown: shown, producedFps: L.newFps, draws, cpuBusy: busy, gpuBusy: busy, replayBusy: busy, outOfOrder: 0 }, counters: { t, ticks, discBytes: disc, xfbCopies: xfb }, presents, vi: 60, integrity: { id: 1, replayFatal: 0, stateLoads: 0 } });
    }
  }
  return out;
}

test("deriveSeconds: speed from the core ticks, new frames from the presents, rates per frame, hitches from the presents", () => {
  const rows = deriveSeconds(samplesOf([["menu", 3], ["game", 3]], { presentGap: { at: 4 } }), { tps: TPS });
  assert.equal(rows.length, 6);
  assert.equal(rows[0].speed, 100);
  assert.equal(rows[0].newFps, 60);
  assert.equal(rows[0].drawsPerFrame, 120);
  assert.equal(rows[4].drawsPerFrame, 400);
  assert.equal(rows[0].xfbPerFrame, 1);
  assert.equal(rows[4].hitches50, 1, "7 presents missing: one gap of 133 ms");
  assert.equal(rows[4].hitches100, 1);
  assert.equal(rows[3].hitches50, 0);
  assert.equal(rows[0].smoothness, 100);
});

test("deriveSeconds: a second without a sampler row keeps the previous rates", () => {
  const s = samplesOf([["game", 4]]);
  s[2].counters = null;
  const rows = deriveSeconds(s, { tps: TPS });
  assert.equal(rows[1].speed, rows[0].speed);
  assert.equal(rows[1].discBps, rows[0].discBps);
  assert.equal(rows[2].speed, 100, "the next row spans both seconds");
});

test("smoothness: the cadence is learnt like the site's (VI/n, margin under the VI rate), else the VI rate", () => {
  assert.equal(windowCadence({ newFps: 30, producedFps: 30, speed: 100, viRate: 60, cpuBusy: 0.3, gpuBusy: 0.3, replayBusy: 0.3 }), 30);
  assert.equal(windowCadence({ newFps: 30, producedFps: 30, speed: 100, viRate: 60, cpuBusy: 0.8, gpuBusy: 0.3, replayBusy: 0.3 }), null, "no margin: a slow machine never teaches 30");
  assert.equal(windowCadence({ newFps: 30, producedFps: 30, speed: 80, viRate: 60, cpuBusy: 0.3, gpuBusy: 0.3, replayBusy: 0.3 }), null);
  assert.equal(windowCadence({ newFps: 60, producedFps: 60, speed: 100, viRate: 60 }), 60, "the VI rate needs no margin");
  const s = samplesOf([["game", 3]]);
  // a 30 fps game with margin: 30 new frames is 100 %
  for (const x of s.slice(1)) x.presents = presentsIn(x.t, 30), x.info.newShown = (x.info.newShown / 60) * 30, x.info.producedFps = 30;
  const rows = deriveSeconds(s, { tps: TPS });
  assert.deepEqual(rows.map((r) => r.smoothness), [100, 100, 100]);
  const busy = samplesOf([["game", 3]], { busy: 0.9 });
  for (const x of busy.slice(1)) x.presents = presentsIn(x.t, 30), x.info.newShown = (x.info.newShown / 60) * 30, x.info.producedFps = 30;
  assert.deepEqual(deriveSeconds(busy, { tps: TPS }).map((r) => r.smoothness), [50, 50, 50], "without margin: against the VI rate");
});

test("classifySecond: each phase from its generic signals", () => {
  const rows = deriveSeconds(samplesOf([["boot", 1], ["cinematic", 1], ["menu", 1], ["loading", 1], ["game", 1], ["still", 1]]), { tps: TPS });
  rows[0].booted = false;
  assert.deepEqual(rows.map((r) => classifySecond(r)), ["boot", "cinematic", "menu", "loading", "game", null]);
  // new frames with no EFB→XFB copy: a movie written to the XFB
  assert.equal(classifySecond({ ...rows[2], xfbPerFrame: 0, discBps: 0 }), "cinematic");
  // the disc read high but the frames kept coming: not a load the player sees
  assert.equal(classifySecond({ ...rows[2], discBps: 2 * LOAD_DISC_BPS }), "menu");
  // a film's own threshold
  assert.equal(classifySecond(rows[2], { gameDrawsPerFrame: 100 }), "game");
  assert.ok(GAME_DRAWS_PER_FRAME > 180 && GAME_DRAWS_PER_FRAME < 300);
});

test("phaseLabels: hysteresis, a phase lasts at least MIN_PHASE_SEC; no-signal seconds keep the phase before", () => {
  const plan = [["boot", 2], ["cinematic", 6], ["menu", 5], ["game", 1], ["menu", 4], ["loading", 1], ["still", 2], ["loading", 2], ["game", 10]];
  const rows = deriveSeconds(samplesOf(plan), { tps: TPS });
  rows[0].booted = rows[1].booted = false;
  const { labels } = phaseLabels(rows);
  const segs = segmentsOf(labels);
  assert.deepEqual(segs.map((s) => [s.phase, s.to - s.from]), [["boot", 2], ["cinematic", 6], ["menu", 10], ["loading", 5], ["game", 10]]);
  for (const s of segs.slice(1)) assert.ok(s.to - s.from >= MIN_PHASE_SEC);
  // a short run right after the boot joins the run after it, never the boot
  const r2 = deriveSeconds(samplesOf([["boot", 2], ["menu", 1], ["game", 5]]), { tps: TPS });
  r2[0].booted = r2[1].booted = false;
  assert.deepEqual(segmentsOf(phaseLabels(r2).labels).map((s) => [s.phase, s.to - s.from]), [["boot", 2], ["game", 6]]);
});

test("currentPhase: the last MIN_PHASE_SEC seconds must agree", () => {
  const rows = deriveSeconds(samplesOf([["menu", 3], ["game", 1]]), { tps: TPS });
  assert.equal(currentPhase(rows), null);
  const more = deriveSeconds(samplesOf([["menu", 3], ["game", 2]]), { tps: TPS });
  assert.equal(currentPhase(more), "game");
  assert.equal(currentPhase(more.slice(0, 1)), null);
});

test("completion: every marker reached, in order, and the phases found contain them in order; else INCOMPLETE", () => {
  const markers = [{ phase: "menu", label: "title" }, { phase: "game", label: "race" }, { phase: "menu", label: "results" }];
  const segs = [{ phase: "boot" }, { phase: "menu" }, { phase: "loading" }, { phase: "game" }, { phase: "menu" }];
  const all = [{ ordinal: 0, at: 10 }, { ordinal: 1, at: 20 }, { ordinal: 2, at: 30 }];
  assert.equal(completionOf(markers, all, segs).completed, true);
  const missed = completionOf(markers, [all[0], all[1], { ordinal: 2, missed: true }], segs);
  assert.equal(missed.completed, false);
  assert.deepEqual(missed.missing, ["results"]);
  assert.equal(completionOf(markers, [all[0], { ordinal: 1, at: 40 }, all[2]], segs).inOrder, false);
  assert.equal(completionOf(markers, all, segs.slice(0, 4)).phasesInOrder, false, "the run never went back to a menu");
  assert.equal(completionOf([], [], segs).completed, false, "a film without markers proves nothing");
});

test("summaries per phase and per section: min, p5, median, the 3 worst seconds, hitches, integrity, occupancy", () => {
  const s = samplesOf([["menu", 5], ["game", 20]]);
  s[12].info.speed = 70; s[12].counters.ticks -= TPS * 0.3;
  for (let i = 13; i < s.length; i += 1) s[i].counters.ticks -= TPS * 0.3;
  s.at(-1).integrity = { id: 1, replayFatal: 2, stateLoads: 0 };
  const markers = [{ phase: "menu", label: "title" }, { phase: "game", label: "race" }];
  const reached = [{ ordinal: 0, at: s[3].t }, { ordinal: 1, at: s[8].t }];
  const a = analyzeRun({ samples: s, tps: TPS, markers, reached });
  assert.deepEqual(Object.keys(a.phases), ["menu", "game"]);
  assert.equal(a.phases.game.seconds, 20);
  assert.equal(a.phases.game.speed.min, 70);
  assert.equal(a.phases.game.worst[0].speed, 70);
  assert.equal(a.phases.game.worst.length, 3);
  assert.equal(a.phases.game.occupancy.cpuBusy, 0.3);
  assert.deepEqual(a.phases.game.integrity.fatal, ["replayFatal 2"]);
  assert.equal(a.integrityFailed, true);
  assert.deepEqual(Object.keys(a.sections), ["start", "title", "race"]);
  assert.equal(a.sections.race.phases.game, 18);
  assert.equal(a.completion.completed, true);
  assert.equal(a.phases.menu.metrics.speedMedian, 100);
  const sum = summarizeSeconds([]);
  assert.equal(sum.seconds, 0);
  assert.equal(sum.speed.median, null);
});

test("sections: a section per reached marker, a name met twice gets a number", () => {
  const rows = [10, 20, 30, 40, 50].map((at, i) => ({ at, i }));
  const secs = sectionsOf(rows, [{ ordinal: 0, at: 20 }, { ordinal: 1, at: 40 }], [{ phase: "menu", label: "a" }, { phase: "game" }]);
  assert.deepEqual(secs.map((s) => [s.name, s.rows.length]), [["start", 1], ["a", 2], ["game-2", 2]]);
  const s = samplesOf([["menu", 3], ["game", 3], ["menu", 3]]);
  const a = analyzeRun({ samples: s, tps: TPS, markers: [{ phase: "menu", label: "m" }, { phase: "game", label: "g" }, { phase: "menu", label: "m" }], reached: [{ ordinal: 0, at: s[1].t }, { ordinal: 1, at: s[4].t }, { ordinal: 2, at: s[7].t }] });
  assert.deepEqual(Object.keys(a.sections), ["m", "g", "m#2"]);
});

// A/B pairs runs phase by phase: a candidate that spends its time
// elsewhere (a longer boot) is still compared on each phase.
test("A/B: paired by phase, never by timestamp; noise from the A/A; incomplete runs left out", () => {
  const run = (gameSpeed, bootSec) => {
    const s = samplesOf([["boot", bootSec], ["menu", 6], ["game", 12], ["menu", 4]]);
    for (let i = 1 + bootSec + 6; i < 1 + bootSec + 18; i += 1) s[i].counters.ticks = s[i - 1].counters.ticks + TPS * (gameSpeed / 100);
    for (let i = 1 + bootSec + 18; i < s.length; i += 1) s[i].counters.ticks = s[i - 1].counters.ticks + TPS;
    for (let i = 1; i <= bootSec; i += 1) s[i].info.newShown = 0;
    const markers = [{ phase: "menu", label: "title" }, { phase: "game", label: "race" }, { phase: "menu", label: "results" }];
    const reached = [{ ordinal: 0, at: s[bootSec + 2].t }, { ordinal: 1, at: s[bootSec + 8].t }, { ordinal: 2, at: s[bootSec + 20].t }];
    return analyzeRun({ samples: s, tps: TPS, markers, reached });
  };
  const base = [run(100, 2), run(99.5, 2), run(100.5, 2), run(100, 2)];
  const worse = [run(90, 6), run(90.5, 5), run(89.5, 7), run(90, 6)];
  const v = parcoursVerdict(base, worse);
  assert.equal(v.regression, true);
  assert.ok(v.regressions.some((r) => r.where === "kind:game" && r.metric === "speedMedian"));
  assert.ok(v.regressions.some((r) => r.where === "section:race"));
  assert.ok(!v.regressions.some((r) => r.where === "kind:menu"), "the menus did not move");
  const same = parcoursVerdict(base, [run(100, 4), run(99.5, 3), run(100.5, 5)]);
  assert.equal(same.regression, false);
  // noise from an A/A: per phase key
  const noise = phaseNoise(base);
  assert.ok(noise["kind:game"].speedMedian.stdev >= 0);
  assert.ok(Object.keys(phaseMetrics(base[0])).includes("section:results"));
  // an incomplete run never counts
  const incomplete = { ...worse[0], completion: { completed: false } };
  assert.equal(parcoursVerdict(base, [incomplete, incomplete, incomplete]).usable.candidate, 0);
  assert.equal(parcoursVerdict(base, [incomplete]).inconclusive, true);
});

test("timeline PNG: a picture of the run's size, phase bands coloured, encodable", () => {
  const s = samplesOf([["menu", 10], ["game", 30]]);
  const a = analyzeRun({ samples: s, tps: TPS, markers: [{ phase: "game", label: "race" }], reached: [{ ordinal: 0, at: s[12].t, t: 11 }] });
  const img = renderTimeline(a, { markers: markerIndexes(a, [{ ordinal: 0, at: s[12].t, t: 11 }], [{ phase: "game", label: "race" }]) });
  assert.equal(img.height, 320);
  assert.equal(img.width, Math.max(320, 34 + 8 + 40 * 4));
  assert.equal(img.data.length, img.width * img.height * 4);
  const back = decodePng(encodePng(img));
  assert.equal(back.width, img.width);
  // a pixel inside the game band of the first panel is the game colour
  const x = 34 + 30 * 4, y = 40, i = (y * img.width + x) * 4;
  assert.deepEqual([...img.data.slice(i, i + 3)], [170, 230, 170]);
  // long runs are capped
  const long = renderTimeline({ rows: Array.from({ length: 5000 }, () => ({ speed: 100, newFps: 60, phase: "game" })), segments: [] });
  assert.equal(long.width, 4000);
});

// --- the pad film -------------------------------------------------------------

// pad-film-worker.js is a classic worker script: its pure part runs in node through vm.
function loadWorker() {
  const sandbox = { Math, Number, Boolean, String, Infinity, Atomics, Int32Array, performance };
  vm.runInNewContext(readFileSync(new URL("../harness/lib/pad-film-worker.js", import.meta.url), "utf8"), sandbox);
  return sandbox;
}

test("film validation: ports, steps in order, one kind each, phases from the detector's list", () => {
  const ok = { unit: "poll", ports: [0, 1], end: 100, steps: [{ at: 0, mask: 1, stick: [128, 128] }, { at: 10, port: 1, mask: 0, stick: [0, 255] }, { at: 20, phase: "menu", label: "title" }, { at: 30, auto: { polls: 50 } }] };
  assert.equal(validateFilm(ok), ok);
  assert.ok(validateFilm({ unit: "poll", port: 0, end: 5, steps: [{ at: 1, mask: 1, stick: [128, 128] }] }), "salon's one-port film");
  assert.throws(() => validateFilm({ ...ok, unit: "ms" }), /unit must be "poll"/);
  assert.throws(() => validateFilm({ ...ok, steps: [{ at: 5, mask: 0, stick: [1, 1] }, { at: 4, mask: 0, stick: [1, 1] }] }), /≥ the previous/);
  assert.throws(() => validateFilm({ ...ok, steps: [{ at: 1, port: 2, mask: 0, stick: [1, 1] }] }), /not one of the film's ports/);
  assert.throws(() => validateFilm({ ...ok, steps: [{ at: 1, phase: "race" }] }), /not one of boot, loading/);
  assert.throws(() => validateFilm({ ...ok, steps: [{ at: 1, phase: "menu", mask: 1, stick: [1, 1] }] }), /exactly one of/);
  assert.throws(() => validateFilm({ ...ok, steps: [{ at: 1, auto: { speed: 3 } }] }), /auto takes/);
  assert.throws(() => validateFilm({ ...ok, end: 10 }), /before its last step/);
  assert.deepEqual(filmMarkers(ok), [{ at: 20, phase: "menu", label: "title", timeoutSec: null }]);
});

test("film player: pad states on the game's polls, per port, neutral before the first", () => {
  const w = loadWorker();
  const p = w.createPlayer({ unit: "poll", ports: [0, 1], end: 10, steps: [{ at: 2, mask: 1, stick: [128, 128] }, { at: 3, port: 1, mask: 2, stick: [0, 128] }, { at: 5, mask: 0, stick: [128, 128] }] });
  const writes = [];
  let out;
  for (let n = 1; n <= 10; n += 1) { out = p.onPoll(n, { released: 0, stuck: 0 }); writes.push(out.writes.map(([port, s]) => `${n}:${port}:${s.mask}`)); }
  assert.deepEqual(writes.flat(), ["1:0:0", "1:1:0", "2:0:1", "3:1:2", "5:0:0"]);
  assert.equal(out.done, true);
  // a missed poll (n jumps): the film still lands on the poll's position
  const q = w.createPlayer({ unit: "poll", port: 0, end: 10, steps: [{ at: 4, mask: 1, stick: [128, 128] }] });
  q.onPoll(1, { released: 0, stuck: 0 });
  assert.equal(q.onPoll(5, { released: 0, stuck: 0 }).writes[0][1].mask, 1);
});

test("film player: a RESYNC marker holds the film (neutral pad) until released, before the steps of its own poll", () => {
  const w = loadWorker();
  const p = w.createPlayer({ unit: "poll", port: 0, end: 20, steps: [{ at: 1, mask: 1, stick: [128, 128] }, { at: 5, phase: "game" }, { at: 5, mask: 16, stick: [128, 128] }] });
  for (let n = 1; n <= 4; n += 1) p.onPoll(n, { released: 0, stuck: 0 });
  let out = p.onPoll(5, { released: 0, stuck: 0 });
  assert.equal(out.hold, 1);
  assert.equal(out.writes[0][1].mask, 0, "neutral while held");
  for (let n = 6; n <= 50; n += 1) out = p.onPoll(n, { released: 0, stuck: 0 });
  assert.equal(out.pos, 5, "the film does not move while held");
  assert.equal(out.done, false);
  out = p.onPoll(51, { released: 1, stuck: 0 });
  assert.equal(out.hold, 0);
  assert.equal(out.writes[0][1].mask, 16, "the marker's own steps once released");
  assert.equal(out.pos, 6);
  for (let n = 52; n <= 70; n += 1) out = p.onPoll(n, { released: 1, stuck: 0 });
  assert.equal(out.done, true);
});

test("film player: the autopilot drives until the port's next step, keeps driving through a hold, takes the way out on a stuck signal", () => {
  const w = loadWorker();
  const p = w.createPlayer({ unit: "poll", port: 0, end: 400, steps: [{ at: 1, auto: { amp: 50, periodPolls: 100, recoverPolls: 30 } }, { at: 200, phase: "menu", label: "results" }, { at: 300, mask: 16, stick: [128, 128] }] });
  let out = p.onPoll(1, { released: 0, stuck: 0 });
  assert.equal(out.writes[0][1].mask, 1, "A held");
  const xs = [];
  for (let n = 2; n <= 60; n += 1) { out = p.onPoll(n, { released: 0, stuck: 0 }); if (out.writes.length) xs.push(out.writes[0][1].stick[0]); }
  assert.ok(Math.max(...xs) > 170 && Math.min(...xs) < 170, "the stick sweeps");
  out = p.onPoll(61, { released: 0, stuck: 1 });
  assert.equal(out.writes[0][1].mask, 2, "B: backing off");
  assert.equal(out.writes[0][1].stick[0], 28);
  for (let n = 62; n <= 91; n += 1) out = p.onPoll(n, { released: 0, stuck: 1 });
  assert.equal(p.onPoll(92, { released: 0, stuck: 1 }).writes.length ? 1 : 1, 1);
  for (let n = 93; n <= 250; n += 1) out = p.onPoll(n, { released: 0, stuck: 1 });
  assert.equal(out.hold, 1);
  assert.equal(out.pos, 200);
  // held, the autopilot keeps A down
  const held = p.onPoll(251, { released: 0, stuck: 1 });
  assert.ok(!held.writes.length || held.writes[0][1].mask === 1);
  for (let n = 252; n <= 400; n += 1) out = p.onPoll(n, { released: 1, stuck: 1 });
  assert.equal(out.pos, 349);
  // past 300 the port's pad step took over
  assert.equal(p.onPoll(401, { released: 1, stuck: 1 }).writes.length, 0);
});

test("film recorder: the live states the page sets, on the poll they took effect, autopilot spans as one step", () => {
  const w = loadWorker();
  const r = w.createRecorder([0, 1], { amp: 40 });
  const neutral = { mask: 0, stick: [128, 128], auto: false };
  r.onPoll(1, { 0: neutral, 1: neutral });
  r.onPoll(2, { 0: { mask: 1, stick: [128, 128], auto: false }, 1: neutral });
  r.onPoll(3, { 0: { mask: 1, stick: [128, 128], auto: false }, 1: neutral });
  r.onPoll(4, { 0: { ...neutral, auto: true }, 1: { mask: 16, stick: [128, 128], auto: false } });
  const a = r.onPoll(5, { 0: { ...neutral, auto: true }, 1: { mask: 16, stick: [128, 128], auto: false } });
  assert.equal(a.writes[0][1].mask, 1, "the autopilot drives port 0");
  r.onPoll(6, { 0: neutral, 1: neutral });
  const film = r.film(6);
  assert.deepEqual(JSON.parse(JSON.stringify(film.steps)).map((s) => [s.at, s.port, s.auto ? "auto" : s.mask]), [[1, 0, 0], [1, 1, 0], [2, 0, 1], [4, 0, "auto"], [4, 1, 16], [6, 0, 0], [6, 1, 0]]);
  assert.equal(film.steps[3].auto.amp, 40);
  assert.doesNotThrow(() => validateFilm(film));
  // marks placed in the recorded film, before the steps of their poll
  const marked = filmWithMarks(film, [{ phase: "game", label: "race", pos: 4 }, { phase: "menu", label: "results", pos: null, missed: true }], "test");
  assert.deepEqual(JSON.parse(JSON.stringify(marked.steps)).slice(3, 5).map((s) => s.phase ?? s.at), ["game", 4]);
  assert.deepEqual([...marked.missedMarks], ["results"]);
  assert.equal(marked.about, "test");
  assert.doesNotThrow(() => validateFilm(marked));
});

test("record steps: lib/steps.mjs kinds plus mark and auto; keys mapped as the engine's keyboard", () => {
  assert.equal(keyToPad("KeyX"), "A");
  assert.equal(keyToPad("Enter"), "START");
  assert.throws(() => keyToPad("KeyP"), /not bound/);
  assert.deepEqual(padStateOf(new Set(["A", "B"])), { mask: 3, stick: [128, 128] });
  const left = padStateOf(new Set(["STICK_LEFT"]));
  assert.equal(left.mask, 0, "stick directions are axes, not buttons");
  assert.ok(left.stick[0] < 40 && left.stick[1] === 128);
  assert.ok(validateRecordSteps([{ wait: 1 }, { tap: "KeyX", repeat: 2, every: 1 }, { mark: "menu", label: "title" }, { auto: 30, until: "menu" }, { down: "KeyW", port: 1 }]));
  assert.throws(() => validateRecordSteps([{ mark: "race" }]), /not one of/);
  assert.throws(() => validateRecordSteps([{ tap: "KeyP" }]), /not bound/);
  assert.throws(() => validateRecordSteps([{ auto: 0 }]), /seconds > 0/);
  assert.throws(() => validateRecordSteps([{ wait: 1, port: 5 }]), /0-3/);
  assert.deepEqual(recordPorts([{ wait: 1 }, { tap: "KeyX", port: 1 }]), [0, 1]);
  assert.deepEqual(recordPorts([{ auto: 5, ports: [2, 0] }]), [0, 2]);
  assert.throws(() => validateRecordSteps([{ wait: 1, ports: [0, 1] }]), /only with auto/);
});

test("runRecordSteps: live states set in order, marks wait for the phase, the autopilot until its phase", async () => {
  const calls = [];
  let t = 0, phase = null;
  const live = {
    setLive: async (_, port, s) => calls.push(["live", port, s.mask]),
    setAuto: async (_, port, on) => calls.push(["auto", port, on]),
    status: async () => ({ polls: Math.round(t / 8) })
  };
  const marks = [];
  const wait = async (ms) => { t += ms; if (t >= 3000) phase = "menu"; if (t >= 9000) phase = "game"; };
  await runRecordSteps({ mouse: { click: async () => calls.push(["click"]) } }, [
    { click: [1, 2] }, { tap: "KeyX", hold: 100 }, { mark: "menu", label: "title", timeoutSec: 10 }, { auto: 60, until: "game" }, { mark: "loading", timeoutSec: 1 }
  ], { phase: () => phase, onMark: (m) => marks.push(m), wait, now: () => t, live });
  assert.deepEqual(calls, [["click"], ["live", 0, 1], ["live", 0, 0], ["auto", 0, true], ["auto", 0, false], ["live", 0, 0]]);
  calls.length = 0;
  await runRecordSteps({}, [{ auto: 1, ports: [0, 1] }], { phase: () => null, wait, now: () => t, live });
  assert.deepEqual(calls, [["auto", 0, true], ["auto", 1, true], ["auto", 0, false], ["live", 0, 0], ["auto", 1, false], ["live", 1, 0]]);
  assert.equal(marks[0].phase, "menu");
  assert.equal(marks[0].missed, false);
  assert.ok(marks[0].pos >= 3000 / 8);
  assert.equal(marks[1].missed, true, "a mark whose phase never came is missed");
  assert.ok(t >= 9000 && t < 12000, "the autopilot stopped when the game phase showed");
});

// --- the probe's pure parts -----------------------------------------------------

test("probe: the sampler's last row as counters; marker steps release on the phase, miss after the timeout", () => {
  assert.equal(countersOf({ rows: [] }), null);
  assert.deepEqual(countersOf({ columns: ["t", "lagMs", "ticks", "discBytes", "xfbCopies"], rows: [[1, 0, 2, 3, 4], [5, 0, 6, 7, 8]] }), { t: 5, ticks: 6, frame: null, discBytes: 7, xfbCopies: 8 });
  const markers = [{ phase: "menu", timeoutSec: null }, { phase: "game", timeoutSec: 5 }];
  const state = { held: 0, since: 0 };
  assert.equal(markerStep({ status: { hold: 0 }, markers, phase: "menu", now: 0, state, defaultTimeoutSec: 60 }).action, "none");
  assert.equal(markerStep({ status: { hold: 1, released: 0 }, markers, phase: "boot", now: 1000, state, defaultTimeoutSec: 60 }).action, "wait");
  assert.deepEqual(markerStep({ status: { hold: 1, released: 0 }, markers, phase: "menu", now: 2000, state, defaultTimeoutSec: 60 }), { action: "release", ordinal: 0 });
  assert.equal(markerStep({ status: { hold: 1, released: 1 }, markers, phase: "menu", now: 2000, state, defaultTimeoutSec: 60 }).action, "none", "released, the worker has not moved yet");
  assert.equal(markerStep({ status: { hold: 2, released: 1 }, markers, phase: "menu", now: 3000, state, defaultTimeoutSec: 60 }).action, "wait");
  assert.deepEqual(markerStep({ status: { hold: 2, released: 1 }, markers, phase: "menu", now: 8001, state, defaultTimeoutSec: 60 }), { action: "missed", ordinal: 1 });
});

test("probe: a run analysed from its raw record, its summary lines and exit code", () => {
  const s = samplesOf([["menu", 4], ["game", 6], ["menu", 3]]);
  const raw = { samples: s, tps: TPS, markers: [{ phase: "menu", label: "title" }, { phase: "game", label: "race" }], reached: [{ ordinal: 0, at: s[2].t, t: 1 }, { ordinal: 1, at: s[6].t, t: 5 }], loads: [[0, 1], [1, 2]], power: null, powerEnd: null };
  const a = analyzeRaw(raw, { maxLoad: 4 });
  assert.equal(a.completion.completed, true);
  assert.equal(a.overloaded, false);
  const summary = { runs: [{ side: "candidate", run: 1, ...a }], sides: { candidate: "this tree" } };
  const lines = humanSummary(summary);
  assert.match(lines[0], /^candidate 1: COMPLETE, 13 s, menu 4 > game 6 > menu 3/);
  assert.match(lines[1], /menu\s+7 s\s+speed 100/);
  assert.equal(exitCodeOf(summary), 0);
  assert.equal(exitCodeOf({ runs: [{ ...summary.runs[0], completion: { completed: false } }] }), 1);
  assert.equal(exitCodeOf({ runs: [{ ...summary.runs[0], integrityFailed: true }] }), 2);
  assert.equal(exitCodeOf({ ...summary, verdict: { regression: true }, noVerdict: null }), 2);
  assert.equal(exitCodeOf({ ...summary, verdict: { regression: false }, noVerdict: ["x"] }), 3);
  assert.deepEqual(analyzeRaw({ error: "boom" }), { error: "boom", ended: null });
  // a recorded run: its marks are its markers
  const rec = analyzeRaw({ samples: s, tps: TPS, marks: [{ phase: "menu", label: "title", pos: 10, t: 1 }, { phase: "game", label: "race", pos: 50, t: 5 }], loads: [] }, { maxLoad: 4 });
  assert.equal(rec.completion.completed, true);
  assert.deepEqual(rec.reached.map((r) => r.label), ["title", "race"]);
});

// --- the autopilot's eyes ---------------------------------------------------------

// A synthetic view: sky, then a road band [roadL, roadR] (columns) on grass,
// the player's vehicle in the middle.
function sceneOf(w, h, roadL, roadR) {
  const d = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
    const c = y < h * 0.35 ? [90, 140, 250] : x >= roadL && x <= roadR ? [110, 110, 115] : [40, 160, 40];
    const car = y > h * 0.45 && y < h * 0.8 && x > w * 0.42 && x < w * 0.6;
    d.set(car ? [200, 30, 30, 255] : [...c, 255], (y * w + x) * 4);
  }
  return d;
}

test("edge follower: steers towards the middle of the road it sees, away from the side where it ends; nothing without a road ahead", async () => {
  const { steerFromPixels } = await import("../harness/lib/edge-follower.mjs");
  const W = 128, H = 96;
  const centred = steerFromPixels(sceneOf(W, H, 20, 108), W, H);
  assert.ok(Math.abs(centred.x - 128) <= 12, `centred road: ${centred.x}`);
  const right = steerFromPixels(sceneOf(W, H, 45, 120), W, H);
  assert.ok(right.x > 150, `road going right: ${right.x}`);
  const left = steerFromPixels(sceneOf(W, H, 5, 85), W, H);
  assert.ok(left.x < 106, `road going left: ${left.x}`);
  // no one colour ahead (a wall's pattern, a menu): no steering, the sine drives
  const busy = sceneOf(W, H, 20, 108);
  for (let x = 0; x < W; x += 1) for (const y of [Math.floor(0.4 * H)]) busy.set([[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255]][x % 3], (y * W + x) * 4);
  assert.equal(steerFromPixels(busy, W, H).x, null);
  // a split screen: the bottom half's view only
  const two = new Uint8Array(W * H * 2 * 4);
  two.set(sceneOf(W, H, 5, 85), 0);
  two.set(sceneOf(W, H, 45, 120), W * H * 4);
  assert.ok(steerFromPixels(two, W, H * 2, [0, 0.5, 1, 1]).x > 150);
  assert.ok(steerFromPixels(two, W, H * 2, [0, 0, 1, 0.5]).x < 106);
});

test("film player: the picture's steering replaces the sine under the autopilot, the way out still wins", () => {
  const w = loadWorker();
  const p = w.createPlayer({ unit: "poll", port: 0, end: 100, steps: [{ at: 1, auto: { recoverPolls: 5 } }] });
  assert.equal(p.onPoll(1, { released: 0, stuck: 0, steer: { 0: 200 } }).writes[0][1].stick[0], 200);
  assert.equal(p.onPoll(2, { released: 0, stuck: 0, steer: { 0: 60 } }).writes[0][1].stick[0], 60);
  const out = p.onPoll(3, { released: 0, stuck: 1, steer: { 0: 60 } });
  assert.equal(out.writes[0][1].mask, 2, "B: backing off");
  assert.notEqual(p.onPoll(4, { released: 0, stuck: 1, steer: { 0: null } }).writes.length ? 1 : 0, 2);
});

// Review of #413 (#411's rule): an absent datum stays unknown, never 0.
test("a present gap's VIs in [a, b) and the worker's stall: null when unknown, 0 only for an on-time tick inside it", () => {
  // VIs in [a, b): the one at a counts, the one at b does not
  assert.equal(gapDetail(1000, 1100, [1000, 1050, 1100], []).vis, 2);
  // a 60 ms late tick ending inside: 60; a stall across the gap's end: its part inside
  assert.equal(gapDetail(1000, 1100, [], [[1080, 60], [1300, 40]]).workerLagMs, 60);
  assert.equal(gapDetail(1000, 1100, [], [[1150, 100]]).workerLagMs, 50);
  // an on-time tick due inside: 0
  assert.equal(gapDetail(1000, 1100, [], [[1050, 0]]).workerLagMs, 0);
  // no tick due inside nor stalled across it (the 100 ms blind spot): unknown
  assert.equal(gapDetail(1000, 1040, [], [[990, 0], [1090, 0]]).workerLagMs, null);
  // the sampler not read, the ring lost entries: unknown
  assert.equal(gapDetail(1000, 1100, null, null).workerLagMs, null);
  assert.equal(gapDetail(1000, 1100, null, null).vis, null);
});

test("per present, the gap before it (the adapter's gapVis, gapWorkerLagMs): unknown when either second's data is", () => {
  const prev = { presents: [900, 983], viT: [950], samplerTicks: [[960, 0]] };
  const r = presentGaps(prev, { presents: [1000, 1100], viT: [990, 1016, 1050], samplerTicks: [[1060, 0], [1090, 50]] });
  assert.deepEqual(r.vis, [1, 2]);
  assert.deepEqual(r.workerLagMs, [null, 50], "983-1000: no tick due in it");
  assert.deepEqual(presentGaps(undefined, { presents: [5, 21], viT: [10], samplerTicks: [[12, 0]] }), { vis: [null, 1], workerLagMs: [null, 0] });
  // this second's ring lost entries, or its drain failed
  assert.deepEqual(presentGaps(prev, { presents: [1000], viT: null, samplerTicks: [[990, 0]] }).vis, [null]);
  assert.deepEqual(presentGaps(prev, { presents: [1000], viT: [990], samplerTicks: null }).workerLagMs, [null]);
  // the previous second's data unknown: the gap spanning both is too
  assert.deepEqual(presentGaps({ ...prev, viT: null }, { presents: [1000], viT: [990], samplerTicks: [[990, 0]] }).vis, [null]);
  // the probe's readers
  assert.deepEqual(samplerTicksOf({ columns: ["t", "lagMs", "ticks"], rows: [[1, 5, 0], [2, 30, 0]] }), [[1, 5], [2, 30]], "every tick, on time ones too");
  assert.equal(samplerTicksOf({ error: "timeout" }), null);
  assert.equal(samplerTicksOf(null), null);
  assert.equal(viTimesOf({ presents: { t: [], lost: 0 }, vi: { t: [1, 2], lost: 0 } }).length, 2);
  assert.equal(viTimesOf({ presents: { t: [], lost: 3 }, vi: { t: [1, 2], lost: 0 } }), null, "presents lost");
  assert.equal(viTimesOf({ presents: { t: [] }, vi: { t: [1], lost: 1 } }), null, "VIs lost");
  assert.equal(viTimesOf({ error: "x" }), null);
  // the row's workerLagMs: unknown without ticks
  const s = samplesOf([["menu", 2]]);
  s[1].samplerTicks = [[1, 0], [2, 40]];
  s[2].samplerTicks = null;
  const rows = deriveSeconds(s, { tps: TPS });
  assert.equal(rows[0].workerLagMs, 40);
  assert.equal(rows[1].workerLagMs, null);
  assert.equal("gaps" in rows[0], false, "no invented per-row gaps");
  const probe = readFileSync(new URL("../harness/probes/parcours.mjs", import.meta.url), "utf8");
  assert.ok(probe.indexOf("const tl = await readTimeline(page)") < probe.indexOf('"validationDropSampler", { action: "drain" }'), "the timeline read before the sampler is drained");
  assert.match(probe, /raw\.samplerMissing = /);
});

test("the other processes' CPU: this run's process tree left out (helpers without the profile directory included), the top three", () => {
  const ps = [
    "  10     1  50.0 /usr/libexec/fseventsd",
    "  12     1  30.0 node probe",
    "  20    12  40.0 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/tmp/gc-harness-parcours-abc",
    "  21    20  80.0 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Helper (GPU) --type=gpu-process",
    "  22    20  60.0 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Helper (Renderer) --type=renderer",
    "  23    22   5.0 /some/grandchild",
    "  30     1  70.0 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Helper (GPU) --type=gpu-process",
    "  40     1  12.0 /opt/other/cfd-solver --mesh x",
    "  41     1   2.0 /bin/zsh"
  ].join("\n");
  const [t, pct, top] = otherCpuOf(ps, { profileDir: "/tmp/gc-harness-parcours-abc", selfPid: 12, now: 5 });
  assert.equal(t, 5);
  assert.equal(pct, 50 + 70 + 12 + 2, "the run's node, browser, helpers and their children left out; another Chrome's GPU counted");
  assert.deepEqual(top, [["Google Chrome Helper (GPU)", 70], ["fseventsd", 50], ["cfd-solver", 12]]);
});

// #415 used `sec` above its declaration: every run failed with a TDZ
// ReferenceError ("Cannot access 'sec' before initialization").
test("probe: the sampling loop declares each name before its first use", () => {
  const src = readFileSync(new URL("../harness/probes/parcours.mjs", import.meta.url), "utf8");
  const loop = src.slice(src.indexOf("while (!ended) {"), src.indexOf("raw.ended = ended;"));
  for (const name of ["sec", "phase", "status", "drained", "tl"]) {
    const decl = new RegExp(`(?:const|let) (?:\\{[^}]*\\b)?${name}\\b`).exec(loop);
    assert.ok(decl, `${name} declared in the loop`);
    const use = new RegExp(`(?<![\\w.])${name}(?![\\w:])`).exec(loop.slice(0, decl.index));
    assert.equal(use, null, `${name} used before its declaration`);
  }
});

// Content, not a loss (parcours A/A of 2026-11-01: 31 % of the menus' deficit):
// the game made fewer frames than the cadence at full speed with margin.
test("smoothness: a content second (made that few at full speed, with margin) is judged against what was made", () => {
  const s = samplesOf([["menu", 3]]);
  for (const x of s.slice(1)) { x.presents = presentsIn(x.t, 45), x.info.newShown = (x.info.newShown / 60) * 45; x.info.producedFps = 45; }
  const rows = deriveSeconds(s, { tps: TPS });
  assert.deepEqual(rows.map((r) => r.smoothness), [100, 100, 100]);
  assert.deepEqual(rows.map((r) => r.content), [true, true, true]);
  assert.equal(rows[0].sceneCadence, 60);
  // a frame made and not shown is still a loss
  const lost = samplesOf([["menu", 2]]);
  for (const x of lost.slice(1)) { x.presents = presentsIn(x.t, 40), x.info.newShown = (x.info.newShown / 60) * 40; x.info.producedFps = 45; }
  assert.deepEqual(deriveSeconds(lost, { tps: TPS }).map((r) => r.smoothness), [88.9, 88.9]);
  // no margin (a saturated thread can be why it made few) or slow: against the cadence
  const busy = samplesOf([["menu", 2]], { busy: 0.9 });
  for (const x of busy.slice(1)) { x.presents = presentsIn(x.t, 45), x.info.newShown = (x.info.newShown / 60) * 45; x.info.producedFps = 45; }
  assert.deepEqual(deriveSeconds(busy, { tps: TPS }).map((r) => r.smoothness), [75, 75]);
  assert.equal(contentSecond({ producedFps: 45, speed: 90, cadence: 60, cpuBusy: 0.2, gpuBusy: 0.2, replayBusy: 0.2 }), false);
  assert.equal(contentSecond({ producedFps: 59, speed: 100, cadence: 60, cpuBusy: 0.2, gpuBusy: 0.2, replayBusy: 0.2 }), false, "within the shown share: no content second");
  assert.equal(contentSecond({ producedFps: 45, speed: 100, cadence: 60, cpuBusy: 0.2, gpuBusy: null, replayBusy: 0.2 }), false, "unknown occupancy is no margin");
  // a loading screen animating at 45 is still a loading when the disc reads
  const load = deriveSeconds(samplesOf([["loading", 2]]), { tps: TPS });
  assert.equal(classifySecond(load[0]), "loading");
  const a = analyzeRun({ samples: s, tps: TPS });
  assert.equal(a.phases.menu.contentSeconds, 3);
});

test("one definition of content: parcours' contentSecond is lib/drops.mjs contentRule", async () => {
  const { contentRule } = await import("../harness/lib/drops.mjs");
  for (const speed of [95, 98.9, 99, 100]) for (const producedFps of [30, 56, 58]) for (const busy of [0.5, 0.69, 0.7, 0.9, null]) {
    const r = { producedFps, speed, cadence: 60, cpuBusy: busy, gpuBusy: 0.2, replayBusy: 0.2 };
    assert.equal(contentSecond(r), contentRule({ speed, produced: producedFps, expected: 60, occupancy: { cpu: busy, gpu: 0.2, replay: 0.2 } }), JSON.stringify(r));
  }
  const src = readFileSync(new URL("../harness/lib/parcours.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(src, /CONTENT_MIN_SPEED/, "no second set of thresholds");
});

// Review of #410: an unknown value never passes as content (null >= 0 is
// true in JS), a second with nothing made is no content reference (0/0).
test("content: an unknown production, speed or cadence is no content; none made is no reference; the smoothness stays judged", async () => {
  const { contentRule } = await import("../harness/lib/drops.mjs");
  const calm = { cpu: 0.2, gpu: 0.2, replay: 0.2 };
  assert.equal(contentRule({ speed: 100, produced: null, expected: 60, occupancy: calm }), false);
  assert.equal(contentRule({ speed: 100, produced: NaN, expected: 60, occupancy: calm }), false);
  assert.equal(contentRule({ speed: null, produced: 30, expected: 60, occupancy: calm }), false);
  assert.equal(contentRule({ speed: 100, produced: 30, expected: null, occupancy: calm }), false);
  assert.equal(contentRule({ speed: 100, produced: 30, expected: NaN, occupancy: calm }), false);
  assert.equal(contentRule({ speed: 100, produced: 30, expected: 60, occupancy: { ...calm, cpu: null } }), false);
  assert.equal(contentRule({ speed: 100, produced: 0, expected: 60, occupancy: calm }), true, "the attribution: a still screen is content");
  assert.equal(contentSecond({ producedFps: null, speed: 100, cadence: 60, cpuBusy: 0.2, gpuBusy: 0.2, replayBusy: 0.2 }), false);
  assert.equal(contentSecond({ producedFps: 0, speed: 100, cadence: 60, cpuBusy: 0.2, gpuBusy: 0.2, replayBusy: 0.2 }), false, "0/0: no reference");
  // producedFps missing: judged against the cadence, never 100 % by an Infinity
  const s = samplesOf([["menu", 2]]);
  for (const x of s.slice(1)) { x.presents = presentsIn(x.t, 40), x.info.newShown = (x.info.newShown / 60) * 40; x.info.producedFps = null; }
  assert.deepEqual(deriveSeconds(s, { tps: TPS }).map((r) => [r.content, r.smoothness]), [[false, 66.7], [false, 66.7]]);
  const z = samplesOf([["menu", 2]]);
  for (const x of z.slice(1)) { x.presents = [], x.info.newShown = 0; x.info.producedFps = 0; }
  assert.deepEqual(deriveSeconds(z, { tps: TPS }).map((r) => r.smoothness), [0, 0]);
});

test("readNoise refuses an A/A analysed under another analysis version (its noise is of another metric)", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const os = await import("node:os");
  const { readNoise } = await import("../harness/probes/parcours.mjs");
  const { ANALYSIS_VERSION } = await import("../harness/lib/parcours.mjs");
  const dir = mkdtempSync(`${os.tmpdir()}/parcours-noise-`);
  const base = { probe: "parcours", probeVersion: 2, film: "f#1", query: "q", noise: { "kind:menu": {} } };
  const expect = { probeVersion: 2, film: "f#1", query: "q" };
  writeFileSync(`${dir}/old.json`, JSON.stringify(base));
  assert.throws(() => readNoise(`${dir}/old.json`, expect), /analysed with analysis version 1, this probe judges with \d+: re-analyse it/);
  writeFileSync(`${dir}/new.json`, JSON.stringify({ ...base, analysisVersion: ANALYSIS_VERSION }));
  assert.deepEqual(readNoise(`${dir}/new.json`, expect), base.noise);
  const probe = readFileSync(new URL("../harness/probes/parcours.mjs", import.meta.url), "utf8");
  assert.match(probe, /analysisVersion: ANALYSIS_VERSION, reanalyzedAt/, "--analyze writes the current version");
  assert.match(probe, /probeVersion: PROBE_VERSION, analysisVersion: ANALYSIS_VERSION, at:/);
});

test("deriveSeconds off WebGPU: no produced counter, the sampler's XFB copies stand in; 7 copies at 60 VIs is render-starved", async () => {
  const { attributeDips, parcoursWindowsForAttribution } = await import("../harness/lib/drops.mjs");
  // the software renderer: the worker has no new-frames counters (newFps,
  // producedFps, newShown absent), the VIs and presents keep 60 a second,
  // the core renders 7 frames (XFB copies) with the GPU thread saturated
  const s = samplesOf([["game", 5]], { busy: 0.9 });
  let xfb = 0;
  for (const x of s.slice(1)) {
    delete x.info.newShown; delete x.info.producedFps;
    x.info.cpuBusy = 0.4; x.info.replayBusy = 0.2; x.info.gpuBusy = 0.9;
    xfb += 7; x.counters.xfbCopies = xfb;
  }
  const rows = deriveSeconds(s, { tps: TPS });
  assert.deepEqual(rows.map((r) => r.producedFps), [7, 7, 7, 7, 7]);
  assert.ok(rows.every((r) => r.producedFrom === "xfb" && r.xfbPerFrame === null && r.newFps === null));
  // the worker's own counter still wins when it has one
  assert.equal(deriveSeconds(samplesOf([["game", 2]]), { tps: TPS })[0].producedFrom, "worker");
  const result = attributeDips(parcoursWindowsForAttribution(rows.map((r) => ({ ...r, cadence: 60 }))), { cadence: 60 });
  assert.equal(result.dips.length, 5);
  assert.ok(result.dips.every((d) => Object.keys(d.parts).length === 1 && Math.abs(d.parts["render-starved"] - 53) < 0.5), JSON.stringify(result.dips.map((d) => d.parts)));
});

// Analysis 3: the new frames of each exact second, present by present (the
// worker's last 500 ms rate saw half the second and counted it twice).
const at60 = (t) => presentsIn(t, 60);
const without = (presents, from, to) => presents.filter((p) => p <= from || p > to);
test("new frames a second: 2 frames lost in the first half of a second read 58, whatever the worker's 500 ms rate says", () => {
  const s = samplesOf([["menu", 3]]);
  // two presents of the second ending at s[2].t missing 200-233 ms into it (one 50 ms gap)
  s[2].presents = without(at60(s[2].t), s[2].t - 805, s[2].t - 770);
  assert.equal(s[2].presents.length, 58);
  // the worker's last 500 ms held none of it: its rate says 60; at another
  // reading phase it said 56 (2 lost in a half second, twice)
  s[2].info.newFps = 60; s[3].info.newFps = 56;
  const rows = deriveSeconds(s, { tps: TPS });
  assert.deepEqual(rows.map((r) => r.newFps), [60, 58, 60]);
  assert.deepEqual(rows.map((r) => r.smoothness), [100, 96.7, 100]);
  assert.deepEqual(rows.map((r) => r.newFpsWorker), [60, 60, 56], "the worker's rate kept apart");
  assert.equal(rows[1].hitches50, 0, "a 50 ms gap is no hitch over 50");
});

test("new frames a second: a loss at the half second, or across two seconds, is counted once", () => {
  const s = samplesOf([["menu", 4]]);
  // 2 lost around the half second of one second
  s[2].presents = without(at60(s[2].t), s[2].t - 510, s[2].t - 480);
  // 2 lost across the reading of s[3]: its last one and s[4]'s first one
  s[3].presents = at60(s[3].t).slice(0, -1);
  s[4].presents = at60(s[4].t).slice(1);
  const rows = deriveSeconds(s, { tps: TPS });
  assert.deepEqual(rows.map((r) => r.newFps), [60, 58, 59, 59]);
  assert.equal(rows.reduce((n, r) => n + (60 - r.newFps), 0), 4, "4 frames lost, 4 counted");
  // a reading late by 30 ms: still the exact second before it
  const late = samplesOf([["menu", 3]]);
  late[2].t += 30; late[2].presents = late[2].presents.concat([late[2].t - 13]);
  late[3].presents = late[3].presents.filter((p) => p > late[2].t);
  assert.deepEqual(deriveSeconds(late, { tps: TPS }).map((r) => r.newFps), [60, 60, 60], "a present read early or late counts in its own second");
});

test("new frames a second: unknown when the timeline read failed or lost presents, or frames are untagged; a repeat is no new frame", () => {
  const s = samplesOf([["menu", 4]]);
  s[2].presentsKnown = false;
  // s[2]'s span is in the seconds ending at s[2] only (the windows are 1 s, readings 1 s apart)
  assert.deepEqual(deriveSeconds(s, { tps: TPS }).map((r) => r.newFps), [60, null, 60, 60]);
  // a late reading: the next second reaches back into the unknown span
  s[3].t -= 20;
  assert.deepEqual(deriveSeconds(s, { tps: TPS }).map((r) => r.smoothness), [100, null, null, 100]);
  // records before analysis 3: viT null (the probe's mark of a failed or lossy read) is unknown
  const old = samplesOf([["menu", 2]]);
  old.forEach((x) => { x.viT = [x.t]; });
  old[1].viT = null;
  assert.deepEqual(newFramesPerSecond(old), [null, null, 60]);
  // untagged frames (no newShown): the presents are no count of new frames
  const sw = samplesOf([["menu", 2]]);
  for (const x of sw) delete x.info.newShown;
  assert.deepEqual(newFramesPerSecond(sw), [null, null, null]);
  // presentVi: a present showing a VI shown before is a repeat; an unknown VI, an unknown second
  const tagged = samplesOf([["menu", 2]]);
  let vi = 0;
  for (const x of tagged) x.presentVi = x.presents.map(() => (vi += 1));
  tagged[1].presentVi[5] = tagged[1].presentVi[4];
  assert.deepEqual(newFramesPerSecond(tagged), [null, 59, 60]);
  tagged[2].presentVi[3] = -1;
  assert.deepEqual(newFramesPerSecond(tagged), [null, 59, null]);
});

test("phases from the film clock: each second takes the declared phase covering most of its film span; the detector before the first", () => {
  const phases = [{ at: 1000, phase: "cinematic", label: "intro" }, { at: 2000, phase: "menu", label: "title" }];
  const row = (from, to) => ({ filmFrom: from, film: { pos: to } });
  assert.deepEqual(filmPhaseLabels([row(800, 920), row(920, 1040), row(950, 1070), row(1880, 2000), row(1950, 2070), row(2100, 2100), row(null, 1200)], phases),
    [null, null, "cinematic", "cinematic", "menu", "menu", null]);
  assert.deepEqual(filmPhaseLabels([row(0, 100)], []), [null], "no declared phase: the detector's");
  // phase null: the detector's from that poll; no frame yet: the boot stays the detector's
  const open = [...phases, { at: 3000, phase: null }];
  assert.deepEqual(filmPhaseLabels([row(2900, 2990), row(2950, 3100), row(3000, 3120), { ...row(1100, 1200), booted: false }], open), ["menu", null, null, null]);
  // analyzeRun: film labels where declared, whatever the signals say
  const s = samplesOf([["menu", 3], ["cinematic", 3], ["menu", 4]]);
  s.forEach((x, k) => { x.film = { pos: k * 120, hold: 0 }; });
  const a = analyzeRun({ samples: s, tps: TPS, filmPhases: [{ at: 280, phase: "cinematic" }, { at: 600, phase: "menu" }] });
  assert.deepEqual(a.rows.map((r) => r.phase), ["menu", "menu", "cinematic", "cinematic", "cinematic", "menu", "menu", "menu", "menu", "menu"]);
  assert.deepEqual(a.rows.map((r) => r.phaseFrom), ["detector", "detector", "film", "film", "film", "film", "film", "film", "film", "film"]);
  assert.deepEqual(analyzeRun({ samples: s, tps: TPS }).rows.map((r) => r.phase).slice(2, 7), ["menu", "cinematic", "cinematic", "cinematic", "menu"], "the detector alone");
});

test("film phases: validated (polls in order, known phases), read apart from the RESYNC markers", () => {
  const film = { unit: "poll", ports: [0], steps: [{ at: 1, port: 0, mask: 0, stick: [128, 128] }, { at: 1500, phase: "cinematic", label: "intro" }], end: 3000 };
  assert.deepEqual(filmPhases(validateFilm({ ...film, phases: [{ at: 1240, phase: "cinematic", label: "intro" }, { at: 2130, phase: "menu" }] })),
    [{ at: 1240, phase: "cinematic", label: "intro" }, { at: 2130, phase: "menu", label: null }]);
  assert.deepEqual(filmPhases(film), []);
  assert.throws(() => validateFilm({ ...film, phases: [{ at: 2130, phase: "menu" }, { at: 1240, phase: "cinematic" }] }), /after the previous phase/);
  assert.throws(() => validateFilm({ ...film, phases: [{ at: 10, phase: "cutscene" }] }), /not one of/);
  assert.throws(() => validateFilm({ ...film, phases: {} }), /array/);
  assert.equal(validateFilm({ ...film, phases: [{ at: 1240, phase: "cinematic" }, { at: 2493, phase: null }] }).phases.length, 2, "null: the detector's from there");
  assert.deepEqual(filmMarkers(film).map((m) => m.at), [1500], "the markers stay the markers");
});

test("probe: each sample keeps its presents' VIs and whether the read saw them all; a run's own film phases win over --analyze --film", () => {
  const src = readFileSync(new URL("../harness/probes/parcours.mjs", import.meta.url), "utf8");
  assert.match(src, /presents, presentVi, presentsKnown, vi:/);
  assert.match(src, /filmPhases: o\.film \? filmPhases\(o\.film\) : \[\]/);
  const s = samplesOf([["menu", 3], ["cinematic", 3]]);
  s.forEach((x, k) => { x.film = { pos: k * 120, hold: 0 }; });
  const raw = { samples: s, tps: TPS, markers: [], reached: [], filmPhases: [{ at: 0, phase: "game" }] };
  assert.equal(analyzeRaw(raw, { maxLoad: 12, filmPhases: [{ at: 0, phase: "menu" }] }).phases.game.seconds, 6);
  const a = analyzeRaw({ ...raw, filmPhases: undefined }, { maxLoad: 12, filmPhases: [{ at: 0, phase: "menu" }] });
  assert.equal(a.phases.menu.seconds, 6);
  assert.equal(a.phaseClock, "film");
});
