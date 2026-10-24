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

test("the worker reads the disc ahead by default, ?discreadahead=0 turns it off, and counts it", async () => {
  const read = (p) => readFile(new URL(p, import.meta.url), "utf8");
  const w = await read("../src/upstream-discio-worker.js");
  // Before the harness's timing wrapper, so (a) times the reads in blocks.
  assert.match(w, /if \(discReadaheadEnabled\) readDiscAhead\(resolveWorkerFs\(moduleInstance\)\);\n\s*if \(harnessEnabled\) \{\n\s*timeDiscReads/);
  assert.match(w, /discReadaheadEnabled = discReadahead !== false;/);
  assert.match(w, /discReadahead: payload\.discReadahead,/);
  assert.match(w, /readahead: discBlockReader \? \{ \.\.\.discBlockReader\.stats \} : null/);
  assert.match(await read("../src/core-host.js"), /get\("discreadahead"\) !== "0"/);
  const a = await read("../src/upstream-worker-adapter.js");
  assert.match(a, /this\.discReadahead = discReadahead !== false;/);
  assert.match(a, /discReadahead: this\.discReadahead,/);
});
