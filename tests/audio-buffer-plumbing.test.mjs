// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// ?audiobuffer=N: the core mixer's queue (Dolphin's AudioBufferSize), from the
// page's URL to the core's config. Options the adapter forgot to carry were
// silently dropped before (?aotsample, ?wasmengine): every hop is checked.
test("?audiobuffer: parsed in range only, 0 (the core's 80 ms) otherwise", async () => {
  const { requestedAudioBufferMs } = await import("../src/core-host.js");
  assert.equal(requestedAudioBufferMs(""), 0);
  assert.equal(requestedAudioBufferMs("?audiobuffer=40"), 40);
  assert.equal(requestedAudioBufferMs("?audiobuffer=8"), 0, "under the mixer's 4 granules");
  assert.equal(requestedAudioBufferMs("?audiobuffer=500"), 0);
  assert.equal(requestedAudioBufferMs("?audiobuffer=x"), 0);
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
