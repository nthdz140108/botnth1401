#!/usr/bin/env bash
set -euo pipefail
release="$(realpath -e -- "${1:?release directory required}")"
portal="$release/rust/portal"
export PATH="/root/.cargo/bin:$PATH"
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-2}"
export CARGO_TARGET_DIR="${PORTAL_CARGO_TARGET_DIR:-/opt/mybot/.cache/portal-cargo-target}"
rustup target add wasm32-unknown-unknown
if ! cargo leptos --version >/dev/null 2>&1; then cargo install cargo-leptos --locked; fi
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
