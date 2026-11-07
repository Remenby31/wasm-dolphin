// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later
//
// ?efbdefer=0: EFB copies to RAM not deferred (Dolphin's DeferEFBCopies=False),
// a base-layer value under any GameINI. The adapter rebuilds the init message
// field by field (options were silently dropped twice): every hop is checked.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("efbdefer=0 goes URL → host → adapter → worker → Module → base config", async () => {
  const host = await read("../src/core-host.js");
  assert.match(host, /this\.efbNoDefer = new URLSearchParams\(window\.location\.search\)\.get\("efbdefer"\) === "0";/);
  assert.match(host, /\n {12}efbNoDefer: this\.efbNoDefer,\n/);
  const adapter = await read("../src/upstream-worker-adapter.js");
  assert.match(adapter, /this\.efbNoDefer = Boolean\(efbNoDefer\);/);
  assert.match(adapter, /\n {6}efbNoDefer: this\.efbNoDefer,\n/);
  const worker = await read("../src/upstream-discio-worker.js");
  assert.match(worker, /\n {8}efbNoDefer: payload\.efbNoDefer,\n/);
  assert.match(worker, /dolphinEfbNoDefer: Boolean\(efbNoDefer\),/);
  const core = await read("../core/upstream/dolphin_web_core.cpp");
  assert.match(core, /Module\['dolphinEfbNoDefer'\]/);
  assert.match(core, /Config::SetBase\(Config::GFX_HACK_DEFER_EFB_COPIES, !efb_no_defer\);/);
});

test("the adapter carries efbNoDefer, off by default", async () => {
  const { UpstreamWorkerAdapter } = await import("../src/upstream-worker-adapter.js");
  assert.equal(new UpstreamWorkerAdapter({}).efbNoDefer, false);
  assert.equal(new UpstreamWorkerAdapter({ efbNoDefer: true }).efbNoDefer, true);
});
