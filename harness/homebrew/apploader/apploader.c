/* Copyright 2026 wasm-dolphin contributors
 * SPDX-License-Identifier: MIT
 * Minimal GameCube apploader. BS2 (or Dolphin's HLE BS2) calls _start, then
 * main_ repeatedly to learn which disc ranges to copy where, then close_ for
 * the entry point. The section table is patched in by mkgcm.mjs: it looks
 * for TABLE_MAGIC and overwrites count, entry and the entries in place.
 */
typedef unsigned int u32;
struct sec { u32 ram, len, off; };
struct table { u32 magic, count, entry; struct sec secs[32]; };

#define TABLE_MAGIC 0x48425442u /* "HBTB" */
static volatile struct table tbl = { TABLE_MAGIC, 0, 0, {{0, 0, 0}} };
static volatile u32 idx = 0;

static void init(void (*report)(const char *, ...)) { (void)report; }
static int main_(u32 *dst, u32 *len, u32 *off) {
	if (idx >= tbl.count) return 0;
	*dst = tbl.secs[idx].ram; *len = tbl.secs[idx].len; *off = tbl.secs[idx].off;
	idx++;
	return 1;
}
static u32 close_(void) { return tbl.entry; }

__attribute__((section(".text.start")))
void _start(void **pinit, void **pmain, void **pclose) {
	*pinit = (void *)init; *pmain = (void *)main_; *pclose = (void *)close_;
}
