// Copyright 2026 Dolphin Emulator Project (wasm-dolphin fork)
// SPDX-License-Identifier: GPL-2.0-or-later

// Streaming capture inside the emulation worker. The page creates a
// MediaStreamTrackGenerator and hands its `writable` to the worker
// (EmulatorHost.captureVideoTrack); every presented frame then becomes a
// VideoFrame written here, without a round trip through the page's main
// thread (canvas.captureStream() is fed by the placeholder canvas, which is
// updated by a main-thread task: research/deep-stream-video.md §0.3-1).
//
// - Software frames (RGBA bytes in the core's memory): one CPU copy into the
//   VideoFrame (option C), no GPU wait; RGB → NV12 happens in the encoder.
// - Hardware (wgpu) frames: a VideoFrame from the presented canvas
//   (option B), which waits for the submitted GPU work.
// The writer never queues: when the track's consumer has not taken the last
// frame, the new one is dropped (the next one is fresher anyway).
//
// The stream keeps its own size: at internal resolution N (patch 0168) the
// canvas is 640N x 480N and changes size with every switch. A larger canvas
// is first drawn into a STREAM_HEIGHT-line canvas (a GPU blit with
// filtering), its width following the picture's aspect: 640x480 in 4:3,
// 854x480 in 16:9 (patch 0178), whatever the scale; never wider than
// STREAM_MAX_WIDTH.

export const STREAM_WIDTH = 640;
export const STREAM_HEIGHT = 480;
export const STREAM_MAX_WIDTH = 854;
const MAX_SIZES = 8;

export class StreamCapture {
  // VideoFrameImpl: injectable for tests (node has no VideoFrame).
  constructor({
    now = () => performance.now(),
    VideoFrameImpl = globalThis.VideoFrame,
    createCanvas = (w, h) => new OffscreenCanvas(w, h),
    streamWidth = STREAM_MAX_WIDTH,
    streamHeight = STREAM_HEIGHT
  } = {}) {
    this.now = now;
    this.VideoFrameImpl = VideoFrameImpl;
    this.createCanvas = createCanvas;
    this.streamWidth = streamWidth;
    this.streamHeight = streamHeight;
    this.scaler = null;
    this.writer = null;
    this.stats = StreamCapture.emptyStats();
  }

  static emptyStats() {
    return {
      attached: false,
      frames: 0,
      dropped: 0,
      errors: 0,
      source: null,
      width: 0,
      height: 0,
      // Worker time spent building VideoFrames (copy or GPU snapshot), ms.
      captureMsTotal: 0,
      captureMsMax: 0,
      lastCaptureAt: 0,
      lastCoreFrame: 0,
      // The size really sent, over the whole capture (width/height are the
      // last frame's only), and the widest canvas offered before scaling.
      // sizes: frames per "source:WxH", at most MAX_SIZES keys (others go
      // to "other"): a stray size (a 320x240 canvas at 4x, ticket 0168
      // point 5) shows with its count and its last core frame.
      minWidth: 0,
      maxWidth: 0,
      minHeight: 0,
      maxHeight: 0,
      inputMaxWidth: 0,
      sizes: {}
    };
  }

  attach(writable) {
    this.detach();
    this.writer = writable.getWriter();
    this.stats = { ...StreamCapture.emptyStats(), attached: true };
    this.writer.closed.catch(() => {}).finally(() => {
      if (this.writer && this.stats.attached) this.stats.attached = false;
    });
  }

  detach() {
    const writer = this.writer;
    this.writer = null;
    this.stats.attached = false;
    writer?.close().catch(() => {});
  }

  get active() {
    return this.writer !== null && this.stats.attached;
  }

  // Nobody is reading: skip the copy entirely.
  ready() {
    if (!this.active) return false;
    const desired = this.writer.desiredSize;
    if (desired !== null && desired <= 0) {
      this.stats.dropped += 1;
      return false;
    }
    return true;
  }

