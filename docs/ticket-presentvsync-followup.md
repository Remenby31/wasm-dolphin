# presentvsync: follow-ups (review of #263, 2026-10-26)

`?presentvsync=1` stays off by default. Fixed in #263: one pool texture per
frame (src/wgpu-vsync-queue.js, kept across drains, never queued twice), the
theft guard, the device in the pool key, off with the detached presenter,
the display counter matched by rAF frame time, the stream captured at queue
time (v3). Left for later:

1. **Stream copy at full size.** At internal resolution 4× (patch 0168) the
   stream copies a 2560×1920 texture per frame. Render it to 640×480 (a blit
   pass from the pool texture) when the encoder does not need more.
2. **destroy() the pool's textures** when the pool is dropped (resize, new
   device) and when the presenter detaches; today they wait for the GC.
3. **Stop the presenter's rAF loop** when nothing has been queued for a while
   (it runs every BeginFrame once started, even paused).
4. **Rename `wgpuVsyncInBeginFrame` to `wgpuVsyncFrameTime`**: it now holds
   the rAF frame time, not a flag.
5. **Default switch criterion** (judge, 2026-10-26): p99 between presents and
   BeginFrames with 2+ pictures over ≥ 6 runs, with the fixed display counter;
   check beginFb0 == presents in the measurement.
