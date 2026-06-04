# Executive Command Centre (`/exec`) — developer notes

`GET /api/exec/dashboard` composes existing BI, management inbox, and operational slices. No separate financial engine.

## Period-aware (uses `period.startISO` / `period.endISO` via `resolveBiPeriodBounds`)

- Produced / quoted sales, collections, quoted collection rate
- Operating expenses and categories
- Top customers by payments
- Branch produced sales, collections, branch expenses (comparison table)

## BI lookback or point-in-time (labelled in UI + `dataScopeNotes`)

- **SKU weeks-cover** — `computeSkuIntelligence` uses multi-month production kg demand, not the dashboard period filter alone. UI shows selected-period metres/revenue from `materialPerformance` where available.
- **Cash-pressure horizons** — `computePredictiveAnalytics` uses ~4-month treasury inflow/outflow averages.
- **Coil inventory valuation** — on-hand snapshot (landed cost × kg).
- **Receivables aging / outstanding** — as-at `period.endISO`.
- **Customer debt** — current outstanding per quotation; not “new debt in period”.

## Count scope (`executiveCounts` metadata)

| Metric | Branch-scoped when `branchScope !== 'ALL'` | Notes |
|--------|---------------------------------------------|--------|
| Pending refunds | Yes | `customer_refunds.branch_id` |
| Pending payment requests | Yes | via `expenses.branch_id` |
| Material incidents | Yes | `material_incidents.branch_id` |
| Price exceptions | Yes | `quotations.branch_id` |
| Pending production jobs | Yes | `production_jobs.branch_id` (`executiveCounts.pendingProductionJobs`) |
| Stock register MD queue | Yes | `listStockRegisterInbox` per branch (`executiveCounts.stockRegisterPendingMd`) |
| Payroll drafts awaiting MD | No | `scopeBasis: company` |
| Bank reconciliation in review | No | `scopeBasis: company` |

## Work tray

- **MD** (inbox permissions): real rows from `listMdAttentionInbox` + extras + optional unified/office items (deduped by `id`).
- **CEO** (read-only): summary rows per queue kind (`summaryOnly: true`); no fake `:queue:N` stubs.

## Estimated metrics (UI)

- Coil valuation, SKU weeks-cover, cash-pressure horizons, and some KPI attributions show an **Est.** chip in the UI.
- `dataScopeNotes` on the dashboard explains when period filters do not apply to a metric.

## Phase 3B — cautious financial decision support (estimated / labelled)

### Working capital snapshot (`workingCapital`)

- **Label:** Estimated working capital snapshot — **not statutory accounts**.
- **Formula (indicative):** Current assets (cash + receivables + estimated inventory) minus current liabilities (AP, approved unpaid payment requests, pending refunds, payroll liability where available, known BI outflow proxy).
- **Limitations:** Missing components stay visible with `available: false`, `estimated: true`, or count-only lines. **Working capital is not free cash** and must not be treated as withdrawable capacity (`notWithdrawableCash: true`).

### Payables & outflows (`payables`)

- AP outstanding and aging from real AP data where available.
- Approved unpaid payment requests and BI pending-outflow proxy.
- PO commitment gap is a **commitment proxy** (ordered − received on PO lines), not booked AP.

### Estimated material cost per metre (`materialCosting`)

- Built from completed `production_jobs`, `production_job_coils`, and `coil_lots` unit/landed cost (plus optional `getCostingSnapshot` standards).
- **Material only** — excludes labour, diesel, machine overhead, transport, and full factory allocation.
- Not “true cost per metre”; if landed/unit cost is missing, rows show cost unavailable (no guessing).

### Targets vs actuals (`targets`)

- **Company-level only** from `org.manager_targets.v1` (`nairaTargetPerMonth`, `meterTargetPerMonth`).
- Compared to period **produced revenue** and **completed job output metres** — not cash-based.
- Status: Ahead / On Track / Behind / **No Target Set** when targets are absent (no fake targets).

### Staff activity (`staffActivity`)

- Activity counts from reliable `user_id` fields (ledger, expenses, payment requests, approvals, work items, office, HR attendance when present).
- **Not performance ranking** — sorted for display only; excludes text-only `handled_by` / operator fields (see `legacyNote`).
- Do not use for bonus or pay without HR policy.

### Reserve policy (`reservePolicy` + `/api/exec/reserve-policy`)

**Phase 3C** adds controlled configuration via `org_policy_kv` and `org_policy_audit` (no headroom formula yet).

| Key | Meaning |
|-----|---------|
| `treasury.reserves.operating_ngn` | Minimum operating cash buffer |
| `treasury.reserves.emergency_ngn` | Emergency reserve |
| `treasury.reserves.payroll_ngn` | Payroll reserve |
| `treasury.reserves.supplier_payment_ngn` | Supplier payment reserve |
| `treasury.reserves.stock_purchase_ngn` | Stock purchase reserve |
| `treasury.reserves.tax_statutory_ngn` | Tax / statutory reserve |
| `treasury.headroom.include_receivables` | Whether receivables count toward indicative expansion headroom (default **false**) |
| `treasury.headroom.include_inventory` | Whether inventory counts toward headroom (default **false**) |
| `treasury.headroom.include_po_commitments` | Whether open PO commitment gap reduces headroom (default **true**) |
| `treasury.headroom.policy_notes` | Optional MD/Finance notes |

**Why receivables and inventory default to excluded:** Outstanding customer debt and stock valuation are not cash. Treating them as withdrawable capacity misstates treasury risk.

**Why PO commitments may reduce headroom:** Open purchase orders (ordered − received) are a **commitment proxy** for future cash outflow even before AP is booked.

**Who can configure:** `treasury.reserve_policy.manage` (MD, finance manager, administrator). CEO and other exec viewers with `exec.dashboard.view` can **read** policy status only.

**Audit:** Each `PUT /api/exec/reserve-policy` writes `org_policy_audit` rows per changed key plus an application audit log entry.

**API:**

- `GET /api/exec/reserve-policy` — read policy + readiness (`exec.dashboard.view`)
- `PUT /api/exec/reserve-policy` — update policy (`treasury.reserve_policy.manage`)

**UI wording:** Use “Reserve policy” and “Indicative expansion headroom”. Do not show “Safe withdrawal amount” or “You can withdraw” on `/exec`. Documentation may explain why safe withdrawal is not shown.

**Phase 3D (not yet):** When policy is complete, the next phase may enable the indicative expansion headroom **formula**. Until then `headroomHidden: true` on dashboard and policy APIs.

## Intentionally not implemented

- Safe withdrawal amount / withdrawal recommendation (requires Phase 3D+ formula sign-off)
- True cost per metre, live break-even KPI, branch profit, staff performance ranking
- Major schema / SKU master redesign
