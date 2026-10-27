// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later
//
// EASU and RCAS below are a WGSL port of AMD FidelityFX Super Resolution 1.0
// (ffx_fsr1.h), Copyright (c) 2021 Advanced Micro Devices, Inc., MIT license:
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to
// deal in the Software without restriction, including without limitation the
// rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
// sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions: The above
// copyright notice and this permission notice shall be included in all copies
// or substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS",
// WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED.

// Display filter of the WebGPU path (docs/display-filter.md). With
// presentvsync (the default) each frame is a pooled texture at the core's
// backbuffer size, copied to the canvas at the worker's rAF. With the filter
// on, the canvas is sized to the page's display pixels instead and the copy
// becomes:
// - a scale to the display size: FSR1 EASU when the display is larger than
//   the backbuffer (edge-adaptive upscale), an area filter when it is
//   smaller (internal resolution above the display: supersampling, the
//   anti-aliasing setting), nothing when equal;
// - then FSR1 RCAS (contrast-adaptive sharpening), light or strong.
// The stream is captured from the pooled texture (presentvsync v3): it never
// sees the filter nor the display size.

export const DISPLAY_SHARPNESS = Object.freeze(["off", "light", "strong"]);

// RCAS strength in stops (FSR1's unit: 0 = strongest, each stop halves it).
// AMD's default is 0.2; light is a mild 1.0.
const RCAS_STOPS = Object.freeze({ light: 1.0, strong: 0.2 });

// The largest canvas the filter draws (per side): a 5K display at most.
export const DISPLAY_FILTER_MAX_SIDE = 5120;

export function normalizeDisplaySharpness(value) {
  const s = String(value ?? "").toLowerCase();
  if (s === "1") return "light";
  if (s === "2") return "strong";
  return DISPLAY_SHARPNESS.includes(s) ? s : "off";
}

// The filter's state as the worker keeps it: { sharpness, fit, box }. fit:
// size the canvas to the display box even without sharpening (an internal
// resolution above the display is then area-filtered down: supersampling);
// any sharpness implies it (displayFilterFits). box: the canvas element's
// size in device pixels, or null before the page measured it.
export function normalizeDisplayFilter({ sharpness, fit, box } = {}) {
  const w = Math.round(Number(box?.width)), h = Math.round(Number(box?.height));
  return {
    sharpness: normalizeDisplaySharpness(sharpness),
    fit: fit === true,
    box: w > 0 && h > 0 ? { width: w, height: h } : null
  };
}

// Whether the canvas follows the display (the filter draws the frames).
export function displayFilterFits(filter) {
  return filter?.fit === true || normalizeDisplaySharpness(filter?.sharpness) !== "off";
}

// ?fsr= and ?displayfit=1.
export function requestedDisplayFilter(search) {
  const params = new URLSearchParams(search || "");
  return normalizeDisplayFilter({
    sharpness: params.get("fsr"),
    fit: params.get("displayfit") === "1"
  });
}

export function rcasSharpnessStops(sharpness) {
  return RCAS_STOPS[normalizeDisplaySharpness(sharpness)] ?? null;
}

// The canvas size for a backbuffer `src` shown in a display box of `box`
// device pixels: the backbuffer's aspect fitted inside the box (the page
// lays the canvas out at the backbuffer's aspect, so this is the box), at
// most maxSide per side. No box (not measured, hidden): the backbuffer.
export function displayFilterOutputSize(src, box, { maxSide = DISPLAY_FILTER_MAX_SIDE } = {}) {
  const sw = Math.round(Number(src?.width)), sh = Math.round(Number(src?.height));
  if (!(sw > 0) || !(sh > 0)) return null;
  const bw = Math.round(Number(box?.width)), bh = Math.round(Number(box?.height));
  if (!(bw > 0) || !(bh > 0)) return { width: sw, height: sh };
  let scale = Math.min(bw / sw, bh / sh, maxSide / sw, maxSide / sh);
  let width = Math.max(1, Math.round(sw * scale));
  let height = Math.max(1, Math.round(sh * scale));
  // Within one pixel of the box on a side: the box (rounding).
  if (Math.abs(width - bw) <= 1 && Math.abs(height - bh) <= 1) { width = bw; height = bh; }
  return { width: Math.min(width, maxSide), height: Math.min(height, maxSide) };
}

