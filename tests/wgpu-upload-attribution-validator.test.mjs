// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { validateWgpuUploadAttribution } from "../tools/validate-wgpu-upload-attribution.mjs";

test("attribution validator accepts conserved direct-battle artifacts", async (t) => {
  const fixture = await makeFixture(t);
  const result = await validateWgpuUploadAttribution({ outDir: fixture.root });

  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.equal(result.runCount, 1);
  assert.deepEqual(result.runs[0].equations.opcodeCalls, {
    total: 5,
    opcode6: 4,
    opcode8: 1,
    sum: 5,
  });
  assert.deepEqual(result.runs[0].equations.roleBytes.operands, [0, 64, 0, 128, 32, 256]);
  assert.ok(result.runs[0].artifacts.every((artifact) => artifact.sha256));
});

test("attribution validator rejects role, bucket, and opcode disagreement", async (t) => {
  const fixture = await makeFixture(t);
  await mutateFinalAndLastSample(fixture, (webgpu) => {
    webgpu.uploadAttribution.totalCalls = 99;
    webgpu.uploadAttribution.bucketBytesByRole[3][1] = 127;
    webgpu.replayOps.queueUploadCalls[6] = 3;
  });

  const result = await validateWgpuUploadAttribution({ outDir: fixture.root });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === "ATTR_ROLE_SUM"));
  assert.ok(result.issues.some((issue) => issue.code === "ATTR_BUCKET_SUM"));
  assert.ok(result.issues.some((issue) => issue.code === "ATTR_OP6_RECONCILE"));
  assert.ok(result.issues.some((issue) => issue.code === "ATTR_OPCODE_TOTAL"));
});

test("attribution validator rejects a cumulative sample regression", async (t) => {
  const fixture = await makeFixture(t);
  const samplesPath = path.join(fixture.runDir, "samples.json");
  const samples = JSON.parse(await readFile(samplesPath, "utf8"));
  samples[1].causalTelemetry.webgpu.uploadAttribution.callsByRole[3] = 0;
  await writeFile(samplesPath, JSON.stringify(samples));

  const result = await validateWgpuUploadAttribution({ outDir: fixture.root });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === "ATTR_COUNTER_REGRESSION"));
});

test("attribution validator rejects replay, copy, and queue disagreement", async (t) => {
  const fixture = await makeFixture(t);
  await mutateFinalAndLastSample(fixture, (webgpu) => {
    webgpu.replayOps.uploadCopyCalls[6] -= 1;
    webgpu.replayOps.uploadCopyBytes[8] -= 4;
  });

  const result = await validateWgpuUploadAttribution({ outDir: fixture.root });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === "REPLAY_UPLOAD_CALL_MISMATCH"));
  assert.ok(result.issues.some((issue) => issue.code === "REPLAY_UPLOAD_BYTE_MISMATCH"));
});

test("attribution validator requires a consistent verified timeout boundary", async (t) => {
  const fixture = await makeFixture(t);
  const manifestPath = path.join(fixture.runDir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.fixture.loadResult.response.wgpuUploadTimeoutBoundary.afterLoadDelta = 7;
  await writeFile(manifestPath, JSON.stringify(manifest));

  const result = await validateWgpuUploadAttribution({ outDir: fixture.root });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === "TIMEOUT_BOUNDARY_MISMATCH"));
});

test("attribution validator requires real-WGPU identity and RGB chain evidence", async (t) => {
  const fixture = await makeFixture(t);
  const manifestPath = path.join(fixture.runDir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.renderer.activeVideoBackend = "Software Renderer";
  manifest.renderer.wgpuReplayClassifier.stages.firstEfbPassReadback.nonzeroColorBytes = 0;
  manifest.renderer.wgpuReplayClassifier.stages.presentationChain.backbuffer.lastNonzeroColorBytes = 0;
  await writeFile(manifestPath, JSON.stringify(manifest));

  const result = await validateWgpuUploadAttribution({ outDir: fixture.root });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === "BACKEND_IDENTITY"));
  assert.ok(result.issues.some((issue) => issue.code === "RGB_EFB_FIRST_PASS_ZERO"));
  assert.ok(result.issues.some((issue) => issue.code === "RGB_BACKBUFFER_FINAL_ZERO"));
});

