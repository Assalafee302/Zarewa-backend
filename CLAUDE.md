# Zarewa ERP — working rules for coding sessions

Owner: Abdulrahman (Operations Manager). Prefer architecture-first explanations and phased plans over code dumps.

Frontend lives in the sibling repo `../Zarewa-frontend-main` (report UI, `src/lib/liveAnalytics.js`, `src/lib/reportsPackRows.js`). Shared libs in `shared/lib/` are mirrored to the frontend's `src/shared/lib/` and must stay identical.

## RULES (Reports Phase 1)

- Phase 1 = code only: report calculation and labels. NO database writes, NO migrations, NO data corrections, NO changes to how data is posted (GRN, treasury, refunds, payroll). If a fix seems to need that, stop and tell the owner.
- Production DB is read-only: SELECT only. Avoid heavy queries; the DB reset connections on the slow refund-list step — skip or lighten it.
- Each report's calculation lives in a pure function (data in → rows/totals out) with unit tests on a Kaduna (BR-KD) Sep 2026 fixture (`shared/lib/__fixtures__/kd-2026-09/`). A fix is done only when its tests pass.
- Keep the old version reachable via `?legacy=1` until the owner approves.
- One commit per report. After each report: run it read-only for Kaduna Sep 2026 and give an old vs new comparison table. Then stop for approval before merging.
- Phase 1 work goes on branch `fix/reports-phase1` in both repos, never directly on `main`.
- Order: purchase register → sales → material transaction register → expenses. Do not start Phase 2 (data corrections) or Phase 3 (controls) without being asked.

## Owner decisions

- Purchase register approved 2026-10-13. Supplier balances are exact (no rounding tolerance — PO-0070's ₦400 stays). PO value = ordered qty × unit price (not received qty).
- Recognised sales = sales report rows (receipts on quotations whose first completed production falls in the period, incl. money received earlier) EXCLUDING receipts whose treasury receipt was fully reversed. Suspended receipts that reached the bank and were never reversed stay in, marked suspended.
- Sales report v2 approved 2026-10-14 (frontend `69b6b47`). Accrual section approved 2026-10-14 (frontend `ded7185`, backend `5914833`). Fixture source: ERP export `zarewa-entered-data (8).xlsx`, Kaduna, generated 2026-10-13 14:27 UTC.

## Accounting basis (owner decision 2026-10-14)

- Zarewa uses the **accrual basis**. A sale is recognised when production is complete (job `completedAt`): goods are made to the customer's spec and become theirs on completion.
- Value of a completed quotation = quotation total − refunds whose reason is unproduced meterage, additional services or another value-reducing reason (not pure "Overpayment"). For mixed-reason refunds, only the part above the quote's overpayment counts as value-reducing.
- A job marked Completed with 0 actual metres and 0 kg is NOT a sale; it is listed as an exception (e.g. QT-1643, PRO-KD-26-1349).
- Customer balance = cash received − refunds paid − value produced. > 0 is an advance, < 0 is a debt.
- Sales bridge (must tie to ₦0): cash received − refunds paid + increase in debts − increase in advances = goods produced (net).

## Material register (next step) — owner notes

- Coil quantities shown gross AND net of spool (Aluzinc 65 kg, Aluminium 45 kg per coil; a coil lighter than its spool = nil).
- Per PO: kg ordered vs kg received.

## Tech debt

- `salesPaymentsReceivedRows` (frontend `src/lib/liveAnalytics.js`) is slow on full branch history (7–24 s on the Kaduna fixture): `quotationPaidNgnAsOf` rescans all receipts and rebuilds the companion-overpay map per quotation. Leave until reports Phase 1 is done.

## Release checklist (before shipping reports Phase 1)

- Run the backend DB-backed tests against a real database: `server/finance/reportPeriodSourceOps.test.js` (period source sends `quotationLines` and `accrualTreasuryMovements`). They skip on machines without MySQL, so a green local run is not enough.
- Deploy backend `5914833` (period source) together with frontend `ded7185`+ (accrual section); without it the Accrual section prints an "incomplete balances" warning.

## Phase 4 — data model (recorded, not built)

- Receipts get a **"Paid by (name on bank alert / teller)"** field, entered by the cashier. The sales report's "Paid by" column already reads it first (`paidByName` / `paidBy` / `payerName` on the receipt), then falls back to the matched bank-recon narration, then "not matched". POS card lines carry card/terminal text, not a name, so only this field can fill them.
