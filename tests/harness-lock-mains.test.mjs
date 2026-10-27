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
  const lock = await calmLock({ maxLoad: 100, calmWait: 0, acquire: async () => { n += 1; events.push(`acquire ${n}`); return mk(n); }, wait: async () => ({ ok: true }) });
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
