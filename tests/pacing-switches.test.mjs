// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Patch 0150's pacing switches, each from the page's URL to the core's config:
// ?rush=1 (Rush is off by default), ?synconidle=1, ?dupvsync=1. An option the adapter forgot to carry
// was silently dropped twice (?aotsample, ?wasmengine; and ?synconidle, which
// the harness trusted while the core ignored it): every hop is checked.
const SWITCHES = [
  { param: "rush=1", option: "rushPresentation", on: true, flag: "dolphinRushPresentation" },
  { param: "synconidle=1", option: "syncOnSkipIdle", on: true, flag: "dolphinSyncOnSkipIdle" },
  { param: "dupvsync=1", option: "dupXfbRearmsThrottle", on: true, flag: "dolphinDupXfbRearmsThrottle" }
];

test("pacing switches: URL parsing, shipped defaults, each switch only its own", async () => {
  const { requestedPacing } = await import("../src/core-host.js");
  // Rush off by default (upstream's default): ?rush=1 turns it back on.
  assert.deepEqual(requestedPacing(""), { rushPresentation: false, syncOnSkipIdle: false, dupXfbRearmsThrottle: false, presentVsync: false });
  for (const s of SWITCHES) {
    const p = requestedPacing(`?${s.param}`);
    assert.equal(p[s.option], s.on, s.param);
    for (const other of SWITCHES.filter((o) => o !== s)) assert.equal(p[other.option], !other.on, `${s.param} leaves ${other.option}`);
  }
  assert.equal(requestedPacing("?rush=0").rushPresentation, false);
  assert.equal(requestedPacing("?synconidle=0").syncOnSkipIdle, false);
});

test("pacing switches reach the worker's init message through the adapter", async (t) => {
  const { requestedPacing } = await import("../src/core-host.js");
  const { UpstreamWorkerAdapter } = await import("../src/upstream-worker-adapter.js");
  const adapter = new UpstreamWorkerAdapter(requestedPacing("?rush=1&synconidle=1&dupvsync=1"));
  let posted = null;
  adapter.worker = {
    postMessage(message) {
      posted = message;
      queueMicrotask(() => adapter.handleMessage({ id: message.id, ok: true }));
    }
  };
  const originalWindow = globalThis.window;
  globalThis.window = { location: { href: "http://127.0.0.1:8080/?rush=1&synconidle=1&dupvsync=1", search: "?rush=1&synconidle=1&dupvsync=1" } };
  t.after(() => {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  });
  await adapter.load();
  for (const s of SWITCHES) assert.equal(posted.payload[s.option], s.on, `${s.option} in the init payload`);
});

test("pacing switches: host passes them, the worker sets the Module flags, the core reads them into its config", async () => {
  const host = await readFile(new URL("../src/core-host.js", import.meta.url), "utf8");
  const worker = await readFile(new URL("../src/upstream-discio-worker.js", import.meta.url), "utf8");
  const core = await readFile(new URL("../core/upstream/dolphin_web_core.cpp", import.meta.url), "utf8");
  for (const s of SWITCHES) {
    assert.match(host, new RegExp(`\\n {12}${s.option}: this\\.pacing\\.${s.option},\\n`), `host passes ${s.option}`);
    assert.match(worker, new RegExp(`\\n {8}${s.option}: payload\\.${s.option},\\n`), `worker reads ${s.option} from the payload`);
    assert.match(worker, new RegExp(`\\n {4}${s.flag}: ${s.option} [!=]== (true|false),\\n`), `worker sets Module['${s.flag}']`);
    assert.match(core, new RegExp(`Module\\['${s.flag}'\\]`), `core reads Module['${s.flag}']`);
  }
  assert.match(core, /Config::SetBase\(Config::MAIN_RUSH_FRAME_PRESENTATION, rush_presentation\);/);
  assert.match(core, /Config::SetBase\(Config::MAIN_SYNC_ON_SKIP_IDLE, sync_on_skip_idle\);/);
  assert.match(core, /DolphinWeb_SetDupXfbRearmsThrottle\(/);
  // the harness reads back what the core applied, from its effective config
  assert.match(worker, /case "validationReadPacingConfig":/);
  assert.match(worker, /syncOnSkipIdle: Boolean\(bits & 1\), rushFramePresentation: Boolean\(bits & 2\), dupXfbResetsThrottle: Boolean\(bits & 4\)/);
});

test("Rush off by default: a page or core that sets nothing runs without Rush Frame Presentation", async () => {
  const { UpstreamWorkerAdapter } = await import("../src/upstream-worker-adapter.js");
  assert.equal(new UpstreamWorkerAdapter({}).rushPresentation, false);
  const core = await readFile(new URL("../core/upstream/dolphin_web_core.cpp", import.meta.url), "utf8");
  assert.match(core, /Module\['dolphinRushPresentation'\] === true\) \? 1 : 0;/, "the core's own default is off too");
  const worker = await readFile(new URL("../src/upstream-discio-worker.js", import.meta.url), "utf8");
  assert.match(worker, /\n  rushPresentation = false,\n/);
});

