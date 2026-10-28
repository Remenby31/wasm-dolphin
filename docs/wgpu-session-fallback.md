# Keeping the session when WebGPU fails

Design note (2026-10-28). When the WebGPU device is lost while a game runs,
or the hardware renderer fails after the boot, the player should keep
playing on a fallback renderer instead of losing the game. This note says
what happens today, from the code, which recovery paths exist, what they
cost, and which one to take. The opt-in switch `?wgpurecover=1` implements
the engine's part of the recommended path.

## What happens today

### Who sees the loss

The engine runs in three kinds of threads:

- the **disc-I/O worker** (`src/upstream-discio-worker.js`): the
  Emscripten module's own thread. It owns the `GPUDevice`, the presenter's
  canvas context and the consumer of the WebGPU command ring: it replays
  the ring's records as real WebGPU calls;
- the **CPU thread** and the **GPU-FIFO (video) thread**: wasm pthreads.
  Dolphin's WebGPU backend (patch 0006 and its follow-ups, under
  `patches/dolphin-wasm/snapshot/*webgpu*`) never touches a device. It
  writes records (create shader, create texture, draw, upload, copy to
  staging...) into a ring in the shared heap; every object is an id the
  backend allocated (`m_next_id++`), mapped to a real object by the worker
  (`webGpuObjects`);
- the page (`src/core-host.js`, the site above it).

`device.lost` resolves in the **disc-I/O worker**. Its handler
(`createWebGpuPresenter`, then `handleWgpuDeviceLoss` in
`src/wgpu-device-lifecycle.js`):

1. records a `device-lost` renderer error;
2. `markWgpuReplayFatal("device-lost")`: releases every pending readback
   (`src/wgpu-readback.js` wakes the waiters with "lost"), then publishes
   the consumer state **FAILED** in the ring header (protocol v3,
   `consumer_state = 2`, `wgpuRendererRuntime.emergencyFail`);
3. cancels the replay pump, clears the replay state and the mapped staging
   pool, re-arms the producer's geometry epoch, drops `renderGpu`, sets the
   backend to `webgpu-lost`;
4. above 1x, holds the worker's scale to 1x, then posts
   `wgpu-device-lost { internalResolution, reason, detail }`.

The host (`handleGpuDeviceLost`) caps its scale to 1x when the loss was
above 1x and calls `onGpuDeviceLost({ internalResolution, fallback, reason,
detail })`. The site (Salon, `Play.tsx`) then flushes the memory cards and
restarts the engine one scale lower (3x then 2x then 1x); lost at 1x, it
shows a crash screen. A restart is a new boot: the player is back at the
title screen, and whatever was not saved in game is gone.

### What survives

Everything but the picture. The FAILED state is terminal for the ring: the
producer's `WaitForRingSpace` returns false, `Push` poisons the open pass
and drops every later record; staging readbacks (EFB peeks, EFB copies to
RAM, patch 0093) return at once with the texels they already had. Nothing
blocks on the GPU any more, so:

- the worker, the wasm heap (guest RAM, ARAM), the CPU and video threads,
  the memory cards in the worker's file system and the sound all survive;
- **the game keeps running, blind**: the core goes on emulating and playing
  sound while the canvas shows the last picture (checked below);
- **a save state can still be taken** (checked below). The CPU, memory and
  hardware state in it are exact. Its video part is not: the EFB and the
  EFB copies kept in the texture cache are serialized through readbacks
  that no longer run, so they hold stale texels (the last completed
  readback, or zeros). When the state is loaded, Dolphin's
  `TextureCacheBase::DoState` invalidates the texture cache (textures are
  decoded from RAM again) and draws the saved EFB back: at worst a frame of
  wrong EFB, and wrong render-to-texture effects until the game redraws
  them (most games redraw them every frame).

### The other failures after the boot

Device loss is the only failure the page hears about. Every other fatal
replay error goes through the same `markWgpuReplayFatal` (scopes
`submit-error`, `staging-seal`, `staging-capacity`, `staging-copy`,
`staging-remap`, `webgpu-command-ring-ownership`,
`webgpu-command-ring-attach`): the ring is FAILED in the same way, the
device stays alive, and **no message reaches the page**. The game goes on
blind and the canvas freezes. The only boot-time compatibility check that
can change later, the scale ceiling (`wgpu-scale-ceiling`), clamps the
scale and never fails. The recovery below applies to these errors as well,
once the worker tells the page about them (follow-up 1).

