/* Copyright 2026 wasm-dolphin contributors
 * SPDX-License-Identifier: GPL-2.0-or-later
 *
 * efbpoke: CPU writes and reads of the EFB (GX_PokeARGB / GX_PeekARGB),
 * which gxtest uses to fill the EFB before an EFB copy. Needs EFB access
 * (EFBAccessEnable). The EFB is cleared to a known colour by a copy, then:
 *   1 peek of a cleared pixel reads the clear colour
 *   2 poke then peek of that pixel reads the poked colour
 *   3 an EFB copy to RAM (RGBA8) holds the poked colour at that pixel
 *   4 a quad drawn over it, peeked, reads the quad's colour
 * Detail of a failed check: the colour read, 0xRRGGBBAA. RGBA6: a peek
 * expands each 6-bit channel to 8 bits by repeating its top bits (0x40 reads
 * 0x41). Dither off.
 */
#include <gccore.h>
#include <malloc.h>
#include <string.h>
#include "report.h"

#define FIFO_SIZE (256 * 1024)

static u32 packed(GXColor c) { return ((u32)c.r << 24) | ((u32)c.g << 16) | ((u32)c.b << 8) | c.a; }

int main(void) {
  rp_init();
  void *fifo = memalign(32, FIFO_SIZE);
  memset(fifo, 0, FIFO_SIZE);
  GX_Init(fifo, FIFO_SIZE);
  GX_SetPixelFmt(GX_PF_RGBA6_Z24, GX_ZC_LINEAR);
  GX_SetViewport(0, 0, 640, 480, 0, 1);
  GX_SetScissor(0, 0, 640, 480);
  GX_SetAlphaUpdate(GX_TRUE);
  GX_SetColorUpdate(GX_TRUE);
  GX_PokeAlphaUpdate(GX_TRUE);
  GX_PokeColorUpdate(GX_TRUE);
  GX_PokeBlendMode(GX_BM_NONE, GX_BL_ZERO, GX_BL_ZERO, GX_LO_SET);
  GX_PokeZMode(GX_FALSE, GX_ALWAYS, GX_FALSE);
  GX_PokeAlphaRead(GX_READ_NONE);
  GX_PokeDither(GX_FALSE);

  /* Clear the EFB with a texture copy that clears (RGBA6: 6 bits a channel). */
  GXColor clear = {0x40, 0x80, 0xc0, 0xfc};
  GX_SetCopyClear(clear, 0x00ffffff);
  u8 *buf = memalign(32, 8 * 8 * 4);
  GX_SetTexCopySrc(0, 0, 8, 8);
  GX_SetTexCopyDst(8, 8, GX_TF_RGBA8, GX_FALSE);
  GX_CopyTex(buf, GX_TRUE);
  GX_DrawDone();

  rp_start_test();
  GXColor c;
  GX_PeekARGB(5, 5, &c);
  RP_CHECK(c.r == 0x41 && c.g == 0x82 && c.b == 0xc3, packed(c));
  rp_end_test();

  rp_start_test();
  GXColor poke = {0xa0, 0x20, 0x60, 0xfc};
  GX_PokeARGB(5, 5, poke);
  GX_PeekARGB(5, 5, &c);
  RP_CHECK(c.r == 0xa2 && c.g == 0x20 && c.b == 0x61, packed(c));
  rp_end_test();

  rp_start_test();
  memset(buf, 0, 8 * 8 * 4);
  DCFlushRange(buf, 8 * 8 * 4);
  GX_CopyTex(buf, GX_FALSE);
  GX_DrawDone();
  DCInvalidateRange(buf, 8 * 8 * 4);
  /* RGBA8 tiles of 4x4: AR block, then GB block. Pixel (5,5) = tile (1,1), index 5. */
  u32 base = (1 * 2 + 1) * 64, off = 5 * 2;
  GXColor m = {buf[base + off + 1], buf[base + 32 + off], buf[base + 32 + off + 1], buf[base + off]};
  RP_CHECK(m.r == 0xa2 && m.g == 0x20 && m.b == 0x61, packed(m));
  rp_end_test();

  rp_start_test();
  GX_ClearVtxDesc();
  GX_SetVtxDesc(GX_VA_POS, GX_DIRECT);
  GX_SetVtxDesc(GX_VA_CLR0, GX_DIRECT);
  GX_SetVtxAttrFmt(GX_VTXFMT0, GX_VA_POS, GX_POS_XYZ, GX_F32, 0);
  GX_SetVtxAttrFmt(GX_VTXFMT0, GX_VA_CLR0, GX_CLR_RGBA, GX_RGBA8, 0);
  GX_SetNumChans(1);
  GX_SetChanCtrl(GX_COLOR0A0, GX_DISABLE, GX_SRC_REG, GX_SRC_VTX, GX_LIGHTNULL, GX_DF_NONE, GX_AF_NONE);
  GX_SetNumTexGens(0);
  GX_SetNumTevStages(1);
  GX_SetTevOrder(GX_TEVSTAGE0, GX_TEXCOORDNULL, GX_TEXMAP_NULL, GX_COLOR0A0);
  GX_SetTevOp(GX_TEVSTAGE0, GX_PASSCLR);
  GX_SetBlendMode(GX_BM_NONE, GX_BL_ONE, GX_BL_ZERO, GX_LO_CLEAR);
  GX_SetZMode(GX_FALSE, GX_ALWAYS, GX_FALSE);
  GX_SetCullMode(GX_CULL_NONE);
  GX_SetDither(GX_FALSE);
  Mtx44 ortho;
  guOrtho(ortho, 0, 479, 0, 639, 0, 300);
  GX_LoadProjectionMtx(ortho, GX_ORTHOGRAPHIC);
  Mtx id;
  guMtxIdentity(id);
  GX_LoadPosMtxImm(id, GX_PNMTX0);
  GX_SetCurrentMtx(GX_PNMTX0);
  GX_Begin(GX_QUADS, GX_VTXFMT0, 4);
  GX_Position3f32(0, 0, -1); GX_Color1u32(0x2040e0fc);
  GX_Position3f32(16, 0, -1); GX_Color1u32(0x2040e0fc);
  GX_Position3f32(16, 16, -1); GX_Color1u32(0x2040e0fc);
  GX_Position3f32(0, 16, -1); GX_Color1u32(0x2040e0fc);
  GX_End();
  GX_DrawDone();
  GX_PeekARGB(5, 5, &c);
  RP_CHECK(c.r == 0x20 && c.g == 0x41 && c.b == 0xe3, packed(c));
  rp_end_test();

  rp_done();
  return 0;
}
