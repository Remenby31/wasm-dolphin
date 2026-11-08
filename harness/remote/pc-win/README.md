# PC kit (Windows, driven from the Mac)

The measure of a Windows PC over ssh, in one command, the machine put back as it was.
The full write-up (pitfalls, calibration sources, limits) is in the program's `research/pc-windows-kit.md`. The protocol is `research/pc-windows-protocol.md`, hashed before any data.

```sh
# 1. what the PC is, and whether it can measure (no change but C:\salon-kit\salon-pc.ps1)
node harness/remote/pc-run.mjs check --host pc --iso 'C:\discs\game.iso'
# 2. node, Playwright (driver only), this checkout's HEAD and the engine Salon pins, under C:\salon-kit
node harness/remote/pc-run.mjs setup --host pc
# 3. the adapter, the bench in Chrome and Edge, unclamped
node harness/remote/pc-run.mjs smoke --host pc
# 4. the clamp to the i5-12400 class: calibration.json
node harness/remote/pc-run.mjs calibrate --host pc
# 5. the J1b series: parcours 1P and 2P, Chrome and Edge, interleaved, under the calibrated clamp
node harness/remote/pc-run.mjs run --host pc --iso 'C:\discs\game.iso' \
  --film 1p=route1-1p-v2.json --film 2p=route2-2p.json --runs 3 --calibration <job>/calibration.json
# or 2 to 5 at once:
node harness/remote/pc-run.mjs all --host pc --iso 'C:\discs\game.iso' --film 1p=... --film 2p=...
# any command: --dry-run (no connection, a simulated PC answers); restore --job ID after a lost Mac
```

What a job changes on the PC, all undone at its end (by `pc-run`, and by the job's own task if the Mac is gone):
- a power scheme with the fixed GUID `5a10c0de-0b1d-4c1a-9e2f-12400c1a0001`, a copy of the active one, carrying the clamp (maximum processor frequency, else maximum processor state). The original scheme is re-activated and the copy deleted; the user's schemes are never edited.
- one scheduled task `\SalonKit\<job>`, which runs the job in the logged-on session. A browser started from the ssh session would have no screen.
- files under `C:\salon-kit`.

The core count is a process affinity of the job (6 cores of the fastest class, with their SMT siblings), so there is nothing to undo. The kit never installs a browser or a driver, and never copies a disc: `--iso` is a path on the PC.

Results go to `$CLAUDE_JOB_DIR/pc-kit/<job>/`, else `../measures/pc-kit/`. That folder holds `report.md` (preflight, clamp and restore, the machine during the job, the J1b table), `kit-record.json`, `sampler.jsonl`, and each probe's own output.
