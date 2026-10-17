// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
// One emulator session = fresh Chrome profile + boot one disc + observe.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { bootIso, REPO_ROOT, grabFrame, launchChrome, readCoreProgress, readFrameInfo, setCorePaused, watchPage } from "./browser.mjs";
import { addGamepadMock } from "./gamepad-mock.mjs";
import { decodeMarkers } from "./markers.mjs";
import { encodePng } from "./png.mjs";
import { claim } from "./ownership.mjs";
import { machineSnapshot, sampleChromeCpu } from "./system.mjs";

export async function openSession({ base, server = null, query, iso, headed = true, gamepads = null, keepProfile = false, routes = {} }) {
  // The served tree is checked before the page loads and again when the
  // session closes; a run whose server changed in between is an error.
  await server?.verify?.();
  const profileDir = mkdtempSync(path.join(os.tmpdir(), "gc-harness-profile-"));
  const releaseProfile = claim(profileDir, REPO_ROOT, "chrome-profile");
  const context = await launchChrome({ profileDir, headed });
  if (gamepads) await addGamepadMock(context, gamepads);
  const page = context.pages()[0] ?? (await context.newPage());
  for (const [pattern, file] of Object.entries(routes)) {
    await page.route(pattern, (route) => route.fulfill({ path: file, contentType: "application/octet-stream" }));
  }
  const watch = watchPage(page);
  const url = `${base}?${query}`;
  const machineBefore = machineSnapshot();
  const startedAt = Date.now();
  await bootIso(page, { url, iso });
  return {
    page,
    context,
    profileDir,
    url,
    iso,
    watch,
    machineBefore,
    startedAt,
    async close() {
      await context.close().catch(() => {});
      releaseProfile();
      if (!keepProfile) rmSync(profileDir, { recursive: true, force: true });
      await server?.verify?.();
    }
  };
}

export function savePng(frame, file) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, encodePng(frame));
  return file;
}

// Sample __lastFrameInfo and Chrome CPU once per second for `seconds`.
export async function sample(session, { seconds, shotEvery = 0, shotPrefix = null, stopOnFatal = true }) {
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
    if (stopOnFatal && session.watch.fatal().length) break;
  }
  return { samples, cpu, shots };
}

export async function waitSeconds(session, seconds) {
  for (let i = 0; i < seconds * 4 && !session.watch.fatal().length; i += 1) await session.page.waitForTimeout(250);
}

// The worker answers validationSetCorePaused with the core state it observed.
export function assertPaused(response) {
  if (response?.paused !== true) throw new Error(`core did not pause: ${JSON.stringify({ ...response, id: undefined })}`);
  return response;
}

// A self-checking homebrew is done when its status says pass/fail. padtest
// (idle marker) and discs without markers never say so: they are done once
// they ran minFrames frames.
export function isDone(markers, info, minFrames) {
  // A status only counts when the whole marker area decodes cleanly; a game
  // picture that is yellow or green in that corner is not a marker.
  const status = markers?.confident ? markers.status : null;
  if (status === "pass" || status === "fail") return true;
  return (status === "idle" || status == null) && info?.frame >= minFrames;
}

// Poll a marker-speaking homebrew until it reports done (pass/fail), the
// worker dies, the core stops advancing, or the timeout hits.
export async function runUntilDone(session, { timeoutSec = 90, minFrames = 600, stallSec = 8 } = {}) {
  const end = Date.now() + timeoutSec * 1000;
  let lastFrame = -1, stalledSince = Date.now();
  let info = null, markers = null, frame = null;
  let outcome = "timeout";
  while (Date.now() < end) {
    await session.page.waitForTimeout(1000);
    info = await readFrameInfo(session.page);
    if (session.watch.fatal().length) { outcome = "fatal"; break; }
    frame = await grabFrame(session.page);
    markers = decodeMarkers(frame);
    if (isDone(markers, info, minFrames)) { outcome = "done"; break; }
    if (info.frame !== lastFrame) { lastFrame = info.frame; stalledSince = Date.now(); }
    else if (Date.now() - stalledSince > stallSec * 1000) { outcome = "stalled"; break; }
  }
  if (!frame || outcome === "fatal") {
    frame = await grabFrame(session.page).catch(() => null);
    markers = frame ? decodeMarkers(frame) : null;
  }
  const progress = await readCoreProgress(session.page);
  return { outcome, info, markers, frame, progress, fatal: session.watch.fatal() };
}

export { grabFrame, readCoreProgress, setCorePaused };
