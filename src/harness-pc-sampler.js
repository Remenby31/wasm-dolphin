// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later
// QA harness only: a guest-PC sampler. A worker of its own reads the u32 at
// PowerPCState::pc (DolphinWeb_HarnessPcAddress) in the shared wasm heap every
// `periodMs`, without stopping or slowing the emulated CPU thread (no CDP
// profiler, no message to the core). The result is a histogram of guest PCs:
// where the emulated CPU spends its time, by real-time sampling.
const SOURCE = `onmessage = (e) => {
  const { buffer, ctl, pcAddress, periodMs } = e.data;
  const u32 = new Uint32Array(buffer), flag = new Int32Array(ctl), sleeper = new Int32Array(new SharedArrayBuffer(4));
  const counts = new Map();
  let n = 0, outside = 0, same = 0, last = -1;
  const t0 = performance.now();
  while (Atomics.load(flag, 0) === 0) {
    Atomics.wait(sleeper, 0, 0, periodMs);
    const pc = u32[pcAddress >>> 2];
    if (pc < 0x80000000 || pc >= 0x81800000) { outside++; continue; }
    n++;
    if (pc === last) same++;
    last = pc;
    counts.set(pc, (counts.get(pc) || 0) + 1);
  }
  postMessage({ n, outside, same, ms: performance.now() - t0, counts: [...counts.entries()] });
};`;

export function startPcSampler({ buffer, pcAddress, periodMs = 0.25 }) {
  if (typeof SharedArrayBuffer === "undefined" || !(buffer instanceof SharedArrayBuffer)) {
    throw new Error("the guest-PC sampler needs a shared wasm heap (cpu=dual or cpu=single with threads)");
  }
  if (!pcAddress || pcAddress % 4) throw new Error(`bad PC address ${pcAddress}`);
  const ctl = new SharedArrayBuffer(4);
  const url = URL.createObjectURL(new Blob([SOURCE], { type: "text/javascript" }));
  const worker = new Worker(url, { name: "harness-pc-sampler" });
  URL.revokeObjectURL(url);
  const done = new Promise((resolve, reject) => {
    worker.onmessage = (e) => { resolve(e.data); worker.terminate(); };
    worker.onerror = (e) => { reject(new Error(e.message || "pc sampler failed")); worker.terminate(); };
  });
  worker.postMessage({ buffer, ctl, pcAddress, periodMs });
  return {
    stop() {
      Atomics.store(new Int32Array(ctl), 0, 1);
      return done;
    }
  };
}

// Histogram → shares. `functions`: optional sorted [[start, end, name], …]
// (end exclusive) to attribute PCs to functions.
export function summarizePcSamples({ n, outside, same, ms, counts }, { top = 40, functions = null } = {}) {
  const share = (c) => (n ? Math.round((c / n) * 10000) / 100 : 0);
  const pcs = [...counts].sort((a, b) => b[1] - a[1]);
  const out = {
    samples: n, outside, hz: ms ? Math.round((n + outside) / (ms / 1000)) : null, distinctPcs: pcs.length,
    samePcShare: share(same),
    topPcs: pcs.slice(0, top).map(([pc, c]) => ({ pc: `0x${pc.toString(16)}`, share: share(c) }))
  };
  if (functions?.length) {
    const byFn = new Map();
    let unknown = 0;
    for (const [pc, c] of pcs) {
      let lo = 0, hi = functions.length - 1, hit = null;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1, f = functions[mid];
        if (pc < f[0]) hi = mid - 1; else if (pc >= f[1]) lo = mid + 1; else { hit = f; break; }
      }
      if (hit) byFn.set(hit[2], (byFn.get(hit[2]) ?? 0) + c); else unknown += c;
    }
    out.topFunctions = [...byFn].sort((a, b) => b[1] - a[1]).slice(0, top).map(([name, c]) => ({ name, share: share(c) }));
    out.unattributedShare = share(unknown);
  }
  return out;
}