## Path (a): a new device, resumed in place

Ask the adapter for a new device, rebuild the worker's objects on it, and
let the ring flow again, in the same worker and the same core.

What it needs:

1. **No gap in the record stream.** Once the ring is FAILED, every record
   the producer pushes is dropped: a texture, shader or pipeline created
   after the loss has an id in Dolphin and none in the worker, for good.
   Clearing the header word from JavaScript does not bring those records
   back. The loss would instead have to park the consumer (the producer
   then waits on a full ring) instead of failing it. Readbacks would time
   out (500 ms each, patch 0093) in the meantime. `device.lost` is also
   asynchronous: the records replayed between the real loss and the
   handler ran on a dead device, silently.
2. **Every object rebuilt on the new device.** Shaders: possible, the
   backend keeps every WGSL blob in the heap for good
   (`PushCreateShader`). Pipelines and samplers: their descriptors are kept
   (`pipeTpl`, `samplerDescriptors`). Buffers and textures: their sizes,
   formats and usages, but not their contents. Bind groups refer to dead
   objects and must be rebuilt as well. Then about ten JavaScript caches
   built on the device (mapped staging pool, sparse UBO, UBO compute
   reconstruction, pass state cache, semantic runtime, pipeline prewarm,
   visual cadence, readback pool) and the presenter's canvas context. The
   semantic runtime already says that "device loss does not clear all
   browser WebGPU resource maps". It is a device-ownership rewrite of a
   17,000-line worker.
3. **Contents.** GPU memory is gone: EFB, EFB copies, every texture.
   Dolphin's texture cache still believes its textures are valid and keeps
   reusing an entry while the RAM behind it does not change: static
   textures (menus, tracks, fonts) would stay blank. No core export
   invalidates the cache. `TextureCacheBase::OnConfigChanged` only does it
   for settings the page does not expose (texture format overlay, GPU
   texture decoding, arbitrary mipmap detection...); a change of internal
   resolution recreates the EFB but not the cache. The one thing that
   invalidates it today is **loading a save state**. EFB copies cannot be
   recovered at all: their only copy was on the lost GPU.

So a JavaScript-only path (a) still needs a save state for the textures,
which makes it path (b) inside the same worker, at the price of rebuilding
every WebGPU object. A clean path (a) needs a core patch: an export that
re-pushes the backend's own objects (vertex and uniform stream buffers,
utility pipelines, EFB) and calls `TextureCacheBase::Invalidate`,
`ShaderCache::Reload` and `FramebufferManager::RecreateEFBFramebuffer`, plus
the worker's device swap. Its only gain over (b) is the time of a new boot.

## Path (b): save state, new boot, load

1. On the loss, pause the core in the worker's `device.lost` handler,
   before the page hears of it (the game must not run blind), then take a
   save state in memory (`exportSaveState({ slot: 0 })`, which the worker
   already offers).
2. Restart the engine as today, one scale lower; lost at 1x, on a new
   WebGPU device at 1x or on the software renderer.
