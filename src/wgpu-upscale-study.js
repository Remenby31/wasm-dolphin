// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// Upscaling study (docs/upscaling-study.md), prototype only. Two pieces the
// worker's WebGPU presenter opts into from the page URL:
//
// - a presentation upscaler (?upscale=easu|bilinear&upscalex=2|3&sharp=0.2):
//   the frame Dolphin presents is drawn into an offscreen texture at its own
//   size, then filtered into a canvas `upscalex` times larger. "easu" is AMD
//   FidelityFX FSR 1 (EASU, then RCAS sharpening; MIT), ported to WGSL from
//   the reference ffx_fsr1.h, fp32 path. "bilinear" is the reference a GPU
//   would do anyway when the page stretches the canvas.
// - a GPU pass timer (?gputime=1): timestamp queries around every render
//   pass of a present, summed per present. Needs the adapter's
//   timestamp-query feature; Chrome rounds timestamps to 100 µs unless
//   launched with --enable-webgpu-developer-features.

export function requestedUpscaleStudy(search) {
  const q = new URLSearchParams(search);
  const filter = ["easu", "bilinear"].includes(q.get("upscale")) ? q.get("upscale") : "";
  const factor = [2, 3].includes(Number(q.get("upscalex"))) ? Number(q.get("upscalex")) : 2;
  const sharp = Number.parseFloat(q.get("sharp") ?? "0.2");
  return {
    filter,
    factor,
    // RCAS sharpness in stops: 0 is the strongest, each stop halves it.
    sharpness: Number.isFinite(sharp) ? Math.min(2, Math.max(0, sharp)) : 0.2,
    gpuTime: q.get("gputime") === "1"
  };
}

const FULLSCREEN_VS = /* wgsl */ `
@vertex fn vs(@builtin(vertex_index) i : u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// EASU: 12 taps around the output pixel's source position, an edge
// direction and length from the luma of the inner 2x2, then a stretched
// Lanczos-2 approximation along that edge, clamped to the inner 2x2 range.
const EASU_WGSL = /* wgsl */ `
${FULLSCREEN_VS}
struct Easu { con0 : vec4f, con1 : vec4f, con2 : vec4f, con3 : vec4f }
@group(0) @binding(0) var src : texture_2d<f32>;
@group(0) @binding(1) var<uniform> u : Easu;

fn tap(base : vec2i, o : vec2i, hi : vec2i) -> vec3f {
  return textureLoad(src, clamp(base + o, vec2i(0), hi), 0).rgb;
}
fn luma(c : vec3f) -> f32 { return c.g + 0.5 * (c.r + c.b); }

fn setF(dir : ptr<function, vec2f>, len : ptr<function, f32>, w : f32,
        lA : f32, lB : f32, lC : f32, lD : f32, lE : f32) {
  var lenX = max(abs(lD - lC), abs(lC - lB));
  let dirX = lD - lB;
  (*dir).x += dirX * w;
  lenX = select(0.0, clamp(abs(dirX) / lenX, 0.0, 1.0), lenX > 0.0);
  lenX *= lenX;
  *len += lenX * w;
  var lenY = max(abs(lE - lC), abs(lC - lA));
  let dirY = lE - lA;
  (*dir).y += dirY * w;
  lenY = select(0.0, clamp(abs(dirY) / lenY, 0.0, 1.0), lenY > 0.0);
  lenY *= lenY;
  *len += lenY * w;
}

fn tapF(aC : ptr<function, vec3f>, aW : ptr<function, f32>, off : vec2f, dir : vec2f,
        len : vec2f, lob : f32, clp : f32, c : vec3f) {
  var v = vec2f(dot(off, dir), dot(off, vec2f(-dir.y, dir.x))) * len;
  let d2 = min(dot(v, v), clp);
  var wB = 0.4 * d2 - 1.0;
  var wA = lob * d2 - 1.0;
  wB *= wB;
  wA *= wA;
  wB = 1.5625 * wB - 0.5625;
  let w = wB * wA;
  *aC += c * w;
  *aW += w;
}

