/* Copyright 2026 wasm-dolphin contributors
 * SPDX-License-Identifier: MIT
 * dstalpha: source-alpha blending while the destination alpha is a constant
 * (GX_SetDstAlpha), the case that needs dual-source blending on a host GPU.
 * A device without it (Safari's WebGPU) makes Dolphin take its no_dual_src
 * path; the harness compares that picture with the software renderer.
 *
 * EFB RGBA6_Z24. Each frame:
 *  1. four opaque background columns;
 *  2. over them, four rows of translucent quads blended with their own
 *     (TEV) alpha 0x30 / 0x80 / 0xc0 / 0xff, writing the constant
 *     destination alpha 0x40 (rows 0-1) or 0xc0 (rows 2-3);
 *  3. a white band over rows 1-2 blended with the destination alpha
 *     (GX_BL_DSTALPHA), so the alpha step 2 wrote shows as brightness.
 * A backend that blends step 2 with the constant instead of the TEV alpha,
 * or writes the TEV alpha instead of the constant, shows another picture.
 */
#include <gccore.h>
#include <malloc.h>
#include <string.h>

#define FIFO_SIZE (256 * 1024)

static const u32 column_rgba[4] = {0xc03020ff, 0x20a040ff, 0x2040c0ff, 0xe0c020ff};
static const u8 quad_alpha[4] = {0x30, 0x80, 0xc0, 0xff};

static void vtx(f32 x, f32 y, u32 rgba) {
	GX_Position3f32(x, y, -1.0f);
	GX_Color1u32(rgba);
}

static void rect(f32 x0, f32 y0, f32 x1, f32 y1, u32 rgba) {
	GX_Begin(GX_QUADS, GX_VTXFMT0, 4);
	vtx(x0, y0, rgba); vtx(x1, y0, rgba);
	vtx(x1, y1, rgba); vtx(x0, y1, rgba);
	GX_End();
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
	GXColor bg = {0x10, 0x10, 0x10, 0x00};
	GX_SetCopyClear(bg, 0x00ffffff);
	GX_SetViewport(0, 0, rmode->fbWidth, rmode->efbHeight, 0, 1);
	f32 yscale = GX_GetYScaleFactor(rmode->efbHeight, rmode->xfbHeight);
	u32 xfb_height = GX_SetDispCopyYScale(yscale);
	GX_SetScissor(0, 0, rmode->fbWidth, rmode->efbHeight);
	GX_SetDispCopySrc(0, 0, rmode->fbWidth, rmode->efbHeight);
	GX_SetDispCopyDst(rmode->fbWidth, xfb_height);
	GX_SetCopyFilter(rmode->aa, rmode->sample_pattern, GX_TRUE, rmode->vfilter);
	GX_SetFieldMode(rmode->field_rendering, (rmode->viHeight == 2 * rmode->xfbHeight) ? GX_ENABLE : GX_DISABLE);
	GX_SetPixelFmt(GX_PF_RGBA6_Z24, GX_ZC_LINEAR);
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
	GX_SetZMode(GX_FALSE, GX_ALWAYS, GX_FALSE);
	GX_SetColorUpdate(GX_TRUE);
	GX_SetAlphaUpdate(GX_TRUE);

	Mtx44 ortho;
	guOrtho(ortho, 0, rmode->efbHeight - 1, 0, rmode->fbWidth - 1, 0, 300);
	Mtx id;
	guMtxIdentity(id);

	int fb = 0;
	while (1) {
		GX_LoadProjectionMtx(ortho, GX_ORTHOGRAPHIC);
		GX_LoadPosMtxImm(id, GX_PNMTX0);

		/* 1. Opaque columns, destination alpha 0. */
		GX_SetDstAlpha(GX_ENABLE, 0x00);
		GX_SetBlendMode(GX_BM_NONE, GX_BL_ONE, GX_BL_ZERO, GX_LO_CLEAR);
		for (int c = 0; c < 4; c++)
			rect(40 + c * 150, 30, 170 + c * 150, 450, column_rgba[c]);

		/* 2. Translucent rows: blended with the TEV alpha, destination alpha
		 * written as a constant. */
		GX_SetBlendMode(GX_BM_BLEND, GX_BL_SRCALPHA, GX_BL_INVSRCALPHA, GX_LO_CLEAR);
		for (int r = 0; r < 4; r++) {
			GX_SetDstAlpha(GX_ENABLE, r < 2 ? 0x40 : 0xc0);
			for (int c = 0; c < 4; c++)
				rect(50 + c * 150, 50 + r * 100, 160 + c * 150, 120 + r * 100,
				     0xf0f0f000u | quad_alpha[(r + c) & 3]);
		}

		/* 3. White band blended with the destination alpha. */
		GX_SetDstAlpha(GX_DISABLE, 0x00);
		GX_SetBlendMode(GX_BM_BLEND, GX_BL_DSTALPHA, GX_BL_INVDSTALPHA, GX_LO_CLEAR);
		rect(30, 130, 620, 340, 0xffffffffu);

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
