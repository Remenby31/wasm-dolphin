// The memory card flush export (patch 0070 + FlushMemoryCards) ships with
// the next core build. Until then the worker falls back to copying a card
// once two scans agree; once the committed core is built from a series that
// includes the patch, the export is required.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const lock = JSON.parse(read("provenance/dolphin-source.lock.json"));
const build = JSON.parse(read("cores/dolphin/dolphin-core-upstream.build.json"));
const seriesHasFlush = lock.patches.some((patch) => /memcard-flush-on-request\.patch$/.test(patch.path));
const coreFromThisSeries = build.source?.patchSeriesSha256 === lock.patchSeriesSha256;

test("the flush patch is in the series and the bridge exports FlushMemoryCards", () => {
  assert.ok(seriesHasFlush);
  assert.match(read("core/upstream/dolphin_web_core.cpp"), /EMSCRIPTEN_KEEPALIVE\n#endif\nint FlushMemoryCards\(\)/);
  assert.match(read("src/upstream-discio-worker.js"), /flushMemoryCards: optionalCwrap\("FlushMemoryCards", "number", \[\]\)/);
});

test(
  "a core built from this patch series exports FlushMemoryCards",
  { skip: coreFromThisSeries ? false : `committed core predates this series (${build.source?.patchSeriesSha256?.slice(0, 12)}); the worker falls back to two-scan copies` },
  () => {
    assert.match(read("cores/dolphin/dolphin-core-upstream.js"), /_FlushMemoryCards/);
  }
);
