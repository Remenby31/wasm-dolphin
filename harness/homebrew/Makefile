# SPDX-License-Identifier: MIT
# Builds the harness homebrews inside devkitpro/devkitppc (see build.sh).
# Plain rules on purpose: no devkitPro template, so every input is ours.
DEVKITPRO ?= /opt/devkitpro
DEVKITPPC ?= $(DEVKITPRO)/devkitPPC
LIBOGC    ?= $(DEVKITPRO)/libogc
CC        := $(DEVKITPPC)/bin/powerpc-eabi-gcc
OBJCOPY   := $(DEVKITPPC)/bin/powerpc-eabi-objcopy
ELF2DOL   := $(DEVKITPRO)/tools/bin/elf2dol
OUT       ?= out
MACHDEP   := -DGEKKO -mogc -mcpu=750 -meabi -mhard-float
CFLAGS    := -O2 -Wall -Werror $(MACHDEP) -I$(LIBOGC)/include -Icommon \
             -ffile-prefix-map=$(CURDIR)=. -fno-ident
LDFLAGS   := $(MACHDEP) -L$(LIBOGC)/lib/cube -Wl,--build-id=none
PROGRAMS  := padtest consoletest gxscene cpufuzz cpufuzz-nomcrf tonetest smctest efbpeek
# Selftest mutants (harness/selftest): built from the same sources.
MUTANTS   := gxscene-nocubes gxscene-color

all: $(PROGRAMS:%=$(OUT)/%.dol) $(MUTANTS:%=$(OUT)/%.dol) $(OUT)/apploader.bin

$(OUT)/%.elf: %/main.c common/marker.h | $(OUT)
	$(CC) $(CFLAGS) $< -o $@ $(LDFLAGS) -logc -lm

# Same fuzzer without mcrf, which currently crashes the WASM JIT; lets the
# fuzz keep going past that known crash.
$(OUT)/cpufuzz-nomcrf.elf: cpufuzz/main.c common/marker.h | $(OUT)
	$(CC) $(CFLAGS) -DCPUFUZZ_NO_MCRF $< -o $@ $(LDFLAGS) -logc -lm

$(OUT)/gxscene-nocubes.elf: gxscene/main.c | $(OUT)
	$(CC) $(CFLAGS) -DMUTATE_NO_CUBES $< -o $@ $(LDFLAGS) -logc -lm

$(OUT)/gxscene-color.elf: gxscene/main.c | $(OUT)
	$(CC) $(CFLAGS) -DMUTATE_COLOR $< -o $@ $(LDFLAGS) -logc -lm

$(OUT)/%.dol: $(OUT)/%.elf
	$(ELF2DOL) $< $@

$(OUT)/apploader.bin: apploader/apploader.c apploader/link.ld | $(OUT)
	$(CC) -O2 -ffreestanding -nostdlib -mno-sdata -fno-pic -fno-ident -Wl,--build-id=none \
	  -T apploader/link.ld $< -o $(OUT)/apploader.elf
	$(OBJCOPY) -O binary $(OUT)/apploader.elf $@

$(OUT):
	mkdir -p $@

clean:
	rm -rf $(OUT)

.PHONY: all clean
# Keep the .elf files: symbols are needed to map a crashing PC back to source.
.SECONDARY:
