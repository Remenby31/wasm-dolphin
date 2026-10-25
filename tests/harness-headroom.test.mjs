// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { consistentHeadroomRead, decodeHeadroomStats, headroomOf, invalidReasons, pacingExpectation, querySpeed, unlimitedAllowed } from "../harness/lib/headroom.mjs";

function hrBytes(v = {}) {
  const view = new DataView(new ArrayBuffer(96));
  view.setUint32(0, v.version ?? 1, true);
  view.setUint32(4, v.size ?? 96, true);
  view.setUint32(8, v.on ?? 1, true);
  [v.windowUs ?? 0, v.cpuSleepUs ?? 0, v.gpuWorkUs ?? 0, v.xfbCopies ?? 0, v.rushSkips ?? 0, v.flushGpuWaitUs ?? 0, v.flushGpuWaits ?? 0, v.gpuConsumerWaitUs ?? 0, v.guestTicks ?? 0, v.presentSleepUs ?? 0].forEach((x, i) => view.setFloat64(16 + 8 * i, x, true));
  return Array.from(new Uint8Array(view.buffer));
}

test("headroom: Dolphin's Max on the CPU thread, the GPU bound, the smaller one", () => {
  // 10 s of host time at speed=1: 4 s asleep in the throttle, 1 s waiting on the GPU, the GPU busy 3 s.
  const s = decodeHeadroomStats(hrBytes({ windowUs: 10e6, cpuSleepUs: 4e6, gpuWorkUs: 3e6, xfbCopies: 300, rushSkips: 2, flushGpuWaitUs: 1e6, flushGpuWaits: 40 }));
  const h = headroomOf(s, { guestSeconds: 10, viOutputs: 600 });
  assert.equal(h.speed, 1);
  assert.equal(h.maxSpeedCpu, 2); // 10 guest s / (10 - 4 - 1) host s
  assert.equal(h.maxSpeedGpu, 3.3333);
  assert.equal(h.headroom, 2);
  assert.equal(h.headroomApplies, true);
  assert.equal(h.throttleSleepShare, 0.4);
  assert.equal(h.xfbCopiesPerVi, 0.5);
  assert.equal(h.gameFramesPerSecond, 30); // 300 XFB copies over 10 host s
  // The GPU as the bound.
  assert.equal(headroomOf(decodeHeadroomStats(hrBytes({ windowUs: 10e6, cpuSleepUs: 6e6, gpuWorkUs: 8e6 })), { guestSeconds: 10 }).headroom, 1.25);
  // Below 100 %: no sleep, the speed is the number.
  assert.equal(headroomOf(decodeHeadroomStats(hrBytes({ windowUs: 10e6, cpuSleepUs: 0, gpuWorkUs: 2e6 })), { guestSeconds: 9 }).headroomApplies, false);
  assert.match(decodeHeadroomStats(hrBytes({ version: 2 })).error, /layout version 2/);
  assert.match(decodeHeadroomStats(hrBytes({ windowUs: 1e6, cpuSleepUs: 2e6 })).error, /CPU waits/);
  assert.match(consistentHeadroomRead(s, decodeHeadroomStats(hrBytes({ windowUs: 1, cpuSleepUs: 0 }))).error, /torn read/);
  assert.match(headroomOf(decodeHeadroomStats(hrBytes({ on: 0 })), { guestSeconds: 1 }).error, /not on/);
});

test("headroom: waiting on the render worker is not GPU work; guest time from the core's own ticks", () => {
  // GPU passes 5 s, 2 s of which waiting for ring space: 3 s of work.
  const s = decodeHeadroomStats(hrBytes({ windowUs: 10e6, cpuSleepUs: 4e6, gpuWorkUs: 5e6, gpuConsumerWaitUs: 2e6, guestTicks: 4860e6 }));
  const h = headroomOf(s, { guestSeconds: 99, ticksPerSecond: 486e6 });
  assert.equal(h.guestSeconds, 10); // guestTicks / tps wins over the harness's reads
  assert.equal(h.maxSpeedGpu, 3.3333);
  assert.equal(h.gpuConsumerWaitShare, 0.2);
  // An older v1 struct without guestTicks: the harness's guest seconds.
  assert.equal(headroomOf(decodeHeadroomStats(hrBytes({ windowUs: 10e6, cpuSleepUs: 4e6, gpuWorkUs: 3e6 })), { guestSeconds: 9, ticksPerSecond: 486e6 }).guestSeconds, 9);
});

