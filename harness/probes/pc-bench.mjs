#!/usr/bin/env node
// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// The PC kit's single-thread Wasm bench (research/pc-windows-kit.md): the
// two generated kernels of lib/wasm-kernel.mjs (core: L1-resident; front:
// ~830 KiB of wasm and 4 MiB of memory behind call_indirect) run in a
// dedicated worker of the browser under test, the thread type that carries
// the emulated CPU. Per kernel: ns per dispatch at the first calls (cold:
// Liftoff, or an interpreter) and at the end (hot: after tier-up), their
// ratio and the spread of the hot calls. The score is the geometric mean of
// the two hot throughputs (M dispatches/s): the calibration's unit
// (harness/remote/pc-calibrate.mjs). Also the page's state: rAF interval
// (30 Hz = an energy saver), visibility, focus, the brand.
//
//   node harness/probes/pc-bench.mjs [--runs 3] [--warm-sec 4] [--out file.json]
//   HARNESS_BROWSER_CHANNEL=msedge HARNESS_DISPLAY=windows node harness/probes/pc-bench.mjs
//
// A timed run: on the Mac only under acquirePerfLock (never in tests).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { launchChrome } from "../lib/browser.mjs";
import { median, round } from "../lib/stats.mjs";
import { buildKernel, reference, SHAPES } from "../lib/wasm-kernel.mjs";

export const BENCH_VERSION = 1;
// A first call of this many dispatches checks the engine against the JS
// reference before anything is timed.
export const CHECK_N = 1000;
// Cold: the first COLD_CALLS timed calls; hot: the last HOT_CALLS.
export const COLD_CALLS = 3;
export const HOT_CALLS = 10;
// A call aims at this duration (its dispatch count is sized on the first one).
export const CALL_MS = 15;

const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))]; };

// One kernel's calls (ns per dispatch, in call order) -> its summary. Pure.
export function summarizeCalls(nsPerDispatch) {
  if (nsPerDispatch.length < COLD_CALLS + HOT_CALLS) return { calls: nsPerDispatch.length, coldNs: null, hotNs: null, ratio: null, spread: null, mdps: null };
  const cold = median(nsPerDispatch.slice(0, COLD_CALLS));
  const hotCalls = nsPerDispatch.slice(-HOT_CALLS);
  const hot = median(hotCalls);
  return {
    calls: nsPerDispatch.length, coldNs: round(cold, 2), hotNs: round(hot, 2), ratio: round(hot / cold, 3),
    spread: round((pct(hotCalls, 0.9) - pct(hotCalls, 0.1)) / hot, 3), mdps: round(1000 / hot, 3)
  };
}

// The bench's score: geometric mean of the kernels' hot M dispatches/s.
export function benchScore(kernels) {
  const v = Object.values(kernels).map((k) => k?.mdps);
  if (!v.length || v.some((x) => !(x > 0))) return null;
  return round(Math.exp(v.reduce((s, x) => s + Math.log(x), 0) / v.length), 3);
}

// What the tier-up says about the JIT (research/deep-windows-blockers.md
// §1.5): no gain from the first calls to the last = no optimizing tier
// (Liftoff alone, or an interpreter). Which of the two needs a second
// browser on the same machine: jitAgainst. Threshold to calibrate on the PC.
export const NO_TIER_UP_RATIO = 0.85;
export function jitVerdict(kernels) {
  const r = kernels.core?.ratio;
  if (!Number.isFinite(r)) return "unknown";
  return r > NO_TIER_UP_RATIO ? "no-tier-up" : "tier-up";
}
// Same machine, two browsers (e.g. Edge against Chrome): hot core kernel
// this many times slower = an interpreter (Edge's enhanced security: no JIT).
export const INTERPRETER_FACTOR = 5;
export function jitAgainst(subject, reference) {
  const a = subject?.kernels?.core?.hotNs, b = reference?.kernels?.core?.hotNs;
  if (!(a > 0) || !(b > 0)) return { factor: null, verdict: "unknown" };
  const factor = round(a / b, 2);
  return { factor, verdict: factor >= INTERPRETER_FACTOR ? "interpreter" : jitVerdict(subject.kernels) === "no-tier-up" ? "liftoff-only" : "jit" };
}

// The worker's program (a string: it runs in the browser). Per kernel:
// check run(CHECK_N) against the expected checksum, size a call to CALL_MS,
// then call until warmMs has passed.
export const WORKER_SOURCE = `
onmessage = (e) => {
  const { kernels, warmMs, callMs, coldCalls, hotCalls } = e.data;
  const out = {};
  for (const [name, k] of Object.entries(kernels)) {
    const bytes = Uint8Array.from(atob(k.b64), (c) => c.charCodeAt(0));
    const run = new WebAssembly.Instance(new WebAssembly.Module(bytes), {}).exports.run;
    let t = performance.now();
    const check = run(k.checkN) >>> 0;
    const firstMs = performance.now() - t;
    const n = Math.max(1000, Math.round(k.checkN * callMs / Math.max(firstMs, 0.05)));
    const ns = [];
    const t0 = performance.now();
    while (ns.length < coldCalls + hotCalls || performance.now() - t0 < warmMs) {
      t = performance.now();
      run(n);
      ns.push((performance.now() - t) * 1e6 / n);
      if (performance.now() - t0 > warmMs * 20) break;
    }
    out[name] = { checksumOk: check === k.expect, n, ns };
  }
  postMessage(out);
};`;

