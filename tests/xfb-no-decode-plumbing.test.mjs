// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later
//
// ?xfbdecode=0: under video=null only, the core skips the XFB's YUV->RGBA
// decode on the CPU thread (a cost WebGPU never pays), for the Spark bench.
// The adapter rebuilds the init message field by field: every hop is checked.
// spark-run refuses the switch unless every side knows it.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { asksNoXfbDecode, xfbSwitchTest } from "../harness/remote/spark-run.mjs";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("xfbdecode=0 goes URL → host → adapter → worker → Module → core, null backend only", async () => {
  const host = await read("../src/core-host.js");
  assert.match(host, /this\.xfbNoDecode = new URLSearchParams\(window\.location\.search\)\.get\("xfbdecode"\) === "0";/);
  assert.match(host, /\n {12}xfbNoDecode: this\.xfbNoDecode,\n/);
  const adapter = await read("../src/upstream-worker-adapter.js");
  assert.match(adapter, /this\.xfbNoDecode = Boolean\(xfbNoDecode\);/);
  assert.match(adapter, /\n {6}xfbNoDecode: this\.xfbNoDecode,\n/);
  const worker = await read("../src/upstream-discio-worker.js");
  assert.match(worker, /\n {8}xfbNoDecode: payload\.xfbNoDecode,\n/);
  assert.match(worker, /dolphinXfbNoDecode: Boolean\(xfbNoDecode\),/);
  const core = await read("../core/upstream/dolphin_web_core.cpp");
  assert.match(core, /Module\['dolphinXfbNoDecode'\]/);
  assert.match(core, /s_video_backend == "WebGPU" \|\| \(s_video_backend == "Null" && xfb_no_decode\);/);
});

test("the adapter carries xfbNoDecode, off by default", async () => {
  const { UpstreamWorkerAdapter } = await import("../src/upstream-worker-adapter.js");
  assert.equal(new UpstreamWorkerAdapter({}).xfbNoDecode, false);
  assert.equal(new UpstreamWorkerAdapter({ xfbNoDecode: true }).xfbNoDecode, true);
});

test("spark-run sees the switch in a query and checks both the core's glue and the worker", () => {
  assert.equal(asksNoXfbDecode(["--query", "video=null&xfbdecode=0"]), true);
  assert.equal(asksNoXfbDecode(["--baseline-query", "xfbdecode=0&video=null"]), true);
  assert.equal(asksNoXfbDecode(["--query", "video=null&xfbdecode=1"]), false);
  assert.equal(asksNoXfbDecode(["--query", "video=null", "--name", "xfbdecode=0"]), false);
  const t = xfbSwitchTest("trees/x");
  assert.match(t, /dolphinXfbNoDecode trees\/x\/cores\/dolphin\/dolphin-core-upstream\.js/);
  assert.match(t, /dolphinXfbNoDecode trees\/x\/src\/upstream-discio-worker\.js/);
});
