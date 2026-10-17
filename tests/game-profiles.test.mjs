import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  GAME_PROFILES,
  adapterFamilyFromInfo,
  detectAdapterFamily,
  resolveRendererProfile
} from "../src/game-profiles.js";

test("a hardware profile only applies on an adapter family it was validated on", () => {
  assert.deepEqual(resolveRendererProfile("GM4E01", "amd"), { renderer: "hardware", validated: true });
  // Measured on an M4 Pro: menus fine, no 3D world in a race.
  assert.deepEqual(resolveRendererProfile("GM4E01", "apple"), { renderer: "software", validated: false });
  assert.deepEqual(resolveRendererProfile("gm4e01", "nvidia"), { renderer: "software", validated: false });
  assert.deepEqual(resolveRendererProfile("GM4E01", null), { renderer: "software", validated: false });
});

test("software profiles hold on every family and unknown discs keep the shipping default", () => {
  for (const family of ["amd", "apple", null]) {
    assert.deepEqual(resolveRendererProfile("GMSE01", family), { renderer: "software", validated: true });
    assert.equal(resolveRendererProfile("ZZZZ99", family), null);
    assert.equal(resolveRendererProfile(null, family), null);
  }
});

test("every hardware profile names the families it was checked on, and none is Apple", () => {
  for (const [id, profile] of Object.entries(GAME_PROFILES)) {
    if (profile.renderer !== "hardware") continue;
    assert.ok(profile.validatedOn.length > 0, id);
    assert.ok(!profile.validatedOn.includes("apple"), id);
  }
});

test("adapter info normalizes to a family from vendor or description", () => {
  assert.equal(adapterFamilyFromInfo({ vendor: "apple", architecture: "metal-3" }), "apple");
  assert.equal(adapterFamilyFromInfo({ vendor: "amd", architecture: "rdna-4" }), "amd");
  assert.equal(adapterFamilyFromInfo({ vendor: "", description: "AMD Radeon RX 9070 XT" }), "amd");
  assert.equal(adapterFamilyFromInfo({ vendor: "nvidia" }), "nvidia");
  assert.equal(adapterFamilyFromInfo({ vendor: "intel" }), "intel");
  assert.equal(adapterFamilyFromInfo({ vendor: "google", description: "SwiftShader" }), null);
  assert.equal(adapterFamilyFromInfo({}), null);
  assert.equal(adapterFamilyFromInfo(null), null);
});

test("adapter detection uses the core's power preference and degrades to null", async () => {
  let asked = null;
  const gpu = {
    requestAdapter: async (options) => {
      asked = options;
      return { info: { vendor: "apple" } };
    }
  };
  assert.equal(await detectAdapterFamily(gpu, "low-power"), "apple");
  assert.deepEqual(asked, { powerPreference: "low-power" });

  const legacy = { requestAdapter: async () => ({ requestAdapterInfo: async () => ({ vendor: "amd" }) }) };
  assert.equal(await detectAdapterFamily(legacy), "amd");
  assert.equal(await detectAdapterFamily({ requestAdapter: async () => null }), null);
  assert.equal(await detectAdapterFamily({ requestAdapter: async () => { throw new Error("blocked"); } }), null);
  assert.equal(await detectAdapterFamily(undefined), null);
});

test("the auto-profile status line names neither the disc nor its measurement", async () => {
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const body = app.slice(app.indexOf("async function applyGameProfile"), app.indexOf("async function mountFile"));
  const status = body.slice(body.indexOf("setStatus("));
  assert.match(status, /Auto per-game/);
  assert.doesNotMatch(status, /gameId|\.why|game\.name/);
});
