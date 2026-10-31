import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  clampShare,
  cpuThreadBusyShare,
  createBusyClock,
  createOccupancyMeter,
  gpuThreadBusyShare,
  HEADROOM_LAYOUT_BYTES,
  readHeadroomStats,
  replayBusyShare
} from "../src/occupancy-stats.js";
import { decodeHeadroomStats, headroomOf } from "../harness/lib/headroom.mjs";
import { UpstreamWorkerAdapter } from "../src/upstream-worker-adapter.js";

const worker = readFileSync(new URL("../src/upstream-discio-worker.js", import.meta.url), "utf8");
const host = readFileSync(new URL("../src/core-host.js", import.meta.url), "utf8");

// A 0113 v1 struct at byte 64 of a heap.
function heapWith({ on = 1, version = 1, size = 96, windowUs = 0, cpuSleepUs = 0, flushGpuWaitUs = 0, guestTicks = 0, gpuWorkUs = 0, gpuConsumerWaitUs = 0, presentSleepUs = 0 } = {}) {
  const buffer = new ArrayBuffer(256);
  const ptr = 64;
  new Uint32Array(buffer, ptr, 4).set([version, size, on, 0]);
  const f = new Float64Array(buffer, ptr + 16, 10);
  f[0] = windowUs; f[1] = cpuSleepUs; f[2] = gpuWorkUs; f[5] = flushGpuWaitUs; f[7] = gpuConsumerWaitUs; f[8] = guestTicks; f[9] = presentSleepUs;
  return { buffer, ptr };
}
const cpu = (windowUs, cpuSleepUs, flushGpuWaitUs = 0, guestTicks = windowUs * 486) => ({ on: true, windowUs, cpuSleepUs, flushGpuWaitUs, guestTicks, gpuWorkUs: 0, gpuConsumerWaitUs: 0, presentSleepUs: 0 });
// windowUs plus the GPU thread's counters
const gpu = (windowUs, gpuWorkUs, gpuConsumerWaitUs = 0, presentSleepUs = 0) => ({ ...cpu(windowUs, 0), gpuWorkUs, gpuConsumerWaitUs, presentSleepUs });

test("clampShare: 0..1, null for an unusable span", () => {
  assert.equal(clampShare(250, 500), 0.5);
  assert.equal(clampShare(700, 500), 1);
  assert.equal(clampShare(-3, 500), 0);
  assert.equal(clampShare(1, 0), null);
  assert.equal(clampShare(NaN, 500), null);
  assert.equal(clampShare(1, null), null);
});

test("readHeadroomStats reads the v1 struct, refuses another layout, says when off", () => {
  const { buffer, ptr } = heapWith({ windowUs: 1e6, cpuSleepUs: 4e5, flushGpuWaitUs: 1e4, guestTicks: 5e8, gpuWorkUs: 6e5, gpuConsumerWaitUs: 1e5, presentSleepUs: 2e5 });
  assert.deepEqual(readHeadroomStats(buffer, ptr), { on: true, windowUs: 1e6, cpuSleepUs: 4e5, flushGpuWaitUs: 1e4, guestTicks: 5e8, gpuWorkUs: 6e5, gpuConsumerWaitUs: 1e5, presentSleepUs: 2e5 });
  assert.deepEqual(readHeadroomStats(heapWith({ on: 0 }).buffer, 64), { on: false });
  assert.equal(readHeadroomStats(heapWith({ version: 2 }).buffer, 64), null);
  assert.equal(readHeadroomStats(heapWith({ size: 88 }).buffer, 64), null);
  assert.equal(readHeadroomStats(heapWith({ windowUs: NaN }).buffer, 64), null);
  assert.equal(readHeadroomStats(heapWith({ cpuSleepUs: -1 }).buffer, 64), null);
  assert.equal(readHeadroomStats(buffer, 0), null, "no export / null pointer");
  assert.equal(readHeadroomStats(buffer, 68), null, "not 8-aligned");
  assert.equal(readHeadroomStats(buffer, 256 - HEADROOM_LAYOUT_BYTES + 8), null, "past the heap");
  assert.equal(readHeadroomStats(null, 64), null);
});

