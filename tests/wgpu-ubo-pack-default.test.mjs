import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { wasmEngine } from "../src/wasm-engine.js";
import { defaultWgpuUboPack, requestedWgpuUboPack } from "../src/wgpu-replay-diagnostics.js";

// Dense UBO packets (0029): on by default under V8, ?wgpuubopack=0|1 forces it.
const UA = {
  chromeMac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  safariMac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  safariIos: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  chromeIos: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0 Mobile/15E148 Safari/604.1",
  firefox: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:132.0) Gecko/20100101 Firefox/132.0"
};
const JSC = () => ({ line: true, lineNumber: false });
const V8 = () => ({ line: false, lineNumber: false });
const SM = () => ({ line: false, lineNumber: true });

test("dense UBO packets: on in Chrome, off in Safari, every iOS browser and Firefox", () => {
  const pack = (userAgent, probe, search = "") => requestedWgpuUboPack(search, defaultWgpuUboPack(wasmEngine({ search, userAgent, probe })));
  assert.equal(pack(UA.chromeMac, V8), true);
  assert.equal(pack(UA.safariMac, JSC), false);
  assert.equal(pack(UA.safariIos, JSC), false);
  assert.equal(pack(UA.chromeIos, JSC), false, "Chrome on iOS runs JavaScriptCore");
  assert.equal(pack(UA.chromeIos, V8), false, "an iOS user agent is never V8");
  assert.equal(pack(UA.firefox, SM), false);
  assert.equal(pack(UA.chromeMac, V8, "?wgpuubopack=0"), false, "=0 turns the default off");
  assert.equal(pack(UA.safariMac, JSC, "?wgpuubopack=1"), true, "=1 turns it on elsewhere");
  assert.equal(pack(UA.chromeMac, V8, "?wgpuubopack="), true, "an empty value keeps the default");
  assert.equal(pack(UA.chromeMac, V8, "?wgpuubopack=yes"), true, "a non-canonical value keeps the default");
});

test("the host asks for the engine's default, once the engine is known", async () => {
  const host = await readFile(new URL("../src/core-host.js", import.meta.url), "utf8");
  assert.match(host, /this\.wgpuUboPack = requestedWgpuUboPack\(window\.location\.search, defaultWgpuUboPack\(this\.wasmEngine\)\);/);
  assert.ok(host.indexOf("this.wasmEngine =") < host.indexOf("this.wgpuUboPack ="));
});

test("perf artifacts expect the engine's default: on under V8, off under JSC, never with the UBO cache", async () => {
  const { evaluateWgpuRuntimeConfigEvidence } = await import("../tools/perf-artifacts.mjs");
  const uboPackFailure = (runtimeConfig, params) =>
    evaluateWgpuRuntimeConfigEvidence({ required: true, runtimeConfig, params }).failures.find((f) => f.includes("UBO pack"));
  assert.match(uboPackFailure({ uboPackEnabled: false }, {}) ?? "", /UBO pack mismatch: requested=true active=false/);
  assert.equal(uboPackFailure({ uboPackEnabled: true, producerUboPackAvailable: true }, {}), undefined);
  assert.equal(uboPackFailure({ uboPackEnabled: false, wasmEngine: "jsc" }, {}), undefined);
  assert.equal(uboPackFailure({ uboPackEnabled: false }, { wgpuubopack: "0" }), undefined);
  assert.equal(uboPackFailure({ uboPackEnabled: false, uboCacheEnabled: true, producerUboCacheAvailable: true }, { wgpuubocache: "1" }), undefined);
});
