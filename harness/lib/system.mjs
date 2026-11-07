// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
// Machine load and per-profile Chrome CPU, so every measurement carries the
// context it was taken in (the eval machine is shared and often loaded).
import { execFileSync } from "node:child_process";
import os from "node:os";

// The power source (macOS `pmset -g batt`): a laptop on battery runs slower
// and differently from on mains, so a measure says which it ran on.
// { source: "ac" | "battery", percent } or null (another OS, no battery).
export function parsePmsetBatt(text) {
  const m = /Now drawing from '([^']+)'/.exec(text ?? "");
  if (!m) return null;
  const pct = /(\d+)%/.exec(text);
  return { source: /battery/i.test(m[1]) ? "battery" : /ac/i.test(m[1]) ? "ac" : m[1], percent: pct ? Number(pct[1]) : null };
}
// On mains but not keeping up (2026-10-29: "AC attached", 72 -> 54 % over a
// night of measures): the battery feeds the machine, which may then run as
// on battery. A measure needs the charge not falling, and above this.
export const MIN_BATTERY_PERCENT = 30;
// A stretch from `start` to `end` (powerSnapshot readings) whose charge fell,
// or ended under MIN_BATTERY_PERCENT: true. Unknown percentages: false.
export function powerDrained(start, end, minPercent = MIN_BATTERY_PERCENT) {
  const a = start?.percent, b = end?.percent ?? a;
  if (!Number.isFinite(b)) return false;
  return (Number.isFinite(a) && b < a) || b < minPercent;
}
export function powerSnapshot() {
  if (os.platform() !== "darwin") return null;
  try {
    return parsePmsetBatt(execFileSync("pmset", ["-g", "batt"], { encoding: "utf8" }));
  } catch {
    return null;
  }
}

export function machineSnapshot() {
  let uptime = "";
  try {
    uptime = execFileSync("uptime", { encoding: "utf8" }).trim();
  } catch {}
  const [l1, l5, l15] = os.loadavg();
  return {
    at: new Date().toISOString(),
    loadavg: [l1, l5, l15].map((v) => Math.round(v * 100) / 100),
    cpus: os.cpus().length,
    cpuModel: os.cpus()[0]?.model ?? "",
    totalMemGiB: Math.round(os.totalmem() / 2 ** 30),
    platform: `${os.platform()} ${os.release()}`,
    power: powerSnapshot(),
    uptime
  };
}

// Parse `ps -A -o %cpu=,command=` and sum the processes whose command line
// contains the profile directory (Chrome passes --user-data-dir to helpers).
// macOS %CPU: 100 = one core.
export function parsePsForProfile(psOutput, profileDir) {
  let total = 0, rendererMax = 0, gpu = 0, processes = 0;
  for (const line of psOutput.split("\n")) {
    const m = line.match(/^\s*([\d.]+)\s+(.*)$/);
    if (!m || !m[2].includes(profileDir)) continue;
    const cpu = Number(m[1]);
    processes += 1;
    total += cpu;
    if (m[2].includes("--type=renderer") && cpu > rendererMax) rendererMax = cpu;
    if (m[2].includes("--type=gpu-process")) gpu += cpu;
  }
  return { total: Math.round(total), rendererMax: Math.round(rendererMax), gpu: Math.round(gpu), processes };
}

export function sampleChromeCpu(profileDir) {
  try {
    const out = execFileSync("ps", ["-A", "-o", "%cpu=,command="], { encoding: "utf8", maxBuffer: 32 << 20 });
    return { t: Date.now(), load1: Math.round(os.loadavg()[0] * 100) / 100, ...parsePsForProfile(out, profileDir) };
  } catch (error) {
    return { t: Date.now(), error: String(error.message || error) };
  }
}

// Windows has no `ps`: the same figures from two CDP SystemInfo.getProcessInfo
// snapshots (cumulative CPU seconds per Chrome process, browser target only),
// over the wall time between them. 100 = one core, as on macOS. Pure.
export function cpuFromProcessInfo(before, after, wallMs) {
  if (!before || !after || !(wallMs > 0)) return null;
  const prev = new Map(before.map((p) => [p.id, p.cpuTime]));
  let total = 0, rendererMax = 0, gpu = 0;
  for (const p of after) {
    const cpu = (Math.max(0, p.cpuTime - (prev.get(p.id) ?? 0)) * 1000 * 100) / wallMs;
    total += cpu;
    if (p.type === "renderer" && cpu > rendererMax) rendererMax = cpu;
    if (p.type === "GPU") gpu += cpu;
  }
  return { total: Math.round(total), rendererMax: Math.round(rendererMax), gpu: Math.round(gpu), processes: after.length };
}

// A sampler over cpuFromProcessInfo for one Playwright context; each call
// returns the CPU since the previous one (the first only sets the origin).
export async function cdpCpuSampler(context) {
  const cdp = await context.browser()?.newBrowserCDPSession();
  if (!cdp) return null;
  let last = null;
  return async () => {
    const t = Date.now();
    try {
      const { processInfo } = await cdp.send("SystemInfo.getProcessInfo");
      const r = last ? cpuFromProcessInfo(last.info, processInfo, t - last.t) : null;
      last = { t, info: processInfo };
      return { t, load1: null, ...(r ?? { origin: true }) };
    } catch (error) {
      return { t, error: String(error.message || error) };
    }
  };
}

// Resident memory of one profile's Chrome processes, per process type
// (browser, renderer, gpu-process, utility:<service>), from
// `ps -A -o pid=,rss=,command=` (RSS in KB). Pure.
export function parseRssForProfile(psOutput, profileDir) {
  const byType = {};
  let totalMB = 0;
  for (const line of psOutput.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!m || !m[3].includes(profileDir)) continue;
    const mb = Number(m[2]) / 1024;
    let type = /--type=([a-z-]+)/.exec(m[3])?.[1] ?? "browser";
    const sub = /--utility-sub-type=([A-Za-z.]+)/.exec(m[3])?.[1];
    if (sub) type += `:${sub}`;
    byType[type] = Math.round((byType[type] ?? 0) + mb);
    totalMB += mb;
  }
  return { totalMB: Math.round(totalMB), byType };
}

export function sampleChromeRss(profileDir) {
  try {
    return parseRssForProfile(execFileSync("ps", ["-A", "-o", "pid=,rss=,command="], { encoding: "utf8", maxBuffer: 32 << 20 }), profileDir);
  } catch (error) {
    return { error: String(error.message || error) };
  }
}
