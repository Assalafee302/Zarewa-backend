# Release — Reports Phase 1 (branch `fix/reports-phase1`)

Status: **approved by the owner, not pushed, not deployed.** Same file in both repos
(`Zarewa-backend-main`, `Zarewa-frontend-main`).

Phase 1 = report calculation and labels only. No database writes, no migrations, no data corrections,
no change to how GRN, treasury, refunds or payroll are posted. Every report keeps its pre-Phase-1 version
behind **`?legacy=1`** on the Reports page (e.g. `https://erp.zarewaglobalservices.com/reports?legacy=1`).

## What changed, per report

### 1. Purchase register (`GET /api/reports/purchase-register`)
- Line total = received qty × unit cost (value at receipt); "Remaining value today" in its own column.
- **Metre-bought aluminium** (PO line type `coil_meter`, metres offered = qty ordered, or price ≥ ₦9,000)
  valued at the amount paid (line amount shared over its coils by kg) — `shared/lib/coilPurchaseUnit.js`.
- Supplier outstanding as at period end for all open POs; AP source id `AP-PO-PO-…` mapped to the PO.
- Paid split: against this period's POs vs payments made this period (incl. earlier POs); overpaid flag;
  "Paid, not yet received" section; stone flat sheets in pieces; real branch name in the header.

### 2. Sales report (frontend, from `GET /api/reports/period-source`)
- Two figures: **Cash received in period** (treasury, by posting date, by account) and **Recognised sales**
  (report rows less receipts fully reversed in treasury; suspended receipts that reached the bank kept, marked).
- Reconciliation recognised → cash, itemised, ending at ₦0 unexplained; receipt/treasury exceptions.
- One row per payment line (treasury movement) with its own account, date and amount; "Paid by" (bank-recon
  narration; receipt payer field first once Phase 4 adds it); print subtotal per split receipt; Excel safe to SUM
  ("Receipt total", "Line x of n").
- **Accrual section**: goods produced at quotation value net of value-reducing refunds (pro-rated by metres),
  customer advances/debts at start and end, sales bridge ending at ₦0, exceptions (0 m jobs, refunds above value,
  double-counted advance application, unassigned treasury lines, stale balances).

### 3. Material transaction register (`GET /api/reports/material-transaction`)
- Coil stock at start/end by roll-back from current kg (movement dates), gross and net of spool
  (Aluzinc/PPGI 65 kg; aluminium by kg 45 kg; aluminium by metre 0), metre-bought coils at amount paid ÷ kg.
- Per PO: kg ordered vs received, bought by kg/metre, cost/kg received, "not weighed?" lines.
- Consumption from COIL_CONSUMPTION movements; jobs with metres but no coil drawn; consumption with no job.
- Per-job: stone-coated by quotation material; movement kg beside job-record kg; **Paid (net) = cash that stayed
  + credit applied − refunds paid**, once per quotation, three columns, "Produced before fully covered" flag;
  balance gaps listed.
- Exceptions: ERP cost/kg ≠ amount paid ÷ kg received, booked late (CL-26-2096 report note), received date ≠ GRN
  movement date, coil spec ≠ PO line, no unit cost, over-coverage (QT-1522/1544/1668/1681 → Phase 2).

### 4. Expenses report (frontend, from period-source)
- Real payment-request status (Paid / Part-paid / Pending payout / Cancelled / No payment request).
- ERP view (unchanged total) + **book view** after rule-based reclassification, every moved line listed:
  R1 refund → Refunds; R2 IOU/staff loan → Staff loans; R3 transformer/NEMSA/generator/machine → Fixed asset;
  R4 washer/felt → Accessories; R5 forklift → Maintenance; R6 imprest → Admin expenses.
  Cancelled requests are left out of the book view and listed.
- Carriage in the book = expense carriage + PO transport paid − expense lines duplicating PO transport.
- Admin salary vs payroll gross; payroll split is an input (HR payroll is a monthly Excel sheet today — the live
  report shows "not in the data source").
- Bridge from expenses by date to payment requests paid in the period.

## Commits

Backend (`fix/reports-phase1`, on top of `origin/main` 7f6a87a — fast-forward):

| Commit | What |
|---|---|
| fab653a | Purchase register v2 (values at receipt, as-at supplier positions) |
| 18ea124 | CLAUDE.md — Phase 1 rules |
| b77acda | CLAUDE.md — accrual basis, tech debt |
| 5914833 | Period source: quotation lines + full treasury history (accrual) |
| 70f901b | CLAUDE.md — release checklist, Phase 4 Paid-by |
| 025917c | Material register v2 — coil roll-back, PO kg, consumption |
| 839bc5c | Material register — metre-bought aluminium, Paid (net) coverage, not weighed |
| 4324616 | Purchase register — metre-bought aluminium at amount paid |
| a384a67 | CLAUDE.md — expenses rules |
| (this) | RELEASE.md, CLAUDE.md payroll source |

Frontend (`fix/reports-phase1`, on top of `origin/main` 97d8f64 — fast-forward):

