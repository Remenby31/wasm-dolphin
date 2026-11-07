// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
// The autopilot's eyes (pad-film-worker.js, control word STEER + port): a
// track-edge follower from the shown picture, nothing known of any game.
// A few times a second the page draws the canvas small, takes the colour of
// the ground just ahead of the player's view centre as "the road", finds on
// a few rows how far that colour goes left and right of the centre, and
// steers towards the middle of what it found (away from the side where the
// road ends first). A frame whose reference patch is not one colour (a wall
// in front, a menu) gives no steering: the worker's sine drives then, and
// the stuck signal still backs off.
// A port's view: the part of the picture it drives in, as fractions
// [x0, y0, x1, y1] (a split screen gives each player its half); the film's
// auto step carries it (auto.view), the whole picture by default.

// Fractions of the view: refRow the reference patch's row (just over the
// player's vehicle, centred), rows the rows scanned, body the player's own
// vehicle (left, right: skipped by the scan), scan the columns scanned (a
// HUD at the sides left out).
export const EDGE_DEFAULTS = Object.freeze({ refRow: 0.4, rows: [0.47, 0.55, 0.65], body: [0.38, 0.64], scan: [0.15, 0.8], refHalf: 0.05, tol: 60, gain: 1.6, everyMs: 100, learnTicks: 10, sampleW: 128, sampleH: 96 });

// Pure: RGBA pixels (w x h) -> { x: stick byte or null, error, rows }.
export function steerFromPixels(data, w, h, view = [0, 0, 1, 1], o = EDGE_DEFAULTS) {
  const vx0 = Math.round(view[0] * w), vy0 = Math.round(view[1] * h), vx1 = Math.round(view[2] * w), vy1 = Math.round(view[3] * h);
  const vw = vx1 - vx0, vh = vy1 - vy0;
  if (vw < 8 || vh < 8) return { x: null, why: "view too small" };
  const at = (x, y) => { const i = (y * w + x) * 4; return [data[i], data[i + 1], data[i + 2]]; };
  const cx = vx0 + Math.floor(vw / 2);
  // the reference: the patch ahead of the centre, one colour or nothing
  const ry = vy0 + Math.floor(o.refRow * vh), half = Math.max(1, Math.floor(o.refHalf * vw));
  const patch = [];
  for (let x = cx - half; x <= cx + half; x += 1) patch.push(at(x, ry));
  const seen = [0, 1, 2].map((c) => patch.map((p) => p[c]).sort((a, b) => a - b)[patch.length >> 1]);
  // o.ref: the road's colour learnt when the drive started (on the grid, the
  // road is ahead); without it the patch ahead is taken as the road
  const ref = o.ref ?? seen;
  const dist = (p) => Math.abs(p[0] - ref[0]) + Math.abs(p[1] - ref[1]) + Math.abs(p[2] - ref[2]);
  const rows = [];
  const fx = (f) => vx0 + Math.floor(f * vw);
  const [sx0, sx1] = [fx(o.scan[0]), fx(o.scan[1])], [b0, b1] = [fx(o.body[0]), fx(o.body[1])];
  for (const f of o.rows) {
    const y = vy0 + Math.floor(f * vh);
    // runs of road pixels on the row (the vehicle's columns bridge a run
    // that goes under it), one stray pixel tolerated; the widest is the road
    const runs = [];
    let start = null, miss = 0, last = null;
    for (let x = sx0; x < sx1; x += 1) {
      const road = (x >= b0 && x < b1) ? start != null : dist(at(x, y)) <= o.tol;
      if (road) { if (start == null) start = x; last = x; miss = 0; }
      else if (start != null && ++miss >= 2) { runs.push([start, last]); start = null; miss = 0; }
    }
    if (start != null) runs.push([start, last]);
    const real = runs.filter(([l, r]) => !(l >= b0 && r < b1));
    if (!real.length) continue;
    const [l, r] = real.sort((p, q) => (q[1] - q[0]) - (p[1] - p[0]))[0];
    rows.push({ y, left: l, right: r, mid: (l + r) / 2 });
  }
  if (!rows.length) return { x: null, why: "no road colour in sight", seen };
  const error = rows.reduce((s, r) => s + (r.mid - cx) / (vw / 2), 0) / rows.length;
  const x = Math.max(0, Math.min(255, Math.round(128 + Math.max(-1, Math.min(1, o.gain * error)) * 127)));
  return { x, error: Math.round(error * 1000) / 1000, rows, seen };
}

// In the page: the canvas drawn small o.everyMs, the steering written to the
// pad film's control words for each port of `views` ({ port: view }). The
// capture stream runs only while this does (the autopilot's own cost):
// stop() ends it.
export async function startEdgeFollower(page, views, options = {}) {
  const o = { ...EDGE_DEFAULTS, ...options };
  return page.evaluate(async ([src, viewsIn, opt, STEER]) => {
    const steer = new Function(`return (${src})`)();
    const d = window.__padFilm;
    if (!d) return { error: "no pad film" };
    const canvas = document.getElementById("screen");
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = canvas.captureStream(30);
    await Promise.race([video.play(), new Promise((r) => setTimeout(r, 3000))]);
    const c = new OffscreenCanvas(opt.sampleW, opt.sampleH);
    const g = c.getContext("2d", { willReadFrequently: true });
    const stats = { ticks: 0, steered: 0, last: {}, ref: {} };
    const learnt = {};
    const timer = setInterval(() => {
      if (!video.videoWidth) return;
      g.drawImage(video, 0, 0, opt.sampleW, opt.sampleH);
      const px = g.getImageData(0, 0, opt.sampleW, opt.sampleH).data;
      stats.ticks += 1;
      for (const [port, view] of Object.entries(viewsIn)) {
        // the first LEARN_TICKS ticks learn the road's colour (median of what
        // was ahead), then it stays
        const l = (learnt[port] ??= []);
        const s = steer(px, opt.sampleW, opt.sampleH, view, l.length >= opt.learnTicks ? { ...opt, ref: stats.ref[port] } : opt);
        if (l.length < opt.learnTicks && s.seen) {
          l.push(s.seen);
          if (l.length === opt.learnTicks) stats.ref[port] = [0, 1, 2].map((c) => l.map((p) => p[c]).sort((a, b) => a - b)[l.length >> 1]);
        }
        Atomics.store(d.control, STEER + Number(port), s.x == null ? 0 : s.x + 1);
        if (s.x != null) stats.steered += 1;
        stats.last[port] = s.x;
      }
    }, opt.everyMs);
    window.__edgeFollower = {
      stats,
      stop() { clearInterval(timer); for (const p of Object.keys(viewsIn)) Atomics.store(d.control, STEER + Number(p), 0); video.srcObject?.getTracks().forEach((t) => t.stop()); return stats; }
    };
    return { started: true };
  }, [steerFromPixels.toString(), views, o, 16]);
}

export const edgeFollowerStats = (page) => page.evaluate(() => window.__edgeFollower?.stats ?? null).catch(() => null);
export const stopEdgeFollower = (page) => page.evaluate(() => window.__edgeFollower?.stop() ?? null).catch(() => null);
