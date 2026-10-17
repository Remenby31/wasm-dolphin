// SPIR-V → WGSL transpiler with a C ABI, for the WebGPU hardware
// renderer. Dolphin's shader generators emit GLSL; glslang (already
// linked in the wasm build) compiles that to SPIR-V; this crate does
// the final SPIR-V → WGSL hop the browser's WebGPU requires.
//
// Built as a `staticlib` for `wasm32-unknown-emscripten` and linked
// straight into dolphin_web_core, so `WebGPUShaderTranslator::
// SpirvToWgsl` can call `naga_spirv_to_wgsl` synchronously — no async
// worker round-trip, no change to Dolphin's pipeline-creation path.
//
// `panic = "abort"` in release: a panic here would abort the whole
// game wasm, so every path below is panic-free (no unwrap/expect/
// indexing — all Results handled, return null on any failure).

use std::cell::RefCell;
use std::os::raw::c_char;

// Day-30: last failure reason, so the C++/JS side can see *why* Naga
// rejected a real Dolphin shader (frontend parse vs validation vs
// WGSL backend, plus the message) instead of just a null. Thread-
// local because naga_spirv_to_wgsl is called synchronously on the
// single video pthread; valid until the next call on that thread.
thread_local! {
    static LAST_ERROR: RefCell<Option<std::ffi::CString>> = RefCell::new(None);
}

fn set_last_error(msg: String) {
    // Truncate hard so a giant naga dump can't blow the FFI copy.
    let mut m = msg;
    if m.len() > 600 {
        m.truncate(600);
    }
    let cs = std::ffi::CString::new(m)
        .unwrap_or_else(|_| std::ffi::CString::new("<err string had interior NUL>").unwrap());
    LAST_ERROR.with(|e| *e.borrow_mut() = Some(cs));
}

/// Pointer to the last failure message (NUL-terminated, owned by the
/// crate, valid until the next naga_spirv_to_wgsl call on this
/// thread), or null if the last call succeeded / none yet.
#[no_mangle]
pub extern "C" fn naga_last_error() -> *const c_char {
    LAST_ERROR.with(|e| match &*e.borrow() {
        Some(cs) => cs.as_ptr(),
        None => std::ptr::null(),
    })
}

/// Translate a SPIR-V module to WGSL.
///
/// `spirv_ptr`        — pointer to SPIR-V words (u32, little-endian as
///                      produced by glslang in the same wasm memory).
/// `spirv_word_count` — number of u32 words.
///
/// Returns a NUL-terminated UTF-8 WGSL C string allocated with the
/// shared (emscripten) allocator, or null on any failure. The caller
/// must release it with `naga_free_wgsl`.
#[no_mangle]
pub extern "C" fn naga_spirv_to_wgsl(
    spirv_ptr: *const u32,
    spirv_word_count: usize,
) -> *mut c_char {
    if spirv_ptr.is_null() || spirv_word_count == 0 {
        return std::ptr::null_mut();
    }

    // SAFETY: the C side passes a valid pointer to `spirv_word_count`
    // contiguous u32 words living in the same linear memory. We only
    // read it.
    let words: &[u32] = unsafe { std::slice::from_raw_parts(spirv_ptr, spirv_word_count) };

    match translate(words) {
        Ok(wgsl) => {
            LAST_ERROR.with(|e| *e.borrow_mut() = None);
            match std::ffi::CString::new(wgsl) {
                Ok(cstr) => cstr.into_raw(),
                Err(_) => {
                    set_last_error("WGSL output had an interior NUL".into());
                    std::ptr::null_mut()
                }
            }
        }
        Err(msg) => {
            set_last_error(msg);
            std::ptr::null_mut()
        }
    }
}

/// Free a string returned by `naga_spirv_to_wgsl`. Null-safe.
#[no_mangle]
pub extern "C" fn naga_free_wgsl(ptr: *mut c_char) {
    if ptr.is_null() {
        return;
    }
    // SAFETY: `ptr` was produced by CString::into_raw above; reclaim
    // and drop it. Both sides share emscripten's allocator under
    // wasm32-unknown-emscripten, so this is the correct free.
    unsafe {
        drop(std::ffi::CString::from_raw(ptr));
    }
}

// Naga errors nest the real cause in their source chain; the top-level
// Display is often generic ("Entry point main at Fragment is
// invalid"). Walk the chain so the C++/JS log shows the actual reason.
fn chain(prefix: &str, e: &dyn std::error::Error) -> String {
    let mut s = format!("{prefix}: {e}");
    let mut src = e.source();
    while let Some(c) = src {
        s.push_str(" <- ");
        s.push_str(&c.to_string());
        src = c.source();
    }
    s
}

