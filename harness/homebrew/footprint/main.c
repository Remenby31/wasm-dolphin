/* Copyright 2026 wasm-dolphin contributors
 * SPDX-License-Identifier: MIT
 * footprint: the CI bench's front-end workload (research/deep-x64-ci-bench.md
 * §4.4). Its hot code (out/footprint_gen.S, from footprint/gen.mjs) is
 * static in the DOL, so aot=1 plans regions over it like over a game's:
 * ~1000 functions, several hundred KB of PowerPC, swept in a loop, with
 * branches and a jump table on a data-dependent state, inline cold paths,
 * calls through tables, integer, scalar FP and paired-single blocks.
 *
 * Never waits for a VI: the CPU is always busy, like a CPU-bound scene.
 * After every fp_run (SWEEPS sweeps over all functions) the marker rows
 * show: row 0 the hash of that call, row 1 the number of calls so far,
 * row 2 the function count, row 3 the hash of the first call (equal hashes
 * across backends: the generated code ran the same).
 */
#include <string.h>
#include <malloc.h>
#include <gccore.h>
#include "marker.h"

#define SWEEPS 4
#define DATA_BYTES 65536

extern u32 fp_run(void *data, u32 sweeps, const void *table);
extern const u32 fp_functions[];
extern const u32 fp_function_count;

int main(void) {
	VIDEO_Init();
	GXRModeObj *rmode = VIDEO_GetPreferredMode(NULL);
	void *xfb = MEM_K0_TO_K1(SYS_AllocateFramebuffer(rmode));
	VIDEO_ClearFrameBuffer(rmode, xfb, COLOR_BLACK);
	VIDEO_Configure(rmode);
	VIDEO_SetNextFramebuffer(xfb);
	VIDEO_SetBlack(FALSE);
	VIDEO_Flush();
	VIDEO_WaitVSync();
	if (rmode->viTVMode & VI_NON_INTERLACE) VIDEO_WaitVSync();

	/* Paired singles on (HID2: PSE and LSQE), GQR0 = plain floats. */
	u32 hid2;
	__asm__ volatile("mfspr %0, 920" : "=r"(hid2));
	hid2 |= 0xa0000000u;
	__asm__ volatile("mtspr 920, %0; isync" : : "r"(hid2));
	__asm__ volatile("mtspr 912, %0; isync" : : "r"(0));

	/* The data area: words, then doubles and float pairs of moderate size. */
	u8 *data = memalign(32, DATA_BYTES);
	u32 x = 0x12345678u;
	for (int i = 0; i < 4096; i++) { x ^= x << 13; x ^= x >> 17; x ^= x << 5; ((u32 *)data)[i] = x; }
	for (int i = 0; i < 2048; i++) ((f64 *)(data + 16384))[i] = 0.5 + (i % 97) * 0.01;
	for (int i = 0; i < 512; i++) ((f32 *)data)[i] = 0.25f + (i % 31) * 0.03f;
	DCFlushRange(data, DATA_BYTES);

	u32 first = 0;
	for (u32 n = 1;; n++) {
		u32 h = fp_run(data, SWEEPS, fp_functions);
		if (n == 1) first = h;
		const u32 rows[MK_ROWS] = {h, n, fp_function_count, first};
		mk_rows(xfb, rmode, rows);
	}
	return 0;
}
