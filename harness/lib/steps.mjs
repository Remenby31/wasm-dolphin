// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
// Scripted input: a JSON list of steps run after boot (menus → race, etc).
//   { "wait": 25 }                          seconds
//   { "tap": "Enter", "hold": 120, "repeat": 14, "every": 1.8 }
//   { "down": "KeyX" } / { "up": "KeyX" }   keyboard (Playwright key names)
//   { "click": [400, 500] }                 page coordinates
//   { "pad": 0, "state": { "pressed": ["A"] } }   needs the gamepad mock
import { setPad } from "./gamepad-mock.mjs";

export function validateSteps(steps) {
  if (!Array.isArray(steps)) throw new Error("steps must be an array");
  const kinds = ["wait", "tap", "down", "up", "click", "pad"];
  steps.forEach((s, i) => {
    const k = kinds.filter((kind) => kind in s);
    if (k.length !== 1) throw new Error(`step ${i}: expected exactly one of ${kinds.join("/")}`);
  });
  return steps;
}

export function stepsDuration(steps) {
  let ms = 0;
  for (const s of steps) {
    if ("wait" in s) ms += s.wait * 1000;
    if ("tap" in s) ms += (s.repeat ?? 1) * Math.max((s.hold ?? 120), (s.every ?? 0) * 1000);
  }
  return ms / 1000;
}

export async function runSteps(page, steps) {
  for (const s of validateSteps(steps)) {
    if ("wait" in s) await page.waitForTimeout(s.wait * 1000);
    else if ("down" in s) await page.keyboard.down(s.down);
    else if ("up" in s) await page.keyboard.up(s.up);
    else if ("click" in s) await page.mouse.click(s.click[0], s.click[1]);
    else if ("pad" in s) await setPad(page, s.pad, s.state ?? {});
    else if ("tap" in s) {
      for (let i = 0; i < (s.repeat ?? 1); i += 1) {
        const hold = s.hold ?? 120;
        await page.keyboard.down(s.tap);
        await page.waitForTimeout(hold);
        await page.keyboard.up(s.tap);
        if (s.every) await page.waitForTimeout(Math.max(0, s.every * 1000 - hold));
      }
    }
  }
}
