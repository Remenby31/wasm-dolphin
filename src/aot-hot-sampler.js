// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later
// Guest-PC samples for the player's local profile (aot-profile.js): a worker
// of its own reads the u32 at PowerPCState::pc in the shared wasm heap every
// `periodMs` (no message to the core, nothing on the CPU thread) and posts
// what it counted every `postMs`. The discio worker drains them into the
// profile, which stays in this origin's OPFS and is never sent or shared.
// Paused (the emulation paused or stopped), the worker blocks without waking;
// a PC that does not move for `frozenMs` (a stall the pause did not report)
// is not counted, and the worker then looks less often, until it moves.
const SOURCE = `onmessage = (e) => {
  const { buffer, ctl, pcAddress, periodMs, postMs, frozenMs } = e.data;
  const u32 = new Uint32Array(buffer), flag = new Int32Array(ctl), sleeper = new Int32Array(new SharedArrayBuffer(4));
  const frozenAfter = Math.max(1, Math.round(frozenMs / periodMs));
  let counts = new Map(), lastPost = performance.now(), lastPc = -1, same = 0;
  const post = () => {
    if (counts.size) postMessage([...counts.entries()]);
    counts = new Map();
    lastPost = performance.now();
  };
  while (Atomics.load(flag, 0) === 0) {
    if (Atomics.load(flag, 1) === 1) {
      post();
      Atomics.wait(flag, 1, 1);
      lastPc = -1;
      same = 0;
      continue;
    }
    Atomics.wait(sleeper, 0, 0, same >= frozenAfter ? Math.max(periodMs * 20, 200) : periodMs);
    const pc = u32[pcAddress >>> 2];
    if (pc === lastPc) same++;
    else { lastPc = pc; same = 0; }
    if (same < frozenAfter && pc >= 0x80000000 && pc < 0x81800000) counts.set(pc, (counts.get(pc) || 0) + 1);
    if (performance.now() - lastPost >= postMs) post();
  }
  post();
  close();
};`;

// The guest PC's address in the core's heap: the ungated export (the harness
// one returns 0 unless the harness hooks are on, which the product never
// does: a product build recorded no profile), the harness one on an older
// core, else 0.
export function guestPcAddress(m) {
  return m?._DolphinWeb_GuestPcAddress?.() || m?._DolphinWeb_HarnessPcAddress?.() || 0;
}

// Starts sampling; null without a shared heap or a PC address.
export function startHotSampler({ buffer, pcAddress, periodMs = 10, postMs = 500, frozenMs = 1000,
  createWorker = (url) => new Worker(url, { name: "aot-hot-sampler" }) }) {
  if (typeof SharedArrayBuffer === "undefined" || !(buffer instanceof SharedArrayBuffer) || !pcAddress || pcAddress % 4) return null;
  const ctl = new SharedArrayBuffer(8);
  const flag = new Int32Array(ctl);
  const url = URL.createObjectURL(new Blob([SOURCE], { type: "text/javascript" }));
  const worker = createWorker(url);
  URL.revokeObjectURL(url);
  let pending = new Map(); // since the last drain (the local profile's record)
  worker.onmessage = (e) => {
    for (const [pc, n] of e.data) pending.set(pc, (pending.get(pc) ?? 0) + n);
  };
  worker.onerror = () => worker.terminate();
  worker.postMessage({ buffer, ctl, pcAddress, periodMs, postMs, frozenMs });
  return {
    // [[pc, hits]] sampled since the last drain.
    drain() {
      const out = [...pending.entries()];
      pending = new Map();
      return out;
    },
    // The emulation paused or stopped: the worker blocks, without waking.
    pause() {
      Atomics.store(flag, 1, 1);
    },
    resume() {
      Atomics.store(flag, 1, 0);
      Atomics.notify(flag, 1);
    },
    paused: () => Atomics.load(flag, 1) === 1,
    stop() {
      Atomics.store(flag, 0, 1);
      this.resume();
    }
  };
}

// Records drained samples into a disc's local profile. The first record is
// a new session (older weights halve), the next ones add to it; which one a
// record is gets decided before it awaits anything, so two records in flight
// (a remount during the minute's record) never count the session twice.
// A failure only costs the profile, but it is never silent (#165 recorded
// nothing for two bugs in a row and nothing showed): record.stats() counts
// records and failures with the last error (in validationReadAotProgress),
// and the first failure is a console warning.
export function createProfileRecorder({ store, discKey, blocksFromPcSamples, warn = (m) => console.warn(m) }) {
  let recorded = false;
  const stats = { records: 0, failures: 0, lastError: null };
  async function record(samples) {
    if (!samples?.length) return null;
    const newSession = !recorded;
    recorded = true;
    try {
      const out = await store.record(discKey, blocksFromPcSamples(samples), { newSession });
      stats.records += 1;
      return out;
    } catch (error) {
      if (newSession) recorded = false;
      stats.failures += 1;
      stats.lastError = `${error?.name ?? "Error"}: ${error?.message ?? error}`;
      if (stats.failures === 1) warn(`aot: the local region profile could not be recorded (${stats.lastError})`);
      return null;
    }
  }
  record.stats = () => ({ ...stats });
  return record;
}
