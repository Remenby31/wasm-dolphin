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
  // Without flags the adapter is recorded (first run: a SwiftShader fallback, not null).
  assert.match(warp, /webgpu-adapter\.mjs --port \d+ --out webgpu-adapter-default\.json/);
});

test("the WARP matrix compares wgpu with the exact software renderer, single core", async () => {
  const m = JSON.parse(await read("../harness/matrices/windows-warp.json"));
  assert.equal(m.reference, "sw-exact");
  assert.equal(m.configs.find((c) => c.id === "sw-exact").set.fastsw, "0");
  assert.ok(m.configs.some((c) => c.preset === "wgpu-nojit"));
  assert.ok(m.games.every((g) => g.set?.cpu === "single"));
  assert.ok(m.games.every((g) => g.iso.startsWith("harness/homebrew/out/")), "homebrews only, no ROM");
});
