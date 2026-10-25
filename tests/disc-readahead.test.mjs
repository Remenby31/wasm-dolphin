import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createDiscReadahead } from "../src/disc-readahead.js";

// A fake WORKERFS node over bytes: a Blob-like slice and a reader that
// counts its calls.
function disc(size) {
  const bytes = new Uint8Array(size).map((_, i) => (i * 31 + 7) & 0xff);
  const blob = { slice: (a, b) => ({ a, b }) };
  const calls = [];
  const readBlob = ({ a, b }) => { calls.push([a, b]); return bytes.slice(a, b).buffer; };
  return { bytes, stream: { node: { contents: blob, size } }, readBlob, calls };
}

test("reads ahead return exactly the bytes asked, across segment boundaries and at the end", () => {
  const d = disc(10_000);
  const ra = createDiscReadahead({ readBlob: d.readBlob, minBytes: 512, maxBytes: 2048, heldBytes: 4096 });
  for (const [position, length] of [[0, 100], [1000, 100], [3000, 2500], [9990, 100], [10_000, 10], [5, 9000]]) {
    const out = new Uint8Array(length + 8).fill(0xee);
    const n = ra.read(d.stream, out, 4, length, position);
    const expected = Math.max(0, Math.min(10_000, position + length) - position);
    assert.equal(n, expected);
    assert.deepEqual(out.subarray(4, 4 + n), d.bytes.subarray(position, position + n));
    assert.equal(out[3], 0xee, "nothing written before the offset");
  }
});

test("a stream reads 64 KiB first, then twice as much each time it follows on, up to 1 MiB; a seek starts over", () => {
  const d = disc(8 << 20);
  const ra = createDiscReadahead({ readBlob: d.readBlob });
  const out = new Uint8Array(16 << 10);
  for (let p = 0; p < (3 << 20); p += out.length) ra.read(d.stream, out, 0, out.length, p);
  const sizes = d.calls.map(([a, b]) => (b - a) >> 10);
  assert.deepEqual(sizes.slice(0, 6), [64, 128, 256, 512, 1024, 1024]);
  const before = d.calls.length;
  ra.read(d.stream, out, 0, 100, 6 << 20); // a seek
  assert.equal((d.calls[before][1] - d.calls[before][0]) >> 10, 64);
  // 3 MiB of 16 KiB reads: a handful of segment reads, the rest copies.
  assert.ok(ra.stats.blockHits > 180 && before <= 7, `${before} reads, ${ra.stats.blockHits} hits`);
});

test("what is held stays under the cap, oldest segments out first", () => {
  const d = disc(8 << 20);
  const ra = createDiscReadahead({ readBlob: d.readBlob, heldBytes: 2 << 20 });
  const out = new Uint8Array(16 << 10);
  for (let p = 0; p < (6 << 20); p += out.length) ra.read(d.stream, out, 0, out.length, p);
  assert.ok(ra.stats.heldBytes <= 2 << 20, `${ra.stats.heldBytes} held`);
  assert.ok(ra.stats.maxHeldBytes <= 2 << 20, `the cap holds at every moment (${ra.stats.maxHeldBytes})`);
  // The oldest region was let go: reading it again is a new (small) read.
  const before = d.calls.length;
  ra.read(d.stream, out, 0, 100, 0);
  assert.equal(d.calls.length, before + 1);
});

test("two discs share one cap: after a disc change the old disc's segments go first", () => {
  const one = disc(4 << 20), two = disc(4 << 20);
  const readBlob = (slice) => (slice.file === 1 ? one : two).readBlob(slice);
  for (const [n, d] of [[1, one], [2, two]]) d.stream.node.contents = { slice: (a, b) => ({ file: n, a, b }) };
  const ra = createDiscReadahead({ readBlob, heldBytes: 2 << 20 });
  const out = new Uint8Array(16 << 10);
  for (let p = 0; p < (2 << 20); p += out.length) ra.read(one.stream, out, 0, out.length, p);
  const readsOnOne = one.calls.length;
  // The second disc: a stream that settles at 1 MiB segments, then a pass
  // over what is held must be copies, with the cap holding.
  for (let p = 0; p < (2 << 20); p += out.length) ra.read(two.stream, out, 0, out.length, p);
  const readsOnTwo = two.calls.length;
  for (let p = (1 << 20); p < (2 << 20); p += out.length) {
    ra.read(two.stream, out, 0, out.length, p);
    assert.deepEqual(out, two.bytes.subarray(p, p + out.length));
  }
  assert.equal(two.calls.length, readsOnTwo, "what is held of the second disc is not read again");
  assert.equal(one.calls.length, readsOnOne);
  assert.ok(ra.stats.maxHeldBytes <= 2 << 20, `${ra.stats.maxHeldBytes} held at most`);
});

test("a file shorter than its node says: the read returns what there is, never loops", () => {
  const d = disc(1000);
  d.stream.node.size = 5000; // the node says more than the Blob holds
  const ra = createDiscReadahead({ readBlob: d.readBlob, minBytes: 512 });
  const out = new Uint8Array(4000);
  assert.equal(ra.read(d.stream, out, 0, 4000, 500), 500);
  assert.deepEqual(out.subarray(0, 500), d.bytes.subarray(500, 1000));
  assert.equal(ra.read(d.stream, out, 0, 100, 2000), 0);
});

