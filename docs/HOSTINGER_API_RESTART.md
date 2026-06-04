# Hostinger API — 503 Service Unavailable

A **Hostinger HTML 503** page (not JSON from Zarewa) means the **Node process is not running** or the proxy cannot reach it. The API code may be fine; the app must be **restarted** after `git pull`.

## Fix (SSH or hPanel File Manager)

From the backend repo root (e.g. `/home/u172282559/domains/api.zarewaglobalservices.com`):

```bash
git pull origin main
npm ci --omit=dev
node scripts/hostinger-boot-check.mjs
```

**hPanel → Node.js app → Environment variables** (required for fast boot):

| Variable | Value |
|----------|--------|
| `NODE_ENV` | `production` |
| `PORT` | (leave Hostinger default — do not hard-code 8787 unless hPanel says so) |
| `ZAREWA_MYSQL_HOST` | `localhost` (on-server MySQL) |
| `ZAREWA_MYSQL_*` | match hPanel MySQL database |

Optional: `ZAREWA_SKIP_BOOT_SEED=1` (same effect as `NODE_ENV=production` — skips heavy seed on restart).

**Application startup file:** `server/index.js`  
**Run command:** `npm start`

Then **Restart** the Node.js application.

If the app was down because boot seed timed out, `NODE_ENV=production` lets the API listen in seconds instead of minutes.

## Verify

```bash
curl -sS https://api.zarewaglobalservices.com/api/health
```

Expect JSON with `"ok":true` and `"capabilities":{"trialExceptionsB3a":"v1",...}`.

If JSON shows `"ok":false,"degraded":true`, MySQL/env failed but Node is up — fix `ZAREWA_MYSQL_*` in the app `.env` and restart again.

## Node binary (SSH)

If `node` is not in PATH:

```bash
/opt/alt/alt-nodejs20/root/usr/bin/node scripts/hostinger-boot-check.mjs
```

Entry file for hPanel must be: **`server/index.js`** (see `package.json` `"start"`).