@fragment fn fs(@builtin(position) pos : vec4f) -> @location(0) vec4f {
  var pp = floor(pos.xy) * u.con0.xy + u.con0.zw;
  let fp = floor(pp);
  pp -= fp;
  // The 12 texels around fp, loaded directly (ffx_fsr1.h gathers the same
  // ones through p0..p3 and con1..con3, which only a gather needs):
  //    b c
  //  e f g h
  //  i j k l
  //    n o
  let base = vec2i(fp);
  let hi = vec2i(textureDimensions(src)) - 1;
  let bC = tap(base, vec2i(0, -1), hi); let bL = luma(bC);
  let cC = tap(base, vec2i(1, -1), hi); let cL = luma(cC);
  let eC = tap(base, vec2i(-1, 0), hi); let eL = luma(eC);
  let fC = tap(base, vec2i(0, 0), hi); let fL = luma(fC);
  let gC = tap(base, vec2i(1, 0), hi); let gL = luma(gC);
  let hC = tap(base, vec2i(2, 0), hi); let hL = luma(hC);
  let iC = tap(base, vec2i(-1, 1), hi); let iL = luma(iC);
  let jC = tap(base, vec2i(0, 1), hi); let jL = luma(jC);
  let kC = tap(base, vec2i(1, 1), hi); let kL = luma(kC);
  let lC = tap(base, vec2i(2, 1), hi); let lL = luma(lC);
  let nC = tap(base, vec2i(0, 2), hi); let nL = luma(nC);
  let oC = tap(base, vec2i(1, 2), hi); let oL = luma(oC);

  var dir = vec2f(0.0);
  var len = 0.0;
  setF(&dir, &len, (1.0 - pp.x) * (1.0 - pp.y), bL, eL, fL, gL, jL);
  setF(&dir, &len, pp.x * (1.0 - pp.y), cL, fL, gL, hL, kL);
  setF(&dir, &len, (1.0 - pp.x) * pp.y, fL, iL, jL, kL, nL);
  setF(&dir, &len, pp.x * pp.y, gL, jL, kL, lL, oL);

  let dir2 = dir * dir;
  var dirR = dir2.x + dir2.y;
  let zro = dirR < (1.0 / 32768.0);
  dirR = select(inverseSqrt(dirR), 1.0, zro);
  dir.x = select(dir.x, 1.0, zro);
  dir *= dirR;
  len = len * 0.5;
  len *= len;
  let stretch = dot(dir, dir) / max(abs(dir.x), abs(dir.y));
  let len2 = vec2f(1.0 + (stretch - 1.0) * len, 1.0 - 0.5 * len);
  let lob = 0.5 - 0.29 * len;
  let clp = 1.0 / lob;

  let min4 = min(min(fC, gC), min(jC, kC));
  let max4 = max(max(fC, gC), max(jC, kC));
  var aC = vec3f(0.0);
  var aW = 0.0;
  tapF(&aC, &aW, vec2f(0.0, -1.0) - pp, dir, len2, lob, clp, bC);
  tapF(&aC, &aW, vec2f(1.0, -1.0) - pp, dir, len2, lob, clp, cC);
  tapF(&aC, &aW, vec2f(-1.0, 1.0) - pp, dir, len2, lob, clp, iC);
  tapF(&aC, &aW, vec2f(0.0, 1.0) - pp, dir, len2, lob, clp, jC);
  tapF(&aC, &aW, vec2f(0.0, 0.0) - pp, dir, len2, lob, clp, fC);
  tapF(&aC, &aW, vec2f(-1.0, 0.0) - pp, dir, len2, lob, clp, eC);
  tapF(&aC, &aW, vec2f(1.0, 1.0) - pp, dir, len2, lob, clp, kC);
  tapF(&aC, &aW, vec2f(2.0, 1.0) - pp, dir, len2, lob, clp, lC);
  tapF(&aC, &aW, vec2f(2.0, 0.0) - pp, dir, len2, lob, clp, hC);
  tapF(&aC, &aW, vec2f(1.0, 0.0) - pp, dir, len2, lob, clp, gC);
  tapF(&aC, &aW, vec2f(1.0, 2.0) - pp, dir, len2, lob, clp, oC);
  tapF(&aC, &aW, vec2f(0.0, 2.0) - pp, dir, len2, lob, clp, nC);
  return vec4f(min(max4, max(min4, aC / aW)), 1.0);
}`;

// RCAS: a cross of 5 taps, the strongest sharpening that cannot push a
// channel out of the cross's own range, scaled by exp2(-sharpness).
const RCAS_WGSL = /* wgsl */ `
${FULLSCREEN_VS}
@group(0) @binding(0) var src : texture_2d<f32>;
@group(0) @binding(1) var<uniform> sharp : vec4f;

fn ld(p : vec2i) -> vec3f {
  let size = vec2i(textureDimensions(src));
  return textureLoad(src, clamp(p, vec2i(0), size - 1), 0).rgb;
}
fn max3(a : vec3f, b : vec3f, c : vec3f) -> vec3f { return max(a, max(b, c)); }
fn min3(a : vec3f, b : vec3f, c : vec3f) -> vec3f { return min(a, min(b, c)); }

