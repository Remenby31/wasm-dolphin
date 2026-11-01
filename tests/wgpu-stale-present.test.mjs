import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createStalePresentDetector } from "../src/wgpu-stale-present.js";
import { INTEGRITY_FATAL, INTEGRITY_REPORTED } from "../src/wgpu-integrity.js";
import { integrityBrief, integrityOf } from "../harness/lib/integrity.mjs";

const read = (p) => readFile(new URL(p, import.meta.url), "utf8");

test("a new frame shown from a texture not rewritten since its last present is stale", () => {
  const d = createStalePresentDetector();
  assert.equal(d.stale, null, "no tagged present yet");
  // double-buffered XFB: 61 and 62 alternate, each written before it is shown
  d.created(61); d.created(62);
  d.wrote(61); assert.equal(d.present(61, 1), false);
  d.wrote(62); assert.equal(d.present(62, 2), false);
  d.wrote(61); assert.equal(d.present(61, 3), false);
  assert.equal(d.stale, 0);
  // the late replay: frame 4 shown from 62, whose copy of frame 4 has not run
  assert.equal(d.present(62, 4), true);
  assert.equal(d.stale, 1);
  // the copy lands, then frame 5 from 61: fine again
  d.wrote(62);
  d.wrote(61); assert.equal(d.present(61, 5), false);
  assert.equal(d.stale, 1);
});

test("a duplicate VI swap, an untagged present and a state load are not stale", () => {
  const d = createStalePresentDetector();
  d.wrote(7);
  assert.equal(d.present(7, 10), false);
  assert.equal(d.present(7, 10), false, "the same tag again: the game repeats its picture");
  assert.equal(d.present(7, 0), false, "untagged");
  assert.equal(d.present(0, 11), false, "no texture");
  // a load (tag epoch 1) restores the frame count; what was shown is forgotten
  assert.equal(d.present(7, 3, 1), false);
  assert.equal(d.stale, 0);
  // a texture id reused after a destroy: its creation is new content
  d.created(7);
  assert.equal(d.present(7, 4, 1), false);
  assert.equal(d.stale, 0);
});

test("stalePresents is reported in every run's integrity, never fatal yet", () => {
  assert.deepEqual(INTEGRITY_REPORTED, ["stalePresents", "staleXfbHeld"]);
  assert.ok(!INTEGRITY_FATAL.includes("stalePresents"));
  const i = integrityOf({ presents: 0, stalePresents: 2 }, { presents: 500, stalePresents: 9 });
  assert.deepEqual(i.fatal, []);
  assert.deepEqual(i.reported, ["stalePresents 7"]);
  assert.equal(integrityBrief(i), " (reported: stalePresents 7)");
  assert.deepEqual(integrityOf({ stalePresents: null }, { stalePresents: null }).reported, [], "null without tags");
});

test("the replay feeds the detector at every write and present, and reports it", async () => {
  const worker = await read("../src/upstream-discio-worker.js");
  assert.match(worker, /if \(!webGpuObjects\.textures\.has\(id\)\) \{\n\s+wgpuStalePresent\.created\(id\);/);
  assert.match(worker, /const t = webGpuObjects\.textures\.get\(textureId\);\n\s+wgpuStalePresent\.wrote\(textureId\);/);
  assert.match(worker, /noteMissingResource\("color-texture", fbId\);\n\s+break;\n\s+\}\n\s+wgpuStalePresent\.wrote\(fbId\);/);
  assert.match(worker, /if \(s && d\) \{\n\s+wgpuStalePresent\.wrote\(destinationId\);/);
  assert.match(worker, /wgpuStalePresent\.present\(wgpuLastBackbufferSourceTextureId, presentFrameTag, presentFrameTagEpoch\);/);
  assert.match(worker, /stalePresents: wgpuStalePresent\.stale,\n\s+\/\/ patch 0211[^\n]*\n\s+staleXfbHeld: typeof m\?\._DolphinWeb_StaleXfbHeld === "function" \? m\._DolphinWeb_StaleXfbHeld\(\) >>> 0 : null,\n\s+geometryCacheCollisions,/);
  assert.match(worker, /stalePresents: wgpuStalePresent\.stale,\n\s+\/\/ Shares of the last window/);
  const adapter = await read("../src/upstream-worker-adapter.js");
  assert.match(adapter, /"framesOutOfOrder", "stalePresents"\]\) \{/);
  const host = await read("../src/core-host.js");
  assert.match(host, /stalePresents: this\.mode === "dolphin" \? this\.adapter\.stalePresents \?\? null : null,/);
});

test("patch 0211: in dual core a swap that fetches an older XFB already shown holds the last picture", async () => {
  const patch = await read("../patches/dolphin-wasm/snapshot/0211-stale-xfb-shows-last-picture.patch");
  // only in dual core, only an entry older than the last and shown before
  assert.match(patch, /\+    const bool stale = Core::System::GetInstance\(\)\.IsDualCoreMode\(\) && m_last_shown_entry &&\n\+                       old_xfb_id != std::numeric_limits<u64>::max\(\) && id < old_xfb_id &&\n\+                       shown_before;/);
  // held: the last entry again, the same id, so the swap is a duplicate
  assert.match(patch, /\+      m_xfb_entry = m_last_shown_entry;\n\+      m_xfb_rect = m_last_shown_rect;\n\+      m_last_xfb_id = old_xfb_id;/);
  assert.match(patch, /\+      DolphinWeb::g_stale_xfb_held\.fetch_add\(1, std::memory_order_relaxed\);/);
  // a state load restores entry ids: lower than every one remembered starts over
  assert.match(patch, /\+        m_shown_xfb_ids\.fill\(0\);/);
  const core = await read("../core/upstream/dolphin_web_core.cpp");
  assert.match(core, /std::uint32_t DolphinWeb_StaleXfbHeld\(\)\n\{\n#ifdef __EMSCRIPTEN__\n\s+return DolphinWeb::g_stale_xfb_held\.load\(std::memory_order_relaxed\);/);
});
