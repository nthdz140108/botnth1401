#!/usr/bin/env bash
# ==============================================================================
# MyBot V4 Super Pro Max — Automated Ubuntu 22.04 / 24.04 LTS Provisioner
# ==============================================================================
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "[!] Vui lòng chạy script này với quyền root: sudo bash deploy/ubuntu/install-ubuntu.sh"
  exit 1
fi

# Accept optional --source-dir <path> or auto-detect from script location
SOURCE_OVERRIDE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --source-dir)
      SOURCE_OVERRIDE="${2:-}"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${SOURCE_OVERRIDE:-$(cd "${SCRIPT_DIR}/../.." && pwd)}"

echo "==> [1/7] Cài đặt gói hệ thống, OpenSSL, font chữ tiếng Việt/Emoji, FFmpeg, Node.js 20 & PM2..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y --no-install-recommends \
  ca-certificates curl git jq openssl sqlite3 pkg-config build-essential clang lld cmake \
  ffmpeg fontconfig fonts-noto-core fonts-noto-color-emoji fonts-liberation2 \
  libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev

if ! command -v node >/dev/null 2>&1; then
  echo "[i] Đang cài đặt Node.js 20 LTS cho kiến trúc Hybrid..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
if ! command -v pm2 >/dev/null 2>&1; then
  echo "[i] Đang cài đặt PM2..."
  npm install -g pm2
fi

echo "==> [2/7] Cài đặt yt-dlp bản mới nhất..."
if ! command -v yt-dlp >/dev/null 2>&1; then
  curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux \
    -o /usr/local/bin/yt-dlp
  chmod a+rx /usr/local/bin/yt-dlp
fi

echo "==> [3/7] Áp dụng cấu hình Kernel TCP BBR & giới hạn File Descriptors..."
if [[ -f "${SCRIPT_DIR}/99-mybot-sysctl.conf" ]]; then
  cp "${SCRIPT_DIR}/99-mybot-sysctl.conf" /etc/sysctl.d/99-mybot-sysctl.conf
  modprobe tcp_bbr || true
  sysctl --system >/dev/null || true
fi

echo "==> [4/7] Khởi tạo tài khoản hệ thống 'mybot', tạo Swap dự phòng (nếu VPS ít RAM) & chép dữ liệu..."
TOTAL_MEM_MB="$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)"
if [[ "${TOTAL_MEM_MB}" -lt 8192 ]] && [[ ! -f /swapfile_mybot ]] && [[ "$(swapon --show | wc -l)" -eq 0 ]]; then
  echo "[i] Phát hiện VPS có ${TOTAL_MEM_MB}MB RAM -> Tự động tạo 2GB Swap để biên dịch Rust mượt mà..."
  fallocate -l 2G /swapfile_mybot || dd if=/dev/zero of=/swapfile_mybot bs=1M count=2048
  chmod 600 /swapfile_mybot
  mkswap /swapfile_mybot >/dev/null
  swapon /swapfile_mybot || true
fi

if ! id -u mybot >/dev/null 2>&1; then
  useradd --system --home-dir /opt/mybot --shell /usr/sbin/nologin mybot
fi
mkdir -p /opt/mybot /var/lib/mybot /etc/mybot /dev/shm/mybot

if [[ -d "${REPO_ROOT}/assets" ]]; then
  mkdir -p /opt/mybot/assets
  if [[ -f /opt/mybot/assets/config.json ]]; then
    # Preserve existing real bot credentials; do NOT overwrite!
    cp -rn "${REPO_ROOT}/assets/"* /opt/mybot/assets/ 2>/dev/null || true
  else
    cp -rf "${REPO_ROOT}/assets" /opt/mybot/
  fi
fi
if [[ -d "${REPO_ROOT}/dashboard/dist" ]]; then
  mkdir -p /opt/mybot/dashboard
  cp -rf "${REPO_ROOT}/dashboard/dist" /opt/mybot/dashboard/
fi
if [[ -d "${REPO_ROOT}/src" ]]; then
  cp -rf "${REPO_ROOT}/src" /opt/mybot/
fi
if [[ -d "${REPO_ROOT}/scripts" ]]; then
  cp -rf "${REPO_ROOT}/scripts" /opt/mybot/
fi
if [[ -f "${REPO_ROOT}/package.json" ]]; then
  cp -f "${REPO_ROOT}/package.json" /opt/mybot/
