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
  assert.match(core, /s_skip_xfb_decode = s_video_backend == "WebGPU";/);
  const onXfb = discio.slice(discio.indexOf("void DolphinWeb_OnXfb("), discio.indexOf("void DolphinWeb_OnGlBackbuffer("));
  assert.ok(onXfb.indexOf("HarnessOnViOutput(") < onXfb.indexOf("if (!s_skip_xfb_decode)"), "the VI ring advances before the skip");
  assert.match(onXfb, /if \(!s_skip_xfb_decode\)\n\s*\{\n\s*DecodeXfbToPresentationBuffer/);
  assert.match(onXfb, /s_skip_xfb_decode \? 0 :/);
  assert.match(onXfb, /\+\+s_frame;\n\s*PublishFrameSignal\(\);/);
});
