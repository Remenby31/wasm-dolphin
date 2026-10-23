import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Patch 0136: a constant destination alpha blended by the TEV alpha needs
// dual-source blending; without it (Safari's WebGPU, or a WebGPU shader that
// writes depth) VertexManagerBase draws it in two passes. The pictures are
// checked by harness/matrices/wgpu-features.json (dstalpha, dstalpha-coplanar).
const read = (p) => readFile(new URL(p, import.meta.url), "utf8");

test("patch 0136 draws destination alpha in two passes when dual-source blending is dropped", async () => {
  const patch = await read("../patches/dolphin-wasm/snapshot/0136-dst-alpha-two-pass.patch");
  const added = patch.split("\n").filter((l) => l.startsWith("+")).join("\n");
  // When: dst alpha, a blend that reads the source alpha, and no dual source for this pipeline.
  assert.match(added, /ps->useDstAlpha && config\.blending_state\.RequiresDualSrc\(\) &&\n\+\s*DualSourceBlendDropped\(ps\)/);
  assert.match(added, /if \(!g_backend_info\.bSupportsDualSourceBlend\)\n\+\s*return true;/);
  assert.match(added, /g_backend_info\.api_type == APIType::Vulkan && ps->per_pixel_depth/);
  // Pass 1: TEV alpha in ocol0.a, colour only. Pass 2: the constant, alpha only, no blend.
  assert.match(added, /color\.ps_uid\.GetUidData\(\)->useDstAlpha = false;\n\+\s*color\.blending_state\.alpha_update = false;/);
  assert.match(added, /alpha\.blending_state\.blend_enable = false;\n\+\s*alpha\.blending_state\.color_update = false;/);
  assert.match(added, /alpha\.depth_state\.func = CompareMode::Equal;/);
  assert.match(added, /alpha\.depth_state\.update_enable = false;/);
  // The second draw reuses the committed vertices, outside the perf query.
  assert.match(added, /g_gfx->SetPipeline\(dst_alpha_pipeline\);\n\+\s*DrawCurrentBatch\(base_index, m_index_generator\.GetIndexLen\(\), base_vertex\);/);
});

test("the features matrix covers the coplanar (per-pixel depth) case", async () => {
  const m = JSON.parse(await read("../harness/matrices/wgpu-features.json"));
  assert.ok(m.games.some((g) => g.id === "dstalpha-coplanar" && g.set?.cpu === "single"));
  const make = await read("../harness/homebrew/Makefile");
  assert.match(make, /-DDSTALPHA_COPLANAR/);
});
