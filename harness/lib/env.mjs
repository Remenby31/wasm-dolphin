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

// The gate's reading: { load, limit, ok }. Off the bench, the 1-minute load
// average against --max-load. On the DGX Spark bench (spark-race.sh exports
// SPARK_LANE_CPUS), the lane's own cores free of other people's threads and
// the machine under its background plus 5 per granted lane
// (lib/bench-load.mjs): two lanes at once made a fixed --max-load wrong.
export function gateReader({ maxLoad, load = null, env = process.env } = {}) {
  if (!load && env.SPARK_LANE_CPUS) {
    return async () => (await import("./bench-load.mjs")).benchRead();
  }
  const limit = loadLimit(maxLoad);
  const read = load ?? (() => os.loadavg()[0]);
  return async () => {
    const now = read();
    return { load: Math.round(now * 100) / 100, limit, ok: now <= limit };
  };
}

const why = (g) => `load ${g.load} > ${g.limit}${g.laneBusy?.length ? `, lane ${g.lane} cores busy (${g.laneBusy.map((b) => `${b.comm} ${b.pct} % on ${b.cpu}`).join(", ")})` : ""}`;

// Wait (bounded) for the gate to open: the load under the limit (and, on the
// bench, the lane's cores free).
export async function waitForLoad({ maxLoad, waitSec = 60, pollSec = 5, log = () => {}, read = gateReader({ maxLoad }) }) {
  const end = Date.now() + waitSec * 1000;
  let g = await read();
  while (!g.ok && Date.now() < end) {
    log(`${why(g)}, waiting`);
    await new Promise((r) => setTimeout(r, pollSec * 1000));
    g = await read();
  }
  return g;
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
export async function calmUnderLock({ lock, maxLoad, waitSec, acquire, log = () => {}, load = null, wait = waitForLoad }) {
  // A measure's lock (requireMains) on battery now: given back, and taken
  // again in turn once on mains (acquire waits for it); the run is played
  // again (relocked), never measured on battery.
  if (lock?.powerChanged?.()) {
    log("on battery: perf lock released until mains power");
    lock();
    // taken again on mains (acquire waits for it), then the load gate as usual
    const again = await calmUnderLock({ lock: await acquire(), maxLoad, waitSec, acquire, log, load, wait });
    return { ...again, relocked: true };
  }
  const read = gateReader({ maxLoad, load });
  const gate = await read();
  // Calm. No lock held (a gate gave up before): taken again in its turn.
  if (gate.ok) return lock ? { lock, gate, relocked: false } : { lock: await acquire(), gate, relocked: true };
  log(`${why(gate)}: ${lock ? "perf lock released while waiting for calm" : "waiting for calm before taking the perf lock again"}`);
  lock?.();
  const calm = await wait({ maxLoad, waitSec, pollSec: 30, log, read });
  if (!calm.ok) return { lock: null, gate: calm, relocked: false };
  return { lock: await acquire(), gate: calm, relocked: true };
}

// A perf lock never held while waiting for the load, for every probe: taken
// once the machine is calm (calmThenLock), then before each run
// waitCalmUnlocked() checks the load and, loaded, gives the lock back
// during the wait and takes it again in turn (calmUnderLock). The gate it
// returns says whether the lock went back (relocked). `acquire` null: no
// lock (--no-lock), the gate only waits. release() lets go of what is held.
// retakeOnGiveUp (ab): a gate still loaded after waitSec takes the lock
// again anyway, since the campaign goes on and measures under it (the cell
// is judged overloaded); a probe that stops on a give-up leaves it off.
export async function calmLock({ maxLoad, calmWait, acquire, log = () => {}, wait = waitForLoad, load, retakeOnGiveUp = false }) {
  let held = acquire ? await calmThenLock({ maxLoad, calmWait, acquire, log, wait }) : null;
  return {
    async waitCalmUnlocked({ waitSec, log: gateLog = log }) {
      if (!acquire) return { ...(await wait({ maxLoad, waitSec, log: gateLog })), relocked: false };
      const g = await calmUnderLock({ lock: held, maxLoad, waitSec, acquire, log: gateLog, wait, ...(load ? { load } : {}) });
      held = g.lock;
      if (!held && retakeOnGiveUp) {
        gateLog(`load ${g.gate.load} > ${g.gate.limit} after ${waitSec} s: perf lock taken again, the run goes on under it`);
        held = await acquire();
      }
      return { ...g.gate, relocked: g.relocked || Boolean(held && retakeOnGiveUp && !g.lock) };
    },
    check: () => held?.check?.(),
    release() { const r = held; held = null; r?.(); }
  };
}

// Under the lock, a load gate that did not open (still loaded after
// --load-wait): the remaining runs are given up, the lock goes back.
export const loadGaveUp = (gate) => (gate && gate.ok === false ? `${why(gate)} after --load-wait: remaining runs given up, lock released` : null);

// A run is overloaded when the median 1-minute load during it exceeds the limit.
export function isOverloaded(cpuSamples, maxLoad) {
  const v = cpuSamples.map((c) => c.load1).filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return false;
  return v[v.length >> 1] > loadLimit(maxLoad);
}
