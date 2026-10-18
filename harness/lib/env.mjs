// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
// What a measurement must record about the browser it ran in
// (QA-CHECKLIST.md §11), and the machine-load guard.
import os from "node:os";

// Browser-side facts, read once per session.
export async function browserInfo(page) {
  return page.evaluate(async () => {
    const out = { userAgent: navigator.userAgent, devicePixelRatio, screen: { width: screen.width, height: screen.height } };
    try {
      const hints = await navigator.userAgentData?.getHighEntropyValues?.(["fullVersionList", "platformVersion"]);
      out.chrome = hints?.fullVersionList?.find((b) => /Chrome/.test(b.brand))?.version ?? null;
    } catch {}
    try {
      const adapter = await navigator.gpu?.requestAdapter?.();
      const info = adapter?.info ?? (await adapter?.requestAdapterInfo?.());
      out.gpu = info ? { vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description } : null;
    } catch (e) {
      out.gpu = { error: String(e?.message || e) };
    }
    return out;
  });
}

export function loadLimit(maxLoad) {
  return Number.isFinite(maxLoad) && maxLoad > 0 ? maxLoad : os.cpus().length;
}

// Wait (bounded) for the 1-minute load average to drop under the limit.
export async function waitForLoad({ maxLoad, waitSec = 60, pollSec = 5, log = () => {} }) {
  const limit = loadLimit(maxLoad);
  const end = Date.now() + waitSec * 1000;
  let load = os.loadavg()[0];
  while (load > limit && Date.now() < end) {
    log(`load ${load.toFixed(1)} > ${limit}, waiting`);
    await new Promise((r) => setTimeout(r, pollSec * 1000));
    load = os.loadavg()[0];
  }
  return { load: Math.round(load * 100) / 100, limit, ok: load <= limit };
}

// A run is overloaded when the median 1-minute load during it exceeds the limit.
export function isOverloaded(cpuSamples, maxLoad) {
  const v = cpuSamples.map((c) => c.load1).filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return false;
  return v[v.length >> 1] > loadLimit(maxLoad);
}
