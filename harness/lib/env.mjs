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

// Waits for a calm machine first, then takes the perf lock (`acquire`):
// never hold the lock while waiting on a load that may not come down
// (2026-10-22, a race-perf held the Mac lock 1 h 52 behind a load of 25
// from a VM outside the program, blocking the whole queue). Not calm within
// `calmWait`: refused, no lock taken, nothing measured.
export async function calmThenLock({ maxLoad, calmWait, acquire, log = () => {}, wait = waitForLoad }) {
  const calm = await wait({ maxLoad, waitSec: calmWait, pollSec: 30, log });
  if (!calm.ok) throw new Error(`machine not calm: load ${calm.load} > ${calm.limit} after ${calmWait} s; no lock taken, nothing measured`);
  return acquire();
}

// Under the lock, before each side: a loaded machine never keeps the lock
// (2026-10-22, a pair waited 60 min on --load-wait while holding the Mac
// lock). The lock goes back at once, the calm is awaited outside it (up to
// `waitSec`), then the lock is taken again in its turn (`acquire`). Returns
// the lock now held (null: never calm, given up, no lock held), the gate,
// and whether the lock was let go meanwhile (the run is then played again).
export async function calmUnderLock({ lock, maxLoad, waitSec, acquire, log = () => {}, load = () => os.loadavg()[0], wait = waitForLoad }) {
  const limit = loadLimit(maxLoad);
  const now = load();
  if (now <= limit) return { lock, gate: { load: Math.round(now * 100) / 100, limit, ok: true }, relocked: false };
  log(`load ${now.toFixed(1)} > ${limit}: perf lock released while waiting for calm`);
  lock();
  const calm = await wait({ maxLoad, waitSec, pollSec: 30, log });
  if (!calm.ok) return { lock: null, gate: calm, relocked: false };
  return { lock: await acquire(), gate: calm, relocked: true };
}

// Under the lock, a load gate that did not open (still loaded after
// --load-wait): the remaining runs are given up, the lock goes back.
export const loadGaveUp = (gate) => (gate && gate.ok === false ? `load ${gate.load} > ${gate.limit} after --load-wait: remaining runs given up, lock released` : null);

// A run is overloaded when the median 1-minute load during it exceeds the limit.
export function isOverloaded(cpuSamples, maxLoad) {
  const v = cpuSamples.map((c) => c.load1).filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return false;
  return v[v.length >> 1] > loadLimit(maxLoad);
}
