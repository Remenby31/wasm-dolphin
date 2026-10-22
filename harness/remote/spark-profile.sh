#!/bin/sh
# Copyright 2026 wasm-dolphin contributors
# SPDX-License-Identifier: MIT
# Spark side of a profiling job (NOT a speed pair): waits its turn in the
# bench's FIFO queue like a pair (harness/remote/spark-race.sh), takes lane
# a's lock, runs harness/probes/profile.mjs with perf attached to the renderer for the
# window, then post-processes on the Spark. Detach it from ssh:
#
#   ssh spark 'cd ~/salon-bench/<tree with this harness> && \
#     setsid nohup sh harness/remote/spark-profile.sh ~/salon-bench/profiles/<name> ~/salon-bench/roms/<disc> >/dev/null 2>&1 &'
#   ssh spark salon-bench/bin/spark-queue list --eta        (its place)
#
# Needs perf usable by the bench user for its own processes:
#   kernel.perf_event_paranoid <= 2 (Ubuntu ships 4: no perf at all for
#   users), or PERF="sudo -n perf" with a NOPASSWD rule for perf. Neither is
#   set up on the bench (2026-10-22): a decision for the bench's owner.
# Writes <out>.log, <out>/{perf.data,samples.txt,perf.data.jitted,top.txt,asm/}.
out=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
iso=$2
B="$HOME/salon-bench"
export PATH="$B/node/bin:$PATH"
PERF=${PERF:-perf}
mkdir -p "$out"
{
  lane=$(node harness/remote/spark-queue.mjs wait --pid $$ --kind pair --lanes a --name "profile-$(basename "$out")")
  trap 'node harness/remote/spark-queue.mjs done --pid $$' EXIT
  [ "$lane" = a ] || { echo "[spark-profile] lane $lane, expected a"; exit 2; }
  export PLAYWRIGHT_MODULE="$B/pw/node_modules/playwright/index.mjs"
  export HARNESS_PERF_LOCK="$B/.perf-lock"
  export HARNESS_CHROME_PATH="$PWD/harness/remote/chrome-pinned.sh"
  export SPARK_CHROMIUM="$(ls -d "$B"/ms-playwright/chromium-*/chrome-linux*/chrome | sort -V | tail -1)"
  export SPARK_CHROME_CPUS=15-19
  echo "[spark-profile] $(date -Is) $("$SPARK_CHROMIUM" --version) perf=$PERF paranoid=$(cat /proc/sys/kernel/perf_event_paranoid)"
  taskset -c 10-14 node harness/probes/profile.mjs --tree "$PWD" --iso "$iso" --out "$out" --port 8090 ${STATE:+--state "$STATE"} \
    --query "${QUERY:-core=upstream&video=null&presenter=2d&cpu=dual&speed=1&wasmjit=1&jitwarmup=60&oc=1&aot=1}" \
    --perf "$PERF" --freq 4999 --warmup "${WARMUP:-45}" --secs "${SECS:-20}"
  echo "[spark-profile] run exit $?"
  [ -s "$out/perf.data" ] || { echo "[spark-profile] no perf.data"; exit 3; }
  # Our own mapping (no inject needed): pid/tid/time/ip of every sample.
  $PERF script -i "$out/perf.data" -F pid,tid,time,ip --ns > "$out/samples.txt"
  dump=$(ls -S "$out"/jit/jit-*.dump | head -1)
  node harness/probes/wasm-hot.mjs --jitdump "$dump" --perf-script "$out/samples.txt" --window "$out/window.json" \
    --top 30 --insns 12 --annotate 8 --out "$out/asm" > "$out/top.txt" 2>&1
  # perf's own view (perf report / perf annotate on the jitted-*.so files).
  ( cd "$out/jit" && $PERF inject --jit -i "$out/perf.data" -o "$out/perf.data.jitted" ) && \
    $PERF report -i "$out/perf.data.jitted" --no-children --sort sym --stdio 2>/dev/null | head -80 > "$out/perf-report.txt"
  echo "[spark-profile] done $(date -Is)"
} >> "$out.log" 2>&1
