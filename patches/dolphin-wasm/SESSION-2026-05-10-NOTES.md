# Session 2026-05-10 — vendor/dolphin source changes not yet captured as patches

This session's WASM rebuild (`cores/dolphin/dolphin-core-upstream.{js,wasm}`,
committed in the repo at `1e05b65`) embeds five changes to `vendor/dolphin/`
that are **not** in patches 0001–0009. Re-deriving the patches against
upstream Dolphin was deferred because the working tree had 0001–0009 +
session deltas all intermixed, with no clean baseline to diff against. The
binary works; this note records what the next rebuild has to re-apply.

If you're rebuilding from a clean upstream Dolphin clone, after `npm run
patch:upstream` apply these five edits **before** running `npm run build:upstream`.

---

## 1. `Source/Core/Core/CMakeLists.txt` — bump heap to 1.5 GiB

Around the `target_link_options(dolphin_web_core ...)` block:

```diff
-    "-sALLOW_MEMORY_GROWTH=0"
-    "-sINITIAL_MEMORY=1073741824"
+    "-sALLOW_MEMORY_GROWTH=0"
+    "-sINITIAL_MEMORY=1610612736"
```

**Why:** With JIT off (forced for OGL hardware path because JIT-on
corrupts post-boot rendering), the interpreter+dcb cache grows enough to
OOM at the original 1 GiB heap around the title-screen transition.
1.5 GiB sits between Chrome's tolerant ceiling and Firefox's 2 GiB
per-worker cap; both browsers accept it. Memory-growth + pthread emits
an em++ warning and broke ROM mount in the user's session, so kept
fixed-size.

---

## 2. `Source/Core/Core/PowerPC/CachedInterpreter/CachedInterpreter.cpp` — JIT block memory page count

Around the WASM block emitter where the imported shared memory limits are
declared (search for `EmitU32Leb(imports, 16384)`):

```diff
   imports.push_back(0x02);
   imports.push_back(0x03);
-  EmitU32Leb(imports, 16384);
-  EmitU32Leb(imports, 16384);
+  EmitU32Leb(imports, 24576);
+  EmitU32Leb(imports, 24576);
   EmitSection(bytes, 2, imports);
```

**Why:** The JIT-emitted WASM modules import the actual shared memory.
The declared min/max **must equal** the SAB's min/max (1.5 GiB = 24576
pages). Mismatch throws `LinkError("memory max 24576 > WASM binary max
16384")` exactly when block compilation fires (~frame 700). Keep in sync
with `INITIAL_MEMORY` above.

Note: this same emit pattern is also in `core/upstream/dolphin_web_core.cpp`
(two places) — those are in-repo and already committed at `1e05b65`.

---

## 3. `Source/Core/Common/GL/GLInterface/Emscripten.h` — track context-creation method

Inside `class GLContextEmscripten`, after `EMSCRIPTEN_WEBGL_CONTEXT_HANDLE m_context = 0;`:

```cpp
  // True when the GL context was created via direct JS getContext +
  // GL.registerContext (the worker-mode path patch 0009 bypasses Emscripten's
  // proxy machinery with). For these contexts emscripten_webgl_commit_frame
  // returns -3 (INVALID_TARGET) because explicitSwapControl isn't on the
  // registered context. Rely on the OffscreenCanvas auto-mirror at task
  // boundary instead. Without this gate, PE_FINISH never fires → the game's CPU
  // stays in the idle-poll fast loop forever.
  bool m_context_created_via_direct_js = false;
```

---

## 4. `Source/Core/Common/GL/GLInterface/Emscripten.cpp` — set + gate the flag

Inside `Initialize`, in the worker-mode branch that creates the context via
`EM_ASM_INT` (added by patch 0009). After the fallback `if` block that
handles direct-creation failure:

```cpp
    if (static_cast<std::intptr_t>(m_context) <= 0)
    {
      // ... existing fallback to PROXY_ALWAYS ...
    }
    else
    {
      m_context_created_via_direct_js = true;
    }
```

In `Swap()`, replace the unconditional commit_frame call with:

```cpp
  // For direct-JS-created contexts (worker-mode patch 0009), commit_frame
  // returns -3 INVALID_TARGET because explicitSwapControl isn't on the
  // registered context. Without this gate the swap "fails" every frame,
  // Renderer::Present aborts, GXSetDrawDone never reaches the GPU thread,
  // PE_FINISH never raises, and the game's CPU stays in the idle-poll fast
  // loop forever.
  const int commit_result =
      m_context_created_via_direct_js ? 0 : emscripten_webgl_commit_frame();
```

---

## 5. `Source/Core/VideoBackends/OGL/OGLMain.cpp` — gate reverse-Z on clip control

In `FillConservativeEmscriptenBackendInfo` (the function patch 0001 added that
returns early when `UseWorkerOwnedWebGL()`), change `bSupportsReversedDepthRange`:

```cpp
  // WebGL2 lacks GL_ARB_clip_control; reverse-Z without clip control breaks
  // every depth test, so leave reverse-Z off in the conservative defaults.
  g_backend_info.bSupportsReversedDepthRange = false;
```

In `FillBackendInfo`, after the `PopulateConfig(context)` call succeeds:

```cpp
  // Reverse-Z requires clip control to remap NDC depth from [-1, 1] to
  // [0, 1]. WebGL2 lacks GL_ARB_clip_control; enabling reverse-Z without
  // it corrupts every depth test (geometry Z-fails out, scene renders
  // black). Gate one on the other.
  if (!g_backend_info.bSupportsClipControl)
    g_backend_info.bSupportsReversedDepthRange = false;
```

---

## Open follow-ups (not addressed this session)

- **JIT-on + OGL renders garbage** — `wasmjit=1` mis-emits opcodes whose
  result corrupts vertex/raster state for any 3D scene post-boot. Two
  bisection attempts narrowed the bad category but didn't pinpoint a
  one-line fix (see task KK in commit history). Workaround: keep JIT
  off for the OGL path; software backend can run JIT-on safely.
- **Firefox compatibility** — boot dialogs render in Firefox but
  post-cutscene title screen is black on the user's machine. Suspected
  cause: a SES-injecting browser extension intercepting an exception
  during pthread bootstrap. Playwright's bundled Firefox lacks WebGL
  and WASM, so couldn't reproduce.
