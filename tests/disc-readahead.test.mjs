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

test("reads in blocks return exactly the bytes asked, across block boundaries and at the end", () => {
  const d = disc(10_000);
  const ra = createDiscReadahead({ readBlob: d.readBlob, blockBytes: 1024, maxBlocks: 4 });
  for (const [position, length] of [[0, 100], [1000, 100], [3000, 2500], [9990, 100], [10_000, 10]]) {
    const out = new Uint8Array(length + 8).fill(0xee);
    const n = ra.read(d.stream, out, 4, length, position);
    const expected = Math.max(0, Math.min(10_000, position + length) - position);
    assert.equal(n, expected);
    assert.deepEqual(out.subarray(4, 4 + n), d.bytes.subarray(position, position + n));
    assert.equal(out[3], 0xee, "nothing written before the offset");
  }
});

test("a block is read once, then copies; at most maxBlocks are held (least recently used out)", () => {
  const d = disc(64 * 1024);
  const ra = createDiscReadahead({ readBlob: d.readBlob, blockBytes: 4096, maxBlocks: 2 });
  const out = new Uint8Array(64);
  for (let p = 0; p < 4096; p += 64) ra.read(d.stream, out, 0, 64, p);
  assert.deepEqual(d.calls, [[0, 4096]], "64 small reads of one block: one block read");
  assert.equal(ra.stats.blockHits, 63);
  ra.read(d.stream, out, 0, 64, 4096); // block 1
  ra.read(d.stream, out, 0, 64, 0); // block 0 again: a hit, now most recent
  ra.read(d.stream, out, 0, 64, 8192); // block 2: evicts block 1
  ra.read(d.stream, out, 0, 64, 0); // still held
  ra.read(d.stream, out, 0, 64, 4096); // read again
  assert.deepEqual(d.calls.map(([a]) => a / 4096), [0, 1, 2, 1]);
  assert.equal(ra.stats.maxHeldBytes, 2 * 4096);
  assert.equal(ra.stats.heldBytes, 2 * 4096);
});

test("the worker reads the disc in blocks by default, ?discreadahead=0 turns it off, and counts it", async () => {
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
