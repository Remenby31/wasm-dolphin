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
  words[0] = 3;
  assert.deepEqual(read(), {}, "an unknown layout: nothing read");
  words[0] = 1;
  assert.equal(read().xlatGlslangUs, undefined, "layout 1 (0219 only): 0220's columns absent, never 0");
  // a new core (a reboot): its block starts at zero again, counted in full from its first read
  const m2 = { _DolphinWeb_HarnessLoadStats: () => ptr };
  words[1] = 3;
  assert.equal(read(m2).texLoads, 4294967304);
  words[1] = 7;
  assert.equal(read(m2).texLoads, 4294967308);
  // layout 2 (0220): its six words read too, from zero
  const m3 = { _DolphinWeb_HarnessLoadStats: () => ptr };
  words[0] = 2; words[10] = 7000; words[14] = 3; words[15] = 1;
  const v2 = read(m3);
  assert.deepEqual([v2.xlatGlslangUs, v2.xlatDuplicates, v2.xlatUntracked], [7000, 3, 1]);
});

// Patch 0220: the WebGPU backend's shader translations, in the same block (layout 2, words 10-15).
const patch20 = read("patches/dolphin-wasm/snapshot/0220-harness-xlat-counters.patch");
const added20 = (file) => {
  const at = patch20.indexOf(`+++ b/${file}`);
  assert.ok(at >= 0, file);
  const next = patch20.indexOf("\ndiff --git", at);
  return patch20.slice(at, next < 0 ? undefined : next).split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1)).join("\n");
};
const translator = added20("Source/Core/VideoBackends/WebGPU/WebGPUShaderTranslator.cpp");
const gfx = added20("Source/Core/VideoBackends/WebGPU/WebGPUGfx.cpp");
const header20 = added20("Source/Core/VideoCommon/WasmLoadStats.h");

test("0220 off: one acquire load of the flag per translation, no clock read, no hash, no lock, no write", () => {
  // the backend: one On() per CreateShaderFromSource; the times asked only when on (a null XlatTimes otherwise)
  assert.equal((gfx.match(/DolphinWeb::LoadStats::On\(\)/g) ?? []).length, 1);
  assert.match(gfx, /GlslToWgsl\(stage, source, xlat_stats \? &xlat_times : nullptr\)/);
  assert.doesNotMatch(gfx, /emscripten_get_now|DolphinWeb_HarnessRecord|std::hash/);
  assert.match(gfx, /DolphinWeb::LoadStats::Xlat\(xlat_stats, source,/);
  // the translator reads the clock only when asked
  for (const line of translator.split("\n").filter((l) => /emscripten_get_now/.test(l))) assert.match(line, /times \?|if \(times\)|^\s+times->/, line);
  assert.match(translator, /const double xlat_start = times \? emscripten_get_now\(\) : 0\.0;/);
  // the header hashes the source only when on
  assert.match(header20, /inline void Xlat\(bool on, std::string_view source,[^)]*\)\n\{\n\s+if \(on\)\n\s+DolphinWeb_HarnessRecordShaderXlat\(std::hash<std::string_view>\{\}\(source\),/);
});

test("0220: the duplicate table is bounded, allocated with the block, locked only when recording (on)", () => {
  const section = discio.slice(discio.indexOf("// Patch 0219 (harness only)"), discio.indexOf("DolphinWeb_HarnessLoadStatsWords()"));
  assert.match(section, /constexpr std::uint32_t HARNESS_LOAD_STATS_VERSION = 2;/);
  assert.match(section, /constexpr std::uint32_t HARNESS_XLAT_TABLE_SLOTS = 8192;\nconstexpr std::uint32_t HARNESS_XLAT_TABLE_MAX = 6144;/);
  // the table on the heap at the first enable, before the block is published (release)
  assert.match(section, /s_harness_xlat_table\.store\(new HarnessXlatTable\(\), std::memory_order_release\);\n\s+s_harness_load_stats\.store\(words, std::memory_order_release\);/);
  assert.match(section, /static std::atomic<HarnessXlatTable\*> s_harness_xlat_table\{nullptr\};/);
  // the bound: past HARNESS_XLAT_TABLE_MAX a new source is counted untracked, never stored
  const rec = section.slice(section.indexOf('extern "C" void DolphinWeb_HarnessRecordShaderXlat'));
  assert.match(rec, /if \(table->entries >= HARNESS_XLAT_TABLE_MAX\)\n\s+\{\n\s+HarnessLoadAdd\(LOAD_XLAT_UNTRACKED, 1\);\n\s+return;/);
  assert.match(rec, /if \(slot == key\)\n\s+\{\n\s+HarnessLoadAdd\(LOAD_XLAT_DUPLICATES, 1\);/);
  // the lock: only in the recorder, which the backend calls only when on (Xlat's if (on))
  assert.equal((section.match(/std::lock_guard<std::mutex>/g) ?? []).length, 1);
  assert.ok(rec.indexOf("std::lock_guard") > rec.indexOf("if (!table)"));
  // no static table (regshape): the struct is only ever made by new
  assert.doesNotMatch(section, /static HarnessXlatTable|static\s+std::uint64_t\s+\w+\[/);
});

test("0220: a model of the table: repeats counted, the bound respected, overflow untracked", () => {
  // the C++ table's logic, transcribed (same slots, same bound, same probe)
  const model = (slotsN, max) => { const slots = new Array(slotsN).fill(0n); let entries = 0, dup = 0, untracked = 0;
    return { add(h) { const key = h ? h : 1n; for (let p = 0; p < slotsN; p += 1) { const i = Number((key + BigInt(p)) % BigInt(slotsN)); if (slots[i] === key) { dup += 1; return; } if (slots[i] === 0n) { if (entries >= max) { untracked += 1; return; } slots[i] = key; entries += 1; return; } } untracked += 1; }, get: () => ({ entries, dup, untracked }) }; };
  const t = model(8, 6);
  for (const h of [5n, 13n, 5n, 21n, 13n]) t.add(h);
  assert.deepEqual(t.get(), { entries: 3, dup: 2, untracked: 0 });
  for (const h of [1n, 2n, 3n, 4n]) t.add(h);
  assert.deepEqual(t.get(), { entries: 6, dup: 2, untracked: 1 }, "past the bound: untracked");
  t.add(5n);
  assert.equal(t.get().dup, 3, "a known source is still found once full");
});
