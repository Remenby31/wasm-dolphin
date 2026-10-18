import assert from "node:assert/strict";
import test from "node:test";

import { imageFromDol } from "../src/aot-image.js";
import { AotOptimizer, fakeCompiler } from "../src/aot-optimizer.js";
import { planDol } from "../src/aot-plan.js";
import { asm, assemble, buildDol } from "./aot-asm.mjs";

const TEXT = 0x80003100;

// Entry calling N small functions of growing size.
function plan(n = 40) {
  const items = ["entry"];
  for (let i = 0; i < n; i++) items.push((pc, l) => asm.bl(pc, l[`f${i}`]));
  items.push(asm.blr());
  for (let i = 0; i < n; i++) {
    items.push(`f${i}`);
    for (let k = 0; k <= i; k++) items.push(asm.li(3, i * 100 + k));
    items.push(asm.blr());
  }
  const t = assemble(TEXT, items);
  const { image, entryPoint } = imageFromDol(buildDol({ textAddr: TEXT, text: t.words, entry: t.labels.entry }));
  return planDol({ image, entryPoint, options: { gapFill: false } });
}

function optimizer(compiler, extra = {}) {
  const p = plan();
  let builds = 0;
  const o = new AotOptimizer({ discKey: "disc", compilerVersion: "fake-1", compiler, buildPlan: async () => { builds++; return p; }, ...extra });
  const events = [];
  for (const type of ["optimization-progress", "optimization-done", "optimization-error"]) o.addEventListener(type, (e) => events.push([type, e.detail]));
  return { o, events, builds: () => builds };
}

test("aot optimizer: first launch compiles every region, second launch is complete", async () => {
  const compiler = fakeCompiler();
  const { o, events } = optimizer(compiler);
  assert.deepEqual(await o.status(), { state: "none", fraction: 0 });
  await o.start();
  const fractions = events.filter(([t]) => t === "optimization-progress").map(([, d]) => d.fraction);
  assert.ok(fractions.every((f, i) => !i || f >= fractions[i - 1]), "progress is monotonic");
  assert.equal(fractions.at(-1), 1);
  assert.equal(events.at(-1)[0], "optimization-done");
  const again = optimizer(compiler);
  assert.deepEqual(await again.o.status(), { state: "complete", fraction: 1 });
});

test("aot optimizer: cancel keeps what was compiled and a restart resumes", async () => {
  const compiler = fakeCompiler({ msPerKiB: 40 });
  const first = optimizer(compiler, { batchSize: 4 });
  first.o.addEventListener("optimization-progress", (e) => { if (e.detail.done > 0) first.o.cancel(); });
  await first.o.start();
  assert.ok(!first.events.some(([t]) => t === "optimization-done"));
  const st = await first.o.status();
  assert.equal(st.state, "partial");
  const before = compiler.persisted.size;
  const second = optimizer(compiler);
  await second.o.start({ resume: true });
  assert.deepEqual(await second.o.status(), { state: "complete", fraction: 1 });
  const submitted = second.events.filter(([t]) => t === "optimization-progress")[0][1].done;
  assert.ok(submitted >= before - 1, "the restart starts from the persisted regions");
});

test("aot optimizer: refused regions are not fatal and progress still ends at 1", async () => {
  const p = plan();
  const refuse = new Set([p.modules[0].functions[3].hash]);
  const { o, events } = optimizer(fakeCompiler({ refuse }));
  await o.start();
  const errors = events.filter(([t]) => t === "optimization-error").map(([, d]) => d);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].fatal, false);
  assert.equal(events.at(-1)[0], "optimization-done");
  assert.equal(events.at(-1)[1].refused, 1);
});

test("aot optimizer: the plan is cached and a stale or broken cached plan is rebuilt", async () => {
  const saved = new Map();
  const planStore = { load: async (k) => saved.get(k) ?? null, save: async (k, p) => { saved.set(k, p); } };
  const a = optimizer(fakeCompiler(), { planStore });
  await a.o.status();
  assert.equal(a.builds(), 1);
  const b = optimizer(fakeCompiler(), { planStore });
  await b.o.status();
  assert.equal(b.builds(), 0, "second launch reuses the cached plan");
  saved.set("disc", { ...saved.get("disc"), analyzer: -1 });
  const c = optimizer(fakeCompiler(), { planStore });
  await c.o.status();
  assert.equal(c.builds(), 1);
});

test("aot optimizer: a compiler that cannot open is a fatal error, never a throw", async () => {
  const { o, events } = optimizer({ open: async () => { throw new Error("no worker"); } });
  await o.start();
  assert.deepEqual(events.at(-1), ["optimization-error", { message: "no worker", fatal: true }]);
});
