# Refund module — inventory (feat/refund-audit, 2026-10-19)

Every path a refund takes, who uses it, what it shows, what it calculates, where the number comes from, and what
can go wrong. Written before any code change. Figures checked on the restored copy `zarewa_restore_20261014`
(840 refunds; read-only, CHECKSUM TABLE before/after in `docs/refund-audit/checksums.md`).

Branch base: `main` 8c57ab1 + `fix/refund-cap-and-mixed-overpay` (f8ba8f1) + `hotfix/refund-uses-confirmed-amount`
(a25755b) + `hotfix/refund-payout-gl-key` (c0a4a14), merged, not rebased, so the three fixes keep their history.
Frontend: `main` 3d9338f + `fix/refund-cap-and-mixed-overpay` (0d9452e).

Legend for "source": `customer_refunds.*` = the refund row; `TM` = `treasury_movements`; `RCA` =
`refund_credit_applications`; `RCR` = `refund_company_retention_entries`; `PWL` = `partner_wallet_entries`;
`GL` = `gl_journal_entries` / `gl_journal_lines`; `LE` = `ledger_entries`.

## A. Raise — Sales refund form

Screen: Sales → Refunds → **New refund** (`src/components/sales/RefundModal.jsx`, 7,250 lines). Used by sales staff
(`refunds.request`); BM/MD open the same modal in view/approve mode.

