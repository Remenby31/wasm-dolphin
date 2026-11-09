// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
// Result directory of a probe, as race-perf.mjs places them: a local-only
// disc (anything outside the homebrew builds) never writes into the repo,
// its results go to ../measures/harness (or HARNESS_PRIVATE_OUT).
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "./browser.mjs";
import { claim } from "./ownership.mjs";

export const HOMEBREW_OUT = path.join(REPO_ROOT, "harness", "homebrew", "out");

export const isLocalOnly = (iso) => !path.resolve(iso).startsWith(HOMEBREW_OUT);

export function probeOutDir(name, iso, out = null) {
  const stamp = `${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}-${process.pid}-${randomBytes(3).toString("hex")}`;
  const dir = out ? path.resolve(out) : isLocalOnly(iso)
    ? path.resolve(process.env.HARNESS_PRIVATE_OUT || path.join(REPO_ROOT, "..", "measures", "harness"), `${name}-${stamp}`)
    : path.join(REPO_ROOT, "harness", "results", `${name}-${stamp}`);
  mkdirSync(path.dirname(dir), { recursive: true });
  mkdirSync(dir);
  claim(dir, REPO_ROOT, "results");
  return dir;
}

// Which Chrome ran (race-perf records the same): a wrapper or extra flags
// left exported would otherwise pass for the engine's own numbers.
// channel: msedge when HARNESS_BROWSER_CHANNEL says so (the PC kit's Edge
// runs); display: a run shown on a screen (x11, windows) says so.
export const chromeInfo = (env = process.env) => ({
  path: env.HARNESS_CHROME_PATH || "chrome stable", args: env.HARNESS_CHROME_ARGS || "",
  ...(env.HARNESS_BROWSER_CHANNEL && env.HARNESS_BROWSER_CHANNEL !== "chrome" ? { channel: env.HARNESS_BROWSER_CHANNEL } : {}),
  ...(env.HARNESS_DISPLAY && env.HARNESS_DISPLAY !== "headless" ? { display: env.HARNESS_DISPLAY } : {})
});
