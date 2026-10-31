// Playwright validator that boots the reference game through the GameCube intro, save
// dialog, attract cutscene, title, main menu, and into character select.
// Captures screenshots at every input event, every 4s, plus a per-second HUD
// + canvas-hash log so we can tell which menu screens were reached.
//
//   node tools/menu-progress-validate.mjs --duration 360
//
// Env: ROM (default smash melee path), BASE_URL, OGL_PROXY_MODE, HEADED=1.

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createWriteStream, existsSync } from "node:fs";
import { reapStaleBrowsers } from "./reap-stale-browsers.mjs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

import {
  collectRunMetadata,
  parseProfileMetrics,
  recordsToCsv,
  resolveCoreArtifactPath,
} from "./perf-artifacts.mjs";
import { buildVisibleHarnessUrl } from "./benchmark-url.mjs";

const root = process.cwd();
const args = parseArgs(process.argv.slice(2));
const baseUrl = args.baseUrl || process.env.BASE_URL || "http://127.0.0.1:8082/";
const romPath = args.rom || process.env.ROM || "";
const durationSeconds = args.duration ?? Number(process.env.DURATION || 360);
const sampleMs = args.sampleMs ?? Number(process.env.SAMPLE_MS || 1000);
const screenshotEverySeconds = args.shotEvery ?? Number(process.env.SHOT_EVERY || 4);
const captureScreenshots = process.env.CAPTURE_SCREENSHOTS !== "0";
const showDebugPanel = process.env.SHOW_DEBUG_PANEL === "1";
const audioMode = String(process.env.AUDIO_MODE || "audible").trim().toLowerCase();
if (!["audible", "muted"].includes(audioMode)) {
  throw new Error(`Invalid AUDIO_MODE=${process.env.AUDIO_MODE}; expected audible or muted`);
}
const inputMarkerCanvasObservationEnabled =
  process.env.INPUTLATENCY === "1" && process.env.INPUTMARKEROBSERVE !== "0";
const inputPhotonEnabled = process.env.INPUTPHOTON === "1";
const oglProxy = process.env.OGL_PROXY_MODE || "proxy";
const videoMode = process.env.VIDEO || "ogl"; // "ogl" or "software"
const headed = process.env.HEADED === "1" || args.headed;
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = args.outDir
  ? path.resolve(args.outDir)
  : path.join(root, ".omx", "menu-progress", stamp);

if (!existsSync(romPath)) throw new Error(`Missing disc image: ${romPath}`);

// Default input script for the reference game. Each X press = GC A, Enter = Start, WASD = stick.
// Tuned for proxy mode (~38% game speed): real-time elapsed must be ~2.6x of
// what the in-game animation length would be at 100%.
//
// Stage timeline (real seconds, proxy speed):
//   t=10–14: "Press Start" save dialog  → Enter
//   t=20–25: GameCube boot beep advance → A spam
//   t=30–80: attract cutscene             → A spam to skip
//   t=90–110: title "Press Start"         → Enter
//   t=120–150: Main menu (top option = 1P)→ A
//   t=160–195: 1P modes (Regular Match)   → A
//   t=205–240: Stage / character select   → A again to push through
// Aggressive input script: press A (X) AND Start (Enter) repeatedly with
// short intervals so attract-mode skips and dialogs auto-advance. With JIT
// off the emulator runs ~190% speed in headless Chrome, so what reads as
// real-second N here is roughly emulator-second N*2. Press both keys often
// enough that whichever screen the game is on gets unstuck.
function makeAggressiveInputScript() {
  const events = [];
  let index = 0;
  // Phase 1 (t=3..200s): A + Start spam to advance through dialogs, attract
  //   cutscene skip, title, main menu. Reaches character select around t~200.
  // Phase 2 (t=200..400s): A + Start spam + occasional D-Right + Z. D-Right
  //   moves the character-select cursor; Z confirms/cancels. Once a char is
  //   picked, A starts the match. Reaches stage select.
  // Phase 3 (t=400..600s): A spam only — the validator is now in-game or
  //   on the results screen; we just want to keep something happening.
  for (let t = 3; t <= 600; t += 3) {
    const key = (index % 2 === 0) ? "x" : "Enter";
    events.push(`down:${t}:${key}`);
    events.push(`down:${t + 1}:${key}`);
    events.push(`up:${t + 1.5}:${key}`);
    // Phase 2: every 4th iteration, also tap a directional key + Z so the
    // character-select cursor moves and any "ready"/"back" prompt can be
    // dismissed in case A alone isn't enough.
    if (t >= 200 && t < 400 && index % 4 === 0) {
      events.push(`down:${t + 0.5}:ArrowRight`);
      events.push(`up:${t + 0.7}:ArrowRight`);
      events.push(`down:${t + 2}:z`);
      events.push(`up:${t + 2.2}:z`);
    }
    index += 1;
  }
  return events.join(",");
}
const defaultInputScript = makeAggressiveInputScript();

// INPUT_SCRIPT=none (or an explicitly empty value in shells that preserve it)
// means "send no gameplay input". This is important for fixed-state benchmarks,
// where the scene must not drift because menu navigation kept pressing buttons
// after the state loaded.
const rawInputScript = process.env.INPUT_SCRIPT;
const configuredInputScript =
  rawInputScript == null
    ? defaultInputScript
    : /^(?:none|off)$/i.test(rawInputScript.trim())
      ? ""
      : rawInputScript;
const inputScript = parseInputScript(configuredInputScript);
// Optional: load a Dolphin .sav (served by the dev server) once the
// core is running. SAVE_STATE_URL = path under the dev server (e.g.
// /__savestate_probe.sav); SAVE_STATE_AT = seconds into the run to do
// it (must be after boot — Core must be running for State::LoadAs).
const saveStateUrl = process.env.SAVE_STATE_URL || "";
// Optional local counterpart used only for provenance. SAVE_STATE_URL is what
// the browser loads; SAVE_STATE_PATH lets the harness record the exact bytes
// without assuming how the development server maps URLs to disk.
const saveStatePath = process.env.SAVE_STATE_PATH || "";
const saveStateAt = Number(process.env.SAVE_STATE_AT || 30);
const sceneLabel = process.env.SCENE_LABEL || "";
let saveStateDone = false;
let saveStateLoadResult = null;
// Capture a version-matched state at SAVE_STATE_CAPTURE_AT (write the
// .sav into outDir for reuse), then reload it from the worker FS at
// SAVE_STATE_RELOAD_AT to prove a deterministic round-trip.
const ssCaptureAt = Number(process.env.SAVE_STATE_CAPTURE_AT || 0);
const ssReloadAt = Number(process.env.SAVE_STATE_RELOAD_AT || 0);
let ssCaptureDone = false;
let ssReloadDone = false;

const { chromium, firefox } = await importPlaywright();
const browserName = (process.env.BROWSER || "chromium").toLowerCase();
const browserEngine = browserName === "firefox" ? firefox : chromium;
await mkdir(outDir, { recursive: true });
console.log(`[menu-progress] outDir=${outDir} duration=${durationSeconds}s headed=${headed}`);

const { url, removedProbe: removedInheritedWgpuProbe } = buildVisibleHarnessUrl(baseUrl);
if (removedInheritedWgpuProbe) {
  console.warn(
    `[menu-progress] removed inherited wgpurenderprobe=${removedInheritedWgpuProbe}; ` +
    "playthrough runs require visible output"
  );
}
url.searchParams.set("core", "upstream");
if (process.env.CORE_ID) url.searchParams.set("coreid", process.env.CORE_ID);
url.searchParams.set("video", videoMode);
url.searchParams.set("cpu", process.env.CPU || "dual");
// §28cx: honor a SPEED override so throughput A/Bs can run unthrottled
// (?speed=unlimited) — at speed=1 a faster JIT just idles in throttle and
// the gameSpeed% pins at 100%, hiding headroom. Unthrottled, gameSpeed% IS
// the raw throughput. Defaults to "1" (every existing caller unchanged).
url.searchParams.set("speed", process.env.SPEED || "1");
url.searchParams.set("presenter", process.env.PRESENTER || (videoMode === "software" ? "webgpu" : "webgl"));
url.searchParams.set("pacing", process.env.PACING || "smooth");
// Use the safer guarded JIT for both backends. The "mixed" tier compiles
// more aggressive patterns that proved fine for boot dialogs but appear to
// corrupt some post-boot CPU code paths under the browser pthread layout
// (cutscene scene rendering went all-black with mixed but boot dialogs
// renderered fine).
url.searchParams.set("jittier", process.env.JITTIER || "guarded");
if (videoMode === "ogl") {
  url.searchParams.set("present", process.env.PRESENT || "half");
  url.searchParams.set("oglproxy", oglProxy);
  // forcejit only when explicitly requested; defaults to no-JIT for OGL
  // since we're trying to isolate whether JIT corruption was hiding the
  // post-boot 3D-rendering black output.
  if (process.env.FORCEJIT === "1") url.searchParams.set("forcejit", "1");
  url.searchParams.set("queue", "8");
} else {
  url.searchParams.set("present", process.env.PRESENT || "full");
  url.searchParams.set("wasmjit", process.env.WASMJIT ?? "1");
  url.searchParams.set("queue", process.env.QUEUE_SIZE || "4");
  url.searchParams.set("jitwarmup", process.env.JITWARMUP || "60");
  // forcejit keeps the JIT engaged through the post-activation stall
  // fuse — required to actually exercise the mixed tier (its larger
  // one-time compile burst otherwise trips the guarded-tuned fuse).
  if (process.env.FORCEJIT === "1") url.searchParams.set("forcejit", "1");
}
url.searchParams.set("oc", process.env.OC || "1");
url.searchParams.set("fastsw", process.env.FASTSW || "1");
if (process.env.XFBFAST) url.searchParams.set("xfbfast", process.env.XFBFAST);
if (process.env.DISABLE) url.searchParams.set("disable", process.env.DISABLE);
// WGPUCLEARRECT=0 turns the scissored EFB clear off. It is on by default in the
// backend, so this is a bisection knob: with it off the renderer falls back to
// whole-attachment loadOp clears and a Wii racing game composites a patchwork.
if (process.env.WGPUCLEARRECT)
  url.searchParams.set("wgpuclearrect", process.env.WGPUCLEARRECT);
if (process.env.REDISPATCH) url.searchParams.set("redispatch", process.env.REDISPATCH);
if (process.env.BLOCKMERGE) url.searchParams.set("blockmerge", process.env.BLOCKMERGE);
if (process.env.REGALLOC) url.searchParams.set("regalloc", process.env.REGALLOC);
if (process.env.SHORTPREFIX) url.searchParams.set("shortprefix", process.env.SHORTPREFIX);
if (process.env.SMEARCOMPILE) url.searchParams.set("smearcompile", process.env.SMEARCOMPILE);
if (process.env.FASTMEMHOIST) url.searchParams.set("fastmemhoist", process.env.FASTMEMHOIST);
if (process.env.OGLSAB) url.searchParams.set("oglsab", process.env.OGLSAB);
if (process.env.GPUCOMPLETE) url.searchParams.set("gpucomplete", process.env.GPUCOMPLETE);
if (process.env.INPUTLATENCY) url.searchParams.set("inputlatency", process.env.INPUTLATENCY);
if (process.env.INPUTREADBACK) url.searchParams.set("inputreadback", process.env.INPUTREADBACK);
for (const [environmentName, queryName] of [
  ["INPUTPHOTON", "inputphoton"],
  ["INPUTPHOTONSIZE", "inputphotonsize"],
  ["INPUTPHOTONX", "inputphotonx"],
  ["INPUTPHOTONY", "inputphotony"],
]) {
  if (process.env[environmentName] != null) {
    url.searchParams.set(queryName, process.env[environmentName]);
  }
}
for (const [environmentName, queryName] of [
  ["WGPUCLASSIFY", "wgpuclassify"],
  ["WGPUPUMP", "wgpupump"],
  ["WGPUSTATECACHE", "wgpustatecache"],
  ["WGPUUBOCACHE", "wgpuubocache"],
  ["WGPUUBOPACK", "wgpuubopack"],
  ["WGPUUBOSPARSE", "wgpuubosparse"],
  ["WGPUUBOMETRICS", "wgpuubometrics"],
  ["WGPUVPDIAG", "wgpuvpdiag"],
  ["WGPUUNIFORMFAST", "wgpuuniformfast"],
  ["WGPUPACKAGEPROJECTION", "wgpupackageprojection"],
  ["WGPUUPLOADRUNPROJECTION", "wgpuuploadrunprojection"],
  ["WGPUUBOCOMPUTEPROJECTION", "wgpuubocomputeprojection"],
  ["WGPUUBOCOMPUTE", "wgpuubocompute"],
  ["WGPUOWNERSHIPTRACE", "wgpuownershiptrace"],
  ["WGPUSEMANTIC", "wgpusemantic"],
  ["WGPUGEOMPACK", "wgpugeompack"],
  ["WGPUGEOMRANGE", "wgpugeomrange"],
  ["WGPUDETACHED", "wgpudetached"],
  ["WGPULOADFENCE", "wgpuloadfence"],
  ["WGPUDEEPDIAG", "wgpudeepdiag"],
  // Native producer/draw phase timers. Accumulated counters read once at the
  // end of a run, but they are still off by default -- a profiling capture is
  // a separate run from a throughput measurement, never the same one.
  ["WGPUPRODPROFILE", "wgpuprodprofile"],
  ["WGPUDRAWPROFILE", "wgpudrawprofile"],
  ["CORELOG", "corelog"],
  ["EFBDIAG", "efbdiag"],
  ["FRAMECAP", "framecap"],
  ["WGPUATOMIC", "wgpuatomic"],
  ["WGPUUPLOADMB", "wgpuuploadmb"],
  ["WGPUSTAGINGSLOTS", "wgpustagingslots"],
  ["WGPUSTAGINGSLOTMIB", "wgpustagingslotmib"],
  ["WGPUSTAGEFAST", "wgpustagefast"],
  // Sparse UBO copy-forward uploads only the dirty 16-byte ranges of a
  // constant block instead of the whole block. It needs the mapped upload
  // transport, so the two travel together.
  ["WGPUUBOSPARSE", "wgpuubosparse"],
  ["WGPUUPLOADTRANSPORT", "wgpuuploadtransport"],
  ["WGPUMAPPEDTIMING", "wgpumappedtiming"],
  ["WGPUDRAINCOALESCE", "wgpudraincoalesce"],
  ["WGPUREPLAYMS", "wgpureplayms"],
  ["WGPUPOWER", "wgpupower"],
  ["SWTEVFAST", "swtevfast"],
  ["SWTEVSHADOW", "swtevshadow"],
]) {
  if (process.env[environmentName] != null) {
    url.searchParams.set(queryName, process.env[environmentName]);
  }
}
// §28cx in-page main-thread profiler passthrough (?mainprof=1). Headless can
// only validate the tooling emits — real-Chrome contention is the authoritative
// signal — but it confirms activation and dumps the audio-pump cadence +
// LoAF script-attribution snapshot at end of run (mainprofile.json).
if (process.env.MAINPROF) url.searchParams.set("mainprof", process.env.MAINPROF);
if (process.env.PPCPROF) url.searchParams.set("ppcprof", process.env.PPCPROF);
url.searchParams.set("metrics", process.env.METRICS ?? "1");
url.searchParams.set("probe", `menu-progress-${Date.now()}`);

