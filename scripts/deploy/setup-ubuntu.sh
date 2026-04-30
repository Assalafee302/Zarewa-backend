#!/usr/bin/env bash
# One-shot Ubuntu setup: Node 20, zarewa user, SQLite dir, npm build, systemd, nginx.
# Run ON the EC2/Lightsail instance after cloning this repo (must use sudo).
#
#   export ZAREWA_PUBLIC_URL=https://your.domain     # or http://YOUR_ELASTIC_IP
#   export ZAREWA_DOMAIN=your.domain                  # optional; for nginx server_name + certbot
#   export CERTBOT_EMAIL=you@example.com              # optional; if set with DOMAIN, runs certbot
#   sudo -E bash scripts/deploy/setup-ubuntu.sh
#
# Optional: APP_DIR=/opt/zarewa/app  (defaults to repo root next to this script)

set -euo pipefail

if [[ "${EUID:-}" -ne 0 ]]; then
  echo "Run with sudo, e.g.: sudo -E bash scripts/deploy/setup-ubuntu.sh"
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_APP="$(cd "$SCRIPT_DIR/../.." && pwd)"
APP_DIR="${APP_DIR:-$DEFAULT_APP}"

if [[ ! -f "$APP_DIR/package.json" ]]; then
  echo "No package.json in APP_DIR=$APP_DIR — clone the repo there or set APP_DIR."
  exit 1
fi

ZAREWA_USER="${ZAREWA_USER:-zarewa}"
ZAREWA_DB_PATH="${ZAREWA_DB_PATH:-/var/lib/zarewa/zarewa.sqlite}"
PUBLIC_URL="${ZAREWA_PUBLIC_URL:-}"
DOMAIN="${ZAREWA_DOMAIN:-}"

if [[ -z "$PUBLIC_URL" ]]; then
  if [[ -n "$DOMAIN" ]]; then
    PUBLIC_URL="https://${DOMAIN}"
  else
    echo "Set ZAREWA_PUBLIC_URL to the URL users open (e.g. https://app.example.com or http://1.2.3.4)."
    exit 1
  fi
fi

# HTTP trial (IP only): must disable Secure cookies even in production.
COOKIE_SECURE=0
if [[ "$PUBLIC_URL" == https://* ]]; then
  COOKIE_SECURE=1
fi

echo "==> APT: base packages"
apt-get update -y
apt-get install -y --no-install-recommends \
  ca-certificates curl git nginx python3 python3-certbot-nginx \
  build-essential

echo "==> Node.js 20.x (NodeSource)"
if ! command -v node >/dev/null 2>&1 || [[ "$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)" -lt 20 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
NODE_BIN="$(command -v node)"
echo "Using node: $NODE_BIN ($("$NODE_BIN" -v))"

echo "==> User $ZAREWA_USER + data dir"
if ! id -u "$ZAREWA_USER" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "/home/$ZAREWA_USER" --shell /bin/bash "$ZAREWA_USER"
fi
mkdir -p "$(dirname "$ZAREWA_DB_PATH")"
chown -R "$ZAREWA_USER:$ZAREWA_USER" "$(dirname "$ZAREWA_DB_PATH")"

echo "==> App permissions + npm ci + build + migrate"
chown -R "$ZAREWA_USER:$ZAREWA_USER" "$APP_DIR"
sudo -u "$ZAREWA_USER" -H bash -lc "
  set -euo pipefail
  cd \"$APP_DIR\"
  npm ci
  npm run build
  ZAREWA_DB=\"$ZAREWA_DB_PATH\" npm run db:migrate
"

ENV_FILE="$APP_DIR/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "==> Creating $ENV_FILE"
  umask 077
  cat >"$ENV_FILE" <<EOF
NODE_ENV=production
PORT=8787
ZAREWA_DB=$ZAREWA_DB_PATH
CORS_ORIGIN=$PUBLIC_URL
COOKIE_SECURE=$COOKIE_SECURE
EOF
  chown "$ZAREWA_USER:$ZAREWA_USER" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
else
  echo "==> Keeping existing $ENV_FILE (verify CORS_ORIGIN=$PUBLIC_URL and COOKIE_SECURE for HTTPS)"
fi

echo "==> systemd: zarewa.service"
cat >/etc/systemd/system/zarewa.service <<EOF
[Unit]
Description=Zarewa API + web UI
After=network.target

[Service]
Type=simple
User=$ZAREWA_USER
Group=$ZAREWA_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$NODE_BIN server/index.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable zarewa
systemctl restart zarewa
sleep 1
systemctl is-active --quiet zarewa || (journalctl -u zarewa -n 40 --no-pager; exit 1)

echo "==> Local health check"
curl -sfS "http://127.0.0.1:8787/api/health" | head -c 200 || true
echo

NGINX_SERVER_NAME="${DOMAIN:-_}"
echo "==> nginx reverse proxy (server_name $NGINX_SERVER_NAME)"
cat >/etc/nginx/sites-available/zarewa <<EOF
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name $NGINX_SERVER_NAME;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 120s;
    }
}
EOF
rm -f /etc/nginx/sites-enabled/default
ln -sf /etc/nginx/sites-available/zarewa /etc/nginx/sites-enabled/zarewa
nginx -t
systemctl reload nginx

if [[ -n "${CERTBOT_EMAIL:-}" && -n "$DOMAIN" ]]; then
  echo "==> Let's Encrypt (certbot)"
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$CERTBOT_EMAIL" --redirect
  systemctl reload nginx
  echo "If CORS_ORIGIN was http://, update .env to https://$DOMAIN and: sudo systemctl restart zarewa"
else
  echo "==> TLS: skipped (set CERTBOT_EMAIL + ZAREWA_DOMAIN and re-run certbot when DNS points here):"
  echo "    sudo certbot --nginx -d your.domain --agree-tos -m you@example.com"
fi

echo "
Done.
  App:     $PUBLIC_URL
  Service: sudo systemctl status zarewa
  Logs:    sudo journalctl -u zarewa -f
  SQLite:  $ZAREWA_DB_PATH
Next: point DNS A/AAAA record to this host; open EC2 security group for 80/443; rotate seeded passwords (docs/DEPLOYMENT.md).
"
