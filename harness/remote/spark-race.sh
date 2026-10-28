#!/bin/sh
# Copyright 2026 wasm-dolphin contributors
# SPDX-License-Identifier: MIT
# Spark side of spark-run.mjs: one race-perf (or SPARK_PROBE: drop-meter,
# replay-gates), detached from the ssh session that started it. Run from a
# pushed harness tree under ~/salon-bench/harness.
#   spark-race.sh <out dir> <lane: a | b | auto> -- <probe args…>
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
probe=${SPARK_PROBE:-race-perf}
case $probe in
  race-perf|drop-meter|replay-gates) ;;
  *) echo "[spark-race] unknown probe $probe" >> "$out.log"; echo 2 > "$out.exit"; exit 2 ;;
esac
B="$HOME/salon-bench"
export PATH="$B/node/bin:$PATH"
mkdir -p "$B/lanes/b"
{
  trap 'node harness/remote/spark-queue.mjs done --pid $$' EXIT
  # Its turn, first come first served (spark-queue.mjs): the lane granted,
  # once that lane's cores are free of other people's processes (the bench
  # is shared: another user's evals run there, never touched). Over 50 % of
  # a core there (spark-cores.mjs, read only, thread by thread), the ticket
  # steps aside and asks again every 60 s, 30 min at most (queue exit 3:
  # exit 4 here, no pair rather than measure on shared cores); any other
  # failure is an error (2), never retried. The last check is kept as
  # <out>.cores.
  lane=$(node harness/remote/spark-queue.mjs wait --pid $$ --kind pair --lanes "$want" --name "$(basename "$out")" \
    --cores "a=${SPARK_CHROME_CPUS:-15-19},${SPARK_NODE_CPUS:-10-14}" --cores "b=${SPARK_CHROME_CPUS:-5-9},${SPARK_NODE_CPUS:-0-4}" --cores-out "$out.cores" -- "$@")
  code=$?
  case $code in
    0) ;;
    3) echo "[spark-race] the lane's cores stayed busy for 30 min: no pair"; echo 4 > "$out.exit"; exit 4 ;;
    *) echo "[spark-race] the queue failed (exit $code)"; echo 2 > "$out.exit"; exit 2 ;;
  esac
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
  # The codegen of the targets (Mac arm64, x64): V8 keeps an explicit bounds
  # check on every wasm store wider than a byte on arm64 outside macOS
  # (wasm_partial_oob_writes_are_noops false there, V8 15.6
  # flag-definitions.h), ~4 instructions a store the targets never run.
  export HARNESS_CHROME_ARGS="${HARNESS_CHROME_ARGS:+$HARNESS_CHROME_ARGS }--js-flags=--wasm-partial-oob-writes-are-noops"
  export SPARK_CHROMIUM="$(ls -d "$B"/ms-playwright/chromium-*/chrome-linux*/chrome | sort -V | tail -1)"
  export SPARK_CHROME_CPUS="${SPARK_CHROME_CPUS:-$cpus}"
  echo "[spark-race] $(date -Is) $(hostname) lane $lane uptime:$(uptime)"
  echo "[spark-race] chromium: $("$SPARK_CHROMIUM" --version) on cpus $SPARK_CHROME_CPUS, node on ${SPARK_NODE_CPUS:-$ncpus}, port $port"
  echo "[spark-race] the lane's cores are free: $(cat "$out.cores")"
  # The busiest threads and the CPU each last ran on, before and after, to
  # tell a pair's load from someone else's on its cores (read only; per
  # thread: a process's psr is its main thread's alone).
  # Read only: whether a cpuset cgroup per lane could replace taskset without
  # a system change (systemd user delegation of the cpuset controller).
  cg=$(sed -n 's/^0:://p' /proc/self/cgroup 2>/dev/null)
  echo "[spark-race] cgroup ${cg:-?}: controllers $(cat "/sys/fs/cgroup${cg}/cgroup.controllers" 2>/dev/null || echo ?); parent delegates $(cat "/sys/fs/cgroup$(dirname "${cg:-/}")/cgroup.subtree_control" 2>/dev/null || echo ?)"
  echo "[spark-race] busiest before:"; ps -eLo pid,tid,psr,pcpu,user,comm --sort=-pcpu | head -8
  echo "[spark-race] probe $probe"
  taskset -c "${SPARK_NODE_CPUS:-$ncpus}" node "harness/probes/$probe.mjs" "$@" --port "$port" --out "$out"
  code=$?
  echo "[spark-race] busiest after:"; ps -eLo pid,tid,psr,pcpu,user,comm --sort=-pcpu | head -8
  echo "[spark-race] exit $code at $(date -Is)"
  echo "$code" > "$out.exit"
} >> "$out.log" 2>&1
