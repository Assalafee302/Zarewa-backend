# HR production UAT cutover

Use this checklist when moving HR v2 from staging to production. The live status card is on **HR → Dashboard → Production readiness** (`GET /api/hr/dashboard` → `readiness`). Ops can also probe schema without login via `GET /api/hr/health`.

## Two layers of “ready”

| Signal | Meaning |
|--------|---------|
| `productionReady` | All HR submodule tables exist (migrations applied). |
| `canCutover` | Migrations **and** data-quality gates pass for your branch scope. |

Do not sign off UAT until **both** are true on the dashboard.

## Step 1 — Deploy and migrate

```bash
git pull
npm install
npm run db:migrate
# restart API process
```

Verify `GET /api/hr/health`:

- `productionReady: true`
- Every module in `modules` is `true` (core, notifications, recruiting, learning, engagement)
- `blockers` is empty

If any module shows `false`, re-run migrate and check server logs for migration errors.

## Step 2 — Data gates (dashboard)

Open **HR → Dashboard** as an HR admin. Resolve every item under **Production readiness** blockers:

| Gate | Target | Action |
|------|--------|--------|
| Special org nodes | mining, scholarship, chairman staff mapped | **Staff directory** — set department/org node on at least one active staff per special node |
| Profile quality | ≥ 85% without quality flags | Complete missing fields on flagged profiles |
| Data cleanup queue | 0 items | Fix duplicate/conflict rows flagged in HR observability |
| Overdue requests | 0 (recommended before sign-off) | **HR → Requests** — approve, reject, or escalate |

When `canCutover` is true, the card shows **Ready for UAT sign-off**.

## Step 3 — Functional smoke test

Run after gates are green. See [HR-E2E-TESTING.md](./HR-E2E-TESTING.md) for automated suites.

### Core workflows

- [ ] Register or open a staff profile; sensitive fields mask/unlock with reason
- [ ] Submit leave → HR review → manager/GM path → balance updates
- [ ] Submit loan → approvals → finance disbursement → payroll deduction on next run
- [ ] Payroll: create run → recompute → lock → mark paid

### HR v2 features

- [ ] **Recruiting** — create job, add applicant, interview scorecard, generate offer letter
- [ ] **Public careers** — `/careers` lists open jobs; test apply (no login)
- [ ] **Learning** — add training record; export **training-expiry** CSV from Reports
- [ ] **Engagement** — create survey; staff responds via My Profile; export **engagement-trends** CSV
- [ ] **Reports** — download headcount, turnover, training-expiry, engagement-trends exports
- [ ] **Loan agreement** — on approved loan, **Agreement PDF** from **HR → Loans**
- [ ] **Office Desk** — HR review, discipline, and appraisal work items appear for assignees

### Permissions spot-check

- [ ] Staff self-service: leave/loan submit only (no payroll)
- [ ] Branch manager: endorsements, no sensitive salary unlock
- [ ] HR admin: full directory, reports export, recruiting
- [ ] Finance: loan disbursement queue only where policy allows

## Step 4 — Sign-off

| Role | Sign-off |
|------|----------|
| HR lead | Data gates green; staff register complete for active headcount |
| IT / ops | `productionReady` true; backups configured; migrate re-run documented |
| GM / exec | Sample payroll + loan + leave paths verified on production branch |

Record sign-off date and operator in your change log. After cutover, monitor **Overdue requests** and **Incomplete profiles** weekly on the dashboard.

## Rollback

- API: redeploy previous release tag
- DB: HR migrations are additive; rollback is forward-fix only (restore DB snapshot if needed)
- Frontend: redeploy previous build; `/careers` and HR nav remain compatible with v1 API if core tables only

## Related docs

- [HR-V2-FEATURES.md](./HR-V2-FEATURES.md) — API and UI map
- [HR-POLICY-RECRUITING.md](./HR-POLICY-RECRUITING.md) — hiring workflow
- [HR-E2E-TESTING.md](./HR-E2E-TESTING.md) — automated test commands
