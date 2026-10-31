// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later

// A SOURCE-CONTRACT test. It reads the patched vendor tree and the host source
// and asserts their shape. It does not compile or execute anything, so on its
// own it cannot show that a ClearRect record is ever produced at runtime.
//
// Native emission is established by three things together, and the other two
// live outside this file:
//
//   1. this file      -- the gate is wired to a capability that defaults on,
//                        and producer and consumer agree on the opcode;
//   2. runtime count  -- a default MKWii launch reports a non-zero
//                        `[clearrect] executed=N`, and `?wgpuclearrect=0`
//                        reports none (recorded in the PR description);
//   3. visual A/B     -- the same pair renders the world vs. the pre-fix
//                        patchwork.
//
// Cite all three. This test alone would still pass if the opcode never left
// the producer.
//
// It exists because tests/wgpu-clear-rect.test.mjs starts from a record the
// test itself builds, so it proves the decoder is right and says nothing about
// whether one is ever produced -- and the gate once read an ENABLE bit out of
// the cached-interpreter *disable* mask, so whether a normal launch emitted the
// opcode depended on a line in the worker that nothing tested and that the
// native comment contradicted.
//
// What is checked here, from the native decision point to the constant the JS
// decoder dispatches on:
//
//   default launch configuration      -> host sends the capability on
//   native ClearRegion decision       -> gated on the renderer feature mask
//   renderer feature mask default     -> the ClearRect bit is SET
//   native emission                   -> PushClearRect with rect/depth/flags
//   opcode number                     -> native CmdOp::ClearRect == JS constant
//
// It reads the patched vendor tree, so it only runs after `npm run
// patch:upstream`; without it there is nothing to assert against and the test
// is skipped rather than silently passing.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { sourceContractTest } from "./helpers/source-contract.mjs";

const gfxUrl = new URL(
  "../vendor/dolphin/Source/Core/VideoBackends/WebGPU/WebGPUGfx.cpp",
  import.meta.url
);
const streamHeaderUrl = new URL(
  "../vendor/dolphin/Source/Core/VideoBackends/WebGPU/WebGPUCommandStream.h",
  import.meta.url
);
const cmakeUrl = new URL("../vendor/dolphin/Source/Core/Core/CMakeLists.txt", import.meta.url);
const workerUrl = new URL("../src/upstream-discio-worker.js", import.meta.url);
const hostUrl = new URL("../src/core-host.js", import.meta.url);

const vendored = existsSync(fileURLToPath(gfxUrl));
const skip = vendored
  ? false
  : "vendor/dolphin is not patched; run `npm run patch:upstream` first";

const read = async (url) => (await readFile(url, "utf8")).replaceAll("\r\n", "\n");

// The body of WebGPUGfx::ClearRegion, which is where the decision is made.
function clearRegionBody(source) {
  const start = source.indexOf("void WebGPUGfx::ClearRegion(");
  assert.notEqual(start, -1, "WebGPUGfx::ClearRegion not found");
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error("unbalanced braces in WebGPUGfx::ClearRegion");
}

