// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// ?audiobuffer=N: the core mixer's queue (Dolphin's AudioBufferSize), from the
// page's URL to the core's config. Options the adapter forgot to carry were
// silently dropped before (?aotsample, ?wasmengine): every hop is checked.
test("?audiobuffer: 40 ms by default when the worklet can run, the core's 80 ms otherwise, a value in range overrides", async () => {
  const { requestedAudioBufferMs } = await import("../src/core-host.js");
  const able = { crossOriginIsolated: true, SharedArrayBuffer, AudioWorkletNode: function () {} };
  const q = (search, g = able) => requestedAudioBufferMs(search, g);
  // 40 ms by default with the worklet (the 2026-10-28 pairs); the core's
  // 80 ms with ?audiotransport=legacy; an out-of-range value is ignored
  assert.equal(q(""), 40);
  assert.equal(q("?audiotransport=legacy"), 0);
  assert.equal(q("?audiobuffer=80"), 80);
  assert.equal(q("?audiobuffer=40&audiotransport=legacy"), 40);
  assert.equal(q("?audiobuffer=8"), 40, "under the mixer's 4 granules: the default");
  assert.equal(q("?audiobuffer=500&audiotransport=legacy"), 0);
  assert.equal(q("?audiobuffer=x"), 40);
  // Review of #327: the core takes the queue before the boot, the transport
  // is chosen after: a page that will fall back to legacy keeps 80 ms
  assert.equal(q("", { ...able, crossOriginIsolated: false }), 0, "no isolation");
  assert.equal(q("", { ...able, SharedArrayBuffer: undefined }), 0, "no SharedArrayBuffer");
  assert.equal(q("", { ...able, AudioWorkletNode: undefined }), 0, "no AudioWorkletNode");
  assert.equal(q("?audiobuffer=40", { crossOriginIsolated: false }), 40, "an explicit value still wins");
});

test("?audiobuffer reaches the worker's init message through the adapter", async (t) => {
  const { UpstreamWorkerAdapter } = await import("../src/upstream-worker-adapter.js");
  const adapter = new UpstreamWorkerAdapter({ audioBufferMs: 40 });
  let posted = null;
  adapter.worker = {
    postMessage(message) {
      posted = message;
      queueMicrotask(() => adapter.handleMessage({ id: message.id, ok: true }));
    }
  };
  const originalWindow = globalThis.window;
  globalThis.window = { location: { href: "http://127.0.0.1:8080/?audiobuffer=40", search: "?audiobuffer=40" } };
  t.after(() => {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  });
  await adapter.load();
  assert.equal(posted.payload.audioBufferMs, 40);
});

test("?audiobuffer: the host passes it, the worker calls the core's setter before the boot, the core sets AudioBufferSize", async () => {
  const host = await readFile(new URL("../src/core-host.js", import.meta.url), "utf8");
  const worker = await readFile(new URL("../src/upstream-discio-worker.js", import.meta.url), "utf8");
  const core = await readFile(new URL("../core/upstream/dolphin_web_core.cpp", import.meta.url), "utf8");
  assert.equal(host.match(/\n {12}audioBufferMs: this\.audioBufferMs,\n/g)?.length, 2, "both of the host's init paths");
  assert.match(worker, /\n {8}audioBufferMs: payload\.audioBufferMs,\n/);
  assert.match(worker, /if \(Number\(audioBufferMs\) > 0\) api\.setAudioBufferMs\?\.\(Number\(audioBufferMs\)\);/);
  assert.match(worker, /module\._DolphinWeb_SetAudioBufferMs\(Number\(ms\) \| 0\)/);
  assert.match(core, /int DolphinWeb_SetAudioBufferMs\(int ms\)\n\{\n {2}if \(s_runtime_initialized \|\| ms < 16 \|\| ms > 200\)/);
  assert.match(core, /if \(s_audio_buffer_ms > 0\)\n {4}Config::SetBase\(Config::MAIN_AUDIO_BUFFER_SIZE, s_audio_buffer_ms\);/);
});

// 0186: the mixer's queue, read-only, from the core's export to the producer.
test("0186: the core exports the mixer's queue, the worker hands it to the producer", async () => {
  const core = await readFile(new URL("../core/upstream/dolphin_web_core.cpp", import.meta.url), "utf8");
  const worker = await readFile(new URL("../src/upstream-discio-worker.js", import.meta.url), "utf8");
  const patch = await readFile(new URL("../patches/dolphin-wasm/snapshot/0186-mixer-queue-depth.patch", import.meta.url), "utf8");
  assert.match(core, /EMSCRIPTEN_KEEPALIVE\n#endif\ndouble DolphinWeb_AudioQueuedMs\(\)/);
  assert.match(core, /mixer->GetQueuedMicroseconds\(\)/);
  assert.match(patch, /u64 GetQueuedMicroseconds\(\) const/);
  // only additions: nothing the emulation runs is changed
  assert.deepEqual(patch.split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---")), []);
  assert.match(worker, /audioQueuedMs:\s*\n?\s*typeof module\._DolphinWeb_AudioQueuedMs === "function"/);
  assert.match(worker, /audioQueuedMs: api\?\.audioQueuedMs/);
});
