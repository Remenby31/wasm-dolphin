// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
// One emulator session = fresh Chrome profile + boot one disc + observe.
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { bootIso, captureAtVi, grabFrame, launchChrome, readCoreProgress, readFrameInfo, readTimeline, REPO_ROOT, watchPage } from "./browser.mjs";
import { addGamepadMock } from "./gamepad-mock.mjs";
import { installMonitor } from "./monitor.mjs";
import { encodePng } from "./png.mjs";
import { checkCore } from "./core-identity.mjs";
import { claim } from "./ownership.mjs";
import { machineSnapshot, sampleChromeCpu } from "./system.mjs";

export async function openSession({ base, server = null, query, iso, display = "headless", gamepads = null, keepProfile = false, routes = {} }) {
  const profileDir = mkdtempSync(path.join(os.tmpdir(), "gc-harness-profile-"));
  const releaseProfile = claim(profileDir, REPO_ROOT, "chrome-profile");
  const context = await launchChrome({ profileDir, display });
  await context.assertInvisible?.("after launch");
  await context.addInitScript(installMonitor);
  if (gamepads) await addGamepadMock(context, gamepads);
  const page = context.pages()[0] ?? (await context.newPage());
  for (const [pattern, file] of Object.entries(routes)) {
    await page.route(pattern, (route) => route.fulfill({ path: file, contentType: "application/octet-stream" }));
  }
  const watch = watchPage(page);
  const url = `${base}?${query}`;
  const machineBefore = machineSnapshot();
  const startedAt = Date.now();
  const fetchedBefore = server?.coreFetches.length ?? 0;
  const boot = await bootIso(page, { url, iso });
  await context.assertInvisible?.("after boot");
  // The core really loaded must be the one asked for (core-identity.mjs).
  let core = null;
  if (server) {
    const selection = await page.evaluate(() => window.__host?.adapter?.coreSelectionTelemetry?.() ?? null).catch(() => null);
    core = checkCore({ url, defaultSha256: server.defaultCoreSha256, fetches: server.coreFetches.slice(fetchedBefore), selection });
    if (!core.ok) {
      await context.close().catch(() => {});
      releaseProfile();
      if (!keepProfile) rmSync(profileDir, { recursive: true, force: true });
      throw new Error(core.error);
    }
  }
  return {
    page,
    context,
    profileDir,
    url,
    iso,
    watch,
    machineBefore,
    startedAt,
    harness: boot.harness,
    core,
    rendererCrashed: () => watch.events.some((e) => e.type === "crash"),
    // Keep Chrome's log and crash dumps (Crashpad) of this profile in `dir`.
    keepCrashEvidence(dir) {
      mkdirSync(dir, { recursive: true });
      const kept = [];
      for (const name of ["chrome.log", "crash-dumps", "Crashpad"]) {
        const from = path.join(profileDir, name);
        if (!existsSync(from)) continue;
        cpSync(from, path.join(dir, name), { recursive: true });
        kept.push(name);
      }
      return { dir, kept };
    },
    async close() {
      await context.close().catch(() => {});
      releaseProfile();
      if (!keepProfile) rmSync(profileDir, { recursive: true, force: true });
    }
  };
}

// Boot the disc again in the same session (same profile and caches), and
// check again which core it loaded: a reboot fetches the core anew.
export async function rebootSession(session, server) {
  const before = server.coreFetches.length;
  await bootIso(session.page, { url: session.url, iso: session.iso });
  const selection = await session.page.evaluate(() => window.__host?.adapter?.coreSelectionTelemetry?.() ?? null).catch(() => null);
  const core = checkCore({ url: session.url, defaultSha256: server.defaultCoreSha256, fetches: server.coreFetches.slice(before), selection });
  if (!core.ok) throw new Error(core.error);
  session.core = core;
  return core;
}

export async function monitorSnapshot(session, reset = false) {
  return session.page.evaluate((r) => window.__harnessMonitor?.snapshot(r) ?? null, reset).catch(() => null);
}

export async function attachAudio(session) {
  return session.page.evaluate(() => window.__harnessMonitor?.attachAudio()).catch((e) => ({ attached: false, reason: String(e.message || e) }));
}

export function savePng(frame, file) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, encodePng(frame));
  return file;
}

// Sample __lastFrameInfo and Chrome CPU once per second for `seconds`.
export async function sample(session, { seconds, shotEvery = 0, shotPrefix = null, stopOnFatal = true, everySecond = null }) {
  const samples = [];
  const cpu = [];
  const shots = [];
  for (let i = 0; i < seconds; i += 1) {
    await session.page.waitForTimeout(1000);
    samples.push(await readFrameInfo(session.page));
    cpu.push(sampleChromeCpu(session.profileDir));
    if (shotEvery && shotPrefix && (i + 1) % shotEvery === 0) {
      shots.push(savePng(await grabFrame(session.page), `${shotPrefix}-t${String(i + 1).padStart(3, "0")}.png`));
    }
    if (everySecond) await everySecond(i);
    if (stopOnFatal && session.watch.fatal().length) break;
  }
  return { samples, cpu, shots };
}

export async function waitSeconds(session, seconds) {
  for (let i = 0; i < seconds * 4 && !session.watch.fatal().length; i += 1) await session.page.waitForTimeout(250);
}

// captureAtVi, cut short when the worker dies: a crash then reports as a
// crash at once instead of a capture timeout.
export async function captureInSession(session, options) {
  let stop = false;
  const died = (async () => {
    while (!stop) {
      if (session.watch.fatal().length) return { error: "worker died before the capture" };
      await new Promise((r) => setTimeout(r, 250));
    }
    return null;
  })();
  try {
    return await Promise.race([captureAtVi(session.page, options), died]);
  } finally {
    stop = true;
  }
}

export { captureAtVi, grabFrame, readCoreProgress, readTimeline };
