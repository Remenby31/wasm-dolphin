// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import { analyzeRun, classifySecond, filmPhaseLabels, newFrameBins, gamePauseReference, gamePauseSpans, gamePauseGpuSide, gpuSideBusy, productionGapsOf, GPU_ROW_COLUMNS, nominalViRate, ownRateCadence, PARCOURS_PRIMARY, viBins, ANALYSIS_VERSION as AV, producedBins, regularProduction, contentSecond, gapDetail, completionOf, currentPhase, deriveSeconds, GAME_DRAWS_PER_FRAME, LOAD_DISC_BPS, markerIndexes, MIN_PHASE_SEC, parcoursVerdict, phaseLabels, phaseMetrics, phaseNoise, renderTimeline, sectionsOf, segmentsOf, summarizeSeconds, windowCadence } from "../harness/lib/parcours.mjs";
import { filmMarkers, filmPhases, filmWithMarks, keyToPad, padStateOf, recordPorts, runRecordSteps, validateFilm, validateRecordSteps } from "../harness/lib/pad-film.mjs";
import { analyzeRaw, countersOf, otherCpuOf, presentGaps, samplerTicksOf, viTimesOf, exitCodeOf, gamePausesText, gpuRowsOf, humanSummary, markerStep } from "../harness/probes/parcours.mjs";
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
// n presents evenly in the second ending at t: [t - 1000, t)
const presentsIn = (t, n) => Array.from({ length: n }, (_, i) => t - 1000 + (i * 1000) / n);
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

// Analysis 4: the new frames of each second of a fixed grid on the timeline,
// present by present (the worker's last 500 ms rate saw half the second and
// counted it twice), by frame tag when recorded.
const at60 = (t) => presentsIn(t, 60);
const without = (presents, from, to) => presents.filter((p) => p < from || p >= to);
// tags for every present of the samples, one new frame each from `first`
function tagged(samples, first = 1) {
  let tag = first;
  for (const x of samples) { x.presentTag = x.presents.map(() => tag++); x.presentTagEpoch = x.presents.map(() => 1); x.presentsKnown = true; }
  return samples;
}
test("new frames a second: 2 frames lost in the first half of a second read 58, whatever the worker's 500 ms rate says", () => {
  const s = samplesOf([["menu", 3]]);
  // two presents of the second before s[2] missing 200-233 ms into it (one 50 ms gap)
  s[2].presents = without(at60(s[2].t), s[2].t - 805, s[2].t - 770);
  assert.equal(s[2].presents.length, 58);
  // the worker's last 500 ms held none of it: its rate says 60; read at another phase, 56
  s[2].info.newFps = 60; s[3].info.newFps = 56;
  const rows = deriveSeconds(s, { tps: TPS });
  assert.deepEqual(rows.map((r) => r.newFps), [60, 58, 60]);
  assert.deepEqual(rows.map((r) => r.smoothness), [100, 96.7, 100]);
  assert.deepEqual(rows.map((r) => r.newFpsWorker), [60, 60, 56], "the worker's rate kept apart");
  assert.equal(newFrameBins(s).basis, "all", "no tags recorded: every present counts");
  // readings a little early against the grid (the first one late): each second still in its own row
  const early = samplesOf([["menu", 3]]);
  early[2].presents = without(at60(early[2].t), early[2].t - 805, early[2].t - 770);
  early[0].t += 8;
  for (const x of early.slice(1)) x.t -= 5;
  assert.deepEqual(deriveSeconds(early, { tps: TPS }).map((r) => r.newFps), [60, 58, null], "the last grid second ends after the last reading: none");
});

test("new frames a second: a loss at the half second, or across two grid seconds, is counted once; readings over 1 s apart lose none", () => {
  const s = samplesOf([["menu", 4]]);
  s[2].presents = without(at60(s[2].t), s[2].t - 510, s[2].t - 480);
  // 2 lost across a grid boundary: the last present of one second, the first of the next
  s[3].presents = at60(s[3].t).slice(0, -1);
  s[4].presents = at60(s[4].t).slice(1);
  const rows = deriveSeconds(s, { tps: TPS });
  assert.deepEqual(rows.map((r) => r.newFps), [60, 58, 59, 59]);
  // a late reading (a hitch delays it): the reading 300 ms late holds the presents up to it, the grid is unchanged
  const late = samplesOf([["menu", 3]]);
  late[2].t += 300;
  late[2].presents = [...late[2].presents, ...late[3].presents.filter((p) => p < late[2].t)];
  late[3].presents = late[3].presents.filter((p) => p >= late[2].t);
  assert.deepEqual(deriveSeconds(late, { tps: TPS }).map((r) => r.newFps), [60, 60, 60], "a present read early or late counts in its own second");
  // a reading skipped (the loop 2 s on): the row spans two grid seconds, each kept; a gap across their boundary counted once
  const skip = samplesOf([["menu", 4]]);
  const gap = (p) => !(p >= skip[2].t - 20 && p < skip[2].t + 20);
  skip[3].presents = [...skip[2].presents, ...skip[3].presents].filter(gap);
  skip.splice(2, 1);
  const rows2 = deriveSeconds(skip, { tps: TPS });
  assert.deepEqual(rows2.map((r) => r.smoothBins.map((x) => x.newFrames)), [[60], [59, 58], [60]]);
  assert.equal(rows2[1].smoothness, 96.7, "the row: its worst second");
  const all = summarizeSeconds(rows2);
  assert.equal(all.smoothness.seconds, 4, "4 grid seconds, each once");
  assert.equal(all.smoothness.min, 96.7);
});

test("new frames a second: unknown seconds counted, never good; past 5 % of a phase its p5 is unreliable", () => {
  const s = samplesOf([["menu", 4]]);
  s[2].presentsKnown = false;
  // reading 2 may hold presents of (t1, t3): both grid seconds unknown
  const rows = deriveSeconds(s, { tps: TPS });
  assert.deepEqual(rows.map((r) => r.newFps), [60, null, null, 60]);
  const sum = summarizeSeconds(rows);
  assert.equal(sum.smoothness.unknown, 2);
  assert.equal(sum.smoothness.reliable, false);
  assert.equal(sum.metrics.smoothUnknown, 2);
  assert.equal(sum.worst[0].smoothness, null, "unknown ranked first, never as good");
  // one unknown in 30: under 5 %, reliable
  const long = samplesOf([["menu", 31]]);
  long[31].presentsKnown = false;
  const s30 = summarizeSeconds(deriveSeconds(long, { tps: TPS }));
  assert.equal(s30.smoothness.unknown, 1);
  assert.equal(s30.smoothness.reliable, true);
  // records before analysis 3: viT null (the probe's mark of a failed or lossy read) is unknown
  const old = samplesOf([["menu", 3]]);
  old.forEach((x) => { x.viT = [x.t]; });
  old[2].viT = null;
  assert.deepEqual(newFrameBins(old).bins.map((x) => x.newFrames), [60, null, null], "reading 2 may hold presents of (t1, t3)");
  // untagged frames (no newShown: the software renderer) are no count of new frames
  const sw = samplesOf([["menu", 2]]);
  for (const x of sw) delete x.info.newShown;
  assert.deepEqual(newFrameBins(sw).bins.map((x) => x.newFrames), [null, null]);
});

