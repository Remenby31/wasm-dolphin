// Paired A/B performance comparison.
//
// Why this exists: single-run comparisons on this project are worthless. The
// same title measured 32-35% early in a session and 26-28% later on
// byte-identical builds, and within-config spread on one binary was 26-35%.
// A 1-2% optimisation cannot be seen through that, which made micro-
// optimisation unfalsifiable rather than merely hard.
//
// What fixes it is not more runs -- it is PAIRING. Run A and B back-to-back as
// a pair, compute the difference WITHIN each pair, then take the median of the
// differences. Machine drift moves both halves of a pair together and cancels;
// only the treatment effect survives. Group means do not have this property,
// which is why the earlier A/B tables were misleading.
//
// Usage:
//   node tools/perf-ab.mjs --filter "<title substring>" \
//     --a "" --b "DISABLE=0x800000" --pairs 5 [--duration 40]
//
// --a and --b are space-separated ENV assignments applied to boot-matrix. The
// only difference between the two arms should be the thing under test.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

function parseArgs(argv) {
  const out = {
    pairs: 5, duration: 40, a: "", b: "", library: "F:/Games/Library/GameCube",
    // Was 8, derived from an 18-run curve that swung 29.1% before settling.
    // That curve was measured with the shared profile on, and the shared
    // profile was itself the fault, so the "settling transient" it described
    // was largely an artifact. Re-measured with the profile off, the same
    // fixture settles to 2.0% within 8 runs on a much flatter curve, and 4 is
    // enough to clear the opening spread. Raise it if a self-test on your host
    // still shows drift.
    warmup: 4, metric: "frames", selftest: false, persist: false,
    gpuRecoverySeconds: 90,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--filter") out.filter = argv[++i];
    else if (k === "--a") out.a = argv[++i];
    else if (k === "--b") out.b = argv[++i];
    else if (k === "--pairs") out.pairs = Number(argv[++i]);
    else if (k === "--duration") out.duration = Number(argv[++i]);
    else if (k === "--library") out.library = argv[++i];
    else if (k === "--video") out.video = argv[++i];
    else if (k === "--presenter") out.presenter = argv[++i];
    else if (k === "--expect-adapter") out.expectAdapter = argv[++i];
    else if (k === "--gpu-recovery-seconds") out.gpuRecoverySeconds = Number(argv[++i]);
    else if (k === "--rom") out.rom = argv[++i];
    else if (k === "--save-state") out.saveState = argv[++i];
    else if (k === "--state-at") out.stateAt = argv[++i];
    else if (k === "--base-url") out.baseUrl = argv[++i];
    else if (k === "--retries") out.retries = Number(argv[++i]);
    else if (k === "--warmup") out.warmup = Number(argv[++i]);
    else if (k === "--metric") out.metric = argv[++i];
    else if (k === "--selftest") out.selftest = true;
    else if (k === "--no-persist") out.persist = false;
    else if (k === "--persist") out.persist = true;
    else throw new Error(`Unknown arg: ${k}`);
  }
  if (!out.filter) throw new Error("--filter is required");
  if (!["frames", "speed"].includes(out.metric))
    throw new Error(`--metric must be frames or speed, got ${out.metric}`);
  // A/A: both arms are the control, so anything it reports is this rig's noise
  // rather than an effect. Refuse a --b that would quietly make that untrue.
  if (out.selftest) {
    if (out.b && out.b !== out.a)
      throw new Error("--selftest compares A against A; do not also pass --b");
    out.b = out.a;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

// Git Bash (MSYS) rewrites a leading-slash argument into a Windows path before
// node ever sees it, so `--save-state /__race.sav` silently arrived as
// "C:/Program Files/Git/__race.sav". The page then fetched that string and
// reported "Failed to fetch", which looked like a server or COEP problem and
// was neither. Accept a bare name and build the URL here.
let saveStateUrl = "";
if (args.saveState) {
  if (/^[A-Za-z]:[\/]/.test(args.saveState)) {
    throw new Error(
      `--save-state looks like a local path (${args.saveState}). Pass just the ` +
      `served name, e.g. --save-state __race.sav (no leading slash: Git ` +
      `Bash rewrites it into a Windows path).`
    );
  }
  const base = args.baseUrl || "http://127.0.0.1:8082/";
  saveStateUrl = new URL(args.saveState.replace(/^\/+/, ""), base).href;
  console.log(`[perf-ab] save state: ${saveStateUrl}`);
}

// Sharing one browser profile across runs was tried, to let the JIT cache in
// the origin's IndexedDB warm up instead of starting cold every run. It broke
// the rig, and badly enough that it is now OFF by default.
//
// Chrome single-instances a profile with a SingletonLock. Once any run failed
// to release it, every later launch against that directory failed too, and the
// lock outlived them all -- it only went away when the whole process tree
// exited. That is the collapse that cost four debugging sessions: about ten
// good runs, then nothing, with a GPU that answered normally again the instant
// perf-ab was killed. It was diagnosed as Xvfb churn, then file descriptors,
// then NVIDIA Xid faults, and it was none of those.
//
// Measured back to back on the same host: with the profile shared, 28 of 30
// runs discarded and no usable pairs; without it, 14 runs, zero discards, a
// +/-0.7% self-test, and no new Xid faults at all.
//
// --persist re-enables it. Do not, unless the SingletonLock behaviour has been
// dealt with first.
const persistDir = args.persist
  ? mkdtempSync(path.join(tmpdir(), "perfab-profile-"))
  : null;

// menu-progress-validate defaults the presenter to webgl for every video mode
// except software. Leaving it unset therefore measured video=wgpu with the GL
// presenter -- a different path from the hardware one this project profiles --
// and the run looked perfectly healthy while doing it: an A/A self-test came
// back at 3596 frames/60s, which is the SOFTWARE figure, against a hardware
// baseline near 1790. Set it explicitly, and verify it afterwards.
function envFrom(spec) {
  const env = {
    ...process.env,
    VIDEO: args.video || "wgpu",
    PRESENTER: args.presenter || "webgpu",
  };
  if (args.baseUrl) env.BASE_URL = args.baseUrl;
  if (persistDir) env.PROBE_PERSIST_DIR = persistDir;
  for (const tok of spec.split(/\s+/).filter(Boolean)) {
    const eq = tok.indexOf("=");
    if (eq < 0) throw new Error(`Bad env token: ${tok}`);
    env[tok.slice(0, eq)] = tok.slice(eq + 1);
  }
  return env;
}

// What the run ACHIEVED, as opposed to what it asked for. Checking the URL is
// not enough: on a headless Linux box with an RTX 3090, GPU acquisition under
// Xvfb is intermittent, and a run that loses it still requests
// video=wgpu&presenter=webgpu and still finishes. One such run scored 3602
// frames/60s against a ~1530 GPU cluster -- within 0.15% of this project's
// known software figure. The URL check passed it.
//
// Returns null when the run is fine, or a short reason to discard it. It is a
// discard rather than a hard failure because the loss is intermittent: the
// retry loop should get a good run, and the count is reported at the end so a
// host that keeps losing the GPU is visible rather than silently averaged in.
const discardedBackend = [];

// Count NVIDIA Xid faults the kernel has logged. Best effort: dmesg is often
// restricted to root, and this is a Linux/NVIDIA-only signal, so an unreadable
// or absent log means "cannot tell", never "no faults".
function gpuFaultCount() {
  try {
    const out = execFileSync("dmesg", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return (out.match(/Xid /g) || []).length;
  } catch {
    return null;
  }
}

// A faulted GPU channel does not recover instantly, and retrying into it just
// burns runs. This host logged NVRM Xid 32 -- "invalid or corrupted push buffer
// stream" -- from both chrome and the emulator worker thread, and every launch
// after a fault returned a null adapter until the machine had been left alone
// for a while. Retries were therefore spending four attempts each against a
// channel that could not answer, which is how a session lost 28 runs.
function sleepSeconds(seconds) {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, seconds * 1000);
}

function achievedBackendProblem(dir, expectAdapter) {
  let diag;
  try {
    diag = JSON.parse(readFileSync(path.join(dir, "renderer-diagnostics.json"), "utf8"));
  } catch {
    return null; // Nothing to check against; do not invent a failure.
  }
  const adapter = diag.adapter;
  if (adapter && adapter.isFallbackAdapter) return "fallback adapter";
  if (expectAdapter) {
    const vendor = String(adapter?.vendor ?? "");
    if (!vendor) return "no adapter reported";
    if (!vendor.toLowerCase().includes(expectAdapter.toLowerCase()))
      return `adapter vendor "${vendor}" != expected "${expectAdapter}"`;
  }
  return null;
}

// Read back what the run actually launched and compare it against what was
// requested. A mismatch throws rather than returning a number, because the
// failure mode being guarded against is a plausible-looking result from the
// wrong backend, not a crash.
function assertRunConfiguration(dir, env) {
  let url;
  try {
    const meta = JSON.parse(readFileSync(path.join(dir, "run-metadata.json"), "utf8"));
    url = meta.url;
  } catch {
    return; // No metadata to check against; do not invent a failure.
  }
  if (!url) return;
  const params = new URL(url).searchParams;
  for (const [key, expected] of [["video", env.VIDEO], ["presenter", env.PRESENTER]]) {
    const actual = params.get(key);
    if (expected && actual !== expected) {
      const error = new Error(
        `run used ${key}=${actual} but ${key}=${expected} was requested. ` +
        `The measurement would have been of the wrong backend.`
      );
      error.wrongConfiguration = true;
      throw error;
    }
  }
}

// Fixed-scene measurement. A save state pins the workload: every run measures
// the SAME frames, which removes the dominant variance source. Without it each
// run samples whatever the attract mode happened to be showing, which is why
// within-config spread was 26-35% even on one binary. Input is disabled so the
// scene cannot drift after the state loads.
function measureFixedScene(spec) {
  const dir = mkdtempSync(path.join(tmpdir(), "perfab-"));
  try {
    const env = envFrom(spec);
    env.ROM = args.rom;
    env.SAVE_STATE_URL = saveStateUrl;
    env.SAVE_STATE_AT = args.stateAt || "35";
    env.INPUT_SCRIPT = "none";
    env.DURATION = String(args.duration);
    env.CAPTURE_SCREENSHOTS = "0";
    const out = execFileSync(process.execPath,
      ["tools/menu-progress-validate.mjs", "--out-dir", dir],
      { env, stdio: "pipe", maxBuffer: 64 * 1024 * 1024 }).toString();
    // Confirm the run measured the configuration that was asked for. This is
    // not paranoia: the presenter default silently produced a whole self-test
    // against the wrong backend, and every number in it looked plausible. A
    // benchmark that measures the wrong thing quietly is worse than one that
    // fails.
    assertRunConfiguration(dir, env);
    const backendProblem = achievedBackendProblem(dir, args.expectAdapter);
    if (backendProblem) {
      discardedBackend.push(backendProblem);
      return null;
    }
    // Score only the post-load tail, so the pre-state boot is excluded.
    const samples = JSON.parse(readFileSync(path.join(dir, "samples.json"), "utf8"));
    const scored = (samples.samples || samples)
      .filter((x) => Number(x.elapsedSeconds) > Number(env.SAVE_STATE_AT) + 5);
    if (scored.length < 5) return null;
    if (args.metric === "frames") {
      // Emulated frames advanced across the scored window, normalised to a
      // per-second rate so runs of different length stay comparable. This is
      // the emulator's own counter over a fixed span, which is steadier than
      // the median of per-second game-speed samples: one stalled second moves
      // the median, but only its own frames leave the total.
      const first = scored[0];
      const last = scored[scored.length - 1];
      const dFrames = Number(last.frame) - Number(first.frame);
      const dSeconds = Number(last.elapsedSeconds) - Number(first.elapsedSeconds);
      if (!Number.isFinite(dFrames) || !(dSeconds > 0) || dFrames <= 0) return null;
      return (dFrames / dSeconds) * 60;
    }
    // gameSpeed is a STRING with a percent sign ("99%"), so Number() gives
    // NaN and every row silently drops. That produced "fail" for a run that
    // had 46 good samples.
    const rows = scored
      .map((x) => Number.parseFloat(String(x.gameSpeed)))
      .filter((n) => Number.isFinite(n));
    if (rows.length < 5) return null;
    return median(rows);
  } catch (e) {
    // A run that failed to produce samples is a discarded measurement and the
    // retry loop handles it. A run that measured the wrong backend is not: it
    // would be retried, fail identically, and end up reported as flakiness.
    // Let that one out.
    if (e?.wrongConfiguration) throw e;
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// One measurement. Returns median game speed for the run, or null if the run
// did not produce a usable sample -- a failed mount must not be scored as 0.
function measure(spec) {
  if (args.saveState) return measureFixedScene(spec);
  const dir = mkdtempSync(path.join(tmpdir(), "perfab-"));
  try {
    execFileSync(process.execPath,
      ["tools/boot-matrix.mjs", "--library", args.library, "--filter", args.filter,
       "--duration", String(args.duration), "--out-dir", dir],
      { env: envFrom(spec), stdio: "pipe", maxBuffer: 64 * 1024 * 1024 });
    const results = JSON.parse(readFileSync(path.join(dir, "results.json"), "utf8"));
    const rows = results.results || results;
    const row = rows[0];
    if (!row || row.verdict === "mount-fail" || !Number.isFinite(Number(row.medianGameSpeed)))
      return null;
    return Number(row.medianGameSpeed);
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function median(xs) {
  const s = [...xs].sort((p, q) => p - q);
  const n = s.length;
  if (!n) return null;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

const unit = args.metric === "frames" ? "frames/60s" : "%";
console.log(
  `[perf-ab] ${args.filter}  pairs=${args.pairs} duration=${args.duration}s ` +
  `metric=${args.metric} warmup=${args.warmup} persist=${persistDir ? "on" : "off"}`
);
console.log(
  `[perf-ab] backend: video=${args.video || "wgpu"} presenter=${args.presenter || "webgpu"} ` +
  `(verified against each run)`
);
if (args.selftest) {
  console.log("[perf-ab] SELF-TEST: both arms are identical. Anything reported below");
  console.log("[perf-ab] is this rig's noise, not an effect.");
}
console.log(`[perf-ab] A: ${args.a || "(baseline)"}`);
console.log(`[perf-ab] B: ${args.b || "(baseline)"}`);

// Discarded measurements, until the rig settles. The first several runs of a
// session swing far too widely to score -- see the note on the warmup default
// for the curve this number comes from. They are printed anyway: if they have
// not flattened out by the last one or two, the pairs that follow are being
// measured on a rig that is still moving, and the run should be treated with
// suspicion no matter how tidy its verdict looks.
const warmupValues = [];
for (let w = 1; w <= args.warmup; w++) {
  const v = measure(args.a);
  if (v != null) warmupValues.push(v);
  console.log(`  warmup ${w}: ${v == null ? "fail" : v.toFixed(1)} ${unit} (discarded)`);
}
if (warmupValues.length >= 3) {
  const tail = warmupValues.slice(-3);
  const tailMean = tail.reduce((s, x) => s + x, 0) / tail.length;
  const tailSpread = ((Math.max(...tail) - Math.min(...tail)) / tailMean) * 100;
  console.log(`  warmup settled to within ${tailSpread.toFixed(1)}% over the last 3`);
  if (tailSpread > 8) {
    console.log(
      `  WARNING: still moving by ${tailSpread.toFixed(1)}% at the end of warmup. ` +
      `Raise --warmup, or check for other load on this machine.`
    );
  }
}

const diffs = [];
const aVals = [];
const bVals = [];
let discarded = 0;

for (let i = 1; i <= args.pairs; i++) {
  // Alternate which arm runs first, so any within-pair ordering effect
  // (cache warmth, thermal ramp) does not bias one arm systematically.
  const aFirst = i % 2 === 1;
  // Disc mounts are intermittently flaky on large images. Retry rather than
  // discard, so a transient mount failure does not quietly shrink the sample.
  const attempt = (spec) => {
    const tries = Number.isFinite(args.retries) ? args.retries : 2;
    for (let t = 0; t <= tries; t++) {
      const discardsBefore = discardedBackend.length;
      const faultsBefore = gpuFaultCount();
      const v = measure(spec);
      if (v != null) return v;
      // Only back off when the run actually lost the backend. An ordinary
      // failed run -- a flaky mount, say -- should be retried at once.
      const lostBackend = discardedBackend.length > discardsBefore;
      if (lostBackend && t < tries) {
        const faultsAfter = gpuFaultCount();
        const newFaults =
          faultsBefore != null && faultsAfter != null ? faultsAfter - faultsBefore : null;
        const wait = args.gpuRecoverySeconds;
        console.log(
          `    backend lost` +
          (newFaults ? ` (${newFaults} new GPU Xid fault(s) logged)` : "") +
          `; waiting ${wait}s for the driver to recover before retrying`
        );
        sleepSeconds(wait);
      }
    }
    return null;
  };
  const first = aFirst ? attempt(args.a) : attempt(args.b);
  const second = aFirst ? attempt(args.b) : attempt(args.a);
  const a = aFirst ? first : second;
  const b = aFirst ? second : first;
  if (a == null || b == null) {
    discarded++;
    console.log(`  pair ${i}: DISCARDED (a=${a ?? "fail"} b=${b ?? "fail"})`);
    continue;
  }
  aVals.push(a); bVals.push(b); diffs.push(b - a);
  const pct = a !== 0 ? ((b - a) / a) * 100 : 0;
  console.log(
    `  pair ${i}: a=${a.toFixed(1)}  b=${b.toFixed(1)}  ` +
    `b-a=${(b - a).toFixed(1)} ${unit} (${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%)`
  );
}

if (!diffs.length) {
  console.log("[perf-ab] no usable pairs");
  process.exit(1);
}

const md = median(diffs);
const lo = Math.min(...diffs);
const hi = Math.max(...diffs);
const sameSign = diffs.every((d) => d > 0) || diffs.every((d) => d < 0);

const aMed = median(aVals);
// Half the spread of the paired differences, as a share of the control. Two
// arms that differ by less than this cannot be told apart by this many pairs,
// so it is the number to quote as "what this rig can resolve today".
// Half the spread of the paired differences, as a share of the control -- but
// only once there are enough pairs for a spread to mean anything. Over one pair
// the range is a single point, so this reads +/-0.0%: a rig that had just thrown
// away 28 of 30 runs announced perfect precision. Two pairs is barely better.
// Below MIN_RESOLUTION_PAIRS the honest answer is that the question was not
// asked enough times, so say that instead of printing a number.
const MIN_RESOLUTION_PAIRS = 3;
const resolutionKnown = diffs.length >= MIN_RESOLUTION_PAIRS && aMed;
const resolution = resolutionKnown ? ((hi - lo) / 2 / aMed) * 100 : NaN;
const mdPct = aMed ? (md / aMed) * 100 : NaN;

console.log("");
console.log(`[perf-ab] A median ${aMed.toFixed(1)} ${unit}  (spread ${Math.min(...aVals).toFixed(1)}-${Math.max(...aVals).toFixed(1)})`);
console.log(`[perf-ab] B median ${median(bVals).toFixed(1)} ${unit}  (spread ${Math.min(...bVals).toFixed(1)}-${Math.max(...bVals).toFixed(1)})`);
console.log(`[perf-ab] paired difference (B-A): median ${md.toFixed(1)} ${unit} (${mdPct >= 0 ? "+" : ""}${mdPct.toFixed(1)}%), range ${lo.toFixed(1)}..${hi.toFixed(1)}`);
console.log(
  resolutionKnown
    ? `[perf-ab] resolution at ${diffs.length} pair(s): +/-${resolution.toFixed(1)}%`
    : `[perf-ab] resolution: UNKNOWN -- ${diffs.length} usable pair(s), need ` +
      `${MIN_RESOLUTION_PAIRS}. Any difference above is unproven.`
);
if (discarded) console.log(`[perf-ab] ${discarded} pair(s) discarded`);
if (discardedBackend.length) {
  const tally = {};
  for (const r of discardedBackend) tally[r] = (tally[r] || 0) + 1;
  console.log(
    `[perf-ab] ${discardedBackend.length} run(s) discarded for not achieving the ` +
    `requested backend: ${Object.entries(tally).map(([r, n]) => `${n}x ${r}`).join(", ")}`
  );
  console.log(`[perf-ab] A host that keeps losing the GPU will not produce a trustworthy result.`);
}

if (args.selftest) {
  // A against A: the true difference is zero, so the median difference is bias
  // and the range is noise. Sign agreement here is a warning, not a result --
  // it means something drifts with run order that pairing has not cancelled.
  console.log("");
  if (resolutionKnown) {
    console.log(`[perf-ab] SELF-TEST RESULT: this rig resolves about +/-${resolution.toFixed(1)}%.`);
    console.log(`[perf-ab] Treat any A/B difference smaller than that as unproven.`);
  } else {
    console.log(
      `[perf-ab] SELF-TEST RESULT: NOT ESTABLISHED. ${diffs.length} usable pair(s) of ` +
      `${args.pairs}; ${MIN_RESOLUTION_PAIRS} are needed before a spread means anything.`
    );
    console.log(`[perf-ab] This rig did not stay healthy long enough to characterise itself.`);
  }
  if (sameSign && diffs.length >= 2) {
    console.log(
      `[perf-ab] WARNING: identical arms still disagreed consistently ` +
      `(${mdPct >= 0 ? "+" : ""}${mdPct.toFixed(1)}%). There is order-dependent drift ` +
      `left; raise --warmup or --duration before trusting small results.`
    );
  } else {
    console.log("[perf-ab] Sign disagreement across pairs is the expected, healthy result here.");
  }
} else {
  console.log(
    sameSign
      ? `[perf-ab] VERDICT: consistent ${md > 0 ? "gain" : "loss"} — every pair agreed in sign.`
      : `[perf-ab] VERDICT: NOT RESOLVED — pairs disagree in sign, effect is below this rig's resolution.`
  );
}

if (persistDir) rmSync(persistDir, { recursive: true, force: true });
