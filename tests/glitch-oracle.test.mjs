import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { diffFrame, exactVerdict, oracleQueryError, ORACLE_REFERENCE_PARAMS, referenceQuery, referenceSwitchesOn } from "../harness/lib/glitch-oracle.mjs";

const read = (p) => readFile(new URL(p, import.meta.url), "utf8");
const allOff = { geometryCacheMode: 0, geometryPackEnabled: false, geometryRangeEnabled: false, uboPackEnabled: false, uboCacheEnabled: false, bindGroupCacheEnabled: false, stateCacheEnabled: false };

test("the reference forces every cache and grouping off, whatever the query asked", () => {
  const q = new URLSearchParams(referenceQuery("core=upstream&video=wgpu&cpu=single&wgpugeomcache=1&wgpuubopack=1"));
  for (const [k, v] of Object.entries(ORACLE_REFERENCE_PARAMS)) assert.equal(q.get(k), v, k);
  assert.equal(q.get("cpu"), "single");
  assert.equal(q.getAll("wgpugeomcache").length, 1);
});

test("the oracle needs the deterministic CPU and WebGPU", () => {
  assert.equal(oracleQueryError("video=wgpu&cpu=single"), null);
  assert.match(oracleQueryError("video=wgpu&cpu=dual"), /cpu=single/);
  assert.match(oracleQueryError("video=wgpu"), /cpu=single/);
  assert.match(oracleQueryError("cpu=single&video=ogl"), /video=wgpu/);
});

test("a reference is checked against what the replay runs, never assumed", () => {
  assert.deepEqual(referenceSwitchesOn(allOff), []);
  assert.deepEqual(referenceSwitchesOn({ ...allOff, geometryCacheMode: 2, uboPackEnabled: true }), ["geometryCacheMode", "uboPackEnabled"]);
  assert.deepEqual(referenceSwitchesOn({ ...allOff, bindGroupCacheEnabled: undefined }), ["bindGroupCacheEnabled (not reported)"]);
  assert.deepEqual(referenceSwitchesOn(null), ["runtime config unread"]);
});

test("verdict: 0 pixels apart at every VI, a reference that agrees with itself", () => {
  const visit = (side, h) => ({ side, hashes: h });
  const vis = ["240", "600"];
  const pass = exactVerdict([visit("base", { 240: "a", 600: "b" }), visit("candidate", { 240: "a", 600: "b" }), visit("candidate", { 240: "a", 600: "b" }), visit("base", { 240: "a", 600: "b" })], vis);
  assert.equal(pass.pass, true);
  const differs = exactVerdict([visit("base", { 240: "a", 600: "b" }), visit("candidate", { 240: "a", 600: "x" }), visit("candidate", { 240: "a", 600: "b" })], vis);
  assert.equal(differs.pass, false);
  assert.deepEqual(differs.failures, ["VI 600: 1 default visit(s) differ from the reference"]);
  const unstable = exactVerdict([visit("base", { 240: "a" }), visit("base", { 240: "z" }), visit("candidate", { 240: "a" })], ["240"]);
  assert.match(unstable.failures[0], /reference itself differs/);
  const missing = exactVerdict([visit("base", { 240: "a" }), visit("candidate", { 240: null })], ["240"]);
  assert.match(missing.failures[0], /no reference or default frame/);
});

test("the difference image counts the pixels apart and shows them x8", () => {
  const frame = (px) => ({ width: 2, height: 1, data: new Uint8Array(px) });
  const d = diffFrame(frame([10, 10, 10, 255, 0, 0, 0, 255]), frame([10, 10, 10, 255, 0, 3, 0, 255]));
  assert.equal(d.pixels, 1);
  assert.deepEqual([...d.data], [0, 0, 0, 255, 0, 24, 0, 255]);
});

test("replay-gates --exact: reference read back, no input phase, images kept, exit 1 on any difference", async () => {
  const gates = await read("../harness/probes/replay-gates.mjs");
  assert.match(gates, /exact: \{ type: "boolean", default: false \}/);
  assert.match(gates, /const why = oracleQueryError\(o\.query\);\n\s+if \(why\) throw new Error\(why\);/);
  assert.match(gates, /side === "base" \? `\$\{referenceQuery\(o\.query\)\}&metrics=1` : `\$\{o\.query\}&metrics=1\$\{o\.extra\}`/);
  assert.match(gates, /const on = referenceSwitchesOn\(v\.runtimeConfig\);\n\s+if \(on\.length\) throw new Error/);
  assert.match(gates, /if \(!o\.exact\) \{\n\s+await sleep\(5000\);/);
  assert.match(gates, /savePng\(diff, path\.join\(o\.out, `mismatch-\$\{row\.vi\}-diff-x8\.png`\)\);/);
  assert.match(gates, /process\.exit\(verdict\.pass && !errors\.length && !summary\.integrity\.length && !flickerFails \? 0 : 1\);/);
  // the worker reports the two switches the reference needs read back
  const worker = await read("../src/upstream-discio-worker.js");
  const config = worker.slice(worker.indexOf("function wgpuRuntimeConfigPayload()"), worker.indexOf("function wgpuRuntimeConfigPayload()") + 3000);
  assert.match(config, /geometryCacheMode: wgpuGeometryCacheMode,/);
  assert.match(config, /bindGroupCacheEnabled: Boolean\(webGpuObjects\.bindGroupCache\),/);
});

test("the WebKit tolerance: defaults, and a bad spec refused before any run", async () => {
  const { parseWebkitTolerance, WEBKIT_TOLERANCE } = await import("../harness/lib/glitch-oracle.mjs");
  assert.deepEqual(parseWebkitTolerance(""), { ...WEBKIT_TOLERANCE });
  assert.deepEqual(parseWebkitTolerance("over=0.5%,big=0.01%,max=80"), { overLevel: 3, overShare: 0.005, bigLevel: 16, bigShare: 0.0001, maxLevel: 80 });
  assert.equal(parseWebkitTolerance("over=1%").maxLevel, 64);
  for (const bad of ["max=16", "max=64.5", "max=300", "over=0.5", "big=2", "over=150%", "foo=1", "max=64%"]) assert.throws(() => parseWebkitTolerance(bad), /--webkit-tolerance/, bad);
});

// Synthetic frames: a 2-D pattern (a texture), its blended-edge rounding,
// an isolated pixel, a block moved by 8 pixels, another texture.
const W = 1216, H = 896;
const texture = (f) => {
  const data = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) {
    const i = (y * W + x) * 4;
    data[i] = f(x, y); data[i + 1] = f(y, x); data[i + 2] = f(x + y, x - y); data[i + 3] = 255;
  }
  return { width: W, height: H, data };
};
const checker = (x, y) => ((x >> 3) + (y >> 3)) % 2 ? 200 : 40;

