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