fi
if [[ -f "${REPO_ROOT}/index.js" ]]; then
  cp -f "${REPO_ROOT}/index.js" /opt/mybot/
fi
if [[ -f "${REPO_ROOT}/bot.js" ]]; then
  cp -f "${REPO_ROOT}/bot.js" /opt/mybot/
fi
if [[ -f "${REPO_ROOT}/groupSettings.json" ]] && [[ ! -f /opt/mybot/groupSettings.json ]]; then
  cp -f "${REPO_ROOT}/groupSettings.json" /opt/mybot/
fi
fc-cache -f || true

echo "==> [5/7] Biên dịch MyBot V4 Pure-Rust (Nhúng sẵn Web Control Center V4)..."
if ! command -v cargo >/dev/null 2>&1; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
fi
if [[ -f "${HOME}/.cargo/env" ]]; then
  # shellcheck disable=SC1091
  source "${HOME}/.cargo/env"
fi

CPU_RUSTFLAGS=""
if grep -qi "avx2" /proc/cpuinfo 2>/dev/null; then
  CPU_RUSTFLAGS="-C target-cpu=x86-64-v3"
  echo "[i] CPU hỗ trợ AVX2 -> Bật tối ưu SIMD x86-64-v3."
fi

pushd "${REPO_ROOT}/rust" >/dev/null
if [[ "${MYBOT_ENABLE_SKIA_ORT:-0}" == "1" ]]; then
  RUSTFLAGS="${CPU_RUSTFLAGS}" cargo build --release -p mybotd -p mybot-ctl -p ws-decode-worker --features ubuntu-pro-max || \
    RUSTFLAGS="${CPU_RUSTFLAGS}" cargo build --release -p mybotd -p mybot-ctl -p ws-decode-worker
else
  RUSTFLAGS="${CPU_RUSTFLAGS}" cargo build --release -p mybotd -p mybot-ctl -p ws-decode-worker
fi
BACKUP_DIR="/var/lib/mybot/backups"
mkdir -p "${BACKUP_DIR}"
BIN_BACKUP=""
CTL_BACKUP=""
if [[ -f /usr/local/bin/mybotd ]]; then
  BIN_BACKUP="${BACKUP_DIR}/mybotd-$(date -u +%Y%m%dT%H%M%SZ)"
  cp -p /usr/local/bin/mybotd "${BIN_BACKUP}"
fi
if [[ -f /usr/local/bin/mybot-ctl ]]; then
  CTL_BACKUP="${BACKUP_DIR}/mybot-ctl-$(date -u +%Y%m%dT%H%M%SZ)"
  cp -p /usr/local/bin/mybot-ctl "${CTL_BACKUP}"
fi
rollback_previous_binary() {
  local failed_status=$?
  trap - ERR
  if [[ -n "${BIN_BACKUP}" && -f "${BIN_BACKUP}" ]]; then
    install -m 0755 "${BIN_BACKUP}" /usr/local/bin/mybotd
    if [[ -n "${CTL_BACKUP}" && -f "${CTL_BACKUP}" ]]; then
      install -m 0755 "${CTL_BACKUP}" /usr/local/bin/mybot-ctl
    fi
    systemctl restart mybot.service || true
    echo "[LỖI] Đã khôi phục binary MyBot trước đó: ${BIN_BACKUP}"
  fi
  exit "${failed_status}"
}
trap rollback_previous_binary ERR
install -m 0755 target/release/mybotd /usr/local/bin/mybotd
install -m 0755 target/release/mybot-ctl /usr/local/bin/mybot-ctl
install -m 0755 target/release/ws-decode-worker /usr/local/bin/ws-decode-worker || true
popd >/dev/null

DB_PATH="/var/lib/mybot/mybot.db"
if [[ -f "${DB_PATH}" ]]; then
  BACKUP_DIR="/var/lib/mybot/backups"
  DB_BACKUP="${BACKUP_DIR}/mybot-$(date -u +%Y%m%dT%H%M%SZ).db"
  mkdir -p "${BACKUP_DIR}"
  sqlite3 "${DB_PATH}" ".backup '${DB_BACKUP}'"
  chown mybot:mybot "${DB_BACKUP}"
  chmod 0600 "${DB_BACKUP}"
  echo "[OK] Đã sao lưu SQLite nhất quán trước khi restart: ${DB_BACKUP}"
fi

echo "==> [6/7] Di trú dữ liệu V3 sang SQLite WAL (bảo toàn 100% phiên Cookie + IMEI + Nhóm)..."
if [[ ! -f "${DB_PATH}" ]]; then
  /usr/local/bin/mybot-ctl migrate-v3 --source "${REPO_ROOT}" --db "${DB_PATH}"
