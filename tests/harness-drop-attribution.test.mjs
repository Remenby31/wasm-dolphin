import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  attributeDips, attributeSecond, attributionLines, beatEvidence, dropWindowsForAttribution, hitchCause,
  attributionTable, fitPeriod, learnedCadences, measuredRefreshHz, parcoursWindowsForAttribution
} from "../harness/lib/drops.mjs";

const quiet = { cpu: 0.3, gpu: 0.3, replay: 0.2 };
// one second as 10 windows of 100 ms, the totals spread evenly
function second(t, { speed = 100, produced = 60, shown = 60, presents = 60, causes = {}, occupancy = quiet, gaps = [], phase = null, mainLagMs = 0, workerLagMs = 0, beatFrames = 0, cadence } = {}) {
  return Array.from({ length: 10 }, (_, i) => ({
    t: t + i * 100, ms: 100, phase, speed, cadence,
    produced: produced / 10, shown: shown / 10, presents: presents == null ? null : presents / 10,
    causes: Object.fromEntries(Object.entries(causes).map(([k, v]) => [k, v / 10])),
    occupancy, gaps: i === 0 ? gaps : [], mainLagMs: mainLagMs / 10, workerLagMs: workerLagMs == null ? null : workerLagMs / 10, beatFrames: i === 0 ? beatFrames : 0
  }));
}
const allParts = (d) => Object.values(d.parts).reduce((a, f) => a + f, 0);

test("the parts always add up to the deficit (cadence − shown), shown above produced included", () => {
  // the review's case: produced 50, shown 52 → the deficit is 8, not 10
  const d = attributeSecond(second(0, { produced: 50, shown: 52, presents: 52 }), { cadence: 60 });
  assert.equal(d.deficit, 8);
  assert.ok(Math.abs(allParts(d) - 8) < 0.05, JSON.stringify(d.parts));
  // random seconds: the sum of every part (content included) is the deficit
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (let n = 0; n < 2000; n += 1) {
    const produced = Math.round(rnd() * 70), shown = Math.round(rnd() * 70), presents = rnd() < 0.2 ? null : Math.round(rnd() * 70);
    const speed = rnd() < 0.1 ? null : 50 + rnd() * 60;
    const occupancy = rnd() < 0.2 ? { cpu: rnd(), gpu: null, replay: rnd() } : { cpu: rnd(), gpu: rnd(), replay: rnd() };
    const causes = { jit: rnd() * 600, disc: rnd() * 300, uncountedBusy: rnd() * 200 };
    const gaps = [{ ms: 20 + rnd() * 200, vis: rnd() < 0.3 ? null : Math.round(rnd() * 12), workerLagMs: rnd() < 0.3 ? null : rnd() * 200 }];
    const s = attributeSecond(second(0, { produced, shown, presents, speed, occupancy, causes, gaps, beatFrames: Math.round(rnd() * 5) }), { cadence: 60 });
    assert.ok(Math.abs(allParts(s) - Math.max(0, 60 - shown)) < 0.05, `n=${n} ${JSON.stringify({ produced, shown, presents, speed, parts: s.parts })}`);
    assert.ok(Object.values(s.parts).every((f) => f > 0));
  }
});

test("a slow guest: the production gap shared in proportion to the counted causes", () => {
  // 80 %: 200 ms lost, 120 in compiles, 20 on the disc; 12 frames not produced
  const d = attributeSecond(second(0, { speed: 80, produced: 48, shown: 48, presents: 48, causes: { jit: 120, disc: 20 } }), { cadence: 60 });
  assert.deepEqual(d.parts, { "emulation:jit": 7.2, "emulation:disc": 1.2, "emulation:unexplained": 3.6 });
  // the counted ms past the time lost: scaled down together, never by list order
  const over = attributeSecond(second(0, { speed: 80, produced: 48, shown: 48, presents: 48, causes: { jit: 300, disc: 100 } }), { cadence: 60 });
  assert.deepEqual(over.parts, { "emulation:jit": 9, "emulation:disc": 3 });
  // the speed not measured: production:unknown
  assert.deepEqual(attributeSecond(second(0, { speed: null, produced: 48, shown: 48, presents: 48 }), { cadence: 60 }).parts, { "production:unknown": 12 });
});

