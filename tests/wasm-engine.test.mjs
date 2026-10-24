import assert from "node:assert/strict";
import test from "node:test";

import { WASM_ENGINE_PARAM, errorShape, wasmEngine } from "../src/wasm-engine.js";

const UA = {
  safariMac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  safariIos: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  chromeIos: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0 Mobile/15E148 Safari/604.1",
  chromeMac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  edge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
  headless: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/130.0.0.0 Safari/537.36",
  firefox: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:132.0) Gecko/20100101 Firefox/132.0"
};
const JSC = () => ({ line: true, lineNumber: false });
const V8 = () => ({ line: false, lineNumber: false });
const SM = () => ({ line: false, lineNumber: true });

test("wasm engine: JavaScriptCore needs a WebKit user agent that is not Blink AND its Error shape", () => {
  for (const ua of [UA.safariMac, UA.safariIos, UA.chromeIos]) assert.equal(wasmEngine({ userAgent: ua, probe: JSC }), "jsc", ua);
  assert.equal(wasmEngine({ userAgent: UA.safariMac, probe: V8 }), "unknown", "a Safari user agent alone is not enough");
  assert.equal(wasmEngine({ userAgent: UA.chromeMac, probe: JSC }), "unknown", "the JSC Error shape under Blink's user agent is not enough");
});

test("wasm engine: V8 and SpiderMonkey", () => {
  for (const ua of [UA.chromeMac, UA.edge, UA.headless]) assert.equal(wasmEngine({ userAgent: ua, probe: V8 }), "v8", ua);
  assert.equal(wasmEngine({ userAgent: UA.firefox, probe: SM }), "spidermonkey");
  assert.equal(wasmEngine({ userAgent: "", probe: V8 }), "unknown");
});

test("wasm engine: ?wasmengine= overrides the detection; anything else is ignored", () => {
  assert.equal(wasmEngine({ search: `?${WASM_ENGINE_PARAM}=jsc`, userAgent: UA.chromeMac, probe: V8 }), "jsc");
  assert.equal(wasmEngine({ search: `?aot=1&${WASM_ENGINE_PARAM}=spidermonkey`, userAgent: UA.safariMac, probe: JSC }), "spidermonkey");
  assert.equal(wasmEngine({ search: `?${WASM_ENGINE_PARAM}=chakra`, userAgent: UA.chromeMac, probe: V8 }), "v8");
});

test("wasm engine: this Node is V8 by its Error shape", () => {
  assert.deepEqual(errorShape(), { line: false, lineNumber: false });
});

test("wasm engine: only an engine known to have no native module cache says so (unknown keeps it)", async () => {
  const { nativeModuleCache } = await import("../src/wasm-engine.js");
  assert.deepEqual(["v8", "jsc", "spidermonkey", "unknown"].map(nativeModuleCache), [true, false, false, true]);
});
