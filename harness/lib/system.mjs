// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
// Machine load and per-profile Chrome CPU, so every measurement carries the
// context it was taken in (the eval machine is shared and often loaded).
import { execFileSync } from "node:child_process";
import os from "node:os";

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
