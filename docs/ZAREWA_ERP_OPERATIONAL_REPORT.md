# Zarewa Aluminium & Plastic Ltd — ERP Operational & Training Report

**System:** Zarewa Online Database  
**Prepared from:** Full codebase analysis (backend `server/`, frontend `src/`, `shared/`, `docs/`)  
**Date:** June 2026  
**Evidence base:** `server/auth.js`, `server/schemaSql.js`, `server/httpApi.js`, `server/hrApi.js`, `src/App.jsx`, `docs/OPERATIONS_MANUAL.md`, and related SOPs

---

## SECTION 1 — SYSTEM OVERVIEW

### 1.1 Purpose of the system

Zarewa Online Database is an integrated **multi-branch ERP** for a roofing and building-materials business. It unifies:

- **Commercial** — customers, quotations, cutting lists, pricing
- **Operations** — coil/stone/accessory inventory, production jobs, deliveries, material exceptions
- **Customer finance** — receipts, advances, customer ledger, refunds
- **Corporate finance** — treasury, expenses, payment requests, GL, bank reconciliation
- **Procurement** — suppliers, purchase orders, GRN, supplier payments
- **HR** — staff lifecycle, leave, loans, payroll, discipline, executive benefits
- **Management** — dashboards, standard reports, MD command centre, audit trails

**Technology:** React SPA (Vite) + Node.js/Express 5 API + SQLite (or MySQL) with server-side sessions, CSRF protection, and branch-scoped data.

### 1.2 Departments using the system

| Department | Primary roles | Main modules |
|------------|---------------|--------------|
| Sales | Sales officer, Branch manager | Sales, Customers, Quotations, Receipts, Refunds |
| Operations / Production | Operations officer, Branch manager | Operations, Production queue, Deliveries, Material exceptions |
| Store / Inventory | Operations officer | Coil register, stone/accessory stock, GRN |
| Procurement | Operations officer, MD | Procurement, POs, Suppliers, Transport agents |
| Cash / Treasury | Cashier | Cashier desk, Receipt confirmation, Payouts |
| Finance / Accounts | Accountant, MD | Accounting desk, Treasury, GL, Reconciliation, Reports |
| HR | HR Admin, GM HR, MD | HR admin, Team HR, Executive HR, My Profile |
| Executive | MD, CEO | Executive Command Centre, Executive HR, Approvals |
| IT / Admin | Administrator | Settings, Users, Governance, Migrations |

**Branches:** Kaduna (`BR-KD`), Yola, Maiduguri — most operational data is branch-scoped; MD/GM HR can see org-wide rollups with `hq.view_all_branches`.

### 1.3 Automated business processes

| Process | Automation |
|---------|--------------|
| Document numbering | Auto IDs: `QT-KD-26-0001`, `PO-`, `CL-`, `MEX-`, filing refs `ZR/…` |
| Quotation paid sync | Ledger → quotation `paidNgn` via `syncQuotationPaidFromLedger` |
| Refund preview | Server suggests line items by category (preview version 8) |
| Receipt → treasury | Posting creates ledger + treasury movement (pending clearance) |
| Production revenue attribution | Reports use cutting-list / completion dates |
| Period locks | Block back-dated posts into locked accounting periods |
| Payroll GL/treasury exports | CSV packs from payroll runs |
| Coil month-end snapshot | `POST /api/reports/coil-snapshot-capture` |
| Work item routing | Office threads → payment/material requests → approval queues |
| Audit logging | Refunds, reversals, HR changes, permission overrides |
| Delivery payment gate | Configurable `DELIVERY_PAYMENT_GATE` (off/warn/enforce) |
| Rate limiting | Ledger money posts throttled per user |

**Manual / approval-gated:** Refund approve/pay segregation, BM/MD thresholds, receipt bank confirmation, GRN, production manager sign-off, payroll MD sign-off, price-floor exceptions.

### 1.4 Problems the system solves

