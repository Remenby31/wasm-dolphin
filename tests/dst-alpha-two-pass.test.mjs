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
  // Colour: TEV alpha in ocol0.a, alpha writes off, the game's depth state.
  assert.match(added, /p\.color\.ps_uid\.GetUidData\(\)->useDstAlpha = false;\n\+\s*p\.color\.blending_state\.alpha_update = false;/);
  // The constant: unblended, colour writes off, never writing depth.
  assert.match(added, /p\.alpha\.blending_state\.blend_enable = false;\n\+\s*p\.alpha\.blending_state\.color_update = false;\n\+\s*p\.alpha\.depth_state\.update_enable = false;/);
  // The constant goes first (the game's depth func, so strict tests and NEVER
  // hold), unless the colour blend reads the destination alpha.
  assert.match(added, /p\.alpha_first = !ReadsDstAlpha\(config\.blending_state\);/);
  assert.match(added, /if \(p\.alpha\.depth_state\.func == CompareMode::Never\)\n\+\s*p\.alpha_drawn = false;/);
  // Both extra draws reuse the committed vertices, outside the perf query, and count as draws.
  assert.match(added, /if \(dst_alpha_pipeline && dst_alpha_first\)\n\+\s*\{\n\+\s*g_gfx->SetPipeline\(dst_alpha_pipeline\);\n\+\s*DrawCurrentBatch\(base_index, m_index_generator\.GetIndexLen\(\), base_vertex\);\n\+\s*INCSTAT\(g_stats\.this_frame\.num_draw_calls\);/);
  assert.match(added, /if \(dst_alpha_pipeline && !dst_alpha_first\)/);
});

test("the features matrix covers the coplanar (per-pixel depth) case", async () => {
  const m = JSON.parse(await read("../harness/matrices/wgpu-features.json"));
  assert.ok(m.games.some((g) => g.id === "dstalpha-coplanar" && g.set?.cpu === "single"));
  const make = await read("../harness/homebrew/Makefile");
  assert.match(make, /-DDSTALPHA_COPLANAR/);
  assert.match(make, /-DDSTALPHA_ZINIT/);
  // Strict depth (LESS) and NEVER on a redrawn mesh (review of 0136).
  assert.match(make, /-DDSTALPHA_REDRAW/);
  assert.ok(m.games.some((g) => g.id === "dstalpha-redraw"));
  // No dstalpha case is an expected failure: the dual-source ones pass with
  // 0136, and dstalpha-zinit no longer reads the EFB's undefined initial depth.
  const known = JSON.parse(await read("../harness/known-failures.json"));
  assert.ok(!known.some((k) => k.cell.startsWith("dstalpha")));
});

test("dstalpha-zinit sets depth itself before its copies leave it alone", async () => {
  const src = await read("../harness/homebrew/dstalpha/main.c");
  // One copy with depth updates on clears depth to GX 0 before the loop ...
  assert.match(src, /#ifdef DSTALPHA_ZINIT\n[^#]*GX_SetCopyClear\(bg, 0\);\n\tGX_SetZMode\(GX_FALSE, GX_ALWAYS, GX_TRUE\);\n\tGX_CopyDisp\(/);
  // ... then the loop's copies clear to far with updates off: a backend that
  // ignored z_enable would let the LEQUAL rows through.
  assert.match(src, /GX_SetZMode\(GX_FALSE, GX_ALWAYS, GX_FALSE\);\n\tGX_SetCopyClear\(bg, 0x00ffffff\);/);
  const copyUpdates = src.match(/#if ([^\n]*)\n\t\t\/\* Depth updates on, so the copy clears depth/);
  assert.ok(copyUpdates && !copyUpdates[1].includes("DSTALPHA_ZINIT"));
});
