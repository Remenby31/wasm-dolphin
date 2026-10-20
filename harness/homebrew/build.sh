#!/bin/sh
# SPDX-License-Identifier: MIT
# Rebuild the harness homebrews from source and wrap each .dol in a GCM disc
# image. Needs Docker and Node only. Output: harness/homebrew/out/{*.dol,*.iso,SHA256SUMS}
set -eu
here=$(cd "$(dirname "$0")" && pwd)
# Pinned toolchain (devkitPPC r48-ish, gcc 16.2.0, libogc 3.x). Update with care:
# the ISO hashes in SHA256SUMS change with it.
IMAGE=${DEVKITPPC_IMAGE:-devkitpro/devkitppc@sha256:d50f8a886f2ce1d3c22685a774afb0845379876b47d9b41a9b729f4f63a54813}
docker run --rm --label "gc-harness.root=$here" --platform linux/amd64 -v "$here:/w" -w /w "$IMAGE" \
  sh -c 'make -s OUT=out all &&
    for f in cpufuzz cpufuzz-nomcrf; do
      /opt/devkitpro/devkitPPC/bin/powerpc-eabi-nm out/$f.elf | awk '"'"'$3=="cpufuzz_code_pool"{printf "{\"cpufuzz_code_pool\":\"0x%s\",\"words_per_program\":128,\"programs\":384}\n",$1}'"'"' > out/$f.symbols.json; done &&
    chown -R '"$(id -u):$(id -g)"' out'
for p in padtest consoletest gxscene cpufuzz cpufuzz-nomcrf tonetest smctest gxscene-nocubes gxscene-color; do
  node "$here/mkgcm.mjs" --dol "$here/out/$p.dol" --apploader "$here/out/apploader.bin" \
    --out "$here/out/$p.iso" --id "$(printf 'HB%s' "$(echo "$p" | cut -c1-2 | tr a-z A-Z)")" --name "harness $p"
done
(cd "$here/out" && shasum -a 256 *.dol *.iso apploader.bin > SHA256SUMS && cat SHA256SUMS)