| # | Block on screen | What it shows | What it calculates / where from | What can go wrong |
|---|---|---|---|---|
| A1 | Quotation picker | Paid quotations with "₦X refundable" | `GET /api/refunds/eligible-quotations` → `getEligibleRefundQuotations`: remaining = cash in − active refunds − credit out (`quotationRefundHardCapNgn`); hidden below ₦1,000 (`MIN_REFUND_QUOTATION_REMAINING_NGN`) | The ₦X here is the **hard cap**; the form later shows a different "Remaining" (A6). Cash in is `quotationPaymentCashBreakdown` (receipts' `bank_received_amount_ngn` once cleared, else `amount_ngn`, plus ADVANCE_APPLIED/OVERPAY_APPLIED, net OVERPAY_ADVANCE). |
| A2 | Hero ribbon | Quote total, "Receipts: ₦", Requested amount, Remaining | Receipts = sum of `intelligence.receipts` cash (`receiptCashReceivedNgn`); Remaining = `preview.remainingRefundableNgn` | "Receipts" is receipt cash only (no advance applied / overpay credit), so it can differ from the cash-in the caps use. |
| A3 | Reason categories (13) | Checkboxes | `REFUND_REASON_CATEGORY_VALUES`; preview marks hard-blocked ones (already refunded, residual 0) | Overpayment + Order cancellation rejected; Order cancellation + Unproduced / transport / install / services rejected; same category twice on one quote rejected while the first is Pending/Approved. |
| A4 | Calculation lines (preview) | One suggested line per category with label + ₦ | `POST /api/refunds/preview` → `previewRefundRequest`: Overpayment = cash in − quote total − overpay already on other refunds − credit applied out (`quotationOverpaymentResidualNgn`); Unproduced = (quoted − produced) m × blended ₦/m; Transport/Installation/Additional services = quoted service lines; Accessory shortfall = (ordered − supplied − already refunded qty) × unit price from `production_job_accessory_usage`; Substitution = (quoted ₦/m − workbook floor for the thinner coil) × coil metres; Customer commission = (quoted ₦/m − floor ₦/m) × same-gauge produced metres capped by remaining; MD discount = ₦/m × produced m; Calculation error = header − line sum; Other = manual | A line amount may be lowered, never raised above the suggested cap (`validateRefundCategorySuggestedCapsNgn`); label-encoded formulas are re-checked (`validateRefundCalculationLineArithmetic`, over-claim only). |
| A5 | Economic floor | Not shown as a number; only the refusal text | `buildRefundEconomicFloorSummary`: max defensible = cash in − Σ(completed metres × workbook floor ₦/m) − prior refunds; applies to every category that is not Overpayment / Transport / Installation / Additional services / MD discount / Customer commission | **Accessory shortfall and Substitution are floor-gated.** On QT-KD-26-1777 (below-floor quote, ₦5,700 vs ₦5,750) the cap is 12,000,000 − 10,068,250 − 1,942,400 = **−10,650 → ₦0**, so the 60-pack nail shortfall (₦150,000) is refused by the floor even after the text-sum fix. Policy question, see decisions. |
| A6 | "Remaining: ₦" / "Remaining refundable" | One amber figure | `quotationRemainingRefundableNgn` = min(hard cap, Σ suggested lines) | It is **the sum of what the system suggests**, not what is refundable. With no suggested lines it falls back to residual overpayment. A cashier/BM reads it as the balance. |
| A7 | Refund total / Requested amount | Lines total; requested must equal lines ± ₦1 | `REFUND_AMOUNT_LINE_TOLERANCE_NGN = 1`; min ₦1,000 | Red text names the failing cap only in words ("Exceeds refundable cash (max ₦X)"); the rule and the components are not shown. |
| A8 | Payout allocation (splits) | Rows: quote customer / associated staff (driver, installer) / claiming staff (HR login via linked customer); per row gross, cut %, net; totals card (Total refund, Allocated gross, Net to payout, Balanced) | `applyRefundStaffAllocationDeduction` (shared): quote customer 0 %; associated staff 3 % (`REFUND_ASSOCIATED_STAFF_DEDUCTION_RATE`); claiming staff / any other customer-kind payee 20 % (`REFUND_STAFF_ALLOCATION_DEDUCTION_RATE`); **payee bank that matches an HR payroll account forces 20 % even on the quote customer's own line** (`markRefundSplitsStaffBankMatch`). Rates can be changed in Settings (`orgPolicy`). Cut = round(gross × rate), net = gross − cut. | The totals card only appears once a split row exists; a single-payee refund shows no cut preview even when the payee bank is an HR account (the 20 % appears only at approval). Row note defaults to "Overpayment · quote customer" even on a staff row (RF-KD-26-9769). |
| A9 | Pay-to bank | Customer saved bank, HR bank, or inline bank | `savedCustomerPayoutAccount`, `associated_staff.bank_*`; an inline account typed here is **saved onto the profile** (`saveRefundPayoutBank`) | `ENFORCE_REAL_PAYEE_ACCOUNT = false` (TEMP): letters, zeros and short numbers pass. Associated staff AS-001 has name and account number swapped (`bank_account_name = '0636783237'`, `bank_account_no = 'Ahmed Ibrahim'`); 7 paid refunds carry it (RF-KD-26-9586, 9605, 9675, 9691, 9734, 9780 …). |
| A10 | Attention / integrity warnings | Production alignment issues, bundled transport+install, uncleared receipts, MD price exception | `validateRefundProductionAlignmentAtSubmit`, `validateBundledTransportInstallCrossRequest`, `quotationHasUnclearedReceipts`, `quotationRefundBlockedPendingMdPriceConfirm` | Uncleared receipt → request refused outright (`RECEIPT_CLEARANCE_REQUIRED`). |
| A11 | Submit | `POST /api/refunds` → `insertRefundRequest` | Checks in order: amount ≥ ₦1,000; quotation customer; splits balance; payee bank; lines = amount; line arithmetic; branch freeze; uncleared receipts; quotation line integrity; duplicate category; category pairs; delivery; commission cap; MD discount note/metres; bundled services; eligibility (`quotationMeetsRefundEligibility`: receipts must cover the quote total, production completed/cancelled, hard cap > 0); economic floor; per-category caps; hard cap; production alignment. Stores `calculation_lines_json`, `split_distributions_json`, `suggested_lines_json`, `preview_snapshot_json`, status Pending. | 24 refusal messages; most say the rule, few give the numbers (see Part 3). The hard-cap refusal "Refundable balance on this quotation is fully covered by existing refund requests." has no figures. |

## B. Approve — BM / MD

Screens: BM command inbox → cash out (`ManagementDecisionModal` → `RefundManagerApprovalPreview.jsx`, 1,839 lines);
MD Decide tab (`ExecutiveWorkItemReviewModal` → same preview). Roles: `refunds.approve` or `finance.approve`;
cashier blocked; requester ≠ approver (admin/MD "trial" bypass is logged `refund.dual_control.admin_trial`).

| # | Block | Shows | Calculates / source | Can go wrong |
|---|---|---|---|---|
| B1 | Request summary | Requested ₦, categories, lines, quote lines with floor ₦/m, accessory issued vs quoted, receipts, production | `GET /api/refunds/intelligence?excludeRefundId=` (fresh preview) + `GET /api/refunds/:id` | Live preview may shrink after production edits → "stale" warnings block approve (`REFUND_STALE_ECONOMIC_FLOOR`). |
| B2 | Approved amount | Editable; default = requested, or requested − credit already applied | `refundDefaultApproveAmountNgn`; lines are rescaled to the approved amount (`scaleRefundCalculationLinesToApprovedAmount`) and re-stored | Approved can only go down. The stored `split_distributions_json` is **not** rescaled; shares are prorated at read time (`resolveCreditTargets`: share = approved × split ÷ Σ splits), so the print shows the old split amounts. |
| B3 | Company-cut waiver | Checkbox + note (≥ 8 chars), Admin/MD/BM only | Re-stores splits with `companyCutWaived` | — |
| B4 | Decision | `POST /api/refunds/:id/decision` → `decideRefundRequest` | Headroom check: approved ≤ cash in − Σ `amount_ngn` of other non-rejected refunds (**credit applied out is not subtracted here**, unlike create which uses `quotationActiveRefundedTotalNgn`); financial guards (`validateRefundFinancialGuards`, phase approve); MD threshold (`refundExecutiveThresholdNgn`, default ₦1,000,000); MD-only categories (MD discount). On approve: company cut posted to the retention ledger **now** (`creditRefundToPartnerWalletTx` → `creditCompanyRetentionFromRefundTx`, RCR row, `payment_note` "Settled at approval: company cut ₦X → retention ledger."); partner-wallet credits when the wallet flag is on; quotation auto manager-cleared. | Refusal "Approved amount exceeds quotation refundable headroom (max ₦X …)" gives one number, no breakdown. Retention dedupe is by `source_id` only: RF-KD-26-9737 has two ₦8,738 credits (RCR-KD-26-0117 posted with `source_id` RF-KD-26-9726 by a script, then RCR-KD-26-0126 backfilled) — ₦8,738 double-counted in retention. |
| B5 | Cancel before pay | Cashier/BM: `POST …/cancel-before-pay` | Only Approved with no payee money out; voids wallet credits and retention credit | — |

## C. Pay — Cashier desk

Screens: Finance → Cashier desk → Refund payouts queue (`FinanceCashierPayoutsPanel`, `FinanceDeskWorkQueues`),
**Pay** (`RefundPayoutModal.jsx`), **View** (`RefundCashierDetailModal.jsx`), Partner wallet panel, Company retention
panel (withdraw the 20 % / 3 % cuts). Role `finance.pay`; CEO/chairman blocked; approver ≠ payer only when
`ENFORCE_DUAL_CONTROL_PAYMENTS=1`.

| # | Block | Shows | Calculates / source | Can go wrong |
|---|---|---|---|---|
| C1 | Queue row | Payee, "Still to pay", status label (Ready / Partially settled / Blocked — clear receipts / Settled – rounding …) | `buildRefundSettlementSummary` (server, `refundPayoutStatus.js`): net cash due = approved − company cut; payee settled = TM payouts (net of reversals) + wallet withdrawn + credit applied (ledger RCA, max with `credit_applied_ngn`); cash outstanding = net due − settled − `remainder_closed_ngn`; till payable = outstanding − held uncleared − open wallet | One figure, no breakdown on the row. |
| C2 | Pay dialog hero | "Payee Cash Due" = sum of the lines typed; "of ₦net" | `refundPayeePayoutQueueLines` → one line per payee with gross, cut, net, paid so far (`buildRefundCashierPayoutLines` splits cash already paid smallest-net-first) | The attribution of past cash to payees is a heuristic (2 payees: by comparing totals); with equal nets it can mis-attribute. |
| C3 | Payout lines | Account, amount, reference, date (part n of m allowed, any day, any account) | `POST /api/refunds/:id/pay` → `payRefundEntry` → `insertTreasurySplitTx` type `REFUND_PAYOUT`, `source_kind` REFUND; `paid_amount_ngn += Σ lines`; status Partially paid / Paid (`resolveRefundStatus`); GL Dr 2500 (or 4000 for concessions) / Cr 1000 keyed `RF:paid:<TM ids>`; LE rows REFUND_ADVANCE / REFUND_OVERPAY / REFUND_CONCESSION | **Treasury line `counterparty_name` is always the quotation customer** (`payload.payeeName` is never sent by the desk), so a staff-share payout (TM-KD-26-3203 ₦138,352 to Abdulrahman) is booked under "Yunusa Driver"; the cash book and the refund report inherit it. A line below ₦100 needs an `amountFloorReason` (`assertTreasuryAmount`). |
| C4 | Uncleared hold | "₦X held until receipts … confirmed" | `refundHeldNetCashDueNgn`: live uncleared receipts of the **payee** (claiming staff's own customer account) | Cashier may override with a 10-char note (logged). |
| C5 | Rounding close | "Close remainder" for ₦2–₦200 | `closeRefundUnpaidRemainder`: `remainder_closed_ngn`, reason rounding/cancelled, status → Paid; ₦1 is already tolerance (`PAYMENT_OUTSTANDING_TOLERANCE_NGN`) | ₦201–₦500 can only be paid; a ₦201 payout needs no reason (floor is ₦100). Restored copy: 10 closes (₦4–₦8,120; the ₦8,120 and ₦1,018 ones were posted by a named-remainder script, above the desk cap). |
| C6 | Reverse payout | Manager (`finance.reverse`): `POST …/reverse-treasury-payout` | Compensating `REFUND_PAYOUT_REVERSAL_IN` per live line; deletes REFUND_* LE rows; GL reversal for **`paid_amount_ngn`**; `paid_amount_ngn = 0`, status Approved | GL reversal uses `paid_amount_ngn`, which also counts credit applied, so a refund that was part credit, part cash reverses too much GL (treasury lines are reversed correctly). |
| C7 | Clear reversed lines | `POST …/clear-reversed-payout-lines` | Deletes a payout+reversal pair from the statement (open month only) | — |
| C8 | Payout-line correction | Cashier desk amend (expense correction path) | `expenseOutflowTreasuryMovementCorrectTx` amends the GL journal by key `RF:paid:TM[#corr]` | Fixed by hotfix/refund-payout-gl-key (merged here). |

## D. Apply as credit

Screens: Receipt confirm (`ReceiptModal` "Apply refund fund" tick), Refund Credit App panel
(`RefundApplyToQuotationPanel`, `RefundCreditApplicationsPanel`), cashier View → apply to quotation.

| # | Block | Calculates / source | Can go wrong |
|---|---|---|---|
| D1 | Eligible sources | `listEligibleRefundCredits`: overpayment-only refunds whose sole payee is the quote customer (Pending/Approved/Partially paid) + unclaimed quote overpayment (`unclaimedOverpayCreditNgn` = max(ledger pool, economic excess) − refund open − refund consumed − credit out − company kept) | Mixed refunds: only the Overpayment line is consumed when paid (fix/refund-cap-and-mixed-overpay, merged). Transport/installation refunds are never credit. |
| D2 | Apply | `applyRefundCreditToQuotation`: RCA row (`CREDIT_APPLY:`), LE OVERPAY_REVERSAL on source + OVERPAY_APPLIED on target, stamps `credit_applied_ngn`, `credit_applied_to_quotation_ref`, `paid_amount_ngn` on the refund; one source must be chosen when several exist | **No GL journal is posted for a credit apply** (the customer-advance balance moves between quotes inside 2500, so none is needed; recorded for completeness). |
| D3 | Reverse credit | `reverseRefundCreditApplication` (`finance.reverse`) | — |
| D4 | Pay after credit | Approval leftover = requested − credit (B2); pay releases conflicting confirm-credit on the source quote when residual is short (`releaseSourceQuoteOverpayCreditsForPayout`) | — |

## E. Print and reports

| # | Where | Shows | Source | Gaps |
|---|---|---|---|---|
| E1 | Refund voucher (A5) — `src/lib/refundRecordPrint.js` | Quotation, customer, reasons with amounts and the formula detail, Pay-to rows (gross, cut %, net, bank), Requested / Approved (date, by) / Paid (date, by, amount), credit applied, "Pay only · after X% cut" badge | `GET /api/refunds/:id` (`payoutHistory`, `settlementSummary`) | Paid block prints one total; **payouts made (part n of m, date, account)** and the **balance left** are not printed; approver/payer names are printed, requester is. |
| E2 | Refund report v2 (`shared/lib/refundReportCore.js`, Reports → refunds pack) | One row per payout line with payee, approver, account, BKR link, red flags (payee ≠ customer, payee = approver, payee = staff, same payee 3+ customers, paid with no TM) | TM + refunds + bank recon | Payee is read from the refund row (`payeeName`), so a two-payee refund shows the header payee on both lines. |
| E3 | Cash book (`shared/lib/treasuryCashBookCore.js`) | `RF-####`, "<customer> refund (QT-####) – part n of m", remark "staff share 80%" when flagged | TM REFUND_PAYOUT, `ctx.refunds`, `ctx.refundPayoutLines` | Description names the customer, never the actual payee (follows C3). |
| E4 | Sales report / accrual bridge | Refunds paid reduce cash; value-reducing refunds reduce recognised sales (owner rule) | `salesAccrualCore`, `salesPhase1Recognition` | Out of scope here (approved 14 Oct). |
| E5 | Company retention panel | Open cuts, withdrawals (cooldown) | RCR / RCW | B4 duplicate inflates "open" by ₦8,738 until withdrawn (it was: RCW-KD-26-0002 took both). |

## F. Notifications / attention

| # | Flag | Where | Rule | Source |
|---|---|---|---|---|
| F1 | Refund approval (`refunds`) | MD Today / Decide, BM inbox, bell | status Pending; "above executive threshold" when ≥ ₦1,000,000; MD discount category | `mdAttentionOps.listMdAttentionInbox` |
| F2 | Approver = payer / requester = approver (`governance`) | same | only when `ENFORCE_DUAL_CONTROL_PAYMENTS=1` | `buildPendingApprovalsReport.dualControlWarnings` |
| F3 | Approved refund not paid (`refund_unpaid`), customer has an open refund, overpayment credit on ledger | exec work tray, cashier desk | on `feat/attention-explain` (not on main yet) | `shared/lib/attentionRules.js` |
| F4 | Hanging refund chip | Receipt confirm, cashier queue | customer has an open refund while a new receipt is confirmed | `hangingRefundIndicatorsByCustomerId` |
| F5 | Payout hold | Pay dialog red banner | `payout_hold` set by BM/MD (`POST …/payout-hold`) | `refundPayoutHoldBlock` |
| F6 | Uncleared receipts | Pay dialog amber banner, queue "Blocked — clear receipts" | C4 | — |

## G. Real cases on the restored copy (as of 14 Oct)

| Case | Row | Stored figures | Hand calculation | Match |
|---|---|---|---|---|
| RF-KD-26-9769 Yunusa (overpayment, 2 payees) | approved 902,940; splits 730,000 customer / 172,940 staff (HR bank match) | cut 34,588, net 138,352; paid 868,352 = TM 730,000 + 138,352 | 172,940 × 20 % = 34,588; 172,940 − 34,588 = 138,352 | ✓ (TM counterparty both "Yunusa Driver" — C3) |
| RF-KD-26-9776 Gabdo (overpayment + substitution) | approved 1,913,200; splits 1,752,600 customer / 160,600 staff | cut 32,120, net 128,480; RCR-KD-26-0134 32,120; not yet paid on this copy | 160,600 × 20 % = 32,120; overpay residual = 12,000,000 − 10,218,200 − 29,200 (credit to QT-1782) = 1,752,600 | ✓ |
| QT-KD-26-1777 nails | accessory usage 95 ordered / 35 supplied @ ₦2,500 | preview would suggest 60 × 2,500 = 150,000; hard cap 12,000,000 − 1,913,200 − 29,200 = 10,057,600 | economic floor cap = 0 (A5) → refused | ✗ policy (see decisions) |
| RF-KD-26-9734 Mahadi (overpay + install + transport, paid to driver AS-001) | 74,450 all to associated staff, 3 % cut 2,234, paid 72,216 | overpay consumed = min(47,450, 72,216) = 47,450 → credit offer 0 | before the merged fix the ERP offered the overpayment again | ✓ after merge |
| RF-KD-26-9737 Aminu | Partially paid 899,000 of 942,690; retention 2 × 8,738 | one cut of 8,738 | double credit (B4); payout TM-KD-26-3167 has **no GL journal** | ✗ data |
| RF-KD-26-9500 / 9501 (owner's note) | paid 113,100 = TM 15,350 + credit 97,750; 99,840 = 2,080 + 97,760 | `paid_amount_ngn` = payouts + credit by design; `settlementSummary.cashPaidNgn` = payouts only | consistent with the code's definition, not with "paid = money out" | definition question |
| Legacy cut inflation | 13 Paid rows (RF-KD-26-9554, 9563–9579) `paid_amount_ngn` = approved while TM = approved − cut | e.g. 9565: paid 29,509, TM 23,607 | `repairRefundPayoutStateTx` only runs on the next pay, never on Paid rows | ✗ data (reports use TM, so cash is right) |
| RF-KD-26-9796 Adam Suleiman, QT-KD-26-1818 | not on this copy (after 14 Oct) | covered by `receiptConfirmedAmountSync` tests (merged hotfix) | — | — |
