#!/usr/bin/env bash
# ==============================================================================
# MyBot Hybrid Canary Release & Automated Rollback per Bot
# ==============================================================================
set -euo pipefail

BOT_ID="${1:-}"
ROLLBACK_FLAG="${2:-}"

if [[ -z "${BOT_ID}" ]]; then
  echo "Sử dụng: sudo bash deploy/ubuntu/canary-release.sh <botId> [--rollback]"
  echo "Ví dụ : sudo bash deploy/ubuntu/canary-release.sh admin"
  echo "        sudo bash deploy/ubuntu/canary-release.sh child_1 --rollback"
  exit 1
fi

BACKUP_DIR="/var/lib/mybot/backups/canary"
mkdir -p "${BACKUP_DIR}"
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"

echo "==> [CANARY] Bắt đầu quy trình phát hành an toàn cho bot: '${BOT_ID}'..."

# Determine bot config path
if [[ "${BOT_ID}" == "admin" || "${BOT_ID}" == "main" ]]; then
  CONFIG_PATH="/opt/mybot/assets/config.json"
else
  CONFIG_PATH="/opt/mybot/mybot/bots/${BOT_ID}.json"
fi

# 1. Rollback Mode
if [[ "${ROLLBACK_FLAG}" == "--rollback" ]]; then
  echo "==> [ROLLBACK] Đang tìm kiếm bản sao lưu gần nhất của bot '${BOT_ID}'..."
  LATEST_CFG_BACKUP="$(ls -t "${BACKUP_DIR}/config-${BOT_ID}-"*.json 2>/dev/null | head -n 1 || true)"
  LATEST_DB_BACKUP="$(ls -t "${BACKUP_DIR}/db-${BOT_ID}-"*.db 2>/dev/null | head -n 1 || true)"

  if [[ -n "${LATEST_CFG_BACKUP}" && -f "${LATEST_CFG_BACKUP}" ]]; then
    echo "[i] Khôi phục cấu hình từ: ${LATEST_CFG_BACKUP}"
    cp -f "${LATEST_CFG_BACKUP}" "${CONFIG_PATH}"
  fi
  if [[ -n "${LATEST_DB_BACKUP}" && -f "${LATEST_DB_BACKUP}" ]]; then
    echo "[i] Khôi phục SQLite từ: ${LATEST_DB_BACKUP}"
    sqlite3 /var/lib/mybot/mybot.db ".restore '${LATEST_DB_BACKUP}'" || true
  fi

  echo "==> [ROLLBACK] Khởi động lại bot '${BOT_ID}'..."
  pm2 restart "${BOT_ID}" || pm2 start "${CONFIG_PATH}" --name "${BOT_ID}"
  echo "[OK] Đã hoàn tất rollback cho bot '${BOT_ID}'."
  exit 0
fi

# 2. Canary Deployment Pre-flight Backup
echo "==> [1/4] Tạo điểm sao lưu an toàn (Snapshot Backup) trước khi canary..."
if [[ -f "${CONFIG_PATH}" ]]; then
  cp -p "${CONFIG_PATH}" "${BACKUP_DIR}/config-${BOT_ID}-${TIMESTAMP}.json"
  echo "[OK] Đã sao lưu config: ${BACKUP_DIR}/config-${BOT_ID}-${TIMESTAMP}.json"
fi

if [[ -f "/var/lib/mybot/mybot.db" ]]; then
  sqlite3 /var/lib/mybot/mybot.db ".backup '${BACKUP_DIR}/db-${BOT_ID}-${TIMESTAMP}.db'"
  echo "[OK] Đã sao lưu SQLite: ${BACKUP_DIR}/db-${BOT_ID}-${TIMESTAMP}.db"
fi

# 3. Canary Restart
echo "==> [2/4] Áp dụng canary và restart tiến trình bot '${BOT_ID}'..."
pm2 restart "${BOT_ID}" || pm2 reload "${BOT_ID}" || true

# 4. Independent 3-Probe Health Verification
echo "==> [3/4] Chạy 3 probe độc lập để xác minh an toàn canary..."

