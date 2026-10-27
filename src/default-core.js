// The default core's hash lives in a data file that CI rewrites with each core (docs/repro-build.md).
// Page modules only: WebKit (Safari 26.6) cannot load a JSON module in a
// module worker. Statically imported, it fails the whole worker with an
// empty error event; imported dynamically (a top-level await), the worker's
// first messages are lost before the module settles. The discio worker gets
// the hash from the page in its load request instead.
import { DEFAULT_UPSTREAM_CORE_URL, SHA256_PATTERN } from "./upstream-worker-protocol.js";
import coreLock from "../cores/dolphin/core.lock.json" with { type: "json" };
export const DEFAULT_UPSTREAM_CORE_SHA256 = coreLock.sha256;

export function requestedUpstreamCoreBuild(search = globalThis.location?.search ?? "") {
  const requested = new URLSearchParams(search).get("coreid")?.toLowerCase().replace(/^sha256:/, "") ?? "";
  if (!requested) {
    return {
      coreId: `sha256:${DEFAULT_UPSTREAM_CORE_SHA256}`,
      sha256: DEFAULT_UPSTREAM_CORE_SHA256,
      coreUrl: DEFAULT_UPSTREAM_CORE_URL,
      candidate: false
    };
  }
  if (!SHA256_PATTERN.test(requested)) {
    throw new Error("coreid must be a SHA-256 content hash");
  }
  return {
    coreId: `sha256:${requested}`,
    sha256: requested,
    coreUrl: `./build/core-candidates/${requested}/dolphin-core-upstream.js`,
    candidate: true
  };
}
