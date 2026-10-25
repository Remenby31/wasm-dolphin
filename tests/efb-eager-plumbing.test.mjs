// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later
//
// ?efbeager=1 (patch 0166): EFB copies to RAM that would block the video
// thread are written as soon as they land. Every hop of the switch is
// checked (the adapter rebuilds the init message field by field), and the
// patch keeps the exact behavior unless the switch is on, in dual core.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("efbeager=1 goes URL → host → adapter → worker → Module → core flag", async () => {
  const host = await read("../src/core-host.js");
  assert.match(host, /this\.efbEager = new URLSearchParams\(window\.location\.search\)\.get\("efbeager"\) === "1";/);
  assert.match(host, /\n {12}efbEager: this\.efbEager,\n/);
  const adapter = await read("../src/upstream-worker-adapter.js");
  assert.match(adapter, /this\.efbEager = Boolean\(efbEager\);/);
  assert.match(adapter, /\n {6}efbEager: this\.efbEager,\n/);
  const worker = await read("../src/upstream-discio-worker.js");
  assert.match(worker, /\n {8}efbEager: payload\.efbEager,\n/);
  assert.match(worker, /dolphinEfbEager: Boolean\(efbEager\),/);
  const core = await read("../core/upstream/dolphin_web_core.cpp");
  assert.match(core, /Module\['dolphinEfbEager'\]/);
  assert.match(core, /extern "C" int DolphinWeb_EfbEager\(\)/);
});

test("the adapter carries efbEager, off by default", async () => {
  const { UpstreamWorkerAdapter } = await import("../src/upstream-worker-adapter.js");
  assert.equal(new UpstreamWorkerAdapter({}).efbEager, false);
  assert.equal(new UpstreamWorkerAdapter({ efbEager: true }).efbEager, true);
});

test("patch 0166: exact unless the switch is on in dual core; every GPU-side RAM read flushes overlapping copies", async () => {
  const patch = await read("../patches/dolphin-wasm/snapshot/0166-efb-eager-copies.patch");
  assert.match(patch, /return DolphinWeb_EfbEager\(\) != 0 && Core::System::GetInstance\(\)\.IsDualCoreMode\(\);/);
  assert.match(patch, /if \(!copy_to_vram \|\| \(!g_ActiveConfig\.bDeferEFBCopies && !EfbEagerActive\(\)\)\)/);
  // texture, XFB, TLUT and both TMEM preload paths
  assert.equal((patch.match(/FlushEFBCopiesOverlapping\(/g) ?? []).length >= 6, true);
  // in order: stop at the first copy still in flight
  assert.match(patch, /if \(staging && !staging->IsCopyComplete\(\)\)\n\+\s+break;/);
  // the GPU loop: landed copies after each chunk, all when idle
  assert.match(patch, /g_texture_cache->FlushLandedEFBCopies\(\);/);
  assert.match(patch, /if \(TextureCacheBase::EfbEagerActive\(\)\)\n\+\s+g_texture_cache->FlushEFBCopies\(\);/);
});