3. Load the state (`importSaveState` / the site's `loadState(bytes)`).

Everything it uses exists and works in JavaScript, without a core change.

| | |
| --- | --- |
| Cost | a pause, a save (0.8 to 1.0 s, 28 to 35 MB at 1x-2x, docs/internal-resolution.md), a new boot, a load (about 1.2 s). The page holds the state in memory across the restart. |
| Kept | the game where it was, to the frame of the pause; memory cards (flushed by the pause). |
| Lost | the frames between the loss and the worker's `device.lost` handler; EFB and EFB copies are stale for the first frame(s) after the load (see above). |
| Risks | a state belongs to one core build: the restart must boot the same engine (the site restarts from the same URL, so it does). A state taken on the WebGPU renderer loads on the software one (checked below), its speed on heavy 3D scenes was not checked here: a fallback to keep the session, not a promise of full speed. |

What the page sees, with `?wgpurecover=1`:

1. The worker pauses the core in its `device.lost` handler (Dolphin's
   pause, waited for 3 s at most), then posts `wgpu-device-lost` with
   `pause: { state, changed }` or `pause: { error }`.
2. At once, `onStatus("WebGPU device lost: keeping the session ...")` and
   **`onGpuRecovering({ internalResolution, fallback, reason })`**, a new
   host callback: the page can show "the graphics card stopped, resuming"
   while the state is taken. The page should not restart before step 3.
3. `onGpuDeviceLost` once the state is taken (without the switch it comes
   as soon as the worker's message arrives), with five more fields:

| Field | |
| --- | --- |
| `paused` | the core is paused where the device went |
| `pauseChanged` | the recovery paused it; `false`: the player had already paused the game, keep it paused after the restart |
| `state` | `ArrayBuffer` of the save state, or `null` |
| `stateGameId` | the disc ID in the state's header |
| `stateError` | why the pause or the save failed ("" when both worked) |

`onGpuDeviceLost` always comes, whatever fails on the way (it is called
from a `finally`). A worker that never answers cannot hold the restart: the
host's pause (only for a worker that did not pause itself) gives up after
5 s and then skips the save, since the worker is not answering; a pause
the core refused still saves. The save gives up after 20 s. At most 25 s
pass between `onGpuRecovering` and `onGpuDeviceLost`, with
`state: null` and the reason when they time out. Without the switch nothing
changes: `onGpuDeviceLost` comes as soon as the worker's message arrives,
as before, and `onGpuRecovering` is never called.

The site's part (Salon, not in this repository): in the `gpulost` handler,
keep `state` (the engine host must pass it through its `emit`, and pass
`onGpuRecovering` on as an event to show), restart as today, then
`loadState(bytes)` once the disc is mounted and the core runs; pause again
when `pauseChanged` is false.
Lost at 1x: restart once on WebGPU at 1x (a GPU process reset is usually
transient), then on the software renderer (`setRenderer({ video:
"software" })`, which the site already does for discs that need the
bounding box), with a presenter that does not need WebGPU either.

## Recommendation

Path (b), behind `?wgpurecover=1` until the site uses it. It keeps the game
for the cost of a restart the site already does, it needs no core change,
and the same flow fits the replay errors that do not lose the device.
Path (a) is not worth its cost now: without a core patch it is (b) plus a
rewrite of the worker's device ownership, and even with one it only saves
the time of a boot.

Follow-ups:

1. Post a message for the other fatal replay errors (`markWgpuReplayFatal`
   scopes other than `device-lost`), so the page can recover from them the
   same way.
2. Site: pass `state` through `salon-host.js`, load it after the restart,
   the WebGPU-then-software order at 1x, a limit of restarts per session.
3. If boot time matters: the core export of path (a).

## Measurements

`harness/probes/wgpu-recover-check.mjs` (correctness only, no perf lock),
2026-10-28 00:30, M4 Pro, Chrome headless, mains power, load average about
48, one run. Local commercial disc, race save state, accelerator held,
`video=wgpu` at 2x; the device is lost with the harness hook
(`validationLoseWebGpuDevice`, `device.destroy()`).

| Check | Result |
| --- | --- |
| Without the switch, after the loss | the core ran 99 frames in 3 s: the game goes on, blind |
| Save state after the loss, without a pause | 25.6 MB in 0.4 s |
| With `?wgpurecover=1`, the host pausing (first version) | `onGpuDeviceLost` 0.45 s after the loss, `paused: true`, 25.5 MB state, no error; 0 frames in the next 2 s. The game ran blind until the host's pause |
| With `?wgpurecover=1`, the worker pausing (00:39, load about 8) | `onGpuRecovering` 2 ms after the loss, `onGpuDeviceLost` 0.46 s after, `paused: true`, `pauseChanged: true`, 25.5 MB state; 0 frames from the loss to the event and in the next 2 s; resumed on WebGPU at 1x (97 frames in 3 s, no renderer error) |
| That state, new boot on WebGPU at 1x | loaded, 91 frames in 3 s, no renderer error, the race goes on from the state (picture checked by eye) |
| That state, new boot on the software renderer | loaded, 180 frames in 3 s, no renderer error, the race goes on (checked by eye) |

The times are wall clock on a loaded machine, not measurements. The
captures stay outside the repository.

```
node harness/probes/wgpu-recover-check.mjs --iso <disc> --port 8198 \
  --state <race.sav> --hold KeyX --ir 2 --control --out <dir outside the repo>
```
