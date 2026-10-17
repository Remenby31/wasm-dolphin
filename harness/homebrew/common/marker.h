/* Copyright 2026 wasm-dolphin contributors
 * SPDX-License-Identifier: MIT
 * Harness marker protocol: machine-readable cells painted straight into the
 * XFB so the QA harness can read homebrew state back from a captured frame.
 * The decoder lives in harness/lib/markers.mjs; keep both sides in sync.
 *
 *   status block  x 576..623, y 16..47   colour = MK_* below
 *   data rows     row r (0..3): y 384+r*20 .. +13
 *                 bit i (0..31, MSB first): x 32+i*18 .. +13
 *                 white = 1, black = 0
 */
#ifndef HARNESS_MARKER_H
#define HARNESS_MARKER_H

#include <gccore.h>

#define MK_IDLE    0 /* blue   */
#define MK_RUNNING 1 /* yellow */
#define MK_PASS    2 /* green  */
#define MK_FAIL    3 /* red    */

/* Y, Cb, Cr (BT.601, studio range) */
static const u8 mk_status_yuv[4][3] = {
	{ 41, 240, 110},
	{210,  16, 146},
	{145,  54,  34},
	{ 81,  90, 240},
};

static inline void mk_fill(void *xfb, const GXRModeObj *rm, int x0, int y0, int w, int h,
                           u8 y, u8 cb, u8 cr) {
	u32 *fb = (u32 *)xfb;
	u32 px = ((u32)y << 24) | ((u32)cb << 16) | ((u32)y << 8) | cr;
	int stride = rm->fbWidth / 2;
	for (int j = y0; j < y0 + h && j < rm->xfbHeight; j++)
		for (int i = x0 / 2; i < (x0 + w) / 2 && i < stride; i++)
			fb[j * stride + i] = px;
}

static inline void mk_status(void *xfb, const GXRModeObj *rm, int status) {
	const u8 *c = mk_status_yuv[status & 3];
	mk_fill(xfb, rm, 576, 16, 48, 32, c[0], c[1], c[2]);
}

static inline void mk_row(void *xfb, const GXRModeObj *rm, int row, u32 value) {
	for (int i = 0; i < 32; i++) {
		int on = (value >> (31 - i)) & 1;
		mk_fill(xfb, rm, 32 + i * 18, 384 + row * 20, 14, 14, on ? 235 : 16, 128, 128);
	}
}

static inline u32 mk_fnv(u32 h, const void *data, u32 len) {
	const u8 *p = (const u8 *)data;
	for (u32 i = 0; i < len; i++) { h ^= p[i]; h *= 16777619u; }
	return h;
}
#define MK_FNV_INIT 2166136261u

#endif
