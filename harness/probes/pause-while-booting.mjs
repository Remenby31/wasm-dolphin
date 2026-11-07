// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// A pause asked while the game still boots must take once the core can
// hold it, as a front end that mounts a game and holds it behind its
// loading screen expects (the salon does: validationSetCorePaused every
// 100 ms until the core reports Paused, 30 s at most). After 0209 a pause
// during boot threw instead of answering "not yet", the caller stopped
// retrying, and the game ran behind the loading screen (78 and 93 frames
// in 1.5 s, salon e2e, 2026-11-01).
//
//   node harness/probes/pause-while-booting.mjs --iso disc.iso --port N
//     [--query "core=upstream&video=wgpu&cpu=dual"] [--runs 2] [--root <tree to serve>]
// Per run: boot, the caller's retry loop from the first moment the worker
// exists, then the frames over 1.5 s once it reports Paused. Pass: every
// run reached Paused and held (< 5 frames). Exit 1 otherwise.
// Holds the perf lock (Chrome, headless); a watchdog after it; always exits.
import path from "node:path";
import { parseArgs } from "node:util";

import { ensureServer, readCoreProgress } from "../lib/browser.mjs";
import { acquirePerfLock } from "../lib/perf-lock.mjs";
import { openSession } from "../lib/session.mjs";

const { values: o } = parseArgs({ options: {
  iso: { type: "string" }, port: { type: "string" }, runs: { type: "string", default: "2" },
  query: { type: "string", default: "core=upstream&video=wgpu&presenter=webgpu&cpu=dual" },
  root: { type: "string" }, "lock-wait": { type: "string", default: "3600" }
}, strict: true });
for (const k of ["iso", "port"]) if (!o[k]) throw new Error(`--${k} is required`);

export const HOLD_MAX_FRAMES = 5;

// The caller's loop, run in the page from the boot on (the salon's
// setCorePaused, salon-host.js): ask, read the core's state in the answer,
// retry every 100 ms until Paused, give up after 30 s; a rejected request
// ends the loop, as there.
function installPauseLoop() {
  const log = [];
  window.__pauseLoop = { log, reached: false, ended: null };
  const startedAt = performance.now();
  const attempt = () => {
    window.__host.adapter.request("validationSetCorePaused", { paused: true })
      .then((r) => {
        const name = r?.coreStateName ?? "";
        log.push({ at: Math.round(performance.now() - startedAt), name, error: r?.error ?? null });
        if (name === "Paused") { window.__pauseLoop.reached = true; window.__pauseLoop.ended = "paused"; return; }
        if (performance.now() - startedAt < 30000) setTimeout(attempt, 100);
        else window.__pauseLoop.ended = "gave up after 30 s";
      })
      .catch((error) => {
        log.push({ at: Math.round(performance.now() - startedAt), rejected: String(error?.message ?? error) });
        window.__pauseLoop.ended = `rejected: ${String(error?.message ?? error)}`;
      });
  };
  attempt();
}

const log = (m) => console.log(`[pause-boot] ${m}`);
const release = await acquirePerfLock({ name: "pause-while-booting", waitSec: Number(o["lock-wait"]), log });
const watchdog = setTimeout(() => { console.error("watchdog: 20 min under the lock"); release(); process.exit(2); }, 20 * 60 * 1000);
const server = await ensureServer({ port: Number(o.port), root: path.resolve(o.root ?? path.join(import.meta.dirname, "..", "..")) });
const results = [];
try {
  for (let run = 0; run < Number(o.runs); run += 1) {
    // the loop starts with the page: installed before the boot, it waits for
    // the worker, then asks at once (the core still boots)
    const session = await openSession({
      base: server.base, server, query: o.query, iso: o.iso,
      harness: {}, chromeArgs: []
    }).catch((e) => ({ error: String(e?.message || e) }));
    const r = { run };
    if (session.error) {
      r.error = session.error;
    } else {
      try {
        await session.page.evaluate(installPauseLoop);
        await session.page.waitForFunction(() => window.__pauseLoop?.ended, null, { timeout: 40000 }).catch(() => {});
        const loop = await session.page.evaluate(() => window.__pauseLoop);
        r.ended = loop.ended ?? "still running after 40 s";
        r.attempts = loop.log.length;
        r.first = loop.log[0] ?? null;
        r.last = loop.log.at(-1) ?? null;
        const f0 = (await readCoreProgress(session.page))?.frame ?? null;
        await session.page.waitForTimeout(1500);
        const f1 = (await readCoreProgress(session.page))?.frame ?? null;
        r.framesIn1500ms = f0 === null || f1 === null ? null : f1 - f0;
        r.held = loop.reached && r.framesIn1500ms !== null && r.framesIn1500ms < HOLD_MAX_FRAMES;
      } catch (e) {
        r.error = String(e?.message || e);
      } finally {
        await session.close();
      }
    }
    log(`run ${run}: ${JSON.stringify(r)}`);
    results.push(r);
  }
} finally {
  await server.stop();
  release();
  clearTimeout(watchdog);
}
const failed = results.filter((r) => !r.held);
log(failed.length ? `FAILED: ${failed.length} of ${results.length} runs did not hold the game` : `held in ${results.length}/${results.length} runs`);
process.exit(failed.length ? 1 : 0);
