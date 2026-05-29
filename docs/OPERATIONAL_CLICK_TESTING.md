# Operational UI click testing (Playwright)

## Prerequisites

1. **MySQL** running on `127.0.0.1:3306` (XAMPP, MariaDB, or MySQL Installer on Windows).
2. Repo-root **`.env`** from `.env.example` with `ZAREWA_MYSQL_PASSWORD` set.
3. E2E database (created automatically on first run): `zarewa_e2e`.

```powershell
cd Zarewa-backend-main
copy .env.example .env
# Edit ZAREWA_MYSQL_PASSWORD
npm run wipe:e2e-db   # optional fresh E2E data
```

## Run click tests

```powershell
cd Zarewa-backend-main
npm run test:e2e -- e2e/workspace-office-desk.spec.js
npm run test:e2e -- e2e/smoke.spec.js
npm run test:e2e -- e2e/operational-scenarios-click.spec.js
```

All three together (~15–25 min first run while Vite + API start):

```powershell
npm run test:e2e -- e2e/workspace-office-desk.spec.js e2e/smoke.spec.js e2e/operational-scenarios-click.spec.js
```

## What each pack covers

| Spec | Clicks |
|------|--------|
| `workspace-office-desk.spec.js` | Desk nav, create record, HQ block, forum→wizard, notices ack, action bar |
| `smoke.spec.js` | Login, sidebar modules, settings governance, procurement role |
| `operational-scenarios-click.spec.js` | All core modules + sales/procurement/ops/finance shells |

## If MySQL is not running

Playwright fails with `ECONNREFUSED 127.0.0.1:3306` or `Timeout waiting for .../api/health`.

Start MySQL service, then re-run. There is no SQLite mode for E2E — only Vitest pure tests work offline.

## Map to ~1,000 Zare SOPs

Each Playwright test is a **golden path**; full SOP list lives in `shared/lib/helpOperationalCatalog.js` (111 topics × ~9 phrasings). Use the canvas `zarewa-roofing-ux-scenarios` for manual walkthrough of the rest.
