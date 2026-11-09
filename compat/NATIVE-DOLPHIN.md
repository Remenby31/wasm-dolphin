# native-dolphin (paused, 2026-11-09)

Works: `.github/workflows/native-dolphin.yml` builds unpatched upstream Dolphin (e22551e, nogui, Linux, cached per commit, `LINUX_LOCAL_DEV` for Sys); `compat/native.mjs` creates the user tree nogui leaves out (Dump/Frames), keeps Dolphin's log, boots our `.dol`/`.iso` under xvfb with frame dumps decoded by `compat/lib/report-rows.mjs`.
Blocked: under xvfb the log stops right after "Booting from executable" (.dol) or "Using OpenGL" (.iso), software renderer and OGL/llvmpipe alike; no VI/PI event, no frame in 40-60 s. Cause unknown after 7 CI iterations.
Not tried: an interactive Linux session (gdb on the stalled process), `-p headless` with `ENABLE_HEADLESS=ON`, CPUThread=True, a GDB-stub or USB Gecko read-out instead of frame dumps.
On macOS the software renderer needs an OpenGL window (`-p headless` fails: "Failed to create OpenGL window"), forbidden on the shared Mac.
Purpose: show whether a difference our core has (gxtest clipping/rasterization, EFB pokes) is upstream Dolphin's; until then the notes say "non vérifié".
