#!/usr/bin/env node
// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// Play soak, no savestate: boots a disc (headless), plays a step script
// (menus into gameplay), then for --secs checks every --every seconds that
// the game draws: EFB-to-XFB copies (headroom) and DrawDone signals (GPU
// sync) in each window. It also reports the core's GP-read-disable waits
// (patch 0116): a game re-pointing its GP FIFO (GXSetGPFifo) while a chunk
// was still decoding, the race that left the FIFO empty with commands
// pending. Windows during the steps are reported, not judged.
//
//   node harness/probes/play-soak.mjs --iso disc.iso --steps steps.json --port N
//     [--query "...video=wgpu..."] [--secs 600] [--every 10] [--out dir]
//
// Exit status 1 when a window after the steps has no XFB copy.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { ensureServer, workerRequest } from "../lib/browser.mjs";
import { consistentHeadroomRead, decodeHeadroomStats } from "../lib/headroom.mjs";
import { PRESETS } from "../lib/matrix.mjs";
import { openSession } from "../lib/session.mjs";
import { runSteps, validateSteps } from "../lib/steps.mjs";

const { values } = parseArgs({
  options: {
    iso: { type: "string" }, steps: { type: "string" }, port: { type: "string", default: process.env.HARNESS_PORT },
    query: { type: "string" }, secs: { type: "string", default: "600" }, every: { type: "string", default: "10" },
    out: { type: "string" },
  },
});
if (!values.iso || !values.steps || !values.port) throw new Error("usage: play-soak.mjs --iso disc.iso --steps steps.json --port N [--secs 600]");
const iso = path.resolve(values.iso);
if (!existsSync(iso)) throw new Error(`disc image not found: ${iso}`);
const steps = validateSteps(JSON.parse(readFileSync(values.steps, "utf8")));
const query = `${values.query ?? PRESETS["wgpu-nojit"]}&metrics=1`;
const everyMs = Number(values.every) * 1000, secs = Number(values.secs);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const req = (page, type, payload = {}) => workerRequest(page, type, payload, 10000).catch((e) => ({ error: String(e.message || e) }));
async function headroom(page, reset) {
  const r = await req(page, "validationReadHeadroomStats", { reset });
  if (r?.error) return { error: r.error };
  const s = consistentHeadroomRead(decodeHeadroomStats(r.bytes), decodeHeadroomStats(r.again));
  return s.error ? { error: s.error } : s;
}

const server = await ensureServer({ port: values.port });
const session = await openSession({ base: server.base, server, query, iso });
const { page } = session;
const record = { probe: "play-soak", iso: path.basename(iso), query, windows: [], at: new Date().toISOString() };
let stalls = 0;
try {
  await req(page, "validationEnableGpuSyncDiag", { enabled: true });
  let stepsDone = false;
  const playing = runSteps(page, steps).then(() => { stepsDone = true; });
  const t0 = Date.now();
  let before = (await req(page, "validationReadWgpuReplayState"))?.gpuSync;
  await headroom(page, 0);
  while ((Date.now() - t0) / 1000 < secs) {
    await sleep(everyMs);
    const hr = await headroom(page, 0); // read this window, reset for the next
    const after = (await req(page, "validationReadWgpuReplayState"))?.gpuSync;
    const w = {
      t: Math.round((Date.now() - t0) / 1000), judged: stepsDone,
      xfbCopies: hr.error ? null : hr.xfbCopies,
      finish: (after?.counters?.finishSignalled ?? 0) - (before?.counters?.finishSignalled ?? 0),
      readDisableWaits: after?.savestatePause?.readDisableWaits ?? null,
      readDisableMaxUs: after?.savestatePause?.readDisableMaxUs ?? null,
      fifo: after?.fifo ?? null,
    };
    before = after;
    w.ok = Boolean(w.xfbCopies > 0 && w.finish > 0);
    if (w.judged && !w.ok) stalls += 1;
    record.windows.push(w);
    console.log(`[play-soak] ${w.t}s${w.judged ? "" : " (steps)"}: xfbCopies ${w.xfbCopies} finish +${w.finish} readDisableWaits ${w.readDisableWaits} max ${w.readDisableMaxUs} us${w.judged && !w.ok ? ` STALL fifo ${JSON.stringify(w.fifo)}` : ""}`);
  }
  await playing;
} finally {
  await session.close();
}
record.stalls = stalls;
const last = record.windows.at(-1);
record.readDisableWaits = last?.readDisableWaits ?? null;
record.readDisableMaxUs = last?.readDisableMaxUs ?? null;
if (values.out) {
  mkdirSync(values.out, { recursive: true });
  writeFileSync(path.join(values.out, "play-soak.json"), JSON.stringify(record, null, 1));
}
console.log(`[play-soak] ${stalls} stalled window(s) after the steps; GP read disables that waited for a chunk: ${record.readDisableWaits} (longest ${record.readDisableMaxUs} us)`);
process.exit(stalls ? 1 : 0);