@fragment fn fs(@builtin(position) pos : vec4f) -> @location(0) vec4f {
  let sp = vec2i(pos.xy);
  let b = ld(sp + vec2i(0, -1));
  let d = ld(sp + vec2i(-1, 0));
  let e = ld(sp);
  let f = ld(sp + vec2i(1, 0));
  let h = ld(sp + vec2i(0, 1));
  let mn4 = min(min3(b, d, f), h);
  let mx4 = max(max3(b, d, f), h);
  // ffx_fsr1.h relies on rcp(0) = inf and saturate(NaN) = 0; keep the
  // denominators away from 0 instead (black or white neighbourhoods).
  let hitMin = min(mn4, e) / max(4.0 * mx4, vec3f(1.0 / 65536.0));
  let hitMax = (vec3f(1.0) - max(mx4, e)) / min(4.0 * mn4 - 4.0, vec3f(-1.0 / 65536.0));
  let lobeRGB = max(-hitMin, hitMax);
  let limit = 0.25 - 1.0 / 16.0;
  let lobe = max(-limit, min(max(lobeRGB.r, max(lobeRGB.g, lobeRGB.b)), 0.0)) * sharp.x;
  let c = (lobe * (b + d + f + h) + e) / (4.0 * lobe + 1.0);
  return vec4f(c, 1.0);
}`;

const BILINEAR_WGSL = /* wgsl */ `
${FULLSCREEN_VS}
@group(0) @binding(0) var src : texture_2d<f32>;
@group(0) @binding(1) var smp : sampler;
@group(0) @binding(2) var<uniform> outSize : vec4f;
@fragment fn fs(@builtin(position) pos : vec4f) -> @location(0) vec4f {
  return vec4f(textureSampleLevel(src, smp, pos.xy / outSize.xy, 0.0).rgb, 1.0);
}`;

// The four EASU constants of ffx_fsr1.h (FsrEasuCon) for a full-texture
// viewport, as 16 floats.
export function easuConstants(inW, inH, outW, outH) {
  return new Float32Array([
    inW / outW, inH / outH, 0.5 * inW / outW - 0.5, 0.5 * inH / outH - 0.5,
    1 / inW, 1 / inH, 1 / inW, -1 / inH,
    -1 / inW, 2 / inH, 1 / inW, 2 / inH,
    0 / inW, 4 / inH, 0, 0
  ]);
}

// Owns the offscreen source (what Dolphin's backbuffer pass draws into) and
// the passes from it to the canvas texture.
// `externalSource` (a texture view, srcW x srcH): filter that texture
// instead (the software path's uploaded XFB).
export function createPostUpscaler(device, format, { srcW, srcH, outW, outH, filter, sharpness, externalSource = null }) {
  const U = self.GPUTextureUsage, B = self.GPUBufferUsage;
  const tex = (w, h, label) => device.createTexture({
    label, size: [w, h], format,
    usage: U.RENDER_ATTACHMENT | U.TEXTURE_BINDING | U.COPY_SRC
  });
  const source = externalSource ? null : tex(srcW, srcH, "upscale-study source");
  const sourceView = externalSource ?? source.createView();
  const pipeline = (code, label) => device.createRenderPipeline({
    label, layout: "auto",
    vertex: { module: device.createShaderModule({ code, label }), entryPoint: "vs" },
    fragment: { module: device.createShaderModule({ code, label }), entryPoint: "fs", targets: [{ format }] },
    primitive: { topology: "triangle-list" }
  });
  const uniform = (data) => {
    const buf = device.createBuffer({ size: Math.max(16, data.byteLength), usage: B.UNIFORM | B.COPY_DST });
    device.queue.writeBuffer(buf, 0, data);
    return buf;
  };
  const steps = [];
  if (filter === "easu") {
    const mid = tex(outW, outH, "upscale-study easu");
    const easu = pipeline(EASU_WGSL, "upscale-study EASU");
    const rcas = pipeline(RCAS_WGSL, "upscale-study RCAS");
    steps.push({ pipeline: easu, target: mid.createView(), bind: device.createBindGroup({
      layout: easu.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: sourceView },
                { binding: 1, resource: { buffer: uniform(easuConstants(srcW, srcH, outW, outH)) } }]
    }) });
    steps.push({ pipeline: rcas, target: null, bind: device.createBindGroup({
      layout: rcas.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: mid.createView() },
                { binding: 1, resource: { buffer: uniform(new Float32Array([2 ** -sharpness, 0, 0, 0])) } }]
    }) });
  } else {
    const bil = pipeline(BILINEAR_WGSL, "upscale-study bilinear");
    steps.push({ pipeline: bil, target: null, bind: device.createBindGroup({
      layout: bil.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: sourceView },
                { binding: 1, resource: device.createSampler({ magFilter: "linear", minFilter: "linear" }) },
                { binding: 2, resource: { buffer: uniform(new Float32Array([outW, outH, 0, 0])) } }]
    }) });
  }
  return {
    source, sourceView, srcW, srcH, outW, outH, filter,
    // Encodes the filter into `canvasView`; `timer` (optional) wraps each
    // pass so the presentation cost shows separately.
    encode(enc, canvasView, timer = null) {
      for (const step of steps) {
        const desc = { colorAttachments: [{ view: step.target ?? canvasView, loadOp: "clear",
          clearValue: { r: 0, g: 0, b: 0, a: 1 }, storeOp: "store" }] };
        timer?.wrap(desc, "post");
        const pass = enc.beginRenderPass(desc);
        pass.setPipeline(step.pipeline);
        pass.setBindGroup(0, step.bind);
        pass.draw(3);
        pass.end();
      }
    }
  };
}

// Sums the GPU time of the render passes between two presents. Each pass
// gets a begin/end timestamp pair; at present the pairs are resolved and
// read back asynchronously (a ring of readback buffers, never waited on).
export function createGpuPassTimer(device, { maxPasses = 512, ring = 16 } = {}) {
  if (!device.features?.has?.("timestamp-query")) return null;
  const B = self.GPUBufferUsage;
  const count = maxPasses * 2;
  const querySet = device.createQuerySet({ type: "timestamp", count });
  const resolve = device.createBuffer({ size: count * 8, usage: B.QUERY_RESOLVE | B.COPY_SRC });
  const reads = Array.from({ length: ring }, () => ({
    buf: device.createBuffer({ size: count * 8, usage: B.MAP_READ | B.COPY_DST }), busy: false
  }));
  let used = 0, overflow = 0, dropped = 0;
  const kinds = [];
  const frames = []; // { totalMs, postMs, passes }
  const stats = () => {
    const pick = (k) => frames.map((f) => f[k]).sort((a, b) => a - b);
    const q = (arr, p) => arr.length ? arr[Math.min(arr.length - 1, Math.floor(p * arr.length))] : null;
    const total = pick("totalMs"), post = pick("postMs"), passes = pick("passes"), span = pick("spanMs");
    return {
      frames: frames.length, overflow, dropped,
      totalMs: { p50: q(total, 0.5), p90: q(total, 0.9), p99: q(total, 0.99),
                 mean: total.length ? total.reduce((a, b) => a + b, 0) / total.length : null },
      spanMs: { p50: q(span, 0.5), p90: q(span, 0.9) },
      postMs: { p50: q(post, 0.5), mean: post.length ? post.reduce((a, b) => a + b, 0) / post.length : null },
      passes: { p50: q(passes, 0.5) }
    };
  };
  return {
    wrap(desc, kind = "game") {
      if (used >= maxPasses) { overflow++; return; }
      desc.timestampWrites = { querySet, beginningOfPassWriteIndex: used * 2, endOfPassWriteIndex: used * 2 + 1 };
      kinds[used] = kind;
      used++;
    },
    // Called once per present, after the last pass and before submit.
    present(enc) {
      if (!used) return;
      const slot = reads.find((r) => !r.busy);
      const n = used, k = kinds.slice(0, n);
      used = 0;
      if (!slot) { dropped++; return; }
      enc.resolveQuerySet(querySet, 0, n * 2, resolve, 0);
      enc.copyBufferToBuffer(resolve, 0, slot.buf, 0, n * 16);
      slot.busy = true;
      slot.pending = { n, k };
    },
    // Called after submit: map the slots filled this present.
    afterSubmit() {
      for (const slot of reads) {
        if (!slot.busy || !slot.pending || slot.mapping) continue;
        const { n, k } = slot.pending;
        slot.mapping = true;
        slot.buf.mapAsync(self.GPUMapMode.READ, 0, n * 16).then(() => {
          const t = new BigInt64Array(slot.buf.getMappedRange(0, n * 16));
          // Sum of the passes (overlapping passes of a tiler count twice:
          // an upper bound) and span from the first begin to the last end
          // (includes the GPU idling between submits: also an upper bound).
          let total = 0n, post = 0n, first = t[0], last = t[1];
          for (let i = 0; i < n; i++) {
            const d = t[i * 2 + 1] - t[i * 2];
            if (d > 0n) { total += d; if (k[i] === "post") post += d; }
            if (t[i * 2] < first) first = t[i * 2];
            if (t[i * 2 + 1] > last) last = t[i * 2 + 1];
          }
          slot.buf.unmap();
          frames.push({ totalMs: Number(total) / 1e6, postMs: Number(post) / 1e6, spanMs: Number(last - first) / 1e6, passes: n });
          if (frames.length > 20000) frames.splice(0, 10000);
        }).catch(() => { dropped++; }).finally(() => {
          slot.busy = false; slot.mapping = false; slot.pending = null;
        });
      }
    },
    reset() { frames.length = 0; overflow = 0; dropped = 0; },
    stats
  };
}
