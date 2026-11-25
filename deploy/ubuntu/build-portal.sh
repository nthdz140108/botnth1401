#!/usr/bin/env bash
set -euo pipefail
release="$(realpath -e -- "${1:?release directory required}")"
portal="$release/rust/portal"
export PATH="/root/.cargo/bin:$PATH"

mem_mb="$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo 2>/dev/null || echo 4096)"
if [[ "$mem_mb" -lt 6500 ]]; then
  export CARGO_BUILD_JOBS=1
else
  export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-2}"
fi
export CARGO_PROFILE_RELEASE_LTO=off
export CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16
export CARGO_PROFILE_RELEASE_DEBUG=0
if command -v clang >/dev/null 2>&1 && (command -v ld.lld >/dev/null 2>&1 || command -v lld >/dev/null 2>&1); then
  export CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER=clang
  export CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUSTFLAGS="-C link-arg=-fuse-ld=lld"
fi

export CARGO_TARGET_DIR="${PORTAL_CARGO_TARGET_DIR:-/opt/mybot/.cache/portal-cargo-target}"
rustup target add wasm32-unknown-unknown

if ! cargo leptos --version >/dev/null 2>&1; then
  mkdir -p /root/.cargo/bin
  tmp_cl="$(mktemp -d)"
  arch_uname="$(uname -m)"
  if [[ "$arch_uname" == "aarch64" ]]; then
    cl_url="https://github.com/leptos-rs/cargo-leptos/releases/download/v0.3.11/cargo-leptos-aarch64-unknown-linux-gnu.tar.gz"
  else
    cl_url="https://github.com/leptos-rs/cargo-leptos/releases/download/v0.3.11/cargo-leptos-x86_64-unknown-linux-musl.tar.gz"
  fi
  curl -fsSL "$cl_url" -o "$tmp_cl/cargo-leptos.tar.gz"
  tar -xzf "$tmp_cl/cargo-leptos.tar.gz" -C "$tmp_cl"
  cl_bin="$(find "$tmp_cl" -type f -name 'cargo-leptos' | head -n 1)"
  install -m755 "$cl_bin" /root/.cargo/bin/cargo-leptos
  rm -rf "$tmp_cl"
fi

cd "$portal"
cargo leptos build --release --cargo-locked
cargo build --release --locked -p mybot-portal-worker
install -d "$release/bin" "$release/portal-site"
install -m755 "$CARGO_TARGET_DIR/release/mybot-portal" "$release/bin/mybot-portal"
install -m755 "$CARGO_TARGET_DIR/release/mybot-portal-worker" "$release/bin/mybot-portal-worker"
# cargo-leptos site-root is relative to this workspace, independent of target cache.
cp -a "$portal/target/site/." "$release/portal-site/"
test -s "$release/portal-site/pkg/mybot-portal_bg.wasm" || test -s "$release/portal-site/pkg/mybot-portal.wasm"
# Migration precedes the release switch. Only forward, additive migrations exist;
# reverting code never rewinds wallet/order data.
if [[ -f /etc/mybot/portal.env ]]; then
  set -a; source /etc/mybot/portal.env; set +a
  "$release/bin/mybot-portal" migrate
  bash "$release/deploy/ubuntu/grant-portal.sh"
fi
