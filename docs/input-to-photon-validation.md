# External input-to-photon validation

`inputphoton=1` enables an opt-in optical marker intended for an external
photodiode, oscilloscope, or high-speed camera. It does not make the browser
capable of timestamping a physical photon.

The dirty-run browser-boundary evidence (input markers and GPU completion)
validates the telemetry path but does not replace external-sensor
input-to-photon qualification.

The optical marker has three deliberate properties:

- Before the first exact core-polled input generation, a large centered ROI is
  solid black. This is the persistent optical baseline.
- Every exact `N -> N+1` input generation toggles the ROI between full-scale
  black (`0,0,0`) and white (`255,255,255`). The ROI does not expire back to
  game pixels.
- The existing 32x32 colored generation code remains at the top-left. It
  identifies the input generation modulo `2^18`; retain the telemetry log to
  disambiguate longer runs.

The default `inputlatency=1` marker and browser canvas observer are unchanged
when `inputphoton` is absent.

## Enabling the marker

Use the URL directly:

```text
?inputphoton=1&metrics=1&inputphotonsize=160
```

`inputphotonsize` is the square ROI size in rendered pixels. The ROI is
centered by default. `inputphotonx` and `inputphotony` optionally set its
top-left rendered-pixel coordinate; out-of-range values are clamped to the
frame. The requested values and final frame-relative geometry are included in
`causalTelemetry.input.marker.opticalMarker`.

Keep a custom ROI clear of the top-left 32x32 generation code. Custom
coordinates are clamped to the frame, but overlap is not automatically
prevented.

For the headed playthrough harness:

```powershell
$env:INPUTPHOTON = "1"
$env:INPUTPHOTONSIZE = "160"
$env:INPUTMARKEROBSERVE = "0"
$env:METRICS = "1"
node tools/menu-progress-validate.mjs --headed
```

`INPUTPHOTONX` and `INPUTPHOTONY` forward the optional coordinates. Keep
`INPUTMARKEROBSERVE=0` for external-sensor trials. The browser observer uses
`drawImage` and `getImageData` on every animation frame and can perturb the
path being measured. The harness records the optical mode and explicitly says
that it did not capture the photon timestamp.

## Marker self-overhead controls

With both `inputphoton=1` and `metrics=1`, cumulative synchronous CPU costs
are recorded under `causalTelemetry.input.marker.overhead`. If either flag is
absent, `overhead.enabled` is false and the marker adds no overhead timers or
counters. The two measured groups are:

- `softwareFrameCopyPaint.calls`, `sourceBytes`, `paintedBytes`, `totalMs`,
  `averageMs`, and `maxMs`: the complete JavaScript frame copy plus optical
  ROI/barcode paint used by the software presenters. `paintedBytes` is byte
  write volume, so a custom ROI overlapping the barcode counts both paints.
  These stay zero on the hardware-WGPU marker path because that path encodes
  GPU render passes rather than copying a CPU frame.
- `padStatsPollParse.calls`, `sourceUtf16Bytes`, `totalMs`, `averageMs`,
  `maxMs`, and `failureCount`: the synchronous `GetVideoStats` fetch plus pad
  statistic parse used to correlate a pending input with an exact core poll.

The headed harness retains the nested counters in `samples.json` and promotes
them to scalar `inputPhoton*` columns in `samples.csv`. Its `summary.json`
copies the last cumulative snapshot to `inputPhoton.overhead`. These metrics
end at JavaScript CPU work; they do not include GPU execution, compositor
latency, scanout, or panel response.

For a self-perturbation control, run the same build, save state, scene, browser
profile, window state, and duration twice with `METRICS=1` and
`INPUTMARKEROBSERVE=0`. Use `INPUTPHOTON=0` for the control and
`INPUTPHOTON=1` for the marker arm. Compare presentation cadence and the
marker-arm cumulative overhead fields. Do not compare different menu routes
or manually timed character-selection runs.

## GPIO plus USB HID start boundary

An RP2040 or Teensy can provide a repeatable electrical start edge and enqueue
the corresponding USB HID report:

1. Configure one GPIO output and the USB keyboard/gamepad HID endpoint.
2. Randomize each trial delay in firmware so the input phase is not locked to
   USB polling, emulation, display refresh, or camera frames.
