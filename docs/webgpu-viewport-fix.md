# WebGPU viewport preservation and racing-game overlay

WebGPU replay now preserves the requested viewport instead of shrinking it to the render attachment. The correction removes the faint displaced image seen in a Wii racing game's effect composite. Depth range handling and scissor clipping remain intact.

The game requests a scratch viewport at `(336,300)` with size `608×456`. Replay reduced it to `304×228` to fit the `640×528` attachment. That changed the coordinate transform: a scratch quad covered only `76×57` pixels instead of `152×114`. Subsequent larger copies included leftover road imagery, which entered an alpha mask and produced the faint overlay.

Chrome 143.0.7499.4 on the test RDNA4 adapter accepts the original viewport, including tested negative origins. An offscreen GPU regression drew 17,328 pixels with the correct transform versus 4,332 with the old clamp. The viewport transform and attachment clipping are separate operations in the [WebGPU specification](https://gpuweb.github.io/gpuweb/#dom-gpurenderpassencoder-setviewport).

Three corrected game captures restore the expected scratch coverage. Matching shaders and blend descriptors are unchanged, while the contaminated effect alpha becomes zero and the faint rectangle disappears. The correction is in `src/upstream-discio-worker.js`; `tests/wgpu-viewport.test.mjs` adds 14 regressions for oversized, negative, fractional and zero-area viewports, cached state and depth/reverse-Z behavior. All 916 tests, syntax checking and provenance verification pass.

Core: `7479b6c803ff1d19e4c03b3654c69e4fe95a6a4367b411ba11769c65730b112c`. Worker after this fix: `624c4f619038a2d6d0d364be65db56ed1cd7a2bba0be4c239ac032d6db8b7a10`. No native rebuild was needed for the viewport change.

## Separate missing minimap

The course texture is a separate issue. Its 220×220 GPU image contains zero in every RGBA channel immediately before and after the HUD draw. Racer icons use other textures and still render.

Parsing the original race save state confirms that its unique 220×220 EFB-copy cache entry already contains 193,600 zero bytes. All 62 serialized texture-cache images are zero. The original file is unchanged. The active WebGPU staging readback implementation is incomplete, so save/restore readback needs separate repair; a shader cannot recreate pixels missing from the saved state.

Re-entering the same course generated a valid course texture with 5,642 nontransparent pixels. Its raw RGBA pixels were inserted into **a new copy** of the old checkpoint, changing only that one serialized image. The entire decoded state and header were verified unchanged outside the image range, and the rebuilt LZ4 data passed a complete roundtrip check.

The repaired checkpoint (a private `.sav` under `.omx/`) then loaded successfully. The outline appears in the original race scene, and its restored GPU texture SHA-256 exactly matches the freshly generated map (`e4d8b7c7d8882a226cde7e5cbaf5743fa9dc5e55386c30c7e9d9a6ca985dbba6`). Final GPU completion and renderer-error checks pass. This is a map-only fixture recovery: the other 61 lost images and general GPU save-state readback remain unresolved. Future fixture tests for this game should select the repaired checkpoint explicitly.

Private captures, exact before/after readbacks, the GPU viewport probe, shader comparisons and save-state parsing evidence are under a private `.omx/` directory. Game data and captures are excluded from source commits. Performance results measured before this viewport correction retain their original worker identity and are not relabelled as results for the newer worker.