sourceContractTest("the scissored clear is a renderer capability that defaults ON", { skip }, async () => {
  const source = await read(gfxUrl);

  const bit = /DOLPHIN_WEB_RENDERER_FEATURE_SCISSORED_CLEAR_RECT\s*=\s*1u\s*<<\s*(\d+)\s*;/.exec(
    source
  );
  assert.ok(bit, "the ClearRect feature bit is not declared");

  // Default ON. This is the property that matters: a launch that never calls
  // the setter must still emit ClearRect. If the default ever loses this bit,
  // a Wii racing game silently goes back to a patchwork frame.
  const dflt = /DOLPHIN_WEB_RENDERER_FEATURE_DEFAULT\s*=\s*([^;]+);/.exec(source);
  assert.ok(dflt, "the default renderer feature mask is not declared");
  assert.match(
    dflt[1],
    /DOLPHIN_WEB_RENDERER_FEATURE_SCISSORED_CLEAR_RECT/,
    "the ClearRect bit must be set in the default renderer feature mask"
  );

  // The storage is initialised from that default, not from zero.
  assert.match(
    source,
    /s_dolphin_web_renderer_feature_mask\{\s*\n?\s*DOLPHIN_WEB_RENDERER_FEATURE_DEFAULT\}/,
    "the feature mask must be initialised to the default, not zero"
  );

  // Accessors exist and are exported from the WASM, or the host cannot bisect.
  assert.match(source, /extern "C" unsigned int DolphinWeb_SetRendererFeatureMask\(/);
  assert.match(source, /extern "C" unsigned int DolphinWeb_GetRendererFeatureMask\(/);
  const cmake = await read(cmakeUrl);
  assert.match(cmake, /'_SetRendererFeatureMask'/, "setter is not in EXPORTED_FUNCTIONS");
  assert.match(cmake, /'_GetRendererFeatureMask'/, "getter is not in EXPORTED_FUNCTIONS");
});

sourceContractTest("ClearRegion emits ClearRect off the renderer mask, not the CPU mask", { skip }, async () => {
  const body = clearRegionBody(await read(gfxUrl));

  // The regression this exists to catch: gating renderer behaviour on the
  // cached-interpreter disable mask, whose default is 0.
  assert.doesNotMatch(
    body,
    /DolphinWeb_GetCachedInterpreterDisableMask/,
    "ClearRegion must not gate on the cached-interpreter disable mask"
  );
  assert.doesNotMatch(
    body,
    /DOLPHIN_WEB_ENABLE_CLEARRECT/,
    "the old ENABLE-bit-in-a-disable-word gate must be gone"
  );

  assert.match(
    body,
    /const unsigned int renderer_features = DolphinWeb_GetRendererFeatureMask\(\);/,
    "ClearRegion must read the renderer feature mask"
  );

  // The emission is guarded by that bit, and reached for a partial rect or for
  // independent RGB/alpha enables -- the two cases a loadOp clear cannot do.
  const guard =
    /if \(\(!covers_efb \|\| color_enable != alpha_enable\) && efb_w != 0 && efb_h != 0 &&\s*\n\s*\(renderer_features & DOLPHIN_WEB_RENDERER_FEATURE_SCISSORED_CLEAR_RECT\) != 0 &&\s*\n\s*BeginPassIfNeeded\(\)\)/;
  assert.match(body, guard, "the ClearRect emission guard does not have the expected shape");

  // …and it actually stages a record, with the requested rectangle rather than
  // a whole-attachment one.
  assert.match(
    body,
    /m_cmd_stream\.PushClearRect\(cx, cy, cw, ch, rgba,\s*\n?\s*static_cast<float>\(z & 0xFFFFFF\) \/ 16777216\.0f, flags\)/,
    "PushClearRect is not called with the requested rect and depth"
  );
  for (const [name, expr] of [
    ["cx", /const u32 cx = static_cast<u32>\(std::max\(0, target_rc\.left\)\);/],
    ["cy", /const u32 cy = static_cast<u32>\(std::max\(0, target_rc\.top\)\);/],
    ["cw", /const u32 cw = static_cast<u32>\(std::max\(0, target_rc\.GetWidth\(\)\)\);/],
    ["ch", /const u32 ch = static_cast<u32>\(std::max\(0, target_rc\.GetHeight\(\)\)\);/]
  ]) {
    assert.match(body, expr, `${name} is not taken from target_rc`);
  }

  // Flag 8 marks the independent-channel encoding; 1/2/4 are RGB/depth/alpha.
  // The JS decoder reads exactly these, so a change here is a protocol change.
  assert.match(
    body,
    /const u32 flags = 8u \| \(color_enable \? 1u : 0u\) \| \(z_enable \? 2u : 0u\) \|\s*\n?\s*\(alpha_enable \? 4u : 0u\);/,
    "the ClearRect flag encoding changed"
  );

  // Depth is normalised out of GX's 24-bit z, not passed through raw.
  assert.match(body, /z & 0xFFFFFF\) \/ 16777216\.0f/, "depth normalisation changed");
});

sourceContractTest("native and JS agree on the ClearRect opcode number", { skip }, async () => {
  const header = await read(streamHeaderUrl);
  const nativeOp = /ClearRect\s*=\s*(\d+)\s*,/.exec(header);
  assert.ok(nativeOp, "CmdOp::ClearRect is not declared in WebGPUCommandStream.h");

  const worker = await read(workerUrl);
  const jsOp = /const WGPU_CMD_OP_CLEAR_RECT = (\d+);/.exec(worker);
  assert.ok(jsOp, "WGPU_CMD_OP_CLEAR_RECT is not declared in the worker");

  assert.equal(
    Number(jsOp[1]),
    Number(nativeOp[1]),
    "the producer and consumer disagree about the ClearRect opcode"
  );
});

test("a default launch turns the capability on", { skip: false }, async () => {
  const host = await read(hostUrl);
  const worker = await read(workerUrl);

  // Host: absent any query parameter, the capability is on.
  const hostFn = /function requestedWgpuScissoredClearRect\(disableMask\) \{([\s\S]*?)\n\}/.exec(
    host
  );
  assert.ok(hostFn, "requestedWgpuScissoredClearRect not found");
  assert.match(hostFn[1], /if \(raw === "0"\) return false;/, "?wgpuclearrect=0 must disable");
  assert.match(
    hostFn[1],
    /return \(\(disableMask >>> 0\) & LEGACY_DISABLE_BIT_CLEARRECT_OFF\) === 0;/,
    "the default (and the legacy ?disable spelling) must fall through to enabled"
  );

  // It is forwarded to the worker rather than being recomputed there.
  assert.match(host, /wgpuScissoredClearRect: this\.wgpuScissoredClearRect,/);

  // Worker: the parameter defaults to true, and the bit is only ever cleared.
  assert.match(
    worker,
    /wgpuScissoredClearRect = true,/,
    "the worker default for the capability must be on"
  );
  assert.match(
    worker,
    /let rendererFeatureMask = RENDERER_FEATURE_SCISSORED_CLEAR_RECT;/,
    "the worker must start from the enabled mask"
  );
  assert.match(
    worker,
    /if \(rendererMaskSupported\) \{\s*\n\s*api\.setRendererFeatureMask\(rendererFeatureMask\);/,
    "the worker must push the capability mask to a core that supports it"
  );

  // The unconditional smuggling is gone: bit 24 is only ever set now as a
  // fallback for a core that predates the capability.
  assert.doesNotMatch(worker, /CLEARRECT_FORCE_OFF/, "the force-off bit must be gone");
});

test("a core without the capability still gets ClearRect via the legacy bit", { skip: false }, async () => {
  const worker = await read(workerUrl);

  // Host and core version independently. A stale cached core, or a
  // half-finished rebuild, must not silently mean a black Wii racing game.
  assert.match(
    worker,
    /const LEGACY_DISABLE_BIT_CLEARRECT_ENABLE = 1 << 24;/,
    "the legacy enable bit must still be known"
  );
  assert.match(
    worker,
    /if \(!rendererMaskSupported && wgpuScissoredClearRect\) \{\s*\n\s*disableMask = \(disableMask \| LEGACY_DISABLE_BIT_CLEARRECT_ENABLE\) >>> 0;/,
    "an old core must be driven through the legacy bit instead"
  );

  // And the fallback must be conditional on the capability being absent, not
  // applied unconditionally -- a new core takes the capability path.
  assert.match(
    worker,
    /const rendererMaskSupported = Boolean\(api\.setRendererFeatureMask\);/,
    "the fallback must key off whether the core exports the capability"
  );
});