test("headroom: the video thread sleeping until the VI's host time is not GPU work (0153)", () => {
  // Heavy with Rush (deep-gpu-cost-amplifier.md): GPU passes 1.7 s per 10 s, 1.15 s of which asleep in
  // SmoothEarlyPresentation, 0.05 s waiting for ring space: 0.5 s of work.
  const s = decodeHeadroomStats(hrBytes({ windowUs: 10e6, cpuSleepUs: 2.5e6, gpuWorkUs: 1.7e6, gpuConsumerWaitUs: 0.05e6, presentSleepUs: 1.15e6 }));
  const h = headroomOf(s, { guestSeconds: 10 });
  assert.equal(h.maxSpeedGpu, 20); // 10 / (1.7 - 0.05 - 1.15); without the field it read 10 / 1.65 = 6.06
  assert.equal(h.presentSleepShare, 0.115);
  assert.equal(h.gpuBusyShare, 0.05);
  // 0 on a core that does not measure it (before 0153): the old bound, unchanged.
  const old = headroomOf(decodeHeadroomStats(hrBytes({ windowUs: 10e6, cpuSleepUs: 2.5e6, gpuWorkUs: 1.7e6, gpuConsumerWaitUs: 0.05e6 })), { guestSeconds: 10 });
  assert.equal(old.maxSpeedGpu, 6.0606);
  assert.equal(old.presentSleepShare, 0);
  // GPU waits beyond the GPU passes: a broken struct.
  assert.match(decodeHeadroomStats(hrBytes({ windowUs: 10e6, gpuWorkUs: 1e6, presentSleepUs: 2e6 })).error, /GPU waits/);
  // A torn read on the new field too.
  assert.match(consistentHeadroomRead(s, decodeHeadroomStats(hrBytes({ windowUs: 11e6, cpuSleepUs: 2.5e6, gpuWorkUs: 1.8e6, gpuConsumerWaitUs: 0.05e6, presentSleepUs: 1e6 }))).error, /presentSleepUs went backwards/);
});

test("validity: ring overflow, speed above its target, no unique image, game frames per VI off the reference", () => {
  assert.deepEqual(invalidReasons({ complete: true, timelineLost: { vi: 0, presents: 0 }, speed: 100 }, { target: 1 }), []);
  assert.match(invalidReasons({ complete: false, timelineLost: { vi: 6190, presents: 0 }, speed: 1650 }, {})[0], /ring overflowed: 6190 VI/);
  assert.match(invalidReasons({ complete: true, speed: 170 }, { target: 1.6 })[0], /above the target 160 %/);
  assert.deepEqual(invalidReasons({ complete: true, speed: 160 }, { target: 1.6 }), []);
  // A frozen renderer: nothing presented, no game frame; uniqueShare is null, not 0.
  const frozen = { complete: true, speed: 160.1, uniqueFrames: { ok: true, windowMs: 8004, presents: 0, compared: 0, uniqueShare: null }, headroom: { xfbCopiesPerVi: 0 } };
  assert.deepEqual(invalidReasons(frozen, { target: 1.6 }), ["no present in the unique-frames window (rendering frozen)", "no game frame (XFB copy) in the window (rendering frozen)"]);
  assert.deepEqual(invalidReasons({ complete: true, speed: 100, uniqueFrames: { ok: true, windowMs: 8000, presents: 480, uniqueShare: 0.25 }, headroom: { xfbCopiesPerVi: 1 } }, { target: 1 }), []);
  assert.match(invalidReasons({ complete: true, uniqueFrames: { uniqueShare: 0 } })[0], /no unique image/);
  assert.match(invalidReasons({ complete: true, headroom: { xfbCopiesPerVi: 0.2 } }, { framesPerViRef: 0.48 })[0], /outside ±10 % of 0.48/);
  assert.deepEqual(invalidReasons({ complete: true, headroom: { xfbCopiesPerVi: 0.5 } }, { framesPerViRef: 0.48 }), []);
  assert.equal(querySpeed("video=software&speed=1.6"), 1.6);
  assert.equal(querySpeed("video=software"), 1);
  assert.equal(querySpeed("speed=unlimited"), "unlimited");
  assert.equal(unlimitedAllowed("speed=unlimited&synconidle=1"), true);
  assert.equal(unlimitedAllowed("speed=unlimited"), false);
  // video=null renders nothing to run ahead of (the CI bench).
  assert.equal(unlimitedAllowed("video=null&speed=unlimited"), true);
});

