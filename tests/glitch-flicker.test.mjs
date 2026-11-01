import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createFlickerRecorder, lumaSignature, MAX_IN_FLIGHT } from "../src/harness-flicker.js";
import { distinctRuns, findFlicker, FLICKER_FLOOR, FLICKER_RATIO, signatureDistance, tripleStrip } from "../harness/lib/flicker.mjs";

const read = (p) => readFile(new URL(p, import.meta.url), "utf8");
const b64 = (arr) => Buffer.from(Uint8Array.from(arr)).toString("base64");
// a 1-row signature of 8 values, all `v` but position `at` set to `w`
const sig = (v, at = -1, w = 0) => Array.from({ length: 8 }, (_, i) => (i === at ? w : v));
const watchOf = (sigs) => ({ frames: sigs.map((s, seq) => (s === null ? { seq, at: seq * 16, gap: true } : { seq, at: seq * 16, b64: b64(s) })) });

test("signature: BT.601 luma of every other pixel, RGBA or BGRA, rows padded", () => {
  // 3 pixels per row, 2 rows, 16-byte padded rows
  const bytes = new Uint8Array(32);
  bytes.set([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255], 0); // red, green, blue
  bytes.set([255, 255, 255, 255, 0, 0, 0, 255, 10, 10, 10, 255], 16);
  const s = lumaSignature(bytes, 3, 2, 16, false, 2);
  assert.equal(s.cols, 2);
  assert.deepEqual([...s.data], [(255 * 77) >> 8, (255 * 29) >> 8, 255, (10 * 256) >> 8]);
  const bgra = lumaSignature(bytes, 3, 2, 16, true, 2);
  assert.equal(bgra.data[0], (255 * 29) >> 8, "the first byte is blue in BGRA");
});

test("recorder: present order kept, a present past the in-flight cap or of another shape is a gap", async () => {
  let t = 0;
  const rec = createFlickerRecorder({ now: () => t });
  assert.equal(rec.active, false);
  rec.start();
  const pending = [];
  for (let i = 0; i < MAX_IN_FLIGHT + 2; i += 1) {
    rec.onPresent(() => new Promise((resolve) => pending.push(() => resolve({ cols: 2, rows: 1, data: Uint8Array.from([i, i]) }))));
    t += 16;
  }
  // the last two found MAX_IN_FLIGHT readbacks waiting
  pending.reverse().forEach((r) => r());
  await new Promise((r) => setTimeout(r, 0));
  rec.onPresent(() => ({ cols: 3, rows: 1, data: Uint8Array.from([1, 2, 3]) }));
  rec.onPresent(() => { throw new Error("texture gone"); });
  await new Promise((r) => setTimeout(r, 0));
  const out = await rec.stop({ waitMs: 0 });
  assert.equal(out.presents, MAX_IN_FLIGHT + 4);
  assert.deepEqual(out.frames.map((f) => (f.gap ? "gap" : Buffer.from(f.b64, "base64")[0])), [0, 1, 2, 3, 4, 5, "gap", "gap", "gap", "gap"]);
  assert.equal(out.errors, 1);
  assert.match(out.lastError, /texture gone/);
  assert.equal(rec.active, false);
});

test("distinct pictures: a picture presented again counts once, a gap ends the run", () => {
  const runs = distinctRuns(watchOf([sig(10), sig(10), sig(20), null, sig(30), sig(30)]));
  assert.deepEqual(runs.map((r) => r.map((p) => [p.seq, p.presents])), [[[0, 2], [2, 1]], [[4, 2]]]);
});

test("A-B-A: a picture that comes and goes is flagged; motion, a cut and a gap are not", () => {
  assert.equal(signatureDistance(Uint8Array.from(sig(10)), Uint8Array.from(sig(12))), 2);
  // steady motion: each step +4, A to C +8
  const motion = findFlicker(distinctRuns(watchOf([sig(10), sig(14), sig(18), sig(22)])));
  assert.equal(motion.flagged.length, 0);
  assert.equal(motion.closestRatio, 2);
  // a lost pass for one frame (doubled presents around it): A A B A A
  const flash = findFlicker(distinctRuns(watchOf([sig(50), sig(50), sig(50, 3, 0), sig(50), sig(50)])));
  assert.equal(flash.flagged.length, 1);
  assert.deepEqual({ seqA: flash.flagged[0].seqA, seqB: flash.flagged[0].seqB, seqC: flash.flagged[0].seqC, ac: flash.flagged[0].ac }, { seqA: 0, seqB: 2, seqC: 3, ac: 0 });
  // B nearly back to A while the scene moves a little: still flagged under the ratio
  const nearly = findFlicker(distinctRuns(watchOf([sig(50), sig(50, 3, 0), sig(51)])));
  assert.equal(nearly.flagged.length, 1);
  // a flash too small to be a change (under the floor): not judged
  const tiny = findFlicker(distinctRuns(watchOf([sig(50), sig(50, 3, 54), sig(50)])));
  assert.equal(tiny.triples, 0);
  // a scene cut: A, B, then C far from both
  assert.equal(findFlicker(distinctRuns(watchOf([sig(10), sig(100), sig(200)]))).flagged.length, 0);
  // a gap between B and the return to A: no triple spans it
  assert.equal(findFlicker(distinctRuns(watchOf([sig(50), sig(50, 3, 0), null, sig(50)]))).triples, 0);
  assert.equal(FLICKER_FLOOR, 1);
  assert.equal(FLICKER_RATIO, 0.25);
});

