// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
// Compare a candidate frame (e.g. wgpu) with a reference frame (e.g. software
// renderer) of the same scene. Both are resampled to a small fixed grid so
// resolution and scaler differences do not matter, then scored with:
//   ssim        mean block SSIM on luma (1 = identical structure)
//   lostDetail  share of reference blocks that carry detail (texture, edges,
//               geometry) but are flat in the candidate. This is the
//               "overlay drawn, 3D missing" signature: HUD blocks still match,
//               world blocks go flat black or flat clear-colour.
//   meanAbs     mean absolute RGB difference, 0-255
// Frame = { width, height, data: Uint8Array RGBA }.

export const GRID_W = 160;
export const GRID_H = 120;
const BLOCK = 8;
const DEFAULT_BLOCK = BLOCK;
const DETAIL_SIGMA = 6; // luma stdev (0-255) above which a block "has detail"
const C1 = (0.01 * 255) ** 2;
const C2 = (0.03 * 255) ** 2;

export const DEFAULT_THRESHOLDS = Object.freeze({ match: 0.9, lostDetail: 0.3, blankSigma: 2, extent: 0.02 });

// Horizontal/vertical extent of non-black content, as fractions of the frame:
// catches letterboxing and shrunk viewports that SSIM only reports as "different".
export function contentExtent(frame, threshold = 12) {
  const { width, height, data } = frame;
  const col = new Float64Array(width), row = new Float64Array(height);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const i = (y * width + x) * 4;
    const l = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    col[x] += l / height; row[y] += l / width;
  }
  const span = (v) => {
    let a = 0, b = v.length - 1;
    while (a < v.length && v[a] < threshold) a += 1;
    while (b > a && v[b] < threshold) b -= 1;
    return a >= v.length ? null : [a / v.length, (b + 1) / v.length];
  };
  return { x: span(col), y: span(row) };
}

// Area-average resample to GRID_W x GRID_H; returns { rgb: Float32Array(w*h*3), luma: Float32Array(w*h) }.
export function resample(frame, w = GRID_W, h = GRID_H, crop = null) {
  const { width, height, data } = frame;
  const cx = crop?.x ?? 0, cy = crop?.y ?? 0;
  const cw = crop?.width ?? width, ch = crop?.height ?? height;
  const rgb = new Float32Array(w * h * 3);
  const luma = new Float32Array(w * h);
  for (let gy = 0; gy < h; gy += 1) {
    const y0 = cy + Math.floor((gy * ch) / h), y1 = Math.max(y0 + 1, cy + Math.floor(((gy + 1) * ch) / h));
    for (let gx = 0; gx < w; gx += 1) {
      const x0 = cx + Math.floor((gx * cw) / w), x1 = Math.max(x0 + 1, cx + Math.floor(((gx + 1) * cw) / w));
      let r = 0, g = 0, b = 0, n = 0;
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          const i = (y * width + x) * 4;
          r += data[i]; g += data[i + 1]; b += data[i + 2]; n += 1;
        }
      }
      const o = gy * w + gx;
      rgb[o * 3] = r / n; rgb[o * 3 + 1] = g / n; rgb[o * 3 + 2] = b / n;
      luma[o] = 0.299 * (r / n) + 0.587 * (g / n) + 0.114 * (b / n);
    }
  }
  return { rgb, luma, w, h };
}

function blockStats(luma, w, bx, by, block = BLOCK) {
  let s = 0, s2 = 0;
  for (let y = by; y < by + block; y += 1) for (let x = bx; x < bx + block; x += 1) { const v = luma[y * w + x]; s += v; s2 += v * v; }
  const n = block * block, m = s / n;
  return { mean: m, variance: Math.max(0, s2 / n - m * m) };
}