fi

if [[ ! -f /etc/mybot/mybot.env ]]; then
  RAND_HMAC="$(openssl rand -hex 24)"
  cat >/etc/mybot/mybot.env <<EOF
DASHBOARD_HOST=0.0.0.0
DASHBOARD_PORT=4173
DASHBOARD_ADMIN_USERNAME=admin
DASHBOARD_ADMIN_PASSWORD=140108
INTERNAL_API_SECRET=${RAND_HMAC}
MYBOT_CONNECT_LIVE_ZALO=false
MYBOT_NODE_HYBRID=true
MYBOT_BRIDGE_PORT=4174
MYBOT_BRIDGE_URL=http://127.0.0.1:4174
DISABLE_NODE_DASHBOARD=true
EOF
  chmod 0640 /etc/mybot/mybot.env
  chown root:mybot /etc/mybot/mybot.env 2>/dev/null || true
else
  # Ensure hybrid flag and bridge config are active
  if ! grep -qi "MYBOT_NODE_HYBRID" /etc/mybot/mybot.env; then
    echo "MYBOT_NODE_HYBRID=true" >> /etc/mybot/mybot.env
  fi
  if ! grep -qi "MYBOT_BRIDGE_PORT" /etc/mybot/mybot.env; then
    echo "MYBOT_BRIDGE_PORT=4174" >> /etc/mybot/mybot.env
  fi
  if ! grep -qi "MYBOT_BRIDGE_URL" /etc/mybot/mybot.env; then
    echo "MYBOT_BRIDGE_URL=http://127.0.0.1:4174" >> /etc/mybot/mybot.env
  fi
  if ! grep -qi "DISABLE_NODE_DASHBOARD" /etc/mybot/mybot.env; then
    echo "DISABLE_NODE_DASHBOARD=true" >> /etc/mybot/mybot.env
  fi
  sed -i "s/MYBOT_CONNECT_LIVE_ZALO=true/MYBOT_CONNECT_LIVE_ZALO=false/" /etc/mybot/mybot.env
  chmod 0640 /etc/mybot/mybot.env
  chown root:mybot /etc/mybot/mybot.env 2>/dev/null || true
fi

echo "==> Cài đặt thư viện Node và cấu hình PM2 cho kiến trúc Hybrid..."
pushd /opt/mybot >/dev/null
npm install --omit=dev || true
if [[ -f "/opt/mybot/scripts/sync-sqlite-to-node.py" && -f "${DB_PATH}" ]]; then
  python3 /opt/mybot/scripts/sync-sqlite-to-node.py /opt/mybot "${DB_PATH}" || true
fi

# Extract INTERNAL_API_SECRET for Node Bridge
VPS_SECRET="$(grep -E '^INTERNAL_API_SECRET=' /etc/mybot/mybot.env | cut -d'=' -f2- | tr -d '\"' || echo 'mybot-internal-secret')"
mkdir -p /opt/mybot/mybot /opt/mybot/.runtime/pm2
echo "${VPS_SECRET}" > /opt/mybot/mybot/.internal_secret
chmod 0600 /opt/mybot/mybot/.internal_secret

pm2 delete mybot-dashboard || true
pm2 delete mybot-bridge || true
pm2 delete admin || true
fuser -k 4174/tcp 2>/dev/null || true
BOT_KEY=admin BOT_NAME=admin CONFIG_PATH=/opt/mybot/assets/config.json SKIP_ENV_VALIDATION=1 MYBOT_RUN_BRIDGE=1 MYBOT_BRIDGE_PORT=4174 INTERNAL_API_SECRET="${VPS_SECRET}" pm2 start src/dashboard/node-bridge-service.js --name mybot-bridge --cwd /opt/mybot
MYBOT_NODE_HYBRID=true DISABLE_NODE_DASHBOARD=true MYBOT_INSTANCE_KIND=main BOT_KEY=admin BOT_NAME=admin CONFIG_PATH=/opt/mybot/assets/config.json pm2 start src/bootstrap.js --name admin --cwd /opt/mybot
pm2 save
pm2 startup systemd -u root --hp /root || true
popd >/dev/null

chown -R mybot:mybot /opt/mybot /var/lib/mybot /dev/shm/mybot

