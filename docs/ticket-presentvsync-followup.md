# presentvsync: follow-ups (review of #263, 2026-10-26)

`?presentvsync=1` stays off by default. Fixed in #263: one pool texture per
frame (src/wgpu-vsync-queue.js, kept across drains, never queued twice), the
theft guard, the device in the pool key, off with the detached presenter,
the display counter matched by rAF frame time, the stream captured at queue
time (v3). Left for later:

1. **Stream copy at full size.** At internal resolution 4× (patch 0168) the
   stream copies a 2560×1920 texture per frame. Render it to 640×480 (a blit
   pass from the pool texture) when the encoder does not need more.
2. **Done in #265.** The pool destroys its free textures at a key change
   (resize, format, device); the queued ones and the frame's current one may
   still be referenced by unsubmitted commands and are left to the GC.
3. **Done in #265.** The presenter's rAF loop stops after 120 BeginFrames
   with nothing to show and starts again with the next queued frame.
4. **Done in #265.** `wgpuVsyncInBeginFrame` is now `wgpuVsyncFrameTime`
   (the rAF frame time, not a flag).
5. **Done in #265.** In vsync mode the input marker, the visual cadence
   sample and the backbuffer readbacks read the frame's texture
   (`presentTexture`: `wgpuVsync.current`, kept across drains), never the
   drain-local `lastBackbufferTexture`.
6. **A present without a backbuffer pass** (scenario C) queues nothing and is
   not counted by `recordPresentedFrame`: the presentation FPS reads lower
   with presentvsync on than off for the same pictures. Compare p99 between
   presents and BeginFrames with 2+, never the presentation FPS.
7. **Done in #265.** The stream canvas and the display canvas's COPY_DST
   configuration follow the device; a lost device empties the queue (no
   50 ms timer for ever).
8. **Default switch criterion** (judge, 2026-10-26): p99 between presents and
   BeginFrames with 2+ pictures over ≥ 6 runs, with the fixed display counter;
   check beginFb0 == presents in the measurement.
9. **Done.** The fallback counter `byLateHidden` is `byNoBeginFrame` (no
   BeginFrame for 50 ms: a hidden tab or a visible stall), as
   `droppedNoBeginFrame` (#282).