test("new frames by tag: a re-shown duplicate or an older frame is no new frame; a reboot (new epoch) is; tag 0 or tags not one per present: unknown", () => {
  const s = tagged(samplesOf([["menu", 3]]));
  assert.equal(newFrameBins(s).basis, "tag");
  // a duplicate re-shown (same tag, same epoch: its VI number would be new) and an older frame after a newer one
  s[1].presentTag[5] = s[1].presentTag[4];
  s[1].presentTag[9] = s[1].presentTag[3];
  assert.deepEqual(newFrameBins(s).bins.map((x) => x.newFrames), [58, 60, 60]);
  // a reboot: the tags start over at 1 in a new epoch
  const r = tagged(samplesOf([["menu", 3]]));
  r[2].presentTag = r[2].presents.map((_, i) => i + 1);
  r[2].presentTagEpoch = r[2].presents.map(() => 2);
  r[3].presentTag = r[3].presents.map((_, i) => 61 + i);
  r[3].presentTagEpoch = r[3].presents.map(() => 2);
  assert.deepEqual(newFrameBins(r).bins.map((x) => x.newFrames), [60, 60, 60]);
  // without the epoch the restart would read as older frames: the epoch is what makes them new
  r[2].presentTagEpoch = r[2].presents.map(() => 1);
  assert.equal(newFrameBins(r).bins[1].newFrames, 0);
  // an untagged present (0): its second unknown
  const z = tagged(samplesOf([["menu", 2]]));
  z[2].presentTag[7] = 0;
  assert.deepEqual(newFrameBins(z).bins.map((x) => x.newFrames), [60, null]);
  // tags not one per present: the reading is unknown (its span (t1, t3): two seconds)
  const m = tagged(samplesOf([["menu", 3]]));
  m[2].presentTag = m[2].presentTag.slice(1);
  assert.deepEqual(newFrameBins(m).bins.map((x) => x.newFrames), [60, null, null]);
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
  // segments and the completion's phase order on the film's phases
  assert.deepEqual(a.segments.map((x) => [x.phase, x.to - x.from]), [["menu", 2], ["cinematic", 3], ["menu", 5]]);
  const marked = analyzeRun({ samples: s, tps: TPS, filmPhases: [{ at: 280, phase: "cinematic" }, { at: 600, phase: "game" }], markers: [{ at: 300, phase: "game" }], reached: [{ ordinal: 0, at: s[8].t }] });
  assert.equal(marked.completion.phasesInOrder, true, "the film's game phase, though the detector saw a menu");
  assert.equal(marked.newFramesBasis, "all");
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

test("probe: each sample keeps its presents' tags and whether the read saw them all; a run's own film phases win over --analyze --film", () => {
  const src = readFileSync(new URL("../harness/probes/parcours.mjs", import.meta.url), "utf8");
  assert.match(src, /presents, presentTag, presentTagEpoch, presentsKnown, producedT, producedKnown, vi:/);
  // the worker's timeline carries each present's tag and epoch
  const worker = readFileSync(new URL("../src/upstream-discio-worker.js", import.meta.url), "utf8");
  assert.match(worker, /presents\.tag\.push\(harnessPresentRing\[slot \+ 3\]\)/);
  assert.match(worker, /recordPresentedFrame\(f\.coreFrame, f\.shownVi, f\.tag, f\.tagEpoch\)/);
  assert.match(src, /filmPhases: o\.film \? filmPhases\(o\.film\) : \[\]/);
  const s = samplesOf([["menu", 3], ["cinematic", 3]]);
  s.forEach((x, k) => { x.film = { pos: k * 120, hold: 0 }; });
  const raw = { samples: s, tps: TPS, markers: [], reached: [], filmPhases: [{ at: 0, phase: "game" }] };
  assert.equal(analyzeRaw(raw, { maxLoad: 12, filmPhases: [{ at: 0, phase: "menu" }] }).phases.game.seconds, 6);
  const a = analyzeRaw({ ...raw, filmPhases: undefined }, { maxLoad: 12, filmPhases: [{ at: 0, phase: "menu" }] });
  assert.equal(a.phases.menu.seconds, 6);
  assert.equal(a.phaseClock, "film");
});

test("the new frames basis per run: refused across bases (an A/B, an A/A's noise)", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const os = await import("node:os");
  const { readNoise, basisOf } = await import("../harness/probes/parcours.mjs");
  const { ANALYSIS_VERSION } = await import("../harness/lib/parcours.mjs");
  assert.equal(analyzeRun({ samples: tagged(samplesOf([["menu", 2]])), tps: TPS }).newFramesBasis, "tag");
  assert.equal(basisOf([{ newFramesBasis: "tag" }, { newFramesBasis: "tag" }]), "tag");
  assert.equal(basisOf([{ newFramesBasis: "tag" }, { newFramesBasis: "all" }]), "mixed");
  const dir = mkdtempSync(`${os.tmpdir()}/parcours-basis-`);
  const base = { probe: "parcours", probeVersion: 2, analysisVersion: ANALYSIS_VERSION, film: "f#1", query: "q", newFramesBasis: "all", noise: { "kind:menu": {} } };
  writeFileSync(`${dir}/all.json`, JSON.stringify(base));
  assert.throws(() => readNoise(`${dir}/all.json`, { probeVersion: 2, film: "f#1", query: "q", newFramesBasis: "tag" }), /newFramesBasis all vs tag/);
  assert.deepEqual(readNoise(`${dir}/all.json`, { probeVersion: 2, film: "f#1", query: "q", newFramesBasis: "all" }), base.noise);
  const probe = readFileSync(new URL("../harness/probes/parcours.mjs", import.meta.url), "utf8");
  assert.match(probe, /new frames counted on different bases \(tag \/ all\) across runs/);
});

test("A/B: a smoothness p5 marked unreliable on either side is judged neither way (a lost read during a freeze hid the worst second)", () => {
  const run = (smoothP5, smoothReliable) => ({ completion: { completed: true }, integrityFailed: false, phases: { menu: { metrics: { seconds: 20, speedMedian: 100, speedP5: 99, newFpsMedian: 60, smoothP5, smoothSeconds: 20, smoothUnknown: smoothReliable ? 0 : 2, smoothReliable, hitches100: 0 } } }, sections: {} });
  // baseline p5 40; the candidate's read lost during a 600 ms freeze: its worst second unknown, p5 70
  const v = parcoursVerdict([run(40, true), run(41, true), run(40, true)], [run(70, false), run(71, false), run(70, false)]);
  const row = v.phases["kind:menu"].rows.find((r) => r.metric === "smoothP5");
  assert.equal(row.improvement, false);
  assert.equal(row.regression, false);
  assert.equal(row.unreliable, true);
  assert.equal(v.phases["kind:menu"].inconclusive, true);
  assert.equal(v.improvement, false, "no improvement accepted on an unreliable p5");
  // the other way: an unreliable baseline hides no regression either
  const w = parcoursVerdict([run(90, false), run(90, false), run(90, false)], [run(40, true), run(40, true), run(41, true)]);
  assert.equal(w.phases["kind:menu"].rows.find((r) => r.metric === "smoothP5").regression, false);
  assert.equal(w.phases["kind:menu"].inconclusive, true);
  // both reliable: judged
  const x = parcoursVerdict([run(40, true), run(41, true), run(40, true)], [run(70, true), run(71, true), run(70, true)]);
  assert.equal(x.phases["kind:menu"].rows.find((r) => r.metric === "smoothP5").improvement, true);
  const probe = readFileSync(new URL("../harness/probes/parcours.mjs", import.meta.url), "utf8");
  assert.match(probe, /smoothness p5 or production gaps unreliable \(unknown seconds\) in/);
});

test("worst seconds: a row owning no grid second is left out, never ranked over a bad one", () => {
  const rows = [
    { t: 1, speed: 100, smoothness: null, smoothBins: [] },
    { t: 2, speed: 100, smoothness: 90, smoothBins: [{ t: 2, newFrames: 54, smoothness: 90 }] },
    { t: 3, speed: 100, smoothness: 100, smoothBins: [{ t: 3, newFrames: 60, smoothness: 100 }] },
    { t: 4, speed: 100, smoothness: null, smoothBins: [{ t: 4, newFrames: null, smoothness: null }] }
  ];
  assert.deepEqual(summarizeSeconds(rows).worst.map((w) => w.t), [4, 2, 3], "the unknown second first, the healthy empty row out");
});

// Analysis 5: the produced frames (the content reference) on the same grid.
// n produced frames evenly in [t - 1000, t)
function withProduced(samples, perSec) {
  samples.forEach((x, i) => { x.producedT = i === 0 ? [] : presentsIn(x.t, typeof perSec === "function" ? perSec(i) : perSec); x.producedKnown = true; });
  return samples;
}
test("produced frames on the grid: counted per second like the presents, unknown when a read missed them; none recorded: the worker's rate (basis worker)", () => {
  const s = withProduced(samplesOf([["menu", 3]]), (i) => (i === 2 ? 33 : 60));
  assert.equal(producedBins(s).basis, "grid");
  assert.deepEqual(producedBins(s).bins, [60, 33, 60]);
  s[3].producedKnown = false;
  assert.deepEqual(producedBins(s).bins, [60, 33, null], "the last reading may hold frames after t2: its second unknown");
  s[3].producedKnown = true; s[2].producedKnown = false;
  assert.deepEqual(producedBins(s).bins, [60, null, null], "reading 2 may hold frames of (t1, t3)");
  assert.deepEqual(producedBins(samplesOf([["menu", 2]])), { basis: "worker", bins: null });
  // each second's longest pause: one frame interval when regular
  assert.ok(producedBins(withProduced(samplesOf([["menu", 2]]), 60)).maxGapMs.every((g) => Math.abs(g - 1000 / 60) < 0.01));
  // untagged frames: nothing known
  const sw = withProduced(samplesOf([["menu", 2]]), 60);
  for (const x of sw) delete x.info.newShown;
  assert.deepEqual(producedBins(sw).bins, [null, null]);
});

test("a loading second where the game makes 45 frames: judged against the 45 it made (with margin), whatever the worker's 500 ms rate said", () => {
  // the game makes 45 in the middle second, shows them all; the worker's rate says 15.6 there
  const s = withProduced(samplesOf([["menu", 3]]), (i) => (i === 2 ? 45 : 60));
  s[2].presents = presentsIn(s[2].t, 45);
  s[2].info.producedFps = 15.6;
  const rows = deriveSeconds(s, { tps: TPS });
  assert.deepEqual(rows.map((r) => r.producedFps), [60, 45, 60]);
  assert.deepEqual(rows.map((r) => r.producedFrom), ["grid", "grid", "grid"]);
  assert.deepEqual(rows.map((r) => r.smoothBins[0].content), [false, true, false]);
  assert.deepEqual(rows.map((r) => r.smoothness), [100, 100, 100]);
  // 3 of the 45 made not shown: a loss, against what was made
  s[2].presents = presentsIn(s[2].t, 42);
  assert.equal(deriveSeconds(s, { tps: TPS })[1].smoothness, 93.3);
  // no margin (a thread saturated: maybe why it made few): against the cadence
  const busy = withProduced(samplesOf([["menu", 3]], { busy: 0.9 }), (i) => (i === 2 ? 45 : 60));
  busy[2].presents = presentsIn(busy[2].t, 45);
  assert.equal(deriveSeconds(busy, { tps: TPS })[1].smoothness, 75);
  // what was made unknown in a second: its smoothness unknown, counted as such
  const u = withProduced(samplesOf([["menu", 4]]), 60);
  u[2].producedKnown = false;
  const ur = deriveSeconds(u, { tps: TPS });
  assert.deepEqual(ur.map((r) => r.smoothness), [100, null, null, 100]);
  assert.equal(summarizeSeconds(ur).smoothness.unknown, 2);
  assert.equal(analyzeRun({ samples: u, tps: TPS }).producedBasis, "grid");
  assert.equal(analyzeRun({ samples: samplesOf([["menu", 2]]), tps: TPS }).producedBasis, "worker");
});

test("the produced basis per run: refused across bases (an A/B, an A/A's noise); the worker records each produced frame for the harness only", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const os = await import("node:os");
  const { readNoise, basisOf } = await import("../harness/probes/parcours.mjs");
  const { ANALYSIS_VERSION } = await import("../harness/lib/parcours.mjs");
  assert.equal(basisOf([{ producedBasis: "grid" }, { producedBasis: "worker" }], "producedBasis"), "mixed");
  const dir = mkdtempSync(`${os.tmpdir()}/parcours-produced-`);
  const base = { probe: "parcours", probeVersion: 2, analysisVersion: ANALYSIS_VERSION, film: "f#1", query: "q", newFramesBasis: "tag", producedBasis: "worker", noise: { "kind:menu": {} } };
  writeFileSync(`${dir}/w.json`, JSON.stringify(base));
  assert.throws(() => readNoise(`${dir}/w.json`, { probeVersion: 2, film: "f#1", query: "q", newFramesBasis: "tag", producedBasis: "grid" }), /producedBasis worker vs grid/);
  const probe = readFileSync(new URL("../harness/probes/parcours.mjs", import.meta.url), "utf8");
  assert.match(probe, /produced frames on different bases \(grid \/ worker\) across runs/);
  const worker = readFileSync(new URL("../src/upstream-discio-worker.js", import.meta.url), "utf8");
  assert.match(worker, /^let harnessProducedRing = null;$/m);
  assert.match(worker, /harnessProducedRing \?\?= new Float64Array\(HARNESS_PRESENT_RING\);/);
  assert.match(worker, /if \(!harnessEnabled \|\| !harnessProducedRing\) return;/);
  assert.equal(worker.match(/if \(wgpuNewFrames\.queued\([^)]*\) && harnessProducedRing\) recordProducedFrame\(\);/g)?.length, 2, "both WebGPU present paths, the ring checked inline (no call for a player)");
  assert.match(worker, /presents: \{ \.\.\.presents, lost: presentsLost \}, produced, vi,/);
});