  // RGBA bytes (alpha ignored), copied into the frame.
  offerBytes(bytes, width, height, coreFrame) {
    if (!bytes || width <= 0 || height <= 0 || bytes.byteLength < width * height * 4 || !this.ready()) return;
    const startedAt = this.now();
    let frame;
    try {
      frame = new this.VideoFrameImpl(bytes, {
        format: "RGBX",
        codedWidth: width,
        codedHeight: height,
        timestamp: Math.round(startedAt * 1000)
      });
    } catch {
      this.stats.errors += 1;
      return;
    }
    this.stats.inputMaxWidth = Math.max(this.stats.inputMaxWidth, width);
    this.push(frame, "bytes", width, height, coreFrame, startedAt);
  }

  // A canvas just presented (WebGPU or WebGL backbuffer), brought down to
  // the stream's size first when it is larger.
  offerCanvas(canvas, coreFrame) {
    if (!canvas || !this.ready()) return;
    const startedAt = this.now();
    let frame, source;
    try {
      source = this.streamSource(canvas);
      frame = new this.VideoFrameImpl(source, { timestamp: Math.round(startedAt * 1000), alpha: "discard" });
    } catch {
      this.stats.errors += 1;
      return;
    }
    this.stats.inputMaxWidth = Math.max(this.stats.inputMaxWidth, canvas.width);
    this.push(frame, "canvas", source.width, source.height, coreFrame, startedAt);
  }

  streamSource(canvas) {
    const scale = Math.min(1, this.streamHeight / canvas.height, this.streamWidth / canvas.width);
    if (!(scale < 1)) return canvas;
    // Even sizes: the encoders want them (854x480 for 16:9).
    const width = Math.max(2, Math.round(canvas.width * scale / 2) * 2);
    const height = Math.max(2, Math.round(canvas.height * scale / 2) * 2);
    if (!this.scaler || this.scaler.canvas.width !== width || this.scaler.canvas.height !== height) {
      const scaled = this.createCanvas(width, height);
      const ctx = scaled.getContext("2d", { alpha: false });
      ctx.imageSmoothingQuality = "high";
      this.scaler = { canvas: scaled, ctx };
    }
    this.scaler.ctx.drawImage(canvas, 0, 0, width, height);
    return this.scaler.canvas;
  }

  push(frame, source, width, height, coreFrame, startedAt) {
    const ms = this.now() - startedAt;
    const s = this.stats;
    s.frames += 1;
    s.source = source;
    s.width = width;
    s.height = height;
    s.captureMsTotal += ms;
    s.captureMsMax = Math.max(s.captureMsMax, ms);
    s.lastCaptureAt = startedAt;
    s.lastCoreFrame = coreFrame;
    s.minWidth = s.minWidth ? Math.min(s.minWidth, width) : width;
    s.maxWidth = Math.max(s.maxWidth, width);
    s.minHeight = s.minHeight ? Math.min(s.minHeight, height) : height;
    s.maxHeight = Math.max(s.maxHeight, height);
    // The size's entry, looked up again only when the size or source
    // changes (no string per frame).
    const last = this.lastSize;
    let size = last && last.sizes === s.sizes && last.source === source && last.width === width && last.height === height ? last.entry : null;
    if (!size) {
      let key = `${source}:${width}x${height}`;
      if (!(key in s.sizes) && Object.keys(s.sizes).length >= MAX_SIZES) key = "other";
      size = (s.sizes[key] ??= { frames: 0, lastCoreFrame: 0, lastAt: 0 });
      this.lastSize = { sizes: s.sizes, source, width, height, entry: size };
    }
    size.frames += 1;
    size.lastCoreFrame = coreFrame;
    size.lastAt = startedAt;
    // write() takes ownership: the track closes the frame once consumed.
    const writer = this.writer;
    writer.write(frame).catch(() => {
      // The track is gone (stopped, page closed): stop capturing.
      s.errors += 1;
      try {
        frame.close();
      } catch {
        // already closed by the sink
      }
      if (this.writer === writer) this.detach();
    });
  }
}
