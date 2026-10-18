// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
// Unit tests for the consumer-machine runner (docs/consumer-perf.md): backend
// choice, label, CPU busy, presenter, blank pictures, the checkout root on
// every system, and the emulated-time steps.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { repoRootOf } from "../harness/lib/browser.mjs";
import { cpuBusy, isBlankFrame, pickBackends, presenterOf, sanitizeLabel, WGPU_FEATURES } from "../harness/lib/consumer.mjs";
import { emulatedWait, runSteps, validateSteps } from "../harness/lib/steps.mjs";

const real = { available: true, fallback: false, missingFeatures: [] };

test("auto runs wgpu only on a real adapter with every feature, software otherwise", () => {
  assert.deepEqual(pickBackends(real), { backends: ["wgpu"], wgpuOk: true, why: null });
  assert.deepEqual(pickBackends({ available: false, why: "navigator.gpu missing" }).backends, ["soft"]);
  assert.equal(pickBackends({ available: false, why: "navigator.gpu missing" }).why, "navigator.gpu missing");
  assert.deepEqual(pickBackends({ ...real, fallback: true }), { backends: ["soft"], wgpuOk: false, why: "fallback (software) adapter" });
  const missing = pickBackends({ ...real, missingFeatures: [WGPU_FEATURES[2]] });
  assert.deepEqual(missing.backends, ["soft"]);
  assert.equal(missing.why, "missing dual-source-blending");
  assert.deepEqual(pickBackends(null).backends, ["soft"]);
});

test("an explicit backend is honoured, and an unknown one refused", () => {
  assert.deepEqual(pickBackends({ ...real, fallback: true }, "wgpu").backends, ["wgpu"]);
  assert.deepEqual(pickBackends(real, "soft").backends, ["soft"]);
  assert.deepEqual(pickBackends(real, "both").backends, ["wgpu", "soft"]);
  assert.throws(() => pickBackends(real, "metal"), /auto, wgpu, soft or both/);
});

test("labels are one safe path segment", () => {
  assert.equal(sanitizeLabel("Jérôme's PC (salon)"), "Jerome_s_PC_salon");
  assert.equal(sanitizeLabel("../../etc"), "etc");
  assert.equal(sanitizeLabel("C:\\Users\\x"), "C_Users_x");
  assert.equal(sanitizeLabel(""), "machine");
  assert.equal(sanitizeLabel("x".repeat(100)).length, 64);
});

test("CPU busy comes from os.cpus() deltas (Windows has no load average)", () => {
  const cpu = (user, idle) => ({ times: { user, nice: 0, sys: 0, idle, irq: 0 } });
  const r = cpuBusy([cpu(0, 0), cpu(0, 0)], [cpu(750, 250), cpu(250, 750)]);
  assert.deepEqual(r, { percent: 50, cores: 1 });
  assert.deepEqual(cpuBusy([cpu(5, 5)], [cpu(5, 5)]), { percent: 0, cores: 0 });
});

test("the presenter is read from the page's telemetry", () => {
  assert.equal(presenterOf("jit:on warm:700 present webgpu signal:wait mode:smooth"), "webgpu");
  assert.equal(presenterOf("no presenter here"), null);
  assert.equal(presenterOf(undefined), null);
});

test("a uniform picture is blank, a textured one is not", () => {
  const frame = (fill) => {
    const data = new Uint8Array(160 * 120 * 4);
    for (let i = 0; i < data.length; i += 4) { const v = fill(i / 4); data[i] = data[i + 1] = data[i + 2] = v; data[i + 3] = 255; }
    return { width: 160, height: 120, data };
  };
  assert.equal(isBlankFrame(frame(() => 0)), true);
  assert.equal(isBlankFrame(frame(() => 128)), true);
  assert.equal(isBlankFrame(frame((p) => ((p % 160) ^ Math.floor(p / 160)) & 0xff)), false);
});

test("the checkout root is a file system path on Windows and with spaces or accents", () => {
  assert.equal(repoRootOf("file:///C:/Users/J%C3%A9r%C3%B4me%20D/wasm%20dolphin/harness/lib/browser.mjs", { windows: true }), "C:\\Users\\Jérôme D\\wasm dolphin");
  assert.equal(repoRootOf("file:///home/a%20b/r%C3%A9po/harness/lib/browser.mjs", { windows: false }), "/home/a b/répo");
  assert.equal(repoRootOf("file:///srv/repo/harness/lib/browser.mjs", { windows: false }), "/srv/repo");
});

test("emulated waits count the core's frames, and give up on a stalled core", async () => {
  let frame = 0, clock = 0;
  const poll = async (ms) => { clock += ms; frame += Math.round(ms * 0.03); }; // the game runs at half speed
  const wait = emulatedWait(async () => frame, { poll, now: () => clock });
  await wait(1000);
  assert.ok(frame >= 60, `60 VI outputs for 1 s of game time, got ${frame}`);
  assert.ok(clock >= 2000, "a half-speed game takes twice the host time");
  const stalled = emulatedWait(async () => 0, { poll: async (ms) => { clock += ms; }, now: () => clock, maxFactor: 3 });
  await assert.rejects(stalled(100), /not reached/);
});

test("steps go through the wait they are given, and the race steps are valid", async () => {
  const waited = [];
  const page = { keyboard: { down: async () => {}, up: async () => {} }, mouse: { click: async () => {} }, waitForTimeout: async () => { throw new Error("host clock used"); } };
  await runSteps(page, [{ wait: 2 }, { tap: "KeyX", repeat: 2, every: 1 }], { wait: async (ms) => { waited.push(ms); } });
  assert.deepEqual(waited, [2000, 120, 880, 120, 880]);
  validateSteps(JSON.parse(readFileSync(new URL("../harness/probes/local-race-steps.json", import.meta.url), "utf8")));
});
