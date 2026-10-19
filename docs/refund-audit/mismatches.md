# Refund audit — where the ERP's figure differs from the hand calculation

Restored copy `zarewa_restore_20261014` (14 Oct 2026), read-only. "Fixed" = code on feat/refund-audit; "data" = a
correction for the owner to decide (this branch writes nothing to any database).

| # | Case | ERP figure | Correct figure | Cause | Status |
|---|---|---|---|---|---|
| 1 | QT-KD-26-1777 Gabdo — refundable balance after RF-9776 + QT-1782 credit | ₦0 ("fully covered by existing refund requests") | ₦10,057,600 = 12,000,000 − 1,913,200 − 29,200 | MySQL `SUM()` text + number concatenated to 191,320,029,200 | fixed (hotfix/refund-sums on main; message now shows the parts) |
| 2 | QT-KD-26-1777 — nails shortfall 60 × ₦2,500 | refused by the economic floor (cap ₦0–₦76,900) | ₦150,000 is owed for 60 packs not supplied | Accessory shortfall is floor-gated; the quote is below the roofing floor (₦5,700 vs ₦5,750) so the roofing margin is already used up | **decision** (policy) |
| 3 | RF-KD-26-9734 Mahadi — overpayment offered again as credit | ₦42,766 on offer after a ₦72,216 cash payout | ₦0 (47,450 overpayment line consumed by the payout) | mixed-reason refund counted as not consuming overpayment | fixed (fix/refund-cap-and-mixed-overpay, merged here) |
| 4 | RF-KD-26-9737 Aminu — company cut on the retention ledger | ₦17,476 (two credits of ₦8,738: RCR-KD-26-0117 under source RF-KD-26-9726, RCR-KD-26-0126 backfill) | ₦8,738 | dedupe matched `source_id` only; the script wrote the first row with another refund's id | fixed for the future; **data**: RCW-KD-26-0002 already withdrew both |
| 5 | RF-KD-26-9737 — GL for the ₦899,000 payout TM-KD-26-3167 | no `CUSTOMER_REFUND_PAYOUT_GL` journal | Dr 2500 / Cr 1000 ₦899,000 | payout line posted by a restore script, not `payRefundEntry` | **data** (post the journal) |
| 6 | RF-KD-26-9769 Yunusa — treasury lines | TM-KD-26-3202 ₦730,000 and TM-KD-26-3203 ₦138,352 both "Yunusa Driver" | ₦730,000 to Babangida (customer's nominee), ₦138,352 to Abdulrahman Uthman Sali (staff share) | desk never sent the payee; `counterparty_name` = quotation customer | fixed for new payouts; **data** for 12 existing staff-share lines (listed in the inventory) |
| 7 | AS-001 Mal Amadu Ibrahiim (driver) — bank on file | name "0636783237", account "Ahmed Ibrahim" | name Ahmed Ibrahim, account 0636783237 | profile typed the wrong way round; `ENFORCE_REAL_PAYEE_ACCOUNT` is off so it passed | fixed on read; **data**: AS-001 row + 7 paid refunds (RF-KD-26-9586, 9605, 9675, 9691, 9734, 9780, 9605) |
| 8 | 13 Paid refunds RF-KD-26-9554, 9563, 9564, 9565, 9566, 9567, 9568, 9569, 9570, 9571, 9572, 9576, 9577, 9579 — `paid_amount_ngn` | = approved (e.g. 9565: ₦29,509) | = treasury net (₦23,607, the 80 % after the cut) | before the retention ledger, the company cut was counted as paid; `repairRefundPayoutStateTx` only runs on the next pay | **data**; reports already read treasury lines (`cashPaidNgn`) |
| 9 | RF-KD-26-9500 / 9501 (owner's note) — `paid_amount_ngn` 113,100 / 99,840 | = treasury 15,350 + credit 97,750 / 2,080 + 97,760 | depends on the definition | the column is "money out to payees incl. credit applied" by design; `settlementSummary.cashPaidNgn` is cash only | **decision** (which figure the column should hold) |
| 10 | Approval headroom when credit was moved to another quotation | approved ≤ cash − other refunds (credit out ignored) | approved ≤ cash − other refunds − credit out | raw `SUM()` at approve vs `quotationActiveRefundedTotalNgn` at create | fixed |
| 11 | Payout reversal GL on a refund that was part credit, part cash | GL reversal = `paid_amount_ngn` (cash + credit) | GL reversal = cash reversed | `reverseRefundTreasuryPayouts` used the stored counter | fixed |
| 12 | 17 Paid refunds with approved − paid = ₦200–₦496 (e.g. RF-KD-26-9733: approved 1,000, paid 800) | look like unpaid remainders in a naïve approved − paid view | nothing owed: the gap is the 20 % cut | company cut is retained, not paid | no change (the new "Remaining to pay" arithmetic shows the cut) |
| 13 | Remainder closes above the ₦200 desk cap: RF-KD-26-9715 ₦8,120 (cancelled), RF-KD-26-9702 ₦1,018 (rounding) | closed as rounding/cancelled | posted by a named-remainder script, outside the desk rule | script path | note only |

Not reproducible on this copy (after 14 Oct): RF-KD-26-9796 Adam Suleiman (confirmed ≠ entered; covered by the merged
hotfix and its tests), RF-KD-26-9776 payouts 1,147,000 + 605,600 + 128,480.

## Payee ≠ customer on the restored copy (for the data round)

Treasury lines whose refund has a staff share (`staffBankAccountMatch`) but carry the customer's name: TM-KD-26-3202,
3203 (RF-9769), 3201, 3204 (RF-9770), 3231, 3233 (RF-9777), 3232 (RF-9778), 3240 (RF-9779), 3241, 3242 (RF-9780),
3243, 3244 (RF-9781).