test("attribution validator rejects producer and replay qualification failures", async (t) => {
  const fixture = await makeFixture(t);
  await mutateFinalAndLastSample(fixture, (webgpu) => {
    webgpu.uploadTimeoutCount = 1;
    webgpu.uploadTimeoutCountAfterVerifiedLoad = 1;
    webgpu.batchAbortCount = 1;
    webgpu.commandDroppedCount = 2;
    webgpu.producerUploadArenaAvailable = true;
    webgpu.producerUploadArenaRequestedBytes = 64 * 1024 * 1024;
    webgpu.producerUploadArenaConfiguredBytes = 32 * 1024 * 1024;
    webgpu.producerUploadArenaFallbackCount = 1;
    webgpu.uploadArenaRingHandoffBytes = 32 * 1024 * 1024;
    webgpu.uploadArenaRingHandoffExpectedBytes = 64 * 1024 * 1024;
    webgpu.uploadArenaRingHandoffMismatch = true;
    webgpu.uploadArenaRingHandoffMismatchCount = 1;
  });
  const manifestPath = path.join(fixture.runDir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const stages = manifest.renderer.wgpuReplayClassifier.stages;
  stages.missingResources.total = 1;
  stages.passAtomicity.splitAtDrainCount = 1;
  stages.presentSubmission.errorCount = 1;
  manifest.renderer.errors.push({ source: "validation", message: "synthetic" });
  await writeFile(manifestPath, JSON.stringify(manifest));

  const result = await validateWgpuUploadAttribution({ outDir: fixture.root });
  assert.equal(result.ok, false);
  for (const code of ["QUALIFYING_WEBGPU_COUNTER", "MISSING_RESOURCE", "PASS_ATOMICITY",
    "PRESENT_ERROR", "RENDERER_ERROR", "UPLOAD_ARENA_IDENTITY"]) {
    assert.ok(result.issues.some((issue) => issue.code === code), code);
  }
});

test("attribution validator enforces replay-budget identity and a zero hard-cap count", async (t) => {
  const fixture = await makeFixture(t);
  const manifestPath = path.join(fixture.runDir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.benchmark.url = "http://127.0.0.1/?video=wgpu&wgpureplayms=4";
  await writeFile(manifestPath, JSON.stringify(manifest));
  await mutateFinalAndLastSample(fixture, (webgpu) => {
    webgpu.replayBudgetEnabled = false;
    webgpu.replayBudgetMs = 6;
    webgpu.replayBudgetStopReasons = { "record-window": 1 };
  });

  const result = await validateWgpuUploadAttribution({ outDir: fixture.root });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === "REPLAY_BUDGET_IDENTITY"));
  assert.ok(result.issues.some((issue) => issue.code === "REPLAY_BUDGET_HARD_CAP"));
});

test("attribution validator checks the default 4 ms budget and the explicit unbudgeted replay", async (t) => {
  const fixture = await makeFixture(t);
  await mutateFinalAndLastSample(fixture, (webgpu) => {
    webgpu.replayBudgetEnabled = false;
    webgpu.replayBudgetMs = 0;
  });
  const noParam = await validateWgpuUploadAttribution({ outDir: fixture.root });
  assert.ok(noParam.issues.some((issue) => issue.code === "REPLAY_BUDGET_IDENTITY"),
    "no parameter: the 4 ms budget is expected");

  const manifestPath = path.join(fixture.runDir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.benchmark.url = "http://127.0.0.1/?video=wgpu&wgpureplayms=0";
  await writeFile(manifestPath, JSON.stringify(manifest));
  const explicitOff = await validateWgpuUploadAttribution({ outDir: fixture.root });
  assert.ok(!explicitOff.issues.some((issue) => issue.code.startsWith("REPLAY_BUDGET")),
    JSON.stringify(explicitOff.issues));
});

test("attribution validator rejects a missing raw artifact", async (t) => {
  const fixture = await makeFixture(t);
  await unlink(path.join(fixture.runDir, "events.jsonl"));

  const result = await validateWgpuUploadAttribution({ outDir: fixture.root });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some(
    (issue) => issue.code === "ARTIFACT_MISSING" && issue.message.includes("events.jsonl")
  ));
});

