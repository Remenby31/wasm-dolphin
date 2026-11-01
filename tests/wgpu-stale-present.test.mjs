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
  assert.deepEqual(INTEGRITY_REPORTED, ["stalePresents"]);
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
  assert.match(worker, /stalePresents: wgpuStalePresent\.stale,\n\s+geometryCacheCollisions,/);
  assert.match(worker, /stalePresents: wgpuStalePresent\.stale,\n\s+\/\/ Shares of the last window/);
  const adapter = await read("../src/upstream-worker-adapter.js");
  assert.match(adapter, /"framesOutOfOrder", "stalePresents"\]\) \{/);
  const host = await read("../src/core-host.js");
  assert.match(host, /stalePresents: this\.mode === "dolphin" \? this\.adapter\.stalePresents \?\? null : null,/);
});
