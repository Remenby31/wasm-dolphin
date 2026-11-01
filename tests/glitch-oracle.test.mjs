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