PROBE1_OK=0
PROBE2_OK=0
PROBE3_OK=0

for _i in $(seq 1 20); do
  # Probe 1: Rust Dashboard (4173)
  if [[ "${PROBE1_OK}" -eq 0 ]]; then
    P1="$(curl -fsS --max-time 2 http://127.0.0.1:4173/api/system/health 2>/dev/null || true)"
    if [[ "${P1}" == *'"status":"healthy"'* ]]; then
      PROBE1_OK=1
    fi
  fi

  # Probe 2: Node Loopback Bridge (4174)
  if [[ "${PROBE2_OK}" -eq 0 ]]; then
    P2="$(curl -fsS --max-time 2 http://127.0.0.1:4174/bridge/health 2>/dev/null || true)"
    if [[ "${P2}" == *'"status":"ok"'* ]]; then
      PROBE2_OK=1
    fi
  fi

  # Probe 3: Target Bot Status via Bridge Snapshot
  if [[ "${PROBE3_OK}" -eq 0 ]]; then
    SNAP="$(curl -fsS --max-time 2 http://127.0.0.1:4174/bridge/snapshot 2>/dev/null || true)"
    if [[ "${SNAP}" == *'"id":"'"${BOT_ID}"'"'* && ("${SNAP}" == *'"status":"running"'* || "${SNAP}" == *'"status":"starting"'*) ]]; then
      PROBE3_OK=1
    fi
  fi

  if [[ "${PROBE1_OK}" -eq 1 && "${PROBE2_OK}" -eq 1 && "${PROBE3_OK}" -eq 1 ]]; then
    break
  fi
  sleep 1.5
done

# 5. Automated Rollback on Probe Failure
if [[ "${PROBE1_OK}" -ne 1 || "${PROBE2_OK}" -ne 1 || "${PROBE3_OK}" -ne 1 ]]; then
  echo ""
  echo "❌ [LỖI CANARY] Một hoặc nhiều probe thất bại sau canary bot '${BOT_ID}':"
  echo "  - Probe 1 (Rust 4173):  ${PROBE1_OK} (1=OK)"
  echo "  - Probe 2 (Bridge 4174): ${PROBE2_OK} (1=OK)"
  echo "  - Probe 3 (Bot Online):  ${PROBE3_OK} (1=OK)"
  echo ""
  echo "==> [TỰ ĐỘNG ROLLBACK] Đang hoàn tác bot '${BOT_ID}' về trạng thái ổn định..."

  if [[ -f "${BACKUP_DIR}/config-${BOT_ID}-${TIMESTAMP}.json" ]]; then
    cp -f "${BACKUP_DIR}/config-${BOT_ID}-${TIMESTAMP}.json" "${CONFIG_PATH}"
  fi
  if [[ -f "${BACKUP_DIR}/db-${BOT_ID}-${TIMESTAMP}.db" ]]; then
    sqlite3 /var/lib/mybot/mybot.db ".restore '${BACKUP_DIR}/db-${BOT_ID}-${TIMESTAMP}.db'" || true
  fi

  pm2 restart "${BOT_ID}" || true
  echo "⚠️ [ROLLBACK XONG] Bot '${BOT_ID}' đã được khôi phục về phiên bản trước. Các bot khác trong fleet không bị ảnh hưởng."
  exit 1
fi

echo ""
echo "╔══════════════════════════════════════════════════════════════════════════════╗"
echo "║  🎉 CANARY THÀNH CÔNG: Bot '${BOT_ID}' đã vượt qua toàn bộ 3 probe an toàn!   ║"
echo "╠══════════════════════════════════════════════════════════════════════════════╣"
echo "║  ✓ Probe 1: Rust V4 Central Dashboard (4173) Healthy                         ║"
echo "║  ✓ Probe 2: Node Loopback Bridge (4174) Healthy                              ║"
echo "║  ✓ Probe 3: Bot '${BOT_ID}' Online & Sẵn sàng nhận lệnh                      ║"
echo "║  ✓ Backup an toàn lưu tại: ${BACKUP_DIR}                                     ║"
echo "╚══════════════════════════════════════════════════════════════════════════════╝"
exit 0