test("speed=unlimited with a renderer: the core's pacing config must be what the side claims (0150)", () => {
  assert.equal(pacingExpectation("video=wgpu&speed=unlimited&synconidle=1"), "sync");
  assert.equal(pacingExpectation("video=null&speed=unlimited&synconidle=1"), null);
  assert.equal(pacingExpectation("video=wgpu&speed=1"), null);
  assert.equal(pacingExpectation("video=wgpu&speed=unlimited", { decoupledUnlimited: true }), "decoupled");
  assert.equal(pacingExpectation("video=wgpu&speed=unlimited&synconidle=1", { decoupledUnlimited: true }), "sync");
  assert.equal(unlimitedAllowed("video=wgpu&speed=unlimited"), false);
  assert.equal(unlimitedAllowed("video=wgpu&speed=unlimited", { decoupledUnlimited: true }), true);
  const rec = (pacingConfig) => ({ complete: true, headroom: { xfbCopiesPerVi: 1 }, ...(pacingConfig === undefined ? {} : { pacingConfig }) });
  const on = { supported: true, syncOnSkipIdle: true, rushFramePresentation: true, dupXfbResetsThrottle: false };
  const off = { ...on, syncOnSkipIdle: false };
  assert.deepEqual(invalidReasons(rec(on), { pacing: "sync" }), []);
  assert.deepEqual(invalidReasons(rec(off), { pacing: "decoupled" }), []);
  // The URL asked for it, the core did not apply it (2026-10-24: ?synconidle was ignored).
  assert.match(invalidReasons(rec(off), { pacing: "sync" })[0], /SyncOnSkipIdle not applied by the core \(syncOnSkipIdle false\)/);
  // Labelled decoupled, the core synchronises: not the measurement it claims.
  assert.match(invalidReasons(rec(on), { pacing: "decoupled" })[0], /--decoupled-unlimited: the core does not read SyncOnSkipIdle off/);
  // A core without the readback (before 0150) ignores ?synconidle: never "sync",
  // decoupled by construction (idle et timing, 2026-10-24).
  assert.match(invalidReasons(rec({ supported: false }), { pacing: "sync" })[0], /no validationReadPacingConfig/);
  assert.deepEqual(invalidReasons(rec({ supported: false }), { pacing: "decoupled" }), []);
  // A failed read or no read at all: never valid either way.
  for (const pacing of ["sync", "decoupled"]) {
    assert.match(invalidReasons(rec({ error: "timeout" }), { pacing })[0], /\(timeout\)/);
    assert.equal(invalidReasons(rec(undefined), { pacing }).length, 1);
  }
  // Nothing asked: nothing changes.
  assert.deepEqual(invalidReasons(rec(undefined)), []);
});

test("race-perf refuses speed=unlimited while SyncOnSkipIdle is off", () => {
  // Any existing files stand for the disc and the savestate: the query is refused first.
  const here = path.resolve(import.meta.dirname, "harness-headroom.test.mjs");
  const r = spawnSync(process.execPath, [path.resolve(import.meta.dirname, "../harness/probes/race-perf.mjs"), "--iso", here, "--state", here, "--port", "1", "--query", "core=upstream&speed=unlimited"], {
    encoding: "utf8", timeout: 20000,
    // Outside CI: there a stand-in disc is refused as local-only before the query is read.
    env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "CI"))
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /speed=unlimited without synconidle=1/);
});

test("race-perf --decoupled-unlimited: the flag, its option, the summary's label", async () => {
  // No spawn past the guard: the next step would queue for the perf lock.
  const source = await readFile(path.resolve(import.meta.dirname, "../harness/probes/race-perf.mjs"), "utf8");
  assert.match(source, /"decoupled-unlimited": \{ type: "boolean", default: false \}/);
  assert.match(source, /decoupledUnlimited: values\["decoupled-unlimited"\] === true,/);
  assert.match(source, /\.\.\.\(o\.decoupledUnlimited \? \{ decoupledUnlimited: Object\.keys\(sides\)\.filter\(\(n\) => pacingExpectation\(/);
});
