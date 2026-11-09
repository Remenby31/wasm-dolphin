/* Copyright 2026 wasm-dolphin contributors
 * SPDX-License-Identifier: GPL-2.0-or-later
 *
 * battest: block address translation reprogrammed at run time, outside the
 * 0x8/0xC mirrors of MEM1 the JIT's fast paths are built around. Expected
 * values are architectural (PowerPC 750 BAT rules), checked by the program
 * itself every frame for FRAMES frames, so the same code runs first on the
 * interpreter and then as JIT blocks. Results: compat/homebrew/report.h.
 *
 * Three 128 KiB blocks A, B, CODE are taken from the heap (128 KiB aligned).
 *   1 data:  DBAT3 maps EA 0x50000000 to A; words written through A's 0x8
 *            mirror read back through the BAT, and the other way round
 *            (through the uncached 0xC mirror).
 *   2 remap: DBAT3 moved to B; the same EA now reads B, then A again.
 *   3 code:  IBAT3 maps EA 0x50000000 to CODE; a function written there
 *            through the 0x8 mirror is called through the BAT address, then
 *            rewritten (dcbst + icbi on the mirror: the 750's caches are
 *            physically tagged) and called again: it returns the new value.
 */
#include <gccore.h>
#include <malloc.h>
#include <string.h>
#include "report.h"

#define FRAMES 600
#define EA 0x50000000u
static u32 PHYS_A, PHYS_B, PHYS_CODE;

/* 128 KiB block, supervisor valid; read/write, cached (WIMG 0). */
#define BATU(ea) (((ea) & 0xfffe0000u) | 0x2u)
#define BATL(pa) (((pa) & 0xfffe0000u) | 0x2u)

static void set_dbat3(u32 u, u32 l) {
  asm volatile("mtspr 542, %0; mtspr 543, %1; isync" :: "r"(0), "r"(l));
  asm volatile("mtspr 542, %0; isync" :: "r"(u));
}
static void set_ibat3(u32 u, u32 l) {
  asm volatile("mtspr 534, %0; mtspr 535, %1; isync" :: "r"(0), "r"(l));
  asm volatile("mtspr 534, %0; isync" :: "r"(u));
}

static void fill(u32 phys, u32 seed) {
  volatile u32 *p = (volatile u32 *)(0x80000000u | phys);
  for (int i = 0; i < 64; i++) p[i] = seed ^ (u32)(i * 0x9e3779b9u);
  DCFlushRange((void *)(0x80000000u | phys), 256);
}

static u32 diff_words(u32 seed) {
  volatile u32 *v = (volatile u32 *)EA;
  u32 bad = 0;
  for (int i = 0; i < 64; i++) bad += v[i] != (seed ^ (u32)(i * 0x9e3779b9u));
  return bad;
}

/* li r3, imm; blr */
static void write_code(u32 imm) {
  u32 *p = (u32 *)(0x80000000u | PHYS_CODE);
  p[0] = 0x38600000u | (imm & 0xffff);
  p[1] = 0x4e800020u;
  DCFlushRange(p, 32);
  ICInvalidateRange(p, 32);
}

int main(void) {
  rp_init();
  u8 *blocks = memalign(0x20000, 3 * 0x20000);
  PHYS_A = MEM_VIRTUAL_TO_PHYSICAL(blocks);
  PHYS_B = PHYS_A + 0x20000;
  PHYS_CODE = PHYS_A + 0x40000;
  for (int frame = 0; frame < FRAMES; frame++) {
    /* 1 data */
    rp_start_test();
    set_dbat3(BATU(EA), BATL(PHYS_A));
    fill(PHYS_A, 0xa5a50000u + (u32)frame);
    RP_CHECK(diff_words(0xa5a50000u + (u32)frame) == 0, frame);
    volatile u32 *v = (volatile u32 *)EA;
    v[1] = 0x12345678u ^ (u32)frame;
    asm volatile("dcbst 0, %0; sync" :: "r"(EA));
    RP_CHECK(*(volatile u32 *)(0xc0000000u | (PHYS_A + 4)) == (0x12345678u ^ (u32)frame), frame);
    rp_end_test();

    /* 2 remap */
    rp_start_test();
    fill(PHYS_B, 0x5a5a0000u + (u32)frame);
    set_dbat3(BATU(EA), BATL(PHYS_B));
    RP_CHECK(diff_words(0x5a5a0000u + (u32)frame) == 0, frame);
    set_dbat3(BATU(EA), BATL(PHYS_A));
    RP_CHECK(v[1] == (0x12345678u ^ (u32)frame), frame);
    rp_end_test();

    /* 3 code */
    rp_start_test();
    set_ibat3(BATU(EA), BATL(PHYS_CODE));
    u32 (*fn)(void) = (u32 (*)(void))EA;
    write_code(0x1234);
    RP_CHECK(fn() == 0x1234, frame);
    write_code(0x5678);
    RP_CHECK(fn() == 0x5678, frame);
    rp_end_test();

    /* Totals accumulate over frames: one "test" per kind per frame. */
    VIDEO_WaitVSync();
  }
  set_dbat3(0, 0);
  set_ibat3(0, 0);
  rp_done();
  return 0;
}
