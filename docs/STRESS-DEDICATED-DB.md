# Dedicated SQLite stress database

Use a separate file so your normal dev database (`data/zarewa.sqlite`) is never wiped.

## Paths

- **Stress DB (recommended):** `data/stress.sqlite`
- **Default dev DB:** `data/zarewa.sqlite`
- **Playwright E2E:** `data/playwright.sqlite` (recreated when the e2e server starts)

## Wipe and recreate the stress database

1. Stop any API process that has `data/stress.sqlite` open.
2. From the repo root (PowerShell):

```powershell
$env:ZAREWA_DB = 'data/stress.sqlite'
npm run db:wipe
```

3. Start the API with the same variable:

```powershell
$env:ZAREWA_DB = 'data/stress.sqlite'
npm run server
```

The next boot creates schema, runs migrations, and seeds empty tables.

## Run the 50-scenario lifecycle stress script

With the API listening (default port `8787`):

```powershell
$env:STRESS_API_URL = 'http://127.0.0.1:8787'
npm run stress:lifecycle
```

Optional:

- **Slice:** `$env:STRESS_FROM='0'; $env:STRESS_TO='9'` — first 10 scenarios only.
- **Stable keys:** `$env:STRESS_RUN_KEY='MYRUN1'`
- **Skip bootstrap hammer:** `$env:STRESS_SKIP_PHASE2='1'`
- **Multi-user refund smoke** (sales.staff → sales.manager): enabled by default; disable with `$env:STRESS_MULTIUSER_REFUND='0'`

## Reports

After a run, see:

- `scripts/output/fifty-lifecycle-report.json`
- `scripts/output/fifty-lifecycle-report.csv`

## Safety

Never point `ZAREWA_DB` at a production database path. This workflow is for local and CI-style SQLite only.
