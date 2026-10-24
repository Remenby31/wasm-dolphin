import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import { createWgpuReplayParker, parkWgpuReplay, publishWgpuWriteIndex, unparkWgpuReplay, WGPU_PROTOCOL_CONSUMER_PARKED_FLAG } from "../src/wgpu-replay-park.js";
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

// Every interleaving, step by step: the consumer parks after the producer's
// k-th atomic operation, for each k. Atomics is swapped for a counting proxy
// during the producer's call, so the test does not depend on how the
// producer is written: whatever its order, a record left in the ring until
// the timeout (a lost wakeup) fails.
async function interleavings(producer) {
  const stuck = [];
  for (let k = 0; ; k += 1) {
    const h = new Int32Array(new SharedArrayBuffer(7 * 4));
    const real = Atomics;
    let ops = 0, wait = null;
    const park = () => { wait = parkWgpuReplay(h, 0, 300, { waitAsync: real.waitAsync }); };
    if (k === 0) park();
    globalThis.Atomics = new Proxy(real, {
      get(target, name) {
        const f = target[name];
        if (typeof f !== "function") return f;
        return (...args) => {
          const r = f.apply(target, args);
          ops += 1;
          if (ops === k) { globalThis.Atomics = real; park(); globalThis.Atomics = proxy; }
          return r;
        };
      },
    });
    const proxy = globalThis.Atomics;
    try { producer(h, 1); } finally { globalThis.Atomics = real; }
    if (k > ops) break; // the consumer parked after the producer: covered by k = ops
    if (!wait) park();
    const outcome = wait.async ? await wait.value : wait.value;
    if (outcome === "timed-out" && Atomics.load(h, 0) !== 0) stuck.push(k);
  }
  return stuck;
}

test("no interleaving of one park and one publish leaves a record waiting for the timeout", async () => {
  assert.deepEqual(await interleavings(publishWgpuWriteIndex), []);
});

test("the interleaving test catches a producer that reads the flag before it publishes (the swap)", async () => {
  const swapped = (h, write) => {
    const parked = (Atomics.load(h, WGPU_PROTOCOL_FLAGS_HEADER_INDEX) & WGPU_PROTOCOL_CONSUMER_PARKED_FLAG) !== 0;
    Atomics.store(h, 0, write);
    if (parked) Atomics.notify(h, 0);
  };
  assert.ok((await interleavings(swapped)).length > 0);
});

test("the C++ producer publishes, then reads the flag (0148)", async () => {
  const { readFile } = await import("node:fs/promises");
  const patch = await readFile(new URL("../patches/dolphin-wasm/snapshot/0148-wgpu-ring-wake-parked-consumer.patch", import.meta.url), "utf8");
  const added = patch.split("\n").filter((l) => l.startsWith("+")).join("\n");
  assert.match(added, /m_header->write\.store\(w \+ 1, std::memory_order_seq_cst\);\n\+\s*WakeParkedConsumer\(\);/);
  assert.match(added, /m_header->write\.store\(w \+ count, std::memory_order_seq_cst\);\n\+\s*WakeParkedConsumer\(\);/);
  assert.match(added, /if \(\(m_header->protocol_flags\.load\(std::memory_order_seq_cst\) & kProtocolConsumerParked\) == 0\)\n\+\s*return;\n\+\s*emscripten_futex_wake/);
});

// The pump's parker, with a fake waitAsync the test resolves by hand.
function fakeWait() {
  const pending = [];
  const waitAsync = (h, i, v) => {
    if (Atomics.load(h, i) !== v) return { async: false, value: "not-equal" };
    let resolve;
    const value = new Promise((r) => { resolve = r; });
    pending.push(resolve);
    return { async: true, value };
  };
  return { waitAsync, pending };
}
const freshStats = () => ({ replayPumpParkCount: 0, replayPumpParkNotEqualCount: 0, replayPumpParkNotifiedCount: 0, replayPumpParkTimedOutCount: 0, replayPumpParkTimedOutWithDataCount: 0 });
const flagOf = (h) => Atomics.load(h, WGPU_PROTOCOL_FLAGS_HEADER_INDEX) & WGPU_PROTOCOL_CONSUMER_PARKED_FLAG;
const tick = () => new Promise((r) => setImmediate(r));

