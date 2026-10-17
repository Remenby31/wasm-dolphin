// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
// Interpreter-vs-JIT differential verdicts. Pure: takes the observations of
// two runs of the same homebrew and returns findings.
import { compareFrames, DEFAULT_THRESHOLDS } from "./image-diff.mjs";
import { hex } from "./markers.mjs";

export const INTERP_QUERY = "core=upstream&video=software&presenter=webgpu&cpu=dual&speed=1&wasmjit=0&fastsw=1&metrics=1";
// Short warmup + forcejit so the JIT engages within seconds and the
// wall-clock fuse cannot silently turn it off on a loaded machine.
export const JIT_QUERY = "core=upstream&video=software&presenter=webgpu&cpu=dual&speed=1&wasmjit=1&jitwarmup=120&forcejit=1&fastsw=1&metrics=1";

const u32 = (v) => (Number(v) >>> 0);

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

export function analyzeDifferential({ interp, jit, symbols = null, frameMatch = 0.99 }) {
  const findings = [];
  const add = (severity, kind, detail) => findings.push({ severity, kind, ...detail });
  const pcOf = (run) => run.info?.pc ?? run.progress?.ppcPc ?? null;

  if (interp.outcome === "fatal") add("error", "interp-crash", { error: firstFatalText(interp), pc: hex(pcOf(interp)) });
  if (jit.outcome === "fatal") {
    const where = mapPcToProgram(pcOf(jit), symbols);
    add("error", interp.outcome === "fatal" ? "crash-both" : "jit-crash", {
      error: firstFatalText(jit),
      pc: hex(pcOf(jit)),
      jitBlocksCompiled: jit.info?.jitc ?? null,
      ...(where ? { program: where.program, word: where.word, group: where.group } : {})
    });
  }
  for (const [name, run] of [["interp", interp], ["jit", jit]]) {
    if (run.outcome === "timeout" || run.outcome === "stalled") add("error", `${name}-${run.outcome}`, { frame: run.info?.frame ?? null });
    if (run.markers?.status === "fail") {
      const r = run.markers.rows;
      add("error", `${name}-self-mismatch`, {
        mismatchingPrograms: r[2] & 0xffffff,
        groups: r[2] >>> 24,
        firstProgram: r[3] === 0xffffffff ? null : r[3]
      });
    }
  }
  // A JIT that compiled or ran nothing compared nothing: that is a failure,
  // not a pass.
  if (jit.outcome === "done" && !(jit.info?.jitc > 0 && jit.info?.jitr > 0)) {
    add("error", "jit-not-exercised", { jitBlocksCompiled: jit.info?.jitc ?? null, jitBlocksRun: jit.info?.jitr ?? null });
  }

  if (interp.outcome === "done" && jit.outcome === "done") {
    const im = interp.markers, jm = jit.markers;
    if (im?.confident && jm?.confident) {
      // Every row: padtest has one row per port, cpufuzz one per check.
      const rows = im.rows.map((v, i) => i).filter((i) => im.rows[i] !== jm.rows[i]);
      if (rows.length) add("error", "divergence", { rows, interp: im.rows.map(hex), jit: jm.rows.map(hex) });
    } else if (im?.confident !== jm?.confident) {
      add("error", "markers-unreadable", { interp: Boolean(im?.confident), jit: Boolean(jm?.confident) });
    } else if (interp.frame && jit.frame) {
      // Two black screens are equal and prove nothing.
      for (const [name, run] of [["interp", interp], ["jit", jit]]) {
        const { candidateSigma } = compareFrames(run.frame, run.frame);
        if (candidateSigma < DEFAULT_THRESHOLDS.blankSigma) add("error", `${name}-blank-frame`, { candidateSigma });
      }
      const d = compareFrames(interp.frame, jit.frame);
      if (d.ssim < frameMatch) add("error", "frame-divergence", { ssim: d.ssim, meanAbs: d.meanAbs });
    }
  }
  return { ok: !findings.some((f) => f.severity === "error"), findings };
}
