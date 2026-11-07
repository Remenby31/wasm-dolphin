# Upstream Dolphin WebAssembly Probe

This records the current state of the upstream Dolphin port attempt. The local browser host and native ABI build successfully, but upstream Dolphin still needs platform work before it can provide the real emulation core.

## Inputs

- Upstream source: `vendor/dolphin`
- Current upstream commit tested: `e22551e`
- Local build dir: `build/dolphin-wasm`
- Patch command: `npm run patch:upstream`
- Configure command: `npm run configure:upstream`
- Probe target: `npm run build:upstream:discio`

## Configure State

`npm run configure:upstream` successfully generates Ninja files through Emscripten after `npm run patch:upstream` applies the browser platform build gates. The script disables desktop frontends, audio backends, Vulkan/EGL/X11/SDL, updater/analytics, mGBA, UPNP, tests, and zlib-ng CPU-specific optimizations.

The `-D__linux__` compile define is a shallow platform shim. It lets bundled SFML choose its Linux Unix path under Emscripten; it is not a complete browser platform layer.

## Build Findings

Initial compile failed inside bundled zlib-ng because it tried to use x86 CPU feature detection under WebAssembly. The configure script now disables those paths with `WITH_OPTIM=OFF` and the SSE/AVX/PCLMUL flags set to `OFF`.

The first desktop dependency blockers are now patched:

- Bundled SFML rejects Emscripten's generic Unix identity unless forced through a known Unix platform branch. The configure script still uses the temporary `-D__linux__` shim.
- LibUSB and HIDAPI are skipped for Emscripten, because browser builds cannot use the native USB/Bluetooth/controller backends.
- InputCommon's GameCube adapter implementation now compiles without the native USB backend and reports unavailable.
- Common's filesystem watcher is a no-op under Emscripten, avoiding Linux `sys/eventfd.h`.

`npm run build:upstream:discio` now builds `Source/Core/DiscIO/libdiscio.a` through Emscripten. `npm run build:upstream:bridge` links that upstream DiscIO slice into `cores/dolphin/dolphin-upstream.js` and `cores/dolphin/dolphin-upstream.wasm` with a browser ABI for mounting a disc path and reading metadata.

The upstream bridge is now built with `-lworkerfs.js` and `-sENVIRONMENT=web,worker,node`. The browser host can run it through `?core=upstream`, where `src/upstream-discio-worker.js` mounts a selected browser `File` at `/workerfs/<disc-name>` without copying the whole disc into MEMFS. The browser smoke route `?core=upstream&smoke=disc` verifies this path with a synthetic GameCube header (placeholder ID `GXXE01`).

The bridge also exports boot-critical layout probes: apploader date/size, boot DOL offset/size, FST offset/size, raw/data size, root FST entry count, raw disc reads, and filesystem file reads. These are still DiscIO probes, not CPU execution.

## Next Porting Decisions

1. Replace the `-D__linux__` SFML shim with explicit browser platform gates or removal from the metadata-only target.
2. Split DiscIO further so GameCube metadata does not need Wii/WAD ES sources in the bridge link.
3. Use the boot-layout exports to build a browser boot inspector panel and validate a real disc image locally.
4. Decide the threading policy early. A pthreads build needs `SharedArrayBuffer`, `Cross-Origin-Opener-Policy`, and `Cross-Origin-Embedder-Policy`; the local server already sends those headers.
5. Start PowerPC with an interpreter path. Native Dolphin JIT backends cannot be reused directly in a browser because they emit host machine code, not WebAssembly.

The pass metric, a commercial GameCube game running smoothly in Chrome, is still outstanding. The current core mounts a synthetic GameCube header and renders native WebAssembly frames, but it does not execute the game.
