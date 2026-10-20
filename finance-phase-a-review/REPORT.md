# Finance page — Phase A (guardrails) — review notes

Branch `feat/finance-guardrails` in both repos. Backend from `69e6c43` (as asked; `main` is now `bccb1c0`, the treasury inflow hotfix, so merge will bring that in). Frontend from `main` `8e5aebf`. Not pushed, not deployed. No DB reads or writes were made.

Screenshots in this folder come from a dev-only preview route (`/preview/finance-guardrails`) on invented fixture data — no backend could run here (no local MySQL; live DB is off-limits from this PC).

## Commits

Backend: b0fdc1e A1 · 7a63a34 A2 · ab4a3af A5 · e193398 A6 · dc52ee7 A7 · cf18028 A8 (A3, A4 are frontend only)
Frontend: 8790639 A1 · 31b44ca A2 · a2a476c A3 · 8d3f970 A4 · 904bde3 A5 · 4f914fb A6 · 3b96298 A7 · f2033d9 A8 · e690385 preview route

## Migrations

One function, `migrateFinanceGuardrailsPhaseA`, new tables only, no data changes:
- `staff_share_payouts` (A7) — unique on (week, branch, staff)
- `bank_statement_imports` (A8)

## API changes (existing endpoints)

| Endpoint | Change |
|---|---|
| POST /api/refunds/:id/pay | 400 `PAYOUT_ACCOUNT_MISSING` if any payee still owed cash has no bank + 10-digit account. 400 `REFUND_STAFF_SHARE_BATCHED` if the payout would reach staff shares under the batch threshold. Success response adds `roundingClosedNgn`. |
| POST /api/payment-requests/:id/pay | 400 `PAYOUT_ACCOUNT_MISSING` |
| POST /api/purchase-orders/:id/post-transport | 400 `PAYOUT_ACCOUNT_MISSING` (account on the transport agent profile); 400 `PAYOUT_ABOVE_QUOTE` above the quoted fee unless `overQuoteReason` from a BM/OM |
| PATCH /api/purchase-orders/:id/link-transport | `PAYOUT_ACCOUNT_MISSING` when it also pays from treasury |
| POST /api/purchase-orders/:id/supplier-payment | 400 `PAYOUT_ABOVE_QUOTE` above the PO value unless `overQuoteReason` (or old `mdNote`) from a BM/OM. Replaces the PO-paid-in-full MD-note cap on this route. |
| POST /api/ledger/receipt | 409 `RECEIPT_DUPLICATE_24H`; accepts `duplicate24hOverrideReason` (BM/OM only, else 403 `MANAGER_OVERRIDE_REQUIRED`) |
| POST /api/bank-reconciliation/import, /import-csv | optional `treasuryAccountId`, `statementToISO`; response adds `statementImport` |
| GET /api/bootstrap → `poTransportAwaitingTreasury` rows | add `transportAgentId`, `payeeName`, `payeeBankName`, `payeeAccountNo` |

New: POST /api/payout-accounts · POST /api/sales-receipts/:id/use-refund-credit-instead · GET /api/staff-share-batches · POST /api/staff-share-batches/pay · PUT /api/staff-share-batches/threshold · GET /api/treasury/statement-freshness

## Decisions to confirm

1. A1 "anything not 10 digits" blocks 11-digit OPay numbers, which the refund form accepts today.
2. A1 applies to every expense payout, including petty cash from the till.
3. A1 blocks all haulage until hauliers have bank details: transport agents had no bank fields; they now live on the agent profile (Add payout account fills them).
4. A1 "Add payout account" only fills a missing account; it never overwrites a usable one (so an approved payout cannot be redirected from the desk).
5. A2 "same CL": a cutting list belongs to one quotation, so this is the same quotation in practice; the rule also matches a shared CL id.
6. A5 covers haulage (post-transport) and supplier payments on the PO route. The AP-invoice pay route already caps at the invoice balance and keeps its old MD-note rule.
7. A7 staff = associated staff + claiming staff (a split to a customer that is not the quote customer); share = that person's net share on the refund. A staff share joins the batch after the customer on that refund is paid. Refunds on a partner wallet are not batched. Auto-rounding runs after each refund payout only — existing open ≤ ₦200 remainders still use the manual button.
8. A8 imports carry date-only lines. Without an explicit `statementToISO`, the time shown is the import time when the last line is today; otherwise only dd/mm. Accounts with no recorded import fall back to their last tagged bank line.

## Tests

New unit tests: shared/lib payoutAccountGuard, receiptDuplicateGuard, overQuotePayout, staffShareBatch, bankStatementFreshness; server managerOverride, receiptUseRefundCreditOps; frontend financePayoutDesk, financeDeskHeadlines, financeManagerOverride, customerOwedCredit, StaffShareBatchPanel. All pass.

Full backend suite: 309 failures on the branch, the same 309 on base `69e6c43` (DB-backed tests with no MySQL here, plus a Vitest-5 `describe.sequential` issue) — none new. Frontend: 1 pre-existing failure on `main` (`startupCrash.authed` cashier desk, 45 s timeout).

DB-backed paths (pay routes, migration, receipt cancel, batch pay) were not run — no MySQL here. Run against a real MySQL before deploy.

## Owner decisions applied (17 Oct)

- D1 — backend `044ec46`, frontend `6d9fe4b`: an 11-digit wallet number starting with 0 is accepted; the 0 is dropped and 10 digits are stored. Anything else not 10 digits is refused.
- D2 — backend `044ec46`, frontend `6d9fe4b` + `7e6840e`: the account rule applies only to lines paid from a Bank or POS account. Cash-account lines need `cashRecipientName` + `voucherReference` (400 `CASH_OFFICE_VOUCHER_REQUIRED`); the voucher becomes the line reference and the note names the recipient. Covers refunds, expenses and the staff-share batch. Cards without an account show "Pay cash" next to "Add payout account".
- D3 haulage: block kept; Add payout account saves to the transport agent profile (as built).
- D4–D6: unchanged.
- Preview route `e690385`: confirmed excluded from the production build (`npm run build`; no gallery code, route or text in `dist`).
- Rebase: waiting for tonight's deploy to land on `main` (`hotfix/refund-sums` and the latest `fix/reports-round2` are not in `main` yet). Dry-run merges against both are conflict-free in both repos.
- DB-backed suites: not run yet — MySQL 8.4 is installed but no server is running on 3306 and no restored dump is loaded.