const consoleLines = [];
const samples = [];
const milestoneLog = [];
const distinctHashes = new Map(); // hash → { firstAt, screenshot }

// Optional persistent user-data-dir, so IndexedDB (e.g. Day-7 JIT cache)
// and other origin-scoped storage survive across probe runs.
const persistUserDataDir = process.env.PROBE_PERSIST_DIR || null;
const persistBrowserData = persistUserDataDir
  ? path.resolve(persistUserDataDir)
  : null;

// BROWSER_ARGS appends space-separated Chromium flags. Needed to reach the GPU
// at all on some hosts: on a headless Linux box with an NVIDIA card,
// requestAdapter() returns null until --use-angle=vulkan is passed, and then
// reports vendor "nvidia" / architecture "ampere". Without this the run still
// completes and still reports numbers -- they are just software-rendered ones.
const extraBrowserArgs = String(process.env.BROWSER_ARGS || "")
  .split(/\s+/)
  .filter(Boolean);
const chromiumLaunchArgs = [
  "--autoplay-policy=no-user-gesture-required",
  "--enable-webgl",
  "--enable-unsafe-webgpu",
  "--enable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling",
  ...extraBrowserArgs
];

reapStaleBrowsers();
const browser = persistBrowserData
  ? await chromium.launchPersistentContext(persistBrowserData, {
      channel: process.env.BROWSER_CHANNEL || "chrome",
      headless: !headed,
      args: chromiumLaunchArgs
    }).catch(async (error) => {
      console.warn(`Failed persistent context; falling back to bundled chromium: ${error.message}`);
      return chromium.launchPersistentContext(persistBrowserData, { headless: !headed });
    })
  : await (browserName === "firefox"
      ? firefox.launch({
          headless: !headed,
          firefoxUserPrefs: {
            // Mirror what serve.mjs gives us — Firefox needs explicit COOP/COEP
            // and SharedArrayBuffer enabled for the pthread WASM core.
            "dom.postMessage.sharedArrayBuffer.withCOOP_COEP": true,
            "javascript.options.shared_memory": true,
            // Enable WebGL2 (default on, but explicit so we don't fight the user).
            "webgl.force-enabled": true
          }
        })
      : chromium.launch({
          channel: process.env.BROWSER_CHANNEL || "chrome",
          headless: !headed,
          args: chromiumLaunchArgs
        })).catch(async (error) => {
      console.warn(`Failed ${browserName} channel; falling back to bundled chromium: ${error.message}`);
      return chromium.launch({ headless: !headed });
    });

const browserVersion =
  (typeof browser.version === "function" ? browser.version() : browser.browser?.()?.version?.()) || null;
const browserExecutable =
  typeof browserEngine.executablePath === "function" ? browserEngine.executablePath() : null;
const runMetadata = await collectRunMetadata({
  root,
  url: url.href,
  browserName,
  browserChannel: process.env.BROWSER_CHANNEL || (browserName === "chromium" ? "chrome" : null),
  browserVersion,
  browserExecutable,
  headed,
  durationSeconds,
  sampleMs,
  screenshotEverySeconds,
  captureScreenshots,
  showDebugPanel,
  romPath,
  hashRom: process.env.HASH_ROM !== "0",
  corePath: resolveCoreArtifactPath(root, url.href),
  saveStateUrl,
  saveStatePath,
  saveStateAt,
  inputScript: configuredInputScript,
  sceneLabel,
});
runMetadata.benchmark.audioMode = audioMode;
await writeFile(path.join(outDir, "run-metadata.json"), JSON.stringify(runMetadata, null, 2));

// launchPersistentContext returns a BrowserContext (not Browser). Both
// expose .newPage()/.on() with the same signatures we need below, so we
// can treat them uniformly. Same applies to teardown via .close().
const page = persistBrowserData
  ? await browser.newPage()
  : await browser.newPage({ viewport: { width: 1280, height: 900 } });
if (persistBrowserData) {
  await page.setViewportSize({ width: 1280, height: 900 });
}
page.on("console", (m) => consoleLines.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => consoleLines.push(`[pageerror] ${e.stack || e.message}`));
// Worker console capture. The Dolphin upstream core runs in a Web Worker; its
// console.log (including the C++ per-frame ring-buffer drain and disable-mask
// status messages) is not surfaced by page.on("console"). Listen at the
// browser-context level so each spawned worker is wired up automatically.
const seenWorkers = new WeakSet();
function attachWorker(worker) {
  if (seenWorkers.has(worker)) return;
  seenWorkers.add(worker);
  const label = `worker:${worker.url()?.split("/").pop() || "?"}`;
  worker.on("console", (m) => consoleLines.push(`[${label}:${m.type()}] ${m.text()}`));
  worker.on("pageerror", (e) =>
    consoleLines.push(`[${label}:pageerror] ${e.stack || e.message}`));
}
const browserContext = page.context();
for (const w of browserContext.serviceWorkers?.() ?? []) attachWorker(w);
browserContext.on("serviceworker", attachWorker);
page.on("worker", attachWorker);
for (const w of page.workers?.() ?? []) attachWorker(w);

// Chrome DevTools Protocol tracing. JS-level stall loggers showed
// blockingDuration:0 on most long-anim-frame entries — the bottleneck
// is browser-internal (GPU process, compositor, viz). CDP tracing
// captures those layers. Trace output is openable in Chrome's
// DevTools Performance panel or chrome://tracing.
//
// Categories chosen for OGL paint-stall hunting:
//   gpu                                      — GPU process commands & sync
//   cc                                       — compositor frame scheduling
//   viz                                      — display compositor
//   blink.user_timing                        — our performance.mark spots
//   devtools.timeline / devtools.timeline.frame — render scheduling
//   v8.execute                               — V8 work attribution
//   disabled-by-default-* are heavyweight but necessary for GPU detail
//
// Opt-in via PROBE_TRACE=1 to keep default runs cheap (trace files are
// large — ~50 MB for a 90s run).
let cdpSession = null;
const traceEnabled = process.env.PROBE_TRACE === "1";
if (traceEnabled) {
  try {
    cdpSession = await page.context().newCDPSession(page);
  } catch (err) {
    console.warn(`[menu-progress] CDP session failed: ${err.message}`);
    cdpSession = null;
  }
}

const scriptState = inputScript.map((event) => ({ ...event, sent: false }));

// Long-animation-frame entries (Chrome 123+) tell us when the main
// thread blocked the next paint by >50 ms. Each entry has startTime,
// duration, blockingDuration, renderStart, paintTime, presentationTime.
// We push them through page.exposeFunction so we can persist them with
// the rest of the run artifacts. Empty array if the browser doesn't
// support PerformanceLongAnimationFrameTiming.
const longAnimationFrames = [];
await page.exposeFunction("__menuProgressReportLoAF", (entry) => {
  longAnimationFrames.push(entry);
});

// Audio capture (Phase C). The page's AudioController exposes itself as
// window.__audio. The validator unmutes it after mount, attaches an
// AnalyserNode to the gain output, and periodically samples the audio
// envelope (peak amplitude + RMS) so we can assert "audio is producing
// non-silent output during gameplay scenes".
const audioSamples = []; // { tSec, peak, rms }
await page.exposeFunction("__menuProgressReportAudio", (sample) => {
  audioSamples.push(sample);
});

// Input-latency probe (Phase C). PerformanceEventTiming reports each
// input event with both arrival time and handler-processing time. With
// a low durationThreshold the observer surfaces every keypress the
// validator dispatches, letting us compute p50/p95/max input-to-handler
// latency. True input-to-paint latency would need GPU scanout timing
// (out of scope); processingStart-startTime is a decent proxy.
const inputEvents = []; // { startTime, processingStart, duration, name }
let inputMarkerCanvasObservations = null;
// Boot timeline marks (Day 13). Wall-clock ms from t0 (ROM upload start).
// Declared at module scope so the `finally` block can still see them
// if the try-body bails out partway through boot.
let bootMarks = null;
await page.exposeFunction("__menuProgressReportInputEvent", (entry) => {
  inputEvents.push(entry);
});

