import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { defaultWgpuGeometryCacheMode, requestedWgpuGeometryCacheMode } from "../src/wgpu-replay-diagnostics.js";

// 0204: the geometry content cache (on by default under V8, ?wgpugeomcache=0|1|2).
const patch = await readFile(
  new URL("../patches/dolphin-wasm/snapshot/0204-webgpu-geometry-content-cache.patch", import.meta.url),
  "utf8"
);
const worker = await readFile(new URL("../src/upstream-discio-worker.js", import.meta.url), "utf8");

test("geometry cache default: on under V8 only", () => {
  assert.equal(defaultWgpuGeometryCacheMode("v8"), 1);
  for (const engine of ["jsc", "spidermonkey", "unknown"]) assert.equal(defaultWgpuGeometryCacheMode(engine), 0, engine);
  assert.equal(requestedWgpuGeometryCacheMode("", 1), 1, "the engine's default");
  assert.equal(requestedWgpuGeometryCacheMode("?wgpugeomcache=0", 1), 0, "=0 turns the default off");
  assert.equal(requestedWgpuGeometryCacheMode("?wgpugeomcache=1", 0), 1, "=1 turns it on elsewhere");
  assert.equal(requestedWgpuGeometryCacheMode("?wgpugeomcache=yes", 1), 1, "a non-canonical value keeps the default");
});

test("?wgpugeomcache: 1 on, 2 on with the sampled comparison, 0 off", () => {
  assert.equal(requestedWgpuGeometryCacheMode(""), 0);
  assert.equal(requestedWgpuGeometryCacheMode("?wgpugeomcache=1"), 1);
  assert.equal(requestedWgpuGeometryCacheMode("?wgpugeomcache=2"), 3);
  assert.equal(requestedWgpuGeometryCacheMode("?wgpugeomcache=0"), 0);
  assert.equal(requestedWgpuGeometryCacheMode("?wgpugeomcache=yes"), 0);
});

test("the cache mode reaches the worker's init message (needs the pack)", async (t) => {
  const { UpstreamWorkerAdapter } = await import("../src/upstream-worker-adapter.js");
  const adapter = new UpstreamWorkerAdapter({ wgpuGeometryPack: true, wgpuGeometryCacheMode: 3 });
  let posted = null;
  adapter.worker = { postMessage(message) { posted = message; queueMicrotask(() => adapter.handleMessage({ id: message.id, ok: true })); } };
  const originalWindow = globalThis.window;
  globalThis.window = { location: { href: "http://127.0.0.1:8080/?wgpugeomcache=2", search: "?wgpugeomcache=2" } };
  t.after(() => { if (originalWindow === undefined) delete globalThis.window; else globalThis.window = originalWindow; });
  await adapter.load();
  assert.equal(posted.payload.wgpuGeometryCacheMode, 3);
  assert.equal(new UpstreamWorkerAdapter({ wgpuGeometryCacheMode: 1 }).wgpuGeometryCacheMode, 0, "no pack, no cache");
  const host = await readFile(new URL("../src/core-host.js", import.meta.url), "utf8");
  assert.match(host, /wgpuGeometryCacheMode: this\.wgpuGeometryCacheMode/);
  // never with the load fence (it drops published uploads, the cache's too)
  assert.match(host, /this\.wgpuGeometryCacheMode = this\.wgpuGeometryPack && !this\.wgpuLoadEpochFence\n/);
  assert.match(host, /requestedWgpuGeometryCacheMode\(window\.location\.search, defaultWgpuGeometryCacheMode\(this\.wasmEngine\)\)/);
  assert.ok(host.indexOf("this.wasmEngine =") < host.indexOf("this.wgpuGeometryCacheMode ="), "the engine is known first");
  assert.ok(host.indexOf("this.wgpuLoadEpochFence =") < host.indexOf("this.wgpuGeometryCacheMode ="), "the fence is read first");
  assert.match(worker, /wgpuGeometryCacheMode: payload\.wgpuGeometryCacheMode/);
});

