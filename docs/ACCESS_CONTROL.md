# Access control (Zarewa)

This document summarizes how roles, API routes, and the workspace bootstrap relate. For the canonical permission matrix, see `ROLE_DEFINITIONS` in `server/auth.js`.

## Roles

Each user has a `role_key` mapped to a label and a list of permission strings. `admin` has `*` (all permissions). Other roles combine granular strings such as `sales.view`, `finance.post`, `hr.directory.view`, etc.

Non-technical staff summary: **[STAFF_APPROVALS.md](./STAFF_APPROVALS.md)**.

Demo accounts ship with the dev database; change passwords before any production use. The read-only demo user is **`viewer`** / **`Viewer@123456!`** (role `viewer`: `dashboard.view`, `reports.view` only).

## Bootstrap (`GET /api/bootstrap`)

The SPA loads a single snapshot. Row-level lists are **filtered by role** in `server/bootstrap.js` using helpers in `server/workspaceAccess.js`. Sensitive domains (customers, finance, procurement, operations, etc.) are omitted unless the user has a matching permission. Treasury **movements** stay finance-only; treasury **account names** are included for roles that post receipts or request refunds (cash/bank pickers).

## Read APIs

`GET` handlers under `/api` that return business data use `requirePermission(...)` (or internal checks) so empty bootstrap cannot be bypassed by calling the API directly. Examples: customers and quotations require sales-domain permissions; ledger and advances require ledger-related permissions; suppliers require procurement-domain permissions.

`GET /api/exec/summary` returns **org-wide aggregates** for executive dashboards. It requires `exec.dashboard.view` (CEO and similar). It is intentionally narrow — not a substitute for line-level sales or finance APIs. The payload includes queue-style counts such as **payroll drafts without MD sign-off** and **bank reconciliation lines in `Review`**, when the underlying tables exist.

`GET /api/reports/summary` returns **counts only** (no row payloads) for anyone with `reports.view`, respecting branch scope. The Reports page uses this when the user has reports access but no line-level snapshot data.

`GET /api/inventory/snapshot` mirrors bootstrap with the same filtering; it still requires an authenticated session.

## Role highlights (current model)

- **Finance cross-branch posting** (`finance.cross_branch_post`): held by **finance manager** (and `admin` via `*`). Without it, ledger receipt/advance/apply-advance/refund-advance endpoints require the customer’s `branch_id` to match the signed-in user’s **current workspace branch** (prevents mis-booking when read scope is org-wide).
- **CEO** (`ceo`): `exec.dashboard.view` and `dashboard.view` only — minimal exec UI; no `*` wildcard. The SPA routes CEOs to `/exec` and hides broad module nav that depended on `sales.view` / `finance.view`.
- **Managing Director** (`md`): strategic approvals including `hr.payroll.md_approve`, `pricing.manage`, and `md.price_exception.approve`. **Customer refund approval** uses `refunds.approve` (same as branch manager) in addition to `finance.approve` on the decision endpoint.
- **Branch manager** (role key still `sales_manager`): label and permissions updated for branch duties; holds `refunds.approve` for refund decisions alongside MD and **admin** (`*`).
- **Receipt bank confirmation**: `PATCH /api/sales-receipts/:receiptId/bank-confirmation` with `{ confirmed: boolean }` — requires `finance.pay` or `receipts.post`; audited as `receipt.bank_confirmation`.
- **Payroll**: draft runs record `md_approved_at_iso` / `md_approved_by_user_id` via `POST /api/hr/payroll-runs/:runId/md-approve` (permission `hr.payroll.md_approve`). HR cannot **lock** a draft until MD approval is recorded.
- **Price list & production**: canonical rows in `price_list_items`; starting production can be blocked when a quotation is below list price until MD records a price exception (`PATCH /api/quotations/:id/md-price-exception` with `md.price_exception.approve`).
- **HR self-service**: staff profiles include `selfServiceEligible`; leave/loan self-apply on **My profile** is gated on that flag (and the user matching their HR record).

## HR

- Directory, payroll, attendance, and salary snapshots use explicit HR permissions.
- `GET /api/hr/requests` scopes results by query (`mine`, `hr_queue`, `exec_queue`, `all`) with permission checks on non-mine scopes.
- `GET /api/hr/employment-letters` requires `hr.self`, `hr.staff.manage`, or `hr.letters.generate` (admin passes via `*`).

### Leave & loan request workflow (permissions)