export function compareFrames(reference, candidate, { thresholds = DEFAULT_THRESHOLDS, crop = null, grid = null } = {}) {
  const w = grid?.width ?? GRID_W, h = grid?.height ?? GRID_H, BLOCK = grid?.block ?? DEFAULT_BLOCK;
  const a = resample(reference, w, h, crop);
  const b = resample(candidate, w, h, crop);
  let ssimSum = 0, blocks = 0, detailed = 0, lost = 0;
  const blockMap = [];
  for (let by = 0; by < h; by += BLOCK) {
    for (let bx = 0; bx < w; bx += BLOCK) {
      const sa = blockStats(a.luma, w, bx, by, BLOCK);
      const sb = blockStats(b.luma, w, bx, by, BLOCK);
      let cov = 0;
      for (let y = by; y < by + BLOCK; y += 1) for (let x = bx; x < bx + BLOCK; x += 1) {
        cov += (a.luma[y * w + x] - sa.mean) * (b.luma[y * w + x] - sb.mean);
      }
      cov /= BLOCK * BLOCK;
      const ssim = ((2 * sa.mean * sb.mean + C1) * (2 * cov + C2)) /
        ((sa.mean ** 2 + sb.mean ** 2 + C1) * (sa.variance + sb.variance + C2));
      ssimSum += ssim;
      blocks += 1;
      const sigA = Math.sqrt(sa.variance), sigB = Math.sqrt(sb.variance);
      let state = "ok";
      if (sigA > DETAIL_SIGMA) {
        detailed += 1;
        if (sigB < 0.25 * sigA) { lost += 1; state = "lost"; }
      }
      blockMap.push({ x: bx, y: by, ssim, state });
    }
  }
  let absSum = 0, lumaSum = 0, lumaSq = 0;
  for (let i = 0; i < a.rgb.length; i += 1) absSum += Math.abs(a.rgb[i] - b.rgb[i]);
  for (const v of b.luma) { lumaSum += v; lumaSq += v * v; }
  const candSigma = Math.sqrt(Math.max(0, lumaSq / b.luma.length - (lumaSum / b.luma.length) ** 2));
  const ssim = ssimSum / blocks;
  const lostDetail = detailed ? lost / detailed : 0;
  const extent = { reference: contentExtent(reference), candidate: contentExtent(candidate) };
  const off = (axis) => {
    const a = extent.reference[axis], b = extent.candidate[axis];
    return a && b ? Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1])) : 0;
  };
  const extentDelta = Math.max(off("x"), off("y"));
  let verdict = "different";
  if (candSigma < thresholds.blankSigma) verdict = "blank";
  else if (lostDetail >= thresholds.lostDetail) verdict = "missing-detail";
  // Geometry before SSIM: a picture squeezed by a few percent can still score
  // a high SSIM on smooth content.
  else if (extentDelta > thresholds.extent) verdict = "geometry-mismatch";
  else if (ssim >= thresholds.match) verdict = "match";
  return {
    verdict,
    ssim: Math.round(ssim * 1000) / 1000,
    lostDetail: Math.round(lostDetail * 1000) / 1000,
    detailedBlocks: detailed,
    meanAbs: Math.round((absSum / a.rgb.length) * 10) / 10,
    candidateSigma: Math.round(candSigma * 10) / 10,
    extentDelta: Math.round(extentDelta * 1000) / 1000,
    extent,
    grid: { width: w, height: h, block: BLOCK },
    blockMap
  };
}

// Side-by-side visual: reference | candidate | per-block heat (red = lost, yellow = low SSIM).
// Two captures of an animated scene taken a frame or two apart differ by a
// small motion. When the captured emulated frames are at most
// PHASE_TOLERANCE.maxFrameGap apart, compare on a coarse 48×36 grid (cells of
// ~13 px at 640×480), where a few pixels of motion barely move the blocks,
// with a lower match bar. Gross faults (blank, missing detail, squeezed) keep
// their normal thresholds. Beyond the gap, no render verdict is possible.
export const PHASE_TOLERANCE = Object.freeze({ maxFrameGap: 2, grid: { width: 48, height: 36, block: 4 }, match: 0.8 });

export function compareAtFrames(reference, candidate, frameGap) {
  if (!Number.isFinite(frameGap) || frameGap > PHASE_TOLERANCE.maxFrameGap) {
    return { verdict: "frames-differ", frameGap: Number.isFinite(frameGap) ? frameGap : null };
  }
  const exact = compareFrames(reference, candidate);
  if (frameGap === 0 || exact.verdict !== "different") return { ...exact, frameGap };
  const coarse = compareFrames(reference, candidate, { grid: PHASE_TOLERANCE.grid, thresholds: { ...DEFAULT_THRESHOLDS, match: PHASE_TOLERANCE.match } });
  return { ...exact, frameGap, coarseSsim: coarse.ssim, verdict: coarse.verdict === "match" ? "match" : "different" };
}

export function diffImage(reference, candidate, result) {
  const a = resample(reference), b = resample(candidate);
  const W = GRID_W * 3, H = GRID_H;
  const out = new Uint8Array(W * H * 4);
  const put = (x, y, r, g, bl) => { const i = (y * W + x) * 4; out[i] = r; out[i + 1] = g; out[i + 2] = bl; out[i + 3] = 255; };
  for (let y = 0; y < H; y += 1) for (let x = 0; x < GRID_W; x += 1) {
    const o = (y * GRID_W + x) * 3;
    put(x, y, a.rgb[o], a.rgb[o + 1], a.rgb[o + 2]);
    put(x + GRID_W, y, b.rgb[o], b.rgb[o + 1], b.rgb[o + 2]);
  }
  for (const blk of result.blockMap) {
    const heat = blk.state === "lost" ? [230, 30, 30] : blk.ssim < 0.5 ? [230, 200, 30] : [Math.round(40 * blk.ssim), Math.round(120 * blk.ssim), 40];
    for (let y = blk.y; y < blk.y + BLOCK; y += 1) for (let x = blk.x; x < blk.x + BLOCK; x += 1) put(x + 2 * GRID_W, y, ...heat);
  }
  return { width: W, height: H, data: out };
}
