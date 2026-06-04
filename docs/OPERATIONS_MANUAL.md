# Zarewa Operations & IT Manual

**Version:** 1.0  
**Scope:** Full system — business operations and IT administration  
**Audience:** Branch staff, finance, operations, HR, executives, and system administrators  

This is the **consolidated master manual** for Zarewa. It describes how the live system behaves (UI, API, permissions, and controls). Domain-specific deep dives remain in linked documents under `docs/` — this manual ties them together.

---

## Table of contents

1. [System overview](#1-system-overview)
2. [Architecture](#2-architecture)
3. [Daily use — sign-in and navigation](#3-daily-use--sign-in-and-navigation)
4. [Roles, permissions, and segregation of duties](#4-roles-permissions-and-segregation-of-duties)
5. [Cross-cutting rules](#5-cross-cutting-rules)
6. [Module procedures — business operations](#6-module-procedures--business-operations)
   - [6.1 Dashboard and workspace](#61-dashboard-and-workspace)
   - [6.2 Sales and customers](#62-sales-and-customers)
   - [6.3 Quotations, cutting lists, and pricing](#63-quotations-cutting-lists-and-pricing)
   - [6.4 Customer finance — receipts, advances, corrections](#64-customer-finance--receipts-advances-corrections)
   - [6.5 Customer refunds](#65-customer-refunds)
   - [6.6 Procurement and suppliers](#66-procurement-and-suppliers)
   - [6.7 Operations, inventory, and production](#67-operations-inventory-and-production)
   - [6.8 Material exceptions and offcuts](#68-material-exceptions-and-offcuts)
   - [6.9 Finance, treasury, and GL](#69-finance-treasury-and-gl)
   - [6.10 Office, work items, and edit approvals](#610-office-work-items-and-edit-approvals)
   - [6.11 Reports and analytics](#611-reports-and-analytics)
   - [6.12 Human resources](#612-human-resources)
   - [6.13 Settings and master data](#613-settings-and-master-data)
   - [6.14 Executive views](#614-executive-views)
7. [IT operations](#7-it-operations)
   - [7.1 Prerequisites and repositories](#71-prerequisites-and-repositories)
   - [7.2 Environment configuration](#72-environment-configuration)
   - [7.3 Deployment models](#73-deployment-models)
   - [7.4 Database, migrations, and seeding](#74-database-migrations-and-seeding)
   - [7.5 Backup and recovery](#75-backup-and-recovery)
   - [7.6 Health checks and degraded mode](#76-health-checks-and-degraded-mode)
   - [7.7 Updates and release verification](#77-updates-and-release-verification)
   - [7.8 Security hardening](#78-security-hardening)
   - [7.9 Scripts and maintenance tools](#79-scripts-and-maintenance-tools)
   - [7.10 Testing and QA gates](#710-testing-and-qa-gates)
   - [7.11 Incident response](#711-incident-response)
8. [Appendix A — Role quick reference](#appendix-a--role-quick-reference)
9. [Appendix B — Application route map](#appendix-b--application-route-map)
10. [Appendix C — Related documents index](#appendix-c--related-documents-index)

---

## 1. System overview

**Zarewa** is an integrated operations platform for a multi-branch roofing / building-materials business. It covers:

| Domain | Primary users | What the system tracks |
|--------|---------------|------------------------|
| Sales | Sales officers, branch managers | Customers, quotations, cutting lists |
| Customer finance | Sales, cashier, finance | Receipts, advances, ledger, refunds |
| Procurement | Operations, MD, finance | Suppliers, POs, GRN, supplier payments |
| Production & inventory | Operations, storekeepers | Coil register, jobs, deliveries, stock |
| Finance & GL | Finance manager, cashier | Treasury, journals, bank reconciliation, period locks |
| Office | All staff with `office.use` | Threads, memos, payment/material requests, filing |
| HR | HR admin, GM HR, staff | Profiles, leave, loans, payroll, attendance |
| Reporting | Managers, finance, MD | Registers, month-end packs, MD operations pack |

**Technology stack**

- **Frontend:** React (Vite SPA) — routes in `Zarewa-frontend-main/src/App.jsx`
- **Backend:** Node.js + Express 5 — entry `server/index.js`, routes `server/httpApi.js`
- **Persistence:** SQLite file (default `data/zarewa.sqlite`) or MySQL when configured; migrations run on startup
- **Auth:** Server-side session cookies + CSRF on mutating requests; optional Firebase login
- **Shared logic:** `shared/` — ledger math, report cores, constants used by API and UI

**Branches**

- Each user works in a **workspace branch** (default Kaduna `BR-KD`).
- Document IDs embed branch codes, e.g. **QT-KD-26-0001** (quotation, Kaduna, year 26, sequence 0001).
- Suppliers and transport agents are **company-wide** (not branch-scoped).
- Most operational data (customers, quotations, coils, receipts) is **branch-scoped** unless the role has org-wide read (`hq.view_all_branches`).

---

## 2. Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Browser (React SPA)                                        │
│  Routes: /sales, /procurement, /operations, /accounts, …    │
│  Session: cookie + CSRF token                               │
└──────────────────────────┬──────────────────────────────────┘
                           │ HTTPS  /api/*
┌──────────────────────────▼──────────────────────────────────┐
│  Node.js API (Express)                                      │
│  auth.js · httpApi.js · domain ops modules · migrate.js     │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│  Database (SQLite or MySQL)                                 │
│  Single file / schema with migrations + audit tables        │
└─────────────────────────────────────────────────────────────┘
```

**Deployment options**

| Model | When to use | Key settings |
|-------|-------------|--------------|
| **Combined** | Simplest production | API serves built `dist/` from same origin; `ZAREWA_STATIC_DIR` |
| **Split** | UI on CDN/static host, API on VM | `VITE_API_BASE`, `CORS_ORIGIN`, cookie SameSite rules |
| **Dev stack** | Local development | `npm run dev:stack` — API + Vite proxy |

See [SPLIT_DEPLOYMENT_AND_MIGRATION.md](./SPLIT_DEPLOYMENT_AND_MIGRATION.md) and [DEPLOYMENT.md](./DEPLOYMENT.md).

**Bootstrap model**

On login the SPA loads **`GET /api/bootstrap`** — a filtered snapshot of branches, permissions, master data, and lists the user may see. Direct API calls still enforce permissions; bootstrap filtering is not a security boundary.

---

## 3. Daily use — sign-in and navigation

### 3.1 Sign in

1. Open the Zarewa URL provided by IT.
2. Enter **username** and **password**, or use **Google sign-in** if Firebase is configured.
3. On success the app routes you by role:
   - **CEO** → `/exec` (executive summary only)
   - **MD / branch manager / finance / sales / operations / HR** → department home or dashboard
4. First login may require **password change** or **onboarding** steps.

**Forgot password:** use the reset flow on the login screen (token emailed or distributed per your IT policy).

### 3.2 Workspace branch

- Switch branch from the workspace header when your role allows multiple branches.
- Posting receipts, creating quotations, and most writes use the **current workspace branch**.
- Finance with `finance.cross_branch_post` may post to other branches under controlled rules.

### 3.3 Main navigation (SPA routes)

| Route | Module | Typical users |
|-------|--------|---------------|
| `/` | Home / dashboard | All |
| `/workspace/monitoring` | Workspace monitoring | Admin, managers |
| `/exec` | CEO executive dashboard | CEO |
| `/sales` | Sales desk | Sales, managers |
| `/customers`, `/customers/:id` | Customer CRM | Sales |
| `/procurement` | Procurement hub | Operations, MD, finance |
| `/operations` | Store & production | Operations |
| `/operations/material-exceptions` | Material incidents | Operations, managers |
| `/accounts` | Finance & accounts | Finance, cashier |
| `/accounts/bank-reconciliation` | Bank rec | Finance |
| `/reports` | Management reports | Managers, finance, MD |
| `/analytics` | Business intelligence | Management |
| `/office` | Office desk | All with `office.use` |
| `/edit-approvals` | Pending edit approvals | Managers |
| `/settings/*` | Administration | Admin, MD, finance |
| `/manager` | Branch manager dashboard | Branch managers |
| `/my-profile/*` | HR self-service | Staff |
| `/team-hr/*` | Team HR (managers) | Line managers |
| `/hr/*` | HR administration | HR admin, GM HR |
| `/price-list`, `/pricing-policy` | Pricing admin | MD, pricing roles |

Unauthorized routes redirect to `/` with a denial message.

### 3.4 Offline / degraded behaviour

If the API stops responding:

- The UI may show **“System offline”** with last synced workspace data.
- **Nothing new can be saved** until the API reconnects.
- Use **Try reconnect** or refresh after IT confirms the server is healthy.

---

## 4. Roles, permissions, and segregation of duties

### 4.1 Built-in roles

| Role key | Label | Summary |
|----------|-------|---------|
| `admin` | Administrator | Full access (`*`) |
| `md` | Managing Director | Org-wide strategic control, approvals, pricing, HR exec |
| `finance_manager` | Finance manager | Finance, treasury, GL, cross-branch posting, reports |
| `cashier` | Cashier | Receipts, treasury, payouts, limited approvals |
| `sales_manager` | Branch manager | Sales, operations, production, refunds approve, material incidents |
| `sales_staff` | Sales officer | Customers, quotations, receipts, refund requests |
| `operations_officer` | Operations officer | Procurement, inventory, production, material incident create |
| `hr_admin` | HR / Admin | HR directory, payroll prep, attendance |
| `gmhr` | GM HR | Org-wide HR, final leave/loan approvals |
| `ceo` | Chief Executive Officer | Executive dashboard and reports only — no line-level sales/finance |
| `viewer` | Read-only viewer | Dashboard view only |

Canonical permission lists: `server/auth.js` → `ROLE_DEFINITIONS`.  
Module visibility: [RBAC_MATRIX.md](./RBAC_MATRIX.md).

### 4.2 Segregation of duties (critical paths)

| Process | Create / request | Approve / confirm | Pay / execute |
|---------|------------------|-------------------|---------------|
| Customer refund | Sales (`refunds.request`) | Branch manager, MD, or finance (`refunds.approve` / `finance.approve`) | Finance (`finance.pay`) |
| Customer receipt | Sales / cashier (`receipts.post`) | Finance clearance / bank confirmation | Finance |
| Payment request (office) | Requester | Branch manager (≤ threshold) or MD (> threshold) | Finance pays approved request |
| Below-floor quotation → production | Branch manager records exception | MD confirms after production | — |
| Material incident | Operations creates | Branch manager approves & posts | — |
| Payroll lock | HR prepares run | MD sign-off required | HR locks & exports |
| Staff leave / loan | Employee self-service | HR → branch endorsement → GM HR | — |
| Bank reconciliation | Finance imports lines | Finance matches & posts | — |

Staff-facing summary: [STAFF_APPROVALS.md](./STAFF_APPROVALS.md).  
Technical matrix: [ACCESS_CONTROL.md](./ACCESS_CONTROL.md).

### 4.3 Demo accounts

Development databases ship seeded users (e.g. `admin`, `md`, `finance.manager`). **Change every password before production.** Never use demo credentials in live environments.

---

## 5. Cross-cutting rules

### 5.1 Document numbering

Operational IDs follow **PREFIX-BRANCH-YY-NNNN** (assigned in `server/humanId.js`):

| Prefix | Entity |
|--------|--------|
| `QT-` | Quotation |
| `CL-` | Cutting list |
| `RCP-` / ledger refs | Receipt |
| `PO-` | Purchase order |
| `MEX-` | Material exception |
| `ZR/` | Office filing reference |

With **`ZAREWA_EMPTY_SEED=1`** on a fresh database, numbering starts at **0001** per branch/year — recommended for production cutover.

### 5.2 Approval thresholds (office)

Configurable under **Settings → Governance → Office approval thresholds**:

- **Payment requests:** branch manager approves up to expense threshold (default **₦200,000**); above requires MD/admin.
- **Refunds:** executive sign-off above refund threshold (default **₦1,000,000**).

### 5.3 Filing references

On approval of payment/refund work items the API may issue **`ZR/{branch}/{domain}/{year}/{seq}`** into `work_item_filing`.

### 5.4 Accounting period locks

Back-dating into locked periods is blocked when period lock rules apply. Finance manages locks via `period.manage`.

### 5.5 Audit trail

Sensitive actions write to audit logs (refund create/review/pay, receipt reversals, material incident voids, HR changes). Use **Settings** or report exports for review.

### 5.6 Rate limits

Authenticated ledger money POSTs (receipt, advance, refund-advance) are rate-limited per user (default 45/minute). Configure via `ZAREWA_LEDGER_POST_MAX` and `ZAREWA_LEDGER_POST_WINDOW_MS`.

---

## 6. Module procedures — business operations

### 6.1 Dashboard and workspace

**Purpose:** Personal task queue, office desk, notifications, and cross-module search.

**Who:** All users with `dashboard.view`; office features need `office.use`.

**Procedure — daily workspace check**

1. Sign in and confirm **workspace branch** is correct.
2. Open **Office** (`/office`) or home dashboard.
3. Review **inbox / task queue** — payment requests, material requests, unfiled items.
4. Clear **Unfiled** items by attaching filing references after completion.
5. Use **workspace search** (authenticated; results filtered by permission) to find customers, quotations, coils.

**Office desk operations**

- Create office records (memos, payment requests, material requests) via wizard or compose templates.
- **Inter-branch requests:** branch managers create via API/UI; tracked as work items.
- **AI assist** (optional): memo polish and filing extract when `ZAREWA_AI_API_KEY` is set; works from local knowledge base without AI.

**Runbook:** [OFFICE_OPERATIONS_RUNBOOK.md](./OFFICE_OPERATIONS_RUNBOOK.md)

---

### 6.2 Sales and customers

**Purpose:** Maintain customer master data and sales pipeline entry point.

**Permissions:** `sales.view`, `customers.manage`, `quotations.manage`

**Procedure — new customer**

1. Go to **Sales** or **Customers**.
2. Create customer with legal name, phone (used as dedupe key), branch, and contact details.
3. Verify no duplicate phone exists (system warns on duplicates).

**Procedure — customer dashboard**

1. Open customer from list → `/customers/:customerId`.
2. Review quotations, ledger balance, advances, and refund history.
3. Use customer context when creating new quotations or receipts.

**Controls**

- Customer data is branch-scoped for most roles.
- CEO role cannot access customer line screens (executive summary only).

---

### 6.3 Quotations, cutting lists, and pricing

**Purpose:** Commercial offer → production release → delivery tracking.

**Permissions:** `quotations.manage`, `production.manage`, `production.release`, `deliveries.manage`

**Procedure — create quotation**

1. From Sales, select customer → **New quotation**.
2. Add line items (product, gauge, colour, metres, pricing).
3. System validates against **price list** and **material pricing workbook** floors.
4. Save quotation → receives ID e.g. `QT-KD-26-0042`.

**Procedure — cutting list**

1. From quotation, create **cutting list** when customer payment threshold met (branch `cutting_list_min_paid_fraction`, default 70%).
2. Cutting list date drives **production-attributed revenue** in reports.
3. Operations uses cutting list for coil allocation and job creation.

**Below-floor pricing exception**

1. If quotation is below floor, production start is **blocked**.
2. **Branch manager** records approval (`refunds.approve` + manager role) — flagged for MD review.
3. Production may proceed after BM approval.
4. **MD must confirm** (`md.price_exception.approve`) before customer refunds on that quotation.

**Substitution / accessory rules**

- Substitution credits require correct FG product, gauge/colour, and price list resolution.
- Accessory shortfalls appear in refund preview logic.

**Pricing admin**

- **Price list:** `/price-list` — requires `pricing.manage` (typically MD).
- **Pricing policy:** `/pricing-policy` — `pricing.policy.manage`.

---

### 6.4 Customer finance — receipts, advances, corrections

**Purpose:** Record money in, maintain customer ledger, align with treasury.

**Permissions:** `receipts.post`, `finance.post`, `finance.pay`, `finance.reverse`

**Standard posting flow**

1. Open quotation in Sales or Finance.
2. Review **blue history section** — already-posted receipts are **read-only**.
3. Enter **only new money** in editable lines (today's bank/cash inflow).
4. Add specific reference text (transfer ref, POS slip, deposit detail).
5. **Post receipt** → system creates ledger entry and treasury movement (pending clearance).
6. Confirm receipt ID and amount match physical evidence.

**Finance clearance**

1. Finance opens **Finance & accounts → Receipts**.
2. Each new receipt posts as **Pending clearance** until Finance saves settlement with **bank/cash received** amount.
3. Refunds on a quotation are **blocked** until all receipts on that quote are **Cleared**.

**High-value control**

- Payments **≥ ₦100,000** require amount typed twice (confirm amount) in Sales.

**Correction workflow (wrong or duplicate posting)**

1. Detect issue from **Reports → exception queue** (receipt/treasury mismatch, paid discrepancy).
2. Gather bank/cash evidence.
3. **Reverse** the mistaken posting (do not overwrite history).
4. Verify treasury net corrected for that source.
5. **Re-post** only the true new amount.
6. Confirm quotation `paidNgn` and balance due match expected values.
7. Close queue item with note and owner initials.

**Duplicate override**

- System blocks duplicate-like posts by default.
- Override only with valid business reason and **audit-captured override reason**.

**Deep references**

- [PAYMENT_POSTING_SOP.md](./PAYMENT_POSTING_SOP.md)
- [PAYMENT_POSTING_RUNBOOK.md](./PAYMENT_POSTING_RUNBOOK.md)
- [ACCOUNTING_POLICIES.md](./ACCOUNTING_POLICIES.md) — revenue vs cash definitions

**Cadence**

| Frequency | Action |
|-----------|--------|
| Daily | Clear new payment exceptions |
| Weekly | Finance lead reviews aged exceptions (> 7 days) |
| Month-end | Unresolved queue zero or approved carry-forward notes |

---

### 6.5 Customer refunds

**Purpose:** Return customer money with approval chain and treasury payout.

**Permissions:** `refunds.request`, `refunds.approve`, `finance.pay`

**Procedure — request refund**

1. From quotation or customer dashboard, open **Refund request**.
2. Select category (overpayment, unproduced metres, substitution, transport/installation, order cancellation, etc.).
3. Review system-suggested lines — **starting points only**; verify against evidence.
4. Submit → status **Pending**.

**Procedure — approve refund**

1. Approver (branch manager, MD, or finance with approve permission) opens pending refund.
2. Complete **Approver checklist:**
   - Quote total matches commercial agreement.
   - Paid amount + advance matches receipts/ledger (use **Sync paid from receipts** if needed).
   - Produced metres and deliveries match customer claim.
   - Read **System audit flags** and **Logic & integrity warnings**.
   - Calculated total aligns with requested/approved amount.
   - Evidence on file (notes, photos, signed acknowledgements).
3. Save decision → **Approved**.

**Procedure — pay refund**

1. Finance executes payout via treasury (`finance.pay`).
2. Payout cannot exceed approved balance; staged payouts allowed.
3. Verify treasury movement (`REFUND` / `REFUND_PAYOUT` sources) matches bank records.

**Blocked scenarios**

- Order cancellation **after delivery** is blocked by design.
- Duplicate **same category** on same quote rejected.

**Governance defaults**

| Topic | Baseline |
|-------|----------|
| Single approval cap | Escalate to MD above **₦500,000** (adjust locally) |
| Second pair of eyes | Finance pays only after approval |
| High-value sample | Monthly reconcile all refunds **> ₦1,000,000** |

**Deep reference:** [REFUND_OPERATIONS.md](./REFUND_OPERATIONS.md)

---

### 6.6 Procurement and suppliers

**Purpose:** Source materials, manage PO lifecycle, receive goods, pay suppliers.

**Permissions:** `procurement.view`, `purchase_orders.manage`, `suppliers.manage`, `inventory.receive`

**Procedure — purchase order**

1. Open **Procurement** → create PO for supplier (company-wide master).
2. Add line items (coil, stone, transport, accessories — line types in `poLineTypes`).
3. Submit / approve per local policy.
4. PO ordered value = line qty × agreed prices.

**Procedure — goods receipt (GRN)**

1. On physical receipt, post **GRN** against PO lines.
2. System records `received_at_iso`, derives **landed cost** and **unit cost per kg**.
3. Coil lots enter branch inventory register.

**Procedure — supplier payment**

1. Finance posts supplier payment linked to PO/treasury.
2. Three-way match for month-end: **ordered vs received vs paid**.

**Transport agents**

- Managed at `/procurement/transport-agents/:agentId` — company-wide.

**Stone / accessory procurement**

- Separate flows for stone POs and accessory fulfillment; operations receives into stock.

**Reports**

- Purchases register supports cut by **received**, **ordered**, or **paid** date — see [FINANCE_STANDARD_REPORTS.md](./FINANCE_STANDARD_REPORTS.md).

---

### 6.7 Operations, inventory, and production

**Purpose:** Coil control, production jobs, deliveries — **authoritative operational truth**.

**Permissions:** `operations.view`, `operations.manage`, `production.manage`, `production.release`, `deliveries.manage`, `inventory.receive`, `inventory.adjust`

**Procedure — coil register**

1. Open **Operations** → coil register / coil detail (`/operations/coils/:coilNo`).
2. Track kg, metres, colour, gauge, reservation, and control events.
3. GRN posts increase stock; production consumption decreases.

**Procedure — production job**

1. From cutting list or production queue, create/start job.
2. **Allocate** coil metres to job lines.
3. **Start** production → record progress.
4. On **complete**, record produced metres; offcut/incident metres may be sourced from material exception pool.
5. **Manager review** where policy requires before release.

**Procedure — delivery**

1. Operations confirms delivery / produced status — **not Sales**.
2. Sales sees status read-only where enforced.
3. Delivery truth affects refund eligibility (cancellation after delivery blocked).

**Coil import**

- Settings → Coil register import for bulk opening balances or migrations.

**Controls**

- Coil movements audited via `coil_control_events`.
- Reservation reconciliation scripts available for IT (`db:reconcile-coil-reservation`).

---

### 6.8 Material exceptions and offcuts

**Purpose:** Control stain, production error, customer return, yard offcut, supplier defect with manager approval before stock posts.

**Permissions:** `material_incidents.create`, `material_incidents.approve`

**Workflow**

1. **Operations → Material exceptions → New incident**
2. Enter type, coil/quotation/job links, roll lines, before/after kg, storekeeper + operator names.
3. **Save draft** → **Print** (draft watermark) for yard file if needed.
4. **Submit** → branch manager queue.
5. **Approve & post** → coil kg reduced (if applicable), metres added to incident pool.
6. **Production** picks incident(s) when using offcut stock; completion shows “supplied from offcut”.
7. **Customer return:** choose sellable FG or offcut pool; optional **Create refund request**.

**Anti-theft controls**

- No delete — **void** with reason (manager).
- Pool balance = posted metres minus issues.
- Edit after post requires manager unlock + audit log.

**Deep reference:** [MATERIAL_EXCEPTIONS_SOP.md](./MATERIAL_EXCEPTIONS_SOP.md)

---

### 6.9 Finance, treasury, and GL

**Purpose:** Company money control, GL, bank reconciliation, period close.

**Permissions:** `finance.view`, `finance.post`, `finance.pay`, `finance.approve`, `finance.reverse`, `treasury.manage`, `period.manage`

**Treasury**

- All disbursements require approved payment request or refund (cashier cannot pay without approval).
- Receipt posting creates treasury movements; finance clears against bank.

**Bank reconciliation**

1. **Finance & accounts → Bank reconciliation**
2. Import via **CSV** or **JSON** (up to 500 lines per batch).
3. Match lines to receipts, expenses, supplier payments.
4. Review unmatched items weekly; executive summary shows lines in **Review** status.

**General ledger**

- Chart of accounts seeded; journals posted with `period_key` = `YYYY-MM`.
- GRN with landed cost may auto-post **Dr Inventory, Cr GRNI**.
- Payroll locked runs export **GL journal CSV** for salary expense, PAYE, pension, net pay.

**Inter-branch loans**

- MD approval for inter-branch loan requests (`inter_branch_loan.md_approve`).

**Accounting policies**

- Revenue recognition, AR, purchases, expenses — [ACCOUNTING_POLICIES.md](./ACCOUNTING_POLICIES.md)

**Payment request execution**

1. Requester creates in Office or expenses module.
2. Approver per threshold (branch manager / MD).
3. Finance pays approved request — records treasury outflow.

---

### 6.10 Office, work items, and edit approvals

**Purpose:** Internal correspondence, structured requests, and controlled edits to locked records.

**Office threads**

- Create thread → add messages → convert to payment/material request where applicable.
- AI polish/filing when configured.
- Clear **Unfiled** queue after attaching filing reference.

**Edit approvals**

- Route: `/edit-approvals`
- When a locked field needs change, submit edit approval; authorized manager approves/rejects.

**Filing format:** `ZR/{branch}/{domain}/{year}/{seq}`

**Runbook:** [OFFICE_OPERATIONS_RUNBOOK.md](./OFFICE_OPERATIONS_RUNBOOK.md)

---

### 6.11 Reports and analytics

**Purpose:** Management reporting, month-end packs, exception detection.

**Permissions:** `reports.view` + management role for `/api/reports/*` (see `userMayViewManagementReports` in `server/auth.js`). `finance_manager` included.

**Key reports**

| Report / endpoint | Use |
|-------------------|-----|
| Receipts register | Cash in by date |
| Revenue / production | Production completion attribution |
| AR as-at | Outstanding by quotation |
| Sales bridge | Receipts + production cutoff |
| Expenses pack | Posted expenses |
| Refunds pack | Paid vs pipeline |
| Purchases (ordered/received/paid) | Procurement three-way |
| Stock coil as-at | Inventory snapshot |
| MD operations pack | Monthly exception counts for MD |

**Coil snapshot**

- Finance/report role captures point-in-time coil register: `POST /api/reports/coil-snapshot-capture` with `{ asAtISO }`.

**Exception queues (operational priority)**

1. Receipt/treasury mismatches
2. Quotation paid discrepancies
3. Material incidents pending approval
4. Bank rec lines in Review
5. Payroll drafts without MD sign-off

**Deep reference:** [FINANCE_STANDARD_REPORTS.md](./FINANCE_STANDARD_REPORTS.md), [REPORT_PRINT_STANDARD.md](./REPORT_PRINT_STANDARD.md)

**Analytics**

- `/analytics` — Business intelligence dashboards (management permissions).

---

### 6.12 Human resources

**Purpose:** Employee lifecycle, leave, loans, payroll, attendance, discipline, recruiting.

**Module routes**

- `/my-profile/*` — self-service (leave, loans, payslips where eligible)
- `/team-hr/*` — line manager team view
- `/hr/*` — HR administration
- `/careers` — public job listings (no auth)

**Leave / loan workflow**

| Step | Actor | Permission |
|------|-------|------------|
| Draft / submit | Employee | Self-service + own HR file |
| HR triage | HR officer | `hr.requests.hr_review` |
| Branch endorsement | Branch manager | `hr.branch.endorse_staff` |
| GM HR final | GM HR | `hr.requests.gm_approve` |

**Payroll**

1. HR prepares draft run (`hr.payroll.manage`).
2. **MD must sign off** draft (`hr.payroll.md_approve`) before lock.
3. HR locks run → export payslips / GL journal CSV.
4. GM HR may also approve via `hr.payroll.gm_approve` where configured.

**Attendance**

- Upload and daily roll marking per branch (`hr.attendance.upload`, `hr.daily_roll.mark`).

**HR policies (detailed)**

- [HR/HR-POLICY-LEAVE.md](./HR/HR-POLICY-LEAVE.md)
- [HR/HR-POLICY-PAYROLL.md](./HR/HR-POLICY-PAYROLL.md)
- [HR/HR-POLICY-ATTENDANCE.md](./HR/HR-POLICY-ATTENDANCE.md)
- [HR/HR-POLICY-RECRUITING.md](./HR/HR-POLICY-RECRUITING.md)
- [HR/HR-POLICY-EMPLOYEE-LIFECYCLE.md](./HR/HR-POLICY-EMPLOYEE-LIFECYCLE.md)
- [HR/HR-UAT-CUTOVER.md](./HR/HR-UAT-CUTOVER.md)

---

### 6.13 Settings and master data

**Purpose:** Users, roles, governance, branches, templates, imports.

**Permissions:** `settings.view`, `period.manage`, `*` for full admin

**Key settings areas**

| Area | Content |
|------|---------|
| Users & roles | Create users, assign `role_key`, reset passwords |
| Governance | Office approval thresholds, branch policies |
| Branches | Active branches, cutting list paid fraction |
| Master data workbench | Products, colours, gauges, templates |
| Coil register import | Opening balances / migration |
| Zare intelligence | AI assistant configuration panel (UI); keys in env |
| Accounting periods | Lock/unlock periods |

**Production cutover checklist**

1. Set `ZAREWA_EMPTY_SEED=1` for fresh DB (no demo inflation).
2. Change all seeded passwords.
3. Import master data (staff, opening coils, legacy packs if needed).
4. Run smoke login per critical role.
5. Run `npm run verify:complete` on staging.

---

### 6.14 Executive views

**CEO (`/exec`)**

- Org-wide aggregate counts via `GET /api/exec/summary`.
- Requires `exec.dashboard.view`.
- **No** customer line detail, sales posting, or finance line screens.

**Managing Director**

- Full strategic modules, MD operations pack, price exceptions, payroll sign-off, high-value approvals.
- Reports: `GET /api/reports/md-operations-pack?month=YYYY-MM`

**Branch manager (`/manager`)**

- Branch KPIs, quotation intel, activity timeline, quick actions.

---

## 7. IT operations

### 7.1 Prerequisites and repositories

| Item | Requirement |
|------|-------------|
| Node.js | LTS (Node 20 recommended — match CI) |
| npm | Package install and scripts |
| Database | SQLite file path or MySQL instance |
| Build toolchain | `build-essential` on Linux if native modules compile |
| Frontend | Sibling `Zarewa-frontend-main` or `ZAREWA_FRONTEND_ROOT` |

**Repositories**

- **Backend:** `Zarewa-backend-main` — API, shared logic, docs, e2e
- **Frontend:** `Zarewa-frontend-main` — React SPA

**Quick start (development)**

```bash
# Backend
cd Zarewa-backend-main
npm install
npm run server          # http://127.0.0.1:8787

# Full stack (API + Vite UI)
npm run dev:stack       # requires frontend sibling or ZAREWA_FRONTEND_ROOT
```

Default API port: **8787** (`PORT` env overrides).

---

### 7.2 Environment configuration

Full variable reference: [ENVIRONMENT.md](./ENVIRONMENT.md).

**Production minimum**

| Variable | Example | Purpose |
|----------|---------|---------|
| `NODE_ENV` | `production` | Cookie Secure default, CORS strictness |
| `PORT` | `8787` | Listen port |
| `ZAREWA_DB` | `/var/lib/zarewa/zarewa.sqlite` | Database path |
| `CORS_ORIGIN` | `https://zarewa.example.com` | Allowed SPA origin(s) |
| `COOKIE_SECURE` | `1` | HTTPS cookies |
| `ZAREWA_EMPTY_SEED` | `1` | Clean production seed (recommended) |

**Split deploy additions**

| Variable | Purpose |
|----------|---------|
| `VITE_API_BASE` | Frontend build — API origin |
| `ZAREWA_COOKIE_SAMESITE` | `strict` / `lax` / `none` for cross-site |
| `ZAREWA_COOKIE_DOMAIN` | e.g. `.example.com` for sibling subdomains |

**Optional AI**

| Variable | Purpose |
|----------|---------|
| `ZAREWA_AI_API_KEY` or `OPENAI_API_KEY` | LLM features |
| `ZAREWA_AI_BASE_URL`, `ZAREWA_AI_MODEL` | Provider config |

Never commit `.env` files or secrets to git.

---

### 7.3 Deployment models

#### Combined (single host)

1. Build frontend → copy/serve as `dist/`
2. Set `ZAREWA_STATIC_DIR` if not default
3. Run `node server/index.js`
4. Put nginx/Caddy in front for TLS (recommended)

**systemd example:** see [DEPLOYMENT.md](./DEPLOYMENT.md).

#### Split (UI + API separate)

1. Build frontend with `VITE_API_BASE=https://api.example.com`
2. Deploy `dist/` to static hosting (SPA fallback to `index.html`)
3. Deploy API to VM/container with persistent `ZAREWA_DB` volume
4. Set `CORS_ORIGIN` to exact UI origin(s)
5. Verify cookies and CSRF — see [SPLIT_DEPLOYMENT_AND_MIGRATION.md](./SPLIT_DEPLOYMENT_AND_MIGRATION.md)

**Post-deploy smoke**

```bash
ZAREWA_VERIFY_API_ORIGIN=https://your-api-host npm run verify:split-deploy
# With CORS check:
ZAREWA_VERIFY_API_ORIGIN=https://api.example.com \
ZAREWA_VERIFY_UI_ORIGIN=https://app.example.com \
npm run verify:split-deploy
```

**Automated Ubuntu setup:** `scripts/deploy/setup-ubuntu.sh` — see `scripts/deploy/README.md`.

---

### 7.4 Database, migrations, and seeding

**SQLite (default)**

- File: `data/zarewa.sqlite` (override `ZAREWA_DB`)
- WAL mode, foreign keys enabled
- Migrations run **automatically on startup** via `server/migrate.js`

**Manual migration**

```bash
npm run db:migrate
```

**Fresh empty client database**

```bash
npm run db:fresh-empty
# or wipe + ZAREWA_EMPTY_SEED=1
```

**MySQL**

- Configure `ZAREWA_MYSQL_*` in `.env` (see `.env.example`)
- Smoke test: `npm run mysql:smoke`
- E2E uses separate `zarewa_e2e` database

**Legacy / demo data**

- `npm run db:legacy-demo` — development demo pack only; not for production

**Destructive wipes (development only)**

| Command | Effect |
|---------|--------|
| `npm run db:wipe` | Wipe local MySQL dev data |
| `npm run db:wipe-empty-client` | Wipe to empty client seed |
| `npm run wipe:e2e-db` | Reset Playwright DB only |

---

### 7.5 Backup and recovery

**SQLite production**

1. Schedule **file-level backups** of `ZAREWA_DB`
2. Include `-wal` and `-shm` sidecar files if present
3. Store off-site copies — HR and finance audit data lives in the same file
4. **Stop the service** or use consistent snapshot method before copy on busy systems

**Recovery**

1. Stop API service
2. Restore database file (+ WAL/SHM if applicable)
3. Run `npm run db:migrate` if restoring older backup to newer code version
4. Start service; verify `GET /api/health` → `ok: true`

**RPO/RTO:** Set backup cadence to match business tolerance (daily minimum for active production).

---

### 7.6 Health checks and degraded mode

**Healthy startup**

```bash
curl -sS http://127.0.0.1:8787/api/health
# Expect: { "ok": true, "service": "zarewa-api", "database": true, ... }
```

**Probe paths (all return same JSON shape)**

- `/api/health`, `/api/readyz`, `/api/livez`, `/api/status`
- `/health`, `/healthz`, `/livez`, `/readyz`, `/status`

**Degraded mode** (database connection failed at boot)

- API still listens; health returns HTTP **200** with `ok: false`, `degraded: true`, `bootError`
- All other `/api/*` routes return **503**
- JSON includes `mysqlTarget` and `fixHint` when MySQL expected

**Typical fixes**

1. Start MySQL / verify SQLite path writable
2. Check `ZAREWA_MYSQL_*` or `ZAREWA_DB` in `.env`
3. Run `npm run mysql:smoke`
4. Review server logs for migration errors

**Frontend behaviour in degraded mode**

- Users see offline banner; no saves until API recovers

---

### 7.7 Updates and release verification

**Production update procedure**

```bash
sudo systemctl stop zarewa
cd /opt/zarewa/app
git pull
npm ci
npm run build          # if serving combined SPA
export $(grep -v '^#' .env | xargs)
npm run db:migrate
sudo systemctl start zarewa
curl -sS http://127.0.0.1:8787/api/health
```

**Pre-release verification**

| Command | Scope |
|---------|-------|
| `npm run lint` | Static analysis |
| `npm run test:critical-workflows` | Core regression |
| `npm run verify:ci` | Lint + transaction tests |
| `npm run verify:complete` | Full build + Vitest + Playwright |
| `npm run test:e2e:ops-finance` | Operations + finance E2E |
| `npm run test:e2e:hr` | HR E2E |

See [QA_GATES.md](./QA_GATES.md).

**Go-live checklist:** [DEPLOYMENT.md](./DEPLOYMENT.md)

---

### 7.8 Security hardening

**Before production**

- [ ] Replace all demo passwords; restrict user creation to admins
- [ ] HTTPS everywhere; `COOKIE_SECURE=1`
- [ ] Explicit `CORS_ORIGIN` — never `*` in production
- [ ] Review [ACCESS_CONTROL.md](./ACCESS_CONTROL.md) — login as each critical role, confirm 403s
- [ ] Rotate API keys (AI, Firebase) via environment — not in repo
- [ ] Firewall SSH/admin access
- [ ] Enable ledger rate limits (defaults on; do not set `ZAREWA_TEST_SKIP_RATE_LIMIT` in prod)

**Session security**

- Opaque server-side tokens (not JWT in env)
- CSRF required on mutating requests
- Security headers set in `server/app.js` (CSP, frame denial, nosniff)

**Privileged roles**

- `admin`, `md` — limit active accounts; audit changes

---

### 7.9 Scripts and maintenance tools

| Script | Purpose |
|--------|---------|
| `npm run server` / `start` | Start API |
| `npm run dev:stack` | API + Vite dev |
| `npm run start:lan` | Listen on 0.0.0.0 for LAN testing |
| `npm run db:migrate` | Apply migrations |
| `npm run mysql:smoke` | Test MySQL connectivity |
| `npm run db:sync-opening-coils` | Sync opening coil register |
| `npm run db:reconcile-coil-reservation` | Fix reservation mismatches |
| `npm run import:access-sales` | Legacy sales import pack |
| `npm run import:access-finance` | Legacy finance import pack |
| `npm run hr:import-staff` | Staff XLSX import |
| `npm run retention:prune` | Prune old retention-eligible rows |
| `npm run verify:split-deploy` | Post-deploy API smoke |
| `npm run verify:complete` | Full release gate |

Stress/QA scripts (`stress:*`, `bench:dashboard`) — non-production load testing only.

---

### 7.10 Testing and QA gates

**Layers**

1. **Lint** — `npm run lint`
2. **Unit/integration** — `npm test` (Vitest, `server/**/*.test.js`, `shared/**/*.test.js`)
3. **E2E** — `npm run test:e2e` (Playwright; auto-starts API + UI)
4. **SOP matrix** — `npm run test:e2e:sop-matrix-500` (500-click operational matrix)

**E2E prerequisites (MySQL setups)**

- MySQL on `127.0.0.1:3306`
- `.env` from `.env.example`
- `ZAREWA_FRONTEND_ROOT` pointing to frontend repo

See [OPERATIONAL_CLICK_TESTING.md](./OPERATIONAL_CLICK_TESTING.md).

**Recommended before merge**

```bash
npm run lint
npm run test:critical-workflows
npm run verify:ci
```

---

### 7.11 Incident response

| Symptom | Likely cause | Action |
|---------|--------------|--------|
| Health `ok: false`, `degraded: true` | DB down / bad credentials | Fix DB; restart service |
| Login works, mutations fail 403 | CSRF / cookie SameSite | Check HTTPS, `CORS_ORIGIN`, `ZAREWA_COOKIE_SAMESITE` |
| Login fails entirely | Wrong origin / CORS | Verify UI URL in `CORS_ORIGIN` |
| “System offline” in browser | API unreachable | Check process, firewall, proxy |
| Wrong paid amounts | Posting error | Follow [PAYMENT_POSTING_RUNBOOK.md](./PAYMENT_POSTING_RUNBOOK.md) — reverse, re-post |
| Stuck refunds | Missing clearance | Clear all quotation receipts first |
| Migration error on boot | Schema drift | Restore backup; run `db:migrate` on copy; contact dev |
| AI features 503 | No API key | Set `ZAREWA_AI_API_KEY` or use offline knowledge base |

**Escalation**

1. IT checks health endpoint and logs
2. Finance lead for money discrepancies
3. Branch manager / MD for approval blocks
4. Development team for code defects — attach audit log IDs and reproduction steps

---

## Appendix A — Role quick reference

| I need to… | Who acts |
|------------|----------|
| Approve customer refund | Branch manager, MD, or admin; finance may record approval |
| Pay approved refund | Finance (treasury) |
| Post customer receipt | Sales officer or cashier |
| Clear receipt / confirm bank deposit | Finance or cashier with `finance.pay` |
| Fix wrong receipt | Finance reverses → Sales re-posts correct amount |
| Approve payment request ≤ threshold | Branch manager |
| Approve payment request > threshold | MD |
| Pay approved expense | Finance |
| Receive goods (GRN) | Operations |
| Approve material incident | Branch manager |
| Mark production / delivery complete | Operations |
| Approve below-floor price for production | Branch manager; MD confirms after production |
| Lock payroll | HR after MD payroll sign-off |
| Approve leave / loan | HR queue → branch endorsement → GM HR |
| Import bank statement lines | Finance |
| Change list prices | MD / pricing permission |
| Create users / change roles | Administrator |
| View company-wide exec summary only | CEO |

Full table: [STAFF_APPROVALS.md](./STAFF_APPROVALS.md)

---

## Appendix B — Application route map

| SPA route | API domain (representative) |
|-----------|----------------------------|
| `/sales`, `/customers/*` | `/api/customers`, `/api/quotations`, `/api/sales-receipts` |
| `/procurement/*` | `/api/suppliers`, `/api/purchase-orders`, `/api/stone-*` |
| `/operations/*` | `/api/coil-*`, `/api/production-*`, `/api/material-incidents` |
| `/accounts/*` | `/api/ledger-*`, `/api/treasury-*`, `/api/bank-reconciliation`, `/api/gl-*` |
| `/reports` | `/api/reports/*` |
| `/office` | `/api/office/*`, `/api/work-items/*` |
| `/hr/*`, `/my-profile/*` | `/api/hr/*` |
| `/settings/*` | `/api/users`, `/api/settings/*`, `/api/branches` |
| `/exec` | `/api/exec/summary` |
| Session / bootstrap | `/api/session`, `/api/bootstrap`, `/api/health` |

Complete route list: `server/httpApi.js` (~100 endpoints).

---

## Appendix C — Related documents index

| Topic | Document |
|-------|----------|
| **This manual** | `OPERATIONS_MANUAL.md` |
| Environment variables | [ENVIRONMENT.md](./ENVIRONMENT.md) |
| Deployment | [DEPLOYMENT.md](./DEPLOYMENT.md) |
| Split deploy | [SPLIT_DEPLOYMENT_AND_MIGRATION.md](./SPLIT_DEPLOYMENT_AND_MIGRATION.md) |
| Access control | [ACCESS_CONTROL.md](./ACCESS_CONTROL.md) |
| RBAC / module visibility | [RBAC_MATRIX.md](./RBAC_MATRIX.md) |
| Staff approvals summary | [STAFF_APPROVALS.md](./STAFF_APPROVALS.md) |
| Payment posting | [PAYMENT_POSTING_SOP.md](./PAYMENT_POSTING_SOP.md), [PAYMENT_POSTING_RUNBOOK.md](./PAYMENT_POSTING_RUNBOOK.md) |
| Refunds | [REFUND_OPERATIONS.md](./REFUND_OPERATIONS.md) |
| Material exceptions | [MATERIAL_EXCEPTIONS_SOP.md](./MATERIAL_EXCEPTIONS_SOP.md) |
| Office operations | [OFFICE_OPERATIONS_RUNBOOK.md](./OFFICE_OPERATIONS_RUNBOOK.md) |
| Accounting policies | [ACCOUNTING_POLICIES.md](./ACCOUNTING_POLICIES.md) |
| Finance reports | [FINANCE_STANDARD_REPORTS.md](./FINANCE_STANDARD_REPORTS.md) |
| HR policies | [HR/](./HR/) |
| QA gates | [QA_GATES.md](./QA_GATES.md) |
| UX standards | [UX_STANDARDS.md](./UX_STANDARDS.md) |
| UAT tracks | [UAT_TRACKS_AG.md](./UAT_TRACKS_AG.md) |

---

*Document generated from codebase analysis of Zarewa backend (`server/`, `shared/`, `docs/`) and frontend (`src/App.jsx`, module guards). Update this manual when material workflow or deployment behaviour changes.*
