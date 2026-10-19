#!/bin/sh
# Chrome stable confined to the efficiency cores of an Apple Silicon Mac:
# taskpolicy -b runs it, and every process and thread it starts, at background
# QoS, which macOS schedules on E-cores only (ps -M shows priority 4).
# Used as HARNESS_CHROME_PATH for the low-end profile of
# docs/consumer-perf-extrapolation.md.
exec /usr/sbin/taskpolicy -b "${CHROME_STABLE:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}" "$@"
