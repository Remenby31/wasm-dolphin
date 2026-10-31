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
  { param: "dupvsync=1", option: "dupXfbRearmsThrottle", on: true, flag: "dolphinDupXfbRearmsThrottle" },
  { param: "smoothearly=0", option: "smoothEarly", on: false, flag: "dolphinSmoothEarly" }
];

test("pacing switches: URL parsing, shipped defaults, each switch only its own", async () => {
  const { requestedPacing } = await import("../src/core-host.js");
  // Rush off by default (upstream's default): ?rush=1 turns it back on. Game pacing on (?presentpace=off).
  assert.deepEqual(requestedPacing(""), { rushPresentation: false, syncOnSkipIdle: false, dupXfbRearmsThrottle: false, smoothEarly: true, sleepMarginUs: 0, sleepStepUs: 0, sleepK: 750, sleepSpinUs: 150, presentVsync: true, presentGamePace: true, presentPaceStats: true });
  for (const s of SWITCHES) {
    const p = requestedPacing(`?${s.param}`);
    assert.equal(p[s.option], s.on, s.param);
    for (const other of SWITCHES.filter((o) => o !== s)) assert.equal(p[other.option], !other.on, `${s.param} leaves ${other.option}`);
  }
  assert.equal(requestedPacing("?rush=0").rushPresentation, false);
  assert.equal(requestedPacing("?synconidle=0").syncOnSkipIdle, false);
  assert.equal(requestedPacing("?smoothearly=1").smoothEarly, true);
});

test("pacing switches reach the worker's init message through the adapter", async (t) => {
  const { requestedPacing } = await import("../src/core-host.js");
  const { UpstreamWorkerAdapter } = await import("../src/upstream-worker-adapter.js");
  const adapter = new UpstreamWorkerAdapter(requestedPacing("?rush=1&synconidle=1&dupvsync=1&smoothearly=0"));
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
  assert.match(core, /Config::SetBase\(Config::MAIN_SMOOTH_EARLY_PRESENTATION, smooth_early\);/);
  // the harness reads back what the core applied, from its effective config
  assert.match(worker, /case "validationReadPacingConfig":/);
  assert.match(worker, /syncOnSkipIdle: Boolean\(bits & 1\), rushFramePresentation: Boolean\(bits & 2\), dupXfbResetsThrottle: Boolean\(bits & 4\), presentSleep, sleepMarginUs, sleepStepUs, sleepK, sleepSpinUs \};/);
  assert.match(worker, /const presentSleep = typeof moduleInstance\?\._DolphinWeb_SetPresentOnArrival === "function" \? Boolean\(bits & 8\) : null;/);
  assert.match(core, /DolphinWeb_SetPresentOnArrival\(smooth_early \? 0 : 1\);/);
});