test("a worker stall that stops making and showing alike is a loss, not content: only a regular production is content", () => {
  // the middle second: 300 ms with nothing made nor shown (a worker stall), 42 made and 42 shown around it
  const stalled = (t) => presentsIn(t, 60).filter((p) => p < t - 700 || p >= t - 400);
  const s = withProduced(samplesOf([["menu", 3]]), 60);
  s[2].producedT = stalled(s[2].t);
  s[2].presents = stalled(s[2].t);
  assert.equal(s[2].producedT.length, 42);
  const rows = deriveSeconds(s, { tps: TPS });
  assert.equal(rows[1].smoothBins[0].regular, false);
  assert.equal(rows[1].smoothBins[0].content, false);
  assert.equal(rows[1].smoothness, 70, "read against the cadence: 42 of 60");
  // a game making 42 a second, spread over it: content, read against what it made
  const even = withProduced(samplesOf([["menu", 3]]), (i) => (i === 2 ? 42 : 60));
  even[2].presents = presentsIn(even[2].t, 42);
  const er = deriveSeconds(even, { tps: TPS });
  assert.equal(er[1].smoothBins[0].regular, true);
  assert.equal(er[1].smoothness, 100);
  // the rule: the longest pause at most 1.5 frame intervals; unknown is never regular
  assert.equal(regularProduction(42, 35), true);
  assert.equal(regularProduction(42, 300), false);
  assert.equal(regularProduction(42, null), false);
  assert.equal(regularProduction(0, 10), false);
});

