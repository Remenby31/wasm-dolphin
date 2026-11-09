#!/bin/sh
# SPDX-License-Identifier: GPL-2.0-only
# Builds dolphin-emu/hwtests (cputest) for the GameCube from their sources
# at a pinned commit, with compat/homebrew/hwtests-report.cpp in place of
# the network reporter, and wraps each .dol in a GCM image.
#
#   sh compat/homebrew/build.sh <hwtests checkout> <out dir>
#
# Needs Docker and Node. The checkout must be at HWTESTS_COMMIT (checked).
# Toolchain: the devkitPPC image pinned by harness/homebrew/build.sh.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
hw=$(cd "$1" && pwd)
mkdir -p "$2"
out=$(cd "$2" && pwd)
HWTESTS_COMMIT=f28077b139eec18967f60db6ce1e15b182dfeac0
test "$(git -C "$hw" rev-parse HEAD)" = "$HWTESTS_COMMIT" || { echo "hwtests: expected commit $HWTESTS_COMMIT" >&2; exit 1; }
IMAGE=$(sed -n 's/^IMAGE=${DEVKITPPC_IMAGE:-\(.*\)}$/\1/p' "$root/harness/homebrew/build.sh")
test -n "$IMAGE"

# reciprocal and fctiw walk 2^32 inputs (hours): the Node port samples them.
CPU="cr fctiwz fprf frsp load mtspr nan ni pairedmove rlw srawix"
GX=""
OWN=""

docker run --rm --platform linux/amd64 -v "$root:/w" -v "$hw:/hw:ro" -v "$out:/out" -w /w "$IMAGE" sh -c '
  set -eu
  P=/opt/devkitpro
  CXX=$P/devkitPPC/bin/powerpc-eabi-g++
  MACHDEP="-DGEKKO -mogc -mcpu=750 -meabi -mhard-float"
  FLAGS="-std=c++17 -O2 -Wall -Wno-unused-function $MACHDEP -DFMT_HEADER_ONLY -fno-ident -ffile-prefix-map=/hw=hwtests -ffile-prefix-map=/w=."
  INC="-I/w/compat/homebrew/shim -I/w/compat/homebrew -I/hw -I/hw/Externals/fmt/include -I/w/harness/homebrew/common -I$P/libogc/include"
  LIBS="-L$P/libogc/lib/cube -Wl,--build-id=none -logc -lm"
  build() { # name, sources...
    n=$1; shift
    $CXX $FLAGS $INC "$@" /w/compat/homebrew/hwtests-report.cpp -o /out/$n.elf $MACHDEP $LIBS
    $P/tools/bin/elf2dol /out/$n.elf /out/$n.dol
  }
  for t in '"$CPU"'; do build cputest_$t /hw/cputest/$t.cpp; done
  for t in '"$GX"'; do build gxtest_$t /hw/gxtest/$t.cpp /hw/gxtest/cgx.cpp /hw/gxtest/util.cpp; done
  # Our own tests (compat/homebrew/<name>/main.c), same report rows.
  for t in '"$OWN"'; do
    $P/devkitPPC/bin/powerpc-eabi-gcc -O2 -Wall -Werror $MACHDEP -fno-ident -ffile-prefix-map=/w=. \
      -I/w/compat/homebrew -I/w/harness/homebrew/common -I$P/libogc/include \
      /w/compat/homebrew/$t/main.c -o /out/$t.elf $MACHDEP $LIBS
    $P/tools/bin/elf2dol /out/$t.elf /out/$t.dol
  done
  make -s -C /w/harness/homebrew OUT=/out /out/apploader.bin
  chown -R '"$(id -u):$(id -g)"' /out'

i=10
for f in "$out"/*.dol; do
  n=$(basename "$f" .dol)
  node "$root/harness/homebrew/mkgcm.mjs" --dol "$f" --apploader "$out/apploader.bin" \
    --out "$out/$n.iso" --id "HW$i" --name "hwtests $n"
  i=$((i + 1))
done
(cd "$out" && sha256sum *.dol *.iso > SHA256SUMS 2>/dev/null || shasum -a 256 *.dol *.iso > SHA256SUMS; cat SHA256SUMS)
