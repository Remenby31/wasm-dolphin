import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  clampShare,
  cpuThreadBusyShare,
  createOccupancyMeter,
  HEADROOM_LAYOUT_BYTES,
  readHeadroomCpu,
  replayBusyShare
} from "../src/occupancy-stats.js";
import { decodeHeadroomStats, headroomOf } from "../harness/lib/headroom.mjs";
import { UpstreamWorkerAdapter } from "../src/upstream-worker-adapter.js";

const worker = readFileSync(new URL("../src/upstream-discio-worker.js", import.meta.url), "utf8");
const host = readFileSync(new URL("../src/core-host.js", import.meta.url), "utf8");

// A 0113 v1 struct at byte 64 of a heap.
function heapWith({ on = 1, version = 1, size = 96, windowUs = 0, cpuSleepUs = 0, flushGpuWaitUs = 0, guestTicks = 0, gpuWorkUs = 0 } = {}) {
  const buffer = new ArrayBuffer(256);
  const ptr = 64;
  new Uint32Array(buffer, ptr, 4).set([version, size, on, 0]);
  const f = new Float64Array(buffer, ptr + 16, 10);
  f[0] = windowUs; f[1] = cpuSleepUs; f[2] = gpuWorkUs; f[5] = flushGpuWaitUs; f[8] = guestTicks;
  return { buffer, ptr };
}
const cpu = (windowUs, cpuSleepUs, flushGpuWaitUs = 0, guestTicks = windowUs * 486) => ({ on: true, windowUs, cpuSleepUs, flushGpuWaitUs, guestTicks });

test("clampShare: 0..1, null for an unusable span", () => {
  assert.equal(clampShare(250, 500), 0.5);
  assert.equal(clampShare(700, 500), 1);
  assert.equal(clampShare(-3, 500), 0);
  assert.equal(clampShare(1, 0), null);
  assert.equal(clampShare(NaN, 500), null);
  assert.equal(clampShare(1, null), null);
});

test("readHeadroomCpu reads the v1 struct, refuses another layout, says when off", () => {
  const { buffer, ptr } = heapWith({ windowUs: 1e6, cpuSleepUs: 4e5, flushGpuWaitUs: 1e4, guestTicks: 5e8 });
  assert.deepEqual(readHeadroomCpu(buffer, ptr), { on: true, windowUs: 1e6, cpuSleepUs: 4e5, flushGpuWaitUs: 1e4, guestTicks: 5e8 });
  assert.deepEqual(readHeadroomCpu(heapWith({ on: 0 }).buffer, 64), { on: false });
  assert.equal(readHeadroomCpu(heapWith({ version: 2 }).buffer, 64), null);
  assert.equal(readHeadroomCpu(heapWith({ size: 88 }).buffer, 64), null);
  assert.equal(readHeadroomCpu(heapWith({ windowUs: NaN }).buffer, 64), null);
  assert.equal(readHeadroomCpu(heapWith({ cpuSleepUs: -1 }).buffer, 64), null);
  assert.equal(readHeadroomCpu(buffer, 0), null, "no export / null pointer");
  assert.equal(readHeadroomCpu(buffer, 68), null, "not 8-aligned");
  assert.equal(readHeadroomCpu(buffer, 256 - HEADROOM_LAYOUT_BYTES + 8), null, "past the heap");
  assert.equal(readHeadroomCpu(null, 64), null);
});

test("cpuThreadBusyShare: the harness's busy definition, over the delta", () => {
  // 500 ms, 300 ms of throttle sleep, 50 ms waiting in FlushGpu: busy 150 ms
  assert.equal(cpuThreadBusyShare(cpu(1e6, 2e5, 1e4), cpu(1.5e6, 5e5, 6e4), 500), 0.3);
  // same as harness/lib/headroom.mjs over a window starting at a reset
  const { buffer, ptr } = heapWith({ windowUs: 5e5, cpuSleepUs: 3e5, flushGpuWaitUs: 5e4, guestTicks: 5e5 * 486 });
  const h = headroomOf(decodeHeadroomStats(Array.from(new Uint8Array(buffer, ptr, 96))), { ticksPerSecond: 486e6 });
  assert.equal(cpuThreadBusyShare(cpu(0, 0, 0, 0), readHeadroomCpu(buffer, ptr), 500), Math.round((1 - h.throttleSleepShare - h.flushGpuWaitShare) * 1000) / 1000);
  // no sleep at all: busy the whole window
  assert.equal(cpuThreadBusyShare(cpu(1e6, 2e5), cpu(1.5e6, 2e5), 500), 1);
  // sleep straddling the window's last update: clamped
  assert.equal(cpuThreadBusyShare(cpu(1e6, 2e5), cpu(1.5e6, 7.1e5), 500), 0);
});