echo "==> [7/7] Mở cổng tường lửa 4173 & kích hoạt dịch vụ tự chạy 24/7 (systemd)..."
if command -v ufw >/dev/null 2>&1; then
  if ufw status | grep -qi "Status: active"; then
    ufw allow 4173/tcp >/dev/null || true
  fi
fi

cp "${SCRIPT_DIR}/mybot.service" /etc/systemd/system/mybot.service
systemctl daemon-reload
systemctl enable mybot.service
systemctl restart mybot.service

echo "==> Kiểm tra 3 probe độc lập (Rust Dashboard 4173, Node Bridge 4174, Bot Relay)..."
RUST_HEALTHY=0
for _attempt in $(seq 1 30); do
  HEALTH_JSON="$(curl -fsS --max-time 2 http://127.0.0.1:4173/api/system/health 2>/dev/null || true)"
  if [[ "${HEALTH_JSON}" == *'"status":"healthy"'* ]]; then
    RUST_HEALTHY=1
    break
  fi
  sleep 2
done

BRIDGE_HEALTHY=0
for _attempt in $(seq 1 15); do
  BRIDGE_JSON="$(curl -fsS --max-time 2 http://127.0.0.1:4174/bridge/health 2>/dev/null || true)"
  if [[ "${BRIDGE_JSON}" == *'"status":"ok"'* ]]; then
    BRIDGE_HEALTHY=1
    break
  fi
  sleep 1
done

RELAY_HEALTHY=0
for _attempt in $(seq 1 15); do
  NODE_ON_4173="$(ss -tulpn 2>/dev/null | grep -E ':4173\b' | grep -i 'node' || true)"
  if [[ -n "${NODE_ON_4173}" ]]; then
    echo "[CẢNH BÁO] Phát hiện tiến trình Node chiếm cổng 4173! Đang giải phóng cho Rust..."
    pm2 delete mybot-dashboard || true
  fi

  SYS_HEALTH="$(curl -fsS --max-time 2 http://127.0.0.1:4173/api/system/health 2>/dev/null || true)"
  if [[ "${SYS_HEALTH}" == *'"engine":"mybot-v4-rust"'* && "${SYS_HEALTH}" == *'"bots":'* ]]; then
    RELAY_HEALTHY=1
    break
  fi
  sleep 1
done

if [[ "${RUST_HEALTHY}" -ne 1 || "${BRIDGE_HEALTHY}" -ne 1 || "${RELAY_HEALTHY}" -ne 1 ]]; then
  echo "[LỖI] Kiểm tra 3 probe thất bại:"
  echo "  - Probe 1 (Rust Dashboard 4173):   ${RUST_HEALTHY} (1=OK)"
  echo "  - Probe 2 (Node Bridge 4174):       ${BRIDGE_HEALTHY} (1=OK)"
  echo "  - Probe 3 (Relay & Fleet Overview): ${RELAY_HEALTHY} (1=OK)"
  systemctl status mybot.service --no-pager || true
  journalctl -u mybot.service -n 80 --no-pager || true
  pm2 status || true
  false
fi
echo "[OK] Cả 3 probe độc lập đều đạt chuẩn (healthy / ok / relayed)!"
trap - ERR

SERVER_IP="$(curl -fsSL --max-time 4 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"
ADMIN_USER="$(grep -E '^DASHBOARD_ADMIN_USERNAME=' /etc/mybot/mybot.env | cut -d'=' -f2- | tr -d '"' || echo 'admin')"

/usr/local/bin/mybot-ctl doctor --assets-dir /opt/mybot/assets || true

echo ""
echo "╔══════════════════════════════════════════════════════════════════════════════╗"
echo "║  MYBOT V4 đã khởi động và API health trả healthy trên VPS.                  ║"
echo "╠══════════════════════════════════════════════════════════════════════════════╣"
echo "║  🌐 Mở ngay trên trình duyệt : http://${SERVER_IP}:4173"
echo "║  👤 Tài khoản Web Admin      : ${ADMIN_USER}"
echo "║  🔑 Mật khẩu Web Admin       : xem trong /etc/mybot/mybot.env trên VPS"
echo "╠══════════════════════════════════════════════════════════════════════════════╣"
echo "║  💡 Bạn KHÔNG cần dùng Terminal nữa! Hãy mở link trên để quét QR Zalo,       ║"
echo "║     đổi mật khẩu Web, quản lý đội Bot và bật 17 khiên Anti từ xa 24/7.       ║"
echo "╚══════════════════════════════════════════════════════════════════════════════╝"
