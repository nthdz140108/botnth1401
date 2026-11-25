#!/usr/bin/env bash
set -euo pipefail
if [[ $# -lt 2 ]]; then echo 'Usage: locked-runner.sh ROOT OPERATION [ARG]' >&2; exit 2; fi
root="$(realpath -e -- "$1")"
shift
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
if [[ "$1" == 'status' ]]; then exec node "$script_dir/../deployment-worker-cli.mjs" "$root" "$@"; fi
exec 9>"$root/.deploy.lock"
if ! flock -n 9; then echo 'Another deployment is running' >&2; exit 75; fi
export PATH="/root/.cargo/bin:$PATH"
export CARGO_TARGET_DIR="$root/.cache/deploy-cargo-target"
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
export PM2_HOME="${PM2_HOME:-/root/.pm2}"
exec node "$script_dir/../deployment-worker-cli.mjs" "$root" "$@"
