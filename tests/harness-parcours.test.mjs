// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import { analyzeRun, classifySecond, completionOf, currentPhase, deriveSeconds, GAME_DRAWS_PER_FRAME, LOAD_DISC_BPS, markerIndexes, MIN_PHASE_SEC, parcoursVerdict, phaseLabels, phaseMetrics, phaseNoise, renderTimeline, sectionsOf, segmentsOf, summarizeSeconds, windowCadence } from "../harness/lib/parcours.mjs";
import { filmMarkers, filmWithMarks, keyToPad, padStateOf, recordPorts, runRecordSteps, validateFilm, validateRecordSteps } from "../harness/lib/pad-film.mjs";
import { analyzeRaw, countersOf, exitCodeOf, humanSummary, markerStep } from "../harness/probes/parcours.mjs";
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
// Raw samples (as the probe records them) for a list of [look, seconds].
function samplesOf(plan, { speed = 100, busy = 0.3, presentGap = null } = {}) {
  const out = [];
  let t = 1000, ticks = 0, shown = 0, draws = 0, disc = 0, xfb = 0, p = 1000;
  out.push({ t, info: { newShown: 0, draws: 0, producedFps: 0 }, counters: { t, ticks, discBytes: 0, xfbCopies: 0 }, presents: [], vi: 0 });
  let sec = 0;
  for (const [look, n] of plan) {
    for (let k = 0; k < n; k += 1, sec += 1) {
      const L = LOOK[look];
      t += 1000; ticks += TPS * (speed / 100); shown += L.newFps; draws += L.draws * L.newFps; disc += L.disc; xfb += L.xfb;
      const presents = [];
      for (let i = 0; i < 60; i += 1) { p += 1000 / 60; presents.push(p); }
      if (presentGap?.at === sec) { presents.splice(10, 7); }
      out.push({ t, info: { speed, newShown: shown, producedFps: L.newFps, draws, cpuBusy: busy, gpuBusy: busy, replayBusy: busy, outOfOrder: 0 }, counters: { t, ticks, discBytes: disc, xfbCopies: xfb }, presents, vi: 60, integrity: { id: 1, replayFatal: 0, stateLoads: 0 } });
    }
  }
  return out;
}

test("deriveSeconds: speed from the core ticks, new frames from the shown counter, rates per frame, hitches from the presents", () => {
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
  for (const x of s.slice(1)) x.info.newShown = (x.info.newShown / 60) * 30, x.info.producedFps = 30;
  const rows = deriveSeconds(s, { tps: TPS });
  assert.deepEqual(rows.map((r) => r.smoothness), [100, 100, 100]);
  const busy = samplesOf([["game", 3]], { busy: 0.9 });
  for (const x of busy.slice(1)) x.info.newShown = (x.info.newShown / 60) * 30, x.info.producedFps = 30;
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
