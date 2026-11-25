#!/usr/bin/env bash
set -euo pipefail
# A separate EJS runtime: never replaces Node used by PM2 or the bot.
compatible_deno() {
  local version
  version="$($1 --version 2>/dev/null | head -n1 | awk '{print $2}')" || return 1
  [ -n "$version" ] && [ "$(printf '%s\n' 2.3.0 "$version" | sort -V | head -n1)" = 2.3.0 ]
}
if ! command -v deno >/dev/null || ! compatible_deno "$(command -v deno)"; then
  case "$(uname -m)" in
    x86_64) arch=x86_64; checksum=5d84e2d2cda27b4b65e6eb3f5a88085c4efbcb28c4a06f17f210d5db86f0a736 ;;
    aarch64|arm64) arch=aarch64; checksum=d8a5f61504d8071bb0f2ad87abd722b1b9f5b42789f92c51352df6db8b3821dc ;;
    *) echo 'Unsupported Deno architecture' >&2; exit 1 ;;
  esac
  work="$(mktemp -d /tmp/mybot-deno.XXXXXXXX)"
  trap 'rm -rf -- "$work"' EXIT
  asset="deno-${arch}-unknown-linux-gnu.zip"
  curl --fail --location --retry 2 --connect-timeout 15 --max-time 120 \
    "https://github.com/denoland/deno/releases/download/v2.3.0/$asset" -o "$work/$asset"
  printf '%s  %s\n' "$checksum" "$work/$asset" | sha256sum -c -
  python3 - "$work/$asset" "$work" <<'PY'
import sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as archive:
    with open(sys.argv[2] + '/deno', 'wb') as output:
        output.write(archive.read('deno'))
PY
  chmod 755 "$work/deno"
  compatible_deno "$work/deno"
  install -m 755 "$work/deno" /usr/local/bin/deno
fi
deno --version | head -n1
ffmpeg -version | head -n1
ffprobe -version | head -n1
echo 'Download runtime ready; Node unchanged.'
