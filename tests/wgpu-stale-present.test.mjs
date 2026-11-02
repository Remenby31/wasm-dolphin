import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createStalePresentDetector } from "../src/wgpu-stale-present.js";
import { INTEGRITY_FATAL, INTEGRITY_REPORTED } from "../src/wgpu-integrity.js";
import { integrityBrief, integrityOf } from "../harness/lib/integrity.mjs";

const read = (p) => readFile(new URL(p, import.meta.url), "utf8");

// The Presenter functions a patch adds or removes lines in, for
// VideoCommon/Present.cpp: each hunk starts in the function its header names
// (git's "@@ ... @@ <signature>"), and a signature line in the hunk moves to
// the next one.
function presenterFunctionsChanged(patch) {
  const file = patch.slice(patch.indexOf("+++ b/Source/Core/VideoCommon/Present.cpp"));
  const body = file.slice(0, file.indexOf("\ndiff --git", 1) > 0 ? file.indexOf("\ndiff --git", 1) : file.length);
  const fn = (line) => /Presenter::(\w+)\(/.exec(line)?.[1] ?? null;
  const changed = new Set();
  let current = null;
  for (const line of body.split("\n")) {
    if (line.startsWith("@@")) { current = fn(line.replace(/^@@[^@]*@@/, "")); continue; }
    if (/^[ +-](?:[\w:<>]+\s+)+Presenter::\w+\(/.test(line)) { current = fn(line); if (line[0] === " ") continue; }
    if ((line[0] === "+" || line[0] === "-") && current) changed.add(current);
  }
  return changed;
}

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
  assert.deepEqual(INTEGRITY_REPORTED, ["stalePresents", "staleXfbHeld", "staleXfbHeldPreload"]);
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
  assert.match(worker, /stalePresents: wgpuStalePresent\.stale,\n\s+\/\/ patch 0211[^\n]*\n\s+staleXfbHeld: typeof m\?\._DolphinWeb_StaleXfbHeld === "function" \? m\._DolphinWeb_StaleXfbHeld\(\) >>> 0 : null,\n\s+\/\/ of those[^\n]*\n\s+staleXfbHeldPreload: typeof m\?\._DolphinWeb_StaleXfbHeldPreload === "function" \? m\._DolphinWeb_StaleXfbHeldPreload\(\) >>> 0 : null,\n\s+geometryCacheCollisions,/);
  assert.match(worker, /stalePresents: wgpuStalePresent\.stale,\n\s+\/\/ Shares of the last window/);
  const adapter = await read("../src/upstream-worker-adapter.js");
  assert.match(adapter, /"framesOutOfOrder", "stalePresents"\]\) \{/);
  const host = await read("../src/core-host.js");
  assert.match(host, /stalePresents: this\.mode === "dolphin" \? this\.adapter\.stalePresents \?\? null : null,/);
});

