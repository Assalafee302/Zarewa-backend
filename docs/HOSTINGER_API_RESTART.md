# Hostinger API — 503 Service Unavailable

A **Hostinger HTML 503** page (not JSON from Zarewa) means the **Node process is not running** or the proxy cannot reach it. The API code may be fine; the app must be **restarted** after `git pull`.

## Fix (SSH or hPanel File Manager)

From the backend repo root (e.g. `/home/u172282559/domains/api.zarewaglobalservices.com`):

**Stop the old process before starting the new one.** Overlapping boots fight over MySQL
`GET_LOCK('zarewa_mig_<database>')` and the new process fails with
`Could not acquire schema lock … within 120s`. Prefer **Stop → Start** in hPanel (not a
rolling Restart), or run `scripts/hostinger-deploy.sh` which `pkill`s the old
`server/index.js` first. On SIGTERM the API closes the MySQL pool so the lock is released.

```bash
# Optional one-shot: stop → pull → boot-check (then Start in hPanel)
bash scripts/hostinger-deploy.sh

# Or manually:
pkill -f 'server/index.js' || true
sleep 2
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

Then **Stop** (wait until down) and **Start** the Node.js application — do not leave two
instances booting against the same MySQL schema.

If the app was down because boot seed timed out, `NODE_ENV=production` lets the API listen in seconds instead of minutes.

If logs show a schema/migration lock timeout, they include the **holder connection id**
(and whether it is missing from `processlist` = dead/orphan). Inspect or kill with:

```bash
node scripts/diagnose-migration-lock.mjs
node scripts/diagnose-migration-lock.mjs --kill
```

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
