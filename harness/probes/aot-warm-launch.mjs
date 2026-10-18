#!/usr/bin/env node
// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
// Second-launch probe for the JIT cache (plan piste 3, P5/P6). Headless only.
//
//   seed     boot a disc on a persistent profile, play the steps and `--play`
//            seconds more, wait until the JIT cache is persisted, keep the profile.
//   measure  for each run and each side (served tree), clone the seeded profile
//            (APFS clone), boot again and record the timeline from load to
//            `--sec` seconds after the steps: frame p99, speed, hitches, the
//            core's module compile/instance counters and the compiler worker's.
//            Sides alternate which goes first on each run.
//
// node harness/probes/aot-warm-launch.mjs seed --tree . --iso disc.iso --steps s.json --profile DIR
// node harness/probes/aot-warm-launch.mjs measure --side main=DIR --side head=DIR --iso disc.iso \
//      --steps s.json --seed-profile DIR --runs 3 --sec 60 --out DIR
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { bootIso, grabFrame, launchChrome, readTimeline, workerRequest } from "../lib/browser.mjs";
import { ensureServer } from "../lib/server.mjs";
import { savePng } from "../lib/session.mjs";
import { runSteps } from "../lib/steps.mjs";
import { machineSnapshot } from "../lib/system.mjs";
import { coreStats, mergeTimeline, presentationStats, windowOf } from "../lib/timeline.mjs";

const PRESET = "core=upstream&video=software&presenter=webgpu&cpu=dual&speed=1&wasmjit=1&jitwarmup=700&oc=1&pacing=tick&fastsw=1&metrics=1";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    tree: { type: "string", default: "." },
    side: { type: "string", multiple: true, default: [] },
    iso: { type: "string" },
    steps: { type: "string" },
    profile: { type: "string" },
    "seed-profile": { type: "string" },
    port: { type: "string", default: process.env.HARNESS_PORT || "8090" },
    play: { type: "string", default: "60" },
    sec: { type: "string", default: "60" },
    runs: { type: "string", default: "3" },
    launches: { type: "string", default: "1" },
    query: { type: "string", default: PRESET },
    out: { type: "string" }
  }
});
const mode = positionals[0];
const port = Number(values.port);
const steps = JSON.parse(readFileSync(values.steps, "utf8"));
const log = (m) => console.log(`[aot-probe ${new Date().toISOString().slice(11, 19)}] ${m}`);

function parseHelper(text) {
  const s = String(text || "");
  const m = s.match(/modcompile:(\d+)us\/max(\d+)us modinst:(\d+)us\/max(\d+)us modcache:(\d+)hit\/(\d+)miss/);
  return m ? { moduleUs: +m[1], moduleMaxUs: +m[2], instanceUs: +m[3], instanceMaxUs: +m[4], cacheHits: +m[5], cacheMisses: +m[6] } : null;
}

async function open({ tree, profileDir }) {
  const server = await ensureServer({ port, root: path.resolve(tree) });
  const context = await launchChrome({ profileDir });
  await context.assertInvisible("after launch");
  const page = context.pages()[0] ?? (await context.newPage());
  const consoleLines = [];
  page.on("worker", (w) => w.on?.("console", (m) => {
    const t = m.text();
    if (/\[boot-phase\]|jit-cache:/.test(t)) consoleLines.push({ t: Date.now(), text: t.slice(0, 300) });
  }));
  page.on("console", (m) => {
    const t = m.text();
    if (/jit-cache:/.test(t)) consoleLines.push({ t: Date.now(), text: t.slice(0, 300) });
  });
  return {
    server, context, page, consoleLines,
    async close() {
      await context.close().catch(() => {});
      await server.stop();
    }
  };
}

async function readiness(page) {
  return workerRequest(page, "validationReadJitCacheReadiness", {}, 15000).catch((e) => ({ error: String(e.message || e) }));
}

async function seed() {
  mkdirSync(values.profile, { recursive: true });
  const s = await open({ tree: values.tree, profileDir: values.profile });
  try {
    await bootIso(s.page, { url: `${s.server.base}?${values.query}`, iso: values.iso, timeoutMs: 120000 });
    await s.context.assertInvisible("after boot");
    await runSteps(s.page, steps);
    await s.page.waitForTimeout(Number(values.play) * 1000);
    let r = null;
    for (let i = 0; i < 120; i += 1) {
      r = await readiness(s.page);
      if (r && r.idbWritesPending === 0 && r.verificationPending === 0) break;
      await s.page.waitForTimeout(1000);
    }
    log(`seeded: cache=${r?.cacheSize} newCompiles=${r?.newCompileCount} idbWrites=${r?.idbWriteCount}`);
    writeFileSync(path.join(values.profile, "..", `${path.basename(values.profile)}.seed.json`), JSON.stringify({ readiness: r, console: s.consoleLines }, null, 1));
  } finally {
    await s.close();
  }
}