| Problem | Solution |
|---------|----------|
| Spreadsheet chaos | Single source of truth for quotes, production, cash |
| Cash vs revenue confusion | Separate receipt clearance, production-attributed revenue, AR-as-at reports |
| Refund fraud / errors | Request → approve → pay chain, dual control, category duplicate blocks |
| Coil traceability | Coil lots, allocations, conversion checks, material incidents |
| Branch silos | Branch-scoped ops with HQ rollups for MD |
| Segregation of duties | Cashier cannot approve refunds; payer ≠ approver (optional dual control) |
| Audit exposure | Immutable-style ledger history (reverse, don't overwrite), audit log, period locks |
| HR compliance | Policy acknowledgements, payroll sign-off chain, leave/loan workflows |

---

## SECTION 2 — MODULE INVENTORY

### 2.1 Sales

| Attribute | Detail |
|-----------|--------|
| **Purpose** | Create commercial offers and track quote-to-cash entry |
| **Key features** | Quotations, line items, price-list validation, BM price exceptions, paid-fraction gates for cutting lists, sales dashboard analytics |
| **Screens** | `/sales` (tabs: Quotations, Payments, Cutting list, Refunds, Customers), `/customers/:id` |
| **Workflows** | Customer → Quote → Payment → Cutting list → Production handoff |
| **Reports** | Sales bridge, revenue-production, top customers (dashboard), sales report pack on `/reports` |

### 2.2 Customer Management

| Attribute | Detail |
|-----------|--------|
| **Purpose** | Master customer data, CRM interactions, AR summary |
| **Key features** | Phone dedupe, branch scope, payment integrity checks, advance balance |
| **Screens** | `/sales` (Customers tab), `/customers/:customerId` (CustomerDashboard) |
| **Workflows** | Create customer → link quotations/receipts → view ledger/refund history |
| **Reports** | AR-as-at, receivables aging (sales dashboard), customer payment integrity API |

### 2.3 Production

| Attribute | Detail |
|-----------|--------|
| **Purpose** | Convert cutting lists to jobs; track metres, conversion, completion |
| **Key features** | Job statuses (Planned/Running/Completed/Cancelled), coil allocation, conversion checks, BM/MD sign-offs, completion corrections |
| **Screens** | `/operations` → Production line tab |
| **Workflows** | Cutting list → register production → start → complete → delivery |
| **Reports** | Revenue-production, material transaction register, conversion review (Manager inbox) |

### 2.4 Procurement

| Attribute | Detail |
|-----------|--------|
| **Purpose** | Buy coils, stone-coated sheets, accessories; manage suppliers |
| **Key features** | PO lifecycle, transport linking, GRN, supplier payments, in-transit loads, procurement dashboard |
| **Screens** | `/procurement`, supplier/transport agent profiles |
| **Workflows** | PO create → receive (GRN) → supplier payment via treasury |
| **Reports** | Purchase register, purchases cut (received/ordered/paid), procurement dashboard KPIs |

### 2.5 Inventory

| Attribute | Detail |
|-----------|--------|
| **Purpose** | Track coil lots, stone/accessory stock, WIP, finished goods |
| **Key features** | Coil split/scrap, stock movements, stone/accessory receipts, month-end stock register, low-stock alerts |
| **Screens** | `/operations` → Stock management, `/operations/coils/:coilNo` |
| **Workflows** | GRN → allocate to job → consume → adjust/incident |
| **Reports** | Stock-coil-as-at, coil snapshot capture, material transaction register, stock register panel |

### 2.6 Finance

| Attribute | Detail |
|-----------|--------|
| **Purpose** | Operating finance: expenses, payment requests, bank recon, AP diagnostics |
| **Key features** | Expense posting, payment request queue, bank CSV import, AP1c/AP2/AP3 pilot tools, credit exceptions |
| **Screens** | `/accounts`, `/accounting`, `/cashier` |
| **Workflows** | Expense → approve → pay; bank recon import → match → post variance |
| **Reports** | Expenses pack, reconciliation pack, finance trial exceptions |

### 2.7 Ledger (Customer sub-ledger)

| Attribute | Detail |
|-----------|--------|
| **Purpose** | Customer advances, receipts, applications, reversals |
| **Key features** | `ledger_entries` table, advance apply, receipt reverse, refund-advance |
| **Screens** | Sales Payments tab, Finance Receipts tab, Customer dashboard |
| **Workflows** | Post receipt → clearance → sync paid on quote |
| **Reports** | Receipts register, receipt/treasury reconciliation rows in reports pack |

### 2.8 Treasury

| Attribute | Detail |
|-----------|--------|
| **Purpose** | Cash/bank accounts and all money movements |
| **Key features** | Treasury accounts, transfers, movement corrections, reserve policy (MD) |
| **Screens** | `/accounts` Treasury tab, Cashier/Accounting desk KPIs |
| **Workflows** | Every payout/receipt posts a `treasury_movements` row |
| **Reports** | Treasury movements in cash/bank AR pack, payroll treasury exports |

### 2.9 Refunds

| Attribute | Detail |
|-----------|--------|
| **Purpose** | Controlled customer money-out with commercial justification |
| **Key features** | 12+ categories, multi-category refunds, preview engine v8, MD threshold, duplicate category block |
| **Screens** | `/sales` Refunds tab, Manager refund inbox, Cashier refund payout queue |
| **Workflows** | Request → approve → treasury payout (see Section 4) |
| **Reports** | Refunds pack (`/api/reports/refunds-pack`), refund period overview on `/reports` |

**Categories** (`shared/refundConstants.js`): Order cancellation, Unproduced meterage, Overpayment, Transport issue, Installation issue, Additional services, Accessory shortfall, Stone flatsheet shortfall, Calculation error, Substitution Difference, Customer commission, Other.

### 2.10 HR

| Attribute | Detail |
|-----------|--------|
| **Purpose** | Employee lifecycle from hire to exit |
| **Key features** | Directory, leave/loan requests, attendance, discipline, letters, recruiting, ID cards |
| **Screens** | `/hr/*`, `/team-hr/*`, `/my-profile/*`, `/executive-hr/*` |
| **Workflows** | Request → HR review → branch endorse → GM approve (see Section 4) |
| **Reports** | `/api/hr/reports/*` — headcount, turnover, absence, payroll readiness |

### 2.11 Payroll

| Attribute | Detail |
|-----------|--------|
| **Purpose** | Monthly payroll preparation, MD sign-off, lock, export |
| **Key features** | Payroll runs, payslips, statutory packs, GL journal template, bank upload CSV |
| **Screens** | `/hr/payroll`, `/executive-hr` payroll oversight |
| **Workflows** | Prepare → GM approve → MD sign-off → lock → export treasury/bank/GL |
| **Reports** | Payslip CSV, statutory pack, HR approval payroll export |

### 2.12 Reports

| Attribute | Detail |
|-----------|--------|
| **Purpose** | Management and month-end packs |
| **Key features** | Excel workbook downloads, print modals, GL pilot section, executive packs |
| **Screens** | `/reports`, Accounting desk Reports tab, HR reports hub |
| **Workflows** | Select period → download pack → reconcile |
| **Reports** | See Section 6 |

### 2.13 Dashboards

| Attribute | Detail |
|-----------|--------|
| **Purpose** | Role-specific operational visibility |
| **Key features** | KPI strips, action inboxes, alerts |
| **Screens** | `/`, `/manager`, `/exec`, `/cashier`, `/accounting`, `/hr/dashboard`, `/analytics` |
| **Workflows** | Daily login → review inbox → act on approvals |
| **Reports** | Embedded mini-reports and links to `/reports` |

### 2.14 User Management

| Attribute | Detail |
|-----------|--------|
| **Purpose** | Create users, assign roles, custom permission overrides |
| **Key features** | Role patch, permissions JSON override, audit on override |
| **Screens** | `/settings/team`, admin user APIs |
| **Workflows** | Admin creates user → assigns role → optional custom perms |
| **Reports** | Permission overrides audit (`/api/admin/permission-overrides-audit`) |

### 2.15 Access Control

| Attribute | Detail |
|-----------|--------|
| **Purpose** | Enforce segregation of duties across UI and API |
| **Key features** | Module guards, finance desk guards, bootstrap row filtering, CSRF |
| **Screens** | All routes (hidden nav if no permission) |
| **Workflows** | Permission check on every mutating API |
| **Reports** | Audit log, edit approvals page |

**Additional modules:** Office/Work items (`office.use`), Pricing admin (`/price-list`, `/pricing-policy`), Edit approvals, Business Intelligence (`/analytics`), Help assistant, Integration API (trial balance export).

---

## SECTION 3 — USER ROLES

Canonical definitions: `server/auth.js` → `ROLE_DEFINITIONS`.

### 3.1 Administrator (`admin`)

| | |
|---|---|
| **Permissions** | `*` (all) |
| **Allowed** | Every module, break-glass approvals, data reset, user admin |
| **Restricted** | None (highest risk — production use limited) |
| **Approval authority** | All workflows |

### 3.2 Managing Director (`md`)

| | |
|---|---|
| **Permissions** | Executive dashboard, procurement manage, refunds approve, pricing, MD price exceptions, inter-branch loans, HR executive bundle, payroll MD approve, GL/reconciliation view, treasury reserve policy |
| **Allowed** | `/exec`, procurement central, refund/price approvals, executive HR, accounting oversight |
| **Restricted** | Day-to-day HR admin shell (uses executive HR instead) |
| **Approval authority** | Refunds (incl. >₦1M threshold), payment requests > threshold, price exceptions post-production, payroll MD sign-off, inter-branch loans, executive benefits |

### 3.3 Accountant / Head of Accounts (`finance_manager`)

| | |
|---|---|
| **Permissions** | Full finance post/pay/reverse, treasury manage, period locks, reports, accounting desk, GL view, audit view |
| **Allowed** | `/accounting`, `/accounts`, `/reports`, bank recon, GL journals |
| **Restricted** | Branch production ops, cashier desk (default), HR admin |
| **Approval authority** | `finance.approve` on refunds/payment requests; pays approved refunds; period locks |

### 3.4 Cashier (`cashier`)

| | |
|---|---|
| **Permissions** | Sales view, receipts post, refunds **request** (not approve), finance pay/post, cashier desk |
| **Allowed** | `/cashier`, `/sales`, receipt posting, refund payout execution |
| **Restricted** | Cannot approve refunds (`refundHandlers.assertCashierMayNotApproveRefund`); no `/accounting`; management `/api/reports/*` blocked by role allowlist despite `reports.view` |
| **Approval authority** | Receipt bank confirmation; executes approved payouts |

### 3.5 Branch Manager (`sales_manager`)

| | |
|---|---|
| **Permissions** | Sales manage, quotations, refunds approve, operations manage, production, deliveries, material incident approve, team HR |
| **Allowed** | `/manager`, `/sales`, `/operations`, `/team-hr` |
| **Restricted** | Main `/hr`, `/executive-hr`, `/accounting`, broad `/accounts` |
| **Approval authority** | Refunds (below MD threshold), payment requests ≤₦200k (default), price-floor exceptions (BM step), material incidents, team leave/loan endorse |

### 3.6 Sales Officer (`sales_staff`)

| | |
|---|---|
| **Permissions** | Sales view, customers, quotations, receipts, refunds request, self-service HR |
| **Allowed** | `/sales`, `/my-profile` |
| **Restricted** | Approvals, operations, finance desks |
| **Approval authority** | None |

### 3.7 Operations Officer (`operations_officer`)

| | |
|---|---|
| **Permissions** | Procurement manage, POs, production manage/release, inventory receive/adjust, deliveries, material incidents create |
| **Allowed** | `/operations`, `/procurement` |
| **Restricted** | Sales approvals, finance, HR admin |
| **Approval authority** | GRN, production status (not commercial refunds) |

### 3.8 HR Admin (`hr_admin`)

| | |
|---|---|
| **Permissions** | Full HR admin bundle: staff manage, payroll prepare/manage, requests review, reports |
| **Allowed** | `/hr/*`, `/reports` |
| **Restricted** | Sales ops, finance desks (except HR-finance exit clear) |
| **Approval authority** | HR request review; payroll prepare (MD signs off) |

### 3.9 GM HR (`gmhr`)

| | |
|---|---|
| **Permissions** | GM approve, final approve, payroll GM approve, org-wide directory |
| **Allowed** | `/hr/*`, HQ staff view |
| **Restricted** | Operational modules |
| **Approval authority** | Final leave/loan; payroll GM approval step |

### 3.10 CEO (`ceo`)

| | |
|---|---|
| **Permissions** | Executive dashboard view, reports view only |
| **Allowed** | `/exec`, `/reports` (read-only summaries) |
| **Restricted** | Customer line screens, transactional modules |
| **Approval authority** | None (oversight only) |

### 3.11 Viewer (`viewer`)

| | |
|---|---|
| **Permissions** | `dashboard.view` only |
| **Allowed** | Workspace home |
| **Restricted** | All transactional modules |
| **Approval authority** | None |

---

## SECTION 4 — END-TO-END BUSINESS FLOWS

### 4.1 Sales Order Process

```
Trigger: Customer enquiry
  → Actions: Create customer → Create quotation (price-list validation)
  → Approvals: BM price exception if below floor; MD confirms after production if exception used
  → Outputs: QT-ID, optional cutting list when paid fraction met (default 70%)
```

| Step | Actor | System action |
|------|-------|---------------|
| 1 | Sales | Create/update quotation lines |
| 2 | Sales | Post receipt(s) → ledger + treasury (pending clearance) |
| 3 | Finance/Cashier | Bank confirmation → receipt cleared |
| 4 | Sales | Create cutting list from quote |
| 5 | Operations | Register production from cutting list |
| 6 | Operations | Complete job → delivery confirm |
| 7 | System | Production-attributed revenue in reports |

### 4.2 Production Process

```
Trigger: Cutting list ready + payment threshold
  → Actions: Allocate coils/stone/accessories → Start job → Complete → Conversion check
  → Approvals: Manager review on conversion flags; BM/MD on exceptions
  → Outputs: Completed metres, WIP consumption, delivery record
```

Statuses: **Planned → Running → Completed** (or **Cancelled**). QC via `production_conversion_checks`. Material incidents can link to refunds.

### 4.3 Inventory Process

```
Trigger: PO received or adjustment needed
  → Actions: GRN (coil/stone/accessory) → Stock movement → Allocate to production job
  → Approvals: Material incident approval (BM)
  → Outputs: Updated coil lots, stock movements, low-stock alerts
```

Month-end: stock register workflow + coil snapshot capture for as-at reporting.

### 4.4 Procurement Process

```
Trigger: Stock need / PO creation
  → Actions: Create PO → Link transport → GRN receive → Supplier payment
  → Approvals: MD for central procurement decisions; finance for payment
  → Outputs: Coil lots, AP records, treasury SUPPLIER_PAYMENT movements
```

### 4.5 Customer Account Process

```
Trigger: Customer payment
  → Actions: Post receipt/advance → Apply advance to quote → Sync paidNgn
  → Approvals: Finance clearance on receipts; reverse requires finance.reverse
  → Outputs: ledger_entries, treasury movements, updated quote balance
```

Refunds blocked until all quote receipts **cleared**.

### 4.6 Refund Process

```
Trigger: Commercial need to return money
  → Actions: Preview → Request (Pending) → Decision (Approved/Rejected) → Pay (Paid)
  → Approvals: BM/MD/finance.approve; MD mandatory above governance threshold (default ₦1M)
  → Outputs: customer_refunds row, treasury REFUND_PAYOUT, audit log entries
```

**Segregation:** Requester ≠ approver; cashier cannot approve; optional payer ≠ approver dual control.

### 4.7 Cash Collection Process

```
Trigger: Customer pays (transfer/cash/POS)
  → Actions: Sales posts receipt → Treasury CREDIT (pending) → Cashier/Finance confirms bank deposit
  → Approvals: High-value (≥₦100k) double-entry confirm in UI
  → Outputs: Cleared receipt, updated AR
```

### 4.8 Expense Process

```
Trigger: Branch incurs cost
  → Actions: Create expense OR office payment request → Approve → Pay via treasury
  → Approvals: BM ≤ threshold; MD above; finance pays
  → Outputs: expense row, payment_request, treasury movement
```

### 4.9 Payroll Process

```
Trigger: Month-end
  → Actions: HR prepares run → GM HR approve → MD sign-off → Lock → Export bank/GL/treasury
  → Approvals: hr.payroll.gm_approve, hr.payroll.md_approve
  → Outputs: Payslips, statutory CSV, GL journal template, treasury payroll pack
```

### 4.10 HR Process (Leave / Loan example)

```
Trigger: Employee self-service request
  → Actions: Submit → HR review → Branch manager endorse → GM HR final approve
  → Approvals: hr.requests.hr_review, hr.branch.endorse_staff, hr.requests.gm_approve
  → Outputs: Updated leave balance / loan schedule; optional finance queue for loan disbursement
```

---

## SECTION 5 — FINANCE & ACCOUNTING

### 5.1 Ledger structure

**General Ledger** (`gl_accounts`, `gl_journal_entries`, `gl_journal_lines`):

| Code | Account | Type |
|------|---------|------|
| 1000 | Cash on hand | Asset |
| 1200 | Accounts receivable | Asset |
| 1300 | Raw materials inventory | Asset |
| 1400 | Supplier advances | Asset |
| 2100 | GRNI | Liability |
| 2200 | Net payroll payable | Liability |
| 2300–2400 | PAYE / Pension payable | Liability |
| 2500 | Customer advances | Liability |
| 4000 | Sales revenue | Revenue |
| 5000 | COGS | Expense |
| 6000 | Payroll expense | Expense |

**Customer sub-ledger** (`ledger_entries`): ADVANCE_IN, RECEIPT, reversals, refund-advance links.

### 5.2 Transaction flow

```
Customer receipt POST
  → insertLedgerRows (RECEIPT)
  → insertTreasuryMovementTx (RECEIPT_IN, pending clearance)
  → syncQuotationPaidFromLedger
  → optional AP1c GL auto-post (receipt policy)

Refund PAY
  → decideRefundRequest (approved)
  → payRefundEntry
  → treasury REFUND_PAYOUT
  → customer_refunds status = Paid

Expense PAY
  → payment_request approved
  → treasury debit
  → expense marked paid
```

### 5.3 Controls

| Control | Implementation |
|---------|------------------|
| Receipt clearance | `sales_receipts` clearance status gates refunds |
| Dual control | `ENFORCE_DUAL_CONTROL_PAYMENTS`, refundHandlers |
| MD thresholds | `org/governance-limits` refundExecutiveThresholdNgn |
| Period locks | `accounting_period_locks`, `period.manage` |
| Audit trail | `audit_log` — refund.create/review/pay, reversals, HR |
| Cashier segregation | `legacyAccountsAccess.js`, finance desk route guards |
| Rate limits | Ledger POST endpoints throttled |

---

## SECTION 6 — REPORTING

### 6.1 API management reports (`/api/reports/*`)

Gate: role in `{admin, md, ceo, sales_manager, finance_manager}` **and** `reports.view`.

| Report | Purpose | Users | KPIs | Decisions |
|--------|---------|-------|------|-----------|
| summary | Aggregate counts | Managers | Totals by domain | Health check |
| receipts-register | Cash in by date | Finance, BM | Receipt amounts, refs | Daily cash reconciliation |
| revenue-production | Sales by production date | BM, MD | Produced revenue | Performance vs targets |
| ar-as-at | Outstanding by quote | Finance | paid vs total | Collection focus |
| sales-bridge | Receipts + production cut | Finance | Bridge metrics | Month-end tie-out |
| expenses-pack | Operating expenses | Finance | By category | Cost control |
| refunds-pack | Paid + pipeline refunds | Finance, BM | Paid vs pending | Refund governance |
| purchase-register | PO register | Procurement | PO values | Spend tracking |
| purchases (cut) | Received/ordered/paid | Finance | Cut-specific | AP accrual |
| stock-coil-as-at | Inventory snapshot | Ops, Finance | kg/m by SKU | Reorder, month-end |
| material-transaction | Stock movements | Ops | In/out register | Traceability |
| md-operations-pack | MD weekly/monthly | MD | Composite ops KPIs | Executive review |
| daily-pack / weekly-pack | Operational packs | Managers | Period snapshots | Stand-ups |

### 6.2 UI report packs (`/reports`)

Excel/print packs include: Period costs & inventory, Cash/bank & AR reconciliation, GL audit, Sales report, Refund report, Ops & procurement, Material transaction, Purchase register, Material exceptions (offcut), Stock register, Executive packs, AP2/AP3 sections (accounting roles), Finance reconciliation pack.

### 6.3 HR reports (`/api/hr/reports/*`)

Headcount, turnover, training expiry, absence, overtime, exit clearance, promotion due, operational readiness — for HR admin and GM HR.

### 6.4 Analytics

`/analytics` — Business Intelligence: production forecast, expense analysis, coil stockout risk, buy/reduce signals.

---

## SECTION 7 — DASHBOARDS

| Dashboard | Route | Audience | Key metrics | Value |
|-----------|-------|----------|-------------|-------|
| Workspace / Office | `/` | All staff | Inbox, tasks, office threads | Daily work queue |
| Manager | `/manager` | Branch manager | Produced sales, collections, refunds inbox, conversion review, material exceptions | Branch control tower |
| Executive Command Centre | `/exec` | MD, CEO | Sales, collections, cash, inventory, expenses, branch scorecard, payables | Company-wide decisions |
| Cashier desk | `/cashier` | Cashier | Pending confirmations, payouts due | Cash execution |
| Accounting desk | `/accounting` | Accountant | Recon warnings, treasury drift, AP diff, costing readiness | Financial control |
| HR dashboard | `/hr/dashboard` | HR admin | Staff counts, pending requests, probation/contracts | HR operations |
| Team HR | `/team-hr` | Branch manager | Endorsements, team attendance | Local HR without salary |
| Business Intelligence | `/analytics` | Management | Forecasts, stock signals | Planning |
| Workspace monitoring | `/workspace/monitoring` | Admin | Cross-module pending counts | IT/ops health |
| Sales dashboard (API) | embedded | Sales manager | Revenue trend, AR aging, top customers | Pipeline management |
| Procurement dashboard | embedded | Ops/MD | Spend, payables aging, coil risk | Buying decisions |

---

## SECTION 8 — DATABASE STRUCTURE

### 8.1 Master data

| Table group | Business meaning |
|-------------|------------------|
| `customers` | Customer master (branch-scoped) |
| `suppliers`, `transport_agents` | Vendor master (company-wide) |
| `products`, `setup_*` | SKU catalog, colours, gauges, price lists |
| `app_users` | Staff accounts and roles |
| `treasury_accounts` | Cash and bank accounts |
| `gl_accounts` | Chart of accounts |
| `hr_staff_profiles` | Employee HR records |

### 8.2 Transaction data

| Table group | Business meaning |
|-------------|------------------|
| `quotations`, `quotation_lines` | Commercial offers |
| `sales_receipts`, `ledger_entries` | Money in |
| `customer_refunds` | Money out (customer) |
| `cutting_lists`, `production_jobs` | Production pipeline |
| `coil_lots`, `stock_movements` | Inventory |
| `purchase_orders` | Buying |
| `treasury_movements` | All cash movements |
| `expenses`, `payment_requests` | Operating costs |
| `gl_journal_entries` | GL postings |
| `hr_payroll_runs`, `hr_requests` | HR transactions |

### 8.3 Key relationships

```
customers 1—* quotations 1—* quotation_lines
quotations 1—* sales_receipts / cutting_lists
cutting_lists → production_jobs → production_job_coils
quotations → customer_refunds (by quote ref)
ledger_entries → treasury_movements (linked sources)
purchase_orders → coil_lots (via GRN)
app_users → hr_staff_profiles (HR extension)
```

### 8.4 Workflow / audit tables

`audit_log`, `approval_actions`, `work_items`, `office_threads`, `material_incidents`, `accounting_period_locks`, `hr_audit_events`.

---

## SECTION 9 — WEBSITE TRAINING GUIDE (PAGE-BY-PAGE)

### 9.1 Authentication

| Page | Purpose | Key actions |
|------|---------|-------------|
| Login | Sign in | Username/password; workspace loads after session |
| Onboarding gate | First-run setup | Complete profile/training flag |

### 9.2 Workspace (`/`)

| Element | Detail |
|---------|--------|
| **Purpose** | Daily starting point — inbox, office desk, notifications |
| **Fields** | Branch selector, search, work item filters |
| **Buttons** | Create office record, open thread, navigate to modules |
| **Common tasks** | Clear inbox, file completed work, respond to payment requests |

### 9.3 Sales (`/sales`)

| Tab | Purpose | Key fields | Buttons | Common tasks |
|-----|---------|------------|---------|--------------|
| Quotations | Manage quotes | Customer, lines, metres, price | New quote, Edit, Revive | Create quote, check paid status |
| Payments | Receipts & advances | Amount, method, reference | Post receipt, Apply advance | Record customer payment |
| Cutting list | Production release | Lines linked to quote | Create CL | Release to ops when paid enough |
| Refunds | Customer refunds | Category, lines, amount | Request, Preview | Start refund workflow |
| Customers | Directory | Phone, name, branch | Open profile | Find customer |

**Quotation modal:** Product, gauge, colour, metres, unit price, total — validates against price list.  
**Receipt modal:** Amount (double confirm if ≥₦100k), payment method, bank ref — posts to ledger.  
**Refund modal:** Category multi-select, breakdown lines, approver checklist, Sync paid from receipts.

### 9.4 Customer Dashboard (`/customers/:id`)

| Element | Detail |
|---------|--------|
| **Purpose** | 360° customer view |
| **Shows** | Quotes, payments, outstanding, timeline, refunds |
| **Actions** | New quote, post receipt, request refund |

### 9.5 Operations (`/operations`)

| Tab | Purpose | Common tasks |
|-----|---------|--------------|
| Overview | Stock + queue summary | Check low stock, queue depth |
| Stock management | GRN, adjustments | Receive coils/stone/accessories |
| Material exceptions | Offcut/incidents | Log and approve incidents |
| Production line | Job queue | Start/complete jobs, conversion review |

**Coil profile (`/operations/coils/:coilNo`):** Traceability — allocations, movements, history.

### 9.6 Procurement (`/procurement`)

| Element | Detail |
|---------|--------|
| **Purpose** | Purchase orders and supplier management |
| **Fields** | Supplier, lines (coil kg / stone m / accessories), transport |
| **Buttons** | New PO, GRN, Link transport, Record payment |
| **Tasks** | Create PO → receive goods → pay supplier |

### 9.7 Cashier Desk (`/cashier`)

| Queue | Action |
|-------|--------|
| Confirm payments | Match bank deposit to receipt |
| Approved payments | Pay expense/payment requests |
| Refund payouts | Execute approved refunds via treasury |

### 9.8 Accounting Desk (`/accounting`)

| Tab | Action |
|-----|--------|
| Overview | Exception KPIs |
| Reconciliation | Receipt/deposit matching, recon pack |
| AP1c/AP2/AP3 | GL alignment pilots |
| Month-end | Close checklist items |

### 9.9 Finance & Accounts (`/accounts`)

| Tab | Purpose |
|-----|---------|
| Treasury | Account balances, transfers |
| Receipts & recon | Clearance workflow |
| Movements | Treasury register |
| Payments | Payment requests |
| Audit | Audit log excerpts |

### 9.10 Reports (`/reports`)

Select date range → download Excel packs or print. Sections gated by accounting permissions.

### 9.11 Manager Dashboard (`/manager`)

Review **Attention**, **Refunds**, **Clearance**, **Production gate**, **Conversion**, **Material exceptions** tabs — approve/reject from inbox.

### 9.12 Executive Command Centre (`/exec`)

Period/branch filters → review KPIs, alerts, branch scorecard, reserve policy.

### 9.13 HR (`/hr/*`)

| Route | Purpose |
|-------|---------|
| `/hr/dashboard` | HR KPIs and today's actions |
| `/hr/employees` | Staff directory |
| `/hr/attendance` | Uploads, daily roll |
| `/hr/leave` | Balances and policies |
| `/hr/payroll` | Runs, lock, exports |
| `/hr/requests` | Leave/loan queue |
| `/hr/recruitment` | Jobs and applicants |
| `/hr/discipline-exit` | Cases and exit clearance |

### 9.14 My Profile (`/my-profile/*`)

Employee self-service: leave request, loan request, payslips, documents, ID card, policies.

### 9.15 Team HR (`/team-hr/*`)

Branch manager: endorse leave/loans, team attendance — **no salary figures**.

### 9.16 Executive HR (`/executive-hr/*`)

MD: payroll sign-off, chairman accounts, salary matrix, exceptional loans, benefits.

### 9.17 Settings (`/settings/*`)

Profile, security, team/users, governance thresholds, data admin, help guide.

### 9.18 Pricing Admin

| Route | Purpose |
|-------|---------|
| `/price-list` | Floor ₦/m maintenance |
| `/pricing-policy` | Trading bands, ridge rules |

### 9.19 Edit Approvals (`/edit-approvals`)

Second-party approval for sensitive data mutations (mutation codes).

---

## SECTION 10 — MANAGEMENT BENEFITS

| Benefit | How Zarewa delivers |
|---------|---------------------|
| **Cost savings** | Fewer spreadsheet errors; automated paid-sync; standard report packs reduce manual Excel work |
| **Time savings** | Unified inbox; refund preview; payroll export packs; workspace search |
| **Operational controls** | Approval chains, thresholds, production gates, delivery payment gate |
| **Fraud prevention** | Segregation (request/approve/pay), duplicate refund block, audit log, no receipt overwrite |
| **Audit readiness** | Immutable-style reversals, period locks, NDJSON audit export, filing references |
| **Inventory visibility** | Coil traceability, low-stock alerts, month-end snapshots, material incidents |
| **Financial visibility** | Treasury movements linked to every cash event; AR-as-at; reconciliation pack |
| **Management reporting** | MD command centre, branch scorecard, BI forecasts, executive report packs |

---

## SECTION 11 — UNIQUE SELLING POINTS

### 11.1 Why this system is powerful

- **Industry-specific:** Coil allocation, conversion checks, stone/accessory shortfalls, corrugation/refund categories — not generic ERP bolt-ons.
- **Quote-to-cash-to-production chain:** Single thread from `QT-` through cutting list, job, delivery, receipt, refund.
- **Embedded controls:** Governance limits, clearance gates, and segregation enforced in API — not policy PDFs alone.

### 11.2 Different from traditional operations

| Traditional | Zarewa |
|-------------|--------|
| WhatsApp + Excel | Branch-scoped online database with audit |
| Same person sells and approves refund | Three-step refund chain |
| Production metres in notebook | Job queue with conversion intelligence |
| Month-end panic | Standard packs + coil snapshot + recon pack |
| HR in separate files | Integrated payroll → treasury → GL export |

### 11.3 Value to management

- **Executive Command Centre** — one screen for sales, cash, inventory, payables, branch comparison.
- **Predictive signals** — BI forecasts, stockout risk, conversion review inbox.
- **Policy enforcement** — MD threshold on refunds, price-floor exceptions, payroll MD sign-off.

### 11.4 Scalability

- Multi-branch architecture with HQ rollups.
- Reference counter numbering per branch/year.
- Integration API for trial balance export.
- Split deployment (frontend/backend repos) for independent scaling.
- Migration system evolves schema without manual SQL.

---

## SECTION 12 — MISSING FEATURES, RISKS & RECOMMENDATIONS

### 12.1 Incomplete or partial modules

| Area | Evidence | Risk |
|------|----------|------|
| Bank reconciliation UI | `docs/MONTH_END_CLOSE.md` — workflow partial | Month-end relies on receipt confirmation not full bank file match |
| Help assistant auto-publish | `docs/HELP_ASSISTANT.md` | Knowledge gaps not self-healing |
| HR profile sections | `docs/HR/PHASE-8-PLAN.md` | Incomplete fields still visible |
| Executive reserve headroom | `docs/EXEC_COMMAND_CENTRE.md` — `headroomHidden: true` | MD sees policy but not full withdrawal recommendation |
| Overtime pay calculation | `docs/HR/PHASE-6-COMPLETION.md` — not implemented by design | Manual overtime payout outside system |
| True cost per metre / branch P&L | Exec command centre gaps | Limited profitability analytics |
| Cashier management reports | Has `reports.view` but blocked from `/api/reports/*` | Role confusion |

### 12.2 Technical risks

| Risk | Mitigation |
|------|------------|
| SQLite single-file DB | Backup discipline; MySQL option for production scale |
| Custom permission overrides | Audit trail exists; review in Settings regularly |
| Trial-phase admin break-glass | Restrict admin accounts in production |
| Large bootstrap payload | `ZAREWA_BOOTSTRAP_MAX_PRODUCTION_ROWS` trim — ops users may need API refresh for old jobs |

### 12.3 Recommended improvements

1. **Complete bank recon workflow** — match import → auto-suggest → post (reduce month-end manual work).
2. **Cashier read-only report slice** — allow receipt/refund register without full management pack.
3. **Branch P&L dashboard** — use AP3 costing readiness data for MD exec view.
4. **Mobile approval app** — UNVEIL checklist exists; dedicated mobile approve flow for BM/MD on refunds.
5. **Production intelligence export** — scheduled variance alerts (planned vs actual metres) to manager email/digest.
6. **HR Phase 9+ cutover** — complete profile quality gates before removing legacy fields.
7. **Training mode** — leverage `training_completed_at_iso` for guided walkthroughs per role.
8. **CSV export automation** — schedule Phase 11 export set for monthly governance sample.

### 12.4 Pre-go-live checklist (from docs)

- Run `npm run verify:ci` and role-based UAT (`docs/UAT_TRACKS_AG.md`)
- Change all demo passwords (`docs/ACCESS_CONTROL.md`)
- Set governance thresholds in Settings
- Configure `DELIVERY_PAYMENT_GATE` for branch policy
- HR cutover: profile quality ≥85%, resolve data cleanup queue (`docs/HR/HR-UAT-CUTOVER.md`)

---

## APPENDIX — KEY CODE REFERENCES

| Topic | File |
|-------|------|
| Roles | `server/auth.js` |
| HR permissions | `server/hrPermissionKeys.js`, `server/hrRoleBundles.js` |
| Module visibility | `shared/lib/moduleAccess.js` |
| Bootstrap filtering | `server/bootstrap.js`, `server/workspaceAccess.js` |
| Refund categories | `shared/refundConstants.js` |
| Refund controls | `server/refundHandlers.js`, `server/controlOps.js` |
| Schema | `server/schemaSql.js` |
| API routes | `server/httpApi.js`, `server/hrApi.js` |
| SPA routes | `Zarewa-frontend-main/src/App.jsx` |
| Operations manual | `docs/OPERATIONS_MANUAL.md` |

---

*End of report. For consolidated source documentation see `docs/ZAREWA_COMPLETE_DOCUMENTATION.md`.*
