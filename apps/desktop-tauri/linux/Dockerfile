# The Linux build and test image of the Tauri shell: Ubuntu
# 24.04 LTS (the CI runner's release), WebKitGTK 4.1, Rust and Bun pinned to
# the versions of the Mac checks and of package.json, tauri-driver for the
# WebDriver run under Xvfb.
#
#   docker build --platform linux/amd64 -t openedbot-desktop-linux:x86_64 apps/desktop-tauri/linux
#
# Nothing secret goes into the image: sources and the update key are handed
# to the container at run time (scripts/build-linux.ts).
FROM ubuntu:24.04@sha256:fe81560990fae86dc4743202b2cb4d3df98d0bcf949173cecef15ce1127ef852

ARG RUST_VERSION=1.98.0
ARG BUN_VERSION=1.4.4
ARG TAURI_DRIVER_VERSION=2.1.0

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    CARGO_HOME=/opt/cargo \
    RUSTUP_HOME=/opt/rustup \
    BUN_INSTALL=/opt/bun \
    PATH=/opt/cargo/bin:/opt/bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    # The AppImage tools (linuxdeploy, the built AppImage) run without FUSE in a container.
    APPIMAGE_EXTRACT_AND_RUN=1

COPY install-deps.sh /tmp/install-deps.sh
RUN /tmp/install-deps.sh build test && rm -rf /var/lib/apt/lists/* /tmp/install-deps.sh

RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal \
      --default-toolchain "${RUST_VERSION}" --component clippy \
 && cargo install tauri-driver --version "${TAURI_DRIVER_VERSION}" --locked \
 && rm -rf "${CARGO_HOME}/registry" "${CARGO_HOME}/git"

# The repo's tools start with `#!/usr/bin/env node` (vite): Bun answers as
# Node when called by that name, so the image needs no second runtime.
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" \
 && ln -s "${BUN_INSTALL}/bin/bun" /usr/local/bin/node \
 && bun --version && node -e "process.exit(0)"

WORKDIR /work