async function measureOne(name, tree, runDir, profileDir) {
  const machineBefore = machineSnapshot();
  const s = await open({ tree, profileDir });
  const chunks = [];
  const result = { side: name, machineBefore };
  try {
    const t0 = Date.now();
    await bootIso(s.page, { url: `${s.server.base}?${values.query}`, iso: values.iso, timeoutMs: 120000 });
    await s.context.assertInvisible("after boot");
    result.bootMs = Date.now() - t0;
    result.readinessAtLoad = await readiness(s.page);
    // Drain the rings every second, from load to the end of the window.
    let draining = true;
    const drain = (async () => {
      while (draining) {
        chunks.push(await readTimeline(s.page).catch((e) => ({ error: String(e.message || e) })));
        await s.page.waitForTimeout(1000);
      }
    })();
    const loadedAt = await s.page.evaluate(() => performance.timeOrigin + performance.now());
    await runSteps(s.page, steps);
    const raceAt = await s.page.evaluate(() => performance.timeOrigin + performance.now());
    await s.page.waitForTimeout(Number(values.sec) * 1000);
    const endAt = await s.page.evaluate(() => performance.timeOrigin + performance.now());
    draining = false;
    await drain;
    chunks.push(await readTimeline(s.page).catch((e) => ({ error: String(e.message || e) })));
    const timeline = mergeTimeline(chunks);
    const tps = (await workerRequest(s.page, "validationReadCoreProgress", {}, 15000).catch(() => null))?.coreTicksPerSecond ?? null;
    const win = (a, b) => {
      const w = windowOf(timeline, a, b);
      const p = presentationStats(w);
      const c = coreStats(w, { ticksPerSecond: tps, until: b });
      return { frameP50: p.frameP50, frameP95: p.frameP95, frameP99: p.frameP99, frameMax: p.frameMax, hitchesPerMin: p.hitchesPerMin, presentFreezes: p.freezes.length, coreFreezes: c.freezes?.length ?? null, speed: c.speed ?? null, speedP5: c.speedP5 ?? null };
    };
    result.timelineComplete = timeline.complete;
    // The JIT engages at a fixed emulated field: that is when the cached
    // modules are first instantiated and called.
    const progress = await workerRequest(s.page, "validationReadCoreProgress", {}, 15000).catch(() => null);
    result.jitEngagedField = progress?.jitEngagedField ?? null;
    const engage = result.jitEngagedField > 0 ? timeline.vi.find((v) => v.sinceBoot >= result.jitEngagedField) : null;
    if (engage) result.engage = win(engage.t - 1000, engage.t + 10000);
    result.menus = win(loadedAt, raceAt);
    result.race = win(raceAt, endAt);
    result.whole = win(loadedAt, endAt);
    const info = await s.page.evaluate(() => window.__lastFrameInfo?.ppcWasmHelperStats ?? "");
    result.coreModules = parseHelper(info);
    result.readinessAtEnd = await readiness(s.page);
    result.console = s.consoleLines;
    result.machineAfter = machineSnapshot();
    savePng(await grabFrame(s.page), path.join(runDir, `${name}.png`));
  } catch (e) {
    result.error = String(e.stack || e);
  } finally {
    await s.close();
  }
  return result;
}

async function measure() {
  const sides = values.side.map((s) => { const i = s.indexOf("="); return [s.slice(0, i), s.slice(i + 1)]; });
  mkdirSync(values.out, { recursive: true });
  const all = [];
  for (let run = 0; run < Number(values.runs); run += 1) {
    const order = run % 2 ? [...sides].reverse() : sides;
    const runDir = path.join(values.out, `run${run + 1}`);
    mkdirSync(runDir, { recursive: true });
    for (const [name, tree] of order) {
      // --launches N: N boots on one clone of the seeded profile (launch 2+
      // sees what launch 1 left: migrated or repacked caches).
      const profileDir = mkdtempSync(path.join(os.tmpdir(), "gc-aot-probe-"));
      rmSync(profileDir, { recursive: true, force: true });
      execFileSync("cp", ["-c", "-R", values["seed-profile"], profileDir]);
      for (let launch = 1; launch <= Number(values.launches); launch += 1) {
      const tag = Number(values.launches) > 1 ? `${name}-launch${launch}` : name;
      log(`run ${run + 1} ${tag}`);
      const r = await measureOne(tag, tree, runDir, profileDir);
      r.run = run + 1;
      r.launch = launch;
      all.push(r);
      writeFileSync(path.join(runDir, `${tag}.json`), JSON.stringify(r, null, 1));
      log(`  ${tag}: ${r.error ? "ERROR " + r.error.split("\n")[0] : `engage p99=${r.engage?.frameP99?.toFixed?.(1)} max=${r.engage?.frameMax?.toFixed?.(0)} race p99=${r.race?.frameP99?.toFixed?.(1)} menus p99=${r.menus?.frameP99?.toFixed?.(1)} speed=${r.race?.speed?.toFixed?.(1)} core=${JSON.stringify(r.coreModules)}`}`);
      }
      rmSync(profileDir, { recursive: true, force: true });
    }
  }
  writeFileSync(path.join(values.out, "all.json"), JSON.stringify(all, null, 1));
}

if (mode === "seed") await seed();
else if (mode === "measure") await measure();
else {
  console.error("usage: aot-warm-launch.mjs seed|measure …");
  process.exit(2);
}
