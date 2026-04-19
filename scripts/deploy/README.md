# Deploy on Ubuntu (AWS EC2 / Lightsail / any VPS)

We cannot run AWS or SSH for you. After you create the VM and open the firewall, **run the installer on the server**.

## What you do once (AWS console)

1. **EC2** → Launch **Ubuntu 22.04 or 24.04** LTS, add **security group** rules: **SSH 22** (your IP), **HTTP 80**, **HTTPS 443** (world or your office).
2. **Elastic IP** (optional) → attach so the address does not change.
3. **DNS** (optional) → `A` record for your hostname → instance public IP.

## What you do on the VM (SSH)

```bash
# 1) SSH in (replace key path and host)
ssh -i ~/.ssh/your-key.pem ubuntu@YOUR_PUBLIC_IP

# 2) Clone your fork/repo (HTTPS or SSH)
sudo mkdir -p /opt/zarewa && sudo chown "$USER:$USER" /opt/zarewa
cd /opt/zarewa
git clone YOUR_REPO_URL app
cd app

# 3) Run the installer (pick ONE style)

# --- If you have a domain and DNS already points here ---
export ZAREWA_PUBLIC_URL=https://zarewa.example.com
export ZAREWA_DOMAIN=zarewa.example.com
export CERTBOT_EMAIL=you@example.com
sudo -E bash scripts/deploy/setup-ubuntu.sh

# --- IP-only trial (HTTP) ---
export ZAREWA_PUBLIC_URL=http://YOUR_PUBLIC_IP
sudo -E bash scripts/deploy/setup-ubuntu.sh
```

If the script is not executable:

```bash
chmod +x scripts/deploy/setup-ubuntu.sh
```

## After install

- Browser: open `ZAREWA_PUBLIC_URL`.
- Health: `curl -sS http://127.0.0.1:8787/api/health`
- Edit secrets/env: `sudo -u zarewa nano /opt/zarewa/app/.env` then `sudo systemctl restart zarewa`.

## Copy your existing SQLite from a laptop

```bash
# From your PC (example)
scp -i ~/.ssh/your-key.pem ./data/zarewa.sqlite ubuntu@YOUR_PUBLIC_IP:/tmp/zarewa.sqlite
# On the server
sudo install -o zarewa -g zarewa -m 600 /tmp/zarewa.sqlite /var/lib/zarewa/zarewa.sqlite
sudo systemctl restart zarewa
```

## Updates

```bash
cd /opt/zarewa/app
sudo systemctl stop zarewa
git pull
sudo -u zarewa -H bash -lc 'cd /opt/zarewa/app && npm ci && npm run build && ZAREWA_DB=/var/lib/zarewa/zarewa.sqlite npm run db:migrate'
sudo systemctl start zarewa
```

See also [../../docs/DEPLOYMENT.md](../../docs/DEPLOYMENT.md) and [../../docs/ENVIRONMENT.md](../../docs/ENVIRONMENT.md).
