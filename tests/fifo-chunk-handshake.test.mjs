import assert from "node:assert/strict";
import test from "node:test";
import { Worker } from "node:worker_threads";

// Patch 0116 (VideoCommon/Fifo.cpp, CommandProcessor.cpp): the two-thread
// protocol between the GPU loop and the CPU turning GP reads off, modelled
// with sequentially consistent Atomics (the patch's std::atomic defaults).
// GPU, per chunk: chunk_active = 1; if reads off: chunk_active = 0, skip;
// decode; store the read pointer; chunk_active = 0.
// CPU, GXSetGPFifo: reads = 0; wait while chunk_active; rewrite pointers;
// reads = 1.
// A chunk that stores its pointer after a rewrite it started before is the
// stale write that left the FIFO empty with commands pending.
const READS = 0, CHUNK = 1, GEN = 2, STALE = 3, STOP = 4, CHUNKS = 5;

const gpu = `
const { workerData } = require("node:worker_threads");
const w = new Int32Array(workerData);
const spin = (n) => { let x = 0; for (let i = 0; i < n; i += 1) x += i; return x; };
while (Atomics.load(w, ${STOP}) === 0) {
  Atomics.store(w, ${CHUNK}, 1);
  if (Atomics.load(w, ${READS}) === 0) { Atomics.store(w, ${CHUNK}, 0); continue; }
  const gen = Atomics.load(w, ${GEN});
  spin(50 + (gen % 7) * 40); // decode, sometimes long (a wait on the render worker)
  if (Atomics.load(w, ${GEN}) !== gen) Atomics.add(w, ${STALE}, 1); // pointer stored over a rewrite
  Atomics.add(w, ${CHUNKS}, 1);
  Atomics.store(w, ${CHUNK}, 0);
}
`;

async function run({ waitForChunk, rewrites = 20000 }) {
  const sab = new SharedArrayBuffer(8 * 4);
  const w = new Int32Array(sab);
  Atomics.store(w, READS, 1);
  const worker = new Worker(gpu, { eval: true, workerData: sab });
  const spin = (n) => { let x = 0; for (let i = 0; i < n; i += 1) x += i; return x; };
  // Start rewriting once the GPU thread decodes, and go on until both sides
  // have done enough.
  while (Atomics.load(w, CHUNKS) === 0) Atomics.wait(w, STOP, 0, 1);
  for (let i = 0; i < rewrites || Atomics.load(w, CHUNKS) < 20000; i += 1) {
    spin(100 + (i % 5) * 60);
    Atomics.store(w, READS, 0);
    if (waitForChunk) while (Atomics.load(w, CHUNK) !== 0) { /* WaitForFifoChunk */ }
    Atomics.add(w, GEN, 1); // the pointers are rewritten
    Atomics.store(w, READS, 1);
  }
  Atomics.store(w, STOP, 1);
  await worker.terminate();
  return { stale: Atomics.load(w, STALE), chunks: Atomics.load(w, CHUNKS) };
}

test("turning GP reads off waits for the chunk in flight: no stale pointer store", async () => {
  const r = await run({ waitForChunk: true });
  assert.ok(r.chunks > 1000, `the GPU decoded (${r.chunks} chunks)`);
  assert.equal(r.stale, 0);
});

// One chunk, scripted rather than raced (a race may not happen on a loaded
// machine): the GPU flags its chunk, says so (PHASE), then lets the CPU act
// before it stores its pointer, waiting for GO at most 200 ms.
const PHASE = 6, GO = 7;
const scriptedGpu = `
const { workerData } = require("node:worker_threads");
const w = new Int32Array(workerData);
Atomics.store(w, ${CHUNK}, 1);
if (Atomics.load(w, ${READS}) === 0) { Atomics.store(w, ${CHUNK}, 0); }
else {
  const gen = Atomics.load(w, ${GEN});
  Atomics.store(w, PHASE_INDEX, 1);
  Atomics.notify(w, PHASE_INDEX);
  Atomics.wait(w, GO_INDEX, 0, 200); // decoding; the CPU acts now
  if (Atomics.load(w, ${GEN}) !== gen) Atomics.add(w, ${STALE}, 1);
  Atomics.add(w, ${CHUNKS}, 1);
  Atomics.store(w, ${CHUNK}, 0);
}
`.replaceAll("PHASE_INDEX", String(PHASE)).replaceAll("GO_INDEX", String(GO));

async function scripted({ waitForChunk }) {
  const sab = new SharedArrayBuffer(8 * 4);
  const w = new Int32Array(sab);
  Atomics.store(w, READS, 1);
  const worker = new Worker(scriptedGpu, { eval: true, workerData: sab });
  const exited = new Promise((resolve) => worker.once("exit", resolve));
  // The chunk is in flight.
  while (Atomics.load(w, PHASE) === 0) Atomics.wait(w, PHASE, 0, 50);
  Atomics.store(w, READS, 0); // GP reads off
  if (waitForChunk) while (Atomics.load(w, CHUNK) !== 0) Atomics.wait(w, CHUNK, 1, 5);
  Atomics.add(w, GEN, 1); // the pointers are rewritten
  Atomics.store(w, GO, 1);
  Atomics.notify(w, GO);
  await exited;
  return { stale: Atomics.load(w, STALE), chunks: Atomics.load(w, CHUNKS) };
}

test("without the wait, a chunk in flight stores its pointer over the rewrite (the bug), deterministically", async () => {
  assert.deepEqual(await scripted({ waitForChunk: false }), { stale: 1, chunks: 1 });
});

test("with the wait, the same scripted chunk finishes before the rewrite", async () => {
  assert.deepEqual(await scripted({ waitForChunk: true }), { stale: 0, chunks: 1 });
});
