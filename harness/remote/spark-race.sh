#!/bin/sh
# Copyright 2026 wasm-dolphin contributors
# SPDX-License-Identifier: MIT
# Spark side of spark-run.mjs: one race-perf, detached from the ssh session
# that started it. Run from a pushed harness tree under ~/salon-bench/harness.
#   spark-race.sh <out dir> -- <race-perf args…>
# Writes <out dir>.log (all output) and <out dir>.exit (race-perf's code).
out=$1
shift 2
B="$HOME/salon-bench"
export PATH="$B/node/bin:$PATH"
export PLAYWRIGHT_MODULE="$B/pw/node_modules/playwright/index.mjs"
export HARNESS_PERF_LOCK="$B/.perf-lock"
export HARNESS_PRIVATE_OUT="$B/results"
export HARNESS_CHROME_PATH="$PWD/harness/remote/chrome-pinned.sh"
export SPARK_CHROMIUM="$(ls -d "$B"/ms-playwright/chromium-*/chrome-linux*/chrome | sort -V | tail -1)"
{
  echo "[spark-race] $(date -Is) $(hostname) uptime:$(uptime)"
  echo "[spark-race] chromium: $("$SPARK_CHROMIUM" --version) on cpus ${SPARK_CHROME_CPUS:-15-19}, node on ${SPARK_NODE_CPUS:-0-4}"
  taskset -c "${SPARK_NODE_CPUS:-0-4}" node harness/probes/race-perf.mjs "$@" --out "$out"
  code=$?
  echo "[spark-race] exit $code at $(date -Is)"
  echo "$code" > "$out.exit"
} >> "$out.log" 2>&1
