# License of the ported hwtests

The files in this directory are ports of
[dolphin-emu/hwtests](https://github.com/dolphin-emu/hwtests) at commit
`f28077b139eec18967f60db6ce1e15b182dfeac0`, Copyright 2013 Dolphin Emulator
Project, licensed under the GNU General Public License version 2 (the
`license.txt` of that repository; the same text as this repository's
`LICENSE`). The expected values were measured on hardware by the Dolphin
project. Changes: the C++/libogc test bodies were rewritten as PowerPC
programs for the core's JIT oracle; sampled loops are noted in each file.
