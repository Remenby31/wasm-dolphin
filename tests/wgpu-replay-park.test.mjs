import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import { parkWgpuReplay, publishWgpuWriteIndex, unparkWgpuReplay, WGPU_PROTOCOL_CONSUMER_PARKED_FLAG } from "../src/wgpu-replay-park.js";
import { WGPU_PROTOCOL_FLAGS_HEADER_INDEX } from "../src/wgpu-ring-backpressure.js";

// Patch 0148: the replay pump parks on an empty ring and the producer wakes it
// only while it is parked. Stress the race with a real producer thread: every
// publish must be seen well before the park's timeout (no lost wakeup).
const PARK = fileURLToPath(new URL("../src/wgpu-replay-park.js", import.meta.url));
const producer = (wakes) => `
const { workerData } = require("node:worker_threads");
const { header, times, count } = workerData;
const h = new Int32Array(header), t = new Float64Array(times);
import(${JSON.stringify(PARK)}).then(({ publishWgpuWriteIndex }) => {
  const nap = new Int32Array(new SharedArrayBuffer(4));
  for (let i = 1; i <= count; i += 1) {
    // Bursts and gaps, so the consumer parks often and races publishes.
    if (i % 7 === 0) Atomics.wait(nap, 0, 0, 1);
    else { const end = performance.now() + (i % 3) * 0.05; while (performance.now() < end) {} }
    t[i] = performance.timeOrigin + performance.now();
    ${wakes ? "publishWgpuWriteIndex(h, i);" : "Atomics.store(h, 0, i); // a producer that never wakes a parked consumer"}
  }
});
`;

async function run({ wakes, count, timeoutMs }) {
  const header = new SharedArrayBuffer(7 * 4), times = new SharedArrayBuffer((count + 1) * 8);
  const h = new Int32Array(header), t = new Float64Array(times);
  const worker = new Worker(producer(wakes), { eval: true, workerData: { header, times, count } });
  let seen = 0, parks = 0, notified = 0, timedOutWithData = 0, maxLatencyMs = 0;
  while (seen < count) {
    const write = Atomics.load(h, 0);
    if (write === seen) {
      const wait = parkWgpuReplay(h, seen, timeoutMs);
      parks += 1;
      if (wait.async) {
        const outcome = await wait.value;
        unparkWgpuReplay(h);
        if (outcome === "ok") notified += 1;
        else if (Atomics.load(h, 0) !== seen) timedOutWithData += 1;
      }
      continue;
    }
    const now = performance.timeOrigin + performance.now();
    for (let i = seen + 1; i <= write; i += 1) maxLatencyMs = Math.max(maxLatencyMs, now - t[i]);
    seen = write;
  }
  await worker.terminate();
  return { parks, notified, timedOutWithData, maxLatencyMs, flagsLeft: Atomics.load(h, WGPU_PROTOCOL_FLAGS_HEADER_INDEX) };
}

test("a parked consumer is always woken by a publish: no wakeup lost under a racing producer", async () => {
  const r = await run({ wakes: true, count: 3000, timeoutMs: 1000 });
  assert.ok(r.parks > 300 && r.notified > 300, `the consumer parked and was woken often (${r.parks} parks, ${r.notified} wakes)`);
  assert.equal(r.timedOutWithData, 0);
  // A lost wakeup would show as a stall of the whole 1 s timeout.
  assert.ok(r.maxLatencyMs < 250, `every record seen soon after its publish (max ${r.maxLatencyMs.toFixed(1)} ms)`);
  assert.equal(r.flagsLeft & WGPU_PROTOCOL_CONSUMER_PARKED_FLAG, 0, "the parked flag is cleared on wake");
});

test("negative control: a producer that never wakes leaves the consumer to its timeout (what a core without 0148 does)", async () => {
  const r = await run({ wakes: false, count: 200, timeoutMs: 20 });
  assert.equal(r.notified, 0);
  assert.ok(r.timedOutWithData > 0, "the test sees records waiting for the timeout");
});

test("the producer notifies only a parked consumer, and the flag keeps the other protocol bits", () => {
  const h = new Int32Array(new SharedArrayBuffer(7 * 4));
  Atomics.store(h, WGPU_PROTOCOL_FLAGS_HEADER_INDEX, 0b11);
  publishWgpuWriteIndex(h, 5);
  assert.equal(Atomics.load(h, 0), 5);
  // Parking on a stale write index does not sleep and leaves no flag behind.
  const stale = parkWgpuReplay(h, 4, 10);
  assert.deepEqual([stale.async, stale.value], [false, "not-equal"]);
  assert.equal(Atomics.load(h, WGPU_PROTOCOL_FLAGS_HEADER_INDEX), 0b11);
  const parked = parkWgpuReplay(h, 5, 10);
  assert.equal(parked.async, true);
  assert.equal(Atomics.load(h, WGPU_PROTOCOL_FLAGS_HEADER_INDEX), 0b11 | WGPU_PROTOCOL_CONSUMER_PARKED_FLAG);
  unparkWgpuReplay(h);
  assert.equal(Atomics.load(h, WGPU_PROTOCOL_FLAGS_HEADER_INDEX), 0b11);
});

test("the replay pump parks through this module, and a cancel makes a pending park stale", async () => {
  const { readFile } = await import("node:fs/promises");
  const w = await readFile(new URL("../src/upstream-discio-worker.js", import.meta.url), "utf8");
  assert.match(w, /if \(write === read && !wgpuMappedCapacityBlocked && parkWgpuReplayPump\(pump, write\)\) return;/);
  assert.match(w, /if \(generation !== wgpuReplayPumpGeneration \|\| ring !== webGpuCmdRing\) return;/);
  assert.match(w, /wgpuReplayPumpGeneration \+= 1;/);
});
