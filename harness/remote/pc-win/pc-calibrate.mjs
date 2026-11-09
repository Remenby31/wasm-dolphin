#!/usr/bin/env node
// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// The CPU clamp's calibration, run ON the PC by the kit's scheduled task
// (harness/remote/pc-run.mjs calibrate; research/pc-windows-kit.md §2):
//   1. the kit's power scheme with no cap, pc-bench in the browser under
//      test -> the host's own score s0 (the class affinity already applies:
//      6 cores of the fastest class);
//   2. target = s0 x GB6(i5-12400) / GB6(host) (public averages, one
//      snapshot: lib/pc-kit.mjs PUBLIC_GB6);
//   3. search the maximum processor frequency (MHz) until the score is
//      within 2 % of the target (lib/pc-kit.mjs nextProbe); if the firmware
//      ignores the MHz cap (the score does not move), the maximum processor
//      state (%) instead;
//   4. calibration.json: the knob's value to measure with, every probe.
// The power scheme is left for the task's end (restoreAtEnd) or pc-run's
// restore: this script only ever changes the kit's own scheme.
//
//   node harness/remote/pc-win/pc-calibrate.mjs --job ID --out calibration.json
//     [--host-gb6 N] [--runs 3] [--warm-sec 4] [--tol 0.02]
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { calibrationTarget, gb6Of, knobIneffective, MAX_TURBO_MHZ, nextProbe, parseKitJson, PUBLIC_GB6, REFERENCE_CPU } from "../../lib/pc-kit.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "salon-pc.ps1");

// The search itself, its I/O injected (tests drive it with a model CPU).
//   bench(): a score; clamp({ maxMhz, statePct, boostMode }): applies it.
export async function calibrate({ bench, clamp, hostGb6, referenceGb6 = PUBLIC_GB6[REFERENCE_CPU], turboMhz = null, tol = 0.02, log = () => {} }) {
  await clamp({ maxMhz: 0 });
  const s0 = await bench();
  const t = calibrationTarget({ unclampedScore: s0, hostGb6, referenceGb6 });
  log(`unclamped ${s0}, ratio ${t.ratio}, target ${t.target}`);
  const out = { unclampedScore: s0, ...t, hostGb6, referenceGb6, tol, knobs: [] };
  if (!t.needed) return { ...out, chosen: { maxMhz: 0 }, why: "the host is not faster than the reference: no clamp" };
  const run = async (knob, lo, hi, first, apply) => {
    const points = [];
    let x = first;
    for (;;) {
      await apply(x);
      const score = await bench();
      points.push({ x, score });
      log(`${knob} ${x}: ${score} (${Math.round((score / t.target - 1) * 1000) / 10} %)`);
      if (points.length === 3 && knobIneffective(points)) return { knob, points, ineffective: true };
      const n = nextProbe(points, t.target, { lo, hi, tol, step: knob === "maxMhz" ? 50 : 1, minStep: knob === "maxMhz" ? 100 : 2 });
      if (n.done) return { knob, points, best: n.best, errPct: n.errPct, why: n.why };
      x = n.next;
    }
  };
  const turbo = turboMhz ?? 5000;
  const f = await run("maxMhz", 800, 7000, Math.round((turbo * t.ratio) / 50) * 50, (x) => clamp({ maxMhz: x }));
  out.knobs.push(f);
  if (!f.ineffective && f.errPct > 2 * tol * 100) return { ...out, chosen: null, errPct: f.errPct, why: `the MHz cap gets no closer than ${f.errPct} % to the target` };
  if (!f.ineffective) return { ...out, chosen: { maxMhz: f.best.x }, errPct: f.errPct, why: f.why };
  // Maximum processor state: "a percentage of maximum processor frequency"
  // (Microsoft's tuning guide), boost left as it is (with boost off the
  // ceiling falls to the base clock, often under the reference's turbo).
  log("the MHz cap does not move the score: maximum processor state (%) instead");
  const s = await run("statePct", 30, 100, Math.round(100 * t.ratio), (x) => clamp({ maxMhz: 0, statePct: x }));
  out.knobs.push(s);
  if (s.ineffective) return { ...out, chosen: null, why: "neither knob moves the score: the firmware owns the clock (BIOS), clamp by hand" };
  if (s.errPct > 2 * tol * 100) return { ...out, chosen: null, errPct: s.errPct, why: `the processor state gets no closer than ${s.errPct} % to the target` };
  return { ...out, chosen: { maxMhz: 0, statePct: s.best.x }, errPct: s.errPct, why: s.why };
}

function psClamp(job, { maxMhz = 0, statePct = 0, boostMode = -1 }) {
  const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", SCRIPT,
    "-Action", "clamp", "-Job", job, "-MaxMhz", String(maxMhz), "-StatePct", String(statePct), "-BoostMode", String(boostMode)], { encoding: "utf8", windowsHide: true, timeout: 60000 });
  const r = parseKitJson(out);
  if (!r) throw new Error(`clamp: no result (${out.slice(-300)})`);
  return r;
}

async function main() {
  const { values } = parseArgs({ options: { job: { type: "string" }, out: { type: "string" }, "host-gb6": { type: "string" }, port: { type: "string" }, root: { type: "string" }, runs: { type: "string", default: "3" }, "warm-sec": { type: "string", default: "4" }, tol: { type: "string", default: "0.02" } } });
  if (!values.job || !values.out) throw new Error("usage: pc-calibrate.mjs --job ID --out calibration.json [--host-gb6 N]");
  const log = (m) => console.error(`[pc-calibrate] ${m}`);
  const cpu = os.cpus()[0]?.model ?? "";
  const known = gb6Of(cpu);
  const hostGb6 = values["host-gb6"] ? Number(values["host-gb6"]) : known?.gb6;
  if (!(hostGb6 > 0)) throw new Error(`${cpu}: not in the public table, pass --host-gb6 <Geekbench 6 single-core average> (and cite it)`);
  const { benchOnce, summarizeRuns } = await import("../../probes/pc-bench.mjs");
  // the bench on the game's origin, as in the job's own benches
  const { ensureServer, REPO_ROOT } = await import("../../lib/browser.mjs");
  const server = values.port ? await ensureServer({ port: Number(values.port), root: values.root ?? REPO_ROOT }) : null;
  const url = server ? `${server.base}package.json` : "about:blank";
  const bench = async () => {
    const runs = [];
    for (let i = 0; i < Number(values.runs); i += 1) runs.push(await benchOnce({ warmSec: Number(values["warm-sec"]), url, log }));
    const bad = runs.find((r) => r.state.visibility !== "visible" || (r.state.rafMs?.p50 ?? 0) >= 25);
    if (bad) throw new Error(`a bench run is not usable for calibration (${bad.state.visibility}, rAF ${bad.state.rafMs?.p50} ms): see the preflight`);
    return summarizeRuns(runs).score;
  };
  const result = await calibrate({ bench, clamp: (o) => psClamp(values.job, o), hostGb6, turboMhz: known ? MAX_TURBO_MHZ[known.name] ?? null : null, tol: Number(values.tol), log });
  const report = { probe: "pc-calibrate", at: new Date().toISOString(), cpu, hostCpu: known?.name ?? null, reference: REFERENCE_CPU, browser: process.env.HARNESS_BROWSER_CHANNEL || "chrome", ...result };
  writeFileSync(values.out, JSON.stringify(report, null, 1) + "\n");
  log(`chosen ${JSON.stringify(result.chosen)}: ${result.why}`);
  if (!result.chosen) process.exitCode = 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().then(() => process.exit(process.exitCode ?? 0), (e) => { console.error(e); process.exit(1); });
}
