import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// .github/workflows/windows-warp.yml: WebGPU on D3D12 through WARP, on a
// GPU-less GitHub Windows runner. The unsafe flag must stay confined to that
// manual job, and the matrix must judge correctness only.
const read = (p) => readFile(new URL(p, import.meta.url), "utf8");

test("the Windows WARP workflow is manual and keeps --enable-unsafe-webgpu in its own job", async () => {
  const wf = await read("../.github/workflows/windows-warp.yml");
  const on = wf.match(/^on:\n((?:  .*\n)+)/m)[1];
  assert.match(on, /workflow_dispatch/);
  assert.doesNotMatch(on, /pull_request|push|schedule/);
  const warp = wf.slice(wf.indexOf("\n  warp:"));
  assert.equal(wf.split("--enable-unsafe-webgpu").length - 1 - (wf.match(/^#.*--enable-unsafe-webgpu/gm) ?? []).length,
    warp.split("--enable-unsafe-webgpu").length - 1, "the flag appears only in the warp job");
  assert.match(warp, /runs-on: windows-/);
  for (const uses of wf.match(/uses: \S+/g)) assert.match(uses, /@[0-9a-f]{40}$/, `${uses} is pinned by SHA`);
  // Without the harness's unsafe flag, the adapter a player's Chrome gets is recorded.
  assert.match(warp, /webgpu-adapter\.mjs --port \d+ --no-unsafe-webgpu --out webgpu-adapter-default\.json/);
});

test("the WARP matrix compares wgpu with the exact software renderer, single core", async () => {
  const m = JSON.parse(await read("../harness/matrices/windows-warp.json"));
  assert.equal(m.reference, "sw-exact");
  assert.equal(m.configs.find((c) => c.id === "sw-exact").set.fastsw, "0");
  assert.ok(m.configs.some((c) => c.preset === "wgpu-nojit"));
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
  const m = JSON.parse(await read("../harness/matrices/windows-warp.json"));
  assert.equal(m.configs.find((c) => c.id === "wgpu-interp").set.wgpufallback, "1");
});