test("cpuThreadBusyShare: the harness's busy definition, over the delta", () => {
  // 500 ms, 300 ms of throttle sleep, 50 ms waiting in FlushGpu: busy 150 ms
  assert.equal(cpuThreadBusyShare(cpu(1e6, 2e5, 1e4), cpu(1.5e6, 5e5, 6e4), 500), 0.3);
  // same as harness/lib/headroom.mjs over a window starting at a reset
  const { buffer, ptr } = heapWith({ windowUs: 5e5, cpuSleepUs: 3e5, flushGpuWaitUs: 5e4, guestTicks: 5e5 * 486 });
  const h = headroomOf(decodeHeadroomStats(Array.from(new Uint8Array(buffer, ptr, 96))), { ticksPerSecond: 486e6 });
  assert.equal(cpuThreadBusyShare(cpu(0, 0, 0, 0), readHeadroomStats(buffer, ptr), 500), Math.round((1 - h.throttleSleepShare - h.flushGpuWaitShare) * 1000) / 1000);
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

test("gpuThreadBusyShare: the harness's GPU work (work - consumer wait - present sleep) over the CPU window", () => {
  // 500 ms window, 400 ms of GPU passes, 50 waiting for the render worker, 100 sleeping to present
  assert.equal(gpuThreadBusyShare(gpu(1e6, 2e5, 1e4, 1e4), gpu(1.5e6, 6e5, 6e4, 1.1e5), 500), 0.5);
  // the harness's gpuBusyShare over a window from a reset
  const { buffer, ptr } = heapWith({ windowUs: 5e5, guestTicks: 5e5 * 486, gpuWorkUs: 4.5e5, gpuConsumerWaitUs: 5e4, presentSleepUs: 1e5 });
  const h = headroomOf(decodeHeadroomStats(Array.from(new Uint8Array(buffer, ptr, 96))), { ticksPerSecond: 486e6 });
  assert.equal(gpuThreadBusyShare(gpu(0, 0), readHeadroomStats(buffer, ptr), 500), h.gpuBusyShare);
  // saturated GPU thread while the CPU thread sleeps (SyncOnSkipIdle off): CPU looks free, GPU says no
  const a = { ...gpu(1e6, 1e6), cpuSleepUs: 7e5 }, b = { ...gpu(1.5e6, 1.5e6), cpuSleepUs: 1.05e6 };
  assert.equal(cpuThreadBusyShare(a, b, 500), 0.3);
  assert.equal(gpuThreadBusyShare(a, b, 500), 1);
  // clamped
  assert.equal(gpuThreadBusyShare(gpu(1e6, 0), gpu(1.5e6, 6e5), 500), 1);
});

test("gpuThreadBusyShare: null for a GPU loop that does not run, a reset, missing counters", () => {
  // deterministic GPU thread (or single core): no GPU work counted
  assert.equal(gpuThreadBusyShare(gpu(1e6, 0), gpu(1.5e6, 0), 500), null);
  assert.equal(gpuThreadBusyShare(gpu(1e6, 3e5), gpu(1.5e6, 3e5), 500), null, "no pass with work in the window");
  // the CPU thread applied a reset: its counters went back
  assert.equal(gpuThreadBusyShare(gpu(9e6, 4e6), gpu(3e5, 4.2e6), 500), null);
  // the GPU thread zeroed its own one read later
  assert.equal(gpuThreadBusyShare(gpu(3e5, 4e6), gpu(8e5, 2e5), 500), null);
  assert.equal(gpuThreadBusyShare(gpu(1e6, 2e5, 1e5), gpu(1.5e6, 4e5, 0), 500), null, "consumer wait back");
  assert.equal(gpuThreadBusyShare(gpu(1e6, 2e5, 0, 1e5), gpu(1.5e6, 4e5, 0, 0), 500), null, "present sleep back");
  assert.equal(gpuThreadBusyShare(gpu(2e5, 1e5), gpu(4e5, 3e5), 500), null, "window grew by far less than the host time");
  assert.equal(gpuThreadBusyShare(null, gpu(1e6, 1e5), 500), null);
  assert.equal(gpuThreadBusyShare({ on: false }, gpu(1e6, 1e5), 500), null);
});

test("the busy clock: outermost run only, in-progress time included, never back", () => {
  let t = 0;
  const clock = createBusyClock(() => t);
  assert.equal(clock.run(() => { t += 3; return 7; }), 7);
  assert.equal(clock.totalMs(), 3);
  // a drain inside the loop counts once
  clock.run(() => { t += 1; clock.run(() => { t += 2; }); t += 1; });
  assert.equal(clock.totalMs(), 7);
  // read inside a run: the run so far, then the whole run once it ends
  clock.run(() => { t += 2; assert.equal(clock.totalMs(), 9); t += 2; });
  assert.equal(clock.totalMs(), 11);
  // a throw still stops the clock; args pass through
  assert.throws(() => clock.run(() => { t += 1; throw new Error("x"); }));
  assert.equal(clock.totalMs(), 12);
  assert.equal(clock.run((a, b) => a + b, 2, 3), 5);
  t += 100;
  assert.equal(clock.totalMs(), 12, "idle time is not busy");
  // async: only the synchronous part
  clock.run(async () => { t += 1; await null; t += 50; });
  assert.equal(clock.totalMs(), 13);
});

test("replayBusyShare: busy time over host time, null when not collected or back", () => {
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
  const none = { cpuThreadBusy: null, gpuThreadBusy: null, replayBusy: null };
  const h = (w, sleep, work) => ({ ...cpu(w, sleep), gpuWorkUs: work });
  assert.deepEqual(m.window({ atMs: 1000, headroom: h(1e6, 5e5, 1e5), busyMs: 10 }), none);
  assert.deepEqual(m.window({ atMs: 1500, headroom: h(1.5e6, 8e5, 4e5), busyMs: 110 }), { cpuThreadBusy: 0.4, gpuThreadBusy: 0.6, replayBusy: 0.2 });
  assert.deepEqual(m.window({ atMs: 2000, headroom: null, busyMs: null }), none);
  assert.deepEqual(m.window({ atMs: 2500, headroom: h(2.5e6, 1e6, 6e5), busyMs: 160 }), none);
  m.reset();
  assert.deepEqual(m.window({ atMs: 3000, headroom: h(3e6, 1e6, 7e5), busyMs: 170 }), none);
  assert.deepEqual(m.window({ atMs: 3500, headroom: h(3.5e6, 1.25e6, 7e5), busyMs: 220 }), { cpuThreadBusy: 0.5, gpuThreadBusy: null, replayBusy: 0.1 });
});

test("the worker reads the counters once per window, turns the headroom counters on once, never resets them under the harness", () => {
  assert.match(worker, /import \{ createBusyClock, createOccupancyMeter, readHeadroomStats \} from "\.\/occupancy-stats\.js";/);
  const fps = worker.slice(worker.indexOf("function updatePresentationFps()"), worker.indexOf("function readOccupancyCounters()"));
  assert.match(fps, /\(\{ newFramesPerSec, newFramesProducedPerSec \} = wgpuNewFrames\.window\(profileElapsedMs\)\);\n\s+\(\{ cpuThreadBusy, gpuThreadBusy, replayBusy \} = occupancyMeter\.window\(\{ atMs: now, \.\.\.readOccupancyCounters\(\) \}\)\);/);
  const read = worker.slice(worker.indexOf("function readOccupancyCounters()"), worker.indexOf("function checkBootStallWatchdog()"));
  // read only (-1); a reset (0) only while off, once per core
  assert.match(read, /readHeadroomStats\(m\.HEAPU8\.buffer, stats\(-1\) >>> 0\)/);
  assert.match(read, /if \(headroom\?\.on === false && occupancyHeadroomModule !== m\) \{\n\s+stats\(0\);\n\s+occupancyHeadroomModule = m;/);
  assert.equal(read.match(/stats\(/g).length, 2);
  // product path: no harness gate
  assert.doesNotMatch(read, /harnessEnabled/);
  // the worker's busy time: the clock plus the pool's remap callbacks, with a WebGPU replay
  assert.match(read, /const busyMs = webGpuCmdRing && renderGpu && !wgpuReplayFatal\n\s+\? workerBusy\.totalMs\(\) \+ occupancyRemapMs\(\)\n\s+: null;/);
  // The pool's remap callbacks (getMappedRange) run outside any drain: counted, across pools.
  const remap = worker.slice(worker.indexOf("function occupancyRemapMs()"), worker.indexOf("function readOccupancyCounters()"));
  assert.match(remap, /occupancyRemapBaseMs \+= occupancyRemapPool\?\.remapCallbackTotalMs\?\.\(\) \?\? 0;/);
  assert.match(remap, /return occupancyRemapBaseMs \+ pool\.remapCallbackTotalMs\(\);/);
  // reset at boot, sent with the frame stats
  const reset = worker.slice(worker.indexOf("function resetPresentationBuffer()"), worker.indexOf("function readDetailedCoreStat("));
  assert.match(reset, /occupancyMeter\.reset\(\);\n\s+cpuThreadBusy = null;\n\s+gpuThreadBusy = null;\n\s+replayBusy = null;/);
  for (const field of ["cpuThreadBusy,", "gpuThreadBusy,", "replayBusy,"]) assert.ok(worker.includes(`    ${field}\n`), field);
});

test("the worker times its product entry points with one busy clock", () => {
  assert.match(worker, /const workerBusy = createBusyClock\(\);/);
  // page messages, presentation loop, vsync present, drains, pump
  assert.match(worker, /self\.addEventListener\("message", \(event\) => workerBusy\.run\(handleWorkerMessage, event\)\);\nasync function handleWorkerMessage\(event\) \{/);
  assert.match(worker, /function runPresentationLoop\(\) \{\n\s+return workerBusy\.run\(runPresentationLoopOnce\);\n\}\nfunction runPresentationLoopOnce\(\) \{/);
  assert.match(worker, /function presentWgpuVsyncFrame\(options\) \{\n\s+return workerBusy\.run\(presentWgpuVsyncFrameOnce, options\);\n\}\nfunction presentWgpuVsyncFrameOnce\(/);
  assert.match(worker, /function drainWebGpuCmdRing\(source = "presentation"\) \{\n\s+return workerBusy\.run\(drainWebGpuCmdRingOnce, source\);\n\}\nfunction drainWebGpuCmdRingOnce\(source = "presentation"\) \{/);
  assert.match(worker, /const pump = \(\) => workerBusy\.run\(pumpOnce\);\n\s+const pumpOnce = \(\) => \{/);
  // JIT messages from the CPU thread: only theirs are timed
  assert.match(worker, /function handleDolphinJitCompileRequest\(event\) \{\n\s+const type = event\.data\?\.type;\n\s+if \(type !== "dolphin-jit-compile-request" && type !== "dolphin-jit-warm-state"\) return undefined;\n\s+return workerBusy\.run\(handleDolphinJitCompileRequestOnce, event\);/);
  assert.match(worker, /function handleDolphinJitNewCompile\(event\) \{\n\s+if \(event\.data\?\.type !== "dolphin-jit-new-compile"\) return undefined;\n\s+return workerBusy\.run\(handleDolphinJitNewCompileOnce, event\);/);
  // EFB readback completions, disc reads served here
  assert.match(worker, /busy: \(fn\) => workerBusy\.run\(fn\),/);
  assert.match(worker, /return workerBusy\.run\(\(\) => read\.call\(this, stream, buffer, offset, length, position\)\);/);
  // nothing per command: the clock is never used inside the drain body
  const drain = worker.slice(worker.indexOf("function drainWebGpuCmdRingOnce("), worker.indexOf("function finishWebGpuDrain("));
  assert.doesNotMatch(drain, /workerBusy/);
});

test("the adapter keeps the occupancy fields, null included", () => {
  const adapter = new UpstreamWorkerAdapter();
  const read = () => [adapter.cpuThreadBusy, adapter.gpuThreadBusy, adapter.replayBusy];
  assert.deepEqual(read(), [null, null, null]);
  adapter.applyFrame({ frame: 10, cpuThreadBusy: 0.42, gpuThreadBusy: 0.9, replayBusy: 0.1 });
  assert.deepEqual(read(), [0.42, 0.9, 0.1]);
  adapter.applyFrame({ frame: 11, cpuThreadBusy: null, gpuThreadBusy: null, replayBusy: null });
  assert.deepEqual(read(), [null, null, null]);
  // an older worker does not send them: nothing changes
  adapter.applyFrame({ frame: 12, cpuThreadBusy: 0.5, gpuThreadBusy: 0.6 });
  adapter.applyFrame({ frame: 13 });
  assert.deepEqual(read(), [0.5, 0.6, null]);
});

test("core-host passes the occupancy fields to onFrame", () => {
  for (const field of ["cpuThreadBusy", "gpuThreadBusy", "replayBusy"])
    assert.match(host, new RegExp(`${field}: this\\.mode === "dolphin" \\? this\\.adapter\\.${field} \\?\\? null : null,`), field);
});
