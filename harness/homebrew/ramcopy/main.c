/* Copyright 2026 wasm-dolphin contributors
 * SPDX-License-Identifier: MIT
 * ramcopy: EFB copies read back by the CPU from guest RAM, drawn back on
 * screen so the harness can compare backends on one picture
 * (docs/wgpu-efb-readback-design.md).
 *
 * Top half: four flat quads of known colours. For each, a 4x4 block from
 * its centre is copied to a texture in RAM (GX_CopyTex, RGB565), the CPU
 * invalidates its cache and reads the first texel back. Bottom half: one
 * square per quad in the colour read from RAM.
 *
 * Dolphin keeps EFB copies on the GPU by default (EFBToTextureEnable):
 * run with ?efbcopyram=1 so they reach RAM. Then every backend must show
 * the same picture; a backend whose readback returns zeros draws black.
 */
#include <gccore.h>
#include <malloc.h>
#include <string.h>

#define FIFO_SIZE (256 * 1024)

static const u32 quad_rgba[4] = {0xe04020ff, 0x20c060ff, 0x3050e0ff, 0xf0d040ff};

static void vtx(f32 x, f32 y, f32 z, u32 rgba) {
	GX_Position3f32(x, y, z);
	GX_Color1u32(rgba);
}

static void rect(f32 x0, f32 y0, f32 x1, f32 y1, u32 rgba) {
	GX_Begin(GX_QUADS, GX_VTXFMT0, 4);
	vtx(x0, y0, -1, rgba); vtx(x1, y0, -1, rgba);
	vtx(x1, y1, -1, rgba); vtx(x0, y1, -1, rgba);
	GX_End();
}

/* RGB565 (big-endian, as the GameCube stores it) to RGBA8. */
static u32 rgba_of_565(u16 c) {
	u32 r = (c >> 11) & 0x1f, g = (c >> 5) & 0x3f, b = c & 0x1f;
	r = (r << 3) | (r >> 2); g = (g << 2) | (g >> 4); b = (b << 3) | (b >> 2);
	return (r << 24) | (g << 16) | (b << 8) | 0xff;
}

int main(void) {
	VIDEO_Init();
	GXRModeObj *rmode = VIDEO_GetPreferredMode(NULL);
	void *xfb[2];
	xfb[0] = MEM_K0_TO_K1(SYS_AllocateFramebuffer(rmode));
	xfb[1] = MEM_K0_TO_K1(SYS_AllocateFramebuffer(rmode));
	VIDEO_Configure(rmode);
	VIDEO_SetNextFramebuffer(xfb[0]);
	VIDEO_SetBlack(FALSE);
	VIDEO_Flush();
	VIDEO_WaitVSync();
	if (rmode->viTVMode & VI_NON_INTERLACE) VIDEO_WaitVSync();

	void *fifo = memalign(32, FIFO_SIZE);
	memset(fifo, 0, FIFO_SIZE);
	GX_Init(fifo, FIFO_SIZE);
	GXColor bg = {0x10, 0x10, 0x10, 0xff};
	GX_SetCopyClear(bg, 0x00ffffff);
	GX_SetViewport(0, 0, rmode->fbWidth, rmode->efbHeight, 0, 1);
	f32 yscale = GX_GetYScaleFactor(rmode->efbHeight, rmode->xfbHeight);
	u32 xfb_height = GX_SetDispCopyYScale(yscale);
	GX_SetScissor(0, 0, rmode->fbWidth, rmode->efbHeight);
	GX_SetDispCopySrc(0, 0, rmode->fbWidth, rmode->efbHeight);
	GX_SetDispCopyDst(rmode->fbWidth, xfb_height);
	GX_SetCopyFilter(rmode->aa, rmode->sample_pattern, GX_TRUE, rmode->vfilter);
	GX_SetFieldMode(rmode->field_rendering, (rmode->viHeight == 2 * rmode->xfbHeight) ? GX_ENABLE : GX_DISABLE);
	GX_SetPixelFmt(GX_PF_RGB8_Z24, GX_ZC_LINEAR);
	GX_SetCullMode(GX_CULL_NONE);
	GX_SetDispCopyGamma(GX_GM_1_0);

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
	GX_SetAlphaUpdate(GX_TRUE);
	GX_SetColorUpdate(GX_TRUE);

	Mtx44 ortho;
	guOrtho(ortho, 0, rmode->efbHeight - 1, 0, rmode->fbWidth - 1, 0, 300);
	Mtx id;
	guMtxIdentity(id);

	/* One 4x4 RGB565 tile per quad: 32 bytes, texel (0,0) first. */
	u16 *copies = memalign(32, 4 * 32);
	int fb = 0;
	while (1) {
		GX_LoadProjectionMtx(ortho, GX_ORTHOGRAPHIC);
		GX_LoadPosMtxImm(id, GX_PNMTX0);
		for (int i = 0; i < 4; i++)
			rect(40 + i * 150, 40, 160 + i * 150, 160, quad_rgba[i]);
		memset(copies, 0, 4 * 32);
		DCFlushRange(copies, 4 * 32);
		for (int i = 0; i < 4; i++) {
			GX_SetTexCopySrc(98 + i * 150, 98, 4, 4);
			GX_SetTexCopyDst(4, 4, GX_TF_RGB565, GX_FALSE);
			GX_CopyTex((u8 *)copies + i * 32, GX_FALSE);
		}
		GX_PixModeSync();
		GX_DrawDone();
		DCInvalidateRange(copies, 4 * 32);
		for (int i = 0; i < 4; i++)
			rect(40 + i * 150, 220, 160 + i * 150, 300, rgba_of_565(copies[i * 16]));
		GX_DrawDone();
		GX_CopyDisp(xfb[fb], GX_TRUE);
		GX_Flush();
		VIDEO_SetNextFramebuffer(xfb[fb]);
		VIDEO_Flush();
		VIDEO_WaitVSync();
		fb ^= 1;
	}
	return 0;
}
