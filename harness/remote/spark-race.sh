#!/bin/sh
# Copyright 2026 wasm-dolphin contributors
# SPDX-License-Identifier: MIT
# Spark side of spark-run.mjs: one race-perf, detached from the ssh session
# that started it. Run from a pushed harness tree under ~/salon-bench/harness.
#   spark-race.sh <out dir> <lane: a | b | auto> -- <race-perf args…>
# Writes <out dir>.log (all output), <out dir>.lane and <out dir>.exit
# (race-perf's code).
#
# Lanes: two pairs run at once, one per CPU cluster (each cluster has its
# own L3): Chromium on its 5 big cores, node on its 5 little ones, its own
# port and its own perf lock, granted in order of arrival by spark-queue.mjs.
# A pair stays in one lane, both sides. Lane a's
# lock is the bench's first one (~/salon-bench/.perf-lock), so pairs from
# a harness before lanes (Chromium on 15-19) still exclude lane a.
out=$1
want=$2
shift 3
B="$HOME/salon-bench"
export PATH="$B/node/bin:$PATH"
mkdir -p "$B/lanes/b"
{
  # Its turn, first come first served (spark-queue.mjs): the lane granted.
  lane=$(node harness/remote/spark-queue.mjs wait --pid $$ --kind pair --lanes "$want" --name "$(basename "$out")")
  trap 'node harness/remote/spark-queue.mjs done --pid $$' EXIT
  case $lane in
    a) cpus=15-19 ncpus=10-14 port=8090 ;;
    b) cpus=5-9 ncpus=0-4 port=8091 ;;
    *) echo "[spark-race] unknown lane $lane"; echo 2 > "$out.exit"; exit 2 ;;
  esac
  echo "$lane" > "$out.lane"
  export PLAYWRIGHT_MODULE="$B/pw/node_modules/playwright/index.mjs"
  if [ "$lane" = a ]; then export HARNESS_PERF_LOCK="$B/.perf-lock"; else export HARNESS_PERF_LOCK="$B/lanes/$lane/.perf-lock"; fi
  export HARNESS_PRIVATE_OUT="$B/results"
  export HARNESS_CHROME_PATH="$PWD/harness/remote/chrome-pinned.sh"
  export SPARK_CHROMIUM="$(ls -d "$B"/ms-playwright/chromium-*/chrome-linux*/chrome | sort -V | tail -1)"
  export SPARK_CHROME_CPUS="${SPARK_CHROME_CPUS:-$cpus}"
  echo "[spark-race] $(date -Is) $(hostname) lane $lane uptime:$(uptime)"
  echo "[spark-race] chromium: $("$SPARK_CHROMIUM" --version) on cpus $SPARK_CHROME_CPUS, node on ${SPARK_NODE_CPUS:-$ncpus}, port $port"
  taskset -c "${SPARK_NODE_CPUS:-$ncpus}" node harness/probes/race-perf.mjs "$@" --port "$port" --out "$out"
  code=$?
  echo "[spark-race] exit $code at $(date -Is)"
  echo "$code" > "$out.exit"
} >> "$out.log" 2>&1