3. At the trial start, toggle the GPIO and enqueue exactly one HID state
   transition. Release it with a separate, recorded generation after the
   response window.
4. Feed the GPIO to the second oscilloscope channel or illuminate an LED in the
   camera view. Record whether firmware toggles GPIO before or after calling
   the HID enqueue routine.
5. Do not issue another transition until the optical ROI has settled and the
   generation has been logged.

If GPIO marks the firmware HID enqueue call, name the result
`HID-report-enqueue-to-photon`. USB scheduling, host delivery, browser input,
emulation, presentation, scanout, and panel response are all included. Do not
call it button-contact-to-photon. That name is valid only when a separate
electrical or optical contact sensor timestamps the physical button contact.

## Photodiode and oscilloscope protocol

Place a fast photodiode fully inside the centered ROI, not over its colored
generation code. Shield it from room light and unrelated screen pixels.
Capture the GPIO/contact start channel and photodiode voltage on a common time
base at a sample rate high enough to resolve sub-millisecond crossings.

Run at least 100 valid randomized trials, with both black-to-white and
white-to-black edges represented. Before capture:

- warm the emulator, browser, GPU, and display;
- load the same save state and scene;
- disable VRR/adaptive sync and HDR;
- fix refresh rate, window/full-screen state, zoom, display brightness, and
  marker geometry;
- disable the browser canvas marker observer;
- record the git commit, core hash, Chrome version, GPU/driver, display, and
  capture equipment.

For each direction, estimate settled low and high levels from quiet windows
around the transition. Compute `L10 = low + 0.10 * (high - low)` and
`L50 = low + 0.50 * (high - low)`. On a rising edge, use the first sustained
crossing at or above each threshold; on a falling edge, use the first sustained
crossing at or below it. Report 10% and 50% latency distributions separately,
including sample count, median, p95, p99, maximum, and rejected-trial count.

## High-speed camera alternative

Use a camera running at **1000 frames per second or faster**. Frame both the
screen ROI and the microcontroller LED/contact indicator. Lock exposure,
white balance, focus, and frame rate. Extract per-frame mean luminance from a
fixed ROI and apply the same direction-aware 10% and 50% thresholds. Camera
quantization limits timing resolution to its frame interval; state that bound
with the results. A rolling-shutter camera also needs a measured row-timing
correction or an explicit uncertainty interval.

## Raw CSV

Retain every trial, including rejected and timed-out trials. A photodiode run
should contain at least these fields:

```text
session_id,trial_id,commit_sha,core_sha256,browser_version,gpu_driver,display_model,refresh_hz,vrr_enabled,hdr_enabled,scene,save_sha256,url,input_generation,start_boundary,gpio_edge_ns,hid_enqueue_ns,contact_edge_ns,marker_direction,roi_x,roi_y,roi_width,roi_height,settled_low,settled_high,photon_10_ns,photon_50_ns,latency_10_ms,latency_50_ms,valid,rejection_reason,notes
```

Camera runs should additionally retain
`camera_fps,input_frame_index,photon_10_frame_index,photon_50_frame_index,rolling_shutter_correction_ms`
and the per-frame ROI luminance series or a lossless reference to it.

The browser telemetry ends at marker submission or GPU queue completion. Only
the externally recorded threshold crossing establishes the photon boundary.
This is a synthetic presentation marker armed by an exact core pad poll. It
does not wait for the game to react to that input and it bypasses the software
raster/XFB response that would produce a changed game frame. On the hardware
WGPU path it is composed by the replay consumer and can also bypass producer
commands still queued behind the currently submitted work. Therefore report
external results as `HID-report-enqueue-to-synthetic-marker-photon` (or
`contact-to-synthetic-marker-photon` when contact is independently sensed),
never as game-response latency.

The opt-in software-presenter implementation currently copies the complete
frame and paints the ROI in JavaScript. Treat this as measurement
instrumentation with possible self-perturbation: bracket each sensor session
with otherwise-identical marker-off and marker-on telemetry runs, report the
change in draw/presentation timing, and reject the setup if the marker changes
cadence materially. Keep the raw waveform/video, extraction script version,
raw CSV, harness `run-metadata.json`, `samples.json`, and the exact URL together
as one evidence bundle.
