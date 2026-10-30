import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// 0203: geometry buffers left behind (a placement epoch: save load, reset,
// aborted pass; or a generation rotated out when full) are destroyed at the
// next pass end; a skipped draw no longer aborts the pass with the range on.
const patch = await readFile(
  new URL("../patches/dolphin-wasm/snapshot/0203-webgpu-retire-geometry-buffers.patch", import.meta.url),
  "utf8"
);

test("0203 retires the old geometry buffer at an epoch and when a generation rotates out", () => {
  assert.match(patch, /\+\s+if \(m_geometry_buffer_id != 0\)\n\+\s+m_retired_geometry_buffers\.push_back\(m_geometry_buffer_id\);\n\s+m_geometry_buffer_id = 0;/);
  assert.match(patch, /\+\s+if \(m_geometry_buffer_id != 0 && m_geometry_buffer_id != candidate_buffer_id\)\n\+\s+m_retired_geometry_buffers\.push_back\(m_geometry_buffer_id\);\n(?:\+\s+created\.kept = candidate_buffer_id;\n)?\s+m_geometry_buffer_id = candidate_buffer_id;/);
});

test("0203 destroys retired geometry buffers between passes only, keeping what the ring refused", () => {
  assert.match(patch, /\+static constexpr u32 kDestroyTagGeometryBuffer = 1;/);
  assert.match(patch, /\+\s+if \(!cs\.PushDestroy\(kDestroyTagGeometryBuffer, id\)\)\n\+\s+\*kept\+\+ = id;/);
  assert.match(patch, /\+\s+if \(m_pass_open \|\| !g_vertex_manager\)\n[ +]\s+return;/);
  // next to 0201/0202's, at both pass ends (abort and committed)
  assert.equal(patch.match(/DestroyRetiredTextures\(\);\n\+\s+DestroyRetiredGeometryBuffers\(\);/g)?.length, 2);
});

test("0203: a skipped draw returns without aborting the pass", () => {
  assert.equal(patch.match(/-\s+DiscardOrAbortPendingGeometryRange\(\);\n\+\s+\/\/ 0203: only this draw is skipped/g)?.length, 4);
  assert.match(patch, /-void WebGPUGfx::DiscardOrAbortPendingGeometryRange\(\)/);
});

test("0203: the lifecycle smoke bounds live geometry buffers over 20 save loads", () => {
  for (const code of [510, 511, 512, 513, 514, 515, 516]) assert.match(patch, new RegExp(`FailVertexManagerSmoke\\(${code},`));
  assert.match(patch, /for \(int load = 0; load < 19; \+\+load\)/);
  // a fresh ring before the destroys: no consumer drains the fixture
  assert.match(patch, /s_vertex_manager_smoke_fixture\.Reset\(\)\)\n\+\s+return FailVertexManagerSmoke\(514,[^\n]*\n\+\s+manager\.DestroyRetiredGeometryBuffers\(\);/);
});

test("0203: a buffer created for a batch that is never published is retired", () => {
  assert.match(patch, /\+\s+struct CreatedGeometryBuffers\n/);
  assert.match(patch, /\+\s+if \(id != 0 && id != kept\)\n\+\s+retired\.push_back\(id\);/);
  assert.match(patch, /\+\s+created\.ids\[0\] = candidate_buffer_id;/);
  assert.match(patch, /\+\s+created\.ids\[1\] = new_buffer_id;/);
  assert.match(patch, /\+\s+created\.kept = candidate_buffer_id;\n\s+m_geometry_buffer_id = candidate_buffer_id;/);
});

test("0203: the range smoke models a skipped draw as skipped alone (A's upload published before the pass)", () => {
  assert.match(patch, /FailVertexManagerSmoke\(612, "skipped draw B dropped draw A or its upload"\)/);
  assert.doesNotMatch(patch, /\+\s+stream\.AbortPass\(\);\n\+\s+skipped_manager\.DiscardPendingGeometryRange\(\);/);
});
