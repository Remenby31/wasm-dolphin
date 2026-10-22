# video=wgpu: real EFB readback (peeks, EFB/XFB copies to RAM)

Status: design, 2026-10-22. Nothing here is implemented yet.

## What is wrong today

Every GPU→CPU read of the hardware renderer returns zeros:

- `WebGPUStagingTexture` (patch 0006) is a stub. `CopyFromTexture` only sets
  `m_needs_flush`, `Map` succeeds on a zero-filled host buffer.
- Through it, `FramebufferManager::PeekEFBColor/PeekEFBDepth` (CPU reads of
  the EFB at `0x08000000`) read 0, and every EFB or XFB copy to RAM writes
  zeros into guest memory.
- `WebGPUEFBInterface::Peek*Internal` also return 0, but the backend installs
  VideoCommon's `HardwareEFBInterface` (patch 0006, `InitializeShared`), so the
  path that matters is the staging texture.

Two things hide the bug:

1. **The core ships no rendering GameINI key.** Since patch 0097 it embeds
   only the allowlisted keys of `Data/Sys/GameSettings`
   (`tools/gamesettings-allowlist.json`: `[Core] MMU`), so for the video
   settings Dolphin's defaults apply to every disc:
   `EFBAccessEnable=false` (peeks are skipped and read 0 on any backend),
   `EFBToTextureEnable=true` and `XFBToTextureEnable=true` (copies stay on the
   GPU). Upstream turns EFB access on for 13 GameCube IDs (`GMS`, `GZL`,
   `GKH`, `GIZ`, ...) and EFB copies to RAM for many more.
2. Since the wgpu XFB skip (branch perf/wgpu-cpu-relief), video=wgpu no longer copies the XFB to RAM at
   all, like OGL and Dolphin's default.

So the fix is two independent pieces: a real staging texture, and the
per-game settings that turn the reads on.

## What Dolphin already does for us

VideoCommon is unchanged and already implements the latency hiding:

- The EFB peek cache is tiled (`EFBAccessTileSize`, 64 px by default; 0
  means one 640×528 tile). A tile is read back once, then every peek in it
  is served from the staging texture.
- `RefreshPeekCache` (`FramebufferManager.cpp`) runs on `PE_DRAWDONE`,
  `PE_TOKEN(_INT)` (`BPStructs.cpp`) and at the dual-core FIFO tail
  (`Fifo.cpp`, our patches 0033/0034 keep it). It re-reads, **ahead of the
  peek**, every tile the game peeked in the last 8 frames
  (`frame_access_mask`), and calls `g_gfx->Flush()`.
- `InvalidatePeekCache` drops tiles once the EFB changes, unless
  `EFBAccessDeferInvalidation` (upstream: Galaxy only).

A peek is a `PushBlockingEvent` from the CPU thread to the video thread. With
a synchronous readback every first peek of a tile costs a full GPU round trip
(1–3 frames through `mapAsync` in Chrome, research/deep-webgpu-perf.md 1.5).
With `RefreshPeekCache` the copy is issued at DrawDone, so by the time the
CPU peeks, the data is usually back. The staging texture only has to make
"copy now, wait later" real.

## Design

### Producer (video thread, C++, patch 0092+)

`WebGPUStagingTexture` for `StagingTextureType::Readback`:

- Owns a slot id and a host buffer in the wasm heap (`m_buffer`, unchanged,
  `m_map_stride` = tight rows).
- `CopyFromTexture(src, rect, layer, level, dst_rect)` records a new opcode
  `COPY_TEXTURE_TO_STAGING {slot, texture id, layer, level, rect, dst offset,
  heap ptr, stride, seq}` and remembers `m_pending_seq = ++seq`. No wait.
- `Flush()`: if `m_pending_seq` is not complete, submit the command stream
  (`g_gfx->Flush()` semantics: the ring is published to the worker), then wait
  on the slot's completion word with `emscripten_futex_wait` until it reaches
  `m_pending_seq`. Bounded wait (500 ms): on timeout, log once, count it, and
  keep the previous contents (no deadlock if the device is lost or the worker
  is reloading).
- `Map()` stays trivial (the buffer is always mapped on the host side).
- Upload staging (`StagingTextureType::Upload`/`Mutable`) is out of scope.

Report `bSupportsDepthReadback` only for `depth32float` EFB (WebGPU forbids
copying from `depth24plus`); keep the existing colour-pass fallback otherwise.

### Consumer (discio worker, `src/wgpu-readback.js`)

- On `COPY_TEXTURE_TO_STAGING`: inside the current command encoder,
  `copyTextureToBuffer` into a pooled `MAP_READ|COPY_DST` buffer
  (`bytesPerRow` rounded to 256), then at the next submit boundary
  `mapAsync(READ)`.
- On resolve: pack rows into the tight host layout at `heap ptr`
  (`packReadbackRows`, already used by the harness capture), then
  `Atomics.store(seqWord, seq)` + `Atomics.notify`. Unmap, return the buffer
  to the pool.
- Completions are applied in `seq` order per slot; a stale one (renderer
  generation changed: device lost, core reload, savestate load) is dropped
  and its waiter woken with the generation bump, never with old pixels.
- Never wait inside the worker: the video thread is the only side that
  blocks.

### Turning it on: per-game settings

Ship the upstream `GameSettings` lines that matter to the renderer, for
GameCube IDs only, as data in the core's virtual FS (or a small table the
core applies to the game layer). Same values as Dolphin desktop: if a game
needs `EFBAccessEnable` or a copy to RAM there, it gets it here. Until then a
query flag forces it for testing (`?efbaccess=1`).

## Tests, before the code

1. **Unit, worker** (`tests/wgpu-readback.test.mjs`, fake device): row
   packing with 256-byte padding and odd widths; `seq` ordering when two
   copies of one slot resolve out of order; stale generation dropped and
   waiter woken; pool reuse; `mapAsync` rejection counted and waiter woken.
2. **Differential homebrew** (`harness/homebrew/efbpeek`): draws known
   colours and depths in a 640×480 frame, peeks a grid of points with
   `GX_PeekARGB`/`GX_PeekZ` after `GX_DrawDone`, then once without
   `GX_DrawDone` (the prefetch path), and draws the values it read as a row
   of squares. Software renderer = expected picture. Today video=wgpu shows
   black squares; the gate compares the two exactly (cpu=single).
3. **Latency** (harness probe): peeks per second and video-thread wait time
   per peek, with and without the prefetch, on the homebrew; no regression of
   the race (which never peeks) by `race-perf`.

## Risks

- A game peeking many tiles per frame with `EFBAccessDeferInvalidation=false`
  re-reads each tile every frame: 1–3 frames of latency per first peek after
  every invalidation. That is Dolphin's behaviour on every backend; the INI
  list stays upstream's.
- `Atomics.wait`-style blocking on the video thread while the worker owns the
  device is the same pattern as the existing upload arena; the bounded wait
  keeps a lost device from freezing the emulation.
