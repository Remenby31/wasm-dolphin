# Homebrew fixtures

Test programs built from this repository's sources and committed so CI can
run the tests that need them on the core it builds. They contain no game
content and no Nintendo SDK: only our code (`harness/homebrew/<program>/`,
`common/`, MIT) linked against libogc.

| File | SHA-256 | Source | Used by |
|---|---|---|---|
| `cpufuzz.dol` | `1686df327495a29c444e3b9df832ccc362fce2625ee8c75e042ba04295fa3587` | `harness/homebrew/cpufuzz/main.c` | `tests/aot-region-core.test.mjs` (« cpufuzz over 4 slices ») |

## Build recipe

- Toolchain: the Docker image pinned in `harness/homebrew/build.sh`,
  `devkitpro/devkitppc@sha256:d50f8a886f2ce1d3c22685a774afb0845379876b47d9b41a9b729f4f63a54813`
  (devkitPPC with gcc 16.2.0, libogc 3.x), run as `linux/amd64`.
- Flags: `harness/homebrew/Makefile` (`-O2 -mogc -mcpu=750`, `-fno-ident`,
  `-ffile-prefix-map`, `--build-id=none`, so the bytes do not depend on the
  machine or the path).
- Command: `sh harness/homebrew/rebuild-fixtures.sh` rebuilds from source,
  never from an earlier `out/`, and compares with `SHA256SUMS` (exit 1 on any
  difference). `--update` replaces the fixtures and rewrites `SHA256SUMS`.

`tests/homebrew-fixtures.test.mjs` checks that every file here matches
`SHA256SUMS`.