// Patch 0153: bit 3 of DolphinWeb_PacingConfig is the present sleep, and
// ?smoothearly=0 really removes it (a present-on-arrival path, not just
// SmoothEarly off, which with Rush off still sleeps to the intended time); the
// video thread's sleep to the present time is counted apart in the headroom
// struct's former spare f64 (offset 88, presentSleepUs), zeroed with the GPU
// thread's other counters, so it can be taken out of maxSpeedGpu.
test("0153: smoothearly readback bit and the present sleep in the headroom struct", async () => {
  const patch = await readFile(new URL("../patches/dolphin-wasm/snapshot/0153-smooth-early-switch-and-present-sleep.patch", import.meta.url), "utf8");
  assert.match(patch, /\+ +\(Config::Get\(Config::MAIN_SMOOTH_EARLY_PRESENTATION\) &&\n\+ +!DolphinWeb::g_present_on_arrival\.load\(std::memory_order_relaxed\) \?\n\+ +8u :/);
  assert.match(patch, /-  double spare = 0;\n\+  double present_sleep_us = 0;/, "the spare f64 (offset 88), layout v1 unchanged");
  assert.match(patch, /     g_stats\.xfb_copies = 0;\n\+    g_stats\.present_sleep_us = 0;/, "reset with the GPU thread's counters");
  // no sleep at all on arrival; the sleep's timing only while the counters are on
  assert.match(patch, /\+        if \(!DolphinWeb::g_present_on_arrival\.load\(std::memory_order_relaxed\)\)\n\+        \{\n\+          const bool timed = DolphinWeb::Headroom::g_on;\n\+          const auto sleep_start = timed \? Clock::now\(\) : TimePoint\{\};\n\+          Core::System::GetInstance\(\)\.GetCoreTiming\(\)\.SleepUntil\(present_time\);\n\+          if \(timed\)\n\+            DolphinWeb::Headroom::AddPresentSleep\(Clock::now\(\) - sleep_start\);/);
  const header = await readFile(new URL("../patches/dolphin-wasm/snapshot/0113-headroom-counters.patch", import.meta.url), "utf8");
  // the spare is the struct's last f64: 16-byte header + 9 f64 before it
  const fields = header.slice(header.indexOf("+struct Stats"), header.indexOf("+static_assert(sizeof(Stats) == 96);")).match(/\+  double \w+/g);
  assert.equal(fields.length, 10);
  assert.equal(fields[9], "+  double spare");
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
test("presentvsync: URL → host → adapter → worker, on by default, ?presentvsync=0 off", async (t) => {
  const { requestedPacing } = await import("../src/core-host.js");
  assert.equal(requestedPacing("").presentVsync, true, "on by default (2026-10-26)");
  assert.equal(requestedPacing("?presentvsync=0").presentVsync, false);
  for (const off of ["false", "off", "no", "OFF"]) assert.equal(requestedPacing(`?presentvsync=${off}`).presentVsync, false, off);
  assert.equal(requestedPacing("?presentvsync=1").presentVsync, true);
  assert.equal(requestedPacing("?presentvsync=1").rushPresentation, false, "only its own switch");
  const { UpstreamWorkerAdapter } = await import("../src/upstream-worker-adapter.js");
  assert.equal(new UpstreamWorkerAdapter({}).presentVsync, true);
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
  assert.match(worker, /wgpuPresentVsync = presentVsync !== false && typeof self\.requestAnimationFrame === "function" && !wgpuDetachedPresenter;/, "only with a worker rAF, never with the detached presenter (stale bitmap)");
});

// ?presentpace (src/wgpu-game-pacer.js): frames at the game's own pace on a
// screen faster than the game. On by default since 2026-10-28; =off turns it
// off, =observe keeps the histogram without pacing.
test("presentpace: URL → host → adapter → worker → the presenter, game by default, off and observe by the URL", async (t) => {
  const { requestedPacing } = await import("../src/core-host.js");
  for (const q of ["", "?presentpace=game", "?presentpace=GAME", "?presentpace=1", "?presentpace=bogus"]) {
    assert.deepEqual([requestedPacing(q).presentGamePace, requestedPacing(q).presentPaceStats], [true, true], `game: ${q || "no option"}`);
  }
  for (const q of ["?presentpace=off", "?presentpace=OFF", "?presentpace=0", "?presentpace=false", "?presentpace=no"]) {
    assert.deepEqual([requestedPacing(q).presentGamePace, requestedPacing(q).presentPaceStats], [false, false], `off: ${q}`);
  }
  // observe: the histogram and the period kept, no pacing
  assert.deepEqual([requestedPacing("?presentpace=observe").presentGamePace, requestedPacing("?presentpace=observe").presentPaceStats], [false, true]);
  assert.equal(requestedPacing("?presentpace=game").presentVsync, true, "only its own switch");
  const { UpstreamWorkerAdapter } = await import("../src/upstream-worker-adapter.js");
  // the adapter and the worker take what the host passes (nothing: off)
  assert.equal(new UpstreamWorkerAdapter({}).presentGamePace, false);
  const adapter = new UpstreamWorkerAdapter(requestedPacing("?presentpace=game"));
  let posted = null;
  adapter.worker = {
    postMessage(message) {
      posted = message;
      queueMicrotask(() => adapter.handleMessage({ id: message.id, ok: true }));
    }
  };
  const originalWindow = globalThis.window;
  globalThis.window = { location: { href: "http://127.0.0.1:8080/?presentpace=game", search: "?presentpace=game" } };
  t.after(() => {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  });
  await adapter.load();
  assert.equal(posted.payload.presentGamePace, true, "presentGamePace in the init payload");
  const host = await readFile(new URL("../src/core-host.js", import.meta.url), "utf8");
  const worker = await readFile(new URL("../src/upstream-discio-worker.js", import.meta.url), "utf8");
  assert.match(host, /\n {12}presentGamePace: this\.pacing\.presentGamePace,\n/);
  assert.match(worker, /\n {8}presentGamePace: payload\.presentGamePace,\n/);
  assert.match(worker, /\n  presentGamePace = false,\n/);
  assert.match(worker, /\n  wgpuPresentGamePace = presentGamePace === true;\n  wgpuPresentPaceStats = presentPaceStats === true \|\| wgpuPresentGamePace;\n/);
  assert.match(worker, /\n {8}presentPaceStats: payload\.presentPaceStats,\n/);
  assert.match(host, /\n {12}presentPaceStats: this\.pacing\.presentPaceStats,\n/);
  // every queued frame stamped (the HUD reads the same with the switch off);
  // the pace only at a BeginFrame, with the switch on
  // with ?presentpace=off no extra work: stamping, the refresh period and
  // the histogram only with game (the default), observe or the harness
  assert.match(worker, /const wgpuVsyncTracking = \(\) => wgpuPresentPaceStats \|\| harnessEnabled;/);
  assert.match(worker, /\n  if \(wgpuVsyncTracking\(\)\) wgpuGamePacer\.stamp\(at\);\n/);
  assert.match(worker, /const refreshMs = tracking \? wgpuVsyncRefreshMs\(\) : null;/);
  assert.match(worker, /if \(tracking\) \{\n\s+const gameMs = wgpuGamePacer\.period;\n\s+const shownCount = afterGap \? Math\.min\(1, wgpuVsyncShownSinceTick\) : wgpuVsyncShownSinceTick;\n\s+wgpuRefreshHistogram\.tick\(shownCount \? \(refreshMs && gameMs \? gameMs \/ refreshMs : 1\) : null, now, shownCount\);/,
    "back from a gap (a hidden tab), the frames the fallback timer put up are not counted unseen");
  // the afterGap the histogram reads is the tick's own, set before it
  const tickBody = worker.slice(worker.indexOf("const tick = (frameTime) => {"), worker.indexOf("self.requestAnimationFrame(tick);"));
  assert.ok(tickBody.indexOf("const afterGap = ") >= 0 && tickBody.indexOf("const afterGap = ") < tickBody.indexOf("const shownCount = "));
  assert.match(worker, /return refreshOf\(Array\.from\(wgpuVsyncFrameGaps\.subarray\(0, n\)\)\);/, "the refresh period near the shortest gap, not the shortest");
  assert.match(worker, /\(wgpuPresentVsync && wgpuVsyncTracking\(\) \? refreshHelperField\(\) : ""\)/);
  assert.equal((worker.match(/wgpuGamePacer\.stamp\(|wgpuRefreshHistogram\.tick\(/g) ?? []).length, 2, "one stamp, one histogram tick, both gated");
  assert.match(worker, /const pace = wgpuPresentGamePace && t !== null && !newest \? \(frame\) => wgpuGamePacer\.due\(frame, t, refreshMs\) : null;/);
  assert.match(worker, /wgpuVsync\.takeForDisplay\(wgpuVsyncTick, pace\)/);
  assert.match(worker, /if \(pace\) wgpuGamePacer\.shown\(f, t, refreshMs\);/);
  assert.match(worker, / refresh:\$\{h\.counts\.join\("\/"\)\}/, "the HUD's refresh field (the last 10 s)");
});

test("presentvsync: the backbuffer pass renders into a pooled texture, shown at the worker's rAF, the drain never held", async () => {
  const worker = await readFile(new URL("../src/upstream-discio-worker.js", import.meta.url), "utf8");
  // fb#0's BEGIN_PASS: the pool's texture in place of the canvas's
  assert.match(worker, /const cur = wgpuPresentVsync\n\s+\? acquireWgpuVsyncTexture\(\.\.\.wgpuBackbufferSize\(\)\)\n\s+: renderGpu\.context\.getCurrentTexture\(\);/);
  // the present queues the frame; the present count follows the display
  // the frame's texture is kept across drains (wgpu-vsync-queue.js): the present
  // queues it whatever this drain saw, never a drain-local texture
  assert.match(worker, /if \(wgpuPresentVsync\) \{\n(?:\s+\/\/[^\n]*\n)+\s+queueWgpuVsyncFrame\(api\?\.getFrame/);
  assert.doesNotMatch(worker, /queueWgpuVsyncFrame\(lastBackbufferTexture/);
  const present = worker.slice(worker.indexOf("function presentWgpuVsyncFrame("), worker.indexOf("function wgpuCanvasUsage("));
  assert.match(present, /const f = newest \? wgpuVsync\.takeNewest\(\{ hidden \}\) : wgpuVsync\.takeForDisplay\(wgpuVsyncTick, pace\);/, "the oldest queued frame, after the catch-up (or the game pace)");
  assert.match(present, /copyTextureToTexture\(/);
  // v3: the stream no longer follows the display: nothing captured at the rAF
  assert.doesNotMatch(present, /streamCapture\.offerCanvas\(/);
  assert.match(present, /recordPresentedFrame\(f\.coreFrame, f\.shownVi\)/);
  // at the worker's rAF, a timer when no BeginFrame comes; the canvas can be copied to
  assert.match(worker, /self\.requestAnimationFrame\(tick\)/);
  assert.match(worker, /setTimeout\(wgpuVsyncFallbackCheck, WGPU_VSYNC_FALLBACK_MS\)/);
  assert.equal((worker.match(/wgpuPresentVsync \? (textureUsage|self\.GPUTextureUsage)\.COPY_DST : 0/g) ?? []).length, 3, "every configure keeps COPY_DST");
  // v1 held the drain and the core skipped frames: never again
  assert.doesNotMatch(worker, /"display-tick"/);
});

test("presentvsync catch-up: a frame that already waited a BeginFrame gives way to a newer one, counted", async () => {
  const worker = await readFile(new URL("../src/upstream-discio-worker.js", import.meta.url), "utf8");
  const present = worker.slice(worker.indexOf("function presentWgpuVsyncFrame("), worker.indexOf("function wgpuCanvasUsage("));
  // the behaviour is tested on the module (tests/wgpu-vsync-queue.test.mjs)
  assert.match(present, /wgpuVsync\.takeForDisplay\(wgpuVsyncTick, pace\)/);
  // (the frame carries its 0208 tag too: tests/wgpu-new-frames.test.mjs)
  assert.match(worker, /wgpuVsync\.queueFrame\(\{ coreFrame, shownVi, stream, tick: wgpuVsyncTick, at, tag, tagEpoch \}, \{ hidden \}\)/);
  assert.match(worker, /case "validationReadPresentVsync":/);
});

// A present submitted from the presenter's own rAF callback goes out with
// that BeginFrame: the harness display counter counts it there, not at the
// next one (else ?presentvsync=1 measured a vsync later than it shows).
test("display counter: a submit made inside the current BeginFrame is counted in it", async () => {
  const { createDisplayCounter } = await import("../src/wgpu-display-counter.js");
  const c = createDisplayCounter({ capacity: 8 });
  c.beginFrame(100);
  c.submit(7, 100);
  c.beginFrame(116);
  c.submit(8);
  c.beginFrame(133);
  const { displayed } = c.drain();
  assert.deepEqual(displayed.submits, [1, 0, 1]);
  assert.deepEqual(displayed.vi, [7, -1, 8]);
});

// The presenter's rAF and the counter's run in a fixed but arbitrary order
// in each frame: either order counts one picture per BeginFrame, no drop.
// (The presenter first used to land on the previous frame's entry: a false
// drop every frame, in the runs where its loop had started first.)
test("display counter: one present per BeginFrame is one picture, whichever rAF runs first", async () => {
  const { createDisplayCounter } = await import("../src/wgpu-display-counter.js");
  for (const presenterFirst of [false, true]) {
    const c = createDisplayCounter({ capacity: 16 });
    for (const [i, ft] of [100, 116.7, 133.3, 150].entries()) {
      if (presenterFirst) { c.submit(i, ft); c.beginFrame(ft); }
      else { c.beginFrame(ft); c.submit(i, ft); }
    }
    const { displayed, dropped } = c.drain();
    assert.deepEqual(displayed.submits, [1, 1, 1, 1], `presenter first: ${presenterFirst}`);
    assert.deepEqual(displayed.vi, [0, 1, 2, 3]);
    assert.equal(dropped, 0);
  }
  const worker = await readFile(new URL("../src/upstream-discio-worker.js", import.meta.url), "utf8");
  assert.match(worker, /wgpuVsyncFrameTime = performance\.timeOrigin \+ frameTime;/, "the same clock as the counter's beginFrame");
});

// presentvsync v3: the stream captures every frame when it is queued, from
// its pooled texture copied to a canvas of its own, so it is free of the local
// display's BeginFrames, catch-up drops and timer fallback.
test("presentvsync v3: the stream captures at queue time, from the frame's texture", async () => {
  const worker = await readFile(new URL("../src/upstream-discio-worker.js", import.meta.url), "utf8");
  const queue = worker.slice(worker.indexOf("function queueWgpuVsyncFrame("), worker.indexOf("function wgpuVsyncFallbackCheck("));
  assert.match(queue, /if \(!frame\) return false;\n {2}if \(stream && streamCapture\.active\) streamWgpuVsyncFrame\(frame\.tex, coreFrame\);/, "a present without a pass streams nothing");
  const stream = worker.slice(worker.indexOf("function streamWgpuVsyncFrame("), worker.indexOf("// The texture the backbuffer pass renders into"));
  assert.match(stream, /if \(!streamCapture\.ready\(\)\) return;/, "nobody reading: no copy");
  assert.match(stream, /copyTextureToTexture\(\{ texture: tex \}, \{ texture: wgpuVsyncStreamContext\.getCurrentTexture\(\) \}/);
  assert.match(stream, /dev\.queue\.submit\(\[enc\.finish\(\)\]\);\n {2}streamCapture\.offerCanvas\(wgpuVsyncStreamCanvas, coreFrame\);/, "copy submitted before the snapshot");
  assert.match(worker, /const wgpuPresentVsyncStats = \{ byTimer: 0, byLate: 0, byNoBeginFrame: 0, streamed: 0 \};/);
  // the readback keeps the `queued` counter: the queue's length is `waiting`
  const read = worker.slice(worker.indexOf('case "validationReadPresentVsync":'), worker.indexOf('case "validationReadEfbSyncStats":'));
  assert.match(read, /\.\.\.wgpuVsync\.stats,\n[^\n]*\n {8}waiting: wgpuVsync\.waiting,/);
  assert.doesNotMatch(read, /queued: /);
});

// Review of #265: the presenter's rAF loop stops after WGPU_VSYNC_IDLE_TICKS
// empty BeginFrames and the next queued frame starts it again; a lost device
// empties the queue (no 50 ms timer for ever); the canvases follow the device.
test("presentvsync: idle loop stops, device loss empties the queue, canvases keyed by device", async () => {
  const worker = await readFile(new URL("../src/upstream-discio-worker.js", import.meta.url), "utf8");
  assert.match(worker, /if \(wgpuVsyncIdleTicks >= WGPU_VSYNC_IDLE_TICKS && !wgpuVsync\.waiting\) \{\n\s+wgpuVsyncLoop = false;/);
  assert.match(worker, /wgpuVsyncIdleTicks = 0;\n {2}if \(!wgpuVsyncLoop\) \{/, "a queued frame restarts it");
  assert.match(worker, /if \(!renderGpu\) \{\n {4}wgpuVsync\.clear\(\);\n {4}return;\n {2}\}/);
  assert.match(worker, /if \(wgpuVsyncCanvasDevice !== dev\) \{/);
  assert.match(worker, /wgpuVsyncStreamDevice !== dev \|\|/);
  assert.match(worker, /destroyTexture: \(tex\) => tex\.destroy\(\)/);
});

// Review of #263 (item 5): in vsync mode the frame's texture is kept across
// drains, so the input marker, the cadence sample and the backbuffer
// readbacks read the frame's texture, never the drain-local one (null when
// the frame's pass ran in an earlier drain).
test("presentvsync: the input marker, cadence sample and readbacks read the frame's texture", async () => {
  const worker = await readFile(new URL("../src/upstream-discio-worker.js", import.meta.url), "utf8");
  assert.match(worker, /const presentTexture = wgpuPresentVsync \? wgpuVsync\.current : lastBackbufferTexture;/);
  const at = worker.indexOf("const presentTexture = ");
  const present = worker.slice(at, worker.indexOf("          if (wgpuPresentVsync) {", at));
  assert.doesNotMatch(present.slice(80), /lastBackbufferTexture/, "no drain-local texture between the frame's present and its queue");
  assert.match(present, /encodeHardwareInputMarker\(\n\s+ensureEnc\(\),\n\s+presentTexture,/);
  assert.match(present, /encodeWgpuVisualCadence\(ensureEnc\(\), presentTexture\)/);
});

// Review of #265 (drop-meter, boot): a frame queued while the presenter's rAF
// is late (a busy worker cannot run it) is shown at once, counted byLate.
test("presentvsync: a frame queued while the rAF is late is shown at once", async () => {
  const worker = await readFile(new URL("../src/upstream-discio-worker.js", import.meta.url), "utf8");
  // late: 1.5 x the frame period, the smallest rAF frame-time delta
  // (vsyncLateMs, tested in wgpu-vsync-queue.test.mjs), floor 12 ms
  assert.match(worker, /return vsyncLateMs\(Array\.from\(wgpuVsyncFrameGaps\.subarray\(0, n\)\), \{ floor: WGPU_VSYNC_LATE_FLOOR_MS \}\);/);
  assert.match(worker, /wgpuVsyncFrameGaps\[wgpuVsyncFrameGapCount\+\+ % wgpuVsyncFrameGaps\.length\] = frameTime - wgpuVsyncLastFrameTime;/);
  // back after a gap of 50 ms or more: the newest frame first
  assert.match(worker, /const afterGap = now - wgpuVsyncLastTickAt >= WGPU_VSYNC_FALLBACK_MS;/);
  assert.match(worker, /shown = presentWgpuVsyncFrame\(\{ newest: afterGap, t: frameTime, refreshMs \}\);/);
  assert.match(worker, /\} else if \(sinceTick > wgpuVsyncLateMs\(\)\) \{\n(?: {6}\/\/[^\n]*\n)+ {6}wgpuPresentVsyncStats\.byLate \+= 1;\n {6}presentWgpuVsyncFrame\(\{ newest: true \}\);/);
  // no BeginFrame for 50 ms (hidden tab): no local copy, the timer shows the newest
  assert.match(worker, /if \(sinceTick >= WGPU_VSYNC_FALLBACK_MS\) \{\n(?: {6}\/\/[^\n]*\n)+ {6}wgpuPresentVsyncStats\.byNoBeginFrame \+= 1;\n {4}\}/);
  assert.match(worker, /wgpuPresentVsyncStats\.byTimer \+= 1;\n {4}\/\/[^\n]*\n {4}presentWgpuVsyncFrame\(\{ newest: true, hidden: true \}\);/, "the timer's catch-up is not a drop");
  assert.match(worker, /const wgpuPresentVsyncStats = \{ byTimer: 0, byLate: 0, byNoBeginFrame: 0, streamed: 0 \};/);
});
