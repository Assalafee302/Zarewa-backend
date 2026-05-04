# Standard finance reports (API)

Branch-scoped endpoints require `reports.view`. Coil snapshot capture requires `finance.view` **or** `reports.view`.

## Date rules

| Endpoint | Primary dates |
|----------|----------------|
| `GET /api/reports/receipts-register` | Receipt `dateISO` in `[startDate,endDate]` |
| `GET /api/reports/revenue-production` | Production completion date in range |
| `GET /api/reports/ar-as-at` | `asAtDate` label only; rows use **live** quote `paidNgn` vs `totalNgn` (`arBasis: quote_row_live`) |
| `GET /api/reports/sales-bridge` | Receipts in period + `asAtDate` for production-cutoff |
| `GET /api/reports/expenses-pack` | Expense `date` in range |
| `GET /api/reports/refunds-pack` | Payout `postedAtISO` in range for paid sheet; pipeline = non-`Paid` |
| `GET /api/reports/purchases?cut=` | **received**: `receivedAtISO` on coil lots; **ordered**: PO `orderDateISO`; **paid**: treasury `postedAtISO` (`SUPPLIER_PAYMENT` / `PO_SUPPLIER_PAYMENT`) |
| `GET /api/reports/stock-coil-as-at` | `asAtDate` — uses **snapshot** rows when present, else **live** lots + disclaimer |

## Snapshots

`POST /api/reports/coil-snapshot-capture` body: `{ "asAtISO": "YYYY-MM-DD" }` — replaces snapshots for the session branch from current `listCoilLots`.

## Display IDs

Row fields ending in `Display` strip one leading type prefix (`QT-`, `PO-`, etc.) for dense Excel/print columns; full refs remain in `*Full` fields where applicable.
