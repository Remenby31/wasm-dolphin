// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { acquirePerfLock, queueDir } from "../harness/lib/perf-lock.mjs";
import { calmUnderLock } from "../harness/lib/env.mjs";

// A measure on battery is another machine (2026-10-26/27: several ran
// unnoticed on battery). A measure's lock (requireMains) waits for mains
// before taking a ticket, gives its turn back if unplugged meanwhile, and
// says whether the power changed while held.
function lockDir(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "harness-test-mains-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return path.join(root, ".perf-lock");
}

test("requireMains: waits on battery without a ticket, takes the lock on mains, reports a change", async (t) => {
  const dir = lockDir(t);
  let source = "battery", sleeps = 0, ticketsWhileWaiting = 0;
  const power = () => ({ source });
  const release = await acquirePerfLock({
    dir, name: "measure", requireMains: true, power, waitSec: 600, pollSec: 1,
    sleep: async () => {
      sleeps += 1;
      // nobody behind it is blocked: no ticket while it waits for mains
      try { ticketsWhileWaiting += readdirSync(queueDir(dir)).length; } catch { /* no queue yet: no ticket */ }
      if (sleeps === 3) source = "ac";
    }
  });
  assert.equal(sleeps, 3);
  assert.equal(ticketsWhileWaiting, 0);
  assert.equal(release.powerSource, "ac");
  assert.equal(release.powerChanged(), false);
  source = "battery";
  assert.equal(release.powerChanged(), true);
  release();
});

test("requireMains: still on battery after waitSec is an error, nothing taken", async (t) => {
  const dir = lockDir(t);
  await assert.rejects(acquirePerfLock({ dir, name: "measure", requireMains: true, power: () => ({ source: "battery" }), waitSec: 0, sleep: async () => {} }), /on battery/);
});

test("without requireMains (an e2e, a build): battery changes nothing", async (t) => {
  const dir = lockDir(t);
  const release = await acquirePerfLock({ dir, name: "e2e", power: () => ({ source: "battery" }) });
  assert.equal(release.powerChanged(), false);
  release();
});

test("no battery at all (a desktop): requireMains takes the lock at once", async (t) => {
  const dir = lockDir(t);
  const release = await acquirePerfLock({ dir, name: "measure", requireMains: true, power: () => null, sleep: async () => { throw new Error("no wait"); } });
  assert.equal(release.powerChanged(), false);
  release();
});

test("calmUnderLock: unplugged under the lock, the lock goes back and is taken again (the run played again)", async () => {
  const events = [];
  const lock = () => events.push("released");
  lock.powerChanged = () => true;
  const again = () => events.push("released again");
  again.powerChanged = () => false;
  const acquire = async () => { events.push("acquired"); return again; };
  const g = await calmUnderLock({ lock, maxLoad: 4, waitSec: 300, acquire, wait: async () => ({ ok: true }), load: () => 1, log: () => {} });
  assert.deepEqual(events, ["released", "acquired"]);
  assert.equal(g.relocked, true);
  assert.equal(g.lock, again);
  // on mains all along: unchanged behaviour
  const calm = await calmUnderLock({ lock: again, maxLoad: 4, waitSec: 300, acquire, wait: async () => ({ ok: true }), load: () => 1 });
  assert.equal(calm.relocked, false);
});

// Review of #305.
test("powerChanged: only a switch to battery; a failed reading (null) or AC <-> UPS is no change", async (t) => {
  const dir = lockDir(t);
  let source = "ac";
  const release = await acquirePerfLock({ dir, name: "measure", requireMains: true, power: () => (source === null ? null : { source }) });
  for (const [now, changed] of [["ac", false], [null, false], ["UPS Power", false], ["battery", true]]) {
    source = now;
    assert.equal(release.powerChanged(), changed, String(now));
  }
  release();
});

test("calmUnderLock: back on mains after a power relock, the load gate still applies", async () => {
  const lock = () => {};
  lock.powerChanged = () => true;
  const again = () => {};
  again.powerChanged = () => false;
  let waited = 0;
  const g = await calmUnderLock({ lock, maxLoad: 4, waitSec: 300, acquire: async () => again, load: () => 9, wait: async () => { waited += 1; return { ok: true, load: 3, limit: 4 }; }, log: () => {} });
  assert.equal(waited, 1, "loaded once back on mains: waited for calm too");
  assert.equal(g.relocked, true);
});

