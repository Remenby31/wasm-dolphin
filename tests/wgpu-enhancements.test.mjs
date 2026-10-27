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
  assert.match(worker, /dolphinEfbScale: \(wgpuInternalResolution = clampInternalResolution\(internalResolution, wgpuScaleCeiling\(\)\)\),/);
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
  assert.match(worker, /if \(!resizeCanvasBackbuffer\(renderCanvas, renderGpu, width, height, usage\)\) return;/);
  assert.match(worker, /case "setEnhancements": \{[^]*?_DolphinWeb_SetEnhancements/);
  const patch = await read("../patches/dolphin-wasm/snapshot/0168-webgpu-internal-resolution.patch");
  assert.match(patch, /\+  BackbufferSize = 29,/);
  assert.match(patch, /\+  return \{640 \* scale, 480 \* scale, 1\.0f, AbstractTextureFormat::BGRA8\};/);
  assert.match(patch, /PushBackbufferSize\(surface\.width, surface\.height\)/);
  // Never at 1x: the canvas starts at 640x480, and the semantic capture
  // (?wgpusemanticruntime) refuses opcodes it does not know.
  assert.match(patch, /\+  u32 m_announced_backbuffer_w = 640;\n\+  u32 m_announced_backbuffer_h = 480;/);
  assert.match(patch, /g_presenter->SetBackbuffer\(GetSurfaceInfo\(\)\)/);
});

test("resizeCanvasBackbuffer: the same size is a no-op, another size resizes and reconfigures once", async () => {
  const { resizeCanvasBackbuffer } = await import("../src/wgpu-enhancements.js");
  const configured = [];
  const canvas = { width: 640, height: 480 };
  const gpu = { context: { configure: (c) => configured.push(c) }, device: "dev", format: "bgra8unorm", canvasWidth: 640, canvasHeight: 480 };
  assert.equal(resizeCanvasBackbuffer(canvas, gpu, 640, 480, 16), false);
  assert.equal(configured.length, 0);
  assert.equal(resizeCanvasBackbuffer(canvas, gpu, 1280, 960, 16), true);
  assert.deepEqual([canvas.width, canvas.height, gpu.canvasWidth, gpu.canvasHeight], [1280, 960, 1280, 960]);
  assert.deepEqual(configured, [{ device: "dev", format: "bgra8unorm", alphaMode: "opaque", usage: 16 }]);
  assert.equal(resizeCanvasBackbuffer(canvas, gpu, 1280, 960, 16), false);
  for (const bad of [[0, 480], [640, NaN]]) assert.equal(resizeCanvasBackbuffer(canvas, gpu, ...bad, 16), false);
  assert.equal(resizeCanvasBackbuffer(null, gpu, 640, 480, 16), false);
  assert.equal(configured.length, 1);
});

test("the worker hands the core a normalized scale and log2 anisotropy, whatever the message carries", async () => {
  const { enhancementCoreArgs } = await import("../src/wgpu-enhancements.js");
  assert.deepEqual(enhancementCoreArgs({ internalResolution: 3, maxAnisotropy: 4 }), [3, 4]);
  for (const p of [{}, { internalResolution: 5, maxAnisotropy: 5 }, { internalResolution: "x", maxAnisotropy: 2.5 }, null]) {
    assert.deepEqual(enhancementCoreArgs(p), [1, -1], JSON.stringify(p));
  }
});

// The page speaks multipliers (?aniso=16, setEnhancements({ anisotropy: 16 })),
// the core log2: one conversion, in core-host.
test("core-host's setEnhancements takes the anisotropy as a multiplier, like ?aniso=", async () => {
  const host = await read("../src/core-host.js");
  assert.match(host, /async setEnhancements\(\{ internalResolution, anisotropy \} = \{\}\)/);
  assert.match(host, /this\.enhancements\.maxAnisotropy = anisotropyToCore\(anisotropy\);/);
  const worker = await read("../src/upstream-discio-worker.js");
  assert.match(worker, /const internalResolution = set\(\.\.\.enhancementCoreArgs\(payload, wgpuScaleCeiling\(\)\)\);/);
});