test("cpuThreadBusyShare: a harness reset in between gives null, never a wrong share", () => {
  // the reset zeroed the counters: they went back
  assert.equal(cpuThreadBusyShare(cpu(9e6, 4e6), cpu(3e5, 1e5), 500), null);
  assert.equal(cpuThreadBusyShare(cpu(9e6, 4e6), cpu(9.4e6, 3e6), 500), null, "sleep back");
  assert.equal(cpuThreadBusyShare(cpu(9e6, 4e6, 2e5), cpu(9.4e6, 4.1e6, 1e5), 500), null, "FlushGpu wait back");
  assert.equal(cpuThreadBusyShare(cpu(9e6, 4e6, 0, 5e9), cpu(9.4e6, 4.1e6, 0, 4e9), 500), null, "ticks back");
  // reset 100 ms after a young window (200 ms): every counter is past the
  // previous read again, but the window grew by 200 ms over 500 ms of host
  assert.equal(cpuThreadBusyShare(cpu(2e5, 1e5), cpu(4e5, 2e5), 500), null);
  // the CPU thread did not throttle (paused): the window does not move
  assert.equal(cpuThreadBusyShare(cpu(2e6, 1e6), cpu(2e6, 1e6), 500), null);
});

test("cpuThreadBusyShare: missing or off counters give null", () => {
  assert.equal(cpuThreadBusyShare(null, cpu(1e6, 0), 500), null);
  assert.equal(cpuThreadBusyShare(cpu(1e6, 0), null, 500), null);
  assert.equal(cpuThreadBusyShare({ on: false }, cpu(1e6, 0), 500), null, "turned on during the window");
  assert.equal(cpuThreadBusyShare(cpu(1e6, 0), { on: false }, 500), null);
});

test("replayBusyShare: drain time over host time, null when not collected or back", () => {
  assert.equal(replayBusyShare(100, 300, 500), 0.4);
  assert.equal(replayBusyShare(100, 100, 500), 0);
  assert.equal(replayBusyShare(100, 900, 500), 1);
  assert.equal(replayBusyShare(null, 300, 500), null);
  assert.equal(replayBusyShare(100, null, 500), null);
  assert.equal(replayBusyShare(300, 100, 500), null);
  assert.equal(replayBusyShare(100, 300, 0), null);
});

test("the meter: null on the first window and after a reset, then the shares of each span", () => {
  const m = createOccupancyMeter();
  assert.deepEqual(m.window({ atMs: 1000, cpu: cpu(1e6, 5e5), drainMs: 10 }), { cpuThreadBusy: null, replayBusy: null });
  assert.deepEqual(m.window({ atMs: 1500, cpu: cpu(1.5e6, 8e5), drainMs: 110 }), { cpuThreadBusy: 0.4, replayBusy: 0.2 });
  assert.deepEqual(m.window({ atMs: 2000, cpu: null, drainMs: null }), { cpuThreadBusy: null, replayBusy: null });
  assert.deepEqual(m.window({ atMs: 2500, cpu: cpu(2.5e6, 1e6), drainMs: 160 }), { cpuThreadBusy: null, replayBusy: null });
  m.reset();
  assert.deepEqual(m.window({ atMs: 3000, cpu: cpu(3e6, 1e6), drainMs: 170 }), { cpuThreadBusy: null, replayBusy: null });
  assert.deepEqual(m.window({ atMs: 3500, cpu: cpu(3.5e6, 1.25e6), drainMs: 220 }), { cpuThreadBusy: 0.5, replayBusy: 0.1 });
});