async function makeFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wgpu-upload-attribution-validator-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runId = "block-01-run-1";
  const runDir = path.join(root, runId);
  await mkdir(path.join(runDir, "build-provenance"), { recursive: true });

  const first = makeWebgpuSnapshot({ multiplier: 1 });
  // The first page read may still expose the retained pre-load payload. The
  // boundary must appear in a later sample and may never disappear again.
  first.uploadTimeoutBoundaryVerified = false;
  const second = makeWebgpuSnapshot({ multiplier: 2 });
  const samples = [
    sample(first, 0),
    sample(second, 1),
  ];
  const summary = {
    final: samples.at(-1),
  };
  const manifest = {
    benchmark: {
      saveStateAt: 0,
      inputScriptMode: "none",
      timingStartsAfterVerifiedLoad: true,
    },
    fixture: {
      isoVerified: true,
      saveStateVerified: true,
      saveStateLoaded: true,
      battleCheckpoint: { verified: true },
      loadResult: {
        loaded: true,
        response: {
          wgpuUploadTimeoutBoundary: {
            enabled: true,
            verified: true,
            beforeLoad: 0,
            immediatelyAfterLoad: 0,
            afterLoadDelta: 0,
          },
        },
      },
    },
    renderer: rendererEvidence(),
  };
  const report = {
    headed: true,
    qualificationEligible: true,
    results: [{ runId, name: runId, valid: true }],
  };
  const tasklist = {
    status: "SCREENING_SIGNAL",
    blocks: [{ runs: [{ runId }] }],
  };

  await Promise.all([
    writeFile(path.join(root, "report.json"), JSON.stringify(report)),
    writeFile(path.join(root, "tasklist.json"), JSON.stringify(tasklist)),
    writeFile(path.join(root, "comparison.json"), JSON.stringify({ outcome: "SCREENING_SIGNAL" })),
    writeFile(path.join(root, "comparison.csv"), "run,value\nblock-01-run-1,1\n"),
    writeFile(path.join(root, "runs.csv"), "run,valid\nblock-01-run-1,true\n"),
    writeFile(path.join(runDir, "manifest.json"), JSON.stringify(manifest)),
    writeFile(path.join(runDir, "summary.json"), JSON.stringify(summary)),
    writeFile(path.join(runDir, "samples.json"), JSON.stringify(samples)),
    writeFile(path.join(runDir, "samples.csv"), "elapsed,totalCalls\n0,3\n1,5\n"),
    writeFile(path.join(runDir, "events.jsonl"), "{\"event\":\"save-state-loaded\"}\n"),
    writeFile(path.join(runDir, "console.log"), "fixed battle running\n"),
    writeFile(path.join(runDir, "final.png"), Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from("fixture"),
    ])),
    writeFile(path.join(runDir, "build-provenance", "source-lock.json"), "{}\n"),
  ]);
  return { root, runDir };
}