| Commit | What |
|---|---|
| a00a20f | Purchase register print v2 |
| 69b6b47 | Sales: cash vs recognised, treasury reconciliation |
| ded7185 | Sales: accrual section |
| 69cf8e4 | Sales: one row per payment line, Paid by |
| 1c10645 | Material register print/Excel; sales Excel safe to SUM |
| 81422c9 | Material register print/Excel — bought by, cost/kg, Paid (net) |
| 0c88592 | Sync purchase register metre rule |
| f11debe | Expenses: status, ERP vs book, reclassifications |
| 156c472 | Expenses: R6 imprest, cancelled requests out of the book |
| (this) | RELEASE.md |

## Backend loader changes (read-only)
- `GET /api/reports/period-source` also returns `quotationLines` (flat, split off the quotation rows) and
  `accrualTreasuryMovements` (RECEIPT_IN / ADVANCE_IN / RECEIPT_REVERSAL_OUT / ADVANCE_REVERSAL_OUT / REFUND_PAYOUT
  from the start to period end). Without it the frontend prints "customer balances incomplete".
- `GET /api/reports/material-transaction` (v2) also loads all stock movements to today, purchase orders with
  lines, ledger entries and receipt/refund treasury lines to period end. `?legacy=1` skips them.
- `GET /api/reports/purchase-register` unchanged in shape; `?legacy=1` returns the old builder.
- No schema change, no migration.

## Not part of this release
- Backend working copy: `server/financeWorkItems.js` (bank-recon explained-items labels) — uncommitted, separate.
- Frontend working copy: `bootProgressMath.js`, `rankRefundPayoutOptions.js`, `treasuryTillLane.js` — line endings only.
- `exports/` (local analysis files) — untracked.

## Pre-existing failing tests (not caused by Phase 1, on the tech-debt list)
- `server/materialTransactionReportCore.test.js` — "includes cancelled jobs in cancelled section"
- `shared/lib/hrEmployeeNumber.test.js`
- `shared/lib/helpKnowledge.test.js` — "matches overpayment credit"
- `shared/lib/salesPhase1Recognition.test.js` — "round 6 posted adjustments"

## Checklist
1. **DB-backed tests against a real (non-production) MySQL** — on a dev machine with MySQL running:
   `server/finance/reportPeriodSourceOps.test.js` must run (not skip). The test harness refuses production
   schema names.
2. **Deploy backend and frontend together** (the frontend accrual section needs the new period-source fields).
3. **Smoke test on live**: Reports → Kaduna, 1–30 Sep 2026; compare the headline figures below. The fixtures are
   the ERP export of 13 Oct 2026 14:27 UTC — any posting dated in September made after that changes a figure;
   explain each difference before accepting.
4. `?legacy=1` still opens each old report.

### Smoke-test headline figures (Kaduna, Sep 2026)

| Report | Figure | Expected |
|---|---|---|
| Purchase | Coil value at receipt | ₦121,541,640 (Al 6,970 kg, Az 43,304 kg) |
| Purchase | Stone flat sheets received | 160 pieces |
| Purchase | Payments made in period / of which earlier POs | ₦166,976,070 / ₦15,055,040 |
| Purchase | Outstanding 30 Sep | ₦9,050,400 (PO-0061 ₦9,050,000 + PO-0070 ₦400); PO-0079 overpaid ₦5,920,250 |
| Sales | Cash received | ₦206,631,365 (Taj Bank ₦130,031,071 · Moniepoint ₦76,442,414 · Cash Office ₦157,880) |
| Sales | Recognised sales | ₦209,638,175; reconciliation unexplained ₦0 |
| Sales | Exceptions | LE-1611, LE-1665, LE-1840 |
| Sales — accrual | Goods produced (net) | ₦177,996,973; bridge difference ₦0 |
| Sales — accrual | Debts / advances 31 Aug → 30 Sep | ₦4,891,060 → ₦8,565,982 / ₦37,282,580 → ₦41,079,869 |
| Material | Coil stock 31 Aug | 64 coils, 59,613 kg; spool 3,456 kg / ₦6,768,333 |
| Material | Coil stock 30 Sep (ERP / with CL-26-2096) | 70 coils, 66,655 kg / 71 coils; spool 3,845 kg / ₦7,432,585 |
| Material | Sep coil consumption | 45,313 kg (Al 11,073 · Az 34,240); stone 2,817 m |
| Expenses | ERP total | ₦14,853,736 (116 lines) |
| Expenses | Book: Maintenance / Office / Accessories / Carriage / Admin | ₦919,400 / ₦883,550 / ₦1,027,250 / ₦2,170,410 / ₦33,050 |
| Expenses | Payment requests paid in Sep | ₦14,957,877 (105), unexplained ₦0 |

## Server steps (generic)
1. Log in to the server (SSH).
2. Back up the production database (phpMyAdmin export or `mysqldump --single-transaction`); check the file ends
   with "Dump completed".
3. In the backend folder: `git status --short` must be clean.
4. Run `bash scripts/hostinger-deploy.sh` from the backend folder: stops the API, pulls `main` for backend and
   frontend, runs the boot check, builds the frontend and copies `dist` to `public_html`.
5. Hosting panel → Node.js app → **Stop**, wait until stopped, then **Start** (never an overlapping Restart).
6. `curl -sS https://api.zarewaglobalservices.com/api/health` → `"ok":true`.
7. Smoke test (table above), then confirm `?legacy=1`.

## Rollback
- Report level, no deploy: open the report with `?legacy=1`.
- Code level: revert the merge on `main` in both repos (or check out 7f6a87a / 97d8f64 on the server) and redeploy.
  No data or schema to roll back.
