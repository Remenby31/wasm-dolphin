import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  displayFilterFits,
  displayFilterOutputSize,
  displayFilterPlan,
  easuConstants,
  normalizeDisplayFilter,
  rcasSharpnessStops,
  requestedDisplayFilter
} from "../src/wgpu-display-filter.js";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("?fsr= and ?displayfit= parse to the filter's state; any sharpness fits the canvas to the display", () => {
  assert.deepEqual(requestedDisplayFilter(""), { sharpness: "off", fit: false, box: null });
  assert.deepEqual(requestedDisplayFilter("?fsr=light"), { sharpness: "light", fit: false, box: null });
  assert.deepEqual(requestedDisplayFilter("?fsr=2"), { sharpness: "strong", fit: false, box: null });
  // Sharpness implies the fit; turned off again, the fit goes with it.
  assert.equal(displayFilterFits({ sharpness: "light", fit: false }), true);
  assert.equal(displayFilterFits({ sharpness: "off", fit: false }), false);
  assert.equal(displayFilterFits({ sharpness: "off", fit: true }), true);
  assert.deepEqual(requestedDisplayFilter("?displayfit=1"), { sharpness: "off", fit: true, box: null });
  assert.deepEqual(requestedDisplayFilter("?fsr=max&displayfit=yes"), { sharpness: "off", fit: false, box: null });
  assert.deepEqual(normalizeDisplayFilter({ sharpness: "off", fit: true, box: { width: 1600.4, height: 1200 } }),
    { sharpness: "off", fit: true, box: { width: 1600, height: 1200 } });
  assert.equal(normalizeDisplayFilter({ box: { width: 0, height: 10 } }).box, null);
  assert.deepEqual(["off", "light", "strong"].map(rcasSharpnessStops), [null, 1, 0.2]);
});

test("the canvas is the display box at the backbuffer's aspect, capped; no box keeps the backbuffer", () => {
  const bb = { width: 640, height: 480 };
  assert.deepEqual(displayFilterOutputSize(bb, null), { width: 640, height: 480 });
  assert.deepEqual(displayFilterOutputSize(bb, { width: 2560, height: 1920 }), { width: 2560, height: 1920 });
  // A box a pixel off the aspect (device-pixel rounding): the box itself.
  assert.deepEqual(displayFilterOutputSize(bb, { width: 1601, height: 1200 }), { width: 1601, height: 1200 });
  // A wider box (the page stretches or letterboxes): fitted inside it.
  assert.deepEqual(displayFilterOutputSize(bb, { width: 3000, height: 1200 }), { width: 1600, height: 1200 });
  assert.deepEqual(displayFilterOutputSize(bb, { width: 8000, height: 6000 }, { maxSide: 5120 }), { width: 5120, height: 3840 });
  assert.deepEqual(displayFilterOutputSize({ width: 854, height: 480 }, { width: 1920, height: 1080 }), { width: 1920, height: 1080 });
  assert.equal(displayFilterOutputSize({ width: 0, height: 480 }, null), null);
});

test("plans: EASU up, area down, RCAS by sharpness, a copy when nothing is to be done", () => {
  const s = { width: 640, height: 480 };
  assert.deepEqual(displayFilterPlan(s, { width: 640, height: 480 }, "off"), { scale: null, rcas: null });
  assert.deepEqual(displayFilterPlan(s, { width: 640, height: 480 }, "strong"), { scale: null, rcas: 0.2 });
  assert.deepEqual(displayFilterPlan(s, { width: 1280, height: 960 }, "light"), { scale: "easu", rcas: 1 });
  assert.deepEqual(displayFilterPlan({ width: 1920, height: 1440 }, { width: 1280, height: 960 }, "off"), { scale: "area", rcas: null });
  // Larger on one side only: not an upscale.
  assert.equal(displayFilterPlan(s, { width: 700, height: 470 }, "off").scale, "area");
});

test("EASU constants are FsrEasuCon's for the whole source", () => {
  const c = Array.from(easuConstants(640, 480, 1280, 960));
  const expected = [0.5, 0.5, -0.25, -0.25, 1 / 640, 1 / 480, 1 / 640, -1 / 480, -1 / 640, 2 / 480, 1 / 640, 2 / 480, 0, 4 / 480, 0, 0];
  c.forEach((v, i) => assert.ok(Math.abs(v - expected[i]) < 1e-6, `con[${i}] ${v} vs ${expected[i]}`));
});

// Every page option reaches the worker only if the host, the adapter and the
// worker's load each forward it (?aotsample= and ?wasmengine= were dropped
// once).
test("the display filter reaches the worker through the host, the adapter and the load; setDisplayFilter later", async () => {
  const { UpstreamWorkerAdapter } = await import("../src/upstream-worker-adapter.js");
  const adapter = new UpstreamWorkerAdapter({ displayFilter: { sharpness: "light", fit: false, box: null } });
  assert.deepEqual(adapter.displayFilter, { sharpness: "light", fit: false, box: null });
  assert.equal(new UpstreamWorkerAdapter().displayFilter, null);
  assert.deepEqual(await adapter.setDisplayFilter({ box: { width: 10, height: 10 } }), { applied: false, reason: "core-not-loaded" });
  const sent = [];
  adapter.loaded = true;
  adapter.request = async (type, payload) => { sent.push([type, payload]); return { applied: true }; };
  await adapter.setDisplayFilter({ sharpness: "strong" });
  assert.deepEqual(sent, [["setDisplayFilter", { sharpness: "strong", fit: false, box: { width: 10, height: 10 } }]]);
  const host = await read("../src/core-host.js");
  assert.match(host, /\n {12}displayFilter: this\.displayFilter,\n/);
  const adapterSource = await read("../src/upstream-worker-adapter.js");
  assert.match(adapterSource, /\n {6}displayFilter: this\.displayFilter,\n/);
  const worker = await read("../src/upstream-discio-worker.js");
  assert.match(worker, /\n {8}displayFilter: payload\.displayFilter,\n/);
  assert.match(worker, /setWgpuDisplayFilter\(displayFilter \?\? \{\}\);/);
  assert.match(worker, /case "setDisplayFilter":/);
});

// The pooled frame textures stay at the backbuffer (the stream is captured
// from them), only the canvas follows the display; off, the canvas is the
// backbuffer and the present a copy, as before.
test("worker: frames at the backbuffer size, the canvas at the display size only with the filter on", async () => {
  const worker = await read("../src/upstream-discio-worker.js");
  assert.match(worker, /acquireWgpuVsyncTexture\(\.\.\.wgpuBackbufferSize\(\)\)/);
  assert.match(worker, /return wgpuPresentVsync && hardwareVideoBackend && displayFilterFits\(wgpuDisplayFilter\);/);
  assert.match(worker, /if \(wgpuDisplayFilterActive\(\)\) \{[\s\S]{0,400}wgpuDisplayFilterGpu\.encode\(enc, f\.tex, dst, wgpuDisplayFilter\.sharpness\);\n {2}\} else \{\n {4}enc\.copyTextureToTexture\(/);
  assert.match(worker, /const size = wgpuDisplayFilterActive\(\)\n {6}\? displayFilterOutputSize\(/);
});
