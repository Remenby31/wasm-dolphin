#!/usr/bin/env node
// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// The replay pump's wait on an empty ring, alone: a producer thread publishes
// frame-like bursts (a few hundred records, then idle until the next 16.7 ms
// tick) and the consumer either polls every 4 ms (setTimeout, the pump before
// patch 0148) or parks on the write index (src/wgpu-replay-park.js). Reports
// publish -> seen latency of every publish (p50, p95, max), consumer wakes per
// second and the process CPU (the producer is the same in both modes). A
// timed run: on the shared Mac, under the perf lock.
//
//   node harness/probes/replay-park-bench.mjs [--secs 10] [--out file.json]
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Worker } from "node:worker_threads";

import { percentile } from "../lib/stats.mjs";
import { parkWgpuReplay, unparkWgpuReplay } from "../../src/wgpu-replay-park.js";

const PARK = fileURLToPath(new URL("../../src/wgpu-replay-park.js", import.meta.url));
const PRODUCER = `
const { workerData } = require("node:worker_threads");
const { header, times, pubs, secs } = workerData;
const h = new Int32Array(header), t = new Float64Array(times), cap = t.length, n = new Int32Array(pubs);
import(${JSON.stringify(PARK)}).then(({ publishWgpuWriteIndex }) => {
  const nap = new Int32Array(new SharedArrayBuffer(4));
  const start = performance.now();
  let w = 0, frame = 0;
  while (performance.now() - start < secs * 1000) {
    // One frame: bursts of 1-40 records with short gaps, ~300 records.
    for (let burst = 0; burst < 12; burst += 1) {
      const records = 1 + ((frame * 7 + burst * 13) % 40);
      w += records;
      // Publish k's time, then the count, then the write index.
      const k = Atomics.load(n, 0);
      t[k % cap] = performance.timeOrigin + performance.now();
      Atomics.store(n, 0, k + 1);
      publishWgpuWriteIndex(h, w);
      Atomics.wait(nap, 0, 0, 0.2 + (burst % 3) * 0.3);
    }
    frame += 1;
    const next = start + frame * 16.667;
    const left = next - performance.now();
    if (left > 0) Atomics.wait(nap, 0, 0, left);
  }
  Atomics.store(h, 6, 1); // done
});
`;

export async function benchReplayWait({ mode, secs }) {
  const header = new SharedArrayBuffer(7 * 4), times = new SharedArrayBuffer(1 << 20 << 3), pubs = new SharedArrayBuffer(4);
  const h = new Int32Array(header), t = new Float64Array(times), cap = t.length, n = new Int32Array(pubs);
  const worker = new Worker(PRODUCER, { eval: true, workerData: { header, times, pubs, secs } });
  const lat = [];
  let seen = 0, seenPubs = 0, wakes = 0;
  const cpu0 = process.cpuUsage();
  // A pending Atomics.waitAsync does not keep node's event loop alive.
  const keepAlive = setInterval(() => {}, 1000);
  const startedAt = performance.now();
  while (Atomics.load(h, 6) === 0) {
    // Every publish since the previous wake waited until now.
    const write = Atomics.load(h, 0), published = Atomics.load(n, 0);
    if (write !== seen) {
      const now = performance.timeOrigin + performance.now();
      for (let k = seenPubs; k < published; k += 1) lat.push(now - t[k % cap]);
      seen = write;
      seenPubs = published;
    }
    wakes += 1;
    if (mode === "poll") await new Promise((r) => setTimeout(r, 4));
    else {
      const wait = parkWgpuReplay(h, seen, 4);
      if (wait.async) { await wait.value; unparkWgpuReplay(h); }
    }
  }
  const elapsed = (performance.now() - startedAt) / 1000;
  const cpu = process.cpuUsage(cpu0);
  clearInterval(keepAlive);
  await worker.terminate();
  const r = (x) => Math.round(x * 1000) / 1000;
  return { mode, seen: lat.length, p50Ms: r(percentile(lat, 50)), p95Ms: r(percentile(lat, 95)), maxMs: r(Math.max(...lat)), wakesPerSec: Math.round(wakes / elapsed), processCpuPct: Math.round((cpu.user + cpu.system) / 1e4 / elapsed) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ options: { secs: { type: "string", default: "10" }, out: { type: "string" } } });
  const secs = Number(values.secs);
  // A B B A, so a drift of the machine does not favour one mode.
  const runs = [];
  for (const mode of ["poll", "park", "park", "poll"]) {
    const r = await benchReplayWait({ mode, secs });
    console.log(`[replay-park-bench] ${JSON.stringify(r)}`);
    runs.push(r);
  }
  if (values.out) writeFileSync(values.out, JSON.stringify({ secs, runs }, null, 1));
}
