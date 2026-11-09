// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// The CPU clamp's calibration search (research/pc-windows-kit.md §2),
// driven from the Mac by pc-run.mjs calibrateFromMac: the clamp needs the
// elevated ssh session, the bench runs as the user's non-elevated job.
//   1. the kit's power scheme with no cap, the bench -> the host's own
//      score s0 (the class affinity already applies);
//   2. target = s0 x GB6(i5-12400) / GB6(host) (lib/pc-kit.mjs PUBLIC_GB6,
//      one Geekbench snapshot);
//   3. the maximum processor frequency (MHz) searched until the score is
//      within 2 % of the target (nextProbe); if the firmware ignores it
//      (the score does not move), the maximum processor state (%) instead;
//   4. the choice and every probe returned.
import { calibrationTarget, knobIneffective, nextProbe, PUBLIC_GB6, REFERENCE_CPU } from "../../lib/pc-kit.mjs";

// The search itself, its I/O injected (tests drive it with a model CPU).
//   bench(): a score; clamp({ maxMhz, statePct, boostMode }): applies it.
export async function calibrate({ bench, clamp, hostGb6, referenceGb6 = PUBLIC_GB6[REFERENCE_CPU], turboMhz = null, tol = 0.02, log = () => {} }) {
  await clamp({ maxMhz: 0 });
  const s0 = await bench();
  const t = calibrationTarget({ unclampedScore: s0, hostGb6, referenceGb6 });
  log(`unclamped ${s0}, ratio ${t.ratio}, target ${t.target}`);
  const out = { unclampedScore: s0, ...t, hostGb6, referenceGb6, tol, knobs: [] };
  if (!t.needed) return { ...out, chosen: { maxMhz: 0 }, why: "the host is not faster than the reference: no clamp" };
  const run = async (knob, lo, hi, first, apply) => {
    const points = [];
    let x = first;
    for (;;) {
      await apply(x);
      const score = await bench();
      points.push({ x, score });
      log(`${knob} ${x}: ${score} (${Math.round((score / t.target - 1) * 1000) / 10} %)`);
      if (points.length === 3 && knobIneffective(points)) return { knob, points, ineffective: true };
      const n = nextProbe(points, t.target, { lo, hi, tol, step: knob === "maxMhz" ? 50 : 1, minStep: knob === "maxMhz" ? 100 : 2 });
      if (n.done) return { knob, points, best: n.best, errPct: n.errPct, why: n.why };
      x = n.next;
    }
  };
  const turbo = turboMhz ?? 5000;
  const f = await run("maxMhz", 800, 7000, Math.round((turbo * t.ratio) / 50) * 50, (x) => clamp({ maxMhz: x }));
  out.knobs.push(f);
  if (!f.ineffective && f.errPct > 2 * tol * 100) return { ...out, chosen: null, errPct: f.errPct, why: `the MHz cap gets no closer than ${f.errPct} % to the target` };
  if (!f.ineffective) return { ...out, chosen: { maxMhz: f.best.x }, errPct: f.errPct, why: f.why };
  // Maximum processor state: "a percentage of maximum processor frequency"
  // (Microsoft's tuning guide), boost left as it is (with boost off the
  // ceiling falls to the base clock, often under the reference's turbo).
  log("the MHz cap does not move the score: maximum processor state (%) instead");
  const s = await run("statePct", 30, 100, Math.round(100 * t.ratio), (x) => clamp({ maxMhz: 0, statePct: x }));
  out.knobs.push(s);
  if (s.ineffective) return { ...out, chosen: null, why: "neither knob moves the score: the firmware owns the clock (BIOS), clamp by hand" };
  if (s.errPct > 2 * tol * 100) return { ...out, chosen: null, errPct: s.errPct, why: `the processor state gets no closer than ${s.errPct} % to the target` };
  return { ...out, chosen: { maxMhz: 0, statePct: s.best.x }, errPct: s.errPct, why: s.why };
}
