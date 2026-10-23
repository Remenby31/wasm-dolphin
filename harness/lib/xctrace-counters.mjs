// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
// Per-thread CPU counters on macOS without root (research/deep-icache-layout.md
// §5): xctrace's "CPU Counters" template in a guided mode, attached to the
// Chrome renderer for race-perf's window. Command line only: Instruments'
// window never opens.
//
// o.onWindow for race-perf's measure() (--counters on macOS): "start"
// records (`xctrace record --attach <renderer pid>`) and returns once the
// recording runs; "end" stops it (SIGINT), exports MetricTable (per 1 ms
// sample and thread: `cycle` and the mode's fractions; the 10 ms table
// MetricAggregationForThread SUMS the fractions of its samples), keeps the
// thread with the most cycles (the emulated CPU thread in a race) and
// deletes the trace (hundreds of MB a second).
// Counting is at EL0 (user mode), per thread.
//
// Modes (--counter-events): delivery (default: Instruction Delivery
// Bottlenecks: delivery_bandwidth, delivery_latency_icache / _itlb / _other,
// fractions of Apple's "sustainable bandwidth"), discarded (Discarded
// Sampling), discarded_indirect, bottlenecks. Each fraction is averaged over
// the buckets weighted by their cycles. They compare two sides on this Mac,
// never the Mac with the Spark (other definitions).
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, statfsSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { round } from "./stats.mjs";

export const XCTRACE_MODES = Object.freeze({
  delivery: { countingMode: "delivery", display: "Instruction Delivery Bottlenecks" },
  discarded: { countingMode: "discarded_sampling", display: "Discarded Sampling" },
  discarded_indirect: { countingMode: "discarded_indirect_sampling", display: "Discarded Indirect, Call, and Return Sampling" },
  bottlenecks: { countingMode: "bottlenecks", display: "CPU Bottlenecks" }
});

// The --recording-options file of a guided mode (refused if a key is missing).
export function recordingOptions(mode) {
  const m = XCTRACE_MODES[mode];
  if (!m) throw new Error(`xctrace mode ${mode}: one of ${Object.keys(XCTRACE_MODES).join(", ")}`);
  return { "CPU Counters": {
    allEventsAndFormulas: [], configurationType: { guided: {} }, countingLevel: "EL0", pmiEventAliasOrMnemonic: "", pmiThreshold: 1000000,
    processBucketSize: 10, sampleByTime: true, selectedCountingMode: { analysisMode: "bottleneck", countingMode: m.countingMode },
    selectedCountingModeDisplayName: m.display, useDebuggingInformation: false, useHighFrequencyForGuidedMode: false, useHighFrequencyForManualMode: false
  } };
}

const unescape = (s) => s.replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

// MetricTable rows of `xctrace export` (timestamp, metric name, thread,
// value): xctrace writes each value once (id="N") and refers to it later
// (ref="N"), across rows.
export function parseMetricRows(xml) {
  const values = new Map();
  const field = (row, tag) => {
    const m = new RegExp(`<${tag} (?:id="(\\d+)"(?: fmt="([^"]*)")?>([\\s\\S]*?)</${tag}>|ref="(\\d+)"/>)`).exec(row);
    if (!m) return null;
    if (m[4] != null) return values.get(m[4]) ?? null;
    const v = { fmt: m[2] == null ? null : unescape(m[2]), text: m[3] };
    values.set(m[1], v);
    return v;
  };
  // A thread: <thread id fmt><tid id fmt>N</tid>…</thread>, or <thread ref/>.
  const threadOf = (row) => {
    const ref = /<thread ref="(\d+)"\/>/.exec(row);
    if (ref) return values.get(ref[1]) ?? null;
    const m = /<thread id="(\d+)" fmt="([^"]*)"><tid id="\d+" fmt="[^"]*">(\d+)<\/tid>/.exec(row);
    if (!m) return null;
    const v = { tid: Number(m[3]), name: unescape(m[2]) };
    values.set(m[1], v);
    return v;
  };
  const rows = [];
  for (const [, row] of xml.matchAll(/<row>([\s\S]*?)<\/row>/g)) {
    // Register every id of the row in order, so later refs resolve.
    for (const m of row.matchAll(/<([a-z-]+) id="(\d+)"(?: fmt="([^"]*)")?>([^<]*)<\/\1>/g)) if (!values.has(m[2])) values.set(m[2], { fmt: m[3] == null ? null : unescape(m[3]), text: m[4] });
    const thread = threadOf(row);
    const name = field(row, "string"), value = field(row, "fixed-decimal"), start = field(row, "start-time");
    if (!thread || !name || !value) continue;
    rows.push({ t: Number(start?.text ?? NaN), tid: thread.tid, thread: thread.name, metric: name.text, value: Number(value.text) });
  }
  return rows;
}

const camel = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

