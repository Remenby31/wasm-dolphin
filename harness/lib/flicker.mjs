// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// Glitch-meter G4: the temporal A-B-A detector. The worker keeps a signature
// of each presented picture (src/harness-flicker.js: sampled rows as luma).
// A picture that comes and goes, A then B then A again, is a glitch the eye
// sees as a flash: a pass lost for one frame, a stale buffer, an older image
// shown again. Motion never looks like that: from A to C a scene moves at
// least as far as from A to B. So, over the distinct pictures in present
// order (a picture presented twice in a row counts once), B is flagged when
// both its steps are real changes and its neighbours are much closer to each
// other than to it:
//   min(d(A,B), d(B,C)) >= floor   and   d(A,C) <= ratio * min(d(A,B), d(B,C))
// d: mean absolute luma difference (0-255) over the signature.

export const FLICKER_FLOOR = 1.0;
export const FLICKER_RATIO = 0.25;

export function signatureDistance(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i += 1) s += Math.abs(a[i] - b[i]);
  return a.length ? s / a.length : 0;
}

const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// The worker's answer ({ frames: [{ seq, at, b64 } | { seq, at, gap }] }) as
// runs of distinct pictures: a gap ends a run (no triple spans it).
export function distinctRuns(watch, decode = (b64) => new Uint8Array(Buffer.from(b64, "base64"))) {
  const runs = [];
  let run = [];
  for (const f of watch?.frames ?? []) {
    if (f.gap || !f.b64) {
      if (run.length) runs.push(run);
      run = [];
      continue;
    }
    const sig = decode(f.b64);
    const last = run.at(-1);
    if (last && same(last.sig, sig)) {
      last.presents += 1;
      // the ops of a picture presented again still fed the stream
      for (const [k, n] of Object.entries(f.ops ?? {})) last.ops[k] = (last.ops[k] ?? 0) + n;
      continue;
    }
    run.push({ seq: f.seq, at: f.at, vi: f.vi ?? null, source: f.source ?? null, ops: { ...(f.ops ?? {}) }, sig, presents: 1 });
  }
  if (run.length) runs.push(run);
  return runs;
}

// Every A-B-A in the runs, and how close clean motion came to the rule (the
// smallest ratio seen among triples whose steps are real changes).
// Where B differs from A, in signature cells (luma apart by more than
// `threshold`): the bounding box as shares of the width and height, and the
// share of cells changed. A HUD element, a texture, or the whole scene.
export function changedRegion(a, b, cols, rows, threshold = 16) {
  let r0 = rows, r1 = -1, c0 = cols, c1 = -1, n = 0;
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      if (Math.abs(a[r * cols + c] - b[r * cols + c]) <= threshold) continue;
      n += 1;
      if (r < r0) r0 = r;
      if (r > r1) r1 = r;
      if (c < c0) c0 = c;
      if (c > c1) c1 = c;
    }
  }
  if (!n) return null;
  const share = (x, of) => Math.round((x / of) * 1000) / 1000;
  return { top: share(r0, rows), bottom: share(r1 + 1, rows), left: share(c0, cols), right: share(c1 + 1, cols), changed: share(n, rows * cols) };
}

export function findFlicker(runs, { floor = FLICKER_FLOOR, ratio = FLICKER_RATIO, cols = 0, rows = 0 } = {}) {
  const flagged = [];
  let triples = 0;
  let closest = null;
  for (const run of runs) {
    for (let i = 1; i + 1 < run.length; i += 1) {
      const [a, b, c] = [run[i - 1], run[i], run[i + 1]];
      const ab = signatureDistance(a.sig, b.sig), bc = signatureDistance(b.sig, c.sig), ac = signatureDistance(a.sig, c.sig);
      const step = Math.min(ab, bc);
      if (step < floor) continue;
      triples += 1;
      const r = ac / step;
      if (closest === null || r < closest) closest = r;
      if (r <= ratio) {
        flagged.push({ seqA: a.seq, seqB: b.seq, seqC: c.seq, viA: a.vi, viB: b.vi, viC: c.vi, atB: b.at, presentsB: b.presents,
          ab: round(ab), bc: round(bc), ac: round(ac), ratio: round(r),
          region: cols && rows ? changedRegion(a.sig, b.sig, cols, rows) : null,
          ops: { A: a.ops, B: b.ops, C: c.ops }, sources: { A: a.source, B: b.source, C: c.source }, frames: [a, b, c] });
      }
    }
  }
  return { triples, distinct: runs.reduce((s, r) => s + r.length, 0), runs: runs.length, closestRatio: closest === null ? null : round(closest), flagged };
}

const round = (x) => Math.round(x * 1000) / 1000;

// The three pictures of a flagged triple side by side, in gray, each sampled
// row drawn `rowHeight` pixels tall: an image to look at.
export function tripleStrip(triple, cols, rows, rowHeight = 4) {
  const gap = 4;
  const width = cols * 3 + gap * 2;
  const height = rows * rowHeight;
  const data = new Uint8Array(width * height * 4).fill(255);
  triple.frames.forEach((f, k) => {
    const x0 = k * (cols + gap);
    for (let r = 0; r < rows; r += 1) {
      for (let y = r * rowHeight; y < (r + 1) * rowHeight; y += 1) {
        for (let c = 0; c < cols; c += 1) {
          const v = f.sig[r * cols + c];
          const o = (y * width + x0 + c) * 4;
          data[o] = data[o + 1] = data[o + 2] = v;
        }
      }
    }
  });
  return { width, height, data };
}
