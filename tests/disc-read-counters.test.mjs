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
  assert.match(patch, /const u64 read_started_us = Common::Timer::NowUs\(\);\n[+ ]#endif\n\s+if \(!m_disc->Read\(/);
  assert.match(patch, /const u64 finish_wait_started_us = Common::Timer::NowUs\(\);\n[+ ]#endif\n\s+m_result_queue\.WaitForData\(\);/);
  assert.match(added, /extern "C" EMSCRIPTEN_KEEPALIVE void DolphinWeb_DiscReadStats\(u32\* out\)/);
});

test("the worker times its own service of those reads, harness only", async () => {
  const w = await read("../src/upstream-discio-worker.js");
  assert.match(w, /if \(harnessEnabled\) timeDiscReads\(resolveWorkerFs\(moduleInstance\)\);/);
  assert.match(w, /ops\.read = function timedRead\(stream, buffer, offset, length, position\) \{/);
  assert.match(w, /case "validationReadDiscReads":\n\s*return harnessDiscReads\(\);/);
  assert.match(w, /function harnessDiscReads\(\) \{\n\s*if \(!harnessEnabled\) return/);
});
