// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Integrity counters of the WebGPU replay, always on and cheap (an integer
// increment on paths that are already exceptional, no allocation). They count
// what makes a picture wrong without failing anything:
// - a draw skipped: its pipeline failed (resolvePipeline is synchronous: no
//   template, createRenderPipeline threw, or a validation error cached as
//   null, so skipped for good), a bind group or a buffer missing, or no pass
//   open (BEGIN_PASS without its color target): the element vanishes;
// - a resource a record names that the replay does not have (upload
//   destination, pass target, bind group entry, blit, readback);
// - the core's own: command records dropped, batches aborted or oversized,
//   uploads that timed out waiting for arena space (each loses a whole pass);
// - uncaptured WebGPU errors, device losses, a fatal replay, mapped staging
//   refused, geometry cache collisions and failures;
// - frames shown out of order: an older XFB put on the canvas after a newer
//   one (patch 0208 frame tags, src/wgpu-new-frames.js; null without tags).
// - region modules the engine refused (src/region-link-failures.js): an
//   import of the wrong type or bytes that do not validate are fatal, an
//   out of memory (regionLinkOther) is not.
// validationReadIntegrity returns them flat and cumulative; the probes take
// the delta over a window and fail the run on any of INTEGRITY_FATAL.

import { REGION_LINK_FATAL } from "./region-link-failures.js";

// Why a draw was skipped, in the order the replay checks (positional, no
// object per draw).
export const SKIP = Object.freeze({ PIPELINE: 0, BIND_GROUP: 1, VERTEX_BUFFER: 2, INDEX_BUFFER: 3, NO_PASS: 4 });
const SKIP_KEYS = ["skipPipelineFailed", "skipBindGroup", "skipVertexBuffer", "skipIndexBuffer", "skipNoPass"];

// The replay's missing-resource kinds (recordMissingResource) and their counter.
export const MISSING_KEYS = Object.freeze({
  "color-texture": "missingColorTarget",
  "depth-texture": "missingDepthTarget",
  "upload-buffer": "missingUploadBuffer",
  "upload-texture": "missingUploadTexture",
  pipeline: "missingPipeline",
  "bind-group": "missingBindGroup",
  "bind-group-blob": "missingBindGroupBlob",
  texture: "missingBindGroupResource",
  sampler: "missingBindGroupResource",
  buffer: "missingBindGroupResource",
  "vertex-buffer": "missingVertexBuffer",
  "index-buffer": "missingIndexBuffer",
  "blit-source": "missingBlit",
  "blit-destination": "missingBlit",
  "readback-source": "missingReadback"
});

export const CORE_KEYS = Object.freeze(["droppedRecords", "batchAborts", "batchOversize", "uploadTimeouts"]);
// 0207: an upload that failed or a geometry range given up for a reason
// other than a load's placement epoch: a picture known wrong, fatal like a
// lost pass (they may share one abort with an expected epoch loss).
export const CORE_FAILURE_KEYS = Object.freeze([
  "uploadAllocFailed", "uploadFailedUnknown", "uploadFailedUbo", "uploadFailedUtility", "uploadFailedVertex",
  "uploadFailedIndex", "uploadFailedTextureAdjacent", "uploadFailedGeometry", "uploadTextureFailed",
  "rangeFailInvalid", "rangeFailUpload"
]);

// Fatal: any non-zero delta over a measured window fails the run.
export const INTEGRITY_FATAL = Object.freeze([
  ...SKIP_KEYS,
  ...new Set(Object.values(MISSING_KEYS)),
  ...CORE_KEYS,
  ...CORE_FAILURE_KEYS,
  "missingOther",
  "uncapturedErrors",
  "deviceLosses",
  "replayFatal",
  "stagingUnsafe",
  "geometryCacheCollisions",
  "geometryCacheFailed",
  "framesOutOfOrder",
  ...REGION_LINK_FATAL
]);

// Reported, never fatal (yet): counted and shown in every run's integrity.
// stalePresents: a present of a new frame showing a texture not rewritten
// since it was last shown (src/wgpu-stale-present.js), the late-XFB jump
// back; fatal once the core shows the last picture instead (patch 0211).
export const INTEGRITY_REPORTED = Object.freeze(["stalePresents"]);

// The first missing resource of a skipped draw (SKIP), or -1 when it has all.
export function skippedDrawCause(hasPass, hasPipeline, bindGroupsValid, needsVertexBuffer, vertexBufferValid, indexed, indexBufferValid) {
  if (!hasPass) return SKIP.NO_PASS;
  if (!hasPipeline) return SKIP.PIPELINE;
  if (!bindGroupsValid) return SKIP.BIND_GROUP;
  if (needsVertexBuffer && !vertexBufferValid) return SKIP.VERTEX_BUFFER;
  if (indexed && !indexBufferValid) return SKIP.INDEX_BUFFER;
  return -1;
}

