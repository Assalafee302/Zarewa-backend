# HR E2E + Stress Testing

## What’s covered
- **Staff onboarding**: `POST /api/hr/staff/register`
- **Staff self-service**: submit leave/loan requests
- **Approvals**: HR review + executive (manager) review
- **Finance disbursement**: payment request approve + pay → loan becomes *disbursed*
- **Payroll**: create run → recompute → lock → mark paid
- **Loan deductions**: appear on recompute; repayment counters update when run is marked **paid**
- **Leave balances**: recompute + read balances for validation

## Run HR suites (default)
Runs the HR happy-path and edge-case suites.

```powershell
npm run test:e2e:hr
```

## Run HR suites (full)
Includes attendance and role-matrix suites too.

```powershell
npm run test:e2e:hr:full
```

## Run stress suite (opt-in)
The stress test is **skipped** unless you set `HR_STRESS=1`.

```powershell
$env:HR_STRESS='1'
$env:HR_STRESS_N='25'          # 5..60
$env:HR_STRESS_PERIOD='202603' # YYYYMM
$env:HR_STRESS_MAX_MS='120000' # soft performance gate
npm run test:e2e -- --project=chromium e2e/hr-stress.spec.js
```

Or run the stress spec directly (still requires `HR_STRESS=1`):

```powershell
$env:HR_STRESS='1'
npm run test:e2e:hr:stress
```

## Ports (to avoid collisions)
The Playwright stack uses dedicated defaults to avoid clashing with dev servers:
- UI: `E2E_UI_PORT` (default `5174`)
- API: `E2E_API_PORT` (default `8788`)

Override per run if needed:

```powershell
$env:E2E_UI_PORT='5179'
$env:E2E_API_PORT='8799'
npm run test:e2e:hr
```

