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
// canvas is 640N x 480N and changes size with every switch. A wider canvas is
// first drawn into a STREAM_WIDTH-wide canvas (a GPU blit with filtering),
// so the encoder always gets 640x480, whatever the scale.

export const STREAM_WIDTH = 640;

export class StreamCapture {
  // VideoFrameImpl: injectable for tests (node has no VideoFrame).
  constructor({
    now = () => performance.now(),
    VideoFrameImpl = globalThis.VideoFrame,
    createCanvas = (w, h) => new OffscreenCanvas(w, h),
    streamWidth = STREAM_WIDTH
  } = {}) {
    this.now = now;
    this.VideoFrameImpl = VideoFrameImpl;
    this.createCanvas = createCanvas;
    this.streamWidth = streamWidth;
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
      lastCoreFrame: 0
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
    this.push(frame, "bytes", width, height, coreFrame, startedAt);
  }

  // A canvas just presented (WebGPU or WebGL backbuffer), brought down to
  // the stream's width first when it is wider.
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
    this.push(frame, "canvas", source.width, source.height, coreFrame, startedAt);
  }

  streamSource(canvas) {
    if (!(canvas.width > this.streamWidth)) return canvas;
    const width = this.streamWidth;
    const height = Math.round(canvas.height * width / canvas.width);
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