test("full speed: saturated → game, content only with every occupancy known and margin left", () => {
  assert.deepEqual(attributeSecond(second(0, { produced: 45, shown: 45, presents: 45, occupancy: { cpu: 0.3, gpu: 0.97, replay: 0.9 } }), { cadence: 60 }).parts, { "game:gpu+replay": 15 });
  const menu = attributeSecond(second(0, { produced: 30, shown: 30, presents: 60, occupancy: quiet }), { cadence: 60 });
  assert.deepEqual(menu.parts, { content: 30 });
  assert.equal(menu.lostFrames, 0);
  // replay not measured (drop-meter): never content
  assert.deepEqual(attributeSecond(second(0, { produced: 30, shown: 30, presents: 60, occupancy: { cpu: 0.2, gpu: 0.2, replay: null } }), { cadence: 60 }).parts, { "game:unknown": 30 });
  // a thread without margin (0.7 to 0.85): marginal, undecided, not lost;
  // a small shortfall with quiet threads: game:marginal
  assert.deepEqual(attributeSecond(second(0, { produced: 30, shown: 30, presents: 60, occupancy: { cpu: 0.75, gpu: 0.2, replay: 0.1 } }), { cadence: 60 }).parts, { marginal: 30 });
  assert.deepEqual(attributeSecond(second(0, { produced: 58, shown: 58, presents: 60, occupancy: quiet }), { cadence: 60 }).parts, { "game:marginal": 2 });
});

test("presentation: blocked, beat, no-present, old-frame; unknown when not measured", () => {
  assert.deepEqual(attributeSecond(second(0, { produced: 60, shown: 52, presents: 54 }), { cadence: 60 }).parts, { "no-present": 6, "old-frame": 2 });
  const blocked = attributeSecond(second(0, { produced: 60, shown: 52, presents: 54, gaps: [{ ms: 100, vis: 6, workerLagMs: 80 }] }), { cadence: 60 });
  assert.deepEqual(blocked.parts, { "presenter-blocked": 5, "no-present": 3 });
  // the gap's VIs or the worker's lateness not measured: not blocked
  for (const g of [{ ms: 100, vis: null, workerLagMs: 80 }, { ms: 100, vis: 6, workerLagMs: null }]) {
    assert.equal(attributeSecond(second(0, { produced: 60, shown: 52, presents: 54, gaps: [g], workerLagMs: null }), { cadence: 60 }).parts["presenter-blocked"], undefined, JSON.stringify(g));
  }
  // proven beat frames come before no-present
  assert.deepEqual(attributeSecond(second(0, { produced: 60, shown: 52, presents: 54, beatFrames: 3 }), { cadence: 60 }).parts, { beat: 3, "no-present": 5 });
  // presents not measured: pacing:unknown, never old-frame
  assert.deepEqual(attributeSecond(second(0, { produced: 60, shown: 52, presents: null }), { cadence: 60 }).parts, { "pacing:unknown": 8 });
});

test("markers, and a second without produced or shown is not judged", () => {
  assert.deepEqual(attributeSecond(second(0, { produced: 60, shown: 55, mainLagMs: 40, workerLagMs: 60 }), { cadence: 60 }).markers, ["main-stall", "gc-probable"]);
  assert.deepEqual(attributeSecond(second(0, { speed: 90, produced: 54, shown: 54, workerLagMs: 60, causes: { jit: 80 } }), { cadence: 60 }).markers, []);
  assert.equal(attributeSecond([{ t: 0, ms: 1000, produced: null, shown: 60 }], { cadence: 60 }), null);
});

test("dips and the table, per phase, ranked; a cadence per window", () => {
  const windows = [
    ...second(0, { phase: "race" }),
    ...second(1000, { phase: "race", produced: 60, shown: 52, presents: 54 }),
    ...second(2000, { phase: "race", speed: 80, produced: 48, shown: 48, presents: 48, causes: { jit: 200 } }),
    ...second(3000, { phase: "menu", produced: 30, shown: 30, presents: 60, cadence: 30, occupancy: { cpu: 0.95, gpu: 0.1, replay: 0.1 } })
  ];
  const r = attributeDips(windows, { cadence: 60 });
  assert.equal(r.seconds, 4);
  assert.equal(r.dips.length, 2, "the 30 fps menu is not a dip at 30, even saturated");
  const race = r.table.find((x) => x.phase === "race");
  assert.equal(race.lostFrames, 20);
  assert.deepEqual(race.ranked.map((x) => x.cause), ["emulation:jit", "no-present", "old-frame"]);
  assert.ok(attributionLines(r).some((l) => /emulation:jit +12 frames +60\.0 %/.test(l)));
  assert.throws(() => attributeDips(second(0), {}), /window\.cadence/);
});