// ?presentvsync=1 (research/deep-frame-pacing.md §5 step 2): at most one wgpu
// present per BeginFrame, held in the worker (no core flag).
test("presentvsync: URL → host → adapter → worker, off by default", async (t) => {
  const { requestedPacing } = await import("../src/core-host.js");
  assert.equal(requestedPacing("").presentVsync, false);
  assert.equal(requestedPacing("?presentvsync=1").presentVsync, true);
  assert.equal(requestedPacing("?presentvsync=1").rushPresentation, false, "only its own switch");
  const { UpstreamWorkerAdapter } = await import("../src/upstream-worker-adapter.js");
  assert.equal(new UpstreamWorkerAdapter({}).presentVsync, false);
  const adapter = new UpstreamWorkerAdapter(requestedPacing("?presentvsync=1"));
  let posted = null;
  adapter.worker = {
    postMessage(message) {
      posted = message;
      queueMicrotask(() => adapter.handleMessage({ id: message.id, ok: true }));
    }
  };
  const originalWindow = globalThis.window;
  globalThis.window = { location: { href: "http://127.0.0.1:8080/?presentvsync=1", search: "?presentvsync=1" } };
  t.after(() => {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  });
  await adapter.load();
  assert.equal(posted.payload.presentVsync, true, "presentVsync in the init payload");
  const host = await readFile(new URL("../src/core-host.js", import.meta.url), "utf8");
  const worker = await readFile(new URL("../src/upstream-discio-worker.js", import.meta.url), "utf8");
  assert.match(host, /\n {12}presentVsync: this\.pacing\.presentVsync,\n/);
  assert.match(worker, /\n {8}presentVsync: payload\.presentVsync,\n/);
  assert.match(worker, /wgpuPresentVsync = presentVsync === true && typeof self\.requestAnimationFrame === "function";/, "only with a worker rAF");
});

test("presentvsync: the backbuffer pass renders into a pooled texture, shown at the worker's rAF, the drain never held", async () => {
  const worker = await readFile(new URL("../src/upstream-discio-worker.js", import.meta.url), "utf8");
  // fb#0's BEGIN_PASS: the pool's texture in place of the canvas's
  assert.match(worker, /const cur = wgpuPresentVsync\n\s+\? acquireWgpuVsyncTexture\([^)]*\)\n\s+: renderGpu\.context\.getCurrentTexture\(\);/);
  // the present queues the frame; streaming and the present count follow the display
  assert.match(worker, /if \(wgpuPresentVsync && lastBackbufferTexture\) \{\n[^\n]*\n\s+queueWgpuVsyncFrame\(lastBackbufferTexture,/);
  const present = worker.slice(worker.indexOf("function presentWgpuVsyncFrame()"), worker.indexOf("function wgpuCanvasUsage("));
  assert.match(present, /const f = wgpuVsyncQueue\.shift\(\);/, "the oldest queued frame");
  assert.match(present, /copyTextureToTexture\(/);
  assert.match(present, /streamCapture\.offerCanvas\(renderCanvas, f\.coreFrame\)/);
  assert.match(present, /recordPresentedFrame\(f\.coreFrame, f\.shownVi\)/);
  // at the worker's rAF, a timer when no BeginFrame comes; the canvas can be copied to
  assert.match(worker, /self\.requestAnimationFrame\(tick\)/);
  assert.match(worker, /setTimeout\(wgpuVsyncFallbackCheck, WGPU_VSYNC_FALLBACK_MS\)/);
  assert.equal((worker.match(/wgpuPresentVsync \? (textureUsage|self\.GPUTextureUsage)\.COPY_DST : 0/g) ?? []).length, 3, "every configure keeps COPY_DST");
  // v1 held the drain and the core skipped frames: never again
  assert.doesNotMatch(worker, /"display-tick"/);
});