// Analysis 6.
test("pauses of production: two 100 ms stalls in a second stay a loss; 50 frames a second with 2-VI pauses is regular (content)", () => {
  const VI = 1000 / 59.94;
  // two 100 ms stalls: nothing made nor shown in (t-800, t-700] and (t-400, t-300]
  const twice = (t) => presentsIn(t, 60).filter((p) => !((p >= t - 800 && p < t - 700) || (p >= t - 400 && p < t - 300)));
  const s = withProduced(samplesOf([["menu", 3]]), 60);
  s[2].producedT = twice(s[2].t);
  s[2].presents = twice(s[2].t);
  const rows = deriveSeconds(s, { tps: TPS });
  assert.equal(rows[1].smoothBins[0].regular, false, "a 100 ms pause is past 2.5 VIs (41.7 ms)");
  assert.equal(rows[1].smoothness, smoothOfCount(s[2].producedT.length));
  // 50 a second: a frame every VI, every 6th VI skipped (a 33 ms pause), all shown
  const at50 = (t) => { const out = []; for (let i = 0, k = 0; out.length < 50; k += 1) { if (k % 6 === 5) continue; out.push(t - 1000 + k * VI); i += 1; } return out; };
  const g = withProduced(samplesOf([["menu", 3]]), 60);
  g[2].producedT = at50(g[2].t);
  g[2].presents = at50(g[2].t);
  const gr = deriveSeconds(g, { tps: TPS });
  assert.equal(gr[1].smoothBins[0].regular, true, "2-VI pauses are the game's pace");
  assert.equal(gr[1].smoothBins[0].content, true);
  assert.equal(gr[1].smoothness, 100);
  // the bound: 1.5 frame intervals, never under 2.5 VI periods
  assert.equal(regularProduction(53, 39), true);
  assert.equal(regularProduction(53, 45), false);
  assert.equal(regularProduction(20, 70), true, "1.5 x 50 ms");
  assert.equal(AV, 8);
});
const smoothOfCount = (n) => Math.round((1000 * n) / 60) / 10;

test("the live loop: the newest row owns no complete grid second yet, and is still classified (the worker's produced rate for its signals only)", () => {
  // readings 5 ms before each grid edge: the newest second is never complete when it is read
  const s = withProduced(samplesOf([["menu", 3], ["game", 4]]), 60);
  s.slice(1).forEach((x) => { x.t -= 5; });
  for (let i = 3; i <= s.length; i += 1) {
    const live = s.slice(0, i);
    const rows = deriveSeconds(live, { tps: TPS });
    const last = rows.at(-1);
    assert.equal(last.smoothBins.length, 0, `${i}: the newest second is not on the grid yet`);
    assert.equal(last.producedFrom, "worker");
    assert.notEqual(classifySecond(last), null, `${i}: the newest row classified`);
    assert.equal(last.smoothness, null, "no smoothness from the worker's rate");
  }
  assert.equal(currentPhase(deriveSeconds(s, { tps: TPS })), "game");
});

// The drop sampler's GPU-side rows (gpuRows, GPU_ROW_COLUMNS) every 100 ms from the first reading to
// the last: the copies of each row the frames produced in it (none left unproduced), the GPU thread's
// work and this worker's busy time `busy` of the row, `stall` [from, to] (host ms) at 100 % instead,
// no waits for the GPU. `drop`: readings whose rows are lost.
function withGpuRows(s, { busy = 0.05, stall = null, drop = [] } = {}) {
  const produced = s.flatMap((x) => x.producedT ?? []).sort((a, b) => a - b);
  let xfb = 0, work = 0, replay = 0;
  const rows = [];
  for (let t = s[0].t; t <= s.at(-1).t + 1e-6; t += 100) {
    if (rows.length) {
      const from = t - 100;
      xfb += produced.filter((p) => p > from && p <= t).length;
      const stalled = stall ? Math.max(0, Math.min(t, stall[1]) - Math.max(from, stall[0])) : 0;
      work += (busy * (100 - stalled) + stalled) * 1000;
      replay += busy * 100;
    }
    rows.push([t, xfb, work, 0, 0, 0, 0, replay]);
  }
  s.forEach((x, i) => { x.gpuRows = drop.includes(i) ? null : rows.filter((r) => (i === 0 ? r[0] <= x.t : r[0] > s[i - 1].t && r[0] <= x.t)); });
  return s;
}

// Analysis 7: the game's own pause.
// 3 menu seconds; in the middle one the game makes no frame for 300 ms ((t-700, t-400]): 42 made, 42 shown;
// `copies`: the core's EFB->XFB copies counted in it; `visIn`: its VI outputs; `speed`: its emulation speed
function pauseRun({ copies = 42, visIn = 60, speed = 100, learn30 = false, gapVis = true, gpu = {}, rows: wantRows = false } = {}) {
  const s = withProduced(samplesOf(learn30 ? [["menu", 2], ["menu", 3]] : [["menu", 3]]), 60);
  if (learn30) for (const x of s.slice(1, 3)) { x.presents = presentsIn(x.t, 30); x.producedT = presentsIn(x.t, 30); x.info.newShown = 0; }
  const m = s.length - 2;
  const gap = (t) => presentsIn(t, 60).filter((p) => p < t - 700 || p >= t - 400);
  s[m].producedT = gap(s[m].t);
  s[m].presents = gap(s[m].t);
  s.forEach((x) => { x.viT = presentsIn(x.t, 60); });
  s[m].viT = presentsIn(s[m].t, 60).slice(0, visIn);
  if (!gapVis) s[m].viT = s[m].viT.filter((p) => p < s[m].t - 650 || p >= s[m].t - 450);
  // the core's counters: copies in the pause second, its ticks at `speed`
  let xfb = 0, ticks = 0;
  s.forEach((x, i) => {
    if (i > 0) { xfb += i === m ? copies : 60; ticks += TPS * ((i === m ? speed : 100) / 100); }
    x.counters = { ...x.counters, t: x.t, xfbCopies: xfb, ticks };
  });
  withGpuRows(s, gpu);
  const rows = deriveSeconds(s, { tps: TPS });
  return wantRows ? rows : rows[m - 1];
}
test("the game's own pause (no XFB copy left unproduced, VIs on): content, judged at a fixed cadence; copies that went on stay a loss", () => {
  const pause = pauseRun();
  assert.equal(pause.smoothBins[0].regular, false);
  assert.equal(pause.smoothBins[0].gamePause, true);
  assert.equal(pause.smoothness, 100, "42 made, 42 shown, 60 VIs: the game's pause");
  // the game copied 60 frames and 42 came out: ours, a loss against the cadence
  const ours = pauseRun({ copies: 60 });
  assert.equal(ours.smoothBins[0].gamePause, false);
  assert.equal(ours.smoothness, 70);
  // deterministic: a scene cadence learnt as 30 before does not change it
  assert.equal(pauseRun({ learn30: true }).smoothness, 100);
  assert.equal(gamePauseReference({ made: 42, xfbCopies: 43, vis: 60, viRate: 59.94 }), 42);
  assert.equal(gamePauseReference({ made: 42, xfbCopies: 44, vis: 60, viRate: 59.94 }), null);
  assert.equal(gamePauseReference({ made: 42, xfbCopies: null, vis: 60, viRate: 59.94 }), null, "copies unknown: no pause excused");
  assert.equal(gamePauseReference({ made: 40, xfbCopies: 40, vis: 50, viRate: 50 }), 40, "PAL: the 50 cadence");
});

