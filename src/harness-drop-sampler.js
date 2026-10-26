// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
// Harness-only drop sampler (harness/probes/drop-meter.mjs): every `everyMs`
// it snapshots cumulative counters (`read()`, one number or null per column)
// with the host time (timeOrigin + now, the clock of the VI and present
// rings) and how late the tick ran (`lagMs`: the thread it runs on was busy
// or paused). The harness differences consecutive rows into short windows.
// Off unless the harness starts it; nothing is read or stored meanwhile.
export function createDropSampler({
  columns,
  read,
  now = () => performance.timeOrigin + performance.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
  maxRows = 20000
}) {
  let timer = null, everyMs = 50, due = 0, rows = [], lost = 0, lagMaxMs = 0, errors = 0, lastError = null;
  const tick = () => {
    const t = now();
    const lagMs = Math.max(0, t - due);
    lagMaxMs = Math.max(lagMaxMs, lagMs);
    let values;
    try {
      values = read();
    } catch (e) {
      errors += 1;
      lastError = String(e?.message || e).slice(0, 200);
      values = columns.map(() => null);
    }
    if (rows.length >= maxRows) lost += 1;
    else rows.push([t, lagMs, ...values]);
    // Paced on the schedule, not on the last tick: one late tick does not
    // shift the ones after it, and a long stall shows as one large lag
    // (the ticks it swallowed are skipped, not fired in a burst).
    due += everyMs;
    if (due <= t) due = t + everyMs;
    timer = setTimer(tick, Math.max(0, due - now()));
  };
  return {
    get running() { return timer !== null; },
    start(ms = 50) {
      if (timer !== null) clearTimer(timer);
      everyMs = Math.max(5, Number(ms) || 50);
      rows = []; lost = 0; lagMaxMs = 0; errors = 0; lastError = null;
      due = now();
      tick();
      return { started: true, everyMs };
    },
    // Rows since the previous drain, oldest first.
    drain() {
      const out = { columns: ["t", "lagMs", ...columns], rows, lost, lagMaxMs, errors, lastError, running: timer !== null, everyMs };
      rows = []; lost = 0;
      return out;
    },
    stop() {
      if (timer !== null) clearTimer(timer);
      timer = null;
      return this.drain();
    }
  };
}

// Approximate sum (µs) and count of a histogram of `binUs`-wide bins, each
// bin taken at its middle; the last bin (overflow) at its lower edge.
export function histogramSum(words, offset, bins, binUs) {
  let sum = 0, count = 0;
  for (let i = 0; i < bins; i += 1) {
    const n = words[offset + i] >>> 0;
    count += n;
    sum += n * (i === bins - 1 ? i * binUs : (i + 0.5) * binUs);
  }
  return { sum, count };
}
