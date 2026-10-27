import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { DEFAULT_UPSTREAM_CORE_SHA256, requestedUpstreamCoreBuild } from "../src/default-core.js";
import {
  DEFAULT_UPSTREAM_CORE_URL,
  buildWorkerErrorReply,
  isStrictOneWayWorkerRequest,
  planWorkerSuccessReply,
  requestedLegacyOneWayAck,
  requestedSoftwareTevHotCaseMode,
  requestedXfbFastPaths,
  sanitizeDiscFileName,
  sha256Hex,
  workerFsDiscPath
} from "../src/upstream-worker-protocol.js";

test("upstream worker sanitizes disc names for WORKERFS paths", () => {
  assert.equal(sanitizeDiscFileName("Super Smash Bros. Melee.iso"), "Super Smash Bros. Melee.iso");
  assert.equal(sanitizeDiscFileName("../GALE01.gcm"), ".._GALE01.gcm");
  assert.equal(sanitizeDiscFileName(""), "disc.iso");
  assert.equal(workerFsDiscPath("GALE01.gcm"), "/workerfs/GALE01.gcm");
});

test("upstream core selection is content-addressed and defaults to the pinned baseline", () => {
  const abi = JSON.parse(readFileSync(
    new URL("../provenance/dolphin-core-abi-v1.json", import.meta.url),
    "utf8"
  ));
  assert.equal(`sha256:${DEFAULT_UPSTREAM_CORE_SHA256}`, abi.coreId);
  assert.deepEqual(requestedUpstreamCoreBuild(""), {
    coreId: `sha256:${DEFAULT_UPSTREAM_CORE_SHA256}`,
    sha256: DEFAULT_UPSTREAM_CORE_SHA256,
    coreUrl: DEFAULT_UPSTREAM_CORE_URL,
    candidate: false
  });

  const hash = "a".repeat(64);
  assert.deepEqual(requestedUpstreamCoreBuild(`?coreid=sha256:${hash}`), {
    coreId: `sha256:${hash}`,
    sha256: hash,
    coreUrl: `./build/core-candidates/${hash}/dolphin-core-upstream.js`,
    candidate: true
  });
  assert.throws(() => requestedUpstreamCoreBuild("?coreid=not-a-hash"), /SHA-256/);
});

test("core selector hashing uses full SHA-256", async () => {
  assert.equal(
    await sha256Hex(new TextEncoder().encode("abc")),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
  );
});

test("strict one-way requests suppress only successful replies by default", () => {
  const request = {
    type: "setInputState",
    oneWay: true,
    payload: { mask: 1 }
  };
  assert.equal(isStrictOneWayWorkerRequest(request), true);

  const planned = planWorkerSuccessReply(request, {});
  assert.equal(planned.oneWay, true);
  assert.equal(planned.suppress, true);
  assert.equal(planned.estimatedReplyJsonBytes, 11);

  assert.equal(isStrictOneWayWorkerRequest({ ...request, id: 7 }), false);
  assert.equal(isStrictOneWayWorkerRequest({ ...request, type: "runFrame" }), false);
  assert.equal(isStrictOneWayWorkerRequest({ ...request, oneWay: false }), false);
});

test("legacy one-way acknowledgements and request/reply behavior remain available", () => {
  const oneWay = { type: "setAudioMuted", oneWay: true, payload: { muted: true } };
  const legacy = planWorkerSuccessReply(oneWay, {}, { legacyOneWayAck: true });
  assert.equal(legacy.suppress, false);
  assert.deepEqual(legacy.reply, { id: undefined, ok: true });

  const rpc = planWorkerSuccessReply(
    { id: 9, type: "runFrame", payload: {} },
    { frame: 123 }
  );
  assert.equal(rpc.oneWay, false);
  assert.equal(rpc.suppress, false);
  assert.deepEqual(rpc.reply, { id: 9, ok: true, frame: 123 });

  assert.equal(requestedLegacyOneWayAck(""), false);
  assert.equal(requestedLegacyOneWayAck("?legacyonewayack=1"), true);
  assert.equal(requestedLegacyOneWayAck("?legacyonewayack=0"), false);
});

test("XFB fast paths remain default-off and accept independent rollback controls", () => {
  assert.equal(requestedXfbFastPaths(""), 0);
  assert.equal(requestedXfbFastPaths("?xfbfast=0"), 0);
  assert.equal(requestedXfbFastPaths("?xfbfast=rows"), 1);
  assert.equal(requestedXfbFastPaths("?xfbfast=decode"), 2);
  assert.equal(requestedXfbFastPaths("?xfbfast=both"), 3);
  assert.equal(requestedXfbFastPaths("?xfbfast=unknown"), 0);
});

test("software TEV hot cases are independently opt-in for execute and shadow", () => {
  assert.equal(requestedSoftwareTevHotCaseMode(""), 0);
  assert.equal(requestedSoftwareTevHotCaseMode("?swtevfast=0&swtevshadow=0"), 0);
  assert.equal(requestedSoftwareTevHotCaseMode("?swtevfast=1"), 1);
  assert.equal(requestedSoftwareTevHotCaseMode("?swtevshadow=1"), 2);
  assert.equal(requestedSoftwareTevHotCaseMode("?swtevfast=1&swtevshadow=1"), 3);
  assert.equal(requestedSoftwareTevHotCaseMode("?swtevfast=true&swtevshadow=yes"), 0);
});

test("worker error replies are never suppressible", () => {
  const request = { type: "setInputMask", oneWay: true, payload: { mask: 1 } };
  assert.deepEqual(buildWorkerErrorReply(request, "input failed"), {
    id: undefined,
    ok: false,
    error: "input failed"
  });
});