// Which passes a frame takes: "easu" (upscale), "area" (downscale), or none
// for the scale; rcas with its stops or null.
export function displayFilterPlan(src, dst, sharpness) {
  const same = src.width === dst.width && src.height === dst.height;
  const scale = same ? null
    : (dst.width >= src.width && dst.height >= src.height ? "easu" : "area");
  return { scale, rcas: rcasSharpnessStops(sharpness) };
}

// FSR1 EASU constants (FsrEasuCon), the input viewport being the whole
// source texture. Four vec4 as one Float32Array(16).
export function easuConstants(srcW, srcH, dstW, dstH) {
  return new Float32Array([
    srcW / dstW, srcH / dstH, 0.5 * srcW / dstW - 0.5, 0.5 * srcH / dstH - 0.5,
    1 / srcW, 1 / srcH, 1 / srcW, -1 / srcH,
    -1 / srcW, 2 / srcH, 1 / srcW, 2 / srcH,
    0, 4 / srcH, 0, 0
  ]);
}

const FULLSCREEN_VS = /* wgsl */`
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// FsrEasuF (fp32): 12 taps from 4 gathers per channel, an edge direction and
// length from the luma of the 2x2 nearest quads, a stretched and clamped
// lanczos-like kernel along it, the result held within the 2x2's min/max.
export const EASU_WGSL = /* wgsl */`
struct Easu { con0: vec4f, con1: vec4f, con2: vec4f, con3: vec4f };
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> P: Easu;
${FULLSCREEN_VS}

fn rcpSafe(x: f32) -> f32 { return select(0.0, 1.0 / x, x > 0.0); }

fn easuSet(dir: ptr<function, vec2f>, len: ptr<function, f32>, w: f32,
           lA: f32, lB: f32, lC: f32, lD: f32, lE: f32) {
  let dc = lD - lC;
  let cb = lC - lB;
  let dirX = lD - lB;
  var lenX = clamp(abs(dirX) * rcpSafe(max(abs(dc), abs(cb))), 0.0, 1.0);
  lenX = lenX * lenX;
  let ec = lE - lC;
  let ca = lC - lA;
  let dirY = lE - lA;
  var lenY = clamp(abs(dirY) * rcpSafe(max(abs(ec), abs(ca))), 0.0, 1.0);
  lenY = lenY * lenY;
  *dir = *dir + vec2f(dirX, dirY) * w;
  *len = *len + (lenX + lenY) * w;
}

fn easuTap(aC: ptr<function, vec3f>, aW: ptr<function, f32>, off: vec2f, dir: vec2f,
           len: vec2f, lob: f32, clp: f32, c: vec3f) {
  var v = vec2f(off.x * dir.x + off.y * dir.y, off.x * -dir.y + off.y * dir.x);
  v = v * len;
  let d2 = min(v.x * v.x + v.y * v.y, clp);
  var wB = 0.4 * d2 - 1.0;
  var wA = lob * d2 - 1.0;
  wB = wB * wB;
  wA = wA * wA;
  wB = 1.5625 * wB - 0.5625;
  let w = wB * wA;
  *aC = *aC + c * w;
  *aW = *aW + w;
}

