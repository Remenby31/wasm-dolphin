import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// .github/workflows/windows-nogpu.yml: what a player's Chrome does on a
// GPU-less PC, on a GitHub Windows runner. Runs 1-3 (2026-10-23): no adapter
// without flags; a SwiftShader fallback adapter (wgpu device lost, never
// WARP) with --enable-unsafe-webgpu, the harness default.
const read = (p) => readFile(new URL(p, import.meta.url), "utf8");

test("the Windows no-GPU workflow is manual, pinned, and checks the no-flag adapter", async () => {
  const wf = await read("../.github/workflows/windows-nogpu.yml");
  const on = wf.match(/^on:\n((?:  .*\n)+)/m)[1];
  assert.match(on, /workflow_dispatch/);
  assert.doesNotMatch(on, /pull_request|push|schedule/);
  const job = wf.slice(wf.indexOf("\n  nogpu:"));
  assert.match(job, /runs-on: windows-/);
  for (const uses of wf.match(/uses: \S+/g)) assert.match(uses, /@[0-9a-f]{40}$/, `${uses} is pinned by SHA`);
  // A player's Chrome (without the harness's unsafe flag) gets no adapter.
  assert.match(job, /webgpu-adapter\.mjs --port \d+ --no-unsafe-webgpu --expect none/);
  // The effective presenter is asserted, and forced wgpu must fail.
  assert.match(job, /presenter-check\.mjs [^\n]*video=software&presenter=webgpu[^\n]*--expect-presenter webgl/);
  assert.match(job, /presenter-check\.mjs [^\n]*video=wgpu[^\n]*--expect-boot-error "needs a usable WebGPU adapter"/);
  // No step adds Chrome flags of its own.
  assert.doesNotMatch(wf, /HARNESS_CHROME_ARGS/);
});

test("the no-GPU matrix runs the product's software path with both presenter fallbacks", async () => {
  const m = JSON.parse(await read("../harness/matrices/windows-nogpu.json"));
  assert.equal(m.reference, "sw-product");
  assert.deepEqual(m.configs.map((c) => c.preset), ["sw-interp", "sw-interp"]);
  assert.equal(m.configs.find((c) => c.id === "sw-2d").set.presenter, "2d");
  assert.ok(m.games.every((g) => g.set?.cpu === "single"));
  assert.ok(m.games.every((g) => g.iso.startsWith("harness/homebrew/out/")), "homebrews only, no ROM");
});

// A CPU fallback adapter (SwiftShader, with --enable-unsafe-webgpu) is no
// usable GPU for the app; only the harness keeps it (?wgpufallback=1).
test("a fallback WebGPU adapter counts as none unless the harness asks for it", async () => {
  const [host, adapter, worker] = await Promise.all(
    ["../src/core-host.js", "../src/upstream-worker-adapter.js", "../src/upstream-discio-worker.js"].map(read)
  );
  const body = worker.match(/export function isFallbackAdapterInfo\(info\) \{\n([\s\S]*?)\n\}/)[1];
  const isFallbackAdapterInfo = new Function("info", body);
  assert.equal(isFallbackAdapterInfo({ isFallbackAdapter: true, vendor: "google", architecture: "swiftshader" }), true);
  assert.equal(isFallbackAdapterInfo({ isFallbackAdapter: false, architecture: "swiftshader" }), true);
  assert.equal(isFallbackAdapterInfo({ isFallbackAdapter: false, vendor: "apple", architecture: "metal-3" }), false);
  assert.equal(isFallbackAdapterInfo(null), false);
  assert.match(worker, /if \(isFallbackAdapterInfo\(adapter\.info\) && !wgpuAcceptFallbackAdapter\) \{\n[^\n]*\n\s*throw new Error/);
  assert.match(host, /get\("wgpufallback"\) === "1"/);
  assert.match(adapter, /wgpuFallback: this\.wgpuFallback,/);
  assert.match(worker, /wgpuFallback: payload\.wgpuFallback,/);
  // video=wgpu without this worker's device fails before the core starts (the
  // core would otherwise take the refused fallback adapter itself).
  const guard = worker.indexOf('if (videoBackend === "WebGPU-Real" && !renderGpu && !isIntentionalBlankWgpuProbe(wgpuRendererWorkerProbe))');
  assert.ok(guard > 0, "video=wgpu guard present");
  assert.ok(guard < worker.indexOf("moduleInstance = await factory("), "the guard runs before the core module is created");
  assert.match(worker.slice(guard, guard + 600), /throw new Error\(message\)/);
});
