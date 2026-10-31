import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const coreJs = new URL("../cores/dolphin/dolphin.js", import.meta.url);
const coreWasm = new URL("../cores/dolphin/dolphin.wasm", import.meta.url);

test("native Emscripten core mounts a synthetic disc header and renders a frame", async (t) => {
  if (!existsSync(coreJs) || !existsSync(coreWasm)) {
    t.skip("native core has not been built");
    return;
  }

  const { default: createDolphinCore } = await import(coreJs);
  const module = await createDolphinCore({
    wasmBinary: readFileSync(coreWasm),
    noInitialRun: true
  });

  module.FS.mkdir("/games");

  const header = new Uint8Array(0x80);
  header.set(new TextEncoder().encode("GXXE01"), 0);
  header.set(new TextEncoder().encode("Smoke Test Disc"), 0x20);
  module.FS.writeFile("/games/smoke.iso", header);

  const mounted = module.ccall("MountDisc", "number", ["string"], ["/games/smoke.iso"]);
  const getGameId = module.cwrap("GetGameId", "string", []);
  const getGameTitle = module.cwrap("GetGameTitle", "string", []);
  const runFrame = module.cwrap("RunFrame", null, []);
  const frameBuffer = module.cwrap("FrameBuffer", "number", []);

  assert.equal(mounted, 1);
  assert.equal(getGameId(), "GXXE01");
  assert.equal(getGameTitle(), "Smoke Test Disc");

  runFrame();
  const pointer = frameBuffer();
  const firstPixel = new Uint32Array(module.HEAPU8.buffer, pointer, 1)[0];
  assert.notEqual(firstPixel, 0);
});