test("WebKit tolerance: blended edges ±3 pass, an isolated pixel at 17 passes", async () => {
  const { tolerantFrameVerdict } = await import("../harness/lib/glitch-oracle.mjs");
  const ref = texture(checker);
  const edges = texture(checker);
  // every checker edge (about a quarter of the pixels) rounded 1 to 3 levels
  for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) if (x % 8 === 0 || y % 8 === 0) edges.data[(y * W + x) * 4] += 1 + ((x + y) % 3);
  let v = tolerantFrameVerdict(ref, edges);
  assert.deepEqual([v.pass, v.max, v.over, v.big], [true, 3, 0, 0]);
  assert.ok(v.differ > W * H / 5);
  // what Safari gave at VI 600: 8 pixels over 3, one of them at 17
  for (let k = 0; k < 8; k += 1) edges.data[(k * 100 * W + 50) * 4 + 1] += k ? 5 : 17;
  v = tolerantFrameVerdict(ref, edges);
  assert.deepEqual([v.pass, v.max, v.over, v.big], [true, 17, 8, 1]);
});

test("WebKit tolerance: a block moved by 8 px or a wrong texture fails", async () => {
  const { tolerantFrameVerdict } = await import("../harness/lib/glitch-oracle.mjs");
  const ref = texture(checker);
  // one 8x8 block drawn 8 px to the right (the checker's other phase)
  const moved = texture(checker);
  for (let y = 400; y < 408; y += 1) for (let x = 600; x < 608; x += 1) for (let c = 0; c < 3; c += 1) moved.data[(y * W + x) * 4 + c] = ref.data[(y * W + x - 8) * 4 + c];
  let v = tolerantFrameVerdict(ref, moved);
  assert.equal(v.pass, false);
  assert.equal(v.big, 64);
  assert.match(v.failure, /a channel 160 levels apart/);
  // a wrong texture in a 64x64 corner (another pattern)
  const wrong = texture(checker);
  for (let y = 0; y < 64; y += 1) for (let x = 0; x < 64; x += 1) wrong.data[(y * W + x) * 4] = (x * 4) & 255;
  v = tolerantFrameVerdict(ref, wrong);
  assert.equal(v.pass, false);
  assert.match(v.failure, /more than 16 levels apart/);
  assert.match(tolerantFrameVerdict(ref, { width: 608, height: 448, data: new Uint8Array(608 * 448 * 4) }).failure, /internal resolution/);
});

test("--webkit-frames reference: one visit of 4 without its capture fails, never left out", async () => {
  const { webkitReferenceRow } = await import("../harness/lib/glitch-oracle.mjs");
  const visit = (h) => ({ side: "base", hashes: { 240: h } });
  assert.deepEqual(webkitReferenceRow([visit("a"), visit("a"), visit("a"), visit("a")], "240", 4), { vi: "240", reference: "a", failure: null });
  assert.match(webkitReferenceRow([visit("a"), visit(null), visit("a"), visit("a")], "240", 4).failure, /1 reference visit\(s\) of 4 without a frame/);
  assert.match(webkitReferenceRow([visit("a"), visit(null), visit(null), visit(null)], "240", 4).failure, /3 reference visit\(s\) of 4 without a frame/, "one survivor is not 'deterministic'");
  assert.match(webkitReferenceRow([visit("a"), visit("b"), visit("a"), visit("a")], "240", 4).failure, /not deterministic/);
  assert.match(webkitReferenceRow([visit("a"), visit("a")], "240", 4).failure, /2 reference visit\(s\) of 4/, "a visit that never ran");
});

test("replay-gates --webkit-frames: the reference row checks every visit, and a flicker fails the pass", async () => {
  const src = await read("../harness/probes/replay-gates.mjs");
  assert.match(src, /const row = webkitReferenceRow\(hashed, vi, perSide\)/);
  assert.match(src, /summary\.webkit\.pass = failures\.length === 0 && !summary\.integrity\.length && !flickerFails/);
});