| Step | API (typical) | Permission |
|------|----------------|------------|
| Employee draft / submit | `POST /api/hr/requests`, `PATCH …/submit` | Self-service + own HR file |
| HR officer triage | `PATCH …/hr-review` | `hr.requests.hr_review` |
| Branch manager endorsement | `PATCH …/branch-endorse` | `hr.branch.endorse_staff` |
| GM HR final (incl. loan provisioning) | `PATCH …/gm-hr-review` | `hr.requests.gm_approve` (legacy `hr.requests.final_approve` still accepted where mapped) |
| Staff file edits, discipline cases, payroll manage | Various `/api/hr/staff/*`, `/api/hr/discipline/*`, payroll routes | `hr.staff.manage`, `hr.payroll.manage`, etc. |

## Approvals and segregation (quick reference)

| Area | Who requests / creates | Who approves / confirms | Notes |
|------|-------------------------|-------------------------|--------|
| Customer refund | Sales-facing roles (`refunds.request`) | Branch manager or **MD** (`refunds.approve`), or **finance** (`finance.approve` on the same decision API), or **admin** (`*`) | Who acts first is organisational; segregation of duties still requires **Finance** to pay out (`finance.pay` / treasury). Operational checklist: [REFUND_OPERATIONS.md](./REFUND_OPERATIONS.md). |
| Payment request / expense payout | Requesters per module | `finance.approve` / manager flows | Cashier / finance executes pay after approval. |
| Payroll lock → export | HR (`hr.payroll.manage`) | MD sign-off (`hr.payroll.md_approve`) | Draft run must have `md_approved_at_iso` before lock (unless `admin` `*`). |
| Below list price → production | — | MD (`md.price_exception.approve`) | Production start blocked until exception recorded on the quotation. |
| Delivery / produced (authoritative) | — | Operations (`deliveries.manage`, `production.manage`, …) | Sales sees status read-only where enforced. |
| Bank statement lines | Finance post (`finance.post`) | Same role matches lines | `GET /api/bank-reconciliation` is `finance.view`; bulk paste: `POST /api/bank-reconciliation/import`. |
| Receipt vs bank | Cashier / poster | `PATCH /api/sales-receipts/:id/bank-confirmation` | `finance.pay` or `receipts.post`. |

## Bank reconciliation API

- `GET /api/bank-reconciliation` — list lines for current branch scope (`finance.view`).
- `POST /api/bank-reconciliation` — single line (`finance.post`).
- `POST /api/bank-reconciliation/import` — up to 500 lines in one request; body `{ lines: [{ bankDateISO, description, amountNgn, … }] }` (`finance.post`).
- `POST /api/bank-reconciliation/import-csv` — body `{ csvText }` with optional header row `bankDateISO,description,amountNgn`; quoted descriptions may contain commas (`finance.post`).
- `PATCH /api/bank-reconciliation/:lineId` — update match / status (`finance.post`).

## Other hardened reads

- `GET /api/advance-deposits` requires the same permission set as ledger-related reads (`LEDGER_RELATED_PERMS` in `server/workspaceAccess.js`), not anonymous access.
- `GET /api/workspace/search` requires a signed-in session (`requireAuth`); results are still filtered by entity-level permissions inside the handler.

## Hardening checklist for production

- Replace demo passwords and restrict who can create users.
- Serve the API over HTTPS and set `COOKIE_SECURE` appropriately (see `docs/ENVIRONMENT.md`).
- Review new `GET` routes and add `requirePermission` aligned with `workspaceAccess.js`.
- Run `npm run test` and `npm run test:e2e` in CI.

## E2E (`npm run test:e2e`)

Playwright starts `server/playwrightServer.js` (deletes and recreates `data/playwright.sqlite` each time) on port **8787** and Vite on **5173**. Free those ports locally, or stop any other Zarewa API using 8787. `e2e/access-control.spec.js` covers viewer, procurement, **CEO** (exec summary + forbidden customers + empty search), **MD** (customers + search), **branch manager** (refunds list), **sales** (forbidden delivery confirm), **HR** (payroll lock without MD), and related API assertions.

## API test suite note

`server/api.test.js` uses `describe.sequential('Zarewa API', …)` so its cases run one after another and avoid flaky interactions with other Vitest workers (including occasional `404` / shared timing issues on accounting routes when the suite was fully parallel).

## Related files

| Area | File |
|------|------|
| Roles & session | `server/auth.js` |
| Domain helpers | `server/workspaceAccess.js` |
| Bootstrap builder | `server/bootstrap.js` |
| HTTP routes | `server/httpApi.js` |
| Aggregate report counts | `server/readModel.js` → `workspaceReportAggregateCounts` |
