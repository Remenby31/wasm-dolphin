import assert from "node:assert/strict";
import test from "node:test";
import { createLoopProfile } from "../src/loop-profile.js";

test("loop profile: timed by label only once on; timers patched by name", async () => {
  let t = 0;
  const lp = createLoopProfile({ now: () => t });
  const work = lp.wrap("message:work", (ms) => { t += ms; return ms; });
  work(5);
  assert.deepEqual(lp.read().entries, [], "off: nothing recorded");
  lp.start();
  assert.equal(work(3), 3, "the callback's result is kept");
  work(7);
  const byType = lp.wrap(([data]) => `message:${data.type}`, () => { t += 2; });
  byType({ type: "readDisc" });
  const r = lp.read();
  assert.deepEqual(r.entries[0], { label: "message:work", ms: 10, n: 2, maxMs: 7 });
  assert.deepEqual(r.entries[1], { label: "message:readDisc", ms: 2, n: 1, maxMs: 2 });
  assert.equal(r.totalMs, 12);
  const g = { setTimeout: (fn) => fn() };
  lp.patchTimers(g);
  lp.patchTimers(g); // once
  g.setTimeout(function audioTick() { t += 4; }, 10);
  assert.equal(lp.read().entries.find((e) => e.label === "setTimeout:audioTick").ms, 4);
  lp.stop();
  work(1);
  assert.equal(lp.read().entries.find((e) => e.label === "message:work").n, 2, "stopped: nothing more");
});
