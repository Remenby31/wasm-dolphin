# Controllers: four ports, hot-plug, remote injection

The core emulates a GameCube controller on each of the four ports. Each port
is either **plugged in** or **unplugged**; an unplugged port answers "no
controller" to the game, exactly like an empty socket, so a game never sees a
phantom player. At boot only port 1 is plugged in.

## Public API

`EmulatorHost` (`src/core-host.js`) is the entry point for a page that embeds
the engine, for example a site forwarding remote players' inputs or, later,
netplay.

```js
host.setPad(port, state);         // port 0-3 = GameCube ports 1-4
host.connectPad(port, connected); // true plugs the port in, false unplugs it
```

- `setPad` plugs the port in if it was unplugged, then sets its state. It
  returns `false` for a port outside 0-3. A core built before multi-port
  support (no `SetPadState` export) ignores ports 2-4; port 1 still works.
- `connectPad(port, false)` unplugs the port and forgets its state; a pad
  plugged back in starts neutral.
- Both can be called before a game is loaded: the last request per port is
  applied as soon as the core is up. This holds for the worker adapter and for
  the main-thread one (`video=ogl&oglproxy=main`).
- Fields left out of `state` (or `undefined`) are neutral (sticks centred,
  nothing pressed). Byte fields are rounded and clamped to 0-255. A field that
  is not a finite number (`NaN`, `Infinity`, a string) throws a `TypeError`,
  and a `mask` outside 0..0xffffffff a `RangeError`; nothing is sent then.
- Repeating an unchanged state costs nothing (it is deduplicated per port).

`state` is the layout of `src/input.js`:

| Field | Range | Meaning |
|---|---|---|
| `mask` | bits of `BUTTONS` | A, B, X, Y, START, L, R, Z, D-pad; `STICK_*`/`C_STICK_*` bits are digital directions |
| `stickX`, `stickY` | 0-255, `0x80` centre, +y up | main stick |
| `cStickX`, `cStickY` | 0-255, `0x80` centre, +y up | C-stick |
| `triggerLeft`, `triggerRight` | 0-255 | analog L/R |
| `analogA`, `analogB` | 0-255 | analog A/B pressure |

A digital direction in `mask` moves a stick only while that stick's bytes are
at the centre, so it never overrides analog input. A genuine controller's
stick stops at its gate: use `stickToPadBytes(x, y, gateRadius, deadzone)`
from `src/input.js` to turn a host stick (−1..1, +y up) into bytes with the
same geometry Dolphin emulates (octagonal gate, ±101 main and ±92 C-stick at
the cardinals and diagonals, radial deadzone with the remaining travel
rescaled from the centre).

## The engine's own page (`index.html`)

- Every Gamepad API pad with the standard mapping gets a port, in connection
  order: the first on port 1, the second on port 2, and so on. A pad keeps its
  port while it stays connected; unplugging it unplugs that port, and the next
  pad plugged in takes the lowest free port. A device without the standard
  mapping only gets a port when no standard pad is present (it is often a
  phantom HID device).
- The keyboard (and the touch controls) drive port 1 together with the first
  pad. `?keyboardport=2` (1-4) moves them to another port; `?keyboardport=none`
  detaches them. At start the page plugs and unplugs ports to match its
  devices, so with the keyboard off port 1 and no pad, port 1 is empty.
- Sticks use a 0.18 radial deadzone (worn sticks drift up to ~0.45, but only
  the digital `STICK_*` directions used for menus use the larger 0.55
  threshold).

## Transport

The host writes each port into its own seqlock block of the input
`SharedArrayBuffer` (`src/input-transport.js`, one 16-slot block per port with
its own sequence, generation and `connected` flag) and also posts
`setInputState` with `port` and `connected`; the worker applies whichever
arrives first, per port, through the core's `SetPadState(port, connected, …)`.
Input latency telemetry follows port 1 only.

Cores with the direct pad block (`core/upstream/dolphin_web_direct_pad.h`,
`src/direct-pad.js`) also get every state straight in their shared memory:
the worker hands the block to the page once the core is up, the adapter
writes each published state there (seqlock), and the SI poll reads it at
once instead of the presentation loop's copy. `?directpad=0` keeps the block
report-only (A/B measurements).

## Streaming

For a site that streams the game to remote players (one host runs the core,
guests send their pads):

| Call | Effect |
| --- | --- |
| `host.setRemotePad(port, state, { inputSeq, rxTime })` | As `setPad`, plus the guest's packet sequence and its reception time (`performance.timeOrigin + performance.now()`), echoed once an SI poll read the state. |
| `host.tapPad(port, buttons)` | Buttons pressed since the last update, maybe already released (press counters of a lossy channel). The SI poll keeps them reported until a poll of a later 1/50 s window did; returns false on a core without the block (hold them yourself). |
| `host.padFeedback(port)` | `{ pollCount, appliedSeq, appliedRxTime, pollTime, edgePollTime, rumble, rumbleGeneration, reportedMask, presses[12] }`: what the last poll read, when, the game's rumble on that port (patch 0095, `Pad::Rumble`), and the press edges the game was given per button. |
| `host.captureVideoTrack()` | A video `MediaStreamTrack` fed by the emulation worker, one `VideoFrame` per presented frame (software: RGBA copy; wgpu: the presented canvas), without the page's main thread in between. Null without `MediaStreamTrackGenerator`. |
| `await host.streamCaptureStats()` | Frames, drops (consumer behind), errors, worker ms per frame. |

All times share the epoch clock the core's threads use (`emscripten_get_now()`
is `performance.timeOrigin + performance.now()` in every thread).
