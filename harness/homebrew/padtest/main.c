/* Copyright 2026 wasm-dolphin contributors
 * SPDX-License-Identifier: MIT
 * padtest: prints the state of the 4 controller ports and mirrors it in the
 * harness marker rows (row = port, plus a checksum row), so tests can check
 * ports 2-4 end to end.
 * Row bits (LSB first): 0-12 PAD_ButtonsHeld, 13/14 stick X +/-, 15/16 stick Y +/-,
 * 17/18 C-stick X +/-, 19/20 C-stick Y +/-, 21 L analog, 22 R analog,
 * 23 port reported connected, 31 always set (row valid).
 */
#include <stdio.h>
#include <gccore.h>
#include "marker.h"

static u32 encode(int c, u32 connected) {
	u32 v = (1u << 31) | (PAD_ButtonsHeld(c) & 0x1fff);
	int sx = PAD_StickX(c), sy = PAD_StickY(c), cx = PAD_SubStickX(c), cy = PAD_SubStickY(c);
	if (sx > 40) v |= 1u << 13;
	if (sx < -40) v |= 1u << 14;
	if (sy > 40) v |= 1u << 15;
	if (sy < -40) v |= 1u << 16;
	if (cx > 40) v |= 1u << 17;
	if (cx < -40) v |= 1u << 18;
	if (cy > 40) v |= 1u << 19;
	if (cy < -40) v |= 1u << 20;
	if (PAD_TriggerL(c) > 100) v |= 1u << 21;
	if (PAD_TriggerR(c) > 100) v |= 1u << 22;
	if (connected & (1u << c)) v |= 1u << 23;
	return v;
}

int main(void) {
	VIDEO_Init();
	PAD_Init();
	GXRModeObj *rmode = VIDEO_GetPreferredMode(NULL);
	void *xfb = MEM_K0_TO_K1(SYS_AllocateFramebuffer(rmode));
	console_init(xfb, 20, 20, rmode->fbWidth, rmode->xfbHeight, rmode->fbWidth * VI_DISPLAY_PIX_SZ);
	VIDEO_Configure(rmode);
	VIDEO_SetNextFramebuffer(xfb);
	VIDEO_SetBlack(FALSE);
	VIDEO_Flush();
	VIDEO_WaitVSync();
	if (rmode->viTVMode & VI_NON_INTERLACE) VIDEO_WaitVSync();

	u32 frame = 0;
	while (1) {
		VIDEO_WaitVSync();
		u32 connected = PAD_ScanPads();
		printf("\x1b[2;0H");
		printf("PADTEST frame %lu\n\n", (unsigned long)frame++);
		for (int c = 0; c < 4; c++) {
			u16 h = PAD_ButtonsHeld(c);
			printf("P%d held=%04x sx=%4d sy=%4d cx=%4d cy=%4d L=%3d R=%3d\n", c + 1, h,
			       PAD_StickX(c), PAD_StickY(c), PAD_SubStickX(c), PAD_SubStickY(c),
			       PAD_TriggerL(c), PAD_TriggerR(c));
		}
		u32 rows[MK_ROWS];
		for (int c = 0; c < 4; c++) rows[c] = encode(c, connected);
		mk_rows(xfb, rmode, rows);
	}
	return 0;
}