test("drop meter: a visit played again goes through the gate (power, load) first", async () => {
  const { gateBeforeReplay } = await import("../harness/probes/drop-meter.mjs");
  const { calmLock } = await import("../harness/lib/env.mjs");
  const events = [];
  let onBattery = false;
  const mk = (tag) => { const r = () => events.push(`release ${tag}`); r.powerChanged = () => onBattery; return r; };
  let n = 0;
  // a fixed load: the machine's own (above 100 under a heavy build) would add a release and acquire of its own
  const lock = await calmLock({ maxLoad: 100, calmWait: 0, acquire: async () => { n += 1; events.push(`acquire ${n}`); return mk(n); }, wait: async () => ({ ok: true }), load: () => 1 });
  onBattery = true; // unplugged during the visit
  const acquireNow = lock;
  // the next acquire happens once on mains (acquirePerfLock waits for it): modelled as plugged back
  const realAcquire = events.length;
  onBattery = true;
  const replay = gateBeforeReplay(acquireNow, { waitSec: 300 });
  onBattery = false;
  const r = await replay;
  assert.equal(r.gaveUp, null);
  assert.deepEqual(events.slice(realAcquire), ["release 1", "acquire 2"], "the lock went back and was taken again before the replay");
});

test("--allow-battery still works: the rendering probes gate on mains only without it", async () => {
  const { readFile } = await import("node:fs/promises");
  for (const f of ["savestate-scale", "stream-capture-cost"]) {
    const src = await readFile(new URL(`../harness/probes/${f}.mjs`, import.meta.url), "utf8");
    assert.match(src, /acquirePerfLock\(\{ requireMains: !o\["allow-battery"\], /, f);
    assert.doesNotMatch(src, /process\.exit\(3\);\n\}\nconst release = await acquirePerfLock/, `${f}: no early exit on battery, the lock waits`);
  }
});

// Re-review of #305.
test("drop meter: a side whose gate or replay gives up ends the run and the batch; a later calm side never clears it", async () => {
  const { runSides } = await import("../harness/probes/drop-meter.mjs");
  const played = [];
  // the candidate's replay gives up (unplugged, never back), the baseline's gate would be calm
  const gaveUp = await runSides(["candidate", "baseline"], {
    gate: async () => ({ gate: { ok: true }, gaveUp: null }),
    play: async (name) => { played.push(name); return { gaveUp: name === "candidate" ? "on battery: given up" : null }; }
  });
  assert.equal(gaveUp, "on battery: given up");
  assert.deepEqual(played, ["candidate"], "the baseline is not played after a give-up");
  // a gate that gives up: nothing played on that side or after
  const played2 = [];
  const g2 = await runSides(["baseline", "candidate"], {
    gate: async (name) => ({ gate: {}, gaveUp: name === "baseline" ? "load given up" : null }),
    play: async (name) => { played2.push(name); return {}; }
  });
  assert.equal(g2, "load given up");
  assert.deepEqual(played2, []);
  // and the give-up reaches the summary: no verdict
  const { noVerdictReasons } = await import("../harness/probes/drop-meter.mjs");
  assert.match(noVerdictReasons({ analyses: [], visits: 1, gaveUp, verdicts: {} }).join(), /on battery: given up/);
});

test("race-perf: a side measured partly on battery is dropped; an unplug counts once; the give-up names power", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../harness/probes/race-perf.mjs", import.meta.url), "utf8");
  const branch = src.slice(src.indexOf('if (powerSnapshot()?.source === "battery" && powerAtStart !== "battery")'));
  assert.ok(branch.indexOf("delete record[name];") > 0 && branch.indexOf("delete record[name];") < branch.indexOf("replay = true;"), "dropped before any give-up or replay");
  assert.match(src, /if \(powerCounted\) powerCounted = false;\n\s+else relocks \+= 1;/);
  assert.match(src, /unplugged or loaded \$\{relocks\} times \(the lock let go for power or load\)/);
});

