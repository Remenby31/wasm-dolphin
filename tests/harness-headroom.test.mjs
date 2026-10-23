// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

import { consistentHeadroomRead, decodeHeadroomStats, headroomOf, invalidReasons, querySpeed, unlimitedAllowed } from "../harness/lib/headroom.mjs";

function hrBytes(v = {}) {
  const view = new DataView(new ArrayBuffer(96));
  view.setUint32(0, v.version ?? 1, true);
  view.setUint32(4, v.size ?? 96, true);
  view.setUint32(8, v.on ?? 1, true);
  [v.windowUs ?? 0, v.cpuSleepUs ?? 0, v.gpuWorkUs ?? 0, v.xfbCopies ?? 0, v.rushSkips ?? 0, v.flushGpuWaitUs ?? 0, v.flushGpuWaits ?? 0, v.gpuConsumerWaitUs ?? 0, v.guestTicks ?? 0].forEach((x, i) => view.setFloat64(16 + 8 * i, x, true));
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

test("validity: ring overflow, speed above its target, no unique image, game frames per VI off the reference", () => {
  assert.deepEqual(invalidReasons({ complete: true, timelineLost: { vi: 0, presents: 0 }, speed: 100 }, { target: 1 }), []);
  assert.match(invalidReasons({ complete: false, timelineLost: { vi: 6190, presents: 0 }, speed: 1650 }, {})[0], /ring overflowed: 6190 VI/);
  assert.match(invalidReasons({ complete: true, speed: 170 }, { target: 1.6 })[0], /above the target 160 %/);
  assert.deepEqual(invalidReasons({ complete: true, speed: 160 }, { target: 1.6 }), []);
  assert.match(invalidReasons({ complete: true, uniqueFrames: { uniqueShare: 0 } })[0], /no unique image/);
  assert.match(invalidReasons({ complete: true, headroom: { xfbCopiesPerVi: 0.2 } }, { framesPerViRef: 0.48 })[0], /outside ±10 % of 0.48/);
  assert.deepEqual(invalidReasons({ complete: true, headroom: { xfbCopiesPerVi: 0.5 } }, { framesPerViRef: 0.48 }), []);
  assert.equal(querySpeed("video=software&speed=1.6"), 1.6);
  assert.equal(querySpeed("video=software"), 1);
  assert.equal(querySpeed("speed=unlimited"), "unlimited");
  assert.equal(unlimitedAllowed("speed=unlimited&synconidle=1"), true);
  assert.equal(unlimitedAllowed("speed=unlimited"), false);
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
