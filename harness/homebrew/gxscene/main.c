/* Copyright 2026 wasm-dolphin contributors
 * SPDX-License-Identifier: MIT
 * gxscene: a static, depth-tested 3D scene (tiled floor + two intersecting
 * cubes) under a 2D orthographic overlay bar. Every frame is identical, so the
 * harness can compare backends (software vs wgpu) on the same picture and
 * detect "overlay drawn, 3D missing" automatically.
 */
#include <gccore.h>
#include <malloc.h>
#include <string.h>

#define FIFO_SIZE (256 * 1024)

static void vtx(f32 x, f32 y, f32 z, u32 rgba) {
	GX_Position3f32(x, y, z);
	GX_Color1u32(rgba);
}

static void cube(Mtx view, f32 tx, f32 ty, f32 tz, f32 rx, f32 ry, f32 s) {
	static const u32 face_rgba[6] = {0xe04040ff, 0x40c040ff, 0x4060e0ff, 0xe0c040ff, 0xc040c0ff, 0x40c0c0ff};
	static const s8 v[8][3] = {{-1,-1,-1},{1,-1,-1},{1,1,-1},{-1,1,-1},{-1,-1,1},{1,-1,1},{1,1,1},{-1,1,1}};
	static const u8 f[6][4] = {{0,1,2,3},{5,4,7,6},{4,0,3,7},{1,5,6,2},{3,2,6,7},{4,5,1,0}};
	Mtx rotx, roty, model, mv;
	guMtxRotDeg(rotx, 'x', rx);
	guMtxRotDeg(roty, 'y', ry);
	guMtxConcat(roty, rotx, model);
	guMtxScaleApply(model, model, s, s, s);
	guMtxTransApply(model, model, tx, ty, tz);
	guMtxConcat(view, model, mv);
	GX_LoadPosMtxImm(mv, GX_PNMTX0);
	GX_Begin(GX_QUADS, GX_VTXFMT0, 24);
	for (int i = 0; i < 6; i++)
		for (int k = 0; k < 4; k++) {
			const s8 *p = v[f[i][k]];
			vtx(p[0], p[1], p[2], face_rgba[i]);
		}
	GX_End();
}

static void floor_tiles(Mtx view) {
	GX_LoadPosMtxImm(view, GX_PNMTX0);
	GX_Begin(GX_QUADS, GX_VTXFMT0, 4 * 12 * 12);
	for (int i = 0; i < 12; i++)
		for (int j = 0; j < 12; j++) {
			f32 x = -12 + i * 2, z = -16 + j * 2;
			u32 c = ((i + j) & 1) ? 0xd8d8d8ff : 0x305830ff;
			vtx(x, 0, z, c);
			vtx(x + 2, 0, z, c);
			vtx(x + 2, 0, z + 2, c);
			vtx(x, 0, z + 2, c);
		}
	GX_End();
}

static void overlay(void) {
	Mtx id;
	guMtxIdentity(id);
	GX_LoadPosMtxImm(id, GX_PNMTX0);
	GX_Begin(GX_QUADS, GX_VTXFMT0, 8);
	vtx(40, 400, -1, 0xf0f0f0ff); vtx(300, 400, -1, 0xf0f0f0ff);
	vtx(300, 444, -1, 0xf0f0f0ff); vtx(40, 444, -1, 0xf0f0f0ff);
	vtx(46, 406, -1, 0xff8000ff); vtx(220, 406, -1, 0xff8000ff);
	vtx(220, 438, -1, 0xff8000ff); vtx(46, 438, -1, 0xff8000ff);
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
	GXColor bg = {0x10, 0x18, 0x40, 0xff};
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

	Mtx44 persp, ortho;
	guPerspective(persp, 60, (f32)rmode->fbWidth / rmode->efbHeight, 1.0f, 300.0f);
	guOrtho(ortho, 0, rmode->efbHeight - 1, 0, rmode->fbWidth - 1, 0, 300);
	Mtx view;
	guVector cam = {0.0f, 7.0f, 13.0f}, up = {0.0f, 1.0f, 0.0f}, look = {0.0f, 1.0f, -2.0f};
	guLookAt(view, &cam, &up, &look);

	int fb = 0;
	while (1) {
		GX_SetZMode(GX_TRUE, GX_LEQUAL, GX_TRUE);
		GX_LoadProjectionMtx(persp, GX_PERSPECTIVE);
		floor_tiles(view);
		cube(view, -1.5f, 2.0f, -2.0f, 25, 35, 2.0f);
		cube(view, 1.2f, 1.6f, -1.0f, -15, 60, 1.6f);
		GX_SetZMode(GX_FALSE, GX_ALWAYS, GX_FALSE);
		GX_LoadProjectionMtx(ortho, GX_ORTHOGRAPHIC);
		overlay();
		GX_DrawDone();
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
