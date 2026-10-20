/* Copyright 2026 wasm-dolphin contributors
 * SPDX-License-Identifier: MIT
 * smctest: self-modifying code over code the JIT (and P4 regions) compiled.
 * A small function of the DOL is called every frame until PATCH_FRAME, long
 * enough for it to be compiled (and, with aot=1, translated into a region and
 * installed). Then its first instruction is rewritten (li r3,1 -> li r3,2)
 * and the change published as a program must: dcbst, sync, icbi, isync
 * (DCFlushRange + ICInvalidateRange). Every call after that must see 2.
 * Row 0: sum of target() over the frames before the patch (PATCH_FRAME * 1).
 * Row 1: value of target() on the last frame.
 * Row 2: frames after the patch where target() was not 2 (saturating).
 * Row 3: 1 once DONE_FRAME frames have passed (output is frozen from then on).
 */
#include <string.h>
#include <gccore.h>
#include "marker.h"

#define PATCH_FRAME 600
#define DONE_FRAME 900
#define CALLS_PER_FRAME 2000

/* Kept apart and simple: the first word is li r3,1 (checked before patching).
 * noipa: GCC must not use its return value at the call sites (it would fold
 * the calls away and the patch would never be seen). */
__attribute__((noipa, aligned(32))) int smc_target(void) {
	return 1;
}

/* Called through a volatile pointer too: a real call each time. */
static int (*volatile target_fn)(void) = smc_target;

__attribute__((noipa)) static u32 call_many(void) {
	u32 sum = 0;
	for (int i = 0; i < CALLS_PER_FRAME; i++) sum += (u32)target_fn();
	return sum / CALLS_PER_FRAME;
}

__attribute__((noipa)) static void patch_target(void) {
	u32 *code = (u32 *)(void *)smc_target;
	if (code[0] != 0x38600001u) return; /* not li r3,1: leave the code alone */
	code[0] = 0x38600002u;              /* li r3,2 */
	DCFlushRange(code, 32);
	ICInvalidateRange(code, 32);
}

int main(void) {
	VIDEO_Init();
	GXRModeObj *rmode = VIDEO_GetPreferredMode(NULL);
	void *xfb = MEM_K0_TO_K1(SYS_AllocateFramebuffer(rmode));
	VIDEO_Configure(rmode);
	VIDEO_SetNextFramebuffer(xfb);
	VIDEO_SetBlack(FALSE);
	VIDEO_Flush();
	VIDEO_WaitVSync();
	if (rmode->viTVMode & VI_NON_INTERLACE) VIDEO_WaitVSync();

	u32 before = 0, last = 0, wrong = 0;
	for (u32 frame = 0;; frame++) {
		VIDEO_WaitVSync();
		if (frame <= DONE_FRAME) {
			if (frame == PATCH_FRAME) patch_target();
			last = call_many();
			if (frame < PATCH_FRAME) before += last;
			else if (last != 2 && wrong < 0xffffffffu) wrong++;
		}
		const u32 rows[MK_ROWS] = {before, last, wrong, frame < DONE_FRAME ? 0 : 1};
		mk_rows(xfb, rmode, rows);
	}
	return 0;
}