test("the worker sets the cache at boot and after a device loss only, never around a save load", () => {
  const calls = [...worker.matchAll(/setWebGpuGeometryCacheEnabled\?\.\(wgpuGeometryCacheMode\)/g)];
  assert.equal(calls.length, 2);
  assert.match(worker, /api\.setWebGpuGeometryRangeEnabled\?\.\(wgpuGeometryRangeEnabled \? 1 : 0\);\n\s+api\.setWebGpuGeometryCacheEnabled\?\.\(wgpuGeometryCacheMode\);\n\s+api\.setCpuOverclock/);
  assert.match(worker, /invalidateGeometry: \(\) => \{[\s\S]{0,300}setWebGpuGeometryCacheEnabled\?\.\(wgpuGeometryCacheMode\);\n\s+\},/);
  assert.match(worker, /case "validationReadGeometryCache":\n\s+return harnessGeometryCacheStats\(\);/);
  assert.match(worker, /wgpuLoadEpochFence = Boolean\(requestedWgpuLoadEpochFence\);\n[^\n]*\n[^\n]*\n\s+if \(wgpuLoadEpochFence\) wgpuGeometryCacheMode = 0;/);
});

test("0204 keys packets by XXH3-128 over the uploaded bytes, before the stream path and its range", () => {
  assert.match(patch, /\+\s+XXH3_128bits_update\(&state, m_base_buffer_pointer, vertex_bytes\);/);
  assert.match(patch, /\+\s+XXH3_128bits_update\(&state, m_cpu_index_buffer\.data\(\), index_bytes\);/);
  assert.match(patch, /\+\s+if \(IsGeometryCacheEnabled\(\)\)\n\+\s+\{\n\+\s+const GeometryCacheResult cached = TryGeometryCache\(/);
  assert.match(patch, /\+  xxhash::xxhash/);
});

test("0204 never overwrites an entry used in the current submit, and caps insertions per frame", () => {
  assert.match(patch, /\+\s+if \(entry\.used_submit == submit_serial\)\n\+\s+return std::nullopt;/);
  assert.match(patch, /\+\s+if \(!slot\)\n\+\s+\{\n\+\s+s_geometry_cache_stats\.blocked \+= 1;\n\+\s+return miss\(\);/);
  assert.match(patch, /\+\s+static constexpr u32 kGeometryCacheInsertCapPerFrame = 1024u \* 1024u;/);
  assert.match(patch, /\+\s+static constexpr u32 kGeometryCacheSize = 32u \* 1024u \* 1024u;/);
});

test("0204: placement epochs keep the cache; its own setter retires its buffer", () => {
  assert.match(patch, /\+\s+if \(m_cache_buffer_id != 0\)\n\+\s+m_retired_geometry_buffers\.push_back\(m_cache_buffer_id\);/);
  assert.match(patch, /FailVertexManagerSmoke\(529, "a placement epoch emptied the content cache"\)/);
  for (const code of [517, 518, 519, 520, 521, 522, 523, 524, 525, 526, 527, 528, 529, 530, 531,
    532, 533, 534, 535, 536, 537, 538, 539, 540, 541, 542, 543, 544, 545, 546, 547]) {
    assert.match(patch, new RegExp(`FailVertexManagerSmoke\\(${code},`));
  }
});

test("0204: a wrap first evicts the previous lap's leftovers past the write position (#370 review)", () => {
  // at a wrap: every leftover (at or past the write position), then the
  // entries under the new slot
  assert.match(patch, /\+\s+wraps \? \(leftover \|\| entry\.offset < offset \+ packet_bytes\) :/);
  assert.match(patch, /FailVertexManagerSmoke\(537, "a wrap overwrote an entry without evicting it"\)/);
});

test("0204: outside a wrap, every leftover before the slot's end goes, the alignment gap's included (#370 review)", () => {
  assert.match(patch, /\+\s+const bool leftover = entry\.offset >= m_cache_write;/);
  assert.match(patch, /\+\s+wraps \? \(leftover \|\| entry\.offset < offset \+ packet_bytes\) :\n\+\s+\(leftover && entry\.offset < offset \+ packet_bytes\);/);
  assert.match(patch, /FailVertexManagerSmoke\(546, "the ring overwrote a live entry"\)/);
});
