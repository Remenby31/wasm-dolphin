#!/bin/sh
# SPDX-License-Identifier: MIT
# Rebuild the committed homebrew fixtures from source (build.sh: pinned
# devkitPPC image, our sources only), never from a previous out/ build, and compare them with the committed
# bytes. Exit 1 on any difference. --update copies the new builds over the
# fixtures and rewrites fixtures/SHA256SUMS (review the diff then).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
# From source every time: make would otherwise keep an existing out/ build.
rm -f "$here/out/cpufuzz.elf" "$here/out/cpufuzz.dol"
sh "$here/build.sh" >/dev/null
status=0
for f in cpufuzz.dol; do
  built=$(shasum -a 256 "$here/out/$f" | cut -d' ' -f1)
  committed=$(awk -v f="$f" '$2==f{print $1}' "$here/fixtures/SHA256SUMS" 2>/dev/null || true)
  if [ "${1:-}" = "--update" ]; then
    cp "$here/out/$f" "$here/fixtures/$f"
  elif [ "$built" = "$committed" ]; then
    echo "$f: rebuilt identically ($built)"
  else
    echo "$f: rebuilt $built, committed $committed" >&2
    status=1
  fi
done
if [ "${1:-}" = "--update" ]; then
  (cd "$here/fixtures" && shasum -a 256 cpufuzz.dol > SHA256SUMS && cat SHA256SUMS)
fi
exit $status