// 2026-10-29: "AC attached" all night while the charge fell 72 -> 54 % (the
// charger not keeping up). A measure needs the charge not falling and above
// MIN_BATTERY_PERCENT; a visit where it fell is left out like an overloaded one.
test("requireMains: on mains under 30 % charge waits like battery; at 30 % and up it takes the lock", async (t) => {
  const dir = lockDir(t);
  let percent = 22, sleeps = 0;
  const release = await acquirePerfLock({
    dir, name: "measure", requireMains: true, power: () => ({ source: "ac", percent }), waitSec: 600, pollSec: 1,
    sleep: async () => { sleeps += 1; if (sleeps === 2) percent = 30; }
  });
  assert.equal(sleeps, 2);
  release();
  // without requireMains (an e2e, a build) the charge changes nothing
  const r2 = await acquirePerfLock({ dir, name: "e2e", power: () => ({ source: "ac", percent: 5 }), waitSec: 0, sleep: async () => { throw new Error("waited"); } });
  r2();
});

test("drop meter: a visit whose charge fell on mains, or ended under 30 %, is a power-draining one", async () => {
  const { powerDrained, MIN_BATTERY_PERCENT } = await import("../harness/lib/system.mjs");
  const { visitPowerDrained, noVerdictReasons } = await import("../harness/probes/drop-meter.mjs");
  assert.equal(MIN_BATTERY_PERCENT, 30);
  assert.equal(powerDrained({ source: "ac", percent: 72 }, { source: "ac", percent: 71 }), true, "fell by 1 %");
  assert.equal(powerDrained({ source: "ac", percent: 72 }, { source: "ac", percent: 72 }), false);
  assert.equal(powerDrained({ source: "ac", percent: 60 }, { source: "ac", percent: 61 }), false, "charging");
  assert.equal(powerDrained({ source: "ac", percent: 29 }, { source: "ac", percent: 29 }), true, "under 30 %");
  assert.equal(powerDrained({ source: "ac", percent: null }, null), false, "unknown: not drained");
  assert.equal(powerDrained(null, null), false, "a desktop");
  assert.equal(visitPowerDrained({ power: { source: "ac", percent: 54 }, powerEnd: { source: "ac", percent: 53 } }), true);
  // left out of the usable runs, as overloaded ones are
  const run = (side, n, drained) => ({ side, run: n, visit: 1, analysis: { sampled: true, power: "ac", powerDrained: drained } });
  const analyses = [run("baseline", 1, false), run("baseline", 2, true), run("baseline", 3, true), run("candidate", 1, false), run("candidate", 2, false), run("candidate", 3, false)];
  const reasons = noVerdictReasons({ analyses, visits: 1, verdicts: { 1: {} } });
  assert.ok(reasons.some((r) => /visit 1: 1 usable baseline run\(s\) \(errors, overloaded and power-draining runs left out\)/.test(r)), reasons.join("; "));
});

// race-perf decides speed: a side whose charge fell on mains (or ended under
// 30 %) is marked POWER and left out of every paired change, as an
// overloaded side is.
test("race-perf: a power-draining side is marked, logged POWER and left out of the paired changes", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../harness/probes/race-perf.mjs", import.meta.url), "utf8");
  assert.match(src, /if \(r && powerDrained\(powerStart, powerEnd\)\) \{\n\s+r\.powerDrained = \{ start: powerStart\?\.percent \?\? null, end: powerEnd\?\.percent \?\? null \};/);
  assert.match(src, /: POWER, charge /);
  assert.match(src, /const good = \(r\) => r && !r\.error && !r\.fatal\?\.length && !r\.powerDrained && /);
  // every paired change takes good() runs only
  const changes = src.match(/pairedSpeedChange\(runsDone\.filter\(\(r\) => good\(r\.baseline\) && good\(r\.candidate\)\)/g) ?? [];
  assert.ok(changes.length >= 3, `${changes.length} changes on good() runs`);
  assert.match(src, /r\[n\]\?\.powerDrained \? `power: charge /);
});
