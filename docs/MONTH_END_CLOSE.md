# Month-end close — Finance Reconciliation & Cash Confirmation Pack (Phase A1)

## What this pack is

`GET /api/finance/reconciliation-pack?period=YYYY-MM` returns a **read-only, management draft** operational tie-out for a calendar month. It compares:

- **Confirmed sales receipts** (`sales_receipts`, excluding reversed where status exists)
- **Customer ledger receipt-like activity** (`ledger_entries`: RECEIPT, ADVANCE_IN, RECEIPT_REVERSAL)
- **Treasury customer inflows** (`treasury_movements`: RECEIPT_IN, ADVANCE_IN)
- **GL month activity** on cash (1000) and AR (1200) from posted journals
- **Treasury movement summary** by type (`getCashFlowPack`)

Permission: `finance.view`.

Response status: `management_draft`. This is **not** statutory reconciliation or audited financial reporting.

## Why receipt confirmation is the primary cash control

Zarewa’s daily operations rely on **cashier / receipt confirmation**: staff confirm what was actually paid and recorded against customers. That operational control is the practical basis for trusting collections in Phase A.

The pack is designed to **strengthen visibility** around that control by lining up receipts, ledger, treasury, and GL activity — not to replace cashier discipline.

## Receipt confirmation vs formal bank reconciliation

| Control | Owner | Phase A status |
|--------|--------|----------------|
| Receipt confirmation / cashier confirmation | Finance / Cashier / Treasury | **Primary** — reflected in this pack |
| Customer ledger & treasury tie-out | Cashier + Head of Accounts review | **In pack** |
| GL cash/AR month activity | Head of Accounts | **In pack** (activity, not bank balance) |
| Bank statement line import / daily bank line queue | Treasury (when working) | **Partial / future** — do not treat as primary for Phase A |

Formal bank reconciliation UI remains on **Account → Receipts & recon** but is **not** the driver of this pack. Known limitation: bank line workflow may be incomplete; MD and Head of Accounts should treat variances against **receipt confirmation**, not assumed bank-file completeness.

## Role split

| Function | Responsibility |
|----------|----------------|
| **Head of Accounts** (Accounting) | GL, journals, chart of accounts, reconciliation review, financial reports, month-end close, payroll posting coordination, accounting controls |
| **Cashier / Treasury** (Finance) | Receipt confirmation, actual cash/bank movement, treasury accounts, payment execution after approval, refund payout confirmation, daily collections, payment evidence |
| **MD** | Audit/control oversight, exception review, high-value approval, audit trail monitoring |

## What to review monthly (Phase A1)

1. Load the pack for the closing month (`Reports` → **Finance Reconciliation & Cash Confirmation Pack**).
2. Compare **confirmed sales receipts** vs **ledger receipt-like** vs **treasury customer inflow** — investigate warnings.
3. Review **GL 1000 / 1200 month activity** with Head of Accounts (remember: period activity, not bank or full AR balance).
4. Scan **treasury movement summary** for unexpected types or signs.
5. Read **notes** (including “Requires Head of Accounts review” and formal bank reconciliation pending).
6. Continue separate month-end tasks: period lock, stock register, payroll GL export, AP bridge (ordered vs received) — see accounting policies doc.

## Known limitations

- GL figures in the pack are **period journal activity**, not point-in-time control account balances.
- Treasury movements are **not branch-scoped** in the schema; branch filter applies to receipts/ledger where `branch_id` exists.
- No trade payables GL tie-out, inventory tie-out, or payroll liability tie-out in Phase A1.
- Customer receipt GL posting model (Dr 1000 / Cr 1200 on receipt) may differ from quotation-based AR — variances can be expected until policy alignment.
- Pack does **not** enforce period locks on read; locking still blocks backdated writes via `assertPeriodOpen`.
- **No data is changed** by calling this endpoint.

## API example

```
GET /api/finance/reconciliation-pack?period=2026-05
GET /api/finance/reconciliation-pack?period=2026-05&branchId=BR-YL
```

Invalid period → `400` with `{ "ok": false, "error": "Invalid period. Use YYYY-MM." }`.

## Related docs

- [ACCOUNTING_POLICIES.md](./ACCOUNTING_POLICIES.md) — PO ordered / received / paid bridge
- [FINANCE_STANDARD_REPORTS.md](./FINANCE_STANDARD_REPORTS.md) — operational report endpoints
- [REGRESSION_ACCOUNT_FINANCE.md](./REGRESSION_ACCOUNT_FINANCE.md) — manual regression after finance changes

## Phase A roadmap (after A1)

- **A2** — Draft statements pack (P&amp;L, balance sheet, labelled management draft)
- **A3** — Data-quality checks (null coil costs, missing GL sources, etc.)
- **A4** — Month-end checklist endpoint
- **A5** — AP received-basis correction (separate approval; not part of A1)
