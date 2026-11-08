// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: GPL-2.0-or-later
// cputest/fprf.cpp again, with Config::MAIN_FPRF at the core's default (off):
// what a game gets unless something turns FPRF on.
import { makeCases } from "./fprf.mjs";

export const source = "cputest/fprf.cpp";
export const cases = () => makeCases("fprf@default", { fprf: false });
