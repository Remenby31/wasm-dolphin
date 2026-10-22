/* Copyright 2026 wasm-dolphin contributors
 * SPDX-License-Identifier: MIT
 * efbpeek: CPU reads of the EFB (GX_PeekARGB / GX_PeekZ), drawn back on
 * screen so the harness can compare backends on one picture
 * (docs/wgpu-efb-readback-design.md).
 *
 * Top half: four flat quads, known colours at known depths. Bottom half: one
 * square per quad, filled with the colour the CPU read back from the centre
 * of that quad, then a grey square per quad whose level is the depth read
 * back (top 8 bits of 24), then the colours read the frame before: the
 * picture only stays still when the reads are stable from frame to frame.
 *
 * Peeks need EFB access, off by default in Dolphin (EFBAccessEnable): run
 * with ?efbaccess=1. Then every backend must show the same picture; a backend
 * whose readback returns zeros shows black squares.
 */
#include <gccore.h>
#include <malloc.h>
#include <string.h>

#define FIFO_SIZE (256 * 1024)

static const u32 quad_rgba[4] = {0xe04020ff, 0x20c060ff, 0x3050e0ff, 0xf0d040ff};
static const f32 quad_z[4] = {-10.0f, -60.0f, -120.0f, -200.0f};

static void vtx(f32 x, f32 y, f32 z, u32 rgba) {
	GX_Position3f32(x, y, z);
	GX_Color1u32(rgba);
}

static void rect(f32 x0, f32 y0, f32 x1, f32 y1, f32 z, u32 rgba) {
	GX_Begin(GX_QUADS, GX_VTXFMT0, 4);
	vtx(x0, y0, z, rgba); vtx(x1, y0, z, rgba);
	vtx(x1, y1, z, rgba); vtx(x0, y1, z, rgba);
	GX_End();
}

static u32 rgba_of(GXColor c) {
	return ((u32)c.r << 24) | ((u32)c.g << 16) | ((u32)c.b << 8) | 0xff;
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
	GX_SetAlphaUpdate(GX_TRUE);
	GX_SetColorUpdate(GX_TRUE);
	GX_PokeAlphaRead(GX_READ_FF);

	Mtx44 ortho;
	guOrtho(ortho, 0, rmode->efbHeight - 1, 0, rmode->fbWidth - 1, 0, 300);
	Mtx id;
	guMtxIdentity(id);

	GXColor seen_now[4], seen_prev[4];
	u32 depth_now[4];
	memset(seen_prev, 0, sizeof(seen_prev));
	int fb = 0;
	while (1) {
		GX_LoadProjectionMtx(ortho, GX_ORTHOGRAPHIC);
		GX_LoadPosMtxImm(id, GX_PNMTX0);
		GX_SetZMode(GX_TRUE, GX_LEQUAL, GX_TRUE);
		for (int i = 0; i < 4; i++)
			rect(40 + i * 150, 40, 160 + i * 150, 160, quad_z[i], quad_rgba[i]);
		GX_DrawDone();
		/* Read back now: the quads are in the EFB. */
		for (int i = 0; i < 4; i++) {
			GX_PeekARGB(100 + i * 150, 100, &seen_now[i]);
			GX_PeekZ(100 + i * 150, 100, &depth_now[i]);
		}
		GX_SetZMode(GX_FALSE, GX_ALWAYS, GX_FALSE);
		for (int i = 0; i < 4; i++) {
			u32 level = (depth_now[i] >> 16) & 0xff;
			rect(40 + i * 150, 200, 160 + i * 150, 260, -1, rgba_of(seen_now[i]));
			rect(40 + i * 150, 280, 160 + i * 150, 340, -1, (level << 24) | (level << 16) | (level << 8) | 0xff);
			rect(40 + i * 150, 360, 160 + i * 150, 420, -1, rgba_of(seen_prev[i]));
		}
		GX_DrawDone();
		memcpy(seen_prev, seen_now, sizeof(seen_prev));
		GX_SetZMode(GX_TRUE, GX_LEQUAL, GX_TRUE);
		GX_CopyDisp(xfb[fb], GX_TRUE);
		GX_Flush();
		VIDEO_SetNextFramebuffer(xfb[fb]);
		VIDEO_Flush();
		VIDEO_WaitVSync();
		fb ^= 1;
	}
	return 0;
}
