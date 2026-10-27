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

test("spark-run takes --query=... like --query ...: the bench swap and the switch check both see it", async () => {
  const { benchRaceArgs } = await import("../harness/remote/spark-run.mjs");
  assert.equal(asksNoXfbDecode(["--query=video=null&xfbdecode=0"]), true);
  const { args } = benchRaceArgs(["--query=core=upstream&video=wgpu&presenter=webgpu", "--hold="]);
  assert.equal(new URLSearchParams(args[args.indexOf("--query") + 1]).get("video"), "null", "the wgpu query is made fit for the bench");
  assert.deepEqual(args.slice(args.indexOf("--hold"), args.indexOf("--hold") + 2), ["--hold", ""]);
});

test("visual probes refuse video=null&xfbdecode=0, other queries pass", async () => {
  const { visualProbeCheck, xfbDecodeOff } = await import("../harness/lib/matrix.mjs");
  assert.equal(xfbDecodeOff("video=null&xfbdecode=0"), true);
  assert.equal(xfbDecodeOff("video=wgpu&xfbdecode=0"), false, "WebGPU never decodes; the switch means nothing there");
  assert.equal(xfbDecodeOff("video=null"), false);
  assert.match(visualProbeCheck(["video=wgpu", "video=null&xfbdecode=0"], { "--display": true }), /--display/);
  assert.equal(visualProbeCheck(["video=null&xfbdecode=0"], { "--display": false, "--unique-frames": false }), null);
  assert.equal(visualProbeCheck(["video=null"], { "drop-meter": true }), null);
  const race = await read("../harness/probes/race-perf.mjs");
  assert.match(race, /visualProbeCheck\(\[query, baselineQuery\], \{ "--display": o\.display, "--unique-frames": o\.uniqueFrames != null \}\)/);
  const drops = await read("../harness/probes/drop-meter.mjs");
  assert.match(drops, /visualProbeCheck\(\[query\.toString\(\), baselineQuery\?\.toString\(\)\], \{ "drop-meter": true \}\)/);
});

test("race-perf keeps 0156's top 64 of a stats window", async () => {
  const { regionRecord } = await import("../harness/probes/race-perf.mjs");
  const race = await read("../harness/probes/race-perf.mjs");
  assert.match(race, /Array\.isArray\(reply\.missTop\) && reply\.missTop\.length \? \{ missTop: reply\.missTop \}/);
  assert.equal(regionRecord({ error: "x" }).missTop, undefined);
});
