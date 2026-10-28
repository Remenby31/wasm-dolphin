#!/bin/sh
# Copyright 2026 wasm-dolphin contributors
# SPDX-License-Identifier: MIT
# Spark side of spark-run.mjs --multi: one race-multi (every arm at once,
# one lane of X925 cores each: three of 3 cores by default, or two of 5 with
# --multi-lanes "15-19;5-9"), node on 10-14, detached from the ssh session
# that started it. Run from a pushed harness tree under ~/salon-bench/harness.
#   spark-multi.sh <out dir> -- <race-multi args…>
# Writes <out dir>.log (all output), <out dir>.lane and <out dir>.exit
# (race-multi's code).
#
# It takes the whole bench (both lanes' locks, granted in order of arrival
# by spark-queue.mjs, kind multi): its arms run on both clusters.
out=$1
shift 2
B="$HOME/salon-bench"
export PATH="$B/node/bin:$PATH"
mkdir -p "$B/lanes/b"
{
  trap 'node harness/remote/spark-queue.mjs done --pid $$' EXIT
  # Both lanes' cores free of other people's processes before the grant, as
  # for a pair (spark-race.sh): the multi A/A of 2026-10-28 ran with evals
  # on lane b's cores (5, 6, 8, 9), which measured 7 % slower where the
  # cores' capacities differ by 2-3 %. Busy for 30 min: no run (exit 4).
  lane=$(node harness/remote/spark-queue.mjs wait --pid $$ --kind multi --name "$(basename "$out")" \
    --cores "a=15-19,10-14" --cores "b=5-9,0-4" --cores-out "$out.cores" -- "$@")
  code=$?
  case $code in
    0) ;;
    3) echo "[spark-multi] the lanes' cores stayed busy for 30 min: no run"; echo 4 > "$out.exit"; exit 4 ;;
    *) echo "[spark-multi] the queue failed (exit $code)"; echo 2 > "$out.exit"; exit 2 ;;
  esac
  echo "$lane" > "$out.lane"
  export PLAYWRIGHT_MODULE="$B/pw/node_modules/playwright/index.mjs"
  export HARNESS_PRIVATE_OUT="$B/results"
  export HARNESS_CHROME_PATH="$PWD/harness/remote/chrome-pinned.sh"
  # The codegen of the targets (Mac arm64, x64): V8 keeps an explicit bounds
  # check on every wasm store wider than a byte on arm64 outside macOS
  # (wasm_partial_oob_writes_are_noops false there, V8 15.6
  # flag-definitions.h), ~4 instructions a store the targets never run.
  export HARNESS_CHROME_ARGS="${HARNESS_CHROME_ARGS:+$HARNESS_CHROME_ARGS }--js-flags=--wasm-partial-oob-writes-are-noops"
  export SPARK_CHROMIUM="$(ls -d "$B"/ms-playwright/chromium-*/chrome-linux*/chrome | sort -V | tail -1)"
  echo "[spark-multi] $(date -Is) $(hostname) lanes $lane uptime:$(uptime)"
  # the cores' kinds (the two lanes ran 7 % apart in a multi A/A, 2026-10-28)
  node harness/remote/spark-cores.mjs topology 2>/dev/null | sed "s/^/[spark-multi] cpus /"
  echo "[spark-multi] chromium: $("$SPARK_CHROMIUM" --version), node on 10-14, perf_event_paranoid=$(cat /proc/sys/kernel/perf_event_paranoid)"
  taskset -c 10-14 node harness/probes/race-multi.mjs "$@" --port 8095 --lock "$B/.perf-lock" --lock "$B/lanes/b/.perf-lock" --out "$out"
  code=$?
  echo "[spark-multi] exit $code at $(date -Is)"
  echo "$code" > "$out.exit"
} >> "$out.log" 2>&1
