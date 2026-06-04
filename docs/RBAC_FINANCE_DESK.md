# Finance desk separation — Phase B & B3a (trial)

## Trial / onboarding context (first live month)

Zarewa is in the **first live/trial month** of the new ERP. Production data reflects onboarding, training, and finance-manager assist — not fully mature departmental operations.

**Phase B3a — Trial stabilisation & exception visibility** (current):

- **Compatibility mode stays on** — do not remove legacy finance permissions from cashier/finance_manager yet.
- **Finance manager override** for receipt confirmation remains allowed.
- **Cashier workflows are not blocked** — desk cards guide daily work.
- **Warnings only** for same-user approve/pay and related SoD signals (no hard blocks unless env flags are turned on).
- **Exception summary API** (`GET /api/finance/trial-exceptions`) exposes counts for desks and MD/audit oversight.
- **Strict RBAC is prepared but off by default** (see feature flags below).

After **2–4 weeks** of training and stable cashier confirmation, plan **Phase B3 strict** enforcement (see end of this doc).

## Cashier / Treasury Desk

**Route:** `/cashier`  
**Permissions (new):** `cashier.desk.view`, `cashier.receipts.confirm`  
**Compatibility:** also visible with `finance.pay`, `treasury.manage`, or `receipts.post`

### Responsibilities

- Confirm customer payments (receipt finance settlement / bank received amount)
- Execute **approved** payment requests and refund payouts
- Branch treasury movements (transfers, lodgements) via linked Finance tabs
- Monitor branch cash/bank balances and **server-backed exception counts**

### Training note (B3a)

> Cashier confirms **actual payment received** — not every accounting reconciliation line.

### Should not (target state, after strict phase)

- Post manual GL journals
- Lock/unlock accounting periods
- Own month-end close or draft statutory statements

### Current compatibility mode

The `cashier` role **still includes** legacy `finance.view`, `finance.post`, `finance.approve`, `finance.reverse`, and `reports.view` so existing staff are not blocked during trial.

## Head of Accounts / Accounting Desk

**Route:** `/accounting`  
**Permissions (new):** `accounting.desk.view`, `accounting.reconciliation.view`, `accounting.gl.view`  
**Compatibility:** `finance_manager`, `md`, `admin`, or `finance.view` + `reports.view` (non-cashier roles)

### Responsibilities

- Review **Finance Reconciliation & Cash Confirmation Pack** (Phase A1)
- GL pilot / trial balance / activity
- **Exception summary** — receipt/ledger/treasury mismatches, treasury drift, material recon mismatch
- Month-end close, payroll GL posting, fixed assets (placeholders expanding A2–A4)

### Training note (B3a)

> Head of Accounts **reviews exceptions**, not routine cashier confirmation on every line.

### Should not

- Routine receipt confirmation as primary workflow (Cashier Desk)

## Branch Manager

- Validates quotation/order correctness (`manager_cleared_at_iso`, production gates)
- Reviews mismatches via Management inbox and sales reports
- Does **not** post GL or edit treasury balances

## MD / Audit control

- **Executive Command Centre** — trial oversight cards (high-risk exception counts, dual-control warnings, role adoption)
- `md` receives accounting desk **read** permissions for packs and exec oversight
- Reviews high-value approvals, flagged quotations, refunds — **monitor** control issues during trial; do not treat every count as fraud

## Legacy Finance page

**`/accounts`** remains during transition (treasury, payments, receipts queue, audit tab).

## Exception API (B3a)

`GET /api/finance/trial-exceptions` — authenticated; counts only (no PII).

| Field | Meaning |
|-------|---------|
| `pendingReceiptClearance` | Receipts awaiting finance settlement |
| `receiptBankAmountMismatch` | Bank received ≠ receipt amount (>₦100) |
| `receiptWithoutTreasuryMovement` | Posted receipt with no treasury movement |
| `treasuryMovementWithoutFinanceSettlement` | Treasury in but not finance-cleared |
| `approvedUnpaidPaymentRequests` | Approved, not fully paid |
| `approvedUnpaidRefunds` | Approved, not fully paid out |
| `sameDisplayNamePaymentApprovePay` | Warning count (not blocked in B3a) |
| `treasuryBalanceDriftCount` | Accounts where balance ≠ movement sum |
| `reconciliationMaterialMismatch` | Recent month pack material variance |
| `roleAdoption` | Confirmations/approvals/payouts by role |

Optional query: `?branchId=BR-KD`

## Feature flags (strict phase — **off by default**)

| Env | Default | Purpose |
|-----|---------|---------|
| `STRICT_CASHIER_RBAC` | `0` | When `1`, tighten cashier-only receipt confirmation |
| `ALLOW_ACCOUNTANT_RECEIPT_CONFIRMATION` | `1` | When `0` with strict on, block finance_manager/accountant receipt confirm |
| `ENFORCE_DUAL_CONTROL_PAYMENTS` | `0` | When `1`, block same-user approve+pay (future hook) |

Server helper: `financeStrictBlockWouldApply()` — returns whether a block **would** apply; B3a keeps enforcement off.

## API / mutation policy (unchanged in B3a)

| Endpoint | Phase B3a |
|----------|-----------|
| `PATCH /api/sales-receipts/:id/finance-settlement` | Still `finance.pay` / `finance.post` — finance_manager may confirm |
| `POST /api/gl/journal` | Still `finance.post` |
| AP / revenue / COGS / bank recon / posting logic | **Unchanged** |

## Future Phase B3 strict — after 2–4 weeks stable trial

When operations are ready (cashier confirming most receipts, exceptions trending down):

1. Set `STRICT_CASHIER_RBAC=1` and train staff first with warnings-only period complete
2. Remove `finance.post`, `finance.approve`, `finance.reverse`, `reports.view` from `cashier` where not needed
3. Remove `finance.pay` from `finance_manager` for receipt confirmation (accounting reviews only)
4. Gate settlement API on `cashier.receipts.confirm` (with `ALLOW_ACCOUNTANT_RECEIPT_CONFIRMATION` as break-glass)
5. Set `ENFORCE_DUAL_CONTROL_PAYMENTS=1` after payment/refund workflows are staffed for dual control
6. Keep exception API for ongoing monitoring

## Related docs

- [MONTH_END_CLOSE.md](./MONTH_END_CLOSE.md)
- [RBAC_MATRIX.md](./RBAC_MATRIX.md)
- [ACCOUNTING_POLICIES.md](./ACCOUNTING_POLICIES.md)