test("the worker reads the counters once per window, turns the headroom counters on once, never resets them under the harness", () => {
  assert.match(worker, /import \{ createOccupancyMeter, readHeadroomCpu \} from "\.\/occupancy-stats\.js";/);
  const fps = worker.slice(worker.indexOf("function updatePresentationFps()"), worker.indexOf("function readOccupancyCounters()"));
  assert.match(fps, /\(\{ newFramesPerSec, newFramesProducedPerSec \} = wgpuNewFrames\.window\(profileElapsedMs\)\);\n\s+\(\{ cpuThreadBusy, replayBusy \} = occupancyMeter\.window\(\{ atMs: now, \.\.\.readOccupancyCounters\(\) \}\)\);/);
  const read = worker.slice(worker.indexOf("function readOccupancyCounters()"), worker.indexOf("function checkBootStallWatchdog()"));
  // read only (-1); a reset (0) only while off, once per core
  assert.match(read, /readHeadroomCpu\(m\.HEAPU8\.buffer, stats\(-1\) >>> 0\)/);
  assert.match(read, /if \(cpu\?\.on === false && occupancyHeadroomModule !== m\) \{\n\s+stats\(0\);\n\s+occupancyHeadroomModule = m;/);
  assert.equal(read.match(/stats\(/g).length, 2);
  // product path: no harness gate
  assert.doesNotMatch(read, /harnessEnabled/);
  // the replay's drain time only while collected
  assert.match(read, /\(causalMetricsEnabled \|\| wgpuReplayBudgetMs > 0\)\n\s+\? webGpuCausalStats\.drainTotalMs \+ occupancyRemapMs\(\)\n\s+: null;/);
  // The pool's remap callbacks (getMappedRange) run outside any drain: counted, across pools.
  const remap = worker.slice(worker.indexOf("function occupancyRemapMs()"), worker.indexOf("function readOccupancyCounters()"));
  assert.match(remap, /occupancyRemapBaseMs \+= occupancyRemapPool\?\.remapCallbackTotalMs\?\.\(\) \?\? 0;/);
  assert.match(remap, /return occupancyRemapBaseMs \+ pool\.remapCallbackTotalMs\(\);/);
  // collected by finishWebGpuDrain under the same condition
  const finish = worker.slice(worker.indexOf("function finishWebGpuDrain("), worker.indexOf("async function startPipelinePrewarm("));
  assert.match(finish, /const collectReplayMetrics = causalMetricsEnabled \|\| wgpuReplayBudgetMs > 0;/);
  assert.match(finish, /webGpuCausalStats\.drainTotalMs \+= elapsed;/);
  // reset at boot, sent with the frame stats
  const reset = worker.slice(worker.indexOf("function resetPresentationBuffer()"), worker.indexOf("function readDetailedCoreStat("));
  assert.match(reset, /occupancyMeter\.reset\(\);\n\s+cpuThreadBusy = null;\n\s+replayBusy = null;/);
  for (const field of ["cpuThreadBusy,", "replayBusy,"]) assert.ok(worker.includes(`    ${field}\n`), field);
});

test("the adapter keeps the occupancy fields, null included", () => {
  const adapter = new UpstreamWorkerAdapter();
  assert.deepEqual([adapter.cpuThreadBusy, adapter.replayBusy], [null, null]);
  adapter.applyFrame({ frame: 10, cpuThreadBusy: 0.42, replayBusy: 0.1 });
  assert.deepEqual([adapter.cpuThreadBusy, adapter.replayBusy], [0.42, 0.1]);
  adapter.applyFrame({ frame: 11, cpuThreadBusy: null, replayBusy: null });
  assert.deepEqual([adapter.cpuThreadBusy, adapter.replayBusy], [null, null]);
  // an older worker does not send them: nothing changes
  adapter.applyFrame({ frame: 12, cpuThreadBusy: 0.5 });
  adapter.applyFrame({ frame: 13 });
  assert.deepEqual([adapter.cpuThreadBusy, adapter.replayBusy], [0.5, null]);
});

test("core-host passes the occupancy fields to onFrame", () => {
  for (const field of ["cpuThreadBusy", "replayBusy"])
    assert.match(host, new RegExp(`${field}: this\\.mode === "dolphin" \\? this\\.adapter\\.${field} \\?\\? null : null,`), field);
});
