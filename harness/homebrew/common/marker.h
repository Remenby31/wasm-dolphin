/* Copyright 2026 wasm-dolphin contributors
 * SPDX-License-Identifier: MIT
 * Data rows painted straight into the XFB, read back by the QA harness from
 * an exact capture of the XFB at a known VI output (harness/lib/markers.mjs;
 * keep both sides in sync). No scaling, no colour guessing:
 *
 *   row r (0..MK_ROWS-1): y 384+r*16 .. +11
 *   bit i (0..31, MSB first): x 32+i*18 .. +13, white = 1, black = 0
 *   row MK_ROWS: FNV-1a of the MK_ROWS values (big-endian bytes)
 *
 * A capture whose checksum row does not match is unreadable, never guessed.
 */
#ifndef HARNESS_MARKER_H
#define HARNESS_MARKER_H

#include <gccore.h>

#define MK_ROWS 4

static inline void mk_fill(void *xfb, const GXRModeObj *rm, int x0, int y0, int w, int h, u8 y) {
	u32 *fb = (u32 *)xfb;
	u32 px = ((u32)y << 24) | (128u << 16) | ((u32)y << 8) | 128u;
	int stride = rm->fbWidth / 2;
	for (int j = y0; j < y0 + h && j < rm->xfbHeight; j++)
		for (int i = x0 / 2; i < (x0 + w) / 2 && i < stride; i++)
			fb[j * stride + i] = px;
}

static inline u32 mk_fnv(u32 h, const void *data, u32 len) {
	const u8 *p = (const u8 *)data;
	for (u32 i = 0; i < len; i++) { h ^= p[i]; h *= 16777619u; }
	return h;
}
#define MK_FNV_INIT 2166136261u

static inline void mk_row(void *xfb, const GXRModeObj *rm, int row, u32 value) {
	for (int i = 0; i < 32; i++)
		mk_fill(xfb, rm, 32 + i * 18, 384 + row * 16, 14, 12, ((value >> (31 - i)) & 1) ? 235 : 16);
}

/* Paint MK_ROWS values and their checksum row. */
static inline void mk_rows(void *xfb, const GXRModeObj *rm, const u32 values[MK_ROWS]) {
	for (int r = 0; r < MK_ROWS; r++) mk_row(xfb, rm, r, values[r]);
	mk_row(xfb, rm, MK_ROWS, mk_fnv(MK_FNV_INIT, values, MK_ROWS * 4));
}

#endif