@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  var pp = floor(pos.xy) * P.con0.xy + P.con0.zw;
  let fp = floor(pp);
  pp = pp - fp;
  let p0 = fp * P.con1.xy + P.con1.zw;
  let p1 = p0 + P.con2.xy;
  let p2 = p0 + P.con2.zw;
  let p3 = p0 + P.con3.xy;
  let bczzR = textureGather(0, src, samp, p0);
  let bczzG = textureGather(1, src, samp, p0);
  let bczzB = textureGather(2, src, samp, p0);
  let ijfeR = textureGather(0, src, samp, p1);
  let ijfeG = textureGather(1, src, samp, p1);
  let ijfeB = textureGather(2, src, samp, p1);
  let klhgR = textureGather(0, src, samp, p2);
  let klhgG = textureGather(1, src, samp, p2);
  let klhgB = textureGather(2, src, samp, p2);
  let zzonR = textureGather(0, src, samp, p3);
  let zzonG = textureGather(1, src, samp, p3);
  let zzonB = textureGather(2, src, samp, p3);
  let bczzL = bczzB * 0.5 + (bczzR * 0.5 + bczzG);
  let ijfeL = ijfeB * 0.5 + (ijfeR * 0.5 + ijfeG);
  let klhgL = klhgB * 0.5 + (klhgR * 0.5 + klhgG);
  let zzonL = zzonB * 0.5 + (zzonR * 0.5 + zzonG);
  let bL = bczzL.x; let cL = bczzL.y;
  let iL = ijfeL.x; let jL = ijfeL.y; let fL = ijfeL.z; let eL = ijfeL.w;
  let kL = klhgL.x; let lL = klhgL.y; let hL = klhgL.z; let gL = klhgL.w;
  let oL = zzonL.z; let nL = zzonL.w;
  var dir = vec2f(0.0);
  var len = 0.0;
  easuSet(&dir, &len, (1.0 - pp.x) * (1.0 - pp.y), bL, eL, fL, gL, jL);
  easuSet(&dir, &len, pp.x * (1.0 - pp.y), cL, fL, gL, hL, kL);
  easuSet(&dir, &len, (1.0 - pp.x) * pp.y, fL, iL, jL, kL, nL);
  easuSet(&dir, &len, pp.x * pp.y, gL, jL, kL, lL, oL);
  let dir2 = dir * dir;
  var dirR = dir2.x + dir2.y;
  let zro = dirR < (1.0 / 32768.0);
  dirR = select(inverseSqrt(dirR), 1.0, zro);
  dir.x = select(dir.x, 1.0, zro);
  dir = dir * dirR;
  len = len * 0.5;
  len = len * len;
  let stretch = (dir.x * dir.x + dir.y * dir.y) / max(abs(dir.x), abs(dir.y));
  let len2 = vec2f(1.0 + (stretch - 1.0) * len, 1.0 - 0.5 * len);
  let lob = 0.5 + ((1.0 / 4.0 - 0.04) - 0.5) * len;
  let clp = 1.0 / lob;
  let b = vec3f(bczzR.x, bczzG.x, bczzB.x);
  let c = vec3f(bczzR.y, bczzG.y, bczzB.y);
  let i = vec3f(ijfeR.x, ijfeG.x, ijfeB.x);
  let j = vec3f(ijfeR.y, ijfeG.y, ijfeB.y);
  let f = vec3f(ijfeR.z, ijfeG.z, ijfeB.z);
  let e = vec3f(ijfeR.w, ijfeG.w, ijfeB.w);
  let k = vec3f(klhgR.x, klhgG.x, klhgB.x);
  let l = vec3f(klhgR.y, klhgG.y, klhgB.y);
  let h = vec3f(klhgR.z, klhgG.z, klhgB.z);
  let g = vec3f(klhgR.w, klhgG.w, klhgB.w);
  let o = vec3f(zzonR.z, zzonG.z, zzonB.z);
  let n = vec3f(zzonR.w, zzonG.w, zzonB.w);
  let min4 = min(min(f, g), min(j, k));
  let max4 = max(max(f, g), max(j, k));
  var aC = vec3f(0.0);
  var aW = 0.0;
  easuTap(&aC, &aW, vec2f(0.0, -1.0) - pp, dir, len2, lob, clp, b);
  easuTap(&aC, &aW, vec2f(1.0, -1.0) - pp, dir, len2, lob, clp, c);
  easuTap(&aC, &aW, vec2f(-1.0, 1.0) - pp, dir, len2, lob, clp, i);
  easuTap(&aC, &aW, vec2f(0.0, 1.0) - pp, dir, len2, lob, clp, j);
  easuTap(&aC, &aW, vec2f(0.0, 0.0) - pp, dir, len2, lob, clp, f);
  easuTap(&aC, &aW, vec2f(-1.0, 0.0) - pp, dir, len2, lob, clp, e);
  easuTap(&aC, &aW, vec2f(1.0, 1.0) - pp, dir, len2, lob, clp, k);
  easuTap(&aC, &aW, vec2f(2.0, 1.0) - pp, dir, len2, lob, clp, l);
  easuTap(&aC, &aW, vec2f(2.0, 0.0) - pp, dir, len2, lob, clp, h);
  easuTap(&aC, &aW, vec2f(1.0, 0.0) - pp, dir, len2, lob, clp, g);
  easuTap(&aC, &aW, vec2f(1.0, 2.0) - pp, dir, len2, lob, clp, o);
  easuTap(&aC, &aW, vec2f(0.0, 2.0) - pp, dir, len2, lob, clp, n);
  return vec4f(min(max4, max(min4, aC / aW)), 1.0);
}`;

// Downscale (supersampling): each display pixel averages its footprint in
// the source, n x n bilinear samples (n = ceil(ratio), at most 4): an exact
// box at integer ratios.
export const AREA_WGSL = /* wgsl */`
struct Area { ratio: vec2f, rcpSrc: vec2f, taps: vec2f, pad: vec2f };
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> P: Area;
${FULLSCREEN_VS}

