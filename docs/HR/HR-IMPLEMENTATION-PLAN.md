# Zarewa Human Resources — Implementation Plan

This plan restores and completes HR as a first-class Zarewa ERP module aligned with HQ-central payroll, branch contributions (MD-only), level/step salary, and role-based privacy.

**Extended v2 features** (recruiting, L&D, engagement, exports, etc.) are documented in [HR-V2-FEATURES.md](./HR-V2-FEATURES.md).

## Current baseline

| Area | State |
|------|--------|
| Database | `hr_*` tables via `server/migrate.js` (`migrateHrModule`, roadmap migrations) |
| Business logic | `server/hrOps.js`, `hrBusinessRules.js`, `hrPolicy.js`, plus `hrRecruiting.js`, `hrLearning.js`, `hrEngagement.js`, `hrNotifications.js`, `hrStaffLifecycle.js` |
| HTTP API | Registered under `/api/hr/*` via `server/hrApi.js`; public careers under `/api/public/careers/*` (no auth) |
| Frontend | `/hr/*`, `/team-hr/*`, `/my-profile/*`, `/hr/executive/*`, `/careers` |
| Roles | `hr_admin`, `gmhr`, `md`, `finance_manager` in `ROLE_DEFINITIONS` (`server/auth.js`) |
| Finance link | Staff loans → payment requests (`provisionStaffLoanForFinanceQueue`) |
| Workspace | `hr_admin` inbox category, `hr_*` work item types (partial — see Phase 8) |
| AI | `hrContextLines` in `aiAssistContext.js` (redacted) |

## Architecture principles

1. **HQ payroll** — one payroll engine; **payroll group** distinguishes branch/HQ/executive/domestic/scholarship/beneficiary rows.
2. **Approval chain** — Staff → Branch Manager → Admin/HR → GMHR → MD (exceptional) → Finance pay.
3. **Privacy by default** — redaction helpers on every HR API response; bootstrap/search must not include salary payloads.
4. **Sensitive unlock** — password re-verify → short-lived token for compensation/payslip/bank views.
5. **Reuse `hrOps`** — API layer is thin; extend dedicated modules when domains grow (recruiting, L&D, engagement).

## Permission model

Canonical keys live in `server/hrPermissionKeys.js` and `server/hrPermissions.js`. Roles:

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
| HR/Admin, GMHR | Human Resources | `/hr/*` (grouped sidebar nav) |
| MD | Executive HR | `/hr/executive/*` |
| Public | Careers | `/careers` |

`moduleAccess.js` — `hr` module policy synced with `hrPermissions.js`.

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
- [x] Grouped HR sidebar nav (Overview / People / Operations / Governance / Insights)

### Phase 3 — Dashboard and staff directory ✅

- [x] HR dashboard (real cards from `listHrObservability`, `getHrInboxSummary`)
- [x] Staff directory filters + employee profile tabs (redacted by role)
- [x] Re-auth gate on Compensation tab
- [x] Production readiness / module health on dashboard

### Phase 4 — Requests, leave, attendance ✅

- [x] Leave wizard (My Profile) + approval queue (HR/Team)
- [x] Attendance daily roll with **in time / out time** (`rows_json` + `HrDailyRollPanel`)
- [x] Deduction recommendations (HR review queue via `listHrAttendanceDeductionPreview`; no auto lateness deduct)

### Phase 5 — Payroll engine ✅

- [x] Payroll groups on staff profile + payroll lines
- [x] Salary level/step matrix (`hr_salary_matrix`, `hr_salary_history`)
- [x] GMHR or MD approve → lock; Finance `hr.payroll.pay` → mark paid
- [x] Branch contribution table (`hr_branch_payroll_contributions`) — MD only
- [x] Exports (treasury, statutory, payslips CSV + single/bulk PDF payslips)
- [x] Payroll preview / recompute UI

### Phase 6 — Loans and benefits ✅

- [x] Loan wizard + exceptional flag → GM HR queue
- [x] Benefits / scholarship beneficiaries (`hr_beneficiaries`, `hr_benefit_payments`)
- [x] Staff loan agreement letter + PDF (`generateStaffLoanAgreementLetter`, `POST /api/hr/loan-requests/:requestId/agreement-letter`)

### Phase 7 — Transfers, discipline, letters ✅

- [x] Transfer workflow + history + branch recommendations
- [x] Discipline register + incident memo → escalate
- [x] Employment letter generate + list UI
- [x] Letter PDF export (`exportEmploymentLetterPdf`)

### Phase 8 — Workspace and Zare ✅

- [x] Work items for HR approval queues (`listLegacyHrRequestWorkItems` in `workItems.js`)
- [x] Discipline / incident memos and open appraisal forms in unified work items
- [x] Zare HR prompts with redacted context (`hrContextLines`)
- [x] Branch contribution card for MD (executive HR / contributions API)

### Phase 9 — Reports and settings ✅

- [x] HR settings (matrix, qualifications, PAYE/pension, policies)
- [x] Exportable reports (summary UI + CSV: headcount, turnover, training expiry, engagement trends)

### Phase 10 — Testing and polish (in progress)

- [x] `e2e/hr-api.spec.js`, `e2e/hr-smoke.spec.js`
- [x] `server/hrSecurity.test.js`, `shared/lib/simpleTextPdf.test.js`
- [x] `ACCESS_CONTROL.md`, `RBAC_MATRIX.md` synced (2026)
- [x] HR policy docs: recruiting, v2 feature index

### Phase 11 — HR v2 extensions ✅

See [HR-V2-FEATURES.md](./HR-V2-FEATURES.md).

- [x] Recruiting + public careers
- [x] Learning & training records
- [x] Engagement surveys
- [x] Org chart
- [x] Lifecycle checklists + separation
- [x] In-app HR notifications
- [x] Appraisals / feedback (performance UI)

## Schema extensions (by phase)

| Phase | Tables / columns |
|-------|------------------|
| 1 | `hr_payroll_runs.gm_approved_at_iso`, `gm_approved_by_user_id`, `md_approved_*`; `hr_sensitive_tokens` |
| 4 | Daily roll `inTime`/`outTime` in `rows_json` |
| 5 | `payroll_group`, `salary_level`, `salary_step`; `hr_salary_matrix`, `hr_salary_history`, `hr_branch_payroll_contributions` |
| 6 | `hr_beneficiaries`, `hr_benefit_payments`; loan agreement via `hr_employment_letters.letter_kind` |
| 7 | `hr_transfer_requests`, `hr_employment_letters`, incident memos |
| 11 | `hr_job_postings`, `hr_job_applicants`, `hr_training_records`, `hr_engagement_*`, `hr_notifications` |

## API surface

Registered under `/api/hr` — see `server/hrApi.js`. Public careers: `registerPublicCareersApi` in `httpApi.js` (before `requireAuth`). All authenticated mutating routes require CSRF.

## Security checklist

- [x] Bootstrap excludes HR salary arrays (`server/hrSecurity.test.js`)
- [x] Workspace search redacts staff compensation
- [x] AI context uses redacted staff payloads
- [x] Audit events for sensitive actions via `hr_audit_events`
- [x] `?includeSalary=1` rejected without `hr.payroll.view_sensitive`

## Test matrix

See [HR-E2E-TESTING.md](./HR-E2E-TESTING.md) — `npm run test:e2e:hr`, `server/hr*.test.js`.
