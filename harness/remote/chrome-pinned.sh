#!/bin/sh
# Copyright 2026 wasm-dolphin contributors
# SPDX-License-Identifier: MIT
# HARNESS_CHROME_PATH on the Spark bench (spark-run.mjs): Playwright's
# Chromium (Google Chrome has no Linux arm64 build), confined to the big
# cores of one cluster ($SPARK_CHROME_CPUS, default 15-19: Cortex-X925,
# L3 of cpus 10-19) so a run never migrates to a little core or across L3.
#
# With spark-run --headed, DISPLAY and XAUTHORITY come in the environment
# and go to Chromium with the exec (the harness's x11 display mode).
#
# Every --js-flags=… argument is merged into one: Chromium reads only one,
# and the bench adds its own (spark-race.sh, spark-multi.sh) to those a
# probe passes.
js=""
for a in "$@"; do
  shift
  case $a in
    --js-flags=*) js="${js:+$js }${a#--js-flags=}" ;;
    *) set -- "$@" "$a" ;;
  esac
done
[ -n "$js" ] && set -- "$@" "--js-flags=$js"
exec taskset -c "${SPARK_CHROME_CPUS:-15-19}" "${SPARK_CHROMIUM:?}" "$@"
