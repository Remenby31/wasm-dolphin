import assert from "node:assert/strict";
import test from "node:test";

import { attributeDips, attributeSecond, attributionLines, dropWindowsForAttribution, markBeat } from "../harness/lib/drops.mjs";

// one second as 10 windows of 100 ms, the totals spread evenly
function second(t, { speed = 100, produced = 60, shown = 60, presents = 60, causes = {}, occupancy = null, gaps = [], phase = null, mainLagMs = 0, workerLagMs = 0 } = {}) {
  return Array.from({ length: 10 }, (_, i) => ({
    t: t + i * 100, ms: 100, phase, speed,
    produced: produced / 10, shown: shown / 10, presents: presents / 10,
    causes: Object.fromEntries(Object.entries(causes).map(([k, v]) => [k, v / 10])),
    occupancy, gaps: i === 0 ? gaps : [], mainLagMs: mainLagMs / 10, workerLagMs: workerLagMs / 10
  }));
}
const partsSum = (d) => Object.entries(d.parts).filter(([k]) => k !== "content").reduce((a, [, f]) => a + f, 0);

test("the parts of a second add up to its deficit (cadence − shown)", () => {
  for (const s of [
    { speed: 80, produced: 48, shown: 47, presents: 50, causes: { jit: 120 } },
    { produced: 60, shown: 52, presents: 54 },
    { produced: 45, shown: 40, presents: 45, occupancy: { cpu: 0.2, gpu: 0.95, replay: 0.3 } }
  ]) {
    const d = attributeSecond(second(0, s), { cadence: 60 });
    assert.ok(Math.abs(partsSum(d) - (60 - s.shown)) < 0.05, JSON.stringify(d.parts));
    assert.ok(Math.abs(d.lostFrames - (60 - s.shown)) < 0.05);
  }
});

test("a slow guest: the production gap goes to the counted causes, the rest unexplained", () => {
  // 80 %: 200 ms lost, 120 of them compiling; 12 frames not produced
  const d = attributeSecond(second(0, { speed: 80, produced: 48, shown: 48, presents: 48, causes: { jit: 120, disc: 20 } }), { cadence: 60 });
  assert.deepEqual(d.parts, { "emulation:jit": 7.2, "emulation:disc": 1.2, "emulation:unexplained": 3.6 });
});

test("full speed: a saturated thread is the game's own loss, a quiet one is the scene's content (not lost)", () => {
  const game = attributeSecond(second(0, { produced: 45, shown: 45, presents: 45, occupancy: { cpu: 0.3, gpu: 0.97, replay: 0.9 } }), { cadence: 60 });
  assert.deepEqual(game.parts, { "game:gpu+replay": 15 });
  const menu = attributeSecond(second(0, { produced: 30, shown: 30, presents: 60, occupancy: { cpu: 0.2, gpu: 0.2, replay: 0.1 } }), { cadence: 60 });
  assert.deepEqual(menu.parts, { content: 30 });
  assert.equal(menu.lostFrames, 0);
});

test("presentation: no presentation, an older picture, a presenter blocked while the core produced", () => {
  const pacing = attributeSecond(second(0, { produced: 60, shown: 52, presents: 54 }), { cadence: 60 });
  assert.deepEqual(pacing.parts, { "no-present": 6, "old-frame": 2 });
  // a 100 ms gap with 6 VIs produced during it, the worker late 80 ms: 5 frames blocked
  const blocked = attributeSecond(second(0, { produced: 60, shown: 52, presents: 54, gaps: [{ ms: 100, vis: 6, workerLagMs: 80 }] }), { cadence: 60 });
  assert.deepEqual(blocked.parts, { "presenter-blocked": 5, "no-present": 3 });
  // the same gap with the worker on time: plain no-present
  const late = attributeSecond(second(0, { produced: 60, shown: 52, presents: 54, gaps: [{ ms: 100, vis: 6, workerLagMs: 0 }] }), { cadence: 60 });
  assert.equal(late.parts["presenter-blocked"], undefined);
});

test("markers: a late page is main-stall, a late worker with no counted work is gc-probable", () => {
  const d = attributeSecond(second(0, { produced: 60, shown: 55, mainLagMs: 40, workerLagMs: 60 }), { cadence: 60 });
  assert.deepEqual(d.markers, ["main-stall", "gc-probable"]);
  const busy = attributeSecond(second(0, { speed: 90, produced: 54, shown: 54, workerLagMs: 60, causes: { jit: 80 } }), { cadence: 60 });
  assert.deepEqual(busy.markers, []);
  // a second without produced or shown is not judged
  assert.equal(attributeSecond([{ t: 0, ms: 1000, produced: null, shown: 60 }], { cadence: 60 }), null);
});

