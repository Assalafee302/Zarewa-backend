# AP3 — Costing policy & cost per metre (roadmap)

## Purpose

AP3 builds the foundation for **true profit**, **cost per metre**, **COGS**, **gross profit**, and **branch production efficiency** without replacing legacy Finance/Treasury (`/accounts`).

| Phase | Scope |
|-------|--------|
| **AP3a** (this doc) | Read-only data readiness audit + proposed costing policy. No GL, inventory, payroll, or AP changes. |
| **AP3b** | Material cost per metre from actual coil consumption (branch / product family). |
| **AP3c** | Labour, diesel, production overhead allocated by branch monthly production metres; branch contribution / P&L views. |

## Business goals (MD)

- True profit and proper accounting
- Cost per metre with fraud/error prevention
- Branch performance visibility
- Costing visible to MD, Head of Accounts, finance manager — not general staff

## Material cost basis (proposal)

- **Primary:** actual coil consumption on completed production jobs (`production_job_coils` × `coil_lots` unit/landed cost).
- **Fallback order:** `unit_cost_ngn_per_kg` → `landed_cost_ngn / weight` → missing (flagged, not guessed).
- **Not in AP3a final cost:** labour, diesel, machine overhead, transport allocation, HQ/admin/selling/owner drawings.

## Labour, diesel, overhead (proposal)

Until job-level time/fuel meters exist:

| Element | Proposed allocation (AP3c) |
|---------|----------------------------|
| Production labour | Branch monthly production metres |
| Diesel / fuel | Branch monthly production metres |
| Production overhead (repairs, consumables, etc.) | Branch monthly production metres |

## Excluded from cost per metre (initially)

- HQ / shared costs
- Admin / office expenses
- Selling / marketing
- Owner drawings / chairman withdrawal

These belong in **branch P&L / contribution** reports later, not in factory cost per metre.

## Costing dimensions

| Start (AP3b) | Later |
|--------------|-------|
| Branch | Gauge / colour |
| Product family (material type) | Quotation / job |

## AP3a readiness requirements (before AP3b/AP3c)

1. Completed jobs with **actual metres** in period
2. **Coil consumption rows** linked to jobs
3. **Coil unit or landed cost** on consumed coils
4. Expenses classified (Wages, Fuel & lubricant, Maintenance, etc.) via `shared/expenseCategories.js`
5. Expenses **branch-tagged** where branch allocation is required
6. Payroll/HR: branch on staff profiles and locked payroll runs (when using payroll for labour)

## API (read-only)

### AP3a — readiness

`GET /api/finance/ap3-costing-readiness`

Query: `branchId`, `period` (YYYY-MM), `materialFamily`, `gauge`, `colour`

### AP3b — material cost per metre

`GET /api/finance/ap3-material-cost-report`

Query: `branchId`, `period`, `materialFamily`, `gauge`, `colour`, `trustFilter` (`trusted`|`partial`), `limitJobs`

Response `status`: `material_cost_only`. **Trusted** totals include only jobs with metres, coil consumption, and full coil unit/landed cost.

Flag: `AP3_MATERIAL_COST_REPORT_ENABLED=1` (default on).

Permissions: same tier as AP1c dry-run (MD, HoA, finance_manager, `accounting.reconciliation.view`, `finance.view` — not cashier-only).

## Approval

The **proposed costing policy** returned by the API is a draft. It requires **MD and Head of Accounts approval** before enabling AP3b/AP3c allocation or any GL impact.

## Safety (AP3a / AP3b)

- No GL posting
- No customer receipt/revenue changes
- No AP/payables or supplier payment changes
- No inventory/coil cost writes
- No payroll changes
- No overhead allocation journals
- No selling-below-cost blocking
- Legacy Treasury UI unchanged

## Environment

AP3a has no feature flags — endpoint is read-only whenever finance desk permissions allow.