// Per thread: cycles summed over the samples, each other metric averaged
// weighted by its sample's cycles.
export function threadMetrics(rows) {
  const byThread = new Map();
  const buckets = new Map(); // tid -> t -> cycles
  for (const r of rows) {
    if (r.metric !== "cycle") continue;
    const th = byThread.get(r.tid) ?? { tid: r.tid, thread: r.thread, cycles: 0, sums: {} };
    th.cycles += r.value;
    byThread.set(r.tid, th);
    if (!buckets.has(r.tid)) buckets.set(r.tid, new Map());
    buckets.get(r.tid).set(r.t, r.value);
  }
  for (const r of rows) {
    if (r.metric === "cycle") continue;
    const th = byThread.get(r.tid);
    const w = buckets.get(r.tid)?.get(r.t);
    if (!th || !(w > 0)) continue;
    th.sums[r.metric] = (th.sums[r.metric] ?? 0) + w * r.value;
  }
  return [...byThread.values()].map((th) => ({
    tid: th.tid, thread: th.thread, cycles: th.cycles,
    ...Object.fromEntries(Object.entries(th.sums).map(([k, v]) => [camel(k), th.cycles > 0 ? round(v / th.cycles, 5) : null]))
  })).sort((a, b) => b.cycles - a.cycles);
}

// Per 1000 guest cycles of a race-perf window: host cycles of the thread,
// and the cycles each fraction stands for (e.g. delivery_latency_icache:
// cycles the front end lost to the I-cache).
export function perKiloGuestCycles(cold) {
  const c = cold?.counters;
  if (!c || c.error || c.tool !== "xctrace" || !(c.cycles > 0) || !(cold.guestTicks > 0)) return null;
  const k = 1000 / cold.guestTicks;
  const out = { cycles: round(c.cycles * k, 3) };
  for (const [name, v] of Object.entries(c.fractions ?? {})) if (Number.isFinite(v)) out[`${name}Cycles`] = round(c.cycles * v * k, 3);
  return out;
}