let probeError = null;
try {
  await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 30000 });
  // bootstrap.js imports app.js through a top-level await, so DOM readiness
  // can precede the ROM change listener. Match boot-matrix's readiness gate.
  await waitForAppReady(page);
  await page.evaluate((showDebugPanel) => {
    const panel = document.querySelector("#debugPanel");
    const toggle = document.querySelector("#debugToggle");
    if (showDebugPanel && panel?.hidden) toggle?.click();
    // Install LoAF observer. Browsers that don't support
    // "long-animation-frame" (older Chrome, Firefox, Safari) throw —
    // swallow the error so the rest of the probe still runs.
    try {
      const obs = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          window.__menuProgressReportLoAF({
            startTime: e.startTime,
            duration: e.duration,
            renderStart: e.renderStart,
            paintTime: e.paintTime,
            presentationTime: e.presentationTime,
            blockingDuration: e.blockingDuration,
          });
        }
      });
      obs.observe({ type: "long-animation-frame", buffered: true });
    } catch (err) {
      // Not all browsers support LoAF. Validator still works; this just
      // skips the long-frame detail capture.
    }
    // Input-event observer (Phase C). durationThreshold:0 captures every
    // input event regardless of handler cost. Lets us measure validator
    // keypress → handler latency. Same swallow-on-error pattern.
    try {
      const obs = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          window.__menuProgressReportInputEvent({
            startTime: e.startTime,
            processingStart: e.processingStart,
            processingEnd: e.processingEnd,
            duration: e.duration,
            name: e.name,
          });
        }
      });
      obs.observe({ type: "event", durationThreshold: 0, buffered: true });
    } catch (err) {
      // PerformanceEventTiming not supported — input latency stays empty.
    }
  }, showDebugPanel);
  if (inputMarkerCanvasObservationEnabled) {
    await page.evaluate(installInputMarkerCanvasObserver);
  }
  // Boot timeline (Day 13). All times are wall-clock ms from "ROM upload
  // dispatched", so we know exactly where each second of startup goes.
  const bootT0 = Date.now();
  bootMarks = { uploadDispatched: 0 };
  await page.setInputFiles("#romInput", romPath);
  bootMarks.uploadComplete = Date.now() - bootT0;
  await page.click("#screen");
  bootMarks.screenClicked = Date.now() - bootT0;
  console.log(`[menu-progress] mounting ROM…`);
  await waitForMount(page);
  bootMarks.mountComplete = Date.now() - bootT0;

  const loadConfiguredSaveState = async (elapsed) => {
    saveStateDone = true;
    let readiness = null;
    let pauseResponse = null;
    let resumeResponse = null;
    let paused = false;
    // The deterministic direct-save path uses the same pause/load/resume
    // barrier as the perf gate. Pausing prevents boot commands from racing the
    // applied-state ownership boundary while State::LoadAs runs.
    if (elapsed <= 0) {
      for (let attempt = 0; attempt < 60; attempt += 1) {
        readiness = await page.evaluate(() => {
          const info = window.__lastFrameInfo || {};
          return {
            frame: Number(info.frame) || 0,
            coreTicks: Number(info.coreTicks) || 0,
            running: Boolean(info.running),
          };
        });
        if (readiness.running && readiness.frame >= 30 && readiness.coreTicks > 0) break;
        await page.waitForTimeout(250);
      }
      if (!readiness?.running || readiness.frame < 30 || readiness.coreTicks <= 0) {
        throw new Error(`Core did not become ready for save-state load: ${JSON.stringify(readiness)}`);
      }
      pauseResponse = await requestWorkerRpc(
        page,
        "validationSetCorePaused",
        { paused: true }
      );
      if (!pauseResponse?.paused || pauseResponse?.coreStateName !== "Paused") {
        throw new Error(
          `Core did not pause before direct save load: ${JSON.stringify(pauseResponse)}`
        );
      }
      paused = true;
    }
    console.log(
      `[menu-progress] loading save state ${saveStateUrl} at t=${elapsed.toFixed(1)}...`
    );
    try {
      const response = await page.evaluate((u) => window.__loadStateFile(u), saveStateUrl);
      if (!response?.loaded) {
        throw new Error(`Save-state load failed: ${response?.error || JSON.stringify(response)}`);
      }
      if (paused) {
        resumeResponse = await requestWorkerRpc(
          page,
          "validationSetCorePaused",
          { paused: false }
        );
        paused = false;
        if (resumeResponse?.coreStateName !== "Running") {
          throw new Error(
            `Core did not resume after direct save load: ${JSON.stringify(resumeResponse)}`
          );
        }
        await page.evaluate(() => {
          window.__host?.adapter?.onStatus?.("Save state loaded (Running)");
        });
      }
      saveStateLoadResult = {
        attemptedAtSeconds: Number(elapsed.toFixed(3)),
        loaded: true,
        readiness,
        pauseResponse,
        resumeResponse,
        response,
      };
      console.log(`[menu-progress] loadStateFile -> ${JSON.stringify(response)}`);
      milestoneLog.push({
        t: elapsed.toFixed(1),
        event: "save-state-loaded",
        response,
      });
    } catch (error) {
      if (paused) {
        try {
          resumeResponse = await requestWorkerRpc(
            page,
            "validationSetCorePaused",
            { paused: false }
          );
        } catch {
          // Preserve the original load error. The run already fails closed.
        }
      }
      saveStateLoadResult = {
        attemptedAtSeconds: Number(elapsed.toFixed(3)),
        loaded: false,
        readiness,
        pauseResponse,
        resumeResponse,
        error: error?.message || String(error),
      };
      console.log(`[menu-progress] loadStateFile threw: ${saveStateLoadResult.error}`);
      throw error;
    }
    await page.waitForTimeout(1500);
    await capture(page, `savestate-loaded-t${Math.round(elapsed)}.png`);
  };

  // SAVE_STATE_AT=0 bypasses menu navigation and character select. Load the
  // reference-battle fixture before first-visible and audio sampling so the
  // headed run begins at the battle rather than presenting boot/menu output.
  if (saveStateUrl && saveStateAt <= 0) {
    await loadConfiguredSaveState(0);
  }

  // First-visible-content milestone: poll the canvas hash once a second
  // until we see something other than the all-zeros boot frame. This
  // captures "time-to-first-pixels", separate from "core mounted".
  bootMarks.firstVisibleContentAt = null;
  for (let attempt = 0; attempt < 30; attempt++) {
    const hashHex = await page.evaluate(() => {
      const screen = document.querySelector("#screen");
      if (!screen) return "no-screen";
      const c = document.createElement("canvas");
      c.width = 32; c.height = 24;
      const ctx = c.getContext("2d", { alpha: false, willReadFrequently: true });
      try {
        ctx.drawImage(screen, 0, 0, c.width, c.height);
        const bytes = ctx.getImageData(0, 0, c.width, c.height).data;
        // Quick non-zero check — if every R/G/B pixel is < 16, treat as
        // "still black" and keep polling.
        let bright = 0;
        for (let i = 0; i < bytes.length; i += 4) {
          if (bytes[i] > 16 || bytes[i + 1] > 16 || bytes[i + 2] > 16) bright++;
        }
        return bright > 5 ? "bright" : "black";
      } catch { return "err"; }
    });
    if (hashHex === "bright") {
      bootMarks.firstVisibleContentAt = Date.now() - bootT0;
      break;
    }
    await page.waitForTimeout(500);
  }

  // Start CDP tracing after mount so the trace covers steady-state +
  // gameplay, not the boot wasm-instantiate spike (already covered by
  // LoAF entries from Phase A). Categories chosen for OGL paint-stall
  // hunting — see the cdpSession block above for the rationale.
  if (cdpSession) {
    try {
      await cdpSession.send("Tracing.start", {
        transferMode: "ReturnAsStream",
        traceConfig: {
          recordMode: "recordContinuously",
          // Minimal categories for compositor / GPU stall diagnosis.
          // Each additional category multiplies trace size. cc + viz +
          // gpu + toplevel give us frame scheduling + GPU command flow
          // without the huge blink/devtools.timeline event volumes.
          includedCategories: [
            "cc",
            "viz",
            "gpu",
            "toplevel",
            "devtools.timeline.frame",
          ],
        },
      });
      console.log("[menu-progress] CDP trace started");
    } catch (err) {
      console.warn(`[menu-progress] Tracing.start failed: ${err.message}`);
      cdpSession = null;
    }
  }

  // Phase C: apply the explicit test audio mode, attach an AnalyserNode to
  // the post-gain graph, and poll its envelope
  // every 250 ms. Wrapped in a single page.evaluate so it runs cleanly
  // even if AudioContext isn't available (older browsers) — failures
  // just leave audioSamples empty.
  await page.evaluate((selectedAudioMode) => {
    try {
      const audio = window.__audio;
      if (!audio) return;
      void audio.setMuted(selectedAudioMode === "muted");
      // ensureContext is async; the actual AudioContext + gain node is
      // created on first call. Trigger it now so the analyser can hook
      // in. We don't await — the validator's RAF-driven sampling will
      // start working as soon as the graph is up.
      void audio.ensureContext();
      const installAnalyser = () => {
        if (!audio.context || !audio.gain) {
          setTimeout(installAnalyser, 50);
          return;
        }
        const analyser = audio.context.createAnalyser();
        analyser.fftSize = 2048;
        // Tap the post-gain stage so muted runs read 0 (sanity check
        // for the unmute path), but unmuted runs see real samples.
        audio.gain.connect(analyser);
        const buf = new Float32Array(analyser.fftSize);
        const t0 = performance.now();
        setInterval(() => {
          analyser.getFloatTimeDomainData(buf);
          let peak = 0;
          let sumSq = 0;
          for (let i = 0; i < buf.length; i++) {
            const v = buf[i];
            const absV = v < 0 ? -v : v;
            if (absV > peak) peak = absV;
            sumSq += v * v;
          }
          const rms = Math.sqrt(sumSq / buf.length);
          window.__menuProgressReportAudio({
            tSec: (performance.now() - t0) / 1000,
            peak: Number(peak.toFixed(6)),
            rms: Number(rms.toFixed(6)),
          });
        }, 250);
      };
      installAnalyser();
    } catch (err) {
      // Browser doesn't support what we need — validator falls back to
      // running without audio samples, the assertion just becomes a
      // "not measured" rather than a fail.
    }
  }, audioMode);

  await capture(page, "00-mounted.png");
  milestoneLog.push({ t: 0, event: "mounted" });

  const startedAt = Date.now();
  const totalSamples = Math.ceil((durationSeconds * 1000) / sampleMs);
  let lastShotSecond = -screenshotEverySeconds;
  for (let index = 0; index <= totalSamples; index += 1) {
    const elapsed = (Date.now() - startedAt) / 1000;
    for (const event of scriptState.filter((c) => !c.sent && c.second <= elapsed)) {
      event.sent = true;
      if (event.action === "down") await page.keyboard.down(event.key);
      else await page.keyboard.up(event.key);
      const tag = `${String(event.index).padStart(2, "0")}-t${Math.round(elapsed)}-${event.action}-${safeKey(event.key)}.png`;
      await capture(page, tag);
      milestoneLog.push({ t: elapsed.toFixed(1), event: `${event.action} ${event.key}`, screenshot: tag });
    }

    if (saveStateUrl && !saveStateDone && elapsed >= saveStateAt) {
      await loadConfiguredSaveState(elapsed);
    }

    if (ssCaptureAt > 0 && !ssCaptureDone && elapsed >= ssCaptureAt) {
      ssCaptureDone = true;
      console.log(`[menu-progress] capturing save state at t=${elapsed.toFixed(1)}…`);
      await capture(page, `pre-savestate-t${Math.round(elapsed)}.png`);
      try {
        const r = await page.evaluate(() => window.__saveStateFile());
        if (r && r.saved && r.b64) {
          const buf = Buffer.from(r.b64, "base64");
          const outPath = path.join(outDir, "core-native-state.sav");
          await writeFile(outPath, buf);
          console.log(`[menu-progress] saved state -> ${outPath} (${buf.length} B, rc ok)`);
        } else {
          console.log(`[menu-progress] saveStateFile failed: ${JSON.stringify(r)}`);
        }
      } catch (e) {
        console.log(`[menu-progress] saveStateFile threw: ${e?.message || e}`);
      }
    }

    if (ssReloadAt > 0 && !ssReloadDone && elapsed >= ssReloadAt) {
      ssReloadDone = true;
      console.log(`[menu-progress] reloading captured state (FS) at t=${elapsed.toFixed(1)}…`);
      await capture(page, `pre-reload-t${Math.round(elapsed)}.png`);
      try {
        const r = await page.evaluate(() => window.__loadStateFileFs("/savestate_out.sav"));
        console.log(`[menu-progress] loadStateFileFs -> ${JSON.stringify(r)}`);
      } catch (e) {
        console.log(`[menu-progress] loadStateFileFs threw: ${e?.message || e}`);
      }
      await page.waitForTimeout(1500);
      await capture(page, `savestate-reloaded-t${Math.round(elapsed)}.png`);
    }

    const rawSample = await readSample(page, elapsed);
    const sample = {
      ...rawSample,
      ...parseProfileMetrics(rawSample.helper, rawSample.frameProfile),
      ...flattenInputPhotonOverhead(rawSample.causalTelemetry),
    };
    samples.push(sample);

    if (sample.visibleHash && !distinctHashes.has(sample.visibleHash)) {
      const hashShot = `hash-${sample.visibleHash.toString(16)}-t${Math.round(elapsed)}.png`;
      await capture(page, hashShot);
      distinctHashes.set(sample.visibleHash, { firstAt: elapsed, screenshot: hashShot });
      milestoneLog.push({ t: elapsed.toFixed(1), event: `new-hash 0x${sample.visibleHash.toString(16)}`, screenshot: hashShot });
    }

    if (elapsed - lastShotSecond >= screenshotEverySeconds) {
      lastShotSecond = elapsed;
      await capture(page, `t${String(Math.round(elapsed)).padStart(3, "0")}.png`);
    }

    if (index % 10 === 0) {
      console.log(
        `[menu-progress] t=${elapsed.toFixed(1).padStart(5)} ` +
        `frame=${sample.frame} present=${sample.presentFps} core=${sample.coreFps} ` +
        `speed=${sample.gameSpeed} visualFps=${sample.visualFps} ` +
        `hash=0x${(sample.visibleHash || 0).toString(16)} ` +
        `distinct=${distinctHashes.size} mode=${sample.coreMode || "-"} ` +
        `status="${(sample.statusPill || "").slice(0, 40)}"`
      );
    }

    if (index < totalSamples) {
      const nextDeadline = startedAt + (index + 1) * sampleMs;
      await page.waitForTimeout(Math.max(0, nextDeadline - Date.now()));
    }
  }

  await capture(page, "zz-final.png");
} catch (error) {
  probeError = error;
  consoleLines.push(`[probe-error] ${error.stack || error.message}`);
  await capture(page, "zz-error.png");
} finally {
  if (inputMarkerCanvasObservationEnabled) {
    try {
      inputMarkerCanvasObservations = await page.evaluate(() =>
        window.__menuProgressInputMarkerObserver?.stop?.() ?? null
      );
    } catch (error) {
      inputMarkerCanvasObservations = {
        schema: "wasm-dolphin.input-marker-canvas-observations.v1",
        enabled: true,
        captureError: String(error?.message || error),
      };
    }
  }
  // Stop CDP tracing and stream the trace file out before browser
  // teardown. Trace is a JSON of trace events; size ~10-50 MB for a
  // 90-second run with our category set. Openable in Chrome DevTools
  // Performance panel (drag the file in) or chrome://tracing.
  if (cdpSession) {
    try {
      const tracePath = path.join(outDir, "chrome-trace.json.gz");
      const traceDone = new Promise((resolve, reject) => {
        cdpSession.once("Tracing.tracingComplete", async (event) => {
          try {
            const handle = event.stream;
            // Stream-decode CDP base64 chunks → gzip → file. Avoids
            // accumulating the whole trace (often >1 GB) in memory.
            const gzip = createGzip();
            const out = createWriteStream(tracePath);
            const piped = pipeline(gzip, out);
            let raw = 0;
            for (;;) {
              const res = await cdpSession.send("IO.read", { handle, size: 1 << 20 });
              if (res.data) {
                const buf = res.base64Encoded
                  ? Buffer.from(res.data, "base64")
                  : Buffer.from(res.data);
                raw += buf.length;
                if (!gzip.write(buf)) {
                  await new Promise((r) => gzip.once("drain", r));
                }
              }
              if (res.eof) break;
            }
            gzip.end();
            await piped;
            await cdpSession.send("IO.close", { handle });
            const { size: gzSize } = await stat(tracePath);
            console.log(
              `[menu-progress] CDP trace saved: ${tracePath} ` +
              `(${(raw / 1048576).toFixed(1)} MB raw, ${(gzSize / 1048576).toFixed(1)} MB gzipped). ` +
              `Open with: gunzip < chrome-trace.json.gz > trace.json ; then load in Chrome DevTools Performance panel.`
            );
            resolve();
          } catch (err) {
            reject(err);
          }
        });
      });
      await cdpSession.send("Tracing.end");
      await traceDone;
    } catch (err) {
      console.warn(`[menu-progress] CDP trace stop failed: ${err.message}`);
    }
  }
  let rendererDiagnostics = null;
  try {
    rendererDiagnostics = await page.evaluate(async () => {
      const request = window.__host?.adapter?.request;
      if (typeof request !== "function") return null;
      return Promise.race([
        Promise.resolve(request.call(window.__host.adapter, "rendererDiagnostics", {})),
        new Promise((_, reject) => setTimeout(
          () => reject(new Error("rendererDiagnostics timed out after 5000 ms")),
          5000
        )),
      ]);
    });
  } catch (error) {
    rendererDiagnostics = { captureError: String(error?.message || error) };
  }
  if (rendererDiagnostics) {
    await writeFile(
      path.join(outDir, "renderer-diagnostics.json"),
      JSON.stringify(rendererDiagnostics, null, 2)
    );
  }
  await writeFile(path.join(outDir, "console.log"), consoleLines.join("\n")).catch(() => {});
  await writeFile(path.join(outDir, "samples.json"), JSON.stringify(samples, null, 2));
  await writeFile(path.join(outDir, "samples.csv"), recordsToCsv(samples));
  await writeFile(path.join(outDir, "milestones.json"), JSON.stringify(milestoneLog, null, 2));
  if (longAnimationFrames.length) {
    await writeFile(
      path.join(outDir, "long-animation-frames.json"),
      JSON.stringify(longAnimationFrames, null, 2)
    );
  }
  if (audioSamples.length) {
    await writeFile(
      path.join(outDir, "audio-samples.json"),
      JSON.stringify(audioSamples, null, 2)
    );
  }
  if (inputEvents.length) {
    await writeFile(
      path.join(outDir, "input-events.json"),
      JSON.stringify(inputEvents, null, 2)
    );
  }
  if (inputMarkerCanvasObservations) {
    await writeFile(
      path.join(outDir, "input-marker-observations.json"),
      JSON.stringify(inputMarkerCanvasObservations, null, 2)
    );
  }
  await writeFile(
    path.join(outDir, "distinct-hashes.json"),
    JSON.stringify(
      [...distinctHashes.entries()].map(([hash, info]) => ({
        hash: `0x${hash.toString(16)}`, firstAt: info.firstAt, screenshot: info.screenshot
      })),
      null,
      2
    )
  );
  const summary = summarize(samples, distinctHashes, {
    audioSamples,
    longAnimationFrames,
    inputEvents,
    bootMarks,
  });
  summary.audio.requestedMode = audioMode;
  summary.inputMarkerCanvas = inputMarkerCanvasObservations?.summary ?? null;
  summary.inputPhoton = {
    enabled: inputPhotonEnabled,
    mode: inputPhotonEnabled ? "external-sensor" : "off",
    measurementBoundary: inputPhotonEnabled
      ? "browser worker input generation through marker submission; external sensor timestamps the photon edge"
      : "not enabled",
    physicalPhotonTimestampCapturedByHarness: false,
    browserCanvasObserverEnabled: inputMarkerCanvasObservationEnabled,
    requestedSize: process.env.INPUTPHOTONSIZE || "centered-default",
    requestedX: process.env.INPUTPHOTONX || "center",
    requestedY: process.env.INPUTPHOTONY || "center",
    overhead: samples.at(-1)?.causalTelemetry?.input?.marker?.overhead ?? null,
    overheadRawOutputs: ["samples.json", "samples.csv"],
  };
  if (inputMarkerCanvasObservationEnabled &&
      inputMarkerCanvasObservations?.summary?.acceptance?.passed !== true) {
    const reasons = inputMarkerCanvasObservations?.summary?.acceptance?.reasons || [
      inputMarkerCanvasObservations?.captureError || "marker observer produced no acceptance summary",
    ];
    probeError ??= new Error(`Input marker acceptance failed: ${reasons.join(", ")}`);
  }
  runMetadata.finishedAt = new Date().toISOString();
  runMetadata.result = {
    sampleCount: samples.length,
    distinctCanvasHashes: distinctHashes.size,
    summaryFile: "summary.json",
    samplesJsonFile: "samples.json",
    samplesCsvFile: "samples.csv",
    rendererDiagnosticsFile: rendererDiagnostics ? "renderer-diagnostics.json" : null,
    inputMarkerObservationsFile: inputMarkerCanvasObservations
      ? "input-marker-observations.json"
      : null,
    saveStateLoad: saveStateLoadResult,
  };
  summary.rendererDiagnostics = rendererDiagnostics;
  summary.provenance = {
    metadataFile: "run-metadata.json",
    commit: runMetadata.git.commit,
    dirty: runMetadata.git.dirty,
    browserVersion: runMetadata.browser.version,
    url: runMetadata.benchmark.url,
    romSha256: runMetadata.artifacts.rom.sha256,
    coreSha256: runMetadata.artifacts.core.sha256,
    saveStateSha256: runMetadata.artifacts.saveState?.sha256 || null,
    saveStateLoaded: Boolean(saveStateLoadResult?.loaded),
  };
  await writeFile(path.join(outDir, "run-metadata.json"), JSON.stringify(runMetadata, null, 2));
  await writeFile(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(`\n[menu-progress] done: ${JSON.stringify(summary, null, 2)}`);
  console.log(`[menu-progress] ${distinctHashes.size} distinct canvas hashes across ${samples.length} samples`);
  console.log(`[menu-progress] artifacts: ${outDir}`);
  // §28cx: dump the in-page main-thread profiler snapshot if it was enabled.
  if (process.env.MAINPROF) {
    try {
      const mp = await page.evaluate(() => window.__mainProfile?.summary?.() ?? null);
      if (mp) {
        await writeFile(path.join(outDir, "mainprofile.json"), JSON.stringify(mp, null, 2));
        console.log(`\n[mainprof] snapshot:\n${JSON.stringify(mp, null, 2)}`);
      } else {
        console.log("[mainprof] window.__mainProfile not present (profiler did not activate)");
      }
    } catch (e) {
      console.log(`[mainprof] capture threw: ${e?.message || e}`);
    }
  }
  await browser.close();
}

if (probeError) throw probeError;

function flattenInputPhotonOverhead(telemetry) {
  const overhead = telemetry?.input?.marker?.overhead;
  if (!overhead) return {};
  const copyPaint = overhead.softwareFrameCopyPaint || {};
  const padStats = overhead.padStatsPollParse || {};
  return {
    inputPhotonOverheadEnabled: overhead.enabled === true,
    inputPhotonFrameCopyPaintCalls: Number(copyPaint.calls) || 0,
    inputPhotonFrameCopyBytes: Number(copyPaint.sourceBytes) || 0,
    inputPhotonMarkerPaintBytes: Number(copyPaint.paintedBytes) || 0,
    inputPhotonFrameCopyPaintTotalMs: Number(copyPaint.totalMs) || 0,
    inputPhotonFrameCopyPaintMaxMs: Number(copyPaint.maxMs) || 0,
    inputPhotonPadStatsPollParseCalls: Number(padStats.calls) || 0,
    inputPhotonPadStatsSourceUtf16Bytes: Number(padStats.sourceUtf16Bytes) || 0,
    inputPhotonPadStatsPollParseTotalMs: Number(padStats.totalMs) || 0,
    inputPhotonPadStatsPollParseMaxMs: Number(padStats.maxMs) || 0,
    inputPhotonPadStatsPollParseFailureCount: Number(padStats.failureCount) || 0,
  };
}

function summarize(samples, hashes, extras = {}) {
  const { audioSamples = [], longAnimationFrames = [], inputEvents = [], bootMarks = null } =
    extras;
  // Skip the initial 20% (boot warmup) when computing averages — same as
  // before. But also split on JIT engagement so a JIT-on regression doesn't
  // hide in a single overall average.
  const after = samples.slice(Math.floor(samples.length * 0.2));
  const jitStartIndex = findJitEngagementIndex(samples);
  const overall = computeBucket(after);
  let preJit = null;
  let postJit = null;
  if (jitStartIndex >= 0) {
    // Indexes are over the full samples array — translate to the post-warmup
    // window where useful. preJit = samples 20%..jitStart-1, postJit = jitStart..end
    // (with no warmup trim on postJit; the JIT engagement itself is the boundary).
    const warmupCutoff = Math.floor(samples.length * 0.2);
    const preFrom = warmupCutoff;
    const preTo = Math.max(preFrom, jitStartIndex);
    preJit = computeBucket(samples.slice(preFrom, preTo));
    postJit = computeBucket(samples.slice(jitStartIndex));
  }
  const smoothness = computeSmoothnessSummary(samples);
  const audioSummary = computeAudioSummary(audioSamples);
  const inputLatency = computeInputLatencySummary(inputEvents);
  const boot = computeBootSummary(bootMarks, samples);
  const renderingHealth = computeRenderingHealth(
    samples,
    hashes,
    overall,
    smoothness,
    audioSummary,
    longAnimationFrames,
    inputLatency,
    boot
  );
  return {
    sampleCount: samples.length,
    distinctCanvasHashes: hashes.size,
    jitEngaged: jitStartIndex >= 0,
    jitEngagementSampleIndex: jitStartIndex,
    jitEngagementElapsedSeconds:
      jitStartIndex >= 0 ? samples[jitStartIndex]?.elapsedSeconds ?? null : null,
    overall,
    preJit,
    postJit,
    smoothness,
    audio: audioSummary,
    inputLatency,
    boot,
    renderingHealth,
    // Keep the flat averageX fields for backward compat with downstream tooling.
    averageGameSpeed: overall.averageGameSpeed,
    averagePresentFps: overall.averagePresentFps,
    averageCoreFps: overall.averageCoreFps,
    averageVisualFps: overall.averageVisualFps,
    finalSample: samples.at(-1),
  };
}

// Summarize the audio-envelope samples collected from the AnalyserNode.
// Each entry is { tSec, peak, rms } at 4 Hz. We report: total samples,
// active sample count (rms above silence floor), peak-rms-ever-seen,
// and "audio was producing sound for N % of the run".
function computeAudioSummary(audioSamples) {
  if (!audioSamples?.length) {
    return {
      enabled: false,
      sampleCount: 0,
      activeSamples: 0,
      activePercent: 0,
      peakRms: 0,
      peakAmplitude: 0,
    };
  }
  const SILENCE_RMS = 0.001; // ~-60 dBFS — well below any real audio
  let activeSamples = 0;
  let peakRms = 0;
  let peakAmplitude = 0;
  for (const s of audioSamples) {
    if (s.rms > SILENCE_RMS) activeSamples += 1;
    if (s.rms > peakRms) peakRms = s.rms;
    if (s.peak > peakAmplitude) peakAmplitude = s.peak;
  }
  return {
    enabled: true,
    sampleCount: audioSamples.length,
    activeSamples,
    activePercent: Number(((100 * activeSamples) / audioSamples.length).toFixed(2)),
    peakRms: Number(peakRms.toFixed(6)),
    peakAmplitude: Number(peakAmplitude.toFixed(6)),
  };
}

// Boot timeline. Breaks the cold-start cost into named phases so we know
// which one is slowest. Times are wall-clock ms from "ROM upload
// dispatched" (the t0 of the validator's interaction with the page).
function computeBootSummary(bootMarks, samples) {
  if (!bootMarks) return null;
  const jitSampleIdx = samples.findIndex(
    (s) => (s.jitBlockCompileCount || 0) > 0 || /JIT enabled/.test(s.statusPill || "")
  );
  const jitEngagementBootMs =
    jitSampleIdx >= 0
      ? Math.round((samples[jitSampleIdx].elapsedSeconds || 0) * 1000) + (bootMarks.mountComplete || 0)
      : null;
  return {
    // Phase durations (ms each). null for first-visible if we never saw
    // bright pixels within the 15 s polling window.
    uploadMs: bootMarks.uploadComplete ?? null,
    clickMs: bootMarks.screenClicked != null && bootMarks.uploadComplete != null
      ? bootMarks.screenClicked - bootMarks.uploadComplete
      : null,
    mountMs: bootMarks.mountComplete != null && bootMarks.screenClicked != null
      ? bootMarks.mountComplete - bootMarks.screenClicked
      : null,
    firstVisibleMs: bootMarks.firstVisibleContentAt != null && bootMarks.mountComplete != null
      ? bootMarks.firstVisibleContentAt - bootMarks.mountComplete
      : null,
    // Cumulative milestones (ms from t0 = upload dispatched).
    timeline: {
      uploadComplete: bootMarks.uploadComplete ?? null,
      screenClicked: bootMarks.screenClicked ?? null,
      mountComplete: bootMarks.mountComplete ?? null,
      firstVisibleContent: bootMarks.firstVisibleContentAt ?? null,
      jitEngagement: jitEngagementBootMs,
    },
  };
}

// Summarize input-event latency. Each entry is a PerformanceEventTiming
// record: startTime (event arrival), processingStart (handler began),
// processingEnd, duration. We compute p50/p95/max of
// processingStart - startTime as "input-to-handler" latency. Note this
// isn't the true input-to-paint metric (would need GPU scanout time)
// but it's the largest controllable slice of the round trip.
function computeInputLatencySummary(inputEvents) {
  // Only count keyboard inputs the validator dispatched (keydown/keyup).
  // Mouse events from Playwright orchestration shouldn't pollute the
  // input-latency channel.
  const keys = inputEvents.filter(
    (e) => e.name === "keydown" || e.name === "keyup"
  );
  if (!keys.length) {
    return {
      enabled: false,
      sampleCount: 0,
      p50Ms: 0,
      p95Ms: 0,
      maxMs: 0,
    };
  }
  const latencies = keys
    .map((e) => Math.max(0, e.processingStart - e.startTime))
    .sort((a, b) => a - b);
  const pct = (p) => latencies[Math.min(latencies.length - 1, Math.floor(p * latencies.length))];
  return {
    enabled: true,
    sampleCount: latencies.length,
    p50Ms: Number(pct(0.5).toFixed(2)),
    p95Ms: Number(pct(0.95).toFixed(2)),
    maxMs: Number(latencies[latencies.length - 1].toFixed(2)),
  };
}

// Aggregate pass/fail health signal across the run. Each check returns
// { name, passed, value, threshold, detail } so the summary doubles as a
// human-readable report and a CI-friendly assertion. The thresholds aim
// for the user-stated bar: "every frame renders as fast as possible like
// perfect 60 Hz no dropping frames or slowing the game down."
function computeRenderingHealth(samples, hashes, overall, smoothness, audio, loafEntries, inputLatency, boot) {
  const checks = [];
  const last = samples.at(-1);

  // 1. Game makes visible progress (catches "boot-and-stick" regressions).
  checks.push({
    name: "progression",
    passed: hashes.size >= 20,
    value: hashes.size,
    threshold: 20,
    detail: "distinct canvas hashes across the run",
  });

  // 2. Average game speed close to 100% post-warmup. <85% means the
  //    emulator can't keep up with NTSC 60 Hz.
  const speed = Number(overall.averageGameSpeed) || 0;
  checks.push({
    name: "game-speed",
    passed: speed >= 85,
    value: Number(speed.toFixed(1)),
    threshold: 85,
    detail: "overall average gameSpeed % (post-warmup)",
  });

  // 3. Drop rate stays low. Each "drop" is a paint interval > 24 ms (one
  //    full 60 Hz frame late). 5% is the loose cutoff; user-perceived
  //    "smooth" needs to stay near 2-3%.
  const dropRate = smoothness?.dropRatePercent ?? 0;
  checks.push({
    name: "drop-rate",
    passed: dropRate <= 5,
    value: dropRate,
    threshold: 5,
    detail: "% of paint intervals > 24 ms (long-frame threshold)",
  });

  // 4. Worst single paint gap. The user-reported 2 s freezes are caught
  //    here. Split into "boot phase" (first 5 s) and "runtime" (after).
  //    Boot phase always pays a wasm-instantiate + initial-JIT spike;
  //    we report it for visibility but don't fail on it. Runtime stalls
  //    are the real user-perceived freezes.
  const maxGap = smoothness?.lifetimeMaxIntervalMs ?? 0;
  const maxGapAtMs = smoothness?.lifetimeMaxIntervalAtMs ?? 0;
  // performance.now() = ms since page load. waitForMount typically
  // takes ~3 s, so anything <5000 ms is boot phase.
  const maxGapInBoot = maxGapAtMs > 0 && maxGapAtMs < 5000;
  checks.push({
    name: "max-gap-boot",
    passed: true, // never fails — boot stalls are expected
    value: maxGapInBoot ? maxGap : 0,
    threshold: null,
    detail: `ms — worst gap during boot phase (first 5 s). ${
      maxGapInBoot ? "(this run)" : "(no boot stall this run)"
    }`,
    informational: true,
  });
  // The asserting check: post-boot stalls. Threshold 500 ms = "no single
  // freeze longer than a coin flip". The user-reported 2 s in-game
  // freeze would fail this check.
  const runtimeMaxGap = maxGapInBoot ? 0 : maxGap;
  checks.push({
    name: "runtime-max-gap",
    passed: runtimeMaxGap <= 500,
    value: runtimeMaxGap,
    threshold: 500,
    detail: maxGapInBoot
      ? `ms — no post-boot stall (worst gap was at t=${(maxGapAtMs / 1000).toFixed(1)}s in boot)`
      : `ms — worst gap post-boot at t=${(maxGapAtMs / 1000).toFixed(1)}s`,
  });

  // 5. 60 Hz target hit rate. With p99 of intervals in <20 ms band, the
  //    emulator is painting on-cadence 99 % of the time.
  const fastPct = smoothness?.fastIntervalPercent ?? 0;
  checks.push({
    name: "fast-interval",
    passed: fastPct >= 90,
    value: fastPct,
    threshold: 90,
    detail: "% of paint intervals < 20 ms (within one 60 Hz slot + slack)",
  });

  // 6. No solid-color frames (all-black or all-clear). A render-corruption
  //    canary: visibleHash == 0 or a stable single-color hash for >3
  //    consecutive samples is a hard fail. We check the most common
  //    hash count vs total — if one hash dominates (>40% of samples)
  //    something is stuck.
  const hashCounts = new Map();
  for (const s of samples) {
    if (!s.visibleHash) continue;
    hashCounts.set(s.visibleHash, (hashCounts.get(s.visibleHash) || 0) + 1);
  }
  const dominantHashCount = Math.max(0, ...hashCounts.values());
  const dominantHashShare =
    samples.length > 0 ? (dominantHashCount / samples.length) * 100 : 0;
  checks.push({
    name: "no-stuck-frame",
    passed: dominantHashShare <= 40,
    value: Number(dominantHashShare.toFixed(1)),
    threshold: 40,
    detail: "% of samples sharing the single most-common canvas hash",
  });

  // 7. Audio is producing sound. Headless probes may not have working
  //    audio output (Chrome's autoplay policy, missing audio device),
  //    so this check is skipped — not failed — when audio wasn't
  //    measured at all. When measured, at least 5 % of samples must
  //    have RMS above the silence floor.
  if (audio?.enabled) {
    checks.push({
      name: "audio-presence",
      passed: audio.activePercent >= 5,
      value: audio.activePercent,
      threshold: 5,
      detail:
        `% of audio samples above silence floor (peak rms = ${audio.peakRms})`,
    });
  } else {
    checks.push({
      name: "audio-presence",
      passed: true, // not measured — not failed
      value: 0,
      threshold: 5,
      detail: "skipped — audio probe didn't capture any samples",
      skipped: true,
    });
  }

  // 8. Input handler latency. p95 input-to-handler should stay below
  //    32 ms (two 60 Hz slots — fast enough that nobody notices).
  if (inputLatency?.enabled) {
    checks.push({
      name: "input-latency",
      passed: inputLatency.p95Ms <= 32,
      value: inputLatency.p95Ms,
      threshold: 32,
      detail: `ms — p95 input event arrival -> handler start (n=${inputLatency.sampleCount})`,
    });
  } else {
    checks.push({
      name: "input-latency",
      passed: true,
      value: 0,
      threshold: 32,
      detail: "skipped — no input events observed",
      skipped: true,
    });
  }

  // 9. Main-thread blocking frames are rare. PerformanceLongAnimationFrame
  //    entries report whenever a frame took >50 ms on the main thread.
  //    A few per minute is normal during JIT engagement; many sustained
  //    long frames indicate a thrash.
  const loafCount = loafEntries?.length ?? 0;
  const runSeconds = samples.length > 0
    ? (samples.at(-1)?.elapsedSeconds || samples.length)
    : 1;
  const loafPerMinute = (60 * loafCount) / Math.max(1, runSeconds);
  checks.push({
    name: "long-anim-frames",
    passed: loafPerMinute <= 10,
    value: Number(loafPerMinute.toFixed(2)),
    threshold: 10,
    detail: `count of >50 ms main-thread frames per minute (total ${loafCount})`,
  });

  // 10. Boot snappiness. Headline number: time from ROM upload to
  //     first visible (non-black) pixel on the canvas. 5 s is the
  //     loose cutoff — under that "feels snappy"; over feels laggy.
  //     We split phases in the boot block above so a fail here can
  //     pinpoint whether it's mount, wasm-instantiate, or first paint
  //     that's slow.
  if (boot && boot.timeline?.firstVisibleContent != null) {
    const ms = boot.timeline.firstVisibleContent;
    checks.push({
      name: "boot-snappy",
      passed: ms <= 5000,
      value: ms,
      threshold: 5000,
      detail:
        `ms from ROM upload to first visible pixel ` +
        `(mount=${boot.mountMs}ms first-paint=${boot.firstVisibleMs}ms)`,
    });
  } else if (boot) {
    checks.push({
      name: "boot-snappy",
      passed: false,
      value: -1,
      threshold: 5000,
      detail: "first visible pixel never observed within 15 s polling window",
    });
  } else {
    checks.push({
      name: "boot-snappy",
      passed: true,
      value: 0,
      threshold: 5000,
      detail: "skipped — no boot timeline data",
      skipped: true,
    });
  }

  const passed = checks.filter((c) => c.passed).length;
  const failed = checks.filter((c) => !c.passed);
  return {
    passed: failed.length === 0,
    passedChecks: passed,
    totalChecks: checks.length,
    failedChecks: failed.map((c) => c.name),
    checks,
  };
}

// Compile the lifetime smoothness picture across the run. Uses the
// last sample's lifetime counters (they're monotonically increasing,
// so the last sample sees the whole run) plus per-sample drop counts
// from the helper string.
function computeSmoothnessSummary(samples) {
  if (!samples.length) return null;
  const last = samples.at(-1);
  const lifetimeMaxIntervalMs = Number(last.presentationLifetimeMaxIntervalMs) || 0;
  const lifetimeMaxIntervalAtMs = Number(last.presentationLifetimeMaxIntervalAtMs) || 0;
  const lifetimeDropCount = Number(last.presentationLifetimeDropCount) || 0;
  const lifetimeFrameCount = Number(last.presentationLifetimeFrameCount) || 0;
  const intervalStddevMs = Number(last.presentationIntervalStddevMs) || 0;
  const histogram = Array.isArray(last.presentationIntervalHistogram)
    ? last.presentationIntervalHistogram
    : null;
  const buckets = Array.isArray(last.presentationIntervalHistogramBuckets)
    ? last.presentationIntervalHistogramBuckets
    : null;
  const histogramTotal = histogram
    ? histogram.reduce((a, b) => a + (b || 0), 0)
    : 0;
  // Translate the histogram into percentage-of-frames-in-each-bucket so
  // the summary is readable across runs of different length.
  let histogramPercent = null;
  if (histogram && buckets && histogramTotal > 0) {
    histogramPercent = histogram.map((count, i) => {
      const label =
        i < buckets.length
          ? `<${buckets[i]}ms`
          : `>=${buckets[buckets.length - 1]}ms`;
      const pct = (100 * (count || 0)) / histogramTotal;
      return { label, count: count || 0, percent: Number(pct.toFixed(2)) };
    });
  }
  const dropRate =
    lifetimeFrameCount > 0
      ? Number(((100 * lifetimeDropCount) / lifetimeFrameCount).toFixed(2))
      : 0;
  // "Smooth 60Hz" interpretation: under 60Hz target, 99% of intervals
  // should fall in <20ms (i.e., not miss a 16.67ms slot by more than a
  // few ms slack). Drop rate (intervals >24ms) tells us how often we
  // miss a full frame's worth.
  const fastIntervalPct = histogramPercent
    ? histogramPercent
        .filter((b) => /^<(8|12|16|20)ms$/.test(b.label))
        .reduce((a, b) => a + b.percent, 0)
    : null;
  return {
    lifetimeFrameCount,
    lifetimeMaxIntervalMs: Number(lifetimeMaxIntervalMs.toFixed(1)),
    // performance.now() timestamp of when the worst gap happened.
    // The validator's elapsedSeconds is measured from Date.now() at probe
    // start, performance.now() is measured from page load — they're on
    // different clocks. We use this only to bucket "boot phase" vs
    // "post-boot", not for precise correlation.
    lifetimeMaxIntervalAtMs: Number(lifetimeMaxIntervalAtMs.toFixed(0)),
    lifetimeDropCount,
    dropRatePercent: dropRate,
    intervalStddevMs: Number(intervalStddevMs.toFixed(2)),
    fastIntervalPercent: fastIntervalPct !== null ? Number(fastIntervalPct.toFixed(2)) : null,
    histogram: histogramPercent,
  };
}

function findJitEngagementIndex(samples) {
  // First sample where any of: statusPill briefly says "JIT enabled", helper
  // stats include `jit:on`, or block compile count goes nonzero. Whichever
  // wins, we treat as the start of the "post-JIT" regime.
  for (let i = 0; i < samples.length; i += 1) {
    const s = samples[i];
    if (typeof s.statusPill === "string" && s.statusPill.includes("JIT enabled")) return i;
    if (typeof s.helper === "string" && /(?:^|\s)jit:on\b/i.test(s.helper)) return i;
    if ((s.jitBlockCompileCount || 0) > 0) return i;
  }
  return -1;
}

function computeBucket(window) {
  if (!window.length) {
    return {
      sampleCount: 0,
      averageGameSpeed: 0,
      averagePresentFps: 0,
      averageCoreFps: 0,
      averageVisualFps: 0,
    };
  }
  const speeds = window.map((s) => parseFloat(String(s.gameSpeed).replace("%", ""))).filter(Number.isFinite);
  const presents = window.map((s) => parseFloat(s.presentFps)).filter(Number.isFinite);
  const cores = window.map((s) => parseFloat(s.coreFps)).filter(Number.isFinite);
  const visuals = window.map((s) => parseFloat(s.visualFps)).filter(Number.isFinite);
  return {
    sampleCount: window.length,
    averageGameSpeed: avg(speeds),
    averagePresentFps: avg(presents),
    averageCoreFps: avg(cores),
    averageVisualFps: avg(visuals),
  };
}

function avg(arr) {
  if (!arr.length) return 0;
  return Number((arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2));
}

async function waitForAppReady(page, timeoutSeconds = 30) {
  for (let attempt = 0; attempt < timeoutSeconds * 4; attempt++) {
    const ready = await page.evaluate(() => {
      const pill = document.querySelector("#statusPill")?.textContent?.trim() ?? "";
      const input = document.querySelector("#romInput");
      return Boolean(input) && pill !== "" && pill !== "Booting";
    }).catch(() => false);
    if (ready) return true;
    await page.waitForTimeout(250);
  }
  return false;
}

async function waitForMount(page) {
  for (let second = 0; second <= 180; second += 1) {
    const state = await page.evaluate(() => ({
      coreMode: document.querySelector("#coreMode")?.textContent?.trim() ?? "",
      mountNote: document.querySelector("#mountNote")?.textContent?.trim() ?? "",
      status: document.querySelector("#statusPill")?.textContent?.trim() ?? "",
    }));
    if (state.coreMode === "Dolphin" && state.mountNote.includes("Dolphin")) return;
    // See the note in boot-matrix.mjs: the optional jit-cache prewarm
    // reports "failed" in its own status text and must not abort the run.
    if (!/^jit-cache:/i.test(state.status) &&
        (/failed|error/i.test(state.status) || /^Dolphin adapter fallback:/i.test(state.status))) {
      throw new Error(`Mount failed: ${state.status}`);
    }
    await page.waitForTimeout(1000);
  }
  throw new Error("Timed out waiting for Dolphin mount");
}

async function requestWorkerRpc(page, type, payload = {}) {
  const configured = Number(process.env.MENU_WORKER_RPC_TIMEOUT_MS || 30000);
  const timeoutMs = Number.isFinite(configured) && configured >= 1000
    ? configured
    : 30000;
  return page.evaluate(async ({ type, payload, timeoutMs }) => {
    const adapter = window.__host?.adapter;
    if (!adapter?.request) {
      throw new Error(`Active adapter does not expose worker RPC ${type}`);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Worker RPC ${type} timed out after ${timeoutMs} ms`)),
        timeoutMs
      );
      Promise.resolve(adapter.request(type, payload)).then(
        (value) => {
          clearTimeout(timer);
          adapter.applyFrame?.(value);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        }
      );
    });
  }, { type, payload, timeoutMs });
}

async function readSample(page, elapsedSeconds) {
  return page.evaluate((elapsedSeconds) => {
    const read = (sel) => document.querySelector(sel)?.textContent?.trim() ?? "";
    const screen = document.querySelector("#screen");
    const state = (window.__menuProgressState ??= {
      canvas: document.createElement("canvas"),
      context: null,
    });
    state.canvas.width = 64;
    state.canvas.height = 48;
    state.context ??= state.canvas.getContext("2d", { alpha: false, willReadFrequently: true });
    let visibleHash = 0, visibleError = "";
    try {
      state.context.drawImage(screen, 0, 0, state.canvas.width, state.canvas.height);
      const bytes = state.context.getImageData(0, 0, state.canvas.width, state.canvas.height).data;
      let hash = 2166136261;
      // Hash every pixel for sensitivity to scene changes.
      for (let index = 0; index < bytes.length; index += 4) {
        hash ^= bytes[index]; hash = Math.imul(hash, 16777619);
        hash ^= bytes[index + 1]; hash = Math.imul(hash, 16777619);
        hash ^= bytes[index + 2]; hash = Math.imul(hash, 16777619);
      }
      // Bucket the hash to ignore tiny variations.
      visibleHash = (hash >>> 0) & 0xfffffff0;
    } catch (e) { visibleError = e.message || String(e); }
    // Structured worker stats (set by app.js's handleFrame). Reading via
    // window is cheaper than DOM scraping and preserves numeric fields
    // (histogram array, lifetime counters, stddev) without round-tripping
    // through textContent.
    const info = window.__lastFrameInfo || {};
    const metricText = (value, fallback = "") =>
      value == null || value === "" ? fallback : String(value);
    const percentText = (value, fallback = "") =>
      value == null || value === "" ? fallback : `${Math.max(0, Number(value) || 0)}%`;
    const formatGap = () => {
      if (info.presentationP95IntervalMs == null && info.presentationMaxIntervalMs == null) {
        return read("#presentationGapCounter");
      }
      const p95 = Number(info.presentationP95IntervalMs) || 0;
      const max = Number(info.presentationMaxIntervalMs) || 0;
      const longFrames = Number(info.presentationLongFrameCount) || 0;
      return `${p95.toFixed(p95 >= 10 ? 0 : 1)} p95 / ` +
        `${max.toFixed(max >= 10 ? 0 : 1)} max / ${longFrames}`;
    };
    // Fall back to the rendered counter for older builds that do not expose
    // structured JIT counters. The debug panel is intentionally kept closed
    // during benchmarks so it cannot trigger its screenshot/download loop.
    const jitText = read("#ppcWasmJit");
    const jitParts = jitText.split("/").map((part) => part.replace(/[^0-9]+/g, ""));
    const parsedJitBlockRunCount = Number.parseInt(jitParts[0] || "0", 10) || 0;
    const parsedJitBlockCompileCount = Number.parseInt(jitParts[1] || "0", 10) || 0;
    const jitBlockRunCount = Number(info.ppcWasmBlockRunCount ?? parsedJitBlockRunCount) || 0;
    const jitBlockCompileCount =
      Number(info.ppcWasmBlockCompileCount ?? parsedJitBlockCompileCount) || 0;
    // Parse drop/underrun out of the helper string. These are emitted as
    // "drop:N underrun:N" inside the worker's ppcWasmHelperStats. The
    // structured fields aren't yet surfaced separately to the DOM but the
    // helper string is always available.
    const helperStr = String(info.ppcWasmHelperStats || read("#ppcWasmHelperStats"));
    const helperDropMatch = /\bdrop:(\d+)/.exec(helperStr);
    const helperUnderrunMatch = /\bunderrun:(\d+)/.exec(helperStr);
    const helperLongMatch = /\blong:(\d+)/.exec(helperStr);
    const helperRawFpsMatch = /\braw:(\d+)/.exec(helperStr);
    return {
      elapsedSeconds,
      frame: metricText(info.frame, read("#frameCounter")),
      presentFps: metricText(info.presentationFps ?? info.fps, read("#fpsCounter")),
      visualFps: metricText(info.visualChangeFps, read("#visualFpsCounter")),
      coreFps: metricText(info.coreFps, read("#coreFpsCounter")),
      gameSpeed: percentText(info.gameSpeed, read("#gameSpeedCounter")),
      gap: formatGap(),
      helper: helperStr,
      frameProfile: String(info.frameProfileStats || read("#frameProfileStats")),
      coreMode: info.mode === "dolphin" ? "Dolphin" : read("#coreMode"),
      mountNote: read("#mountNote"),
      gameTitle: read("#gameTitle"),
      statusPill: read("#statusPill"),
      input: read("#inputSource"),
      jitBlockRunCount,
      jitBlockCompileCount,
      visibleHash,
      visibleError,
      // Structured smoothness fields (Phase A).
      presentationRawFps: Number(info.presentationRawFps) || 0,
      presentationP95IntervalMs: Number(info.presentationP95IntervalMs) || 0,
      presentationMaxIntervalMs: Number(info.presentationMaxIntervalMs) || 0,
      presentationLifetimeMaxIntervalMs:
        Number(info.presentationLifetimeMaxIntervalMs) || 0,
      presentationLifetimeMaxIntervalAtMs:
        Number(info.presentationLifetimeMaxIntervalAtMs) || 0,
      presentationLifetimeDropCount:
        Number(info.presentationLifetimeDropCount) || 0,
      presentationLifetimeFrameCount:
        Number(info.presentationLifetimeFrameCount) || 0,
      presentationIntervalStddevMs:
        Number(info.presentationIntervalStddevMs) || 0,
      presentationIntervalHistogram: Array.isArray(info.presentationIntervalHistogram)
        ? info.presentationIntervalHistogram.slice()
        : null,
      presentationIntervalHistogramBuckets: Array.isArray(
        info.presentationIntervalHistogramBuckets
      )
        ? info.presentationIntervalHistogramBuckets.slice()
        : null,
      presentationFrameLag: Number(info.presentationFrameLag) || 0,
      presentationQueueAgeMs: Number(info.presentationQueueAgeMs) || 0,
      causalTelemetry: info.causalTelemetry || window.__causalTelemetry || null,
      // Parsed from helper string (worker doesn't surface these to DOM yet).
      helperDropCount: helperDropMatch ? Number(helperDropMatch[1]) : 0,
      helperUnderrunCount: helperUnderrunMatch ? Number(helperUnderrunMatch[1]) : 0,
      helperLongFrameCount: helperLongMatch ? Number(helperLongMatch[1]) : 0,
      helperRawFps: helperRawFpsMatch ? Number(helperRawFpsMatch[1]) : 0,
    };
  }, elapsedSeconds);
}

async function capture(page, name) {
  if (!captureScreenshots) return;
  try { await page.screenshot({ path: path.join(outDir, name), timeout: 5000 }); } catch {}
}

// INPUTLATENCY=1 installs this page-side observer. Keeping the rAF loop and
// canvas readback inside the page avoids a Playwright round-trip per frame.
// The returned latency ends at the first rAF-time read of #screen containing
// a matching 8x8 sample from the deterministic 32x32 sensor-visible marker;
// it does not claim compositor or panel scanout.
function installInputMarkerCanvasObserver() {
  if (window.__menuProgressInputMarkerObserver) return;

  const MARKER_SIZE = 8;
  const RENDERED_MARKER_SIZE = 32;
  const GENERATION_MASK = 0x3ffff;
  const MAX_RAW_OBSERVATIONS = 120000;
  const legacyBackbufferReadbackEnabled = /(?:^|[?&])inputreadback=1(?:&|$)/.test(
    String(globalThis.location?.search || "")
  );
  const scratch = document.createElement("canvas");
  scratch.width = MARKER_SIZE;
  scratch.height = MARKER_SIZE;
  const context = scratch.getContext("2d", {
    alpha: false,
    willReadFrequently: true,
  });
  const inputByGeneration = new Map();
  const firstCandidateByEncodedGeneration = new Map();
  const provisionalByGeneration = new Map();
  const validatedByGeneration = new Map();
  const state = {
    schema: "wasm-dolphin.input-marker-canvas-observations.v1",
    enabled: true,
    meaning:
      "input generation to first deterministic marker read from #screen at requestAnimationFrame cadence",
    observationBoundary:
      "browser canvas readback in a requestAnimationFrame callback; compositor-to-panel scanout is excluded",
    scanoutIncluded: false,
    perturbsRendering: true,
    perturbation:
      "drawImage plus getImageData runs every requestAnimationFrame and can synchronize GPU/canvas work; compare only diagnostic runs with the same observer setting",
    legacyBackbufferReadbackEnabled,
    markerSampleSize: MARKER_SIZE,
    renderedMarkerSize: RENDERED_MARKER_SIZE,
    startedAtEpochMs: Date.now(),
    stoppedAtEpochMs: 0,
    rafSampleCount: 0,
    canvasReadCount: 0,
    canvasReadErrorCount: 0,
    canvasReadTotalMs: 0,
    canvasReadMaxMs: 0,
    canvasUnavailableCount: 0,
    rawObservationDropCount: 0,
    lastCanvasReadError: "",
    inputGenerations: [],
    rawObservations: [],
    provisionalGenerations: [],
    validatedGenerations: [],
    finalJoinPromotionCount: 0,
    latestWorkerMarkerStats: null,
    summary: null,
  };
  let stopped = false;
  let rafId = 0;
  let lastInputEvent = null;
  let adapterPatch = null;
  let finalSnapshot = null;

  const finiteOrNull = (value) => {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  };
  const eventEpochMs = (event) => {
    const timestamp = Number(event.timeStamp);
    if (!Number.isFinite(timestamp)) return Date.now();
    return timestamp > 1e12 ? timestamp : performance.timeOrigin + timestamp;
  };
  const recordInputEvent = (event) => {
    lastInputEvent = {
      type: event.type,
      code: event.code || "",
      key: event.key || "",
      atEpochMs: eventEpochMs(event),
    };
  };
  document.addEventListener("keydown", recordInputEvent, true);
  document.addEventListener("keyup", recordInputEvent, true);

  function restoreAdapterPatch() {
    if (!adapterPatch) return;
    if (adapterPatch.adapter.setInputState === adapterPatch.wrapped) {
      adapterPatch.adapter.setInputState = adapterPatch.original;
    }
    adapterPatch = null;
  }

  function patchAdapter() {
    const adapter = window.__host?.adapter;
    if (!adapter || typeof adapter.setInputState !== "function") return;
    if (adapterPatch?.adapter === adapter) return;
    restoreAdapterPatch();

    const original = adapter.setInputState;
    const wrapped = function inputMarkerObservedSetInputState(...args) {
      const before = Number(this.inputTelemetry?.mainGeneration) >>> 0;
      const adapterCallStartedAtEpochMs = Date.now();
      try {
        return original.apply(this, args);
      } finally {
        const generation = Number(this.inputTelemetry?.mainGeneration) >>> 0;
        if (generation && generation !== before && !inputByGeneration.has(generation)) {
          const eventAgeMs = lastInputEvent
            ? adapterCallStartedAtEpochMs - lastInputEvent.atEpochMs
            : Number.POSITIVE_INFINITY;
          const relatedEvent = eventAgeMs >= -2 && eventAgeMs <= 250
            ? { ...lastInputEvent }
            : null;
          const inputState = args[0] || {};
          const record = {
            generation,
            adapterCallStartedAtEpochMs,
            adapterCallFinishedAtEpochMs: Date.now(),
            event: relatedEvent,
            inputMask: Number(inputState.mask) >>> 0,
          };
          inputByGeneration.set(generation, record);
          state.inputGenerations.push(record);
        }
      }
    };
    adapter.setInputState = wrapped;
    adapterPatch = { adapter, original, wrapped };
  }

  function workerMarkerInfo(decodedGeneration) {
    const telemetry =
      window.__lastFrameInfo?.causalTelemetry || window.__causalTelemetry || null;
    const marker = telemetry?.input?.marker || null;
    if (!marker) {
      return {
        telemetryCapturedAtMs: null,
        generation: 0,
        sample: null,
        timestamps: null,
        markerStats: null,
      };
    }

    const samples = Array.isArray(marker.samples) ? marker.samples : [];
    const generationCandidates = [
      marker.activeGeneration,
      marker.lastCompletedGeneration,
      ...samples.map((sample) => sample?.generation),
    ];
    let generation = 0;
    for (let index = generationCandidates.length - 1; index >= 0; index -= 1) {
      const candidate = Number(generationCandidates[index]) >>> 0;
      if (candidate && (candidate & GENERATION_MASK) === decodedGeneration) {
        generation = candidate;
        break;
      }
    }
    const sample = generation
      ? [...samples].reverse().find(
          (candidate) => (Number(candidate?.generation) >>> 0) === generation
        ) || null
      : null;
    const timestampNames = [
      "sentAtEpochMs",
      "appliedAtEpochMs",
      "polledAtEpochMs",
      "submittedAtEpochMs",
      "completedAtEpochMs",
    ];
    const timestamps = {};
    for (const name of timestampNames) {
      const topLevelName = `last${name[0].toUpperCase()}${name.slice(1)}`;
      timestamps[name] = finiteOrNull(sample?.[name] ?? marker?.[topLevelName]);
    }
    const timestampJoinAvailable = Object.values(timestamps).some((value) => value !== null);
    const markerStatNames = [
      "appliedCount",
      "exactCorePollCount",
      "markerSubmittedCount",
      "markerCompletedCount",
      "expiredMarkerCount",
      "expiredInFlightCount",
      "generationMismatchCount",
      "generationUnavailableCount",
    ];
    const markerStats = { enabled: marker.enabled === true };
    for (const name of markerStatNames) {
      markerStats[name] = finiteOrNull(marker[name]);
    }
    return {
      telemetryCapturedAtMs: finiteOrNull(telemetry.capturedAtMs),
      generation,
      sample: sample
        ? {
            generation: Number(sample.generation) >>> 0,
            coreFrame: Number(sample.coreFrame) >>> 0,
            source: String(sample.source || ""),
            completionKind: String(sample.completionKind || ""),
            completionAgeMs: finiteOrNull(sample.completionAgeMs),
            pollToCompletionMs: finiteOrNull(sample.pollToCompletionMs),
          }
        : null,
      timestamps: timestampJoinAvailable ? timestamps : null,
      markerStats,
    };
  }

  function matchingInputRecord(decodedGeneration) {
    const records = state.inputGenerations;
    for (let index = records.length - 1; index >= 0; index -= 1) {
      const record = records[index];
      if ((record.generation & GENERATION_MASK) === decodedGeneration) return record;
    }
    return null;
  }

  function appendRawObservation(observation) {
    if (state.rawObservations.length < MAX_RAW_OBSERVATIONS) {
      state.rawObservations.push(observation);
    } else {
      state.rawObservationDropCount += 1;
    }
  }

  function stageDelta(end, start) {
    return Number.isFinite(end) && Number.isFinite(start) ? end - start : null;
  }

  function completeWorkerTimestamps(timestamps) {
    return Boolean(timestamps) && [
      timestamps.sentAtEpochMs,
      timestamps.appliedAtEpochMs,
      timestamps.polledAtEpochMs,
      timestamps.submittedAtEpochMs,
      timestamps.completedAtEpochMs,
    ].every(Number.isFinite);
  }

  function monotonicWorkerTimestamps(timestamps, browserCanvasVisibleAtEpochMs) {
    if (!completeWorkerTimestamps(timestamps) ||
        !Number.isFinite(browserCanvasVisibleAtEpochMs)) {
      return false;
    }
    // completedAtEpochMs is when the JS onSubmittedWorkDone() callback runs,
    // not a hardware timestamp. The browser may paint already-submitted work
    // before that callback receives a main-thread turn, so validate the worker
    // lifecycle and submitted-to-visible chains independently.
    const workerOrdered = [
      timestamps.sentAtEpochMs,
      timestamps.appliedAtEpochMs,
      timestamps.polledAtEpochMs,
      timestamps.submittedAtEpochMs,
      timestamps.completedAtEpochMs,
    ];
    return workerOrdered.every(
      (value, index) => index === 0 || value >= workerOrdered[index - 1]
    ) && browserCanvasVisibleAtEpochMs >= timestamps.submittedAtEpochMs;
  }

  function buildGenerationObservation({
    generation,
    decodedGeneration,
    firstObserved,
    input,
    worker,
    adapterValidated,
    workerValidated,
  }) {
    const inputEventAtEpochMs = input?.event?.atEpochMs ?? null;
    const adapterCallStartedAtEpochMs = input?.adapterCallStartedAtEpochMs ?? null;
    const adapterCallFinishedAtEpochMs = input?.adapterCallFinishedAtEpochMs ?? null;
    const timestamps = worker?.timestamps ?? null;
    const sentAtEpochMs = timestamps?.sentAtEpochMs ?? null;
    const appliedAtEpochMs = timestamps?.appliedAtEpochMs ?? null;
    const polledAtEpochMs = timestamps?.polledAtEpochMs ?? null;
    const submittedAtEpochMs = timestamps?.submittedAtEpochMs ?? null;
    const completedAtEpochMs = timestamps?.completedAtEpochMs ?? null;
    const browserCanvasVisibleAtEpochMs = firstObserved.canvasReadAtEpochMs;
    return {
      generation,
      decodedGeneration,
      firstObservedRafIndex: firstObserved.rafIndex,
      firstObservedAtEpochMs: browserCanvasVisibleAtEpochMs,
      browserCanvasVisibleAtEpochMs,
      rgba: firstObserved.rgba,
      inputEventAtEpochMs,
      adapterGeneratedAtEpochMs: adapterCallStartedAtEpochMs,
      adapterCallStartedAtEpochMs,
      adapterCallFinishedAtEpochMs,
      workerSentAtEpochMs: sentAtEpochMs,
      appliedAtEpochMs,
      polledAtEpochMs,
      submittedAtEpochMs,
      completedAtEpochMs,
      adapterToBrowserCanvasVisibleMs: stageDelta(
        browserCanvasVisibleAtEpochMs,
        adapterCallStartedAtEpochMs
      ),
      inputEventToBrowserCanvasVisibleMs: stageDelta(
        browserCanvasVisibleAtEpochMs,
        inputEventAtEpochMs
      ),
      workerSentToBrowserCanvasVisibleMs: stageDelta(
        browserCanvasVisibleAtEpochMs,
        sentAtEpochMs
      ),
      stageDeltas: {
        inputEventToAdapterStartMs: stageDelta(
          adapterCallStartedAtEpochMs,
          inputEventAtEpochMs
        ),
        adapterCallDurationMs: stageDelta(
          adapterCallFinishedAtEpochMs,
          adapterCallStartedAtEpochMs
        ),
        adapterFinishedToWorkerAppliedMs: stageDelta(
          appliedAtEpochMs,
          adapterCallFinishedAtEpochMs
        ),
        workerSentToAppliedMs: stageDelta(appliedAtEpochMs, sentAtEpochMs),
        workerAppliedToCorePollMs: stageDelta(polledAtEpochMs, appliedAtEpochMs),
        corePollToMarkerSubmitMs: stageDelta(submittedAtEpochMs, polledAtEpochMs),
        markerSubmitToGpuCompleteMs: stageDelta(completedAtEpochMs, submittedAtEpochMs),
        markerSubmitToGpuCompletionCallbackMs: stageDelta(
          completedAtEpochMs,
          submittedAtEpochMs
        ),
        gpuCompleteToBrowserCanvasVisibleMs: stageDelta(
          browserCanvasVisibleAtEpochMs,
          completedAtEpochMs
        ),
        gpuCompletionCallbackToBrowserCanvasVisibleMs: stageDelta(
          browserCanvasVisibleAtEpochMs,
          completedAtEpochMs
        ),
        inputEventToBrowserCanvasVisibleMs: stageDelta(
          browserCanvasVisibleAtEpochMs,
          inputEventAtEpochMs
        ),
      },
      workerTimestampsComplete: completeWorkerTimestamps(timestamps),
      workerTimestampsMonotonic: monotonicWorkerTimestamps(
        timestamps,
        browserCanvasVisibleAtEpochMs
      ),
      completionCallbackAfterCanvasVisible:
        Number.isFinite(completedAtEpochMs) &&
        Number.isFinite(browserCanvasVisibleAtEpochMs) &&
        completedAtEpochMs > browserCanvasVisibleAtEpochMs,
      adapterValidated,
      workerValidated,
      workerTelemetryCapturedAtMs: worker?.telemetryCapturedAtMs ?? null,
      workerSample: worker?.sample ?? null,
      workerTimestamps: timestamps,
    };
  }

  function promoteWorkerValidatedObservation({
    generation,
    decodedGeneration,
    firstObserved,
    input,
    worker,
    adapterValidated,
    joinedAtStop = false,
  }) {
    if (!generation || worker?.generation !== generation) return false;
    const workerObservation = buildGenerationObservation({
      generation,
      decodedGeneration,
      firstObserved,
      input,
      worker,
      adapterValidated,
      workerValidated: true,
    });
    workerObservation.joinedAtStop = joinedAtStop;
    const validated = validatedByGeneration.get(generation);
    if (validated) {
      Object.assign(validated, workerObservation);
    } else {
      validatedByGeneration.set(generation, workerObservation);
      state.validatedGenerations.push(workerObservation);
    }
    const provisional = provisionalByGeneration.get(generation);
    if (provisional) {
      provisional.promotedToWorkerValidated = true;
      provisional.joinedAtStop = joinedAtStop;
    }
    return !validated;
  }

  function joinFinalCompletedWorkerSamples() {
    for (const provisional of state.provisionalGenerations) {
      if (validatedByGeneration.has(provisional.generation)) continue;
      const worker = workerMarkerInfo(provisional.decodedGeneration);
      if (worker.generation !== provisional.generation ||
          !worker.sample ||
          !completeWorkerTimestamps(worker.timestamps)) {
        continue;
      }
      const firstObserved = {
        rafIndex: provisional.firstObservedRafIndex,
        canvasReadAtEpochMs: provisional.browserCanvasVisibleAtEpochMs,
        rgba: provisional.rgba,
      };
      const promoted = promoteWorkerValidatedObservation({
        generation: provisional.generation,
        decodedGeneration: provisional.decodedGeneration,
        firstObserved,
        input: inputByGeneration.get(provisional.generation) || null,
        worker,
        adapterValidated: true,
        joinedAtStop: true,
      });
      if (promoted) state.finalJoinPromotionCount += 1;
      if (worker.markerStats) state.latestWorkerMarkerStats = { ...worker.markerStats };
    }
  }

  function observe(rafTimestampMs) {
    if (stopped) return;
    patchAdapter();
    state.rafSampleCount += 1;
    const rafIndex = state.rafSampleCount;
    const screen = document.querySelector("#screen");
    const baseObservation = {
      rafIndex,
      rafTimestampMs: Number(rafTimestampMs.toFixed(3)),
      rafCallbackAtEpochMs: performance.timeOrigin + rafTimestampMs,
      canvasWidth: Number(screen?.width) || 0,
      canvasHeight: Number(screen?.height) || 0,
    };

    if (!screen || !context || screen.width < MARKER_SIZE || screen.height < MARKER_SIZE) {
      state.canvasUnavailableCount += 1;
      appendRawObservation({ ...baseObservation, status: "canvas-unavailable" });
      rafId = requestAnimationFrame(observe);
      return;
    }

    const canvasReadStartedAt = performance.now();
    try {
      context.drawImage(
        screen,
        0,
        0,
        MARKER_SIZE,
        MARKER_SIZE,
        0,
        0,
        MARKER_SIZE,
        MARKER_SIZE
      );
      const bytes = context.getImageData(0, 0, MARKER_SIZE, MARKER_SIZE).data;
      const canvasReadDurationMs = Math.max(0, performance.now() - canvasReadStartedAt);
      state.canvasReadTotalMs += canvasReadDurationMs;
      state.canvasReadMaxMs = Math.max(state.canvasReadMaxMs, canvasReadDurationMs);
      const rgba = [bytes[0], bytes[1], bytes[2], bytes[3]];
      let uniformPixelCount = 0;
      for (let offset = 0; offset < bytes.length; offset += 4) {
        if (
          bytes[offset] === rgba[0] &&
          bytes[offset + 1] === rgba[1] &&
          bytes[offset + 2] === rgba[2] &&
          bytes[offset + 3] === rgba[3]
        ) {
          uniformPixelCount += 1;
        }
      }
      const markerSignature =
        uniformPixelCount === MARKER_SIZE * MARKER_SIZE &&
        (rgba[0] & 0xc0) === 0x40 &&
        (rgba[1] & 0xc0) === 0x80 &&
        (rgba[2] & 0xc0) === 0xc0 &&
        rgba[3] === 0xff;
      const decodedGeneration = markerSignature
        ? (rgba[0] & 0x3f) | ((rgba[1] & 0x3f) << 6) | ((rgba[2] & 0x3f) << 12)
        : 0;
      const canvasReadAtEpochMs = performance.timeOrigin + performance.now();
      const worker = decodedGeneration ? workerMarkerInfo(decodedGeneration) : null;
      if (worker?.markerStats) state.latestWorkerMarkerStats = { ...worker.markerStats };
      const input = decodedGeneration ? matchingInputRecord(decodedGeneration) : null;
      const currentAdapterGeneration =
        Number(window.__host?.adapter?.inputTelemetry?.mainGeneration) >>> 0;
      const fullGeneration =
        worker?.generation || input?.generation ||
        ((currentAdapterGeneration & GENERATION_MASK) === decodedGeneration
          ? currentAdapterGeneration
          : 0);
      const adapterValidated = Boolean(fullGeneration && (
        input?.generation === fullGeneration || currentAdapterGeneration === fullGeneration
      ));
      const workerValidated = Boolean(
        fullGeneration && worker?.generation === fullGeneration
      );
      const generationValidated = markerSignature && Boolean(
        decodedGeneration && (adapterValidated || workerValidated)
      );
      const rawObservation = {
        ...baseObservation,
        status: "read",
        canvasReadDurationMs,
        canvasReadAtEpochMs,
        rgba,
        uniformPixelCount,
        markerSignature,
        decodedGeneration,
        fullGeneration,
        currentAdapterGeneration,
        adapterValidated,
        workerValidated,
        generationValidated,
        workerTelemetryCapturedAtMs: worker?.telemetryCapturedAtMs ?? null,
        workerSample: worker?.sample ?? null,
        workerTimestamps: worker?.timestamps ?? null,
      };
      appendRawObservation(rawObservation);
      state.canvasReadCount += 1;

      if (markerSignature && decodedGeneration) {
        let firstCandidate = firstCandidateByEncodedGeneration.get(decodedGeneration);
        if (!firstCandidate) {
          firstCandidate = {
            rafIndex,
            canvasReadAtEpochMs,
            rgba,
          };
          firstCandidateByEncodedGeneration.set(decodedGeneration, firstCandidate);
        }
        if (generationValidated && fullGeneration) {
          const inputStart = input?.adapterCallStartedAtEpochMs ?? null;
          const candidateAfterInput = inputStart === null ||
            firstCandidate.canvasReadAtEpochMs >= inputStart - 2;
          const firstObserved = candidateAfterInput ? firstCandidate : {
            rafIndex,
            canvasReadAtEpochMs,
            rgba,
          };
          if (adapterValidated && !provisionalByGeneration.has(fullGeneration)) {
            const provisional = buildGenerationObservation({
              generation: fullGeneration,
              decodedGeneration,
              firstObserved,
              input,
              worker: null,
              adapterValidated: true,
              workerValidated: false,
            });
            provisional.promotedToWorkerValidated = workerValidated;
            provisionalByGeneration.set(fullGeneration, provisional);
            state.provisionalGenerations.push(provisional);
          }
          if (workerValidated) {
            promoteWorkerValidatedObservation({
              generation: fullGeneration,
              decodedGeneration,
              firstObserved,
              input,
              worker,
              adapterValidated,
              joinedAtStop: false,
            });
          }
        }
      }
    } catch (error) {
      const canvasReadDurationMs = Math.max(0, performance.now() - canvasReadStartedAt);
      state.canvasReadTotalMs += canvasReadDurationMs;
      state.canvasReadMaxMs = Math.max(state.canvasReadMaxMs, canvasReadDurationMs);
      state.canvasReadErrorCount += 1;
      state.lastCanvasReadError = String(error?.message || error);
      appendRawObservation({
        ...baseObservation,
        status: "read-error",
        canvasReadDurationMs,
        error: state.lastCanvasReadError,
      });
    }

    rafId = requestAnimationFrame(observe);
  }

  function latencyStats(values) {
    const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
    if (!sorted.length) {
      return { sampleCount: 0, averageMs: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 };
    }
    const percentile = (quantile) =>
      sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1))];
    const average = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
    return {
      sampleCount: sorted.length,
      averageMs: Number(average.toFixed(3)),
      p50Ms: Number(percentile(0.5).toFixed(3)),
      p95Ms: Number(percentile(0.95).toFixed(3)),
      maxMs: Number(sorted.at(-1).toFixed(3)),
    };
  }

  function buildSummary() {
    const workerValidated = state.validatedGenerations.filter(
      (sample) => sample.workerValidated === true
    );
    const expectedGenerationCount = state.inputGenerations.length;
    const markerStats = state.latestWorkerMarkerStats;
    const count = (name) => finiteOrNull(markerStats?.[name]);
    const parityCounts = {
      expected: expectedGenerationCount,
      applied: count("appliedCount"),
      polled: count("exactCorePollCount"),
      submitted: count("markerSubmittedCount"),
      completed: count("markerCompletedCount"),
      browserCanvasVisible: workerValidated.length,
    };
    const workerTimestampJoinCount = workerValidated.filter(
      (sample) => sample.workerTimestampsComplete
    ).length;
    const monotonicTimestampCount = workerValidated.filter(
      (sample) => sample.workerTimestampsMonotonic
    ).length;
    const completionCallbackAfterCanvasVisibleCount = workerValidated.filter(
      (sample) => sample.completionCallbackAfterCanvasVisible
    ).length;
    const acceptanceReasons = [];
    if (expectedGenerationCount < 6) {
      acceptanceReasons.push("expected-generation-count-below-six");
    }
    for (const [stage, actual] of Object.entries(parityCounts)) {
      if (stage !== "expected" && actual !== expectedGenerationCount) {
        acceptanceReasons.push(`${stage}-parity-${actual ?? "unavailable"}-of-${expectedGenerationCount}`);
      }
    }
    if (workerTimestampJoinCount !== expectedGenerationCount) {
      acceptanceReasons.push(
        `complete-worker-timestamp-parity-${workerTimestampJoinCount}-of-${expectedGenerationCount}`
      );
    }
    if (monotonicTimestampCount !== expectedGenerationCount) {
      acceptanceReasons.push(
        `monotonic-timestamp-parity-${monotonicTimestampCount}-of-${expectedGenerationCount}`
      );
    }
    for (const name of [
      "expiredMarkerCount",
      "expiredInFlightCount",
      "generationMismatchCount",
      "generationUnavailableCount",
    ]) {
      const value = count(name);
      if (value !== 0) acceptanceReasons.push(`${name}-${value ?? "unavailable"}`);
    }
    if (state.canvasReadErrorCount !== 0) {
      acceptanceReasons.push(`canvas-read-errors-${state.canvasReadErrorCount}`);
    }
    if (state.canvasUnavailableCount !== 0) {
      acceptanceReasons.push(`canvas-unavailable-${state.canvasUnavailableCount}`);
    }
    if (state.rawObservationDropCount !== 0) {
      acceptanceReasons.push(`raw-observation-drops-${state.rawObservationDropCount}`);
    }
    if (state.legacyBackbufferReadbackEnabled) {
      acceptanceReasons.push("inputreadback-must-be-disabled");
    }
    const stageNames = [
      "inputEventToAdapterStartMs",
      "adapterCallDurationMs",
      "adapterFinishedToWorkerAppliedMs",
      "workerSentToAppliedMs",
      "workerAppliedToCorePollMs",
      "corePollToMarkerSubmitMs",
      "markerSubmitToGpuCompleteMs",
      "markerSubmitToGpuCompletionCallbackMs",
      "gpuCompleteToBrowserCanvasVisibleMs",
      "gpuCompletionCallbackToBrowserCanvasVisibleMs",
      "inputEventToBrowserCanvasVisibleMs",
    ];
    const stageLatency = Object.fromEntries(stageNames.map((name) => [
      name,
      latencyStats(workerValidated.map((sample) => sample.stageDeltas?.[name])),
    ]));
    return {
      enabled: true,
      measurement:
        "worker-validated input generation to first matching 8x8 sample of the 32x32 browser-canvas-visible marker",
      gpuCompletionTimestampMeaning:
        "onSubmittedWorkDone callback observation; not an exact hardware completion timestamp",
      observationBoundary: state.observationBoundary,
      scanoutIncluded: false,
      physicalPhotonBoundaryIncluded: false,
      perturbsRendering: true,
      perturbation: state.perturbation,
      legacyBackbufferReadbackEnabled: state.legacyBackbufferReadbackEnabled,
      rafSampleCount: state.rafSampleCount,
      canvasReadCount: state.canvasReadCount,
      canvasReadErrorCount: state.canvasReadErrorCount,
      canvasUnavailableCount: state.canvasUnavailableCount,
      rawObservationDropCount: state.rawObservationDropCount,
      canvasReadAverageMs: state.canvasReadCount + state.canvasReadErrorCount > 0
        ? state.canvasReadTotalMs / (state.canvasReadCount + state.canvasReadErrorCount)
        : 0,
      canvasReadMaxMs: state.canvasReadMaxMs,
      provisionalGenerationCount: state.provisionalGenerations.length,
      finalJoinPromotionCount: state.finalJoinPromotionCount,
      validatedGenerationCount: workerValidated.length,
      workerValidatedGenerationCount: workerValidated.length,
      workerTimestampJoinCount,
      monotonicTimestampCount,
      completionCallbackAfterCanvasVisibleCount,
      workerMarkerStats: markerStats,
      acceptance: {
        passed: acceptanceReasons.length === 0,
        reasons: acceptanceReasons,
        minimumExpectedGenerationCount: 6,
        expectedGenerationCount,
        parityCounts,
        completeWorkerTimestampCount: workerTimestampJoinCount,
        monotonicTimestampCount,
      },
      adapterToBrowserCanvasVisible: latencyStats(
        workerValidated.map((sample) => sample.adapterToBrowserCanvasVisibleMs)
      ),
      inputEventToBrowserCanvasVisible: latencyStats(
        workerValidated.map((sample) => sample.inputEventToBrowserCanvasVisibleMs)
      ),
      workerSentToBrowserCanvasVisible: latencyStats(
        workerValidated.map((sample) => sample.workerSentToBrowserCanvasVisibleMs)
      ),
      stageLatency,
    };
  }

  function stop() {
    if (finalSnapshot) return finalSnapshot;
    stopped = true;
    cancelAnimationFrame(rafId);
    document.removeEventListener("keydown", recordInputEvent, true);
    document.removeEventListener("keyup", recordInputEvent, true);
    restoreAdapterPatch();
    joinFinalCompletedWorkerSamples();
    state.stoppedAtEpochMs = Date.now();
    state.summary = buildSummary();
    finalSnapshot = state;
    return finalSnapshot;
  }

  window.__menuProgressInputMarkerObserver = { stop };
  rafId = requestAnimationFrame(observe);
}

async function importPlaywright() {
  if (process.env.PLAYWRIGHT_MODULE) {
    const configured = path.resolve(process.env.PLAYWRIGHT_MODULE);
    if (!existsSync(configured)) {
      throw new Error(`PLAYWRIGHT_MODULE does not exist: ${configured}`);
    }
    return import(pathToFileURL(configured).href);
  }
  const local = path.join(root, ".omx", "browser-probe", "node_modules", "playwright", "index.mjs");
  if (existsSync(local)) return import(pathToFileURL(local).href);
  return import("playwright");
}

function parseInputScript(script) {
  return String(script || "")
    .split(",")
    .map((entry, index) => {
      if (!entry.trim()) return null;
      const [action, secondText, ...keyParts] = entry.trim().split(":");
      const second = Number.parseFloat(secondText);
      const key = keyParts.join(":");
      if (!["down", "up"].includes(action) || !Number.isFinite(second) || !key) {
        throw new Error(`Invalid INPUT_SCRIPT entry "${entry}"`);
      }
      return { action, second, key, index };
    })
    .filter(Boolean)
    .sort((a, b) => a.second - b.second || a.index - b.index);
}

function safeKey(key) { return key.replace(/[^a-z0-9_-]+/gi, "_"); }

function parseArgs(argv) {
  const out = { headed: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--rom") out.rom = argv[++i];
    else if (a === "--duration") out.duration = Number(argv[++i]);
    else if (a === "--sample-ms") out.sampleMs = Number(argv[++i]);
    else if (a === "--shot-every") out.shotEvery = Number(argv[++i]);
    else if (a === "--base-url") out.baseUrl = argv[++i];
    else if (a === "--out-dir") out.outDir = argv[++i];
    else if (a === "--headed") out.headed = true;
    else throw new Error(`Unknown arg: ${a}`);
  }
  return out;
}
