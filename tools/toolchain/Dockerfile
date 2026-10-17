# Linux image for the reproducible core build (npm run build:core:repro -- --docker,
# and the GitHub Actions workflow). Every input is pinned: the base image by
# digest (it supplies Node 24.12.0, git, curl, python3), rustup-init by
# version and SHA-256, and the rest by tools/toolchain/bootstrap.sh from
# provenance/wasm-toolchain.lock.json. Debian packages below are not pinned;
# none of them reaches the core binary (verify:toolchain hashes every tool
# that does).
FROM node:24.12.0-bookworm@sha256:929c026d5a4e4a59685b3c1dbc1a8c3eb090aa95373d3a4fd668daa2493c8331

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3-venv xz-utils bzip2 \
 && rm -rf /var/lib/apt/lists/*

ENV RUSTUP_HOME=/opt/rustup \
    CARGO_HOME=/opt/cargo \
    WASM_TOOLCHAIN_DIR=/opt/wasm-toolchain \
    PATH=/opt/cargo/bin:$PATH

ARG RUSTUP_VERSION=1.29.0
RUN set -eu; \
    case "$(uname -m)" in \
      x86_64) triple=x86_64-unknown-linux-gnu; sum=4acc9acc76d5079515b46346a485974457b5a79893cfb01112423c89aeb5aa10 ;; \
      aarch64) triple=aarch64-unknown-linux-gnu; sum=9732d6c5e2a098d3521fca8145d826ae0aaa067ef2385ead08e6feac88fa5792 ;; \
      *) echo "unsupported arch $(uname -m)" >&2; exit 1 ;; \
    esac; \
    curl -fsSLo /tmp/rustup-init "https://static.rust-lang.org/rustup/archive/${RUSTUP_VERSION}/${triple}/rustup-init"; \
    echo "${sum}  /tmp/rustup-init" | sha256sum -c -; \
    chmod +x /tmp/rustup-init; \
    /tmp/rustup-init -y --no-modify-path --profile minimal --default-toolchain none; \
    rm /tmp/rustup-init

COPY provenance/wasm-toolchain.lock.json /src/provenance/
COPY tools/toolchain/ /src/tools/toolchain/
COPY tools/naga-spirv-wgsl/Cargo.toml tools/naga-spirv-wgsl/Cargo.lock /src/tools/naga-spirv-wgsl/
RUN /src/tools/toolchain/bootstrap.sh \
 && rm -rf "$WASM_TOOLCHAIN_DIR/emsdk/downloads" \
 && mkdir -p /src/tools/naga-spirv-wgsl/src && touch /src/tools/naga-spirv-wgsl/src/lib.rs \
 && cd /src/tools/naga-spirv-wgsl \
 && rust="$(echo "$RUSTUP_HOME"/toolchains/nightly-*/bin)" \
 && RUSTC="$rust/rustc" "$rust/cargo" fetch --locked \
 && rm -rf /src

# The checkout is bind-mounted here; Git refuses repositories owned by another
# uid unless told otherwise.
RUN git config --system --add safe.directory '*'
WORKDIR /wasm-dolphin
