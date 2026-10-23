import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// ?wgpumask=a,b (harness only): the WebGPU device is created without those
// optional features, as on a browser that lacks them (Safari 26: no
// dual-source-blending, no WGSL clip_distances). Dolphin then takes its
// no_dual_src path; harness/matrices/wgpu-features.json compares it with the
// exact software renderer.
const read = (p) => readFile(new URL(p, import.meta.url), "utf8");

test("?wgpumask reaches the worker and filters the requested features", async () => {
  const [host, adapter, worker] = await Promise.all(
    ["../src/core-host.js", "../src/upstream-worker-adapter.js", "../src/upstream-discio-worker.js"].map(read)
  );
  assert.match(host, /get\("wgpumask"\) \?\? ""/);
  assert.match(host, /wgpuMask: this\.wgpuMask,/);
  assert.match(adapter, /this\.wgpuMask = String\(wgpuMask \|\| ""\);/);
  assert.match(adapter, /wgpuMask: this\.wgpuMask,/);
  assert.match(worker, /wgpuMask: payload\.wgpuMask,/);
  assert.match(worker, /wgpuMaskedFeatures = parseWgpuMask\(wgpuMask\);/);
  assert.match(worker, /\.filter\(\(f\) => !wgpuMaskedFeatures\.has\(f\)\);/);
  // The dual-source renderer bit follows the device, so a masked device
  // tells the core it has no dual-source blending.
  assert.match(worker, /renderGpu\?\.device\?\.features\?\.has\?\.\("dual-source-blending"\)/);
});

test("the mask parses a comma list, ignoring blanks", async () => {
  const worker = await read("../src/upstream-discio-worker.js");
  const body = worker.match(/export function parseWgpuMask\(mask\) \{\n([\s\S]*?)\n\}/)[1];
  const parseWgpuMask = new Function("mask", body);
  assert.deepEqual([...parseWgpuMask("dual-source-blending, clip-distances,")], ["dual-source-blending", "clip-distances"]);
  assert.deepEqual([...parseWgpuMask("")], []);
  assert.deepEqual([...parseWgpuMask(undefined)], []);
});

test("the features matrix compares the masked devices with the exact software renderer", async () => {
  const m = JSON.parse(await read("../harness/matrices/wgpu-features.json"));
  assert.equal(m.reference, "sw-exact");
  assert.equal(m.configs.find((c) => c.id === "sw-exact").set.fastsw, "0");
  assert.equal(m.configs.find((c) => c.id === "wgpu-nodualsrc").set.wgpumask, "dual-source-blending");
  assert.ok(m.games.every((g) => g.set?.cpu === "single"), "cross-renderer checks need cpu=single");
  assert.ok(m.games.some((g) => g.id === "dstalpha"));
});
