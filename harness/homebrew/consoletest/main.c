/* Copyright 2026 wasm-dolphin contributors
 * SPDX-License-Identifier: MIT
 * consoletest: deterministic printf/console workload. The formatted text is
 * also rendered with snprintf and hashed into marker row 0, so an
 * interpreter run and a JIT run can be compared bit for bit.
 * Status: yellow while running, green once DONE_FRAME frames have passed.
 * Row 0: FNV-1a of every line formatted on the last frame.
 * Row 1: FNV-1a of the lines formatted on the first frame.
 * Row 2: number of frames whose hash differed from frame 0 (saturating).
 */
#include <stdio.h>
#include <string.h>
#include <gccore.h>
#include "marker.h"

#define DONE_FRAME 900

static u32 format_all(int echo) {
	char line[96];
	u32 h = MK_FNV_INIT;
	u32 x = 0x12345678u;
	for (int i = 0; i < 12; i++) {
		x = x * 1103515245u + 12345u;
		int n = snprintf(line, sizeof line, "%2d %08lx %11ld %-6s|%6.3f %e", i, (unsigned long)x,
		                 (long)(s32)x, (x & 1) ? "odd" : "even", (double)(x % 100000) / 7.0,
		                 (double)(s32)x * 1e-3);
		h = mk_fnv(h, line, (u32)n);
		if (echo) printf("%s\n", line);
	}
	return h;
}

int main(void) {
	VIDEO_Init();
	GXRModeObj *rmode = VIDEO_GetPreferredMode(NULL);
	void *xfb = MEM_K0_TO_K1(SYS_AllocateFramebuffer(rmode));
	console_init(xfb, 20, 20, rmode->fbWidth, rmode->xfbHeight, rmode->fbWidth * VI_DISPLAY_PIX_SZ);
	VIDEO_Configure(rmode);
	VIDEO_SetNextFramebuffer(xfb);
	VIDEO_SetBlack(FALSE);
	VIDEO_Flush();
	VIDEO_WaitVSync();
	if (rmode->viTVMode & VI_NON_INTERLACE) VIDEO_WaitVSync();

	u32 first = 0, last = 0, diverged = 0;
	for (u32 frame = 0;; frame++) {
		VIDEO_WaitVSync();
		if (frame <= DONE_FRAME) {
			printf("\x1b[2;0HCONSOLETEST\n\n");
			last = format_all(1);
			if (frame == 0) first = last;
			else if (last != first && diverged < 0xffffffffu) diverged++;
		}
		mk_row(xfb, rmode, 0, last);
		mk_row(xfb, rmode, 1, first);
		mk_row(xfb, rmode, 2, diverged);
		mk_status(xfb, rmode, frame < DONE_FRAME ? MK_RUNNING : (diverged ? MK_FAIL : MK_PASS));
	}
	return 0;
}
