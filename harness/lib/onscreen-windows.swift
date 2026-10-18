// Copyright 2026 wasm-dolphin contributors
// SPDX-License-Identifier: MIT
// Prints "pid x y width height" for every on-screen window owned by one of
// the PIDs given as arguments. Used by the harness to prove its browser is
// invisible (PROGRAM.md: never disturb the user).
import CoreGraphics
import Foundation
let pids = Set(CommandLine.arguments.dropFirst().compactMap { Int($0) })
let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
for w in list {
  let pid = w[kCGWindowOwnerPID as String] as? Int ?? 0
  guard pids.contains(pid) else { continue }
  let b = w[kCGWindowBounds as String] as? [String: Any] ?? [:]
  print(pid, b["X"] ?? "", b["Y"] ?? "", b["Width"] ?? "", b["Height"] ?? "")
}