// Patch 0207's detail, in the core's order: a batch abort's cause
// (BatchAbortCause), the renderer's abort site (GfxAbortSite), a failed
// upload's role (BufferUploadRole). Context, not fatal: batchAborts already
// is; they say which site to look at (failed uploads and ranges given up for
// another reason than the epoch are fatal: CORE_FAILURE_KEYS).
export const ABORT_CAUSES = Object.freeze(["RequiredPublication", "Poisoned", "Explicit", "CommitRefused", "Oversize"]);
// The renderer's sites, then a nested BeginPass (the command stream's): their
// sum is abortExplicit. A pass already poisoned when the renderer abandons it
// counts under abortPoisoned and by site in gfxPoison* (no nested there); the
// rest of abortPoisoned are passes PushEndPass found poisoned.
export const GFX_ABORT_SITES = Object.freeze(["Scissor", "Viewport", "GeometryFlush", "PassPoisoned", "BeginPass", "PassState", "Pipeline", "Prepare", "BufferId", "SetBuffer", "PushDraw", "Nested"]);
export const UPLOAD_ROLES = Object.freeze(["Unknown", "Ubo", "Utility", "Vertex", "Index", "TextureAdjacent", "Geometry"]);
// Pending geometry ranges given up (wgrangefail): a placement epoch moved
// under them (a save load: the abort that follows is expected), an invalid
// range, their upload failed.
export const RANGE_FAILURES = Object.freeze(["Epoch", "Invalid", "Upload"]);

const listOf = (s, name) => {
  const m = new RegExp(`\\b${name}:([\\d,]+)`).exec(s);
  return m ? m[1].split(",").map(Number) : null;
};
const fieldsOf = (values, names, prefix) =>
  Object.fromEntries(names.map((n, i) => [`${prefix}${n}`, values && i < values.length ? values[i] : null]));

// The core's counters from its state stats line: null for a field the core
// does not print (an older core), never a 0 it did not report.
export function coreIntegrityOf(text) {
  const s = String(text ?? "");
  const drop = /\bwgdrop:(\d+)/.exec(s);
  const batch = /\bwgbabort:(\d+)\s+wgboversize:(\d+)\s+wguploadto:(\d+)/.exec(s);
  const skip = /\bwgdrawskip:(\d+)/.exec(s);
  // wgupfail: arena, then one per BufferUploadRole, then texture records
  const upfail = listOf(s, "wgupfail");
  return {
    droppedRecords: drop ? Number(drop[1]) : null,
    batchAborts: batch ? Number(batch[1]) : null,
    batchOversize: batch ? Number(batch[2]) : null,
    uploadTimeouts: batch ? Number(batch[3]) : null,
    ...fieldsOf(listOf(s, "wgabortc"), ABORT_CAUSES, "abort"),
    ...fieldsOf(listOf(s, "wggfxabort"), GFX_ABORT_SITES, "gfxAbort"),
    // the renderer's site of a pass that was already poisoned (abortPoisoned)
    ...fieldsOf(listOf(s, "wggfxpoison"), GFX_ABORT_SITES.slice(0, -1), "gfxPoison"),
    ...fieldsOf(listOf(s, "wgrangefail"), RANGE_FAILURES, "rangeFail"),
    drawSkippedNoPipeline: skip ? Number(skip[1]) : null,
    uploadAllocFailed: upfail ? upfail[0] : null,
    ...fieldsOf(upfail ? upfail.slice(1, 1 + UPLOAD_ROLES.length) : null, UPLOAD_ROLES, "uploadFailed"),
    uploadTextureFailed: upfail && upfail.length === UPLOAD_ROLES.length + 2 ? upfail.at(-1) : null
  };
}

export function createWgpuIntegrity() {
  const skips = new Float64Array(SKIP_KEYS.length);
  const counts = { missingOther: 0, uncapturedErrors: 0, deviceLosses: 0, replayFatal: 0 };
  // context, not fatal: state loads this worker ran (the integrity gate
  // excuses at most one load-epoch abort per load, lib/integrity.mjs)
  let stateLoads = 0;
  for (const k of new Set(Object.values(MISSING_KEYS))) counts[k] = 0;
  return {
    skip(cause) {
      if (cause >= 0 && cause < skips.length) skips[cause] += 1;
    },
    missing(kind) {
      counts[MISSING_KEYS[kind] ?? "missingOther"] += 1;
    },
    note(name) {
      if (name in counts) counts[name] += 1;
    },
    stateLoad() {
      stateLoads += 1;
    },
    // extra: counters owned elsewhere (the core, the staging pool, the
    // geometry cache), read at the same moment
    snapshot(extra = {}) {
      const out = {};
      SKIP_KEYS.forEach((k, i) => { out[k] = skips[i]; });
      return { ...out, ...counts, stateLoads, ...extra };
    }
  };
}