test("a hitch's own cause; unknown when its VIs were not measured", () => {
  const frameMs = 1000 / 60;
  assert.equal(hitchCause({ ms: 50, vis: 3 }, { causes: {} }, { frameMs }), "no-present");
  assert.equal(hitchCause({ ms: 50, vis: 3, workerLagMs: 40 }, {}, { frameMs }), "presenter-blocked");
  assert.equal(hitchCause({ ms: 50, vis: 3 }, { workerLagMs: null }, { frameMs }), "no-present", "lateness unknown: not blocked");
  assert.equal(hitchCause({ ms: 100, vis: 1 }, { speed: 60, causes: { jit: 30, disc: 5 } }, { frameMs }), "emulation:jit");
  assert.equal(hitchCause({ ms: 100, vis: null }, { causes: { jit: 30 } }, { frameMs }), "unknown");
});

// A screen ticking at `hz` and a core producing VIs at `viHz`; each tick
// shows the newest VI produced at least `latency` ms before it, with `jitter`
// on the VI times (gaussian sigma `jitter`), a stretch `slow` = [t0, t1]
// where the VIs come at `slowSpeed`; extra repeats (stalls) at the `stalls`
// times.
function timeline({ hz = 60, viHz = 59.94, seconds = 120, latency = 5, jitter = 0.2, stalls = [], seed = 3, slow = null, slowSpeed = 0.8 } = {}) {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const vi = [];
  for (let i = 0, at = 0; at < seconds * 1000; i += 1) {
    vi.push({ t: at + gauss() * jitter, index: i });
    at += (1000 / viHz) / (slow && at >= slow[0] && at < slow[1] ? slowSpeed : 1);
  }
  vi.sort((a, b) => a.t - b.t);
  const ticks = [];
  let k = 0, last = -1;
  for (let j = 0; j < seconds * hz; j += 1) {
    const t = (j * 1000) / hz;
    while (k + 1 < vi.length && vi[k + 1].t <= t - latency) k += 1;
    let show = vi[k].t <= t - latency ? vi[k].index : -1;
    if (stalls.some((x) => t >= x && t < x + 50)) show = last;
    ticks.push({ t, vi: show, submits: show === last ? 0 : 1 });
    if (show !== last) last = show;
  }
  return { vi, ticks };
}

