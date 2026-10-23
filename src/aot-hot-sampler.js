// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later
// Guest-PC heat for the first launch's region optimisation (research
// deep-first-minute, lever 1): a worker of its own reads the u32 at
// PowerPCState::pc in the shared wasm heap every `periodMs` (no message to the
// core, nothing on the CPU thread) and posts what it counted every `postMs`.
// The optimiser translates first the modules whose code these PCs hit. Kept in
// memory for this session only, never stored.
const SOURCE = `onmessage = (e) => {
  const { buffer, ctl, pcAddress, periodMs, postMs } = e.data;
  const u32 = new Uint32Array(buffer), flag = new Int32Array(ctl), sleeper = new Int32Array(new SharedArrayBuffer(4));
  let counts = new Map(), last = performance.now();
  while (Atomics.load(flag, 0) === 0) {
    Atomics.wait(sleeper, 0, 0, periodMs);
    const pc = u32[pcAddress >>> 2];
    if (pc >= 0x80000000 && pc < 0x81800000) counts.set(pc, (counts.get(pc) || 0) + 1);
    if (performance.now() - last >= postMs) {
      postMessage([...counts.entries()]);
      counts = new Map();
      last = performance.now();
    }
  }
  postMessage([...counts.entries()]);
  close();
};`;

// Starts sampling; null without a shared heap or a PC address (nothing to
// sample: the optimiser keeps the plan's order).
export function startHotSampler({ buffer, pcAddress, periodMs = 2, postMs = 500, createWorker = (url) => new Worker(url, { name: "aot-hot-sampler" }) }) {
  if (typeof SharedArrayBuffer === "undefined" || !(buffer instanceof SharedArrayBuffer) || !pcAddress || pcAddress % 4) return null;
  const ctl = new SharedArrayBuffer(4);
  const url = URL.createObjectURL(new Blob([SOURCE], { type: "text/javascript" }));
  const worker = createWorker(url);
  URL.revokeObjectURL(url);
  const heat = new Map();
  worker.onmessage = (e) => {
    for (const [pc, n] of e.data) heat.set(pc, (heat.get(pc) ?? 0) + n);
  };
  worker.onerror = () => worker.terminate();
  worker.postMessage({ buffer, ctl, pcAddress, periodMs, postMs });
  return {
    // [[pc, hits]]: everything sampled so far.
    heat: () => [...heat.entries()],
    stop() {
      Atomics.store(new Int32Array(ctl), 0, 1);
    }
  };
}
