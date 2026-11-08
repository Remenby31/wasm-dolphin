/* Copyright 2026 wasm-dolphin contributors
 * SPDX-License-Identifier: GPL-2.0-or-later
 *
 * cardtest: the memory card in slot A through libogc's CARD API, as a game
 * saves: mount, create a 2-block file, write it, read it back, check its
 * status, delete it, and the file is gone. Two rounds, the second after an
 * unmount and a new mount. The card must start empty of this file or not:
 * any leftover is deleted first. Results: compat/homebrew/report.h (the
 * detail of a failed call is its return code).
 */
#include <gccore.h>
#include <malloc.h>
#include <string.h>
#include "report.h"

#define NAME "compat-cardtest"

static u8 workarea[CARD_WORKAREA_SIZE] ATTRIBUTE_ALIGN(32);

static s32 mount(void) {
  s32 r = CARD_ERROR_BUSY;
  for (int i = 0; i < 200; i++) {
    r = CARD_Mount(CARD_SLOTA, workarea, NULL);
    if (r != CARD_ERROR_BUSY && r != CARD_ERROR_NOCARD && r != CARD_ERROR_IOERROR) break;
    VIDEO_WaitVSync();
  }
  return r;
}

static void round_trip(u32 seed) {
  rp_start_test();
  s32 r = mount();
  RP_CHECK(r == CARD_ERROR_READY, r);
  if (r != CARD_ERROR_READY) { rp_end_test(); return; }
  u32 sector = 0;
  r = CARD_GetSectorSize(CARD_SLOTA, &sector);
  RP_CHECK(r == CARD_ERROR_READY && sector == 8192, r == CARD_ERROR_READY ? (s32)sector : r);
  CARD_Delete(CARD_SLOTA, NAME);

  const u32 len = 2 * 8192;
  u32 *out = memalign(32, len), *in = memalign(32, len);
  for (u32 i = 0; i < len / 4; i++) out[i] = seed ^ (i * 0x9e3779b9u);
  memset(in, 0, len);
  card_file file;
  r = CARD_Create(CARD_SLOTA, NAME, len, &file);
  RP_CHECK(r == CARD_ERROR_READY, r);
  r = CARD_Write(&file, out, len, 0);
  RP_CHECK(r == CARD_ERROR_READY, r);
  CARD_Close(&file);

  r = CARD_Open(CARD_SLOTA, NAME, &file);
  RP_CHECK(r == CARD_ERROR_READY, r);
  r = CARD_Read(&file, in, len, 0);
  RP_CHECK(r == CARD_ERROR_READY, r);
  RP_CHECK(memcmp(in, out, len) == 0, in[0]);
  card_stat st;
  r = CARD_GetStatus(CARD_SLOTA, file.filenum, &st);
  RP_CHECK(r == CARD_ERROR_READY && st.len == len, r == CARD_ERROR_READY ? (s32)st.len : r);
  CARD_Close(&file);

  r = CARD_Delete(CARD_SLOTA, NAME);
  RP_CHECK(r == CARD_ERROR_READY, r);
  r = CARD_Open(CARD_SLOTA, NAME, &file);
  RP_CHECK(r == CARD_ERROR_NOFILE, r);
  r = CARD_Unmount(CARD_SLOTA);
  RP_CHECK(r == CARD_ERROR_READY, r);
  free(out);
  free(in);
  rp_end_test();
}

int main(void) {
  rp_init();
  /* The disc's game and maker codes, as a game passes its own. */
  char game[5] = {0}, maker[3] = {0};
  memcpy(game, (const void *)0x80000000, 4);
  memcpy(maker, (const void *)0x80000004, 2);
  CARD_Init(game, maker);
  round_trip(0xc0ffee00u);
  round_trip(0x5eed0001u);
  rp_done();
  return 0;
}