test("the strip shows the three pictures side by side", () => {
  const frames = [sig(10), sig(200), sig(10)].map((s) => ({ sig: Uint8Array.from(s) }));
  const img = tripleStrip({ frames }, 4, 2, 3);
  assert.equal(img.width, 4 * 3 + 8);
  assert.equal(img.height, 6);
  assert.equal(img.data[0], 10);
  assert.equal(img.data[(0 * img.width + 8) * 4], 200, "the second picture after the first and a 4 px gap");
});

test("the worker records presents only while the harness watches, and replay-gates --flicker judges them", async () => {
  const worker = await read("../src/upstream-discio-worker.js");
  assert.match(worker, /if \(harnessFlicker\.active\) harnessFlicker\.onPresent\(readbackWgpuPresentSignature, wgpuExactCapture\.currentLoad\(\),\n\s+wgpuPresentedSource \? \{ texture: wgpuPresentedSource\.textureId \?\? null, rect: wgpuPresentedSource\.rect \?\? null \} : null\);/);
  assert.match(worker, /case "validationFlickerWatch":\n\s+return harnessFlickerRequest\(payload\);/);
  assert.match(worker, /if \(!harnessEnabled\) return \{ error: "harness hooks are off" \};\n\s+if \(action === "start"\) \{\n\s+if \(!\(harnessVideoBackend === "WebGPU-Real" \|\| harnessVideoBackend === "WebGPU"\)\) return \{ error: `flicker watch/);
  const gates = await read("../harness/probes/replay-gates.mjs");
  assert.match(gates, /flicker: \{ type: "string", default: "0" \}/);
  assert.match(gates, /const found = findFlicker\(distinctRuns\(watch\), \{ cols: watch\.cols, rows: watch\.rows \}\);/);
  assert.match(worker, /if \(harnessFlicker\.active\) harnessFlicker\.noteOp\(op\);\n\s+let replayRecordAccepted = true;/);
  // nothing to judge: fatal on cpu=single only, reported on cpu=dual
  assert.match(gates, /if \(!found\.triples\) \{\n\s+const why = `flicker watch: no triple to judge[^\n]*\n\s+if \(flickerFatal\(o\.query, `\$\{o\.query\}\$\{o\.extra\}`\)\) throw new Error\(why\);\n\s+v\.flicker\.unjudged = why;/);
  assert.match(gates, /process\.exit\(failed\.length \|\| empty\.length \|\| summary\.integrity\.length \|\| flickerFails \? 1 : 0\);/);
  assert.match(gates, /!summary\.integrity\.length && !flickerFails \? 0 : 1\);/);
  assert.match(gates, /summary\.flickerFatal = flickerFatal\(o\.query, `\$\{o\.query\}\$\{o\.extra\}`\);\nconst flickerFails = summary\.flickerFatal \? summary\.flicker\.length : 0;/);
});

test("a flagged picture says where it changed and what the stream did before it", async () => {
  const { changedRegion } = await import("../harness/lib/flicker.mjs");
  // 4 x 2 cells; B differs in the top-right cell only
  assert.deepEqual(changedRegion(Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0]), Uint8Array.from([0, 0, 0, 99, 0, 0, 0, 0]), 4, 2),
    { top: 0, bottom: 0.5, left: 0.75, right: 1, changed: 0.125 });
  assert.equal(changedRegion(Uint8Array.from([5, 5]), Uint8Array.from([6, 6]), 2, 1), null, "under the threshold");
  const frames = [sig(50), sig(50), sig(50, 3, 0), sig(50)].map((s, seq) => ({ seq, at: seq * 16, b64: b64(s), ops: { uploadTexture: seq, blitTexture: 1 } }));
  const found = findFlicker(distinctRuns({ frames }), { cols: 8, rows: 1 });
  assert.equal(found.flagged.length, 1);
  assert.deepEqual(found.flagged[0].ops, { A: { uploadTexture: 1, blitTexture: 2 }, B: { uploadTexture: 2, blitTexture: 1 }, C: { uploadTexture: 3, blitTexture: 1 } });
  assert.deepEqual(found.flagged[0].region, { top: 0, bottom: 1, left: 0.375, right: 0.5, changed: 0.125 });
  const { createFlickerRecorder, COUNTED_OPS } = await import("../src/harness-flicker.js");
  assert.equal(COUNTED_OPS[8], "uploadTexture");
  assert.equal(COUNTED_OPS[24], "blitTexture");
  const rec = createFlickerRecorder({ now: () => 0 });
  rec.start();
  rec.noteOp(8); rec.noteOp(8); rec.noteOp(24); rec.noteOp(3);
  rec.onPresent(() => ({ cols: 1, rows: 1, data: Uint8Array.from([1]) }), 7);
  rec.noteOp(19);
  rec.onPresent(() => ({ cols: 1, rows: 1, data: Uint8Array.from([2]) }), 8);
  const out = await rec.stop({ waitMs: 0 });
  assert.equal(out.frames[0].ops.uploadTexture, 2);
  assert.equal(out.frames[0].ops.blitTexture, 1);
  assert.equal(out.frames[1].ops.draw, 1);
  assert.equal(out.frames[1].ops.uploadTexture, 0);
  assert.deepEqual(out.frames.map((f) => f.vi), [7, 8]);
});

test("A-B-A fails a run only on the deterministic CPU, both sides", async () => {
  const { flickerFatal } = await import("../harness/lib/flicker.mjs");
  assert.equal(flickerFatal("video=wgpu&cpu=single", "video=wgpu&cpu=single&metrics=1"), true);
  assert.equal(flickerFatal("video=wgpu&cpu=dual"), false);
  assert.equal(flickerFatal("video=wgpu"), false);
});