test("dips, the table ranked by frames, per phase", () => {
  const windows = [
    ...second(0, { phase: "race" }),
    ...second(1000, { phase: "race", produced: 60, shown: 52, presents: 54 }),
    ...second(2000, { phase: "race", speed: 80, produced: 48, shown: 48, presents: 48, causes: { jit: 200 } }),
    ...second(3000, { phase: "menu", produced: 30, shown: 30, presents: 60, occupancy: { cpu: 0.1, gpu: 0.1, replay: 0.1 } })
  ];
  const r = attributeDips(windows, { cadence: 60 });
  assert.equal(r.seconds, 4);
  assert.equal(r.dips.length, 3);
  const race = r.table.find((x) => x.phase === "race");
  assert.equal(race.dips, 2);
  assert.equal(race.lostFrames, 20);
  assert.deepEqual(race.ranked.map((x) => x.cause), ["emulation:jit", "no-present", "old-frame"]);
  assert.equal(race.ranked[0].share, 0.6);
  const menu = r.table.find((x) => x.phase === "menu");
  assert.equal(menu.lostFrames, 0);
  assert.equal(menu.contentFrames, 30);
  assert.ok(attributionLines(r).some((l) => /emulation:jit +12 frames +60\.0 %/.test(l)));
  assert.throws(() => attributeDips(windows, {}), /cadence/);
});

test("hitches over 25 ms: frames skipped, presenter-blocked when the core produced and the worker lagged", () => {
  const windows = [
    ...second(0, { produced: 60, shown: 55, presents: 56, gaps: [{ ms: 50, vis: 3, workerLagMs: 0 }] }),
    ...second(1000, { produced: 60, shown: 55, presents: 56, gaps: [{ ms: 67, vis: 4, workerLagMs: 60 }] })
  ];
  const r = attributeDips(windows, { cadence: 60 });
  assert.deepEqual(r.hitches.map((h) => [h.ms, h.frames, h.cause]), [[50, 2, "no-present"], [67, 3, "presenter-blocked"]]);
});

test("the beat: quiet no-present dips recurring every 1/|refresh − VI| move to beat; a lone one stays", () => {
  const P = 1000 / (60 - 59.94);
  const quiet = { produced: 60, shown: 56, presents: 56, occupancy: { cpu: 0.3, gpu: 0.3, replay: 0.2 } };
  const at = [0, 5000, Math.round(P), Math.round(2 * P)];
  const windows = at.flatMap((t) => second(t, quiet));
  const r = attributeDips(windows, { cadence: 60, refreshHz: 60, viHz: 59.94 });
  const byT = Object.fromEntries(r.dips.map((d) => [d.t, d.parts]));
  assert.deepEqual(byT[0], { beat: 4 });
  assert.deepEqual(byT[5000], { "no-present": 4 }, "no partner at a multiple of the period");
  assert.deepEqual(byT[Math.round(2 * P)], { beat: 4 });
  // without the rates, nothing moves
  assert.deepEqual(attributeDips(windows, { cadence: 60 }).dips[0].parts, { "no-present": 4 });
  assert.deepEqual(markBeat([], { refreshHz: 60, viHz: 60 }), []);
});

test("drop-meter windows: shown from the distinct pictures displayed, gaps with the VIs during them", () => {
  const windows = [{ t0: 0, label: "race", speed: 100, presents: 3, xfb: 6, causes: { jit: 0, workerPause: 0, mainPause: 5 } }];
  const presents = [{ t: 10 }, { t: 30 }, { t: 90 }];
  const vi = [{ t: 35 }, { t: 52 }, { t: 69 }];
  const displayed = [{ t: 12, vi: 1, submits: 1 }, { t: 28, vi: 1, submits: 1 }, { t: 45, vi: 2, submits: 1 }, { t: 95, vi: 3, submits: 0 }];
  const [w] = dropWindowsForAttribution(windows, { presents, vi, displayed });
  assert.equal(w.shown, 2, "a repeated picture and one never submitted are not new");
  assert.equal(w.produced, 6);
  assert.deepEqual(w.gaps, [{ ms: 20, vis: 0, workerLagMs: 0 }, { ms: 60, vis: 3, workerLagMs: 0 }]);
  assert.equal(w.mainLagMs, 5);
  assert.equal(w.phase, "race");
  assert.equal(dropWindowsForAttribution(windows, { presents, vi })[0].shown, null, "without --display: not judged");
});

