import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (p) => readFile(new URL(p, import.meta.url), "utf8");

// Patch 0151: the disc's reads, measured on both sides of the WORKERFS proxy
// (task 4: does the WebGPU replay on the same worker delay them?).
test("0151 times the DVD thread's reads and the CPU thread's waits for them", async () => {
  const patch = await read("../patches/dolphin-wasm/snapshot/0151-disc-read-counters.patch");
  const added = patch.split("\n").filter((l) => l.startsWith("+")).join("\n");
  // The timers wrap the read and the wait themselves (context lines).
  assert.match(patch, /const u64 read_started_us = time_read \? Common::Timer::NowUs\(\) : 0;\n[+ ]#endif\n\s+if \(!m_disc->Read\(/);
  assert.match(patch, /const u64 finish_wait_started_us = time_wait \? Common::Timer::NowUs\(\) : 0;\n[+ ]#endif\n\s+m_result_queue\.WaitForData\(\);/);
  assert.match(added, /extern "C" EMSCRIPTEN_KEEPALIVE void DolphinWeb_DiscReadStats\(u32\* out\)/);
});

test("the worker times its own service of those reads, harness only", async () => {
  const w = await read("../src/upstream-discio-worker.js");
  assert.match(w, /if \(harnessEnabled\) \{\n\s*timeDiscReads\(resolveWorkerFs\(moduleInstance\)\);/);
  assert.match(w, /ops\.read = function timedRead\(stream, buffer, offset, length, position\) \{/);
  assert.match(w, /case "validationReadDiscReads":\n\s*return harnessDiscReads\(payload\);/);
  assert.match(w, /function harnessDiscReads\(\{ resetMax = false \} = \{\}\) \{\n\s*if \(!harnessEnabled\) return/);
});

// Off unless the harness is on: in the product neither side times anything.
test("0151's counters are off unless the harness turns them on", async () => {
  const patch = await read("../patches/dolphin-wasm/snapshot/0151-disc-read-counters.patch");
  const added = patch.split("\n").filter((l) => l.startsWith("+")).join("\n");
  assert.match(added, /std::atomic<bool> s_disc_read_stats\{false\};/);
  // Every counter update sits behind the flag: the read, and a wait only when it blocks.
  assert.match(added, /const bool time_read = s_disc_read_stats\.load\(std::memory_order_relaxed\);/);
  assert.match(added, /s_disc_read_stats\.load\(std::memory_order_relaxed\) && m_result_queue\.Empty\(\);/);
  assert.equal((added.match(/fetch_add\(1, std::memory_order_relaxed\)/g) ?? []).length, 2);
  assert.match(added, /if \(time_read\)\n\+\s*\{\n\+\s*const u64 read_us = request\.realtime_done_us - read_started_us;/);
  assert.match(added, /if \(time_wait\)\n\+\s*\{/);
  const w = await read("../src/upstream-discio-worker.js");
  assert.match(w, /if \(harnessEnabled\) \{\n\s*timeDiscReads\(resolveWorkerFs\(moduleInstance\)\);\n\s*moduleInstance\._DolphinWeb_SetDiscReadStatsEnabled\?\.\(1\);/);
});

// Patch 0154: a window's maxima (both sides) start over on request.
test("0154 resets the maxima on request, both sides, and only them", async () => {
  const patch = await read("../patches/dolphin-wasm/snapshot/0154-disc-read-max-reset.patch");
  assert.match(patch, /\+extern "C" EMSCRIPTEN_KEEPALIVE void DolphinWeb_DiscReadStatsResetMax\(\)\n\+\{\n\+\s*s_disc_read_max_us\.store\(0, std::memory_order_relaxed\);\n\+\s*s_disc_finish_wait_max_us\.store\(0, std::memory_order_relaxed\);\n[+ ]\}/);
  const w = await read("../src/upstream-discio-worker.js");
  assert.match(w, /case "validationReadDiscReads":\n\s*return harnessDiscReads\(payload\);/);
  // The read is taken before the reset: it still holds the window's maxima.
  assert.match(w, /const read = \{ service: \{ \.\.\.discReadService \}[^\n]*\n\s*if \(resetMax\) \{\n\s*discReadService\.maxMs = 0;\n\s*moduleInstance\?\._DolphinWeb_DiscReadStatsResetMax\?\.\(\);/);
});
