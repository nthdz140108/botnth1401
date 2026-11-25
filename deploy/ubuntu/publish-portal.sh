#!/usr/bin/env bash
set -euo pipefail
domain="${1:?domain required}"
[[ "$domain" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$ ]] || { echo 'Invalid domain' >&2; exit 2; }
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y nginx certbot python3-certbot-nginx
cat > "/etc/nginx/sites-available/mybot-portal" <<NGINX
server {
  listen 80;
  server_name $domain;
  client_max_body_size 11m;
  location / {
    proxy_pass http://127.0.0.1:4180;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_buffering off;
    proxy_read_timeout 90s;
  }
}
NGINX
ln -sfn /etc/nginx/sites-available/mybot-portal /etc/nginx/sites-enabled/mybot-portal
nginx -t
systemctl reload nginx
certbot --nginx -d "$domain" --non-interactive --agree-tos --register-unsafely-without-email --redirect
echo "Portal: https://$domain"
