#!/usr/bin/env bash
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo 'Run as root' >&2; exit 1; }
backup_dir=/var/backups/mybot-portal
install -d -m700 "$backup_dir"
backup="$backup_dir/portal-$(date -u +%Y%m%dT%H%M%SZ).dump"
umask 077
runuser -u postgres -- pg_dump -Fc mybot_portal > "$backup"
test -s "$backup"
runuser -u postgres -- pg_restore --list < "$backup" >/dev/null
echo "$backup"