// WGSL keyword / reserved / context-dependent names that Naga's WGSL
// backend Namer fails to escape when it auto-derives function names
// from debug-stripped SPIR-V. Concretely it emits `fn function(... :
// ptr<function, T>)`, and Chrome's stricter resolver reads the
// `function` identifier against the `function` address space →
// "cyclic dependency 'function' -> 'function'". We avoid the whole
// class by giving every helper function an explicit, collision-proof
// name before the WGSL backend runs (the backend keeps provided
// names, only auto-generating for `None`). Entry points are named
// from OpEntryPoint (survives debug stripping) so they're left alone.
fn sanitize_function_names(module: &mut naga::Module) {
    let mut idx: u32 = 0;
    for (_h, f) in module.functions.iter_mut() {
        f.name = Some(format!("dolphin_fn_{idx}"));
        idx += 1;
    }
}

// Dual-source blending. Dolphin declares its two blend outputs as
// `layout(location = 0, index = 0/1)`. Naga's SPIR-V frontend ignores the
// Index decoration, sees two outputs at location 0 and fails validation. So
// park the Index-1 output on a location no Dolphin shader uses before parsing,
// then turn the pair into @location(0) @blend_src(0) / @blend_src(1) in the IR.
const OP_DECORATE: u32 = 71;
const DECORATION_LOCATION: u32 = 30;
const DECORATION_INDEX: u32 = 32;
const PARKED_LOCATION: u32 = 31;

fn park_dual_source_output(words: &[u32]) -> Option<Vec<u32>> {
    let decorations = |w: &[u32]| {
        let mut out = Vec::new();
        let mut i = 5;
        while i < w.len() {
            let count = (w[i] >> 16) as usize;
            if count == 0 || i + count > w.len() {
                break;
            }
            if w[i] & 0xffff == OP_DECORATE && count >= 4 {
                out.push(i);
            }
            i += count;
        }
        out
    };
    let at = decorations(words);
    let second: Vec<u32> = at
        .iter()
        .filter(|&&i| words[i + 2] == DECORATION_INDEX && words[i + 3] == 1)
        .map(|&i| words[i + 1])
        .collect();
    if second.is_empty() {
        return None;
    }
    let mut out = words.to_vec();
    for i in at {
        if out[i + 2] == DECORATION_LOCATION && out[i + 3] == 0 && second.contains(&out[i + 1]) {
            out[i + 3] = PARKED_LOCATION;
        }
    }
    Some(out)
}

fn restore_dual_source_outputs(module: &mut naga::Module) {
    use naga::{Binding, TypeInner};
    for ep in module.entry_points.iter() {
        if ep.stage != naga::ShaderStage::Fragment {
            continue;
        }
        let Some(result) = ep.function.result.as_ref() else { continue };
        let ty = module.types[result.ty].clone();
        let TypeInner::Struct { mut members, span } = ty.inner else { continue };
        let parked = |b: &Option<Binding>| {
            matches!(b, Some(Binding::Location { location: PARKED_LOCATION, .. }))
        };
        if !members.iter().any(|m| parked(&m.binding)) {
            continue;
        }
        for m in members.iter_mut() {
            if let Some(Binding::Location { ref mut location, ref mut blend_src, .. }) = m.binding {
                if *location == PARKED_LOCATION {
                    *location = 0;
                    *blend_src = Some(1);
                } else if *location == 0 {
                    *blend_src = Some(0);
                }
            }
        }
        module.types.replace(
            result.ty,
            naga::Type { name: ty.name, inner: TypeInner::Struct { members, span } },
        );
    }
}

fn translate(words: &[u32]) -> Result<String, String> {
    let options = naga::front::spv::Options::default();
    let parked = park_dual_source_output(words);
    let words = parked.as_deref().unwrap_or(words);
    let mut module = naga::front::spv::Frontend::new(words.iter().copied(), &options)
        .parse()
        .map_err(|e| chain("spv-frontend", &e))?;

    sanitize_function_names(&mut module);
    if parked.is_some() {
        restore_dual_source_outputs(&mut module);
    }

    // The WGSL backend needs validation info. Allow the full
    // capability set — Dolphin emits a wide range of features and we
    // don't want to reject otherwise-valid modules here.
    let mut validator = naga::valid::Validator::new(
        naga::valid::ValidationFlags::all(),
        naga::valid::Capabilities::all(),
    );
    let info = validator
        .validate(&module)
        .map_err(|e| chain("validate", &e))?;

    naga::back::wgsl::write_string(&module, &info, naga::back::wgsl::WriterFlags::empty())
        .map_err(|e| chain("wgsl-backend", &e))
}
