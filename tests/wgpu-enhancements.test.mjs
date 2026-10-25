import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  anisotropyFromCore,
  anisotropyToCore,
  normalizeInternalResolution,
  requestedEnhancements
} from "../src/wgpu-enhancements.js";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("?ir= and ?aniso= parse to the core's scale and log2 anisotropy, defaults native and the game's", () => {
  assert.deepEqual(requestedEnhancements(""), { internalResolution: 1, maxAnisotropy: -1 });
  assert.deepEqual(requestedEnhancements("?ir=3&aniso=16"), { internalResolution: 3, maxAnisotropy: 4 });
  assert.deepEqual(requestedEnhancements("?ir=4&aniso=1"), { internalResolution: 4, maxAnisotropy: 0 });
  for (const bad of ["0", "5", "2.5", "x", "-1"]) assert.equal(normalizeInternalResolution(bad), 1, bad);
  for (const bad of [0, 3, 32, "x", null]) assert.equal(anisotropyToCore(bad), -1, String(bad));
  assert.deepEqual([1, 2, 4, 8, 16].map(anisotropyToCore), [0, 1, 2, 3, 4]);
  assert.deepEqual([-1, 0, 2, 4, 5].map(anisotropyFromCore), [0, 1, 4, 16, 0]);
});

// Every page option reaches the worker only if the host, the adapter and the
// worker's init each forward it (?aotsample= and ?wasmengine= were dropped
// once). The worker hands both to the core as Module fields.
test("internal resolution and anisotropy reach the core through the host, the adapter and the worker (0168)", async () => {
  const { UpstreamWorkerAdapter } = await import("../src/upstream-worker-adapter.js");
  const adapter = new UpstreamWorkerAdapter({ internalResolution: 3, maxAnisotropy: 4 });
  assert.deepEqual([adapter.internalResolution, adapter.maxAnisotropy], [3, 4]);
  assert.deepEqual([new UpstreamWorkerAdapter().internalResolution, new UpstreamWorkerAdapter().maxAnisotropy], [1, -1]);
  const host = await read("../src/core-host.js");
  assert.match(host, /\n {12}internalResolution: this\.enhancements\.internalResolution,\n/);
  assert.match(host, /\n {12}maxAnisotropy: this\.enhancements\.maxAnisotropy,\n/);
  const adapterSource = await read("../src/upstream-worker-adapter.js");
  assert.match(adapterSource, /\n {6}internalResolution: this\.internalResolution,\n {6}maxAnisotropy: this\.maxAnisotropy,\n/);
  const worker = await read("../src/upstream-discio-worker.js");
  assert.match(worker, /\n {8}internalResolution: payload\.internalResolution,\n {8}maxAnisotropy: payload\.maxAnisotropy,\n/);
  assert.match(worker, /dolphinEfbScale: normalizeInternalResolution\(internalResolution\),/);
  assert.match(worker, /dolphinMaxAnisotropy: Number\.isInteger\(maxAnisotropy\) \? maxAnisotropy : -1,/);
  const core = await read("../core/upstream/dolphin_web_core.cpp");
  assert.match(core, /Module\['dolphinEfbScale'\]/);
  assert.match(core, /Module\['dolphinMaxAnisotropy'\]/);
  assert.match(core, /int DolphinWeb_SetEnhancements\(int efb_scale, int anisotropy\)/);
});

test("setEnhancements asks the worker while a game runs and keeps the values for the next boot", async () => {
  const { UpstreamWorkerAdapter } = await import("../src/upstream-worker-adapter.js");
  const adapter = new UpstreamWorkerAdapter();
  assert.deepEqual(await adapter.setEnhancements({ internalResolution: 2, maxAnisotropy: 3 }),
    { applied: false, reason: "core-not-loaded" });
  assert.deepEqual([adapter.internalResolution, adapter.maxAnisotropy], [2, 3]);
  const sent = [];
  adapter.loaded = true;
  adapter.request = async (type, payload) => { sent.push([type, payload]); return { applied: true, internalResolution: 4 }; };
  assert.deepEqual(await adapter.setEnhancements({ internalResolution: 4 }), { applied: true, internalResolution: 4 });
  assert.deepEqual(sent, [["setEnhancements", { internalResolution: 4, maxAnisotropy: -1 }]]);
});

// The canvas follows the backbuffer the core lays the presenter out on: the
// BackbufferSize command (29) resizes it, outside any pass. Without it a 2x
// frame would be averaged into a 640x480 canvas (or drawn in a quarter of it).
test("the worker resizes the canvas on the core's BackbufferSize command (0168)", async () => {
  const worker = await read("../src/upstream-discio-worker.js");
  assert.match(worker, /const WGPU_CMD_OP_BACKBUFFER_SIZE = 29;/);
  assert.match(worker, /case WGPU_CMD_OP_BACKBUFFER_SIZE:\n[^]*?resizeWgpuBackbuffer\(u32\[recWord \+ 1\], u32\[recWord \+ 2\]\);/);
  assert.match(worker, /case "setEnhancements": \{[^]*?_DolphinWeb_SetEnhancements/);
  const patch = await read("../patches/dolphin-wasm/snapshot/0168-webgpu-internal-resolution.patch");
  assert.match(patch, /\+  BackbufferSize = 29,/);
  assert.match(patch, /\+  return \{640 \* scale, 480 \* scale, 1\.0f, AbstractTextureFormat::BGRA8\};/);
  assert.match(patch, /PushBackbufferSize\(surface\.width, surface\.height\)/);
  assert.match(patch, /g_presenter->SetBackbuffer\(GetSurfaceInfo\(\)\)/);
});
