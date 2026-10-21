#!/bin/sh
# Copyright 2026 wasm-dolphin contributors
# SPDX-License-Identifier: MIT
# HARNESS_CHROME_PATH on the Spark bench (spark-run.mjs): Playwright's
# Chromium (Google Chrome has no Linux arm64 build), confined to the big
# cores of one cluster ($SPARK_CHROME_CPUS, default 15-19: Cortex-X925,
# L3 of cpus 10-19) so a run never migrates to a little core or across L3.
exec taskset -c "${SPARK_CHROME_CPUS:-15-19}" "${SPARK_CHROMIUM:?}" "$@"