test("patch 0211: a dual-core VI swap ahead of its copy holds the last picture, at most 4 times in a row", async () => {
  const patch = await read("../patches/dolphin-wasm/snapshot/0211-stale-xfb-shows-last-picture.patch");
  // the race's own condition: the GPU thread has not consumed the FIFO written before the VI
  assert.match(patch, /\+            m_gpu_chunks_consumed\.fetch_add\(1, std::memory_order_release\);/);
  // the consumed count read before the distance: a chunk consumed between the two reads lowers the target (a hold missed), never raises it
  assert.match(patch, /\+  const u64 consumed = m_gpu_chunks_consumed\.load\(std::memory_order_acquire\);\n\+  const u32 pending = fifo\.CPReadWriteDistance\.load\(std::memory_order_seq_cst\);\n\+  return consumed \+ \(pending \+ GPFifo::GATHER_PIPE_SIZE - 1\) \/ GPFifo::GATHER_PIPE_SIZE;/);
  assert.match(patch, /\+        system\.IsDualCoreMode\(\) && !fifo_manager\.UseDeterministicGPUThread\(\) \?\n\+            fifo_manager\.GpuCatchUpTarget\(\) :\n\+            0;/);
  assert.match(patch, /\+      fifo_target != 0 &&\n\+      Core::System::GetInstance\(\)\.GetFifo\(\)\.GpuChunksConsumed\(\) < fifo_target;/);
  // held only then, for an older entry already shown, and at most 4 times in a row
  assert.match(patch, /\+    const bool stale = may_hold && m_last_shown_entry && id < old_xfb_id &&\n\+                       old_xfb_id != std::numeric_limits<u64>::max\(\) && shown_before &&\n\+                       m_stale_holds_in_a_row < MAX_STALE_HOLDS_IN_A_ROW;/);
  assert.match(patch, /\+constexpr u32 MAX_STALE_HOLDS_IN_A_ROW = 4;/);
  // an immediate swap never holds: FetchXFB's may_hold defaults to false and only ViSwap passes it
  assert.match(patch, /\+                bool may_hold = false\);/);
  assert.match(patch, /\+  bool is_duplicate = FetchXFB\(xfb_addr, fb_width, fb_stride, fb_height, ticks, may_hold\);/);
  // ImmediateSwap untouched: every added or removed line of Present.cpp, by the Presenter function it falls in
  const changedIn = presenterFunctionsChanged(patch);
  assert.ok(changedIn.has("FetchXFB") && changedIn.has("ViSwap") && changedIn.has("DoState"), `the walk finds the functions the patch changes: ${[...changedIn]}`);
  assert.ok(!changedIn.has("ImmediateSwap"), "ImmediateSwap untouched");
  // a load forgets the ids it restores, before its re-display
  const doState = patch.slice(patch.indexOf("Patch 0211: a load restores"));
  assert.ok(doState.indexOf("ForgetShownXfbs();") >= 0 && doState.indexOf("ForgetShownXfbs();") < doState.indexOf("If we're loading and there is a last XFB, re-display it."), "forgotten before the re-display");
  assert.match(patch, /\+  if \(p\.IsReadMode\(\)\)\n\+  \{\n\+    \+\+m_load_generation;\n\+    ForgetShownXfbs\(\);\n\+    m_last_xfb_id = std::numeric_limits<u64>::max\(\);/);
  assert.match(patch, /\+      DolphinWeb::g_stale_xfb_held\.fetch_add\(1, std::memory_order_relaxed\);/);
  const core = await read("../core/upstream/dolphin_web_core.cpp");
  assert.match(core, /std::uint32_t DolphinWeb_StaleXfbHeld\(\)\n\{\n#ifdef __EMSCRIPTEN__\n\s+return DolphinWeb::g_stale_xfb_held\.load\(std::memory_order_relaxed\);/);
});

test("replay-gates --quickload: a quick save and load, then no hold for 60 VIs", async () => {
  const gates = await read("../harness/probes/replay-gates.mjs");
  assert.match(gates, /quickload: \{ type: "boolean", default: false \}/);
  const q = gates.slice(gates.indexOf("if (o.quickload) {"));
  assert.ok(q.indexOf('"saveState", { slot: 2 }') < q.indexOf("await sleep(50);") && q.indexOf("await sleep(50);") < q.indexOf('"loadState", { slot: 2 }'));
  assert.match(q, /const after60 = await captureAtVi\(session\.page, \{ index: 60, fromLoad: true, timeoutMs: 60000 \}\);/);
  assert.match(q, /if \(v\.quickload\.preload === null\) throw new Error/);
  assert.match(q, /if \(v\.quickload\.preload > 0\) throw new Error\(`quickload: \$\{v\.quickload\.preload\} swap\(s\) held on a picture from before the load`\);/);
  // the core counts a hold of a pre-load picture: a load moves the generation first
  const patch = await read("../patches/dolphin-wasm/snapshot/0211-stale-xfb-shows-last-picture.patch");
  assert.match(patch, /\+      if \(m_last_shown_generation != m_load_generation\)\n\+        DolphinWeb::g_stale_xfb_held_preload\.fetch_add\(1, std::memory_order_relaxed\);/);
  assert.match(patch, /\+    \+\+m_load_generation;\n\+    ForgetShownXfbs\(\);/);
});

test("the Presenter-function walk finds a change inside ImmediateSwap", () => {
  const fake = [
    "diff --git a/Source/Core/VideoCommon/Present.cpp b/Source/Core/VideoCommon/Present.cpp",
    "--- a/Source/Core/VideoCommon/Present.cpp",
    "+++ b/Source/Core/VideoCommon/Present.cpp",
    "@@ -250,6 +250,7 @@ void Presenter::ImmediateSwap(u32 xfb_addr, u32 fb_width, u32 fb_stride, u32 fb_height)",
    "   const u64 ticks = m_next_swap_estimated_ticks;",
    "-  FetchXFB(xfb_addr, fb_width, fb_stride, fb_height, ticks);",
    "+  FetchXFB(xfb_addr, fb_width, fb_stride, fb_height, ticks, true);",
    "@@ -280,3 +281,4 @@ void Presenter::ImmediateSwap(u32 xfb_addr, u32 fb_width, u32 fb_stride, u32 fb_height)",
    " }",
    " void Presenter::SetNextSwapEstimatedTime(u64 ticks, TimePoint host_time)",
    "+  // a line in the next function",
    ""
  ].join("\n");
  assert.deepEqual([...presenterFunctionsChanged(fake)].sort(), ["ImmediateSwap", "SetNextSwapEstimatedTime"]);
});
