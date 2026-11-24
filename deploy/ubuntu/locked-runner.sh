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
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-2}"
export PM2_HOME="${PM2_HOME:-/root/.pm2}"
exec node "$script_dir/../deployment-worker-cli.mjs" "$root" "$@"