test("full speed without occupancy data: the missing frames are the game's loss, never content", () => {
  const d = attributeSecond(second(0, { produced: 45, shown: 45, presents: 45 }), { cadence: 60 });
  assert.deepEqual(d.parts, { "game:unknown": 15 });
  assert.equal(d.lostFrames, 15);
});

test("a hitch's own cause: VIs kept coming (presentation) or not (the guest's counted cause)", async () => {
  const { hitchCause } = await import("../harness/lib/drops.mjs");
  const frameMs = 1000 / 60;
  assert.equal(hitchCause({ ms: 50, vis: 3 }, { causes: {} }, { frameMs }), "no-present");
  assert.equal(hitchCause({ ms: 50, vis: 3, workerLagMs: 40 }, {}, { frameMs }), "presenter-blocked");
  assert.equal(hitchCause({ ms: 100, vis: 1 }, { speed: 60, causes: { jit: 30, disc: 5 } }, { frameMs }), "emulation:jit");
  assert.equal(hitchCause({ ms: 100, vis: 1 }, { speed: 60, causes: {} }, { frameMs }), "emulation:unexplained");
});

test("drop-meter windows: occupancy from the CPU thread's sleep and the GPU thread's work", () => {
  const [w] = dropWindowsForAttribution([{ t0: 0, speed: 100, presents: 6, xfb: 6, sleptMs: 70, gpuWorkMs: 95, causes: {} }], {});
  assert.deepEqual(w.occupancy, { cpu: 0.3, gpu: 0.95, replay: null });
});

test("a cadence per window: a 30 fps scene loses nothing at 30, a 60 fps one is judged at 60", () => {
  const at = (w, cadence) => w.map((x) => ({ ...x, cadence }));
  const windows = [
    ...at(second(0, { phase: "menu", produced: 30, shown: 30, presents: 60, occupancy: { cpu: 0.95, gpu: 0.2, replay: 0.1 } }), 30),
    ...at(second(1000, { phase: "race", produced: 60, shown: 54, presents: 54 }), 60)
  ];
  const r = attributeDips(windows, {});
  assert.equal(r.dips.length, 1, "the 30 fps menu is not a dip, even saturated");
  assert.equal(r.dips[0].phase, "race");
  assert.deepEqual(r.dips[0].parts, { "no-present": 6 });
  // a second never spans two cadences
  const mixed = attributeDips([...at(second(0, { produced: 30, shown: 30 }).slice(0, 5), 30), ...at(second(500, { produced: 60, shown: 60 }).slice(5), 60)], {});
  assert.equal(mixed.seconds, 2);
  // opts.cadence is the default for windows without one; with neither: an error
  assert.equal(attributeDips(second(0, { produced: 54, shown: 54 }), { cadence: 60 }).dips.length, 1);
  assert.throws(() => attributeDips(second(0), {}), /window\.cadence/);
});

test("parcours rows as windows: the row's rates, its cadence and occupancy, gaps from the samples' presents", async () => {
  const { parcoursWindowsForAttribution, parcoursRates } = await import("../harness/lib/drops.mjs");
  const rows = [{ t: 1, phase: "race", cadence: 60, speed: 100, producedFps: 60, newFps: 57, presents: 3, viRate: 60, cpuBusy: 0.3, gpuBusy: 0.2, replayBusy: 0.1 }];
  const raw = { samples: [
    { presents: [1000], counters: { t: 1000, frame: 0 } },
    { presents: [1017, 1050, 1067], counters: { t: 2000, frame: 60 } }
  ] };
  const [w] = parcoursWindowsForAttribution(rows, raw);
  assert.deepEqual({ t: w.t, ms: w.ms, phase: w.phase, cadence: w.cadence, produced: w.produced, shown: w.shown, presents: w.presents }, { t: 0, ms: 1000, phase: "race", cadence: 60, produced: 60, shown: 57, presents: 3 });
  assert.deepEqual(w.occupancy, { cpu: 0.3, gpu: 0.2, replay: 0.1 });
  assert.deepEqual(w.gaps, [{ ms: 17, vis: 1 }, { ms: 33, vis: 2 }, { ms: 17, vis: 1 }], "the first gap from the previous sample's last present");
  assert.equal(parcoursWindowsForAttribution(rows)[0].gaps.length, 0, "without raw: no gaps");
  const rates = parcoursRates(raw);
  assert.equal(rates.viHz, 60);
  assert.ok(Math.abs(rates.refreshHz - 1000 / 17) < 0.01, "the median interval under 25 ms");
  assert.deepEqual(parcoursRates(null), { viHz: null, refreshHz: null });
});