@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let origin = floor(pos.xy) * P.ratio;
  let n = vec2u(P.taps);
  let step = P.ratio / P.taps;
  var acc = vec3f(0.0);
  for (var y = 0u; y < n.y; y++) {
    for (var x = 0u; x < n.x; x++) {
      let at = origin + (vec2f(f32(x), f32(y)) + 0.5) * step;
      acc += textureSampleLevel(src, samp, at * P.rcpSrc, 0.0).rgb;
    }
  }
  return vec4f(acc / f32(n.x * n.y), 1.0);
}`;

// FsrRcasF (fp32, no denoise): a 5-tap cross; the negative lobe is the
// largest that keeps every channel of the result within [0, 1] (the cross's
// min/max), capped at FSR_RCAS_LIMIT, times the sharpness.
export const RCAS_WGSL = /* wgsl */`
struct Rcas { sharp: vec4f };
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(2) var<uniform> P: Rcas;
${FULLSCREEN_VS}

fn tap(p: vec2i, size: vec2i) -> vec3f {
  return textureLoad(src, clamp(p, vec2i(0), size - 1), 0).rgb;
}

@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let size = vec2i(textureDimensions(src));
  let ip = vec2i(floor(pos.xy));
  let b = tap(ip + vec2i(0, -1), size);
  let d = tap(ip + vec2i(-1, 0), size);
  let e = tap(ip, size);
  let f = tap(ip + vec2i(1, 0), size);
  let h = tap(ip + vec2i(0, 1), size);
  let mn4 = min(min(b, d), min(f, h));
  let mx4 = max(max(b, d), max(f, h));
  let hitMin = mn4 / (4.0 * mx4);
  let hitMax = (1.0 - mx4) / (4.0 * mn4 - 4.0);
  let lobeC = max(-hitMin, hitMax);
  let limit = 0.25 - (1.0 / 16.0);
  let lobe = max(-limit, min(max(lobeC.r, max(lobeC.g, lobeC.b)), 0.0)) * P.sharp.x;
  let rcpL = 1.0 / (4.0 * lobe + 1.0);
  return vec4f((lobe * (b + d + h + f) + e) * rcpL, 1.0);
}`;

// The GPU side, made once per device and canvas format. encode() records
// the frame's passes from a pooled texture to the canvas texture.
export function createDisplayFilter(device, format) {
  const u = globalThis.GPUTextureUsage;
  const linear = device.createSampler({ label: "display-filter-linear", magFilter: "linear", minFilter: "linear" });
  const modules = new Map();
  const pipelines = new Map();
  const pipeline = (name, code) => {
    let p = pipelines.get(name);
    if (p) return p;
    let module = modules.get(name);
    if (!module) {
      module = device.createShaderModule({ label: `display-filter-${name}`, code });
      modules.set(name, module);
    }
    p = device.createRenderPipeline({
      label: `display-filter-${name}`,
      layout: "auto",
      vertex: { module, entryPoint: "vs" },
      fragment: { module, entryPoint: "fs", targets: [{ format }] },
      primitive: { topology: "triangle-list" }
    });
    pipelines.set(name, p);
    return p;
  };
  // One uniform buffer per pass kind (written before each encode; the
  // queue orders writeBuffer before the submit that follows).
  const uniforms = {
    easu: device.createBuffer({ label: "display-filter-easu", size: 64, usage: globalThis.GPUBufferUsage.UNIFORM | globalThis.GPUBufferUsage.COPY_DST }),
    area: device.createBuffer({ label: "display-filter-area", size: 32, usage: globalThis.GPUBufferUsage.UNIFORM | globalThis.GPUBufferUsage.COPY_DST }),
    rcas: device.createBuffer({ label: "display-filter-rcas", size: 16, usage: globalThis.GPUBufferUsage.UNIFORM | globalThis.GPUBufferUsage.COPY_DST })
  };
  let scratch = null;
  const stats = { frames: 0, easu: 0, area: 0, rcas: 0, copies: 0, encodeMsTotal: 0, encodeMsMax: 0 };

  const pass = (encoder, name, code, view, entries) => {
    const p = pipeline(name, code);
    const bindGroup = device.createBindGroup({ layout: p.getBindGroupLayout(0), entries });
    const rp = encoder.beginRenderPass({
      label: `display-filter-${name}`,
      colorAttachments: [{ view, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }]
    });
    rp.setPipeline(p);
    rp.setBindGroup(0, bindGroup);
    rp.draw(3);
    rp.end();
  };

  const scratchView = (width, height) => {
    if (!scratch || scratch.width !== width || scratch.height !== height) {
      scratch?.destroy();
      scratch = device.createTexture({
        label: "display-filter-scratch",
        size: [width, height],
        format,
        usage: u.RENDER_ATTACHMENT | u.TEXTURE_BINDING
      });
    }
    return scratch.createView();
  };

  return {
    stats,
    // src: a texture with TEXTURE_BINDING; dst: the canvas texture
    // (RENDER_ATTACHMENT). Returns the plan used.
    encode(encoder, src, dst, sharpness) {
      const t0 = performance.now();
      const plan = displayFilterPlan(src, dst, sharpness);
      const dstView = dst.createView();
      const srcView = src.createView();
      if (!plan.scale && plan.rcas === null) {
        encoder.copyTextureToTexture({ texture: src }, { texture: dst }, [dst.width, dst.height, 1]);
        stats.copies += 1;
      } else {
        let rcasSource = srcView;
        if (plan.scale) {
          const target = plan.rcas === null ? dstView : scratchView(dst.width, dst.height);
          if (plan.scale === "easu") {
            device.queue.writeBuffer(uniforms.easu, 0, easuConstants(src.width, src.height, dst.width, dst.height));
            pass(encoder, "easu", EASU_WGSL, target, [
              { binding: 0, resource: srcView }, { binding: 1, resource: linear }, { binding: 2, resource: { buffer: uniforms.easu } }
            ]);
            stats.easu += 1;
          } else {
            const rx = src.width / dst.width, ry = src.height / dst.height;
            device.queue.writeBuffer(uniforms.area, 0, new Float32Array([
              rx, ry, 1 / src.width, 1 / src.height,
              Math.min(4, Math.max(1, Math.ceil(rx - 1e-3))), Math.min(4, Math.max(1, Math.ceil(ry - 1e-3))), 0, 0
            ]));
            pass(encoder, "area", AREA_WGSL, target, [
              { binding: 0, resource: srcView }, { binding: 1, resource: linear }, { binding: 2, resource: { buffer: uniforms.area } }
            ]);
            stats.area += 1;
          }
          rcasSource = target;
        }
        if (plan.rcas !== null) {
          device.queue.writeBuffer(uniforms.rcas, 0, new Float32Array([2 ** -plan.rcas, 0, 0, 0]));
          pass(encoder, "rcas", RCAS_WGSL, dstView, [
            { binding: 0, resource: rcasSource }, { binding: 2, resource: { buffer: uniforms.rcas } }
          ]);
          stats.rcas += 1;
        }
      }
      stats.frames += 1;
      const ms = performance.now() - t0;
      stats.encodeMsTotal += ms;
      if (ms > stats.encodeMsMax) stats.encodeMsMax = ms;
      return plan;
    },
    destroy() {
      scratch?.destroy();
      scratch = null;
      for (const b of Object.values(uniforms)) b.destroy();
    }
  };
}