// Patch 0155: the next segment in the background, with an async reader the
// test settles by hand.
function asyncReader(d) {
  const pending = [];
  const readBlobAsync = (slice) => new Promise((resolve) => pending.push(() => resolve(d.readBlob(slice))));
  const settle = async () => { while (pending.length) pending.shift()(); await new Promise((r) => setImmediate(r)); };
  return { readBlobAsync, pending, settle };
}

test("prefetch: a stream reads ahead in the background and the DVD thread finds it held", async () => {
  const d = disc(8 << 20);
  const a = asyncReader(d);
  const ra = createDiscReadahead({ readBlob: d.readBlob, readBlobAsync: a.readBlobAsync });
  const out = new Uint8Array(16 << 10);
  let p = 0;
  const readNext = () => { ra.read(d.stream, out, 0, out.length, p); assert.deepEqual(out, d.bytes.subarray(p, p + out.length)); p += out.length; };
  // 64 KiB, then following on: a 128 KiB sync read and a prefetch issued.
  for (let i = 0; i < 5; i += 1) readNext();
  assert.equal(ra.stats.prefetchIssued, 1);
  await a.settle();
  const syncBefore = ra.stats.blockReads;
  // The stream then lives on prefetched segments: no more sync reads.
  for (let i = 0; i < 100; i += 1) { readNext(); await a.settle(); }
  assert.equal(ra.stats.blockReads, syncBefore, "no sync read once the prefetch leads");
  assert.ok(ra.stats.prefetchUsed >= 3 && ra.stats.syncMissInflight === 0, JSON.stringify(ra.stats));
  assert.ok(ra.stats.heldBytes <= 8 << 20);
});

test("prefetch: a read that reaches a segment still in flight reads it synchronously, the late one is dropped", async () => {
  const d = disc(8 << 20);
  const a = asyncReader(d);
  const ra = createDiscReadahead({ readBlob: d.readBlob, readBlobAsync: a.readBlobAsync });
  const out = new Uint8Array(64 << 10);
  ra.read(d.stream, out, 0, out.length, 0);
  ra.read(d.stream, out, 0, out.length, 64 << 10); // follows on: sync 128 KiB, prefetch from 192 KiB
  ra.read(d.stream, out, 0, out.length, 192 << 10); // reaches the prefetch before it lands
  assert.equal(ra.stats.syncMissInflight, 1);
  assert.deepEqual(out, d.bytes.subarray(192 << 10, 256 << 10));
  await a.settle();
  assert.equal(ra.stats.prefetchWasted, 1, "the late prefetch overlaps what was read: dropped");
});

test("prefetch: without an async reader, nothing is prefetched", () => {
  const d = disc(1 << 20);
  const ra = createDiscReadahead({ readBlob: d.readBlob });
  const out = new Uint8Array(16 << 10);
  for (let p = 0; p < (512 << 10); p += out.length) ra.read(d.stream, out, 0, out.length, p);
  assert.equal(ra.stats.prefetchIssued, 0);
});

test("the worker reads the disc ahead by default, ?discreadahead=0 turns it off, and counts it", async () => {
  const read = (p) => readFile(new URL(p, import.meta.url), "utf8");
  const w = await read("../src/upstream-discio-worker.js");
  // Before the harness's timing wrapper, so (a) times the reads in blocks.
  assert.match(w, /if \(discReadaheadEnabled\) readDiscAhead\(resolveWorkerFs\(moduleInstance\)\);\n\s*noteDiscReads\(resolveWorkerFs\(moduleInstance\)\);\n\s*if \(harnessEnabled\) \{\n\s*timeDiscReads/);
  assert.match(w, /discReadaheadEnabled = discReadahead !== false;/);
  assert.match(w, /discReadahead: payload\.discReadahead,/);
  assert.match(w, /readahead: discBlockReader \? \{ \.\.\.discBlockReader\.stats \} : null/);
  assert.match(await read("../src/core-host.js"), /get\("discreadahead"\) !== "0"/);
  const a = await read("../src/upstream-worker-adapter.js");
  assert.match(a, /this\.discReadahead = discReadahead !== false;/);
  assert.match(a, /discReadahead: this\.discReadahead,/);
});

test("the worker prefetches with Blob.arrayBuffer only with ?discprefetch=1 (off by default)", async () => {
  const read = (p) => readFile(new URL(p, import.meta.url), "utf8");
  const w = await read("../src/upstream-discio-worker.js");
  assert.match(w, /readBlobAsync: discPrefetchEnabled \? \(blob\) => blob\.arrayBuffer\(\) : null,/);
  assert.match(w, /discPrefetchEnabled = discPrefetch === true;/);
  assert.match(w, /^let discPrefetchEnabled = false;$/m);
  assert.match(w, /discPrefetch: payload\.discPrefetch,/);
  assert.match(await read("../src/core-host.js"), /get\("discprefetch"\) === "1"/);
  const a = await read("../src/upstream-worker-adapter.js");
  assert.match(a, /this\.discPrefetch = discPrefetch === true;/);
  assert.match(a, /discPrefetch: this\.discPrefetch,/);
});
