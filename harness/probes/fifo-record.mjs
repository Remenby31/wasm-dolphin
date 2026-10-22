#!/usr/bin/env node
// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// Records a FIFO log (.dff, FifoPlayer's format) from one of our homebrews:
// boots it on the software renderer (cpu=single), lets it settle, then has
// the core's FifoRecorder capture the next frames. The log replays the same
// GPU commands on any backend without the homebrew's CPU side: the "fifo"
// lane (harness/matrices/fifo-homebrew.json) compares backends on it.
// Only our homebrews are recorded: no game content.
//
//   node harness/probes/fifo-record.mjs --iso harness/homebrew/out/gxscene.iso --port N
//     [--frames 10] [--settle 8] [--out harness/homebrew/out/gxscene.dff]
import { writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { ensureServer, REPO_ROOT } from "../lib/browser.mjs";
import { PRESETS } from "../lib/matrix.mjs";
import { openSession } from "../lib/session.mjs";

const HOMEBREW_OUT = path.join(REPO_ROOT, "harness", "homebrew", "out");
const { values } = parseArgs({
  options: {
    iso: { type: "string" }, port: { type: "string", default: process.env.HARNESS_PORT },
    frames: { type: "string", default: "10" }, settle: { type: "string", default: "8" }, out: { type: "string" }
  }
});
if (!values.iso || !values.port) throw new Error("usage: fifo-record.mjs --iso harness/homebrew/out/<name>.iso --port N [--frames 10]");
const iso = path.resolve(values.iso);
if (!iso.startsWith(HOMEBREW_OUT + path.sep)) throw new Error("only our homebrews are recorded (harness/homebrew/out)");
if (!values.out && !iso.endsWith(".iso")) throw new Error("--out is required unless the input is an .iso");
const out = path.resolve(values.out ?? iso.replace(/\.iso$/, ".dff"));
if (out === iso) throw new Error("--out must not be the input");
// The preset carries cpu=dual: set (not append) cpu=single so the log is
// recorded single-threaded.
const query = new URLSearchParams(PRESETS["sw-interp"]);
query.set("cpu", "single");
query.set("metrics", "1");

const server = await ensureServer({ port: values.port });
const session = await openSession({ base: server.base, server, query: query.toString(), iso });
try {
  await session.page.waitForTimeout(Number(values.settle) * 1000);
  // Bytes cross the page as base64, as captureAtVi does.
  const log = await session.page.evaluate(async (payload) => {
    try {
      const r = await window.__host.adapter.request("validationFifoRecord", payload);
      const u8 = new Uint8Array(r.bytes.buffer ?? r.bytes);
      let bin = "";
      for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
      return { frames: r.frames, size: r.size, b64: btoa(bin) };
    } catch (e) {
      return { error: String(e?.message || e) };
    }
  }, { frames: Number(values.frames) });
  if (log?.error) throw new Error(log.error);
  const bytes = Buffer.from(log.b64, "base64");
  if (bytes.length !== log.size) throw new Error(`FIFO log truncated: ${bytes.length} of ${log.size} bytes`);
  writeFileSync(out, bytes);
  console.log(`[fifo-record] ${log.frames} frames, ${log.size} bytes -> ${out}`);
} finally {
  await session.close();
}
process.exit(0);
