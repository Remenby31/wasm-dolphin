// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
// Interpreter-vs-JIT differential verdicts. Pure: takes what two runs of
// the same homebrew produced and returns findings.
//
// Each run is captured by the core at the same VI output index (the frame
// identity; emulated ticks are informational, they include the event's
// lateness). The two captures must then be
// byte-identical: there is no tolerance and no heuristic. Marker rows
// (checksum-verified) are only decoded to say *which* program diverged.
import { compareFrames, DEFAULT_THRESHOLDS, differingPixels, identical } from "./image-diff.mjs";
import { decodeRows, hex } from "./markers.mjs";

export const INTERP_QUERY = "core=upstream&video=software&presenter=webgpu&cpu=dual&speed=1&wasmjit=0&fastsw=1&metrics=1";
// Short warmup + forcejit so the JIT engages within seconds and the
// wall-clock fuse cannot silently turn it off on a loaded machine.
export const JIT_QUERY = "core=upstream&video=software&presenter=webgpu&cpu=dual&speed=1&wasmjit=1&jitwarmup=120&forcejit=1&fastsw=1&metrics=1";

const u32 = (v) => Number(v) >>> 0;

// Map a PC inside cpufuzz's generated code pool to (program, word).
export function mapPcToProgram(pc, symbols) {
  if (!symbols?.cpufuzz_code_pool || pc == null) return null;
  const base = Number.parseInt(symbols.cpufuzz_code_pool, 16);
  const bytesPerProgram = symbols.words_per_program * 4;
  const offset = u32(pc) - base;
  if (offset < 0 || offset >= bytesPerProgram * symbols.programs) return null;
  const program = Math.floor(offset / bytesPerProgram);
  return { program, word: (offset % bytesPerProgram) / 4, group: ["int", "branch", "fp+mem", "all"][program & 3] };
}

function firstFatalText(run) {
  return run.fatal?.find((e) => e.type !== "pageerror" || e.text !== "ErrorEvent")?.text?.split("\n")[0] ?? run.fatal?.[0]?.text ?? null;
}

// run = { capture: {index, ticks, width, height, data} | {error}, info: frame info, fatal: [] }
export function analyzeDifferential({ interp, jit, symbols = null }) {
  const findings = [];
  const add = (kind, detail = {}) => findings.push({ severity: "error", kind, ...detail });

  for (const [name, run] of [["interp", interp], ["jit", jit]]) {
    if (run.fatal?.length) {
      const where = name === "jit" ? mapPcToProgram(run.info?.pc, symbols) : null;
      add(`${name}-crash`, {
        error: firstFatalText(run),
        pc: hex(run.info?.pc ?? 0),
        ...(name === "jit" ? { jitBlocksCompiled: run.info?.jitc ?? null } : {}),
        ...(where ? { program: where.program, word: where.word, group: where.group } : {})
      });
    } else if (run.capture?.error) {
      add(`${name}-no-capture`, { error: run.capture.error });
    }
  }
  // A JIT that compiled or ran nothing compared nothing.
  if (!jit.fatal?.length && !(jit.info?.jitc > 0 && jit.info?.jitr > 0)) {
    add("jit-not-exercised", { jitBlocksCompiled: jit.info?.jitc ?? null, jitBlocksRun: jit.info?.jitr ?? null });
  }
  const a = interp.capture, b = jit.capture;
  if (findings.length || !a?.data || !b?.data) return { ok: findings.length === 0 && Boolean(a?.data && b?.data), findings };

  if (a.index !== b.index || Boolean(a.fromLoad) !== Boolean(b.fromLoad)) add("capture-frame-mismatch", { interp: [a.index, a.fromLoad], jit: [b.index, b.fromLoad] });
  for (const [name, c] of [["interp", a], ["jit", b]]) {
    if (compareFrames(c, c).candidateSigma < DEFAULT_THRESHOLDS.blankSigma) add(`${name}-blank-capture`);
  }
  if (!identical(a, b)) {
    const ra = decodeRows(a), rb = decodeRows(b);
    const rows = ra.ok && rb.ok ? ra.rows.map((_, i) => i).filter((i) => ra.rows[i] !== rb.rows[i]) : null;
    add("divergence", {
      differingPixels: differingPixels(a, b),
      ...(rows ? { rows, interp: ra.rows.map(hex), jit: rb.rows.map(hex) } : { rows: "unreadable" })
    });
  }
  // cpufuzz also checks itself against its frame-0 (interpreted) results:
  // row 2 counts the programs that changed, row 3 names the first one.
  const self = decodeRows(b);
  if (self.ok && symbols && (self.rows[2] & 0xffffff)) {
    add("jit-self-mismatch", { mismatchingPrograms: self.rows[2] & 0xffffff, groups: self.rows[2] >>> 24, firstProgram: self.rows[3] });
  }
  return { ok: findings.length === 0, findings };
}
