// video=wgpu presents the XFB from the GPU texture cache. The copy of each XFB
// to guest RAM and its decode on the CPU thread (DolphinWeb_OnXfb) only fed
// the software presenter: both are skipped on that backend, as on OGL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const core = read("core/upstream/dolphin_web_core.cpp");
const discio = read("core/upstream/dolphin_web_discio.cpp");

test("wgpu skips the XFB copy to RAM (base value, a GameINI can still override)", () => {
  assert.match(core, /hardware_xfb = s_video_backend == "OGL" \|\| s_video_backend == "WebGPU";\n\s*Config::SetBase\(Config::GFX_HACK_SKIP_XFB_COPY_TO_RAM, hardware_xfb\);/);
});

test("wgpu skips the XFB decode and hash but still counts the frame", () => {
  // WebGPU always; the null backend only with the bench's ?xfbdecode=0.
  assert.match(core, /s_skip_xfb_decode =\n\s*s_video_backend == "WebGPU" \|\| \(s_video_backend == "Null" && xfb_no_decode\);/);
  const onXfb = discio.slice(discio.indexOf("void DolphinWeb_OnXfb("), discio.indexOf("void DolphinWeb_OnGlBackbuffer("));
  assert.ok(onXfb.indexOf("HarnessOnViOutput(") < onXfb.indexOf("if (s_skip_xfb_decode)"), "the VI ring advances before the skip");
  assert.match(onXfb, /\}\n\s*else\n\s*\{\n\s*DecodeXfbToPresentationBuffer/, "the decode only runs when not skipped");
  assert.match(onXfb, /s_skip_xfb_decode \? 0 :/);
  assert.match(onXfb, /\+\+s_frame;\n\s*PublishFrameSignal\(\);/);
});

test("wgpu keeps one present per VI field (no duplicate-XFB skipping)", () => {
  // Measured 2026-10-22: without this, 4.5-11 % of the race's VI fields were
  // not presented (presents < VI outputs) once the RAM copy was skipped.
  assert.match(core, /if \(s_video_backend == "WebGPU"\)\n\s*Config::SetBase\(Config::GFX_HACK_SKIP_DUPLICATE_XFBS, false\);/);
});

test("dual core presents at their time again: the video thread sleeps until presentation_time (patch 0094)", () => {
  // Measured 2026-10-22: without the sleep, rush frame presentation let the
  // CPU thread emit 2-3 cheap fields at once and every burst reached the
  // screen together (gxscene, video=wgpu, 100 %: frame-time p95 35-52 ms).
  const lock = JSON.parse(read("provenance/dolphin-source.lock.json"));
  assert.ok(lock.patches.some((p) => /0094-present-sleep-until-on-video-thread\.patch$/.test(p.path)));
  const patch = read("patches/dolphin-wasm/snapshot/0094-present-sleep-until-on-video-thread.patch");
  assert.match(patch, /\+      if \(!Core::IsCPUThread\(\) && g_video_backend &&\n\+          g_video_backend->GetConfigName\(\) == "WebGPU"\)\n\+      \{\n\+        Core::System::GetInstance\(\)\.GetCoreTiming\(\)\.SleepUntil\(present_time\);/, "dual core, video=wgpu only (the one backend measured)");
});

test("a game's XFBToTextureEnable = False can put the copy back: only the base layer is set", () => {
  // 0097 v3 embeds [Video_Hacks] XFBToTextureEnable; it reaches the same
  // Config::Info from the game layer, which wins over the base layer.
  const sets = core.match(/Config::Set\w*\(Config::GFX_HACK_SKIP_XFB_COPY_TO_RAM/g) ?? [];
  assert.deepEqual(sets, ["Config::SetBase(Config::GFX_HACK_SKIP_XFB_COPY_TO_RAM"]);
});

test("with the decode skipped, the legacy blit shows black until the replay presents, not the boot frame", () => {
  const onXfb = discio.slice(discio.indexOf("void DolphinWeb_OnXfb("), discio.indexOf("void DolphinWeb_OnGlBackbuffer("));
  assert.match(onXfb, /if \(s_skip_xfb_decode\)\n\s*\{[\s\S]*?s_framebuffer\.fill\(0\);[\s\S]*?\}\n\s*else\n\s*\{\n\s*DecodeXfbToPresentationBuffer/);
});