test("the refresh is measured from the animation frames, not taken from the presentations", () => {
  const { ticks } = timeline({ hz: 60, viHz: 59.94, seconds: 30 });
  assert.ok(Math.abs(measuredRefreshHz(ticks.map((x) => x.t)) - 60) < 1e-6);
  const missed = ticks.filter((_, i) => i % 97 !== 0).map((x) => x.t);
  assert.ok(Math.abs(measuredRefreshHz(missed) - 60) < 1e-6, "a missed frame is not a slower screen");
  assert.equal(measuredRefreshHz(ticks.slice(0, 100).map((x) => x.t)), null, "too few frames");
  // 10 s of ticks with 1 ms of jitter: the regression holds the rate to the
  // thousandth of a hertz (a mean of intervals would not)
  let x = 5;
  const rnd = () => ((x = (x * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const jittered = Array.from({ length: 600 }, (_, j) => (j * 1000) / 59.94 + gauss());
  assert.ok(Math.abs(measuredRefreshHz(jittered) - 59.94) < 0.005);
});

test("the VI period: a regression over the full-speed stretches, a slow stretch neither bends it nor breaks the jitter", () => {
  const { vi } = timeline({ viHz: 59.94, seconds: 60, jitter: 0.9, slow: [20000, 25000] });
  const fit = fitPeriod(vi.map((v) => v.t), { wholeSkips: false });
  assert.ok(Math.abs(1000 / fit.periodMs - 59.94) < 0.002, `${1000 / fit.periodMs}`);
  // the residual is the timestamps' own jitter, not the slow stretch
  assert.ok(fit.sigmaMs > 0.7 && fit.sigmaMs < 1.1, `${fit.sigmaMs}`);
  // a count over the run would say ~59.4 Hz here
  assert.ok((vi.length - 1) * 1000 / (vi.at(-1).t - vi[0].t) < 59.5);
});

test("the beat: proven at the boundary on a drifting screen; random repeats on a locked one stay unproven", () => {
  // 59.94 Hz VI on a 60 Hz screen: every repeat at the drift's boundary
  const drift = beatEvidence(timeline({ viHz: 59.94, seconds: 120 }));
  assert.ok(drift.proven.length >= 6, JSON.stringify({ ...drift, proven: drift.proven.length }));
  assert.ok(drift.share >= 0.5);
  // random stalls (6 dips in 120 s) on a screen locked to the VI: nothing proven
  let tries = 0, labelled = 0;
  for (let seed = 1; seed <= 30; seed += 1) {
    let x = seed;
    const rnd = () => ((x = (x * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const stalls = Array.from({ length: 6 }, () => 2000 + rnd() * 116000);
    const ev = beatEvidence(timeline({ hz: 60, viHz: 60, seconds: 120, stalls, seed }));
    tries += 1;
    if (ev.proven.length) labelled += 1;
  }
  assert.equal(labelled, 0, `random dips labelled beat in ${labelled}/${tries} draws`);
  // random stalls on a drifting screen: the stalls' repeats are not proven beat
  let x = 11;
  const rnd = () => ((x = (x * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const stalls = Array.from({ length: 6 }, () => 2000 + rnd() * 116000);
  const mixed = beatEvidence(timeline({ viHz: 59.94, seconds: 120, stalls }));
  const atStalls = mixed.proven.filter((t) => stalls.some((s) => t >= s && t < s + 60)).length;
  assert.ok(atStalls <= 1, `${atStalls} stall repeats labelled beat`);
});

test("the beat: a screen locked to the VI with a slow stretch shows no beat; the window follows the VI jitter measured", () => {
  // locked 59.94 / 59.94, 5 s at 80 % speed: the slow VIs repeat pictures,
  // but the VI rate is the screen's: no drift, nothing proven
  for (const slow of [[30000, 35000], [30000, 31000]]) {
    const ev = beatEvidence(timeline({ hz: 59.94, viHz: 59.94, seconds: 120, slow, jitter: 0.9 }));
    assert.equal(ev.proven.length, 0, JSON.stringify({ ...ev, proven: ev.proven.length }));
    assert.match(ev.reason, /do not drift/);
  }
  // the worker's VI timestamps jitter by ~0.7-0.9 ms (measured on two Mac
  // runs): the window is 3 sigma of that, under the half-period, and the beat
  // is still proven while random stalls are not
  let x = 17;
  const rnd = () => ((x = (x * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const stalls = Array.from({ length: 6 }, () => 2000 + rnd() * 116000);
  const ev = beatEvidence(timeline({ viHz: 59.94, seconds: 120, jitter: 0.9, stalls }));
  assert.ok(ev.viJitterMs > 0.7 && ev.viJitterMs < 1.1, `${ev.viJitterMs}`);
  assert.ok(Math.abs(ev.deltaMs - 3 * ev.viJitterMs) < 0.01 && ev.deltaMs < 1000 / 60 / 4);
  assert.ok(ev.proven.length >= 6, JSON.stringify({ ...ev, proven: ev.proven.length }));
  const atStalls = ev.proven.filter((t) => stalls.some((s) => t >= s && t < s + 60)).length;
  assert.ok(atStalls <= 1, `${atStalls} stall repeats labelled beat`);
});

test("learned cadences: from previous seconds only, a median, every thread measured with margin", () => {
  const s = (vis, produced, cpu = 0.3, speed = 100, replay = 0.1) => ({ vis, produced, speed, occupancy: { cpu, gpu: 0.2, replay } });
  // a second is never judged against itself: the 30 fps second keeps 60
  assert.deepEqual(learnedCadences([s(60, 60), s(60, 30), s(60, 30), s(60, 30), s(60, 30)]), [60, 60, 60, 30, 30]);
  // one 40-frame second among 60s does not move the median
  assert.deepEqual(learnedCadences([s(60, 60), s(60, 60), s(60, 40), s(60, 60), s(60, 60)]), [60, 60, 60, 60, 60]);
  // busy, slow, or a thread not measured (replay): nothing learned, the reference holds
  assert.deepEqual(learnedCadences([s(60, 30, 0.9), s(60, 30, 0.3, 80), s(60, 30, 0.3, 100, null), s(60, 30)], { reference: 59.94 }), [59.94, 59.94, 59.94, 59.94]);
});

test("drop-meter: 60/40/60 new frames with replay unsampled keeps the VI cadence, the 40 second is one dip", () => {
  const windows = [], displayed = [], vi = [], presents = [];
  let idx = 0;
  for (let s = 0; s < 3; s += 1) {
    const fps = s === 1 ? 40 : 60;
    for (let w = 0; w < 10; w += 1) windows.push({ t0: s * 1000 + w * 100, label: null, speed: 100, presents: 6, xfb: fps / 10, sleptMs: 70, gpuWorkMs: 30, causes: { workerPause: 0, mainPause: 0 } });
    for (let i = 0; i < 60; i += 1) {
      const t = s * 1000 + (i * 1000) / 60;
      vi.push({ t, sinceBoot: idx }); presents.push({ t: t + 5 });
      if (fps === 60 || i % 3 !== 2) displayed.push({ t: t + 5, vi: idx, submits: 1 });
      idx += 1;
    }
  }
  const aw = dropWindowsForAttribution(windows, { presents, vi, displayed });
  assert.deepEqual([0, 10, 20].map((i) => Math.round(aw[i].cadence)), [60, 60, 60]);
  const r = attributeDips(aw, { cadence: 60 });
  assert.equal(r.dips.length, 1);
  assert.deepEqual(Object.keys(r.dips[0].parts), ["game:unknown"], "replay not sampled: never content");
});

test("causes floor at 0 per window: a negative window never cancels a positive one, nor fires gc-probable", () => {
  // the jit counter: +100 ms in one window, −100 ms in another
  const ws = second(0, { speed: 80, produced: 48, shown: 48, presents: 48 });
  ws[0].causes = { jit: 100 };
  ws[1].causes = { jit: -100 };
  const d = attributeSecond(ws, { cadence: 60 });
  assert.ok(d.parts["emulation:jit"] > 0, JSON.stringify(d.parts));
  // worker late 60 ms with 100 ms of counted work: not GC, even if another window says −100
  const late = second(0, { produced: 60, shown: 55, workerLagMs: 60 });
  late[0].causes = { jit: 100 };
  late[1].causes = { jit: -100 };
  assert.deepEqual(attributeSecond(late, { cadence: 60 }).markers, []);
  const neg = second(0, { produced: 60, shown: 55, workerLagMs: 60 });
  neg[0].causes = { disc: -500 };
  assert.deepEqual(attributeSecond(neg, { cadence: 60 }).markers, ["gc-probable"], "a negative counter is not counted work");
  assert.equal(hitchCause({ ms: 100, vis: 1 }, { causes: { jit: -30, disc: -5 } }, { frameMs: 1000 / 60 }), "emulation:unexplained");
});

test("fitPeriod: 600 timestamps with 2 ms of jitter, the error stays at the regression's own (σ·√12/N^1.5)", () => {
  const errs = [];
  for (let seed = 1; seed <= 100; seed += 1) {
    let x = seed * 31;
    const rnd = () => ((x = (x * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
    const f = fitPeriod(Array.from({ length: 600 }, (_, j) => (j * 1000) / 59.94 + 2 * gauss()));
    errs.push(1000 / f.periodMs - 59.94);
  }
  const sd = Math.sqrt(errs.reduce((a, e) => a + e * e, 0) / errs.length);
  const theory = ((59.94 ** 2) / 1000) * 2 * Math.sqrt(12) / 600 ** 1.5;
  assert.ok(sd < 1.5 * theory, `sd ${sd} vs ${theory}`);
});

test("fitPeriod: a few per cent slow never bends the VI period; a locked screen with such a slowdown shows no beat", () => {
  // 3-4 % for seconds, and slowdowns too small for the local slope (0.1-0.2 %
  // for 12-20 s): the per-block rates cut them out
  for (const [speed, from, to] of [[0.96, 40000, 45000], [0.97, 40000, 50000], [0.999, 40000, 52000], [0.998, 40000, 60000]]) for (const jitter of [0.7, 0.9]) {
    const { vi } = timeline({ hz: 59.94, viHz: 59.94, seconds: 120, jitter, slow: [from, to], slowSpeed: speed, seed: 5 });
    const f = fitPeriod(vi.map((v) => v.t), { wholeSkips: false });
    assert.ok(Math.abs(1000 / f.periodMs - 59.94) < 0.005, `${speed} σ${jitter}: ${1000 / f.periodMs}`);
    let x = 23;
    const rnd = () => ((x = (x * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const stalls = Array.from({ length: 10 }, () => 2000 + rnd() * 116000);
    const ev = beatEvidence(timeline({ hz: 59.94, viHz: 59.94, seconds: 120, jitter, slow: [from, to], slowSpeed: speed, stalls, seed: 5 }));
    assert.equal(ev.proven.length, 0, `${speed} σ${jitter}: ${ev.reason ?? ev.proven.length}`);
  }
});

test("the refresh: one rate or none (60 → 120, 120 → 60, 60 → 72 give null), a missed vsync is not a rate", () => {
  const ticks = (hzAt, ms = 60000, sigma = 0.2, missed = 0) => {
    let x = 9;
    const rnd = () => ((x = (x * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const out = [];
    for (let at = 0; at < ms; at += 1000 / hzAt(at)) if (rnd() >= missed) out.push(at + (rnd() - 0.5) * 2 * sigma);
    return out;
  };
  assert.ok(Math.abs(measuredRefreshHz(ticks(() => 60, 60000, 0.2, 0.1)) - 60) < 0.001);
  for (const [name, hz] of [["60 → 120", (t) => (t < 40000 ? 60 : 120)], ["120 → 60", (t) => (t < 40000 ? 120 : 60)], ["60 → 72", (t) => (t < 50000 ? 60 : 72)], ["60 → 120 at half", (t) => (t < 30000 ? 60 : 120)], ["60 → 59.94 at half", (t) => (t < 30000 ? 60 : 59.94)]]) {
    assert.equal(measuredRefreshHz(ticks(hz)), null, name);
  }
});

test("fitPeriod: a rate less precise than 5 mHz is no rate; at 3 ms of jitter a rate given is right", () => {
  let x = 41;
  const rnd = () => ((x = (x * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const run = (n, sigma) => Array.from({ length: n }, (_, j) => (j * 1000) / 59.94 + sigma * gauss());
  // 300 points at 3 ms: the slope's standard error is ~7 mHz
  assert.equal(fitPeriod(run(300, 3), { min: 300 }), null);
  for (let i = 0; i < 40; i += 1) {
    const f = fitPeriod(run(600, 3));
    if (f) assert.ok(f.seHz <= 0.005 && Math.abs(1000 / f.periodMs - 59.94) < 4 * f.seHz, `${1000 / f.periodMs} ± ${f.seHz}`);
  }
});

test("a thread between the content margin and saturation: marginal, not lost; a cadence over the VI rate is capped", () => {
  // 12 new frames a second, all shown, at full speed, cpu 0.717
  const d = attributeSecond(second(0, { produced: 12, shown: 12, presents: 60, occupancy: { cpu: 0.717, gpu: 0.3, replay: 0.2 } }), { cadence: 60 });
  assert.deepEqual(d.parts, { marginal: 48 });
  assert.equal(d.lostFrames, 0);
  const table = attributionTable([d], []);
  assert.equal(table[0].marginalFrames, 48);
  assert.deepEqual(table[0].ranked, []);
  // quiet threads, produced near the cadence: still game:marginal, lost
  assert.deepEqual(attributeSecond(second(0, { produced: 58, shown: 58, presents: 60 }), { cadence: 60 }).parts, { "game:marginal": 2 });
  // a cadence of 120 on a 60 VI/s second: expected 60, not 120
  const ws = second(0, { produced: 60, shown: 60, presents: 60, cadence: 120 }).map((w) => ({ ...w, vis: 6 }));
  assert.equal(attributeSecond(ws, {}).expected, 60);
  // a slow core keeps its cadence: 48 VIs at 80 % speed are 60 nominal
  const slow = second(0, { speed: 80, produced: 48, shown: 48, presents: 48, cadence: 60 }).map((w) => ({ ...w, vis: 4.8 }));
  assert.equal(attributeSecond(slow, {}).expected, 60);
  // parcours rows carry viRate
  assert.equal(parcoursWindowsForAttribution([{ t: 1, cadence: 120, speed: 100, producedFps: 60, newFps: 60, presents: 60, viRate: 60 }])[0].vis, 60);
});

test("a negative cause counter never gives a negative part", () => {
  const d = attributeSecond(second(0, { speed: 80, produced: 48, shown: 48, presents: 48, causes: { jit: 300, disc: -200 } }), { cadence: 60 });
  assert.ok(Object.values(d.parts).every((f) => f > 0), JSON.stringify(d.parts));
  assert.ok(Math.abs(allParts(d) - 12) < 0.05);
  assert.equal(d.parts["emulation:disc"], undefined);
});

test("drop-meter windows: --display required, shown from the distinct pictures, occupancy", () => {
  const windows = [{ t0: 0, label: "race", speed: 100, presents: 3, xfb: 6, sleptMs: 70, gpuWorkMs: 95, causes: { jit: 0, workerPause: 0, mainPause: 5 } }];
  const presents = [{ t: 10 }, { t: 30 }, { t: 90 }];
  const vi = [{ t: 35, sinceBoot: 1 }, { t: 52, sinceBoot: 2 }, { t: 69, sinceBoot: 3 }];
  const displayed = [{ t: 12, vi: 1, submits: 1 }, { t: 28, vi: 1, submits: 1 }, { t: 45, vi: 2, submits: 1 }, { t: 95, vi: 3, submits: 0 }];
  const ws = dropWindowsForAttribution(windows, { presents, vi, displayed });
  const [w] = ws;
  assert.equal(w.shown, 2, "a repeated picture and one never submitted are not new");
  assert.deepEqual(w.gaps, [{ ms: 20, vis: 0, workerLagMs: 0 }, { ms: 60, vis: 3, workerLagMs: 0 }]);
  assert.deepEqual(w.occupancy, { cpu: 0.3, gpu: 0.95, replay: null });
  assert.equal(w.mainLagMs, 5);
  assert.ok(ws.beat.reason, "too short to measure a refresh: no beat");
  assert.throws(() => dropWindowsForAttribution(windows, { presents, vi }), /--display/);
});

test("parcours rows: measured gap VIs only, never estimated", () => {
  const rows = [{ t: 1, phase: "race", cadence: 60, speed: 100, producedFps: 60, newFps: 57, presents: 3, viRate: 60, cpuBusy: 0.3, gpuBusy: 0.2, replayBusy: 0.1 }];
  const raw = { samples: [{ presents: [1000] }, { presents: [1017, 1050, 1067] }] };
  const [w] = parcoursWindowsForAttribution(rows, raw);
  assert.deepEqual(w.gaps, [{ ms: 17, vis: null, workerLagMs: null }, { ms: 33, vis: null, workerLagMs: null }, { ms: 17, vis: null, workerLagMs: null }]);
  assert.deepEqual(w.occupancy, { cpu: 0.3, gpu: 0.2, replay: 0.1 });
  const measured = { samples: [{ presents: [1000] }, { presents: [1017, 1050], gapVis: [1, 2], gapWorkerLagMs: [0, 30] }] };
  assert.deepEqual(parcoursWindowsForAttribution(rows, measured)[0].gaps, [{ ms: 17, vis: 1, workerLagMs: 0 }, { ms: 33, vis: 2, workerLagMs: 30 }]);
  const r = attributeDips(parcoursWindowsForAttribution(rows, raw), {});
  assert.ok(r.hitches.every((h) => h.cause === "unknown"));
});

test("drop-meter: --attribute without --analyze is an error", () => {
  const probe = new URL("../harness/probes/drop-meter.mjs", import.meta.url).pathname;
  const res = spawnSync(process.execPath, [probe, "--attribute", "--iso", "/nonexistent.iso"], { encoding: "utf8", timeout: 20000 });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /--attribute works on recorded runs/);
});