// xctrace also leaves its raw kernel trace in $TMPDIR (instruments*.ktrace,
// 0.1-4 GB each), outside the .trace it saves (2026-10-23: ~6.8 GB in an
// afternoon). Listed before and after each window: the new ones that no
// process holds open are deleted, by the paths the listing returned. Those
// still open (Xcode's DTServiceHub keeps the last one open after the
// recording ends) are deleted at a later window or at the end of the
// campaign (finish), once closed.
export function listKtraces(dir = os.tmpdir()) {
  try {
    return readdirSync(dir).filter((f) => /^instruments.*\.ktrace$/.test(f)).map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

// Whether a process has `file` open (lsof exits 1 when none does).
function heldOpen(file) {
  try { execFileSync("lsof", ["-t", file], { stdio: ["ignore", "pipe", "ignore"] }); return true; } catch { return false; }
}

// Deletes the ktraces in `after` but not in `before` that nobody holds open.
export function removeNewKtraces(before, after, { isOpen = heldOpen, remove = (f) => rmSync(f, { force: true }), sizeOf = (f) => statSync(f).size } = {}) {
  const was = new Set(before);
  const out = { removed: [], removedMB: 0, keptOpen: [] };
  for (const f of after) {
    if (was.has(f)) continue;
    if (isOpen(f)) { out.keptOpen.push(f); continue; }
    let size = 0;
    try { size = sizeOf(f); } catch {}
    remove(f);
    out.removed.push(path.basename(f));
    out.removedMB += size / 1048576;
  }
  out.removedMB = round(out.removedMB, 0);
  return out;
}

// The ktraces our windows created that were still open: add(), retried at
// each sweep(), waited for by finish() (bounded), which returns those left.
// DTServiceHub, which holds the last one, exits ~10 min after the last
// recording (2026-10-23): finish waits 15 min by default.
export function createKtraceJanitor({ isOpen = heldOpen, remove = (f) => rmSync(f, { force: true }), log = (m) => console.log(m) } = {}) {
  const pending = new Set();
  const sweep = () => {
    const out = { removed: [], open: [] };
    for (const f of [...pending]) {
      const r = removeNewKtraces([], [f], { isOpen, remove, sizeOf: () => 0 });
      if (r.keptOpen.length) out.open.push(f); else { pending.delete(f); out.removed.push(...r.removed); }
    }
    if (out.removed.length) log(`[xctrace] ktrace: ${out.removed.length} removed later, once closed: ${out.removed.join(" ")}`);
    return out;
  };
  const finish = async ({ waitSec = 900, pollSec = 15 } = {}) => {
    const end = Date.now() + waitSec * 1000;
    let left = sweep().open;
    while (left.length && Date.now() < end) {
      await new Promise((r) => setTimeout(r, pollSec * 1000));
      left = sweep().open;
    }
    if (left.length) log(`[xctrace] ktrace still open after ${waitSec} s, left: ${left.join(" ")}`);
    return { ktraceLeft: left };
  };
  return { add: (files) => { for (const f of files) pending.add(f); }, sweep, finish, pending: () => [...pending] };
}

// Free space (GB) of the volume holding `dir`.
export function freeDiskGB(dir = os.tmpdir()) {
  const s = statfsSync(dir);
  return (s.bavail * s.bsize) / 1e9;
}
// Under this, a campaign with xctrace stops (race-perf gives up its runs).
export const XCTRACE_MIN_FREE_GB = 25;

export function checkXctrace() {
  if (process.platform !== "darwin") throw new Error("--counters with xctrace: macOS only");
  try { execFileSync("xcrun", ["xctrace", "version"], { stdio: "ignore" }); } catch { throw new Error("--counters: xcrun xctrace not found (Xcode)"); }
}

// o.onWindow; pidOf(session): the renderer to attach to (race-perf's
// rendererThreads(profileDir).pid).
export function xctraceCounters({ mode = "delivery", pidOf, readyTimeoutMs = 60000 } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "xctrace-counters-"));
  const options = path.join(dir, `${mode}.json`);
  writeFileSync(options, JSON.stringify(recordingOptions(mode)));
  process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
  const live = new Map();
  const janitor = createKtraceJanitor();
  const sweep = janitor.sweep;
  const onWindow = async (phase, session) => {
    if (phase === "start") {
      sweep();
      const free = freeDiskGB();
      if (free < XCTRACE_MIN_FREE_GB) return live.set(session, { error: `disk: ${round(free, 1)} GB free < ${XCTRACE_MIN_FREE_GB} GB` });
      const ktraces = listKtraces();
      const pid = pidOf(session);
      if (!pid) return live.set(session, { error: "no renderer to attach to" });
      const trace = mkdtempSync(path.join(dir, "run-"));
      const file = path.join(trace, "window.trace");
      const proc = spawn("xcrun", ["xctrace", "record", "--template", "CPU Counters", "--recording-options", options, "--attach", String(pid), "--no-prompt", "--output", file], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      const ready = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), readyTimeoutMs);
        const seen = (b) => { out += b; if (/Ctrl-C to stop/.test(out)) { clearTimeout(timer); resolve(true); } };
        proc.stdout.on("data", seen);
        proc.stderr.on("data", seen);
        proc.once("exit", () => { clearTimeout(timer); resolve(false); });
      });
      if (!ready) {
        const exited = proc.exitCode != null ? null : new Promise((r) => proc.once("exit", r));
        proc.kill("SIGINT");
        await exited;
        rmSync(trace, { recursive: true, force: true });
        removeNewKtraces(ktraces, listKtraces());
        return live.set(session, { error: `xctrace did not start: ${out.trim().slice(-200)}` });
      }
      live.set(session, { proc, trace, file, pid, out: () => out, startedAt: Date.now(), ktraces });
      return;
    }
    const c = live.get(session);
    live.delete(session);
    if (!c || c.error) return { tool: "xctrace", mode, error: c?.error ?? "not started" };
    const recordedMs = Date.now() - c.startedAt;
    const exited = new Promise((r) => c.proc.once("exit", r));
    c.proc.kill("SIGINT");
    await exited;
    try {
      if (!/Output file saved/.test(c.out())) throw new Error(`xctrace did not save: ${c.out().trim().slice(-200)}`);
      const traceMB = Number(execFileSync("du", ["-sk", c.file], { encoding: "utf8" }).split(/\s/)[0]) / 1024;
      const xml = execFileSync("xcrun", ["xctrace", "export", "--input", c.file, "--xpath", '/trace-toc/run[@number="1"]/data/table[@schema="MetricTable"]'], { encoding: "utf8", maxBuffer: 1 << 30 });
      const threads = threadMetrics(parseMetricRows(xml));
      const top = threads[0];
      if (!top) throw new Error("no thread in the trace's per-thread table");
      const { tid, thread, cycles, ...fractions } = top;
      return {
        tool: "xctrace", mode, pid: c.pid, tid, thread, cycles, fractions, recordedMs, traceMB: round(traceMB, 0),
        // the next threads, to see which one was kept
        others: threads.slice(1, 4).map((t) => ({ thread: t.thread, cycles: t.cycles }))
      };
    } catch (error) {
      return { tool: "xctrace", mode, error: String(error?.message || error).slice(0, 300) };
    } finally {
      rmSync(c.trace, { recursive: true, force: true });
      const k = removeNewKtraces(c.ktraces, listKtraces());
      janitor.add(k.keptOpen);
      if (k.removed.length || k.keptOpen.length) console.log(`[xctrace] ktrace: ${k.removed.length} removed (${k.removedMB} MB)${k.keptOpen.length ? `, ${k.keptOpen.length} still open, removed once closed: ${k.keptOpen.join(" ")}` : ""}`);
      sweep();
    }
  };
  // The end of the campaign (race-perf, after the lock is released): waits
  // up to waitSec for the ktraces still open to close, deletes them, and
  // returns those still open then (paths, for whoever cleans up).
  onWindow.finish = janitor.finish;
  return onWindow;
}
