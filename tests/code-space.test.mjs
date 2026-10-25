// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Patch 0138: the CachedInterpreter code space by engine (32 MiB under JSC,
// 128 elsewhere), ?codespace=<4..128> to force it; from the page to the core.
test("code space: 32 MiB under JSC, 128 elsewhere, ?codespace overrides in range", async () => {
  const { requestedCodeSpaceMiB, CODE_SPACE_MIB_JSC, CODE_SPACE_MIB_DEFAULT } = await import("../src/core-host.js");
  assert.equal(CODE_SPACE_MIB_JSC, 32);
  assert.equal(CODE_SPACE_MIB_DEFAULT, 128);
  assert.equal(requestedCodeSpaceMiB("", "jsc"), 32);
  for (const engine of ["v8", "spidermonkey", "unknown", undefined]) assert.equal(requestedCodeSpaceMiB("", engine), 128, String(engine));
  assert.equal(requestedCodeSpaceMiB("?codespace=64", "jsc"), 64);
  assert.equal(requestedCodeSpaceMiB("?codespace=32", "v8"), 32);
  for (const bad of ["?codespace=0", "?codespace=3", "?codespace=129", "?codespace=1e2", "?codespace=%2032"]) {
    assert.equal(requestedCodeSpaceMiB(bad, "v8"), 128, bad);
    assert.equal(requestedCodeSpaceMiB(bad, "jsc"), 32, bad);
  }
});

test("code space reaches the worker's init message through the adapter", async (t) => {
  const { UpstreamWorkerAdapter } = await import("../src/upstream-worker-adapter.js");
  const adapter = new UpstreamWorkerAdapter({ codeSpaceMiB: 32 });
  let posted = null;
  adapter.worker = {
    postMessage(message) {
      posted = message;
      queueMicrotask(() => adapter.handleMessage({ id: message.id, ok: true }));
    }
  };
  const originalWindow = globalThis.window;
  globalThis.window = { location: { href: "http://127.0.0.1:8080/?wasmengine=jsc", search: "?wasmengine=jsc" } };
  t.after(() => {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  });
  await adapter.load();
  assert.equal(posted.payload.codeSpaceMiB, 32);
});

test("code space: the host resolves it after the engine, the worker hands it to the core, the core allocates it", async () => {
  const host = await readFile(new URL("../src/core-host.js", import.meta.url), "utf8");
  const worker = await readFile(new URL("../src/upstream-discio-worker.js", import.meta.url), "utf8");
  const patch = await readFile(new URL("../patches/dolphin-wasm/snapshot/0138-cached-interpreter-code-space-by-engine.patch", import.meta.url), "utf8");
  const engineAt = host.indexOf("this.wasmEngine = wasmEngine(");
  const spaceAt = host.indexOf("this.codeSpaceMiB = requestedCodeSpaceMiB(window.location.search, this.wasmEngine);");
  assert.ok(engineAt > 0 && spaceAt > engineAt, "resolved from the engine, after it");
  assert.match(host, /\n {12}codeSpaceMiB: this\.codeSpaceMiB,\n/);
  assert.match(worker, /\n {8}codeSpaceMiB: payload\.codeSpaceMiB,\n/);
  assert.match(worker, /api\.setCodeSpaceMiB\?\.\(codeSpaceMiB\)/);
  assert.match(worker, /setCodeSpaceMiB: optionalCwrap\("DolphinWeb_SetCodeSpaceMiB"/);
  assert.match(patch, /\+extern "C" EMSCRIPTEN_KEEPALIVE void DolphinWeb_SetCodeSpaceMiB\(int mib\)/);
  assert.match(patch, /\+std::atomic<u32> s_code_space_mib\{128\};/, "a core the page sets nothing on keeps 128 MiB");
  assert.match(patch, /AllocCodeSpace\(size_t\{s_code_space_mib\.load/);
});
