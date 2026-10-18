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
  applied as soon as the worker is up.
- Fields left out of `state` are neutral (sticks centred, nothing pressed).
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
  detaches them.
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
