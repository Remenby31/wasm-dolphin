// Multi-game boot-compatibility matrix.
//
// menu-progress-validate.mjs is a deep route validator for one reference game. This is
// the breadth counterpart: point it at a disc library and it boots every
// supported image in turn, samples the HUD, and classifies each one. The goal
// is a compatibility table, not a perf measurement — so runs are short and the
// input script is the generic "spam A + Start" that clears the GameCube IPL
// save dialog and most attract/title screens.
//
//   node tools/boot-matrix.mjs --library "F:/Games/Library/GameCube" --duration 45
//
// Env: BASE_URL, LIBRARY, DURATION, VIDEO, PRESENTER, HEADED=1, LIMIT, FILTER.
//
// Classification (worst → best):
//   mount-fail  the core never reported a mounted Dolphin disc
//   black       mounted, but the canvas never showed non-black pixels
//   stalled     pixels appeared but the core stopped advancing (coreFps ~0)
//   static      core advancing, picture not changing — parked on a dialog or
//               title waiting for an input the generic script does not send
//   boots       content changing and the core advancing for the whole run
//
// "boots" means it got through boot and kept running for the sample window. It
// is NOT a claim that the game is playable or correct — that needs eyes on the
// screenshots this writes next to the table.

import { mkdir, readdir, writeFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { reapStaleBrowsers } from "./reap-stale-browsers.mjs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const args = parseArgs(process.argv.slice(2));
const baseUrl = args.baseUrl || process.env.BASE_URL || "http://127.0.0.1:8083/";
const libraryDir = args.library || process.env.LIBRARY || "F:/Games/Library/GameCube";
const durationSeconds = args.duration ?? Number(process.env.DURATION || 45);
const mountTimeoutSeconds = args.mountTimeout ?? Number(process.env.MOUNT_TIMEOUT || 120);
const videoMode = process.env.VIDEO || "software";
const presenter = process.env.PRESENTER || "webgpu";
const headed = process.env.HEADED === "1" || args.headed;
const limit = args.limit ?? Number(process.env.LIMIT || 0);
const filter = (args.filter || process.env.FILTER || "").toLowerCase();
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = args.outDir
  ? path.resolve(args.outDir)
  : path.join(root, ".omx", "boot-matrix", stamp);

// Formats Dolphin's DiscIO can open directly. .zip is deliberately absent —
// the core mounts the file it is handed, it does not unpack archives, so a
// zipped dump has to be extracted before it can be tested.
const SUPPORTED = new Set([".iso", ".rvz", ".ciso", ".gcz", ".wia"]);

if (!existsSync(libraryDir)) throw new Error(`Missing library dir: ${libraryDir}`);

const discs = await collectDiscs(libraryDir);
const selected = discs
  .filter((d) => !filter || d.name.toLowerCase().includes(filter))
  .slice(0, limit > 0 ? limit : undefined);

if (selected.length === 0) throw new Error(`No supported disc images under ${libraryDir}`);

await mkdir(outDir, { recursive: true });
console.log(`[boot-matrix] ${selected.length} disc(s) · ${durationSeconds}s each · outDir=${outDir}`);

const { chromium } = await importPlaywright();
reapStaleBrowsers();
const browser = await chromium.launch({
  channel: process.env.BROWSER_CHANNEL || "chrome",
  headless: !headed,
  args: [
    "--autoplay-policy=no-user-gesture-required",
    "--enable-webgl",
    "--enable-unsafe-webgpu",
  ],
}).catch(async (error) => {
  console.warn(`[boot-matrix] chrome channel failed (${error.message}); using bundled chromium`);
  return chromium.launch({ headless: !headed });
});

const results = [];
for (const [index, disc] of selected.entries()) {
  const label = `${index + 1}/${selected.length}`;
  console.log(`[boot-matrix] ${label} ${disc.name} (${formatBytes(disc.size)})`);
  const result = await runOne(disc, index);
  results.push(result);
  console.log(`[boot-matrix] ${label} → ${result.verdict}` +
    `${result.gameTitle ? ` · ${result.gameTitle}` : ""}` +
    `${result.gameId ? ` · ${result.gameId}` : ""}` +
    ` · hashes=${result.distinctHashes} coreFps=${result.medianCoreFps} speed=${result.medianGameSpeed}%` +
    `${result.error ? ` · ${result.error}` : ""}`);
  await writeReport(); // incremental — a crash mid-run still leaves a usable table
}

await browser.close();
await writeReport();
console.log(`\n[boot-matrix] done. Report: ${path.join(outDir, "results.md")}`);
printSummary();

// --- per-disc run ------------------------------------------------------

async function runOne(disc, index) {
  const slug = `${String(index + 1).padStart(2, "0")}-${safeSlug(disc.name)}`;
  const shotDir = path.join(outDir, slug);
  await mkdir(shotDir, { recursive: true });

  const consoleLines = [];
  const samples = [];
  const hashes = new Set();
  const result = {
    file: disc.file,
    name: disc.name,
    ext: disc.ext,
    sizeBytes: disc.size,
    slug,
    verdict: "mount-fail",
    error: "",
    gameTitle: "",
    gameId: "",
    mountMs: null,
    firstVisibleMs: null,
    distinctHashes: 0,
    medianCoreFps: 0,
    medianGameSpeed: 0,
    sampleCount: 0,
  };

  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on("console", (m) => consoleLines.push(`[${m.type()}] ${m.text()}`));
  page.on("pageerror", (e) => consoleLines.push(`[pageerror] ${e.stack || e.message}`));
  const seen = new WeakSet();
  const attachWorker = (w) => {
    if (seen.has(w)) return;
    seen.add(w);
    const tag = `worker:${w.url()?.split("/").pop() || "?"}`;
    w.on("console", (m) => consoleLines.push(`[${tag}:${m.type()}] ${m.text()}`));
    w.on("pageerror", (e) => consoleLines.push(`[${tag}:pageerror] ${e.stack || e.message}`));
  };
  page.on("worker", attachWorker);

  try {
    await page.goto(buildUrl(disc).href, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.evaluate(() => {
      const panel = document.querySelector("#debugPanel");
      if (panel?.hidden) document.querySelector("#debugToggle")?.click();
    });

    // The page must have finished wiring its own event listeners before the
    // ROM goes in. index.html loads src/bootstrap.js, which reaches app.js
    // through a top-level await, so app.js evaluates AFTER domcontentloaded
    // and wireFileMounting() has not yet attached the #romInput change
    // handler when the navigation resolves. Uploading into that gap fires a
    // change event at no listener: the input holds the file, nothing reads it,
    // and the run dies 120s later on a mount timeout with an empty console and
    // "No file" still on screen.
    await waitForAppReady(page);

    const t0 = Date.now();
    await page.setInputFiles("#romInput", disc.file);
    await page.click("#screen");
    await waitForMount(page, mountTimeoutSeconds);
    result.mountMs = Date.now() - t0;

    // Time-to-first-pixels, separate from "core mounted". A disc that mounts
    // but never brightens the canvas is the "black" verdict, and telling the
    // two apart is the whole point of sampling this before the run proper.
    for (let attempt = 0; attempt < 40; attempt++) {
      if (await isBright(page)) { result.firstVisibleMs = Date.now() - t0; break; }
      await page.waitForTimeout(500);
    }

    const inputScript = makeBootInputScript(durationSeconds);
    const pending = inputScript.map((e) => ({ ...e, sent: false }));
    const runStart = Date.now();
    let nextShot = 0;
    for (let second = 0; second <= durationSeconds; second++) {
      const elapsed = (Date.now() - runStart) / 1000;
      for (const event of pending) {
        if (event.sent || event.second > elapsed) continue;
        event.sent = true;
        if (event.action === "down") await page.keyboard.down(event.key);
        else await page.keyboard.up(event.key);
      }
      const sample = await readSample(page, elapsed);
      samples.push(sample);
      if (sample.visibleHash) hashes.add(sample.visibleHash);
      if (sample.gameTitle && !result.gameTitle) result.gameTitle = sample.gameTitle;
      const idMatch = /\b([A-Z0-9]{6})\b/.exec(sample.mountNote || "");
      if (idMatch && !result.gameId) result.gameId = idMatch[1];
      if (elapsed >= nextShot) {
        const tag = String(Math.round(elapsed)).padStart(3, "0");
        // Two shots per checkpoint, because they answer different questions.
        // The full page carries the HUD counters, which is what you want when
        // a verdict looks wrong. The canvas crop is the game itself, with none
        // of the surrounding UI — that is the one to read when checking
        // whether a game that "boots" is actually rendering correctly rather
        // than throwing up garbled geometry, and the heuristics cannot tell
        // those apart.
        await page.screenshot({ path: path.join(shotDir, `page-t${tag}.png`) });
        await captureCanvas(page, path.join(shotDir, `canvas-t${tag}.png`));
        nextShot += Math.max(5, Math.round(durationSeconds / 6));
      }
      await page.waitForTimeout(1000);
    }
    await page.screenshot({ path: path.join(shotDir, "zz-page-final.png") });
    await captureCanvas(page, path.join(shotDir, "zz-canvas-final.png"));

    result.sampleCount = samples.length;
    result.distinctHashes = hashes.size;
    result.medianCoreFps = round1(median(samples.map((s) => numeric(s.coreFps))));
    result.medianGameSpeed = round1(median(samples.map((s) => numeric(s.gameSpeed))));
    result.verdict = classify(result, samples);
  } catch (error) {
    result.error = String(error.message || error).split("\n")[0];
    try { await page.screenshot({ path: path.join(shotDir, "zz-error.png") }); } catch {}
    await captureCanvas(page, path.join(shotDir, "zz-canvas-error.png"));
  } finally {
    await writeFile(path.join(shotDir, "console.log"), consoleLines.join("\n"), "utf8");
    await writeFile(path.join(shotDir, "samples.json"), JSON.stringify(samples, null, 2), "utf8");
    await page.close().catch(() => {});
  }
  return result;
}

// Verdict from the sample window. Ordered worst-first so the first matching
// condition wins; each one is a distinct failure the screenshots can confirm.
function classify(result, samples) {
  if (result.firstVisibleMs == null) return "black";
  // Whether the core is advancing is the load-bearing check, and it has to be
  // asked BEFORE "is the picture changing". The two disagree in both
  // directions: the presenter happily repaints a stale XFB after the CPU
  // thread has died (moving picture, dead core), and a game parked on a
  // memory-card dialog or a "press start" screen holds one frame while running
  // perfectly (static picture, healthy core). Judging on pixels first
  // mislabels the second case as a freeze — which it did to a life sim at
  // 58 core fps / 97% speed.
  if (result.medianCoreFps < 1) return "stalled";
  // Boot animations legitimately hold a still frame for a few seconds, so this
  // is judged over the last half of the run, not any single stretch.
  const tail = samples.slice(Math.floor(samples.length / 2));
  const tailHashes = new Set(tail.map((s) => s.visibleHash).filter(Boolean));
  // Alive but not animating. Usually a dialog or title waiting on an input the
  // generic script does not produce, so it is a "look at the screenshot"
  // result rather than a failure.
  if (tailHashes.size <= 2) return "static";
  return "boots";
}

// --- page helpers ------------------------------------------------------

function buildUrl(disc) {
  const url = new URL(baseUrl);
  url.searchParams.set("core", "upstream");
  url.searchParams.set("video", videoMode);
  url.searchParams.set("presenter", presenter);
  url.searchParams.set("cpu", process.env.CPU || "dual");
  url.searchParams.set("speed", process.env.SPEED || "1");
  url.searchParams.set("pacing", process.env.PACING || "tick");
  url.searchParams.set("present", process.env.PRESENT || "full");
  url.searchParams.set("wasmjit", process.env.WASMJIT ?? "1");
  url.searchParams.set("jittier", process.env.JITTIER || "guarded");
  url.searchParams.set("jitwarmup", process.env.JITWARMUP || "700");
  url.searchParams.set("queue", process.env.QUEUE_SIZE || "4");
  url.searchParams.set("oc", process.env.OC || "1");
  url.searchParams.set("fastsw", process.env.FASTSW || "1");
  url.searchParams.set("metrics", "1");
  // Optional passthroughs used by the diagnosis docs. CORELOG forwards
  // Dolphin's own ERROR/WARN output to the browser console (?corelog=1),
  // which the renderer bug notes rely on; FASTSW selects the software
  // rasteriser quality tier and is meaningless on video=wgpu.
  if (process.env.CORELOG) url.searchParams.set("corelog", process.env.CORELOG);
  if (process.env.JITVERBOSE) url.searchParams.set("jitverbose", process.env.JITVERBOSE);
  if (process.env.DISABLE) url.searchParams.set("disable", process.env.DISABLE);
  if (process.env.NOJITCACHE) url.searchParams.set("nojitcache", process.env.NOJITCACHE);
  if (process.env.WGPUVISUAL) url.searchParams.set("wgpuvisual", process.env.WGPUVISUAL);
  url.searchParams.set("probe", `boot-matrix-${safeSlug(disc.name)}`);
  return url;
}

// Wait until the page's own scripts have run. index.html ships #statusPill as
// the literal text "Booting"; app.js replaces it once it evaluates, so a pill
// that still says Booting means the file-mount listener is not attached yet.
// Falling through after the timeout is deliberate — a page that never reports
// ready should fail as a mount timeout with its console captured, not as a
// separate error here.
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

async function waitForMount(page, timeoutSeconds) {
  for (let second = 0; second <= timeoutSeconds; second++) {
    const state = await page.evaluate(() => ({
      coreMode: document.querySelector("#coreMode")?.textContent?.trim() ?? "",
      mountNote: document.querySelector("#mountNote")?.textContent?.trim() ?? "",
      status: document.querySelector("#statusPill")?.textContent?.trim() ?? "",
    }));
    if (state.coreMode === "Dolphin" && state.mountNote.includes("Dolphin")) return;
    // "jit-cache: ..." is an optional prewarm step reporting on itself; the
    // worker already returns 0 and boots without it. Its text contains
    // "failed"/"unsupported", which used to abort the run as a mount
    // failure -- intermittently, since it depends on sampling that brief
    // status window. That is the "mount flakiness" in issue #10.
    if (!/^jit-cache:/i.test(state.status) &&
        (/failed|error|unsupported/i.test(state.status) || /^Dolphin adapter fallback:/i.test(state.status))) {
      throw new Error(`Mount failed: ${state.status}`);
    }
    await page.waitForTimeout(1000);
  }
  throw new Error(`Timed out waiting for Dolphin mount (${timeoutSeconds}s)`);
}

// Element screenshot of the emulator canvas alone. Playwright screenshots a
// canvas as its composited pixels, so this is what the game actually drew.
// Never let a capture failure end a run — a missing crop is worth less than
// the rest of the samples.
async function captureCanvas(page, file) {
  try {
    await page.locator("#screen").screenshot({ path: file });
    return true;
  } catch {
    return false;
  }
}

async function isBright(page) {
  return page.evaluate(() => {
    const screen = document.querySelector("#screen");
    if (!screen) return false;
    const c = document.createElement("canvas");
    c.width = 32; c.height = 24;
    const ctx = c.getContext("2d", { alpha: false, willReadFrequently: true });
    try {
      ctx.drawImage(screen, 0, 0, c.width, c.height);
      const bytes = ctx.getImageData(0, 0, c.width, c.height).data;
      let bright = 0;
      for (let i = 0; i < bytes.length; i += 4) {
        if (bytes[i] > 16 || bytes[i + 1] > 16 || bytes[i + 2] > 16) bright++;
      }
      return bright > 5;
    } catch { return false; }
  });
}

async function readSample(page, elapsedSeconds) {
  return page.evaluate((elapsed) => {
    // The HUD ids are not stable across branches: the counters were renamed
    // from "<metric>Counter" to "hud<Metric>". Read whichever exists so one
    // harness measures both and the comparison stays apples-to-apples.
    // Missing ids read as "" and become 0, which silently reports a running
    // game as a dead core — that is exactly what a stale id looks like.
    const read = (...sels) => {
      for (const sel of sels) {
        const text = document.querySelector(sel)?.textContent?.trim();
        if (text) return text;
      }
      return "";
    };
    const screen = document.querySelector("#screen");
    const state = (window.__bootMatrixState ??= { canvas: document.createElement("canvas"), context: null });
    state.canvas.width = 64;
    state.canvas.height = 48;
    state.context ??= state.canvas.getContext("2d", { alpha: false, willReadFrequently: true });
    let visibleHash = 0;
    try {
      state.context.drawImage(screen, 0, 0, 64, 48);
      const bytes = state.context.getImageData(0, 0, 64, 48).data;
      let h = 2166136261;
      for (let i = 0; i < bytes.length; i += 4) {
        h ^= bytes[i]; h = Math.imul(h, 16777619);
        h ^= bytes[i + 1]; h = Math.imul(h, 16777619);
        h ^= bytes[i + 2]; h = Math.imul(h, 16777619);
      }
      visibleHash = h | 0;
    } catch { visibleHash = 0; }
    // app.js publishes the same numbers it renders into the HUD on
    // window.__lastFrameInfo, as structured values rather than formatted text.
    // Prefer it: it survives HUD markup changes, and it is the field the
    // existing menu-progress validator already reads.
    const info = window.__lastFrameInfo || {};
    const pick = (value, ...sels) =>
      (value == null || value === "" ? read(...sels) : String(value));

    return {
      elapsedSeconds: elapsed,
      frame: pick(info.frame, "#frameCounter", "#hudFrame"),
      coreFps: pick(info.coreFps, "#coreFpsCounter", "#hudCoreFps"),
      visualFps: pick(info.visualChangeFps, "#visualFpsCounter", "#hudVisualFps"),
      gameSpeed: pick(info.gameSpeed, "#gameSpeedCounter", "#hudSpeed"),
      presentFps: pick(info.presentationFps ?? info.fps, "#fpsCounter", "#hudFps"),
      hasFrameInfo: Boolean(window.__lastFrameInfo),
      infoKeys: Object.keys(info).slice(0, 40),
      // JIT engagement. The slow titles turn out to compile almost no blocks
      // and run interpreted, so these belong in every sample, not just in a
      // one-off probe.
      jitCompiled: info.ppcWasmBlockCompileCount ?? null,
      jitBlockRuns: info.ppcWasmBlockRunCount ?? null,
      jitHelper: typeof info.ppcWasmHelperStats === "string"
        ? info.ppcWasmHelperStats.slice(0, 6000) : null,
      gameTitle: read("#gameTitle"),
      mountNote: read("#mountNote"),
      statusPill: read("#statusPill", "#hudStatus"),
      visibleHash,
    };
  }, elapsedSeconds);
}

// Generic boot input: alternate A (x) and Start (Enter) every 2s. That is
// enough to clear the IPL "no memory card" dialog, skip attract loops, and
// press through a title screen on every retail GameCube title — which is all
// this harness needs. Game-specific routes belong in a per-game script.
function makeBootInputScript(seconds) {
  const events = [];
  for (let t = 3, i = 0; t <= seconds; t += 2, i++) {
    const key = i % 2 === 0 ? "x" : "Enter";
    events.push({ action: "down", second: t, key });
    events.push({ action: "up", second: t + 0.5, key });
  }
  return events;
}

// --- reporting ---------------------------------------------------------

async function writeReport() {
  await writeFile(path.join(outDir, "results.json"), JSON.stringify({
    generatedAt: new Date().toISOString(),
    baseUrl, libraryDir, durationSeconds, videoMode, presenter,
    results,
  }, null, 2), "utf8");

  const rows = results.map((r) => `| ${r.name} | ${r.ext} | ${r.verdict} | ` +
    `${r.gameId || "—"} | ${r.gameTitle || "—"} | ${r.mountMs ?? "—"} | ` +
    `${r.distinctHashes} | ${r.medianCoreFps} | ${r.medianGameSpeed} | ${r.error || ""} |`);

  const md = [
    `# Boot matrix — ${new Date().toISOString().slice(0, 10)}`,
    "",
    `Library: \`${libraryDir}\` · ${durationSeconds}s per disc · ` +
      `\`video=${videoMode}&presenter=${presenter}\``,
    "",
    "`boots` = content kept changing and the core kept advancing for the whole",
    "sample window. It is not a playability claim — check the screenshots.",
    "",
    "| Game | Fmt | Verdict | ID | Title | Mount ms | Hashes | Core fps | Speed % | Error |",
    "| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | --- |",
    ...rows,
    "",
    "## Tally",
    "",
    ...tally().map(([verdict, count]) => `- **${verdict}**: ${count}`),
  ].join("\n");
  await writeFile(path.join(outDir, "results.md"), md, "utf8");
}

function tally() {
  const counts = new Map();
  for (const r of results) counts.set(r.verdict, (counts.get(r.verdict) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function printSummary() {
  console.log("\n[boot-matrix] tally:");
  for (const [verdict, count] of tally()) console.log(`  ${verdict.padEnd(11)} ${count}`);
}

// --- library scan ------------------------------------------------------

// One level of nesting: dumps are commonly either loose files or a per-game
// folder holding a single image. Deeper trees are not scanned.
async function collectDiscs(dir) {
  const found = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const inner = await readdir(full, { withFileTypes: true }).catch(() => []);
      for (const child of inner) {
        if (child.isFile() && SUPPORTED.has(path.extname(child.name).toLowerCase())) {
          found.push(await describe(path.join(full, child.name)));
        }
      }
      continue;
    }
    if (entry.isFile() && SUPPORTED.has(path.extname(entry.name).toLowerCase())) {
      found.push(await describe(full));
    }
  }
  // Libraries accumulate the same image in more than one place — loose, in a
  // per-game folder, and again inside an extracted archive. Testing a byte-
  // identical dump twice costs a full run and tells us nothing, so collapse on
  // (filename, size); a genuine alternate revision differs in at least one.
  const byIdentity = new Map();
  for (const disc of found) {
    const key = `${disc.name.toLowerCase()} ${disc.size}`;
    const existing = byIdentity.get(key);
    if (!existing) { byIdentity.set(key, disc); continue; }
    existing.duplicatePaths ??= [];
    existing.duplicatePaths.push(disc.file);
  }
  return [...byIdentity.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function describe(file) {
  const info = await stat(file);
  return {
    file,
    name: path.basename(file),
    // .nkit.iso and friends carry a compound suffix; report the real one so the
    // table distinguishes a plain ISO from an NKit-shrunk one.
    ext: /\.nkit\.iso$/i.test(file) ? ".nkit.iso" : path.extname(file).toLowerCase(),
    size: info.size,
  };
}

// --- small utils -------------------------------------------------------

function numeric(text) {
  const n = Number.parseFloat(String(text).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function round1(n) { return Math.round(n * 10) / 10; }

function formatBytes(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
}

function safeSlug(name) {
  return name.replace(/\.[^.]+$/, "").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
}

async function importPlaywright() {
  const local = path.join(root, ".omx", "browser-probe", "node_modules", "playwright", "index.mjs");
  if (existsSync(local)) return import(pathToFileURL(local).href);
  return import("playwright");
}

function parseArgs(argv) {
  const out = { headed: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--library") out.library = argv[++i];
    else if (a === "--duration") out.duration = Number(argv[++i]);
    else if (a === "--mount-timeout") out.mountTimeout = Number(argv[++i]);
    else if (a === "--base-url") out.baseUrl = argv[++i];
    else if (a === "--out-dir") out.outDir = argv[++i];
    else if (a === "--limit") out.limit = Number(argv[++i]);
    else if (a === "--filter") out.filter = argv[++i];
    else if (a === "--headed") out.headed = true;
    else throw new Error(`Unknown arg: ${a}`);
  }
  return out;
}
