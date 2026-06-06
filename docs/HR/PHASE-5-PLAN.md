# HR Module — Phase 5 Plan

Phase 4 delivers master data, transfer workflow, bank payroll export, notification bell integration, and operational readiness. Phase 5 focuses on automation, integrations, and employee self-service at scale.

## 1. Supervisor / department-head scoped team view

**Goal:** Branch managers and department heads see only their team without full HR module access.

**Database**
- `hr_staff_profiles.line_manager_user_id` already exists — enforce as primary scope key.
- Optional `hr_department_heads` mapping (department_id, user_id, branch_scope).

**API**
- `GET /api/hr/team/roster` scoped by line manager + department head role.
- Extend `hrListScope()` with `scopeMode: 'team' | 'branch' | 'org'`.

**UI**
- New `/team-hr/my-team` tab: roster, attendance exceptions, leave calendar for direct reports only.
- Reuse `HrResponsiveTable` and existing Team HR panels with `teamScoped` prop.

## 2. Overtime pay calculation in payroll engine

**Goal:** Approved overtime hours convert to payroll line adjustments automatically.

**Database**
- `hr_payroll_line_overtime` (run_id, user_id, hours, rate_ngn, amount_ngn, overtime_request_id).

**API**
- `POST /api/hr/payroll-runs/:id/apply-overtime` — pulls approved overtime for period.
- Extend `recomputePayrollRun` to include overtime earnings.

**UI**
- Payroll run detail: “Apply overtime” button next to “Apply bonus”.
- Overtime report links to payroll run for reconciliation.

## 3. NHIS provider / network integration

**Goal:** Track NHIS enrolment and deductions consistently.

**Database**
- `hr_nhis_providers` (id, name, network_code, default_deduction_ngn).
- Link `hr_staff_profiles.nhis_provider` to provider id.

**API**
- CRUD `/api/hr/nhis-providers`.
- NHIS deduction report in Reports Hub.

**UI**
- Settings tab: NHIS providers.
- Staff profile: provider picker + dependent count.

## 4. Biometric attendance / time clock integration

**Goal:** Import clock-in/out from devices or CSV; reduce manual daily roll.

**Database**
- `hr_time_clock_events` (user_id, branch_id, event_iso, source, device_id, raw_payload_json).

**API**
- `POST /api/hr/attendance/clock-import` (CSV or webhook).
- Reconciliation job: match events to daily roll / exceptions.

**UI**
- Attendance hub › Uploads tab: replace placeholder with import wizard.
- Exception panel shows “unmatched clock events”.

## 5. Employee mobile self-service

**Goal:** Phone-first experience for leave, payslip, documents, policy ack.

**API**
- Already partially exists via `/api/hr/me/*` — extend with push-friendly notification payloads.

**UI**
- My Profile: bottom-nav layout on small screens.
- PWA manifest + service worker for offline payslip cache (encrypted).
- Integrate `HrNotificationsPanel` into My Profile.

## 6. Advanced analytics

**Goal:** Executive HR dashboards with trends.

**Database**
- Materialized summaries or nightly snapshot table `hr_analytics_daily`.

**API**
- `GET /api/hr/analytics/headcount-trend`, `/turnover`, `/cost-per-branch`.

**UI**
- Executive HR hub charts (recharts, matching Business Intelligence patterns).

## 7. Approval automation and reminders

**Goal:** Reduce manual chasing of pending items.

**Backend**
- Scheduled job (or migration-safe cron hook): email/in-app reminders for items pending > N days.
- Auto-escalation: branch_review → hr_review after 3 days.

**UI**
- Settings: reminder thresholds.
- Notification bell: “stale items” aggregate.

## Recommended implementation order

1. Team-scoped view (highest branch manager value)
2. Overtime in payroll (closes Phase 2 ↔ payroll loop)
3. Employee mobile self-service polish
4. Biometric import
5. NHIS providers
6. Analytics + automation

## Testing recommendations

- Add `npm run test:e2e:hr` with Playwright flows: transfer approve→complete, bank export gate, department CRUD.
- Contract tests for bank CSV column order (Receiver Name, Receiver Account No, Amount, Sender Narration, Bank Code).

## Dependencies / risks

- Bank export requires full account numbers — consider field-level encryption at rest for `bank_account_no`.
- Transfer workflow GM/MD step may need integration with existing `editApproval` if cross-module approval is required.
- Biometric vendors vary — start with CSV import before API integrations.