test("parker: a park sleeps with the flag set; a notified wake clears it and runs the pump once", async () => {
  const { waitAsync, pending } = fakeWait();
  const ring = { headerI32: new Int32Array(new SharedArrayBuffer(28)) };
  const stats = freshStats(), scheduled = [];
  const parker = createWgpuReplayParker({ stats, waitAsync, schedule: (f, d) => scheduled.push(d) });
  let pumps = 0;
  assert.equal(parker.park(ring, 0, () => { pumps += 1; }), true);
  assert.equal(parker.parked, true);
  assert.notEqual(flagOf(ring.headerI32), 0);
  pending[0]("ok");
  await tick();
  assert.deepEqual([pumps, parker.parked, flagOf(ring.headerI32), stats.replayPumpParkNotifiedCount, scheduled.length], [1, false, 0, 1, 0]);
});

test("parker: a cancel makes the pending park stale and clears the flag", async () => {
  const { waitAsync, pending } = fakeWait();
  const ring = { headerI32: new Int32Array(new SharedArrayBuffer(28)) };
  const stats = freshStats();
  const parker = createWgpuReplayParker({ stats, waitAsync, schedule: () => {} });
  let pumps = 0;
  parker.park(ring, 0, () => { pumps += 1; });
  parker.cancel(ring);
  assert.deepEqual([parker.parked, flagOf(ring.headerI32)], [false, 0]);
  pending[0]("ok");
  await tick();
  assert.equal(pumps, 0, "the stale wake runs nothing");
  assert.equal(stats.replayPumpParkNotifiedCount, 0);
});

test("parker: a producer already ahead drains now; a timeout with data is counted; another ring's wake is ignored", async () => {
  const { waitAsync, pending } = fakeWait();
  const ring = { headerI32: new Int32Array(new SharedArrayBuffer(28)) };
  const stats = freshStats(), scheduled = [];
  let current = ring, pumps = 0;
  const parker = createWgpuReplayParker({ stats, waitAsync, schedule: (f, d) => scheduled.push(d), isCurrentRing: (r) => r === current });
  Atomics.store(ring.headerI32, 0, 5);
  assert.equal(parker.park(ring, 4, () => { pumps += 1; }), true);
  assert.deepEqual([scheduled, stats.replayPumpParkNotEqualCount, flagOf(ring.headerI32), parker.parked], [[0], 1, 0, false]);
  parker.park(ring, 5, () => { pumps += 1; });
  Atomics.store(ring.headerI32, 0, 6);
  pending[0]("timed-out");
  await tick();
  assert.deepEqual([pumps, stats.replayPumpParkTimedOutCount, stats.replayPumpParkTimedOutWithDataCount], [1, 1, 1]);
  parker.park(ring, 6, () => { pumps += 1; });
  current = { headerI32: new Int32Array(new SharedArrayBuffer(28)) };
  pending[1]("ok");
  await tick();
  assert.equal(pumps, 1, "a wake for a ring that was replaced runs nothing");
});

test("parker: without Atomics.waitAsync the pump polls (park returns false, no flag)", () => {
  const ring = { headerI32: new Int32Array(new SharedArrayBuffer(28)) };
  const parker = createWgpuReplayParker({ stats: freshStats(), waitAsync: null, schedule: () => {} });
  assert.equal(parker.park(ring, 0, () => {}), false);
  assert.equal(flagOf(ring.headerI32), 0);
});

test("the worker's pump parks through the parker", async () => {
  const { readFile } = await import("node:fs/promises");
  const w = await readFile(new URL("../src/upstream-discio-worker.js", import.meta.url), "utf8");
  assert.match(w, /if \(write === read && !wgpuMappedCapacityBlocked && parkWgpuReplayPump\(pump, write\)\) return;/);
  assert.match(w, /wgpuReplayParker\?\.cancel\(webGpuCmdRing\);/);
});
