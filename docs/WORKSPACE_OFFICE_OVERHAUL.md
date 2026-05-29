# Zarewa Online Office Workspace — Overhaul

Professional office desk replacing Gmail-style workspace UI. Branch scope and bootstrap architecture are unchanged.

## Feature flag

Frontend: set `VITE_OFFICE_DESK_V2=1` in `.env.local` (see `Zarewa-frontend-main/.env.example`).

When off: legacy `Dashboard.jsx` + `GmailStyleWorkspace.jsx`.  
When on: `WorkspaceDesk.jsx` + `OfficeDeskShell.jsx`.

## Save-point commands

### SP0 — Harness

```bash
cd Zarewa-frontend-main && npm run build
cd Zarewa-backend-main && npm run test -- server/workspaceDeskOps.test.js
```

### SP1 — Design

```bash
cd Zarewa-frontend-main && npm run test -- src/lib/workspaceDeskNav.test.js src/lib/officeRecordStatus.test.js
```

### SP2 — Desk shell

```bash
cd Zarewa-frontend-main && npm run lint && npm run build
cd Zarewa-backend-main && npm run test:e2e -- e2e/smoke.spec.js e2e/workspace-office-desk.spec.js
```

### Wave 1 gate

```bash
cd Zarewa-frontend-main && npm run verify:ci && npm run test
cd Zarewa-backend-main && npm run test -- server/officeOps.test.js server/confidentialMemo.test.js shared/workspaceGovernance.test.js shared/lib/officeApprovalRouting.test.js server/officeRecordOps.test.js
cd Zarewa-backend-main && npm run test:e2e -- e2e/workspace-office-desk.spec.js e2e/smoke.spec.js
```

### Final gate

```bash
cd Zarewa-frontend-main && npm run verify:ci
cd Zarewa-backend-main && npm run test && npm run test:e2e -- e2e/workspace-office-desk.spec.js e2e/smoke.spec.js e2e/complete-gate.spec.js
```

## Playwright golden paths

| ID | Spec test name |
|----|----------------|
| GP1 | create fuel office record via wizard |
| GP2 | branch manager convert to expense |
| GP3 | record detail timeline and print |
| GP4 | file record filing number |
| GP5 | acknowledge official notice |
| GP6 | forum suggest create record |
| GP7 | returned to me tab |
| GP8 | search by filing number |

## Manual print QA

1. Print thread conversation  
2. Print case pack  
3. Print internal memo A4 pack  
4. Print expense convert draft  
5. Print filed record certificate  
6. Print official notice  

Allow pop-ups or confirm in-page preview fallback toast.

## MySQL integration tests

Office data-layer tests (`officeRecordOps`, `filingNumberOps`, `officialNoticesOps`, `forumOps`) run against MySQL when env is set:

| Variable | Purpose |
|----------|---------|
| `ZAREWA_MYSQL_HOST` | MySQL host (e.g. `127.0.0.1`) |
| `ZAREWA_MYSQL_USER` | Database user |
| `ZAREWA_MYSQL_PASSWORD` | Password |
| `ZAREWA_MYSQL_DATABASE` | Schema name |

```bash
cd Zarewa-backend-main
# export ZAREWA_MYSQL_* then:
npm run test:office-mysql
```

This runs migrations then the integration pack. Without env, the script exits 0 with a skip message; vitest suites use `describe.skipIf` when MySQL is not configured.

### CI (optional)

Add a job that sets `ZAREWA_MYSQL_*` from secrets and runs `npm run test:office-mysql` on PRs touching `server/office*` or `server/forum*`.
