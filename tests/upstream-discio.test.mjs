import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const coreJs = new URL("../cores/dolphin/dolphin-upstream.js", import.meta.url);
const coreWasm = new URL("../cores/dolphin/dolphin-upstream.wasm", import.meta.url);

function writeU32BE(bytes, offset, value) {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

test("upstream Dolphin DiscIO bridge mounts a GameCube disc header", async (t) => {
  if (!existsSync(coreJs) || !existsSync(coreWasm)) {
    t.skip("upstream DiscIO bridge has not been built");
    return;
  }

  const { default: createDolphinCore } = await import(coreJs);
  const module = await createDolphinCore({
    wasmBinary: readFileSync(coreWasm),
    noInitialRun: true
  });

  module.FS.mkdir("/games");

  const header = new Uint8Array(0x3000);
  header.set(new TextEncoder().encode("GXXE01"), 0);
  header.set(new TextEncoder().encode("Smoke Test Disc"), 0x20);
  header.set([0xc2, 0x33, 0x9f, 0x3d], 0x1c);
  header.set([0x00, 0x00, 0x00, 0x01], 0x458);
  header.set(new TextEncoder().encode("2026/05/05"), 0x2440);
  writeU32BE(header, 0x420, 0x1000);
  writeU32BE(header, 0x424, 0x2800);
  writeU32BE(header, 0x428, 0x24);
  writeU32BE(header, 0x1000, 0x100);
  writeU32BE(header, 0x1048, 0x80003100);
  writeU32BE(header, 0x1090, 0x40);
  writeU32BE(header, 0x10d8, 0x80400000);
  writeU32BE(header, 0x10dc, 0x1000);
  writeU32BE(header, 0x10e0, 0x80003100);
  writeU32BE(header, 0x2454, 0x20);
  writeU32BE(header, 0x2458, 0x10);
  writeU32BE(header, 0x2800, 0x01000000);
  writeU32BE(header, 0x2804, 0);
  writeU32BE(header, 0x2808, 2);
  writeU32BE(header, 0x280c, 0);
  writeU32BE(header, 0x2810, 0x2900);
  writeU32BE(header, 0x2814, 4);
  header.set(new TextEncoder().encode("opening.bnr"), 0x2818);
  header.set(new TextEncoder().encode("BNR1"), 0x2900);
  module.FS.writeFile("/games/smoke.gcm", header);

  const mounted = module.ccall("MountDisc", "number", ["string"], ["/games/smoke.gcm"]);
  const getGameId = module.cwrap("GetGameId", "string", []);
  const getGameTitle = module.cwrap("GetGameTitle", "string", []);
  const getPlatform = module.cwrap("GetPlatform", "string", []);
  const getApploaderDate = module.cwrap("GetApploaderDate", "string", []);
  const getApploaderSize = module.cwrap("GetApploaderSize", "number", []);
  const getBootDolOffset = module.cwrap("GetBootDolOffset", "number", []);
  const getBootDolSize = module.cwrap("GetBootDolSize", "number", []);
  const getFstOffset = module.cwrap("GetFstOffset", "number", []);
  const getFstSize = module.cwrap("GetFstSize", "number", []);
  const getRootEntryCount = module.cwrap("GetRootEntryCount", "number", []);
  const getRootEntryName = module.cwrap("GetRootEntryName", "string", ["number"]);
  const getRootEntryPath = module.cwrap("GetRootEntryPath", "string", ["number"]);
  const getRootEntryIsDirectory = module.cwrap("GetRootEntryIsDirectory", "number", ["number"]);
  const getRootEntryOffset = module.cwrap("GetRootEntryOffset", "number", ["number"]);
  const getRootEntrySize = module.cwrap("GetRootEntrySize", "number", ["number"]);
  const readDisc = module.cwrap("ReadDisc", "number", ["number", "number", "number"]);
  const readDiscFile = module.cwrap("ReadDiscFile", "number", ["string", "number", "number", "number"]);
  const runFrame = module.cwrap("RunFrame", null, []);
  const frameBuffer = module.cwrap("FrameBuffer", "number", []);

  assert.equal(mounted, 1);
  assert.equal(getGameId(), "GXXE01");
  assert.equal(getGameTitle(), "Smoke Test Disc");
  assert.equal(getPlatform(), "GameCube");
  assert.equal(getApploaderDate(), "2026/05/05");
  assert.equal(getApploaderSize(), 0x50);
  assert.equal(getBootDolOffset(), 0x1000);
  assert.equal(getBootDolSize(), 0x140);
  assert.equal(getFstOffset(), 0x2800);
  assert.equal(getFstSize(), 0x24);
  assert.equal(getRootEntryCount(), 1);
  assert.equal(getRootEntryName(0), "opening.bnr");
  assert.equal(getRootEntryPath(0), "opening.bnr");
  assert.equal(getRootEntryIsDirectory(0), 0);
  assert.equal(getRootEntryOffset(0), 0x2900);
  assert.equal(getRootEntrySize(0), 4);

  const pointer = module._malloc(6);
  try {
    assert.equal(readDisc(0, 6, pointer), 6);
    assert.equal(new TextDecoder().decode(module.HEAPU8.subarray(pointer, pointer + 6)), "GXXE01");
    assert.equal(readDiscFile("opening.bnr", 0, 4, pointer), 4);
    assert.equal(new TextDecoder().decode(module.HEAPU8.subarray(pointer, pointer + 4)), "BNR1");
  } finally {
    module._free(pointer);
  }

  runFrame();
  const framePointer = frameBuffer();
  const firstPixel = new Uint32Array(module.HEAPU8.buffer, framePointer, 1)[0];
  assert.notEqual(firstPixel, 0);
});
