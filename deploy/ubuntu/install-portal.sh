#!/usr/bin/env bash
# Idempotent prerequisite setup. Does not start services or change existing bot ownership.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo 'Portal setup requires root' >&2; exit 1; }
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y postgresql postgresql-client pkg-config libssl-dev build-essential ca-certificates curl
systemctl enable --now postgresql
if ! id mybot-portal >/dev/null 2>&1; then useradd --system --home-dir /var/lib/mybot-portal --shell /usr/sbin/nologin mybot-portal; fi
install -d -m750 -o mybot-portal -g mybot-portal /var/lib/mybot-portal
install -d -m700 /etc/mybot
if [[ ! -f /etc/mybot/portal.env ]]; then
  umask 077
  secret="$(cd /opt/mybot/current && node --input-type=module -e 'import fs from "node:fs"; import dotenv from "dotenv"; const e=dotenv.parse(fs.readFileSync("/opt/mybot/.env")); const s=e.INTERNAL_API_SECRET; if(!s || !/^[A-Za-z0-9_./+=:-]{32,}$/.test(s)) process.exit(2); process.stdout.write(s)' )" || { echo 'Configure INTERNAL_API_SECRET (at least 32 safe ASCII characters) in /opt/mybot/.env before portal setup.' >&2; exit 1; }
  api_pw="$(openssl rand -hex 24)"; worker_pw="$(openssl rand -hex 24)"; migrator_pw="$(openssl rand -hex 24)"
  runuser -u postgres -- psql -v ON_ERROR_STOP=1 <<SQL
SELECT 'CREATE ROLE mybot_portal_migrator LOGIN BYPASSRLS' WHERE NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='mybot_portal_migrator')\gexec
SELECT 'CREATE ROLE mybot_portal_api LOGIN NOSUPERUSER NOBYPASSRLS' WHERE NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='mybot_portal_api')\gexec
SELECT 'CREATE ROLE mybot_portal_worker LOGIN NOSUPERUSER BYPASSRLS' WHERE NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='mybot_portal_worker')\gexec
ALTER ROLE mybot_portal_migrator PASSWORD '$migrator_pw';
ALTER ROLE mybot_portal_api PASSWORD '$api_pw';
ALTER ROLE mybot_portal_worker PASSWORD '$worker_pw';
SELECT 'CREATE DATABASE mybot_portal OWNER mybot_portal_migrator' WHERE NOT EXISTS(SELECT 1 FROM pg_database WHERE datname='mybot_portal')\gexec
SQL
  {
    printf 'DATABASE_URL=postgresql://mybot_portal_api:%s@127.0.0.1/mybot_portal\n' "$api_pw"
    printf 'PORTAL_WORKER_DATABASE_URL=postgresql://mybot_portal_worker:%s@127.0.0.1/mybot_portal\n' "$worker_pw"
    printf 'PORTAL_MIGRATION_DATABASE_URL=postgresql://mybot_portal_migrator:%s@127.0.0.1/mybot_portal\n' "$migrator_pw"
    printf 'INTERNAL_API_SECRET=%s\n' "$secret"
    printf '%s\n' 'MYBOT_BRIDGE_URL=http://127.0.0.1:4174' 'PORTAL_BIND=127.0.0.1:4180' 'PORTAL_SECURE_COOKIE=true' 'LEPTOS_OUTPUT_NAME=mybot-portal' 'LEPTOS_SITE_ROOT=/opt/mybot/current/portal-site' 'LEPTOS_SITE_PKG_DIR=pkg' 'LEPTOS_SITE_ADDR=127.0.0.1:4180' 'RUST_LOG=info'
  } > /etc/mybot/portal.env
fi
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
install -m644 "$script_dir/mybot-portal.service" /etc/systemd/system/mybot-portal.service
install -m644 "$script_dir/mybot-portal-worker.service" /etc/systemd/system/mybot-portal-worker.service
systemctl daemon-reload
systemctl enable mybot-portal.service mybot-portal-worker.service
echo 'Portal prerequisites ready; services start only after a verified release build.'