// A worker reused for another disc (mountGame reloads into the same worker):
// played at 2x (canvas 1280x960), then a disc booted at 1x. The new core
// announces nothing at 640x480, so the worker brings its canvas back before
// the boot, or the frame lands in the top-left quarter.
test("a reused worker brings the canvas back to 640x480 before the next disc boots", async () => {
  const { BOOT_BACKBUFFER, bootBackbufferResize, resizeCanvasBackbuffer } = await import("../src/wgpu-enhancements.js");
  const canvas = { width: 1280, height: 960 };
  const gpu = { context: { configure() {} }, device: "dev", format: "bgra8unorm", canvasWidth: 1280, canvasHeight: 960 };
  const size = bootBackbufferResize(canvas);
  assert.deepEqual(size, [640, 480]);
  assert.equal(resizeCanvasBackbuffer(canvas, gpu, ...size, 16), true);
  assert.deepEqual([canvas.width, canvas.height], [...BOOT_BACKBUFFER]);
  assert.equal(bootBackbufferResize(canvas), null);
  assert.equal(bootBackbufferResize(null), null);
  const worker = await read("../src/upstream-discio-worker.js");
  assert.match(worker, /async function mountFile\(file\) \{[^]*?resetWgpuBackbufferForBoot\(\);\n  await ensureUserDataReady\(\);/);
  assert.match(worker, /function resetWgpuBackbufferForBoot\(\) \{[^]*?wgpuBackbufferSized = false;\n\}/);
  const patch = await read("../patches/dolphin-wasm/snapshot/0168-webgpu-internal-resolution.patch");
  assert.match(patch, new RegExp(`m_announced_backbuffer_w = ${BOOT_BACKBUFFER[0]};[^]*m_announced_backbuffer_h = ${BOOT_BACKBUFFER[1]};`));
});

// Follow-up of 0168, point 1: a ceiling per adapter class, the same rule for
// the page (core-host, the site) and the worker.
test("the internal resolution ceiling goes by adapter class and limits", async () => {
  const { internalResolutionCeiling, clampInternalResolution } = await import("../src/wgpu-enhancements.js");
  const gpu = (vendor, architecture, limits = {}, extra = {}) => ({
    info: { vendor, architecture },
    limits: { maxTextureDimension2D: 16384, maxBufferSize: 4294967292, ...limits },
    ...extra
  });
  const cases = [
    [null, {}, 1, "no-adapter"],
    [gpu("google", "swiftshader"), {}, 1, "cpu-adapter"],
    [gpu("apple", "metal-3", {}, { isFallbackAdapter: true }), {}, 1, "cpu-adapter"],
    [{ info: { vendor: "x", isFallbackAdapter: true } }, {}, 1, "cpu-adapter"],
    [gpu("apple", "metal-3"), { deviceMemory: 32 }, 4, "adapter"],
    // Safari has no deviceMemory: an iPhone or an iPad reads as a Mac.
    [gpu("apple", "metal-3"), {}, 2, "apple-without-memory"],
    [gpu("nvidia", "ampere"), {}, 4, "adapter"],
    // Dawn's exact Intel names (gpu_info.json): Arc Alchemist "gen-12hp",
    // Battlemage "xe-2hpg"; integrated gen-*, *lp*.
    ...["gen-12hp", "xe-2hpg", ""].map((a) => [gpu("intel", a), { deviceMemory: 16 }, 4, "adapter"]),
    ...["gen-7", "gen-8", "gen-9", "gen-11", "gen-12lp", "xe-lpg", "xe-2lpg", "xe-3lpg", "xe-3lpg-xs"]
      .map((a) => [gpu("intel", a), { deviceMemory: 16 }, 2, "integrated-gpu"]),
    ...["qualcomm", "arm", "img-tec", "huawei", "verisilicon"].map((v) => [gpu(v, ""), { deviceMemory: 8 }, 2, "mobile-gpu"]),
    [gpu("apple", "metal-3", { maxBufferSize: 268435456 }), { deviceMemory: 16 }, 2, "small-adapter"],
    [gpu("apple", "metal-3", { maxTextureDimension2D: 2048 }), { deviceMemory: 16 }, 3, "texture-limit"],
    [gpu("apple", "metal-3"), { deviceMemory: 4 }, 2, "device-memory"],
    [gpu("apple", "metal-3"), { deviceMemory: 2 }, 1, "device-memory"],
    [gpu("intel", "gen-12lp"), { deviceMemory: 2 }, 1, "device-memory"],
    [{ info: {} }, {}, 4, "adapter"]
  ];
  for (const [adapter, options, ceiling, reason] of cases) {
    assert.deepEqual(internalResolutionCeiling(adapter, options), { ceiling, reason }, JSON.stringify([adapter, options]));
  }
  assert.deepEqual([[4, 2], [2, 4], [3, 1], [9, 4], [4, "x"], [4, undefined]].map(([v, c]) => clampInternalResolution(v, c)),
    [2, 2, 1, 1, 1, 4]);
});

test("the worker holds the scale to its adapter's ceiling, at boot and in game", async () => {
  const { enhancementCoreArgs } = await import("../src/wgpu-enhancements.js");
  assert.deepEqual(enhancementCoreArgs({ internalResolution: 4, maxAnisotropy: 4 }, 2), [2, 4]);
  assert.deepEqual(enhancementCoreArgs({ internalResolution: 3 }, 1), [1, -1]);
  const worker = await read("../src/upstream-discio-worker.js");
  assert.match(worker, /set\(\.\.\.enhancementCoreArgs\(payload, wgpuScaleCeiling\(\)\)\)/);
  assert.match(worker, /wgpuScaleAdapterCeiling = scaleCeiling\.ceiling;/);
  // A device lost above 1x: 1x for the rest of the worker, and the page told.
  assert.match(worker, /if \(internalResolution > 1\) wgpuScaleLostCeiling = 1;/);
  assert.match(worker, /wgpuFatalReporter\.report\(\{ internalResolution, reason: String\(info\?\.reason \?\? "unknown"\)/);
});

// Point 2: a device lost at N > 1 comes back at 1x, not at N again.
test("a device lost above 1x brings the host back to 1x for its next boot and every change", async () => {
  const { UpstreamWorkerAdapter } = await import("../src/upstream-worker-adapter.js");
  const seen = [];
  const adapter = new UpstreamWorkerAdapter({ onGpuDeviceLost: (e) => seen.push(e) });
  adapter.handleMessage({ type: "wgpu-device-lost", internalResolution: 4, reason: "unknown", detail: "oom" });
  assert.deepEqual(seen, [{ internalResolution: 4, reason: "unknown", detail: "oom" }]);

  const { EmulatorHost } = await import("../src/core-host.js");
  const lost = [];
  const host = {
    internalResolutionCeiling: EmulatorHost.prototype.internalResolutionCeiling,
    enhancements: { internalResolution: 4, maxAnisotropy: -1 },
    scaleLostCeiling: 4,
    scaleCeilingPromise: Promise.resolve({ ceiling: 4, reason: "adapter" }),
    mode: "dolphin",
    onStatus: () => {},
    onGpuDeviceLost: (e) => lost.push(e),
    adapter: { setEnhancements: async (e) => ({ applied: true, internalResolution: e.internalResolution }) }
  };
  const call = (name, ...args) => EmulatorHost.prototype[name].apply(host, args);
  assert.deepEqual(await call("internalResolutionCeiling"), { ceiling: 4, reason: "adapter" });
  // The worker's adapter, once known, wins over the page's guess.
  host.workerScaleCeiling = { ceiling: 2, reason: "integrated-gpu" };
  assert.deepEqual(await call("internalResolutionCeiling"), { ceiling: 2, reason: "integrated-gpu" });
  const seenCeiling = [];
  new UpstreamWorkerAdapter({ onScaleCeiling: (c) => seenCeiling.push(c) }).handleMessage({ type: "wgpu-scale-ceiling", ceiling: 2, reason: "integrated-gpu" });
  assert.deepEqual(seenCeiling, [{ ceiling: 2, reason: "integrated-gpu" }]);
  host.workerScaleCeiling = null;
  call("handleGpuDeviceLost", { internalResolution: 4, reason: "unknown", detail: "oom" });
  assert.deepEqual(lost, [{ internalResolution: 4, fallback: 1, reason: "unknown", detail: "oom" }]);
  assert.equal(host.enhancements.internalResolution, 1);
  assert.deepEqual(await call("internalResolutionCeiling"), { ceiling: 1, reason: "device-lost" });
  assert.deepEqual(await call("setEnhancements", { internalResolution: 3 }), { applied: true, internalResolution: 1 });
  // Lost at 1x: no fallback to offer, the ceiling stays.
  const host1 = { ...host, enhancements: { internalResolution: 1 }, scaleLostCeiling: 4, onGpuDeviceLost: (e) => lost.push(e) };
  EmulatorHost.prototype.handleGpuDeviceLost.call(host1, { internalResolution: 1 });
  assert.equal(lost.at(-1).fallback, null);
  assert.equal(host1.scaleLostCeiling, 4);
});

// Follow-up of 0168, point 3: the heap headroom at 4x needs malloc's own
// figures; a diagnostics request only (harness hooks), never per frame.
test("the core reports malloc's use of the heap, read by a harness-only request", async () => {
  const core = await read("../core/upstream/dolphin_web_core.cpp");
  assert.match(core, /int DolphinWeb_HeapStats\(uint32_t\* out, int words\)/);
  assert.match(core, /const struct mallinfo info = mallinfo\(\);/);
  const worker = await read("../src/upstream-discio-worker.js");
  assert.match(worker, /case "validationHeapStats": \{\n(?: {6}\/\/[^\n]*\n)+ {6}if \(!harnessEnabled\) return \{ error: "harness hooks are off" \};/);
  assert.match(worker, /headroom: heapBytes - top \+ free/);
});
