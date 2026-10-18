// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
// Live freeze evidence. While a run is measured the timeline is drained
// every second; when it shows a freeze starting, the harness asks the worker
// for its WebGPU replay / GPU sync state (validationReadWgpuReplayState,
// patch 0080) a few times, so rare freezes come with the state they froze
// in. Evidence only: the gate judges freezes through coreFreeze as before.
export const PROBE_FREEZE_MS = 2000;
export const PROBE_READS = 4;
export const PROBE_INTERVAL_MS = 500;
export const PROBE_MAX_EPISODES = 3;
const MAX_STATE_BYTES = 64 * 1024;

// observe(chunk) takes each timeline read (readTimeline) in order and
// returns a freeze episode when one starts:
// - "core": no VI output for PROBE_FREEZE_MS;
// - "present": no presentation for PROBE_FREEZE_MS while VI outputs go on.
export function createFreezeWatch({ freezeMs = PROBE_FREEZE_MS, maxEpisodes = PROBE_MAX_EPISODES } = {}) {
  let lastVi = null, lastPresent = null, viSinceBoot = null, current = null, episodes = 0;
  return {
    observe(chunk) {
      if (!chunk || chunk.error || !Number.isFinite(chunk.now)) return null;
      const vi = chunk.vi?.supported ? chunk.vi : null;
      if (vi?.t?.length) { lastVi = Math.max(lastVi ?? -Infinity, ...vi.t); viSinceBoot = vi.sinceBoot.at(-1); }
      if (chunk.presents?.t?.length) lastPresent = Math.max(lastPresent ?? -Infinity, ...chunk.presents.t);
      if (lastVi == null) return null; // nothing to judge before the first VI output
      const viAge = chunk.now - lastVi;
      const presentAge = lastPresent == null ? null : chunk.now - lastPresent;
      const kind = viAge > freezeMs ? "core" : presentAge != null && presentAge > freezeMs && viAge < freezeMs / 2 ? "present" : null;
      if (!kind) { current = null; return null; }
      if (current === kind || episodes >= maxEpisodes) return null;
      current = kind;
      episodes += 1;
      return { kind, t: chunk.now, viSinceBoot, lastViAgeMs: Math.round(viAge), lastPresentAgeMs: presentAge == null ? null : Math.round(presentAge) };
    }
  };
}

const UNSUPPORTED = /unknown|unsupported|not supported|unhandled/i;

// Read the worker state `reads` times, `intervalMs` apart. `request` is
// (type, payload) => reply or { error }. Returns { states } or
// { unsupported: true } when the worker does not know the message.
export async function probeWorker(request, { reads = PROBE_READS, intervalMs = PROBE_INTERVAL_MS, wait = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const states = [];
  for (let i = 0; i < reads; i += 1) {
    if (i) await wait(intervalMs);
    const t = performance.timeOrigin + performance.now();
    let reply;
    try {
      reply = await request("validationReadWgpuReplayState", {});
    } catch (e) {
      reply = { error: String(e?.message || e) };
    }
    if (i === 0 && reply?.error && UNSUPPORTED.test(reply.error)) return { unsupported: true, why: reply.error.slice(0, 300) };
    states.push({ t, state: clip(reply) });
  }
  return { states };
}

function clip(value) {
  const text = JSON.stringify(value ?? null);
  return text.length <= MAX_STATE_BYTES ? value : { truncated: true, bytes: text.length, head: text.slice(0, MAX_STATE_BYTES) };
}