function makeWebgpuSnapshot({ multiplier }) {
  const terminal = multiplier === 2;
  const calls = terminal ? [0, 1, 0, 2, 1, 1] : [0, 1, 0, 1, 0, 1];
  const bytes = terminal ? [0, 64, 0, 128, 32, 256] : [0, 64, 0, 64, 0, 256];
  const maxima = terminal ? [0, 64, 0, 64, 32, 256] : [0, 64, 0, 64, 0, 256];
  const bucketCalls = Array.from({ length: 6 }, () => Array(7).fill(0));
  const bucketBytes = Array.from({ length: 6 }, () => Array(7).fill(0));
  bucketCalls[1][0] = 1;
  bucketBytes[1][0] = 64;
  bucketCalls[3][0] = terminal ? 2 : 1;
  bucketBytes[3][0] = terminal ? 128 : 64;
  if (terminal) {
    bucketCalls[4][0] = 1;
    bucketBytes[4][0] = 32;
  }
  bucketCalls[5][1] = 1;
  bucketBytes[5][1] = 256;
  const op6Calls = terminal ? 4 : 2;
  const op6Bytes = terminal ? 224 : 128;
  const arrays = () => Array(25).fill(0);
  const histogram = arrays();
  const uploadCopyCalls = arrays();
  const uploadCopyBytes = arrays();
  const queueUploadCalls = arrays();
  const queueUploadBytes = arrays();
  for (const array of [histogram, uploadCopyCalls, queueUploadCalls]) {
    array[6] = op6Calls;
    array[8] = 1;
  }
  for (const array of [uploadCopyBytes, queueUploadBytes]) {
    array[6] = op6Bytes;
    array[8] = 256;
  }
  return {
    registered: true,
    // the product's default replay budget (no ?wgpureplayms)
    replayBudgetEnabled: true,
    replayBudgetMs: 4,
    replayBudgetStopReasons: { "record-window": 0 },
    batchAbortCount: 0,
    batchOversizeCount: 0,
    commandDroppedCount: 0,
    errorCount: 0,
    heldUploadStageLimitCount: 0,
    uploadTimeoutCount: 0,
    uploadTimeoutBoundaryVerified: true,
    uploadTimeoutCountAtVerifiedLoad: 0,
    uploadTimeoutCountBeforeVerifiedLoad: 0,
    uploadTimeoutCountAfterVerifiedLoad: 0,
    uploadAttribution: {
      schema: "wasm-dolphin.wgpu-upload-attribution.v1",
      enabled: true,
      roleOrder: ["unknown", "ubo", "utility-uniform", "vertex", "index", "texture-adjacent"],
      sizeBucketLabels: ["<=64", "<=256", "<=1024", "<=4096", "<=16384", "<=65536", ">65536"],
      totalCalls: calls.reduce((sum, value) => sum + value, 0),
      totalBytes: bytes.reduce((sum, value) => sum + value, 0),
      maxBytes: 256,
      callsByRole: calls,
      bytesByRole: bytes,
      maxBytesByRole: maxima,
      bucketCallsByRole: bucketCalls,
      bucketBytesByRole: bucketBytes,
      passAssociation: {
        completedPassCount: multiplier,
        abortedPassCount: 0,
        incompletePassCount: 0,
      },
    },
    replayOps: {
      schema: "wasm-dolphin.wgpu-replay-op-metrics.v1",
      enabled: true,
      names: Array.from({ length: 25 }, (_, index) =>
        index === 6 ? "UPLOAD_BUFFER" : index === 8 ? "UPLOAD_TEXTURE" : `OP_${index}`),
      histogram,
      uploadCopyCalls,
      uploadCopyBytes,
      queueUploadCalls,
      queueUploadBytes,
    },
  };
}

function sample(webgpu, elapsedSeconds) {
  return {
    elapsedSeconds,
    causalTelemetry: {
      presentation: { backend: "webgpu" },
      webgpu,
    },
  };
}

function rendererEvidence() {
  return {
    requestedVideoBackend: "WebGPU-Real",
    configuredVideoBackend: "WebGPU-Real",
    activeVideoBackend: "WebGPU-Real",
    expectedVideoBackend: "WebGPU-Real",
    requestedPresenterBackend: "webgpu",
    activePresenterBackend: "webgpu",
    expectedRequestedPresenterBackend: "webgpu",
    expectedActivePresenterBackend: "webgpu",
    fallback: null,
    coreSelection: { fallbackReason: null },
    errors: [],
    emscriptenPrintErr: [],
    fatalStatusHistory: [],
    workerTransport: { requestErrorRepliesSent: 0, oneWayErrorRepliesSent: 0 },
    wgpuReplayClassifier: {
      stages: {
        missingResources: { total: 0 },
        passAtomicity: { splitAtDrainCount: 0, recordsOutsidePass: 0 },
        presentSubmission: { errorCount: 0 },
        firstEfbPassReadback: {
          status: "pass",
          nonzeroColorBytes: 100,
          maxByte: 255,
        },
        presentationChain: {
          xfb: readback(47, 47),
          backbuffer: readback(0, 47),
        },
      },
    },
  };
}

function readback(framebufferId, sourceTextureId) {
  return {
    readbackCount: 1,
    framebufferId,
    sourceTextureId,
    lastSampledBytes: 1024,
    lastNonzeroColorBytes: 768,
    lastMaxByte: 255,
    lastPresentSequence: 10,
  };
}

async function mutateFinalAndLastSample(fixture, mutate) {
  const summaryPath = path.join(fixture.runDir, "summary.json");
  const samplesPath = path.join(fixture.runDir, "samples.json");
  const summary = JSON.parse(await readFile(summaryPath, "utf8"));
  const samples = JSON.parse(await readFile(samplesPath, "utf8"));
  mutate(summary.final.causalTelemetry.webgpu);
  mutate(samples.at(-1).causalTelemetry.webgpu);
  await Promise.all([
    writeFile(summaryPath, JSON.stringify(summary)),
    writeFile(samplesPath, JSON.stringify(samples)),
  ]);
}
