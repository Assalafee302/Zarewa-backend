# RBAC Matrix (Client Route Visibility)

This matrix defines module-level visibility used by the SPA route guards.  
Source of truth in code: [src/lib/moduleAccess.js](src/lib/moduleAccess.js) (`MODULE_ACCESS_POLICY`).

## Module Visibility Policy

| Module | Permission keys (any one grants visibility) |
|---|---|
| `sales` | `sales.view`, `sales.manage`, `quotations.manage`, `receipts.post` |
| `procurement` | `procurement.view`, `purchase_orders.manage` |
| `operations` | `operations.view`, `production.manage` |
| `finance` | `finance.view`, `finance.post`, `finance.pay`, `finance.approve`, `finance.reverse`, `treasury.manage` |
| `reports` | `reports.view` |
| `edit_approvals` | `dashboard.view` (plus role filtering in workspace context) |
| `settings` | `settings.view`, `period.manage` |
| `office` | `office.use` |
| `hr` | `hr.self`, `hr.directory.view`, `hr.staff.manage`, `hr.requests.hr_review`, `hr.requests.gm_approve`, `hr.requests.final_approve`, `hr.branch.endorse_staff`, `hr.payroll.manage`, `hr.payroll.md_approve`, `hr.attendance.upload`, `hr.daily_roll.mark`, `hr.loan_maintain`, `hr.letters.generate`, `hr.compliance` |

Wildcard `*` grants all modules.

## Route Guard Alignment

- Generic module routing guard: [src/components/ModuleRouteGuard.jsx](src/components/ModuleRouteGuard.jsx)
- Accounting HQ route guard: [src/components/AccountingRouteGuard.jsx](src/components/AccountingRouteGuard.jsx)

Both guards redirect unauthorized routes to `/` and preserve denial context in route state.

## Verification

- Unit checks: [src/lib/moduleAccess.test.js](src/lib/moduleAccess.test.js)
- CI checks run lint, tests, and release verification workflow.

