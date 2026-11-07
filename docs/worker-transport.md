# Worker transport A/B

The worker transport treats only `setInputMask`, `setInputState`, and
`setAudioMuted` as strictly one-way requests. These messages carry an explicit
`oneWay: true` marker and no request ID. Successful handlers do not send a
reply because the main-thread adapter never awaited or consumed those replies.

Errors are not suppressed. A failed one-way handler still emits the existing
status message and `{ id: undefined, ok: false, error }` reply. Messages with a
numeric request ID retain the existing promise-based request/response path.
Unknown message types are not classified as one-way.

## Rollback and A/B validation

The optimized transport is the default. Add `legacyonewayack=1` to restore the
previous successful acknowledgement for every one-way request:

```text
# candidate
...?metrics=1

# legacy control
...?metrics=1&legacyonewayack=1
```

Use repeated, balanced-order runs of the same reference-battle fixed save.
Do not interpret message-count reduction as a speedup by itself; compare game
speed, unique visual FPS, interval distributions, main-thread stalls, and input
latency before accepting a performance claim.

## Telemetry

`rendererDiagnostics` includes a `workerTransport` object with request counts,
successful replies suppressed or sent, errors sent, and
`estimatedOneWaySuccessReplyJsonBytesAvoided`. The byte counter is the UTF-8
JSON payload size of the omitted reply, not browser structured-clone framing
or an estimate of total IPC cost. The main-thread adapter also exposes
`transportTelemetry()` for posted one-way/request counts and any unmatched
legacy acknowledgements or error replies it receives.

Rollback is a URL-only change: add `legacyonewayack=1`. No core rebuild or
generated artifact change is involved.
