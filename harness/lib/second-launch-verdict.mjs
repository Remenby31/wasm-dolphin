// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
//
// The verdict of one aot-second-launch run (probes/aot-second-launch.mjs):
// pass, fail (with why), refused-layout (the heap moved and every cached
// region was refused), or not-applicable: a heap shift asked for, but the
// RAM did not move. 0106 places GameCube RAM and L1 at static addresses, so
// a shift leaves the cached modules holding this session's bases already
// (nothing patched, nothing refused); the shift case does not apply there,
// and it is reported as such, never as a failure. It still applies where
// the RAM moves (the Wii, a RAM override).
export function secondLaunchVerdict(r, { frames, fromCache, installed, heapShift = false, minFrames = 3000 }) {
  const staticRam = heapShift && r.heapPatched === 0 && !(r.layoutRefused > 0) && installed > 0;
  const healthy = [
    r.error && `error: ${r.error}`,
    r.capped && `memory cap (${r.capped.totalMB} MB: ${JSON.stringify(r.capped.byType)})`,
    r.invalidReads > 0 && `${r.invalidReads} "Invalid read"`,
    frames < minFrames && `${frames} frames < ${minFrames}`,
    !(fromCache > 0) && "no module loaded from the region cache (a first launch: seed, port, compiler version?)",
    // a forced heap shift: every region must have been patched, none refused
    heapShift && !staticRam && !(r.heapPatched > 0) && `heap shifted but ${r.heapPatched ?? "no"} module patched`,
    heapShift && r.layoutRefused > 0 && `heap shifted and ${r.layoutRefused} refused for their layout`
  ].filter(Boolean);
  const refusedLayout = !healthy.length && !(installed > 0) && r.layoutRefused > 0;
  const layoutNote = r.layoutRefused > 0 ? ` (${r.layoutRefused} refused for another heap layout)` : "";
  const why = refusedLayout ? [] : [...healthy, ...(healthy.length || installed > 0 ? [] : [`no region installed${layoutNote}`])];
  const verdict = refusedLayout ? "refused-layout" : why.length ? "fail" : staticRam ? "not-applicable" : "pass";
  return { verdict, why, staticRam };
}
