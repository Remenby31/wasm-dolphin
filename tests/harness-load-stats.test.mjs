// Patch 0219 (harness only): the video thread's cache-miss counters (textures, shaders, pipelines), and their
// zero cost for players: with the counters off a miss makes one acquire load of a flag, no clock read, no write;
// a hit makes nothing at all. Frozen here on the patch's own text and on dolphin_web_discio.cpp.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const patch = read("patches/dolphin-wasm/snapshot/0219-harness-load-stats.patch");
const discio = read("core/upstream/dolphin_web_discio.cpp");
const worker = read("src/upstream-discio-worker.js");
// the lines a file's hunks add, per file of the patch
const added = (file) => {
  const at = patch.indexOf(`+++ b/${file}`);
  assert.ok(at >= 0, file);
  const next = patch.indexOf("\ndiff --git", at);
  return patch.slice(at, next < 0 ? undefined : next).split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1)).join("\n");
};
const header = added("Source/Core/VideoCommon/WasmLoadStats.h");
const textures = added("Source/Core/VideoCommon/TextureCacheBase.cpp");
const shaders = added("Source/Core/VideoCommon/ShaderCache.cpp");

test("0219 off: one acquire load of a flag per miss, the clock read only when on, the recorders only when on", () => {
  // the flag: one acquire load, nothing else (no harness check, no pointer load)
  const on = discio.slice(discio.indexOf('extern "C" int DolphinWeb_HarnessLoadStatsOn()'), discio.indexOf("static void HarnessLoadAdd"));
  assert.match(on, /\{\n\s+return s_harness_load_stats_enabled\.load\(std::memory_order_acquire\);\n\}/);
  assert.equal((on.match(/\.load\(/g) ?? []).length, 1);
  // the header: On() is that call; Now() reads the clock only when on; the recorders call the core only when on
  assert.match(header, /inline bool On\(\)\n\{\n\s+return DolphinWeb_HarnessLoadStatsOn\(\) != 0;\n\}/);
  assert.match(header, /inline double Now\(bool on\)\n\{\n\s+return on \? emscripten_get_now\(\) : 0\.0;\n\}/);
  for (const fn of ["Texture", "Shader", "Pipeline"]) assert.match(header, new RegExp(`inline void ${fn}\\(bool on,[^)]*\\)\\n\\{\\n\\s+if \\(on\\)\\n\\s+DolphinWeb_HarnessRecord`), fn);
  // the hooks never read the clock nor record directly: only through Now() / the recorders
  for (const [name, code] of [["textures", textures], ["shaders", shaders]]) {
    assert.doesNotMatch(code, /emscripten_get_now|DolphinWeb_HarnessRecord|DolphinWeb_HarnessLoadStatsOn/, name);
  }
  // one On() per hooked miss path: CreateTextureEntry once; 4 Compile*Shader + CreateGeometryShader + 2 pipeline misses
  assert.equal((textures.match(/DolphinWeb::LoadStats::On\(\)/g) ?? []).length, 1);
  assert.equal((shaders.match(/DolphinWeb::LoadStats::On\(\)/g) ?? []).length, 7);
});

test("0219: a pipeline cache HIT makes no access at all (the miss counters come after the hit's return)", () => {
  // the patched function, as the patch leaves it: the hit returns before On()
  const fn = (name) => {
    const hunk = patch.slice(patch.indexOf("+++ b/Source/Core/VideoCommon/ShaderCache.cpp"));
    const at = hunk.indexOf(name);
    return at < 0 ? null : hunk.slice(at, hunk.indexOf("\n@@", at) > 0 ? hunk.indexOf("\n@@", at) : undefined);
  };
  for (const name of ["ShaderCache::GetPipelineForUid(", "ShaderCache::GetUberPipelineForUid("]) {
    const body = fn(name);
    assert.ok(body, name);
    const hit = body.indexOf("return it->second.first.get();"), first = body.indexOf("LoadStats::On()");
    assert.ok(hit >= 0 && first > hit, name);
  }
  // each pipeline miss is timed as a whole, recorded once
  assert.equal((shaders.match(/DolphinWeb::LoadStats::Pipeline\(load_stats,/g) ?? []).length, 2);
  // the texture: one record per created entry, after its levels
  assert.equal((textures.match(/DolphinWeb::LoadStats::Texture\(load_stats, decoded_bytes, decode_ms, copy_push_ms\);/g) ?? []).length, 1);
});

test("0219: the counters live in a block allocated at the first enable, never in the core's static data; release/acquire", () => {
  const section = discio.slice(discio.indexOf("// Patch 0219 (harness only)"), discio.indexOf("DolphinWeb_HarnessLoadStatsWords()"));
  // no static array (tests/regshape-x64.test.mjs: static data moves the translator's embedded addresses)
  assert.doesNotMatch(section, /static\s+(constexpr\s+)?std::array|static[^;(]*\[[^\]]*\]\s*[;={]/);
  assert.match(section, /static std::atomic<std::atomic<std::uint32_t>\*> s_harness_load_stats\{nullptr\};/);
  assert.match(section, /if \(enabled && !s_harness_load_stats\.load\(std::memory_order_acquire\)\)\n\s+\{\n\s+auto\* words = new std::atomic<std::uint32_t>\[HARNESS_LOAD_STATS_WORDS\]\(\);/);
  assert.match(section, /s_harness_load_stats\.store\(words, std::memory_order_release\);/);
  assert.match(section, /s_harness_load_stats_enabled\.store\(enabled \? 1 : 0, std::memory_order_release\);/);
  // never freed (the worker's address never goes stale), relaxed adds from any thread
  assert.doesNotMatch(section, /delete\s*\[\]/);
  assert.match(section, /words\[word\]\.fetch_add\(static_cast<std::uint32_t>\(value \+ 0\.5\), std::memory_order_relaxed\);/);
  // the reader: null until allocated
  assert.match(section, /EMSCRIPTEN_KEEPALIVE std::atomic<std::uint32_t>\* DolphinWeb_HarnessLoadStats\(\)\n\{\n\s+return s_harness_load_stats\.load\(std::memory_order_acquire\);/);
});

test("0219 in the worker: the u32 words unwrapped into cumulative columns; none before the block exists; a new core starts over", () => {
  const src = worker.slice(worker.indexOf("const LOAD_STATS_COLUMNS = "), worker.indexOf("function readLoadStats("));
  const fn = worker.slice(worker.indexOf("function readLoadStats("), worker.indexOf("\n}\n", worker.indexOf("function readLoadStats(")) + 3);
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(`${src}\n${fn}\nglobalThis.readLoadStats = readLoadStats;`, ctx);
  const heap = new Uint8Array(4096);
  const words = new Uint32Array(heap.buffer, 256, 16);
  let ptr = 0;
  const m = { _DolphinWeb_HarnessLoadStats: () => ptr };
  const read = (mod = m) => { const out = {}; ctx.readLoadStats(mod, heap, out); return out; };
  assert.deepEqual(read(), {}, "not allocated: no column");
  ptr = 256; words[0] = 1;
  // the block starts at zero: the first read counts in full (its first ~100 ms are not lost)
  words[1] = 4; words[2] = 10;
  assert.deepEqual([read().texLoads, read().texBytes], [4, 10]);
  words[1] = 4294967290; words[2] = 30;
  assert.equal(read().texLoads, 4294967290);
  words[1] = 5; // wrapped: +11
  assert.equal(read().texLoads, 4294967301);
  words[0] = 2;
  assert.deepEqual(read(), {}, "another layout: nothing read");
  words[0] = 1;
  // a new core (a reboot): its block starts at zero again, counted in full from its first read
  const m2 = { _DolphinWeb_HarnessLoadStats: () => ptr };
  words[1] = 3;
  assert.equal(read(m2).texLoads, 4294967304);
  words[1] = 7;
  assert.equal(read(m2).texLoads, 4294967308);
});