async function pageState(page) {
  return page.evaluate(() => new Promise((resolve) => {
    const ts = [];
    const step = (t) => { ts.push(t); if (ts.length < 61) requestAnimationFrame(step); else done(); };
    const done = () => {
      const d = ts.slice(1).map((t, i) => t - ts[i]).sort((a, b) => a - b);
      resolve({
        rafMs: d.length ? { p50: d[d.length >> 1], p90: d[Math.floor(d.length * 0.9)] } : null,
        visibility: document.visibilityState, focus: document.hasFocus(),
        brands: navigator.userAgentData?.brands?.map((b) => `${b.brand} ${b.version}`) ?? null,
        ua: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency, deviceMemory: navigator.deviceMemory ?? null
      });
    };
    setTimeout(() => (ts.length < 61 ? done() : null), 3000);
    requestAnimationFrame(step);
  }));
}

export async function benchOnce({ warmSec = 4, log = () => {} } = {}) {
  const kernels = Object.fromEntries(Object.entries(SHAPES).map(([name, shape]) => [name, {
    b64: Buffer.from(buildKernel(shape)).toString("base64"), checkN: CHECK_N, expect: reference(shape, CHECK_N)
  }]));
  const dir = mkdtempSync(path.join(os.tmpdir(), "gc-pc-bench-"));
  const context = await launchChrome({ profileDir: dir });
  try {
    await context.assertInvisible?.("after launch");
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto("about:blank");
    await page.bringToFront().catch(() => {});
    const state = await pageState(page);
    log(`page: ${state.visibility}, focus ${state.focus}, rAF p50 ${state.rafMs?.p50?.toFixed(1)} ms`);
    const raw = await page.evaluate(({ src, msg }) => new Promise((resolve, reject) => {
      const w = new Worker(URL.createObjectURL(new Blob([src])));
      w.onmessage = (e) => resolve(e.data);
      w.onerror = (e) => reject(new Error(e.message || "worker error"));
      w.postMessage(msg);
    }), { src: WORKER_SOURCE, msg: { kernels, warmMs: warmSec * 1000, callMs: CALL_MS, coldCalls: COLD_CALLS, hotCalls: HOT_CALLS } });
    const res = {};
    for (const [name, r] of Object.entries(raw)) {
      if (!r.checksumOk) throw new Error(`${name}: checksum mismatch (the engine computed another result than the JS reference)`);
      res[name] = { n: r.n, ...summarizeCalls(r.ns) };
    }
    return { state, kernels: res, score: benchScore(res), jit: jitVerdict(res) };
  } finally {
    await context.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
}

// Several runs (a fresh browser each) -> their median score.
export function summarizeRuns(runs) {
  const scores = runs.map((r) => r.score).filter((s) => s > 0);
  const m = median(scores);
  return { runs: runs.length, score: m == null ? null : round(m, 3), scores, spreadPct: scores.length > 1 && m ? round((100 * (Math.max(...scores) - Math.min(...scores))) / m, 1) : null };
}

async function main() {
  const { values } = parseArgs({ options: { runs: { type: "string", default: "3" }, "warm-sec": { type: "string", default: "4" }, out: { type: "string" } } });
  const log = (m) => console.error(`[pc-bench] ${m}`);
  const runs = [];
  for (let i = 0; i < Number(values.runs); i += 1) {
    const r = await benchOnce({ warmSec: Number(values["warm-sec"]), log });
    log(`run ${i + 1}: score ${r.score}, jit ${r.jit}, core ${r.kernels.core.hotNs} ns, front ${r.kernels.front.hotNs} ns`);
    runs.push(r);
  }
  const report = {
    probe: "pc-bench", benchVersion: BENCH_VERSION, at: new Date().toISOString(),
    browser: { channel: process.env.HARNESS_BROWSER_CHANNEL || "chrome", path: process.env.HARNESS_CHROME_PATH || null, args: process.env.HARNESS_CHROME_ARGS || "", display: process.env.HARNESS_DISPLAY || "headless" },
    machine: { platform: `${os.platform()} ${os.release()}`, cpuModel: os.cpus()[0]?.model ?? "", cpus: os.cpus().length },
    ...summarizeRuns(runs), perRun: runs
  };
  if (values.out) writeFileSync(values.out, JSON.stringify(report, null, 1) + "\n");
  console.log(JSON.stringify({ score: report.score, spreadPct: report.spreadPct, jit: runs.map((r) => r.jit) }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
