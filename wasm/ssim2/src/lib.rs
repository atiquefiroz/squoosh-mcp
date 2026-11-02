//! SSIMULACRA 2 for squoosh-mcp. Plain C-ABI exports, loaded with `WebAssembly.instantiate`.
//!
//! Pixels are interleaved 8-bit sRGB, 3 (RGB) or 4 (RGBA, straight alpha) channels.
//! Errors are reported as `ERROR_SCORE` (-1e9); the JS side turns them into exceptions.

use fast_ssim2::{PixelDescriptor, PixelSlice, Ssimulacra2Reference};

const ERROR_SCORE: f64 = -1.0e9;

fn descriptor(channels: u32) -> PixelDescriptor {
    if channels == 4 {
        PixelDescriptor::RGBA8_SRGB
    } else {
        PixelDescriptor::RGB8_SRGB
    }
}

unsafe fn pixels<'a>(ptr: *const u8, w: u32, h: u32, ch: u32) -> Option<PixelSlice<'a>> {
    if ptr.is_null() || w == 0 || h == 0 || !(ch == 3 || ch == 4) {
        return None;
    }
    let stride = w as usize * ch as usize;
    let data = core::slice::from_raw_parts(ptr, stride * h as usize);
    PixelSlice::new(data, w, h, stride, descriptor(ch)).ok()
}

#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let mut buf = Vec::<u8>::with_capacity(len);
    let ptr = buf.as_mut_ptr();
    core::mem::forget(buf);
    ptr
}

/// # Safety
/// `ptr` must come from `alloc(len)` and not be freed twice.
#[no_mangle]
pub unsafe extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    drop(Vec::from_raw_parts(ptr, 0, len));
}

/// Builds a cached reference. Returns null on invalid input.
///
/// # Safety
/// `ptr` must point to `w * h * ch` readable bytes.
#[no_mangle]
pub unsafe extern "C" fn ref_new(ptr: *const u8, w: u32, h: u32, ch: u32) -> *mut Ssimulacra2Reference {
    match pixels(ptr, w, h, ch).and_then(|px| Ssimulacra2Reference::new(&px).ok()) {
        Some(reference) => Box::into_raw(Box::new(reference)),
        None => core::ptr::null_mut(),
    }
}

/// Scores `ptr` against a cached reference. Returns `ERROR_SCORE` on failure.
///
/// # Safety
/// `reference` must come from `ref_new`; `ptr` must point to `w * h * ch` readable bytes.
#[no_mangle]
pub unsafe extern "C" fn ref_compare(
    reference: *const Ssimulacra2Reference,
    ptr: *const u8,
    w: u32,
    h: u32,
    ch: u32,
) -> f64 {
    let (Some(reference), Some(px)) = (reference.as_ref(), pixels(ptr, w, h, ch)) else {
        return ERROR_SCORE;
    };
    // Whole-image evaluation: strip mode measured ~2.5x slower in WASM. Large images are
    // tiled on the JS side instead, which also bounds memory.
    reference.compare(&px).unwrap_or(ERROR_SCORE)
}

/// # Safety
/// `reference` must come from `ref_new` and not be freed twice.
#[no_mangle]
pub unsafe extern "C" fn ref_free(reference: *mut Ssimulacra2Reference) {
    if !reference.is_null() {
        drop(Box::from_raw(reference));
    }
}
