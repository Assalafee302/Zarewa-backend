# Zarewa Human Resources — Implementation Plan

This plan restores and completes HR as a first-class Zarewa ERP module aligned with HQ-central payroll, branch contributions (MD-only), level/step salary, and role-based privacy.

## Current baseline

| Area | State |
|------|--------|
| Database | `hr_*` tables via `server/migrate.js` (`migrateHrModule`, roadmap migrations) |
| Business logic | `server/hrOps.js` (~3k LOC), `hrBusinessRules.js`, `hrPolicy.js` |
| HTTP API | **Missing** — routes not registered in `server/httpApi.js` |
| Frontend | `/hr/*` redirects home; no HR pages |
| Roles | `hr_officer` / `hr_manager` migrated away; no `hr_admin` / `gmhr` in `ROLE_DEFINITIONS` |
| Finance link | Staff loans → payment requests (`provisionStaffLoanForFinanceQueue`) |
| Workspace | `hr_admin` inbox category, `hr_*` work item types |
| AI | `hrContextLines` in `aiAssistContext.js` |

## Architecture principles

1. **HQ payroll** — one payroll engine; **payroll group** distinguishes branch/HQ/executive/domestic/scholarship/beneficiary rows (schema extension in Phase 5).
2. **Approval chain** — Staff → Branch Manager → Admin/HR → GMHR → MD (exceptional) → Finance pay.
3. **Privacy by default** — redaction helpers on every HR API response; bootstrap/search must not include salary payloads.
4. **Sensitive unlock** — password re-verify → short-lived token for compensation/payslip/bank views.
5. **Reuse `hrOps`** — API layer is thin; extend `hrOps` only when gaps exist (salary matrix, branch contributions, in/out time).

## Permission model

Canonical keys live in `server/hrPermissions.js`. Roles:

| Role key | Label | HR scope |
|----------|-------|----------|
| `sales_staff` | Sales officer | My Profile self-service only |
| `sales_manager` | Branch manager | Team HR (no salary) |
| `hr_admin` | HR / Admin | Full HR operations (not final GM/MD authority) |
| `gmhr` | GM HR | Final HR approvals incl. payroll lock |
| `md` | Managing Director | Executive HR + branch contributions + sensitive |
| `finance_manager` | Finance manager | Payroll pay/export, loan disburse |
| `admin` | Administrator | `*` |

Legacy aliases kept in checks: `hr.requests.hr_review` → `hr.requests.review`, `hr.requests.final_approve` → `hr.requests.gm_approve`.

## Navigation (frontend)

| Audience | Entry | Routes |
|----------|-------|--------|
| All staff | My Profile | `/my-profile/*` |
| Branch manager | Team HR | `/team-hr/*` |
| HR/Admin, GMHR | Human Resources | `/hr/*` (sidebar) |
| MD | Executive HR | `/hr/executive/*` |

`moduleAccess.js` gains `hr` module policy synced with `hrPermissions.js`.

## Phases

### Phase 1 — Backend / API foundation ✅

- [x] `server/hrPermissions.js` — permission constants + capability helpers
- [x] `server/hrRedaction.js` — staff/request/payroll redaction
- [x] `server/hrSensitiveGate.js` — password verify + session token
- [x] `server/hrApi.js` — register `/api/hr/*`
- [x] Wire `registerHrApi` in `httpApi.js` (after auth middleware)
- [x] Extend `ROLE_DEFINITIONS` + `allKnownPermissionKeys`
- [x] Migration: `gm_approved_*` on `hr_payroll_runs`; lock accepts GMHR or MD approval
- [x] Tests: permissions, redaction, route guards

### Phase 2 — Shell and navigation ✅

- [x] Remove `/hr/*` redirect; add `HumanResources` layout + route guards
- [x] Sidebar: Human Resources (permission-gated); Team HR for branch managers
- [x] My Profile in account menu + `/my-profile/*` routes
- [x] Team HR `/team-hr/*` and Executive HR `/hr/executive/*`
- [x] `moduleAccess` + `documentTitle` updates
- [x] `HrSensitiveUnlockModal` + `useHrSensitiveAccess` + `/api/hr/sensitive/verify`
- [x] Live HR dashboard at `/hr/dashboard` (API-backed)

### Phase 3 — Dashboard and staff directory

- HR dashboard (real cards from `listHrObservability`, `getHrInboxSummary`)
- Staff directory filters + employee profile tabs (redacted by role)
- Re-auth gate on Compensation tab

### Phase 4 — Requests, leave, attendance

- Leave wizard (My Profile) + approval queue (HR/Team)
- Attendance daily roll with **in time / out time** (extend `hr_daily_roll_calls` rows JSON)
- Deduction recommendations (HR review queue; no auto lateness deduct)

### Phase 5 — Payroll engine

- Payroll groups on staff profile + payroll lines
- Salary level/step matrix (`hr_salary_matrix`, `hr_salary_history`)
- GMHR approve → lock; Finance `hr.payroll.pay` → mark paid
- Branch contribution table (`hr_branch_payroll_contributions`) — MD only
- Exports (treasury, payslips CSV; PDF payslips Phase 5b)
- Payroll preview mode UI

### Phase 6 — Loans and benefits

- Loan wizard + exceptional MD path
- Benefits / scholarship beneficiaries
- Agreement letter template

### Phase 7 — Transfers, discipline, letters

- Transfer workflow + history tabs
- Discipline from incident memo
- Letter templates + approval + PDF

### Phase 8 — Workspace and Zare

- Work items for each approval step
- Zare HR prompts with redacted context
- Branch contribution card for MD

### Phase 9 — Reports and settings

- HR settings (matrix, qualifications, PAYE/pension, policies)
- Exportable reports

### Phase 10 — Testing and polish

- E2E HR suites restored
- Security audit checklist
- Update `ACCESS_CONTROL.md`, `RBAC_MATRIX.md`

## Schema extensions (by phase)

| Phase | Tables / columns |
|-------|------------------|
| 1 | `hr_payroll_runs.gm_approved_at_iso`, `gm_approved_by_user_id`; `hr_sensitive_tokens` |
| 4 | Daily roll `inTime`/`outTime` in `rows_json` convention |
| 5 | `payroll_group`, `salary_level`, `salary_step` on `hr_staff_profiles`; `hr_salary_matrix`, `hr_salary_history`, `hr_branch_payroll_contributions` |
| 6 | `hr_beneficiaries`, `hr_benefit_payments` |
| 7 | `hr_transfer_requests`, letter metadata |

## API surface (Phase 1)

Registered under `/api/hr` — see `server/hrApi.js` route list. All mutating routes require CSRF (existing `/api` stack).

## Security checklist

- [ ] Bootstrap excludes HR salary arrays
- [ ] Workspace search redacts staff compensation
- [ ] AI context uses `redactStaffForAi`
- [ ] Audit: `hr.sensitive.view`, payroll approve, salary change
- [ ] Branch manager API cannot pass `?includeSalary=1`

## Test matrix (Phase 1+)

See user spec — implemented incrementally per phase in `server/hr*.test.js` and Playwright `e2e/hr-*.spec.js` (restore in Phase 10).
