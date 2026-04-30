# Production deployment checklist

Use this as a cutover guide; adjust host names, secrets, and backup strategy to your environment.

## Before go-live

1. **Node** — Use the same major Node version as CI (see `.github/workflows/ci.yml`) to avoid subtle build/runtime differences.
2. **Environment** — Set variables documented in [ENVIRONMENT.md](./ENVIRONMENT.md): database path, `CORS_ORIGIN` for your public URL, cookie flags for HTTPS, and any branch/workspace defaults.
3. **Database** — Run migrations on the production DB (`npm run db:migrate` or your orchestration equivalent). Take a **backup** before migrating live data.
4. **Build** — `npm ci` and `npm run build`; run `node server/index.js` (or your process manager). If `dist/index.html` exists, the server serves the SPA and `/api` on the **same origin**; you can still put nginx/Caddy in front for TLS only.
5. **HTTPS** — Session cookies should be `Secure` in production; align `SameSite` with how the UI and API share a domain.
6. **Secrets** — Do not commit `.env`; rotate any demo or shared passwords before real users log in.
7. **Smoke** — Log in as each critical role (CEO exec view, MD, branch manager, finance, HR) and confirm expected routes and 403s match [ACCESS_CONTROL.md](./ACCESS_CONTROL.md).

## After go-live

- Monitor API logs and disk use (SQLite file growth, WAL if enabled).
- Schedule backups of the SQLite file (and WAL/shm if present) on a cadence that matches your RPO.

## Release verification (local or staging)

```bash
npm run verify:complete
```

This runs a production build, the full Vitest suite, and all Playwright specs under `e2e/`.

---

## Ubuntu VM (trial or production)

**Automated path (recommended):** on the server, clone the repo and run `sudo -E bash scripts/deploy/setup-ubuntu.sh` with `ZAREWA_PUBLIC_URL` set — see [scripts/deploy/README.md](../scripts/deploy/README.md).

Prerequisites: **Node 20** (match CI), `build-essential` if `better-sqlite3` must compile on your arch, outbound HTTPS for `npm ci`.

### 1. Deploy user and app directory

```bash
sudo adduser --disabled-password --gecos "" zarewa
sudo mkdir -p /opt/zarewa && sudo chown zarewa:zarewa /opt/zarewa
sudo -u zarewa -H bash -c '
  cd /opt/zarewa
  git clone <YOUR_REPO_URL> app
  cd app
  npm ci
  npm run build
'
```

### 2. Database and migrations

```bash
sudo install -d -o zarewa -g zarewa /var/lib/zarewa
sudo -u zarewa -H bash -c '
  cd /opt/zarewa/app
  export ZAREWA_DB=/var/lib/zarewa/zarewa.sqlite
  npm run db:migrate
'
```

Copy an existing SQLite file into `/var/lib/zarewa/` if you are restoring a backup instead of a fresh DB.

### 3. Environment file (not committed)

Create `/opt/zarewa/app/.env` owned by `zarewa` (mode `600`):

```bash
NODE_ENV=production
PORT=8787
ZAREWA_DB=/var/lib/zarewa/zarewa.sqlite
# Public URL users type in the browser (no trailing slash). Required for CORS when using TLS + hostname.
CORS_ORIGIN=https://zarewa.example.com
COOKIE_SECURE=1
```

Sessions are opaque tokens stored in the database (not JWT env vars). Rotate **user passwords** after go-live; see [ENVIRONMENT.md](./ENVIRONMENT.md) for optional toggles.

Load it in systemd (below) with `EnvironmentFile=` or export variables in the service. See [ENVIRONMENT.md](./ENVIRONMENT.md) for the full list.

### 4. systemd unit (Node serves UI + API)

When `dist/index.html` exists, `server/app.js` serves the Vite build from `dist/` and keeps `/api` on the same origin—no separate static server.

`/etc/systemd/system/zarewa.service`:

```ini
[Unit]
Description=Zarewa API + web UI
After=network.target

[Service]
Type=simple
User=zarewa
Group=zarewa
WorkingDirectory=/opt/zarewa/app
EnvironmentFile=/opt/zarewa/app/.env
ExecStart=/usr/bin/node server/index.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now zarewa
sudo systemctl status zarewa
```

Smoke: `curl -sS http://127.0.0.1:8787/api/health`

### 5. HTTPS reverse proxy (recommended)

Expose **nginx** or **Caddy** on ports 80/443 and proxy to `127.0.0.1:8787`. Example **nginx** server block:

```nginx
server {
  listen 443 ssl http2;
  server_name zarewa.example.com;
  # ssl_certificate / path from certbot or your CA

  location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

After TLS is in front of the app, keep `CORS_ORIGIN` aligned with `https://` + that hostname and `COOKIE_SECURE=1`.

### 6. Updates

```bash
sudo systemctl stop zarewa
sudo -u zarewa -H bash -c '
  cd /opt/zarewa/app
  git pull
  npm ci
  npm run build
  export $(grep -v "^#" .env | xargs)
  npm run db:migrate
'
sudo systemctl start zarewa
```

### 7. Trial hygiene

Rotate seeded passwords, restrict SSH and firewall to admin IPs if possible, and back up `/var/lib/zarewa/zarewa.sqlite` (and any `-wal` / `-shm` files if present) on a schedule appropriate for the trial.
