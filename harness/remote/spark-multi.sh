#!/bin/sh
# Copyright 2026 wasm-dolphin contributors
# SPDX-License-Identifier: MIT
# Spark side of spark-run.mjs --multi: one race-multi (every arm at once,
# one lane of 3 big cores each), detached from the ssh session that started
# it. Run from a pushed harness tree under ~/salon-bench/harness.
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
  lane=$(node harness/remote/spark-queue.mjs wait --pid $$ --kind multi --name "$(basename "$out")" -- "$@")
  trap 'node harness/remote/spark-queue.mjs done --pid $$' EXIT
  echo "$lane" > "$out.lane"
  export PLAYWRIGHT_MODULE="$B/pw/node_modules/playwright/index.mjs"
  export HARNESS_PRIVATE_OUT="$B/results"
  export HARNESS_CHROME_PATH="$PWD/harness/remote/chrome-pinned.sh"
  export SPARK_CHROMIUM="$(ls -d "$B"/ms-playwright/chromium-*/chrome-linux*/chrome | sort -V | tail -1)"
  echo "[spark-multi] $(date -Is) $(hostname) lanes $lane uptime:$(uptime)"
  echo "[spark-multi] chromium: $("$SPARK_CHROMIUM" --version), node on 10-14, perf_event_paranoid=$(cat /proc/sys/kernel/perf_event_paranoid)"
  taskset -c 10-14 node harness/probes/race-multi.mjs "$@" --port 8095 --lock "$B/.perf-lock" --lock "$B/lanes/b/.perf-lock" --out "$out"
  code=$?
  echo "[spark-multi] exit $code at $(date -Is)"
  echo "$code" > "$out.exit"
} >> "$out.log" 2>&1
