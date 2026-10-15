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

## Material register — owner rules (2026-10-14)

- Material register v2 approved 2026-10-14 (backend `025917c`, frontend `1c10645`).
- Coil stock at any date = current kg rolled back by movements dated after that date (movement dateISO, not job completion date). Shown gross AND net of spool; a coil lighter than its spool = nil.
- Spool: Aluzinc (incl. PPGI) 65 kg; Aluminium bought by kg 45 kg; Aluminium bought by METRE 0 (arrives without a spool).
- Aluminium is often bought by the metre (≈ ₦9,500–14,800/m); the PO line stores metres in the kg field and the per-metre price as per-kg. Detection (`purchaseUnitForLine`): metre if lineType coil_meter, or metersOffered = qtyOrdered, or price ≥ ₦9,000. Opening aluminium coils with no PO are metre-bought unless listed in `OPENING_ALUMINIUM_BOUGHT_BY_KG` (CL-KD-APR-1918). Metre-bought coils are valued at line amount ÷ kg actually received (coil weights); every coil whose ERP cost/kg differs is listed.
- Oct 2026 stock-check corrections (ADJUSTMENT / COIL_SCRAP / COIL_RETURN dated from 2026-10-01) are treated as true at earlier dates (not rolled back). Constant `STOCK_CHECK_CORRECTIONS_FROM_ISO` in `shared/lib/coilRegisterCore.js`.
- Received-date corrections are report notes only, never data changes (`COIL_RECEIVED_DATE_CORRECTIONS`: CL-26-2096 received 12 Sep, booked 12 Oct). The ERP figure is always shown; a "with corrections" figure is added when one applies.
- Opening coils with no unit cost are valued at the price recorded on the other coils of the same material in the same opening batch (Aluzinc ₦1,738/kg on 30 Apr 2026) and listed as an exception. This reproduces the owner's 31 Aug / 30 Sep figures.
- Per PO: kg ordered vs received per line; difference per coil should look like the spool. Lines where received = ordered exactly are listed as "not weighed?".
- "Paid (net)" per quotation, as at period end = cash that stayed (treasury receipts net of reversals) + credit applied (OVERPAY_APPLIED / ADVANCE_APPLIED) − refunds paid (treasury), three parts in separate columns, counted once per quotation. Flag "Produced before fully covered" (first job completed while coverage < quotation value) measures the Phase 3 control. Quotations covered above value + own overpayment (credit on top of cash) are exceptions (Kaduna Sep: QT-1522, 1544, 1668, 1681).
- Purchase register uses the same metre rule (owner, 2026-10-14; `shared/lib/coilPurchaseUnit.js`): metre-bought coils valued at amount paid. Kaduna Sep coil GRN value ₦121,541,640 (was ₦121,443,840). Opening per-kg aluminium list confirmed: only CL-KD-APR-1918 (old DB ₦6,050/kg). QT-1522/1544/1668/1681 over-coverage → Phase 2 list.

## Tech debt

- Pre-existing failing tests (not caused by reports Phase 1): `server/materialTransactionReportCore.test.js` "includes cancelled jobs in cancelled section"; `shared/lib/hrEmployeeNumber.test.js`; `shared/lib/helpKnowledge.test.js` "matches overpayment credit"; `shared/lib/salesPhase1Recognition.test.js` "round 6 posted adjustments".

- `salesPaymentsReceivedRows` (frontend `src/lib/liveAnalytics.js`) is slow on full branch history (7–24 s on the Kaduna fixture): `quotationPaidNgnAsOf` rescans all receipts and rebuilds the companion-overpay map per quotation. Leave until reports Phase 1 is done.

## Release checklist (before shipping reports Phase 1)

- Run the backend DB-backed tests against a real database: `server/finance/reportPeriodSourceOps.test.js` (period source sends `quotationLines` and `accrualTreasuryMovements`). They skip on machines without MySQL, so a green local run is not enough.
- Deploy backend `5914833` (period source) together with frontend `ded7185`+ (accrual section); without it the Accrual section prints an "incomplete balances" warning.

## Phase 4 — data model (recorded, not built)

- PO coil lines need an explicit purchase unit (kg | metre); coils need cost/kg = amount paid ÷ kg received (today a metre price is stored as a kg price, overvaluing metre-bought aluminium ≈ 1.6×).

- Receipts get a **"Paid by (name on bank alert / teller)"** field, entered by the cashier. The sales report's "Paid by" column already reads it first (`paidByName` / `paidBy` / `payerName` on the receipt), then falls back to the matched bank-recon narration, then "not matched". POS card lines carry card/terminal text, not a name, so only this field can fill them.

## Expenses report — rules (2026-10-14)

- ERP view by ERP category (total unchanged) + "book" view after rule-based reclassification (frontend `src/lib/expensesReportCore.js`): R1 refund → Refunds; R2 IOU/10U or staff payee + loan/advance → Staff loans; R3 transformer/NEMSA/generator/machine → Fixed asset; R4 washer/felt → Accessories; R5 forklift → Maintenance. First match wins; every moved line is listed. No IDs hard-coded.
- Book carriage = expense carriage + PO transport paid in period − expense lines duplicating a PO transport payment (treasury note names the payment request, or same amount same day).
- Admin salary: salary/wages lines = payroll gross; other lines flagged. HR payroll is NOT in the ERP export — the payroll split (factory / branch / HQ share) is an optional input until a payroll source is wired in.
- Payroll source (owner, 2026-10-14): today a monthly Excel payroll sheet; it moves into the HR module in the HR phase (with PAYE). Until then the expenses report takes the payroll split as an input and the live report says "not in the data source".
- R6 imprest (incl. misspellings) → Admin expenses (EXP-0367). Cancelled payment requests are not expenses: left out of the book view, listed as exceptions (EXP-0398). Book Admin expenses ₦33,050.
- Reports Phase 1 complete and approved 2026-10-14 (frontend `156c472` last). See RELEASE.md; not pushed/deployed until the owner's go-ahead.

## Next data round (owner, 2026-10-15) — recorded, NOT run

- Treasury stored balances: recompute `balance` for treasury accounts 2, 3, 4 from opening + movements with the ERP's own integrity routine (treasury_balance_integrity_runs), with audit. Taj (2) differs by ₦8,533,781 (= 21,401,720 − 12,867,939) from the round-2 opening-balance change. Not inside the 7am window.
- Bank statement lines not in the ERP: round 3 imported links only. Import the 43 unlinked Aug Moniepoint statement lines (owner workbook `Aug2026_bank_to_ERP_links.xlsx`, sheet "Unlinked bank lines") as Review lines, and find the 4 workbook-linked lines missing from bank_reconciliation_lines (Aug Moniepoint statement gap ₦85,300.41). Until then the recon shows them only as the statement gap.
- Seed Aug 2026 statement balances after the round-2 deploy: `node scripts/seed-statement-balances-2026-08.mjs` (dry run), then `--apply`.

## Reports round 2 — release checklist additions

- fix/reports-round2 is NOT in the 7am deploy; merge only after the owner reviews the August PDFs.
- DB-backed test to run against a real MySQL: `server/finance/bankStatementBalanceOps.test.js` (skips without MySQL).
- `PRODUCTION_GATE_REQUIRES_CONFIRMED` (default off): owner switches it on Monday 19 Oct 2026 after the memo; set in the server env and restart.

