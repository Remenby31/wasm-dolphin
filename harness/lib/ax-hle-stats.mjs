// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
// AX HLE timing (patch 0099), read through the harness-only worker message
// validationReadAxHleStats, which copies the core's DolphinWeb_AxHleStats
// struct. AX HLE runs a whole audio command list synchronously inside the DSP
// mailbox MMIO write, on the CPU thread (research/deep-thread-budget.md §2).
// Layout v1 (64 bytes, little-endian):
//   +0 u32 version  +4 u32 sizeBytes  +8 u32 on  +12 u32 reserved
//   then f64 from +16: mailMs (host time in the mail handling), mails,
//   mailMaxMs, windowMs (host time from the reset to the last mail), 2 spares.
// DolphinWeb_AxHleStats(n): n >= 0 zeroes the counters and turns them on
// from the next mail (the CPU thread applies it there); n < 0 only reads.
import { round } from "./stats.mjs";

export const AX_STATS_VERSION = 1;
export const AX_STATS_BYTES = 64;
const F64 = ["mailMs", "mails", "mailMaxMs", "windowMs"];

export function decodeAxStats(bytes) {
  if (!bytes || bytes.length < 16) return { error: `AX stats: ${bytes?.length ?? 0} bytes, no header` };
  const view = new DataView(Uint8Array.from(bytes).buffer);
  const version = view.getUint32(0, true), size = view.getUint32(4, true);
  if (version !== AX_STATS_VERSION) return { error: `AX stats: layout version ${version}, this harness reads ${AX_STATS_VERSION}` };
  if (size < AX_STATS_BYTES || bytes.length < AX_STATS_BYTES) return { error: `AX stats: struct of ${size} bytes (${bytes.length} copied), v1 needs ${AX_STATS_BYTES}` };
  const out = { version, sizeBytes: size, on: view.getUint32(8, true) === 1 };
  F64.forEach((name, i) => { out[name] = view.getFloat64(16 + i * 8, true); });
  for (const name of F64) if (!Number.isFinite(out[name]) || out[name] < 0) return { error: `AX stats: ${name} = ${out[name]}` };
  if (out.mailMaxMs > out.mailMs || (out.windowMs > 0 && out.mailMs > out.windowMs)) return { error: `AX stats: mailMs ${out.mailMs}, mailMaxMs ${out.mailMaxMs}, windowMs ${out.windowMs} do not add up` };
  return out;
}

// Two copies taken back to back while the CPU thread keeps counting: a
// counter that went backwards means a torn read (or a reset in between).
export function consistentAxRead(a, b) {
  if (a.error) return a;
  if (b.error) return b;
  const back = F64.filter((f) => f !== "mailMaxMs" && b[f] < a[f]);
  return back.length ? { error: `AX stats: torn read (${back.join(", ")} went backwards)` } : a;
}

// One window: the AX share of the CPU thread's host time. shareOfWindow is
// over the core's own window (reset to last mail); shareOfActive divides by
// the CPU thread's occupancy (busiest renderer thread, %, sampled by the
// probe), so a capped scene that sleeps in the throttle is not understated.
export function axShares(s, busiestThreadPct = null) {
  if (!s || s.error) return null;
  if (!s.on) return { error: "AX stats: counters not on (no mailbox write since the reset)" };
  if (!(s.windowMs > 0) || !s.mails) return { error: `AX stats: ${s.mails} mail(s) over ${s.windowMs} ms` };
  const shareOfWindow = s.mailMs / s.windowMs;
  const occupancy = Number.isFinite(busiestThreadPct) && busiestThreadPct > 0 ? Math.min(busiestThreadPct, 100) / 100 : null;
  return {
    shareOfWindow: round(shareOfWindow, 4),
    shareOfActive: occupancy ? round(Math.min(shareOfWindow / occupancy, 1), 4) : null,
    msPerSecond: round((s.mailMs / s.windowMs) * 1000, 2),
    mailsPerSecond: round((s.mails / s.windowMs) * 1000, 1),
    meanMailUs: round((s.mailMs / s.mails) * 1000, 1),
    mailMaxMs: round(s.mailMaxMs, 3),
    mails: s.mails,
    windowMs: round(s.windowMs, 0),
    busiestThreadPct: busiestThreadPct ?? null
  };
}
