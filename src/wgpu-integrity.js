// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Integrity counters of the WebGPU replay, always on and cheap (a few integer
// increments on paths that are already exceptional). They count what makes a
// picture wrong without failing anything: a draw skipped for want of its
// pipeline, bind group or buffers (the element vanishes for a frame), command
// records the core dropped, passes it aborted or poisoned (an upload that
// waited too long for arena space), uncaptured WebGPU errors, device losses,
// a fatal replay, mapped staging refused. validationReadIntegrity returns them flat
// and cumulative; the probes take the delta over a window and fail the run on
// a fatal counter (INTEGRITY_FATAL).
//
// pipelinePending (a draw skipped because its pipeline is not ready: async
// compilation) is not fatal by itself: the probes judge its rate per second
// after the warm-up (a pipeline evicted and rebuilt in a loop would make an
// element blink on a slow device).

export const SKIP_CAUSES = Object.freeze(["pipelinePending", "bindGroup", "vertexBuffer", "indexBuffer"]);

// Fatal: any non-zero delta over a measured window fails the run.
// The core's own (its state stats line): records dropped, batches aborted or
// oversized, uploads that timed out waiting for arena space; the last two
// poison a whole pass, every element drawn in it gone for a frame.
export const INTEGRITY_FATAL = Object.freeze([
  "skipBindGroup",
  "skipVertexBuffer",
  "skipIndexBuffer",
  "droppedRecords",
  "batchAborts",
  "batchOversize",
  "uploadTimeouts",
  "uncapturedErrors",
  "deviceLosses",
  "replayFatal",
  "stagingUnsafe",
  "geometryCacheCollisions",
  "geometryCacheFailed"
]);

// The first missing resource of a skipped draw, in the order the replay checks
// them: pipeline, bind groups, vertex buffer, index buffer.
export function skippedDrawCause({ hasPipeline, bindGroupsValid, needsVertexBuffer, vertexBufferValid, indexed = false, indexBufferValid = true }) {
  if (!hasPipeline) return "pipelinePending";
  if (!bindGroupsValid) return "bindGroup";
  if (needsVertexBuffer && !vertexBufferValid) return "vertexBuffer";
  if (indexed && !indexBufferValid) return "indexBuffer";
  return null;
}

// The core's counters from its state stats (parseWgpuProducerStateStats):
// null fields when the core predates them.
export function coreIntegrityOf(parsed) {
  return {
    droppedRecords: parsed?.commandDroppedCount ?? null,
    batchAborts: parsed?.batchAbortCount ?? null,
    batchOversize: parsed?.batchOversizeCount ?? null,
    uploadTimeouts: parsed?.uploadTimeoutCount ?? null
  };
}

export function createWgpuIntegrity() {
  const counts = {
    skipPipelinePending: 0,
    skipBindGroup: 0,
    skipVertexBuffer: 0,
    skipIndexBuffer: 0,
    uncapturedErrors: 0,
    deviceLosses: 0,
    replayFatal: 0
  };
  return {
    skip(cause) {
      const key = cause ? `skip${cause[0].toUpperCase()}${cause.slice(1)}` : null;
      if (key && key in counts) counts[key] += 1;
    },
    note(name) {
      if (name in counts) counts[name] += 1;
    },
    // extra: counters owned elsewhere (the core's dropped records, the staging
    // pool, the geometry cache), read at the same moment
    snapshot(extra = {}) {
      return { ...counts, ...extra };
    }
  };
}
