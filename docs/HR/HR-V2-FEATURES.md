# HR v2 — Extended Features (beyond core implementation plan)

Features implemented after the original Phases 1–7 baseline. Use this doc for UAT, ops, and alignment with production.

## Recruiting & public careers

See [HR-POLICY-RECRUITING.md](./HR-POLICY-RECRUITING.md).

- Tables: `hr_job_postings`, `hr_job_applicants`
- Public API registered **before** auth middleware in `httpApi.js`
- SPA route: `/careers` (no login)

## Learning & development

- Table: `hr_training_records`
- API: `GET/POST /api/hr/training-records`, `DELETE …/:id`
- UI: `/hr/learning`
- Report export: `GET /api/hr/reports/export/training-expiry` → CSV

## Staff engagement

- Tables: `hr_engagement_surveys`, `hr_engagement_responses`
- API: surveys CRUD, summary, staff submit via My Profile
- UI: `/hr/engagement`
- Report export: `GET /api/hr/reports/export/engagement-trends` → CSV

## Org chart & reporting lines

- Library: `shared/lib/hrOrgChart.js`
- API: `GET /api/hr/org-chart`; line manager on staff profile / `GET /api/hr/me`
- UI: `/hr/org-chart`

## Lifecycle (onboarding / offboarding)

- Checklists in `hr_staff_profiles.profile_extra_json.lifecycle`
- API: `GET/PATCH /api/hr/staff/:userId/lifecycle`, separation patch
- UI: staff profile lifecycle panel

## In-app notifications

- Table: `hr_notifications`
- API: `GET /api/hr/notifications`, mark read, dashboard panel
- Hooks: leave/loan decisions, payroll lock/paid, new appraisal forms

## Performance

- Tables: `hr_appraisal_cycles`, `hr_appraisal_forms`, `hr_feedback_notes`
- UI: `/hr/performance`

## HR report exports

| Kind | CSV filename (typical) |
|------|-------------------------|
| `headcount` | `hr-headcount.csv` |
| `turnover` | `hr-turnover.csv` |
| `training-expiry` | `hr-training-expiry.csv` |
| `engagement-trends` | `hr-engagement-surveys.csv` |

Permission: `hr.reports.view`, `hr.staff.manage`, or `hr.executive.view`.

## Production readiness

- `GET /api/hr/health` — `modules` + `productionReady` (all submodule tables present)
- Dashboard readiness card — same data from `GET /api/hr/dashboard`

## Staff loan agreement letters

- Generated for **approved** loan requests: `POST /api/hr/loan-requests/:requestId/agreement-letter`
- Stored as `hr_employment_letters` with `letter_kind = staff_loan_agreement`
- PDF: `GET /api/hr/employment-letters/:letterId/pdf`
- UI: **HR → Loans** — “Agreement PDF” on approved rows; also listed under **Letters**

## Migration

Run after deploy:

```bash
npm run db:migrate
```

Ensures recruiting, learning, engagement, notifications, and applicant columns exist (`migrateHrRecruitingLearningEngagementSchema`, `migrateHrLifecycleAndNotificationsSchema`).
