# Standard finance reports (API)

Branch-scoped endpoints require `reports.view`. Coil snapshot capture requires `finance.view` **or** `reports.view`.

## Date rules

| Endpoint | Primary dates |
|----------|----------------|
| `GET /api/reports/receipts-register` | Receipt `dateISO` in `[startDate,endDate]`. Rows include `fundSource` (`Bank/Cash` / `Refund credit` / `Mixed`), `refundCreditAppliedNgn`, and `fundNote` when confirm-payment used refund fund. Also returns `creditApplyRows` for period refund-credit applies. |
| `GET /api/reports/revenue-production` | Production completion date in range |
| `GET /api/reports/ar-as-at` | `asAtDate` label only; rows use **live** quote `paidNgn` vs `totalNgn` (`arBasis: quote_row_live`) |
| `GET /api/reports/sales-bridge` | Receipts in period + `asAtDate` for production-cutoff |
| `GET /api/reports/expenses-pack` | **Payout date** of treasury `EXPENSE` / `PAYMENT_REQUEST` cash (net of reversals). Amount = cash paid in range. Unpaid request memos are omitted. Falls back to expense `date` only when no treasury lines are supplied. |
| `GET /api/reports/expense-memo-filing-pack` | Default **payout date** (`dateBasis=paid`) in the month; optional `dateBasis=expense`. Grouped by category for stacked month-end filing. Query: `month=YYYY-MM` or `startDate`+`endDate`; `status=paid\|approved\|all`; optional `category`, `format=json\|pdf\|csv` |
| `GET /api/reports/refunds-pack` | Payout `postedAtISO` in range for paid sheet; `creditAppliedInPeriod` for refund fund used on other quotations; pipeline = non-`Paid` with `creditAppliedNgn` / `usageNote` |
| `GET /api/reports/purchases?cut=` | **received**: `receivedAtISO` on coil lots; **ordered**: PO `orderDateISO`; **paid**: treasury `postedAtISO` (`SUPPLIER_PAYMENT` / `PO_SUPPLIER_PAYMENT`) |
| `GET /api/reports/stock-coil-as-at` | `asAtDate` — uses **snapshot** rows when present, else **live** lots + disclaimer |

## Snapshots

`POST /api/reports/coil-snapshot-capture` body: `{ "asAtISO": "YYYY-MM-DD" }` — replaces snapshots for the session branch from current `listCoilLots`.

## Display IDs

Row fields ending in `Display` strip one leading type prefix (`QT-`, `PO-`, etc.) for dense Excel/print columns; full refs remain in `*Full` fields where applicable.