test("the game's pauses are published one by one next to the p5: start, duration, film position; per phase, per run, in the A/B", () => {
  const rows = pauseRun({ rows: true });
  const pauses = rows.flatMap((r) => r.gamePauses);
  assert.equal(pauses.length, 1, "one pause, counted once");
  assert.ok(pauses[0].durationMs > 300 && pauses[0].durationMs < 320, `duration ${pauses[0].durationMs}`);
  assert.ok(Number.isFinite(pauses[0].t));
  assert.ok("filmPos" in pauses[0]);
  const sum = summarizeSeconds(rows);
  assert.equal(sum.gamePauses.count, 1);
  assert.equal(sum.gamePauses.seconds, 1);
  assert.deepEqual(sum.gamePauses.durationsMs, [pauses[0].durationMs]);
  assert.equal(sum.metrics.gamePauses, 1);
  assert.equal(sum.metrics.gamePauseMs, pauses[0].durationMs);
  // copies that went on: no game pause, none published
  assert.equal(summarizeSeconds(pauseRun({ copies: 60, rows: true })).gamePauses.count, 0);
  // the spans alone: VIs counted, a VI 2.5 periods late (host jitter, then caught up) still continuous
  const vi = 1000 / 59.94, vis = Array.from({ length: 40 }, (_, i) => i * vi);
  const late = vis.map((t, i) => (i === 10 ? t + 25 : t)).sort((a, b) => a - b);
  const spans = (viT, speed = 100) => gamePauseSpans({ producedT: [0, vi, 2 * vi, 2 * vi + 300, 2 * vi + 300 + vi], viT, from: 0, to: 1000, viMs: vi, speedAt: () => [speed] });
  assert.deepEqual(spans(late).map((p) => [p.durationMs, p.continuousVis, p.fullSpeed, p.noBurst, p.gpuSide.known, p.ok]), [[300, true, true, true, false, false]], "no GPU-side rows: unknown, not excused");
  assert.equal(spans(vis.filter((_, i) => i < 6 || i > 12))[0].continuousVis, false, "7 VIs missing");
  assert.equal(spans(vis, 97)[0].fullSpeed, false);
  // the run's report and the A/B lines carry them, every one, kinds and sections
  assert.match(gamePausesText(sum.gamePauses), /^game pauses 1 in 1 s \(\d+(\.\d)? ms at [\d.]+ s, film /);
  assert.equal(gamePausesText(summarizeSeconds(pauseRun({ copies: 60, rows: true })).gamePauses), "game pauses 0 in 0 s");
  const gp = (n) => ({ count: n, seconds: n, totalMs: n * 100, durationsMs: Array(n).fill(100), list: Array.from({ length: n }, (_, i) => ({ t: 10 + i, durationMs: 100, filmPos: 500 + i })) });
  const metrics = (n) => ({ speedMedian: 100, speedP5: 99, newFpsMedian: 60, smoothP5: 100, hitches100: 0, smoothReliable: true, gamePauses: n, gamePauseMs: n * 100 });
  const run = (n) => ({ completion: { completed: true }, phases: { menu: { metrics: metrics(n), gamePauses: gp(n) } }, sections: { race: { metrics: metrics(n), gamePauses: gp(n) } } });
  const v = parcoursVerdict([run(1), run(2)], [run(0)]);
  assert.deepEqual(v.phases["kind:menu"].gamePauses.baseline.map((x) => [x.count, x.totalMs, x.list.length]), [[1, 100, 1], [2, 200, 2]]);
  assert.deepEqual(v.phases["section:race"].gamePauses.candidate.map((x) => x.count), [0]);
  const lines = humanSummary({ runs: [], verdict: v });
  assert.ok(lines.some((l) => /kind:menu .*by run: baseline 1 in 1 s \[100 ms at 10 s film 500\], 2 in 2 s \[100 ms at 10 s film 500; 100 ms at 11 s film 501\]; candidate 0 in 0 s/.test(l)), lines.join("\n"));
  assert.ok(lines.some((l) => /section:race .*game's own pauses/.test(l)));
});

// The review's cases (PR #469): each an emulation fault the game-pause rule must not excuse.
// rvBase: n seconds of 60 frames made, shown and VIs, readings on the grid; rvCounters: one fresh
// sampler counter row per reading, copiesPerSec(i) copies in reading i.
function rvBase(n = 3) {
  const out = [{ t: 1000, info: { newShown: 0, draws: 0, producedFps: 0 }, counters: { t: 1000, ticks: 0, discBytes: 0, xfbCopies: 0 }, presents: [], producedT: [], producedKnown: true, viT: [], vi: 0 }];
  for (let k = 1; k <= n; k += 1) {
    const t = 1000 + 1000 * k;
    out.push({ t, info: { speed: 100, newShown: 60 * k, producedFps: 60, draws: 120 * 60 * k, cpuBusy: 0.3, gpuBusy: 0.3, replayBusy: 0.3, outOfOrder: 0 }, counters: null, presents: presentsIn(t, 60), producedT: presentsIn(t, 60), producedKnown: true, viT: presentsIn(t, 60), vi: 60 });
  }
  return out;
}
function rvCounters(s, copiesPerSec) {
  let x = 0, ticks = 0;
  s.forEach((r, i) => { if (i) { const dt = (r.t - s[i - 1].t) / 1000; x += copiesPerSec(i) * dt; ticks += TPS * dt; } r.counters = { t: r.t, ticks, discBytes: 0, xfbCopies: x }; });
}
const rvPause = (t, from = 700, to = 400) => (xs) => xs.filter((p) => p < t - from || p >= t - to);
const rvBins = (s) => deriveSeconds(withGpuRows(s), { tps: TPS }).flatMap((r) => r.smoothBins.map((x) => [x.gamePause, x.smoothness]));
const rvPauses = (s) => summarizeSeconds(deriveSeconds(withGpuRows(s), { tps: TPS })).gamePauses;

test("game pause: a reading without a fresh counter row (a stalled sampler) excuses nothing", () => {
  const s = rvBase();
  for (const k of [2, 3]) { const g = rvPause(s[k].t); s[k].producedT = g(s[k].producedT); s[k].presents = g(s[k].presents); }
  rvCounters(s, (i) => (i === 2 ? 42 : 60));
  assert.deepEqual(rvBins(s), [[false, 100], [true, 100], [false, 70]], "fresh: second 3 copied 60, a loss");
  s[3].counters = { ...s[2].counters };
  assert.deepEqual(rvBins(s), [[false, 100], [true, 100], [false, 70]], "stale: second 3 still a loss");
  assert.equal(rvPauses(s).count, 1);
});

test("game pause: copies compared with the frames made in the SAME counter window; a late reading excuses no loss", () => {
  const s = rvBase(4);
  s[3].t += 300;
  const lost = (xs) => xs.filter((p) => !(p >= 4000 && p < 4300));
  for (const r of [s[3], s[4]]) { r.producedT = lost(r.producedT); r.presents = lost(r.presents); }
  rvCounters(s, () => 60);
  s[3].vi = 78; s[4].vi = 42;
  assert.deepEqual(rvBins(s).at(-1), [false, 70], "18 frames lost at 60 copies a second");
  assert.equal(rvPauses(s).count, 0);
});

test("game pause: the cadence and VI period are the run's nominal ones, never one second's measured VI rate", () => {
  const s = rvBase();
  const g = rvPause(s[2].t);
  s[2].producedT = g(s[2].producedT); s[2].presents = g(s[2].presents);
  s[2].viT = s[2].viT.filter((p) => !(p >= s[2].t - 1000 && p < s[2].t - 750)); // 15 VIs gone, outside the gap
  rvCounters(s, (i) => (i === 2 ? 42 : 60));
  const fine = rvBins(s);
  s[2].vi = 45;
  assert.deepEqual(rvBins(s), fine, "the row's VI rate changes nothing");
  assert.deepEqual(fine[1], [true, 73.7], "42 shown against 42 made + 15 VIs missed");
  assert.equal(nominalViRate(s), 59.94);
  // 5 VIs missing INSIDE the gap: not the game's pause, judged against the scene cadence
  const e = rvBase();
  const t = e[2].t, ge = rvPause(t);
  e[2].producedT = ge(e[2].producedT); e[2].presents = ge(e[2].presents);
  let drop = 5;
  e[2].viT = e[2].viT.filter((p) => !(p >= t - 700 && p < t - 400 && drop-- > 0)).filter((p) => !(p >= t - 1000 && p < t - 833));
  e[2].vi = e[2].viT.length;
  rvCounters(e, (i) => (i === 2 ? 42 : 60));
  assert.deepEqual(rvBins(e)[1], [false, 70]);
  assert.equal(rvPauses(e).count, 0);
});

test("game pause: a stall caught up in a VI burst, or frames held then burst out, are ours: losses, nothing excused unpublished", () => {
  // the last 80 ms of the pause an emulation stall, its VIs then caught up within 5 ms
  const s = rvBase();
  const t = s[2].t, g = rvPause(t);
  s[2].producedT = g(s[2].producedT); s[2].presents = g(s[2].presents);
  const v = s[2].viT.filter((p) => !(p >= t - 480 && p < t - 400));
  s[2].viT = [...v, ...Array.from({ length: 60 - v.length }, (_, i) => t - 400 + i)].sort((a, b) => a - b);
  rvCounters(s, (i) => (i === 2 ? 42 : 60));
  assert.deepEqual(rvBins(s)[1], [false, 70]);
  const p = rvPauses(s);
  assert.equal(p.count, 0);
  assert.equal(p.seconds, 0, "no second excused without its pause published");
  // a 45 fps scene: the replay held 150 ms of frames, then let them out at once (copies = made)
  const f = rvBase();
  for (const r of f.slice(1)) { r.producedT = presentsIn(r.t, 45); r.presents = presentsIn(r.t, 45); r.info.producedFps = 45; }
  const tf = f[2].t, held = (x) => x >= tf - 700 && x < tf - 550;
  const shift = (xs) => [...xs.filter((x) => !held(x)), ...xs.filter(held).map((x, i) => tf - 550 + i)].sort((a, b) => a - b);
  f[2].producedT = shift(f[2].producedT); f[2].presents = shift(f[2].presents);
  rvCounters(f, () => 45);
  assert.equal(rvBins(f)[1][0], false);
  assert.equal(rvPauses(f).count, 0);
});

test("a stall on OUR GPU side (VIs on, full speed, no copy asked, no burst after) stays a loss; the same pause with the GPU side idle is excused", () => {
  // the GPU thread at 100 % over the 300 ms gap (dual core: the guest CPU spins waiting for draw-done)
  const t = 3000;
  const ours = pauseRun({ gpu: { stall: [t - 720, t - 380] }, rows: true });
  assert.equal(ours[1].smoothBins[0].gamePause, false);
  assert.equal(ours[1].smoothness, 70, "42 shown against the 60 cadence");
  assert.equal(summarizeSeconds(ours).gamePauses.count, 0);
  // the same pause, the GPU side idle: excused, published
  const game = pauseRun({ rows: true });
  assert.equal(game[1].smoothBins[0].gamePause, true);
  assert.equal(game[1].smoothness, 100);
  assert.equal(summarizeSeconds(game).gamePauses.count, 1);
  // the replay worker busy over the gap (it held the frames): ours
  const spans = (rows) => gamePauseGpuSide({ rows, a: 1300, b: 1600, producedT: [] });
  const row = (t, { work = 5, replay = 5, flush = 0, efb = 0, xfb = 0 } = {}) => [t, xfb, work * 1000, 0, 0, flush * 1000, efb * 1000, replay];
  const cum = (list) => { const acc = [0, 0, 0, 0, 0, 0, 0, 0]; return list.map((r) => r.map((v, i) => (i === 0 ? v : (acc[i] += v)))); };
  const idle = cum([row(1200), row(1300), row(1400), row(1500), row(1600), row(1700)]);
  assert.equal(spans(idle).ok, true);
  assert.equal(spans(cum([row(1200), row(1300), row(1400, { replay: 100 }), row(1500, { replay: 100 }), row(1600), row(1700)])).ok, false, "replay busy");
  assert.equal(spans(cum([row(1200), row(1300), row(1400, { flush: 20 }), row(1500), row(1600), row(1700)])).ok, false, "the CPU waited for the GPU");
  assert.equal(spans(cum([row(1200), row(1300), row(1400, { xfb: 3 }), row(1500), row(1600), row(1700)])).ok, false, "copies inside the gap");
  // a 45 ms GPU stall inside one 100 ms row counts whole (upper bound, not spread over the row)
  assert.equal(gamePauseGpuSide({ rows: cum([row(1300), row(1400, { work: 45 }), row(1500)]), a: 1330, b: 1375, producedT: [] }).ok, false);
  // the counters are credited when a pass ENDS: one 310 ms pass through the gap, ending at 1610 (credited in the
  // row ending at 1700), or just before b, or with rows offset by 50 ms: all counted, not excused
  const flat = (ts, at, work) => cum(ts.map((t) => row(t, { work: t === at ? work : 0, replay: 0 })));
  const ts = [1200, 1300, 1400, 1500, 1600, 1700, 1800];
  assert.equal(spans(flat(ts, 1700, 310)).ok, false, "credited after the gap");
  assert.equal(spans(flat(ts, 1600, 300)).ok, false, "credited at the gap's end");
  assert.equal(spans(flat(ts.map((t) => t + 50), 1650, 310)).ok, false, "rows offset");
  assert.ok(spans(flat(ts, 1700, 310)).gpuMs >= 290);
  // the present sleep is the GPU thread's too (a pacer sleeping through the gap is ours): never subtracted
  const sleepy = cum([row(1200), row(1300), row(1400, { work: 100 }), row(1500, { work: 100 }), row(1600), row(1700)]).map((r, i) => { r[4] = i >= 2 ? 200000 : 0; return r; });
  assert.equal(spans(sleepy).ok, false);
  // a wait for the GPU before the gap is not counted in it
  assert.equal(spans(cum([row(1100), row(1200, { flush: 5 }), row(1300), row(1400), row(1500), row(1600), row(1700)])).ok, true);
  // rows missing (a lost drain), or a field unknown: unknown, never excused
  const lost = pauseRun({ gpu: { drop: [2] }, rows: true });
  assert.equal(lost[1].smoothBins[0].gamePause, false);
  assert.deepEqual(spans(cum([row(1200), row(1300), row(1600), row(1700)])), { known: false, ok: false });
  const nulls = idle.map((r) => [...r]); nulls[2][7] = null;
  assert.equal(spans(nulls).known, false);
  assert.equal(spans(null).known, false);
});

test("A/B: the primary is the production gaps' total time at full speed, excused or not; the game's pauses are published, not judged", () => {
  // a gap the rule refuses (the GPU thread busy over it) and the same gap excused: the gaps' time does not move
  const refused = summarizeSeconds(pauseRun({ gpu: { stall: [2280, 2620] }, rows: true }));
  const excused = summarizeSeconds(pauseRun({ rows: true }));
  assert.deepEqual([refused.gamePauses.count, excused.gamePauses.count], [0, 1]);
  assert.ok(excused.metrics.productionGapMs > 300 && excused.metrics.productionGapMs < 320, `${excused.metrics.productionGapMs}`);
  assert.equal(refused.metrics.productionGapMs, excused.metrics.productionGapMs);
  assert.equal(refused.metrics.productionGaps, 1);
  // below full speed: the speed p5's, not a gap
  assert.equal(summarizeSeconds(pauseRun({ speed: 93, rows: true })).metrics.productionGapMs, 0);
  // the verdict
  const run = (gapMs, pauses = 0) => ({ completion: { completed: true }, phases: { menu: { metrics: { speedMedian: 100, speedP5: 99, newFpsMedian: 60, smoothP5: 100, hitches100: 0, smoothReliable: true, productionGapMs: gapMs, gamePauses: pauses, gamePauseMs: pauses * 100 } } }, sections: {} });
  const flip = parcoursVerdict([run(400, 0), run(410, 0), run(405, 0)], [run(400, 2), run(405, 2), run(410, 2)]);
  assert.equal(flip.regression, false, "a refused gap turned excused: no regression");
  const more = parcoursVerdict([run(400), run(410), run(405)], [run(900), run(910), run(905)]);
  assert.equal(more.regression, true);
  assert.deepEqual(more.regressions.map((r) => r.metric), ["productionGapMs"]);
  // the floor: 60 ms more, with no spread, is no regression
  assert.equal(parcoursVerdict([run(400), run(400), run(400)], [run(460), run(460), run(460)]).regression, false);
  // a gap of unknown length on either side: that row judged neither way
  const unk = (gapMs) => { const r = run(gapMs); r.phases.menu.metrics.productionGapsUnknown = 1; return r; };
  const u = parcoursVerdict([run(400), run(410), run(405)], [unk(900), run(910), run(905)]);
  assert.equal(u.regression, false);
  assert.equal(u.phases["kind:menu"].rows.find((r) => r.metric === "productionGapMs").unreliable, true);
  assert.equal(PARCOURS_PRIMARY.productionGapMs, "up");
  assert.equal(PARCOURS_PRIMARY.gamePauses, undefined);
  assert.equal(PARCOURS_PRIMARY.gamePauseMs, undefined);
});

test("an emulation stall on top of the game's pause still shows: below full speed, the second is a loss against the scene cadence", () => {
  // the emulation at 93 % in the pause second, 4 VIs missing
  const r = pauseRun({ visIn: 56, speed: 93 });
  assert.equal(r.smoothBins[0].gamePause, false);
  assert.equal(r.smoothness, 70, "42 shown against the 60 cadence");
  assert.ok(r.speed < 95, `speed ${r.speed}`);
  // the VIs stopped inside the gap: no game pause, a loss
  const stalled = pauseRun({ gapVis: false, rows: true });
  assert.equal(stalled.some((x) => x.smoothBins.some((y) => y.gamePause)), false);
  assert.equal(summarizeSeconds(stalled).gamePauses.count, 0);
  // at full speed, VIs missing outside the gap: excused, the missed VIs cost it
  const missed = pauseRun({ visIn: 56 });
  assert.equal(missed.smoothBins[0].gamePause, true);
  assert.equal(missed.smoothness, 91.3, "42 shown against 42 made + 4 VIs missed");
  // VI counts per grid second: unknown where a reading lost them
  const s = samplesOf([["menu", 3]]);
  s.forEach((x) => { x.viT = presentsIn(x.t, 60); });
  assert.deepEqual(viBins(s), [60, 60, 60]);
  s[2].viT = null;
  assert.deepEqual(viBins(s), [60, null, null]);
});

test("probe: every run keeps the drop sampler's GPU-side rows (gpuRows), in GPU_ROW_COLUMNS order; a failed drain: null", () => {
  const columns = ["t", "lagMs", "xfbCopies", "gpuWorkUs", "gpuConsumerWaitUs", "presentSleepUs", "flushGpuWaitUs", "efbWaitUs", "replayBusyMs", "ticks"];
  const rows = gpuRowsOf({ columns, rows: [[1000.04, 3, 10, 2000.06, 0, 0, 0, 0, 50.25, 9], [1100, 1, 16, 3000, 0, 0, 0, null, 55, 9]] });
  const none = Array(15).fill(null); // patches 0219 and 0220's columns: absent here
  assert.deepEqual(rows, [[1000, 10, 2000.1, 0, 0, 0, 0, 50.3, ...none], [1100, 16, 3000, 0, 0, 0, null, 55, ...none]]);
  assert.equal(gpuRowsOf({ error: "gone" }), null);
  assert.equal(gpuRowsOf(null), null);
  // a core without the replay column: that field unknown, never 0
  assert.deepEqual(gpuRowsOf({ columns: columns.slice(0, 8), rows: [[1, 0, 1, 2, 0, 0, 0, 0]] }), [[1, 1, 2, 0, 0, 0, 0, null, ...none]]);
  // patch 0219's miss counters ride along, by name
  const c19 = [...columns, "texLoads", "texBytes", "texDecodeUs", "texCopyPushUs", "shaderCompiles", "shaderGenUs", "shaderXlatPushUs", "pipelineMisses", "pipelineUs"];
  assert.deepEqual(gpuRowsOf({ columns: c19, rows: [[1, 0, 2, 3, 0, 0, 0, 0, 4, 9, 1, 2, 3, 4, 5, 6, 7, 8, 9]] })[0].slice(8, 17), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  // every run records them, not only with --sampler-rows
  const probe = readFileSync(new URL("../harness/probes/parcours.mjs", import.meta.url), "utf8");
  assert.match(probe, /raw\.samples\.push\(\{ t, info, counters: countersOf\(drained\), gpuRows: gpuRowsOf\(drained\),/);
  assert.match(probe, /const drained = raw\.samplerMissing \? null : await workerRequest\(page, "validationDropSampler", \{ action: "drain" \}, 5000\);/);
  // the worker samples the column
  const worker = readFileSync(new URL("../src/upstream-discio-worker.js", import.meta.url), "utf8");
  assert.match(worker, /"replayBusyMs",\n/);
  // and patch 0219's miss counters, unwrapped from the core's u32 words, on only while the sampler runs
  assert.match(worker, /"shaderCompiles", "shaderGenUs", "shaderXlatPushUs", "pipelineMisses", "pipelineUs",\n/);
  // and patch 0220's translation columns after them
  assert.match(worker, /"xlatGlslangUs", "xlatNagaUs", "xlatPushUs", "xlatWgslBytes", "xlatDuplicates", "xlatUntracked"\n\];/);
  assert.match(worker, /readLoadStats\(m, heap, out\);\n\s+return DROP_COLUMNS\.map/);
  assert.match(worker, /harnessLoadStats = true;\n\s+moduleInstance\?\._DolphinWeb_HarnessLoadStatsEnable\?\.\(1\);/);
  assert.match(worker, /harnessLoadStats = false;\n\s+moduleInstance\?\._DolphinWeb_HarnessLoadStatsEnable\?\.\(0\);/);
  assert.match(worker, /if \(harnessLoadStats\) moduleInstance\._DolphinWeb_HarnessLoadStatsEnable\?\.\(1\);/);
  assert.match(worker, /out\.replayBusyMs = occupancyBusyMs\(\);/);
});

// A non-excused irregular second: judged against its own regular part's rate snapped to VI/n, else the nominal cadence.
// `before`: the first second's rate (the scene cadence a learner would take), else `fps`
function rateRun(fps, hole, { copies = fps, before = fps } = {}) {
  const s = rvBase();
  let shown = 0;
  for (const r of s.slice(1)) { const n = r === s[1] ? before : fps; r.producedT = presentsIn(r.t, n); r.presents = presentsIn(r.t, n); r.info.producedFps = n; shown += n; r.info.newShown = shown; }
  const t = s[2].t, cut = (xs) => xs.filter((p) => !(p >= t - hole[0] && p < t - hole[1]));
  s[2].producedT = cut(s[2].producedT); s[2].presents = cut(s[2].presents);
  rvCounters(s, () => copies);
  // the GPU thread busy over the hole: ours, never the game's pause
  withGpuRows(s, { stall: [t - hole[0] - 20, t - hole[1] + 20] });
  return deriveSeconds(s, { tps: TPS })[1].smoothBins[0];
}

test("a non-excused irregular second: 30 frames a second with a 100 ms GPU gap is judged against 30 and loses the gap", () => {
  const b = rateRun(30, [600, 500]);
  assert.equal(b.gamePause, false);
  assert.equal(b.reference, "own");
  assert.equal(b.produced, 27);
  assert.equal(b.smoothness, 90, "27 shown against 30");
  // whatever the scene before ran at (a learner would take 60 there: 45 %)
  assert.equal(rateRun(30, [600, 500], { before: 60 }).smoothness, 90);
});

test("a non-excused irregular second: a 60 frames a second scene that stalls 300 ms is judged against 60", () => {
  const b = rateRun(60, [700, 400]);
  assert.equal(b.reference, "own");
  assert.equal(b.smoothness, 70, "42 shown against 60");
  // after a scene at 30 (a learner would take 30 there: 100 %)
  assert.equal(rateRun(60, [700, 400], { before: 30 }).smoothness, 70);
});

test("a non-excused irregular second without enough regular part falls back to the nominal 60, never a learnt cadence", () => {
  // 30 frames a second, a 600 ms gap: 400 ms regular, under half the second
  const short = rateRun(30, [800, 200]);
  assert.equal(short.reference, "nominal");
  assert.equal(short.smoothness, round1((short.produced / 60) * 100));
  // the rule alone: 45 a second alternating 1 and 2 VIs (no k on 80 %): nominal; 20 a second: 60 / 3
  const vi = 1000 / 59.94;
  const alt = []; for (let t = 0, i = 0; t < 1000; t += (i++ % 2 ? 2 : 1) * vi) alt.push(t);
  assert.deepEqual(ownRateCadence({ producedT: alt, from: 0, to: 1000, viMs: vi, nominalCadence: 60 }), { cadence: 60, from: "nominal" });
  // the GPU side's rows over [-500, 1500]: idle (5 %), or the GPU thread busy 90 %
  const sideRows = (busy) => { const out = []; for (let t = -500, w = 0; t <= 1500; t += 100) { out.push([t, 0, w * 1000, 0, 0, 0, 0, 5 * (out.length)]); w += busy * 100; } return out; };
  const idle = { speed: 100, gpuRows: sideRows(0.05) };
  const at20 = Array.from({ length: 20 }, (_, i) => i * 3 * vi);
  assert.deepEqual(ownRateCadence({ producedT: at20, from: 0, to: 1000, viMs: vi, nominalCadence: 60, ...idle }), { cadence: 20, from: "own" });
  // host jitter of a third of a VI still rounds to the same multiple
  const jit = Array.from({ length: 30 }, (_, i) => i * 2 * vi + (i % 2 ? 2.5 : -2.5)); // intervals 2 VIs ± 5 ms
  assert.deepEqual(ownRateCadence({ producedT: jit, from: -10, to: 990, viMs: vi, nominalCadence: 60, ...idle }), { cadence: 30, from: "own" });
  // PAL: the nominal 50 and 50 / k
  assert.deepEqual(ownRateCadence({ producedT: [], from: 0, to: 1000, viMs: 20, nominalCadence: 50, ...idle }), { cadence: 50, from: "nominal" });
  assert.deepEqual(ownRateCadence({ producedT: Array.from({ length: 25 }, (_, i) => i * 40), from: 0, to: 1000, viMs: 20, nominalCadence: 50, ...idle }), { cadence: 25, from: "own" });
  // below the VI rate, ours unless proven otherwise: below full speed, the GPU thread busy 90 %, the GPU side
  // unknown, or k past 3 (10 a second: a render-starved rate at full guest speed) all give the nominal 60
  assert.equal(ownRateCadence({ producedT: at20, from: 0, to: 1000, viMs: vi, nominalCadence: 60, speed: 93, gpuRows: idle.gpuRows }).cadence, 60);
  assert.equal(ownRateCadence({ producedT: at20, from: 0, to: 1000, viMs: vi, nominalCadence: 60, speed: 100, gpuRows: sideRows(0.9) }).cadence, 60);
  assert.equal(ownRateCadence({ producedT: at20, from: 0, to: 1000, viMs: vi, nominalCadence: 60, speed: 100 }).cadence, 60);
  const at10 = Array.from({ length: 10 }, (_, i) => i * 6 * vi);
  assert.equal(ownRateCadence({ producedT: at10, from: 0, to: 1000, viMs: vi, nominalCadence: 60, ...idle }).cadence, 60);
  // a single long interval is no regular part (k 36)
  assert.equal(ownRateCadence({ producedT: [100, 700], from: 0, to: 1000, viMs: vi, nominalCadence: 60, ...idle }).cadence, 60);
});
const round1 = (x) => Math.round(x * 10) / 10;

test("production gaps: a covered reading of unknown speed makes the gap unknown (counted apart), never dropped", () => {
  const vi = 1000 / 59.94;
  const producedT = [0, vi, 2 * vi, 2 * vi + 300, 2 * vi + 300 + vi];
  const gaps = (speeds) => productionGapsOf({ producedT, origin: 0, binMs: 1000, produced: [60], viMs: vi, speedAt: () => speeds });
  assert.deepEqual(gaps([100]), [{ k: 0, ms: 300 }]);
  assert.deepEqual(gaps([100, null]), [{ k: 0, ms: null }]);
  assert.deepEqual(gaps([]), [{ k: 0, ms: null }]);
  assert.deepEqual(gaps([93]), [], "below full speed: the speed p5's");
  // a known speed below full excludes the gap, whatever the readings with no speed (review of #473)
  assert.deepEqual(gaps([93, null]), []);
  assert.deepEqual(gaps([null, 93]), []);
  assert.deepEqual(gaps([100, 99, null]), [{ k: 0, ms: null }]);
  // in a run: every speed known (counters on every reading): the gap measured, none unknown
  const known = summarizeSeconds(pauseRun({ rows: true, copies: 60 })).metrics;
  assert.equal(known.productionGapsUnknown, 0);
  assert.equal(known.productionGaps, 1);
  // in a run read without counters (no sampler rows, no speed in the worker's info): the gap counted unknown, its ms not summed
  const s = rvBase();
  const g = rvPause(s[2].t);
  s[2].producedT = g(s[2].producedT); s[2].presents = g(s[2].presents);
  for (const x of s) { x.counters = null; delete x.info.speed; }
  const unknown = summarizeSeconds(deriveSeconds(s, { tps: TPS })).metrics;
  assert.equal(unknown.productionGapsUnknown, 1);
  assert.equal(unknown.productionGapMs, 0);
  // a reading below full speed over the gap with others unknown: not a gap, not unknown
  const slow = rvBase();
  slow[2].producedT = g(slow[2].producedT); slow[2].presents = g(slow[2].presents);
  rvCounters(slow, () => 60);
  slow[2].counters = { ...slow[2].counters, ticks: slow[1].counters.ticks + TPS * 0.93 };
  slow[3].counters = { ...slow[3].counters, ticks: slow[2].counters.ticks + TPS };
  const sm = summarizeSeconds(deriveSeconds(slow, { tps: TPS })).metrics;
  assert.equal(sm.productionGapsUnknown, 0);
  assert.equal(sm.productionGapMs, 0);
});

test("the game-pause rule reads only its own GPU-side fields: patch 0219's columns null (an older core) change nothing", () => {
  const row = (t, extra) => [t, 0, 1000 * (t / 100), 0, 0, 0, 0, t / 20, ...extra];
  const without = [1200, 1300, 1400, 1500, 1600, 1700].map((t) => row(t, Array(15).fill(null)));
  const withStats = [1200, 1300, 1400, 1500, 1600, 1700].map((t) => row(t, Array(15).fill(1)));
  assert.notEqual(gpuSideBusy(without, 1300, 1600), null);
  assert.deepEqual(gpuSideBusy(without, 1300, 1600), gpuSideBusy(withStats, 1300, 1600));
  assert.equal(GPU_ROW_COLUMNS.length, 23);
});
