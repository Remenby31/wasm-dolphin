// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// A measurement window defined in EMULATED time (--emulated-window).
//
// With a window of S host seconds, a faster side covers another stretch of
// the scene (another idle share): two sides then differ in host work per
// guest cycle, and in speed, without either being slower (bench, PROGRAM.md
// 2026-10-22). Here every launch starts from the same guest tick: the
// savestate is loaded, the core paused, the key pressed, the core resumed;
// it then runs W guest seconds of warmup, and the window covers S guest
// seconds from there. The core has no exact stop: node polls its ticks
// (validationReadCoreProgress) every pollMs, so the window overshoots its
// target by up to one poll; the speed and the counters are divided by the
// ticks actually covered, so the overshoot adds noise, never bias.
import { readCoreProgress, workerRequest } from "./browser.mjs";

// Guest ticks now, with the node time of the reply.
export async function ticksNow(page) {
  const p = await readCoreProgress(page);
  return { ticks: Number(p?.coreTicks ?? NaN), perSecond: Number(p?.coreTicksPerSecond ?? NaN), at: Date.now() };
}

// Polls until the core reaches `target` ticks; onPoll(t) after every read.
export async function waitTicks(page, target, { everyMs = 100, timeoutMs = 600000, onPoll } = {}) {
  const end = Date.now() + timeoutMs;
  let polls = 0;
  for (;;) {
    const t = await ticksNow(page);
    polls += 1;
    if (onPoll) onPoll(t);
    if (t.ticks >= target) return { ...t, polls };
    if (Date.now() > end) throw new Error(`guest ticks stuck at ${t.ticks} (target ${Math.round(target)}) after ${timeoutMs / 1000} s`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

// The record of one window from its tick reads (pure: tested).
export function emulatedRecord({ t0, begin, end, target, secs, warmup, pollMs }) {
  const guestTicks = end.ticks - begin.ticks, hostMs = end.at - begin.at;
  const guestSecondsCovered = guestTicks / t0.perSecond;
  return {
    emulatedWindow: { secs, warmup, pollMs, polls: end.polls ?? null },
    guestTicksStart: begin.ticks, guestTicksEnd: end.ticks, guestTicks,
    guestSecondsCovered: Math.round(guestSecondsCovered * 1e4) / 1e4,
    hostMs,
    // Ticks past the target at the read that ended the window.
    overshootTicks: end.ticks - Math.ceil(target),
    warmupTicks: begin.ticks - t0.ticks,
    ticksPerSecond: t0.perSecond,
    speed: hostMs > 0 ? Math.round((guestSecondsCovered / (hostMs / 1000)) * 1e4) / 100 : null
  };
}

// The start of an emulated run, the savestate already loaded: pause, press()
// (the caller releases the key), resume, then W guest seconds of warmup.
// Returns window(secs, { poll }): S guest seconds from the next read;
// poll(t, fraction) after every read inside it.
export async function emulatedStart(page, { warmup, pollMs = 100, timeoutMs = 600000, press }) {
  await workerRequest(page, "pause", {}, 30000);
  if (press) await press();
  await workerRequest(page, "resume", {}, 30000);
  const t0 = await ticksNow(page);
  if (!Number.isFinite(t0.ticks) || !(t0.perSecond > 0)) throw new Error("no guest ticks from this core (validationReadCoreProgress)");
  await waitTicks(page, t0.ticks + warmup * t0.perSecond, { everyMs: pollMs, timeoutMs });
  return {
    t0,
    async window(secs, { poll } = {}) {
      const begin = await ticksNow(page);
      const target = begin.ticks + secs * t0.perSecond;
      const end = await waitTicks(page, target, {
        everyMs: pollMs, timeoutMs,
        onPoll: poll && ((t) => poll(t, (t.ticks - begin.ticks) / (target - begin.ticks)))
      });
      return emulatedRecord({ t0, begin, end, target, secs, warmup, pollMs });
    }
  };
}

// One window with hooks just before its first and after its last tick read
// (race-multi's counters).
export async function emulatedWindow(page, { secs, warmup, pollMs = 100, timeoutMs = 600000 }, { press, start, end: finish } = {}) {
  const run = await emulatedStart(page, { warmup, pollMs, timeoutMs, press });
  if (start) await start();
  const record = await run.window(secs);
  const finished = finish ? await finish() : undefined;
  return { record, finished };
}
