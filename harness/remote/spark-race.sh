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
# port and its own perf lock. A pair stays in one lane, both sides. Lane a's
# lock is the bench's first one (~/salon-bench/.perf-lock), so pairs from
# a harness before lanes (Chromium on 15-19) still exclude lane a.
out=$1
want=$2
shift 3
B="$HOME/salon-bench"
lock() { if [ "$1" = a ]; then echo "$B/.perf-lock"; else echo "$B/lanes/$1/.perf-lock"; fi; }
mkdir -p "$B/lanes/b"
# A lane is busy while its lock is held, and lane b also while any core
# build exists, running or queued: a build from a harness before lanes takes
# only lane a's lock, and compiles on every core.
busy() {
  [ -e "$(lock "$1")" ] && return 0
  [ "$1" = b ] && pgrep -u "$(id -u)" -f '^node harness/remote/spark-build[.]mjs' >/dev/null
}
{
  lanes=$want
  [ "$want" = auto ] && lanes="a b"
  # The first free lane; race-perf then takes its lock (and waits if another
  # pair took it in between).
  while :; do
    lane=
    for l in $lanes; do busy "$l" || { lane=$l; break; }; done
    [ -n "$lane" ] && break
    echo "[spark-race] lane(s) $lanes busy, retrying in 30 s"
    sleep 30
  done
  case $lane in
    a) cpus=15-19 ncpus=10-14 port=8090 ;;
    b) cpus=5-9 ncpus=0-4 port=8091 ;;
    *) echo "[spark-race] unknown lane $lane"; echo 2 > "$out.exit"; exit 2 ;;
  esac
  echo "$lane" > "$out.lane"
  export PATH="$B/node/bin:$PATH"
  export PLAYWRIGHT_MODULE="$B/pw/node_modules/playwright/index.mjs"
  export HARNESS_PERF_LOCK="$(lock "$lane")"
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
