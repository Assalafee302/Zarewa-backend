# HR Phase 9 — Executive Benefits (completion notes)

## Scope delivered

- Executive benefits backend (`hrExecutiveBenefitsOps.js`) with separate tables from operational payroll
- Migration `migrateHrPhase9ExecutiveBenefits2026`
- REST API under `/api/hr/executive/*`
- Top-level UI route `/executive-hr/*` (MD can access without main `/hr` workspace)
- Executive Benefits hub: beneficiaries, school fees, stipends, domestic staff, payments, bank export, chairman expenses, audit guidance
- Role/dashboard landing updates (MD → `/exec`, cashier → `/cashier`, accountant → `/accounting`, HR admin → `/hr`)
- Executive reports in HR Reports Hub (`executive-*` catalog entries)
- Permissions: `hr.executive.benefits.view|manage|export`, `hr.chairman.manage`
- Bank account encryption via `hrBankCrypto.js`
- Audit events on create/update/approve/export/paid

## Deploy

```bash
npm run db:migrate
# restart API
```

## Routes

| Area | Route |
|------|-------|
| Executive HR shell | `/executive-hr/*` |
| Executive benefits | `/executive-hr/benefits?tab=school-fees` |
| Legacy redirect | `/hr/executive/*` → `/executive-hr/*` |

## API (summary)

- `GET /api/hr/executive/dashboard`
- CRUD: `/beneficiaries`, `/school-fees`, `/stipends`, `/domestic-staff`
- Payments: `/payments`, `/:id/approve`, `/:id/reject`, `/:id/mark-paid`, `/payments/export`
- Reports: `/reports/:kind` (executive catalog IDs)

## Known limitations

- Monthly stipend **payment batch generation** from active stipends is manual (create payment rows via school-fee submit flow or future batch job)
- Document upload for school bills/receipts uses `documentRef` text field only (no file store UI yet)
- Domestic staff not linked to login/My Profile unless `user_id` set separately
- Phase 9 tables are health-checked but not required for `allReady` (core HR still works before migrate)

## Tests

```bash
npm test -- server/hrExecutiveBenefitsOps.test.js server/hrPermissions.test.js
cd ../Zarewa-frontend-main && npm run build
```
