# The 10 most complicated refunds — test cases for the refund fixes (2026-10-19)

Source: production `u172282559_ZAREWA`, SELECT only (refunds up to 19 Oct). Fixture:
`exports/refund-test-cases-2026-10-19.json` (phone and account numbers keep the last 4 digits, also where an account
number sits in a name field). Selection SQL: `exports/refund-pick-selection-2026-10-19.sql` (also at the end of this
file). Scoring: one point per criterion 1–8, +1 for a duplicated retention credit, +½ for a payout hold; the six
must-include refunds are kept whatever their score. 854 refunds scored (rejected ones left out).

## The ten, by score

| # | Refund | Customer · quotation | Score | Criteria | Approved | Paid (row) | Treasury net | Customer share | Staff share | Company cut | Credit applied | Confirmed paid on quote |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | RF-KD-26-9579 | Yahuza · QT-KD-26-1384 | 5 | 1 2 3 4 7 | 3,695,600 | 3,695,520 | 3,596,400 | 3,200,000 | 396,480 | 99,120 | 0 (19,500 moved to QT-1407) | 7,458,660 |
| 2 | RF-KD-26-9737 ★ | Aminu Ibrahim · QT-KD-26-1751 | 5 | 1 3 4 8 + double credit | 942,690 | 899,000 | 899,000 | 899,000 | 34,952 | 8,738 (×2 on ledger) | 0 | 3,654,630 |
| 3 | RF-KD-26-9581 | Aminu Ibrahim · QT-KD-26-1451 | 5 | 1 2 3 7 8 | 654,310 | 643,648 | 643,648 | 597,000 | 45,848 | 11,462 | 0 (296,295 moved to QT-1452) | 3,459,250 |
| 4 | RF-KD-26-9781 ★ | Nasiru Salisu · QT-KD-26-1781 | 5 | 1 2 3 4 7 | 257,070 | 228,490 | 228,490 | 100,000 | 128,546 | 28,524 | 0 | 1,256,550 |
| 5 | RF-KD-26-9684 | Adamuaibrahim · QT-KD-26-1531 | 5 | 1 2 3 4 7 | 98,700 | 93,557 | 93,557 | 73,004 | 20,557 | 5,139 | 0 | 2,158,350 |
| 6 | RF-KD-26-9580 | Ayuba Abubakar · QT-KD-26-1436 | 4½ | 1 2 3 4 + hold | 180,930 | 167,744 | 167,744 | 115,000 | 52,744 | 13,186 | 0 (17,500 reversed) | 1,425,900 |
| 7 | RF-KD-26-9752 ★ | Ibrahim Zaria · QT-KD-26-1750 | 4 | 1 2 4 8 | 483,050 | 426,840 | 426,840 | 342,000 | 118,790 | 22,260 | 0 | 1,200,000 |
| 8 | RF-KD-26-9726 ★ | Aminu Ibrahim · QT-KD-26-1739 | 3 | 1 2 3 | 942,690 | 933,952 | 933,952 | 899,000 | 34,952 | 8,738 | 0 (930,872 leftover clear) | 3,654,630 |
| 9 | RF-KD-26-9796 ★ | Adam Suleiman · QT-KD-26-1818 | 2 | 1 4 | 303,120 | 0 | 0 | 251,000 | 41,696 | 10,424 | 0 | 1,714,000 |
| 10 | RF-KD-26-9790 ★ | abbas gabdo · QT-KD-26-1777 | 1 | 3 | 140,000 | 140,000 | 140,000 | 140,000 | 0 | 0 | 0 (29,200 moved to QT-1782) | 12,000,000 |

★ must-include. Criteria: 1 mixed customer/staff · 2 several parts or accounts · 3 credit · 4 changed/reversed ·
5 receipts (none of the 854 hit it: every quotation here has one cleared receipt whose confirmed amount equals the
entered amount) · 6 near the cap (only RF-KD-26-9655, not in the ten) · 7 approver = payee or non-profile account ·
8 payout ≠ approved net.

## Expected result per branch, and current vs expected

Branches: **CA** hotfix/refund-uses-confirmed-amount · **GL** hotfix/refund-payout-gl-key · **MX**
fix/refund-cap-and-mixed-overpay · **FG** feat/finance-guardrails (A1 payout account guard, A7 remainders ≤ ₦200
auto-close and staff shares < ₦5,000 to the weekly batch, A6 refund credit instead of a cash receipt) · **AT**
feat/attention-explain. "RA" = feat/refund-audit (this branch), not one of the five.

### 1 · RF-KD-26-9579 Yahuza — overpayment 3,458,760 + unproduced 236,840; staff share to the approver
- CA: cash in 7,458,660 (one cleared receipt, confirmed = entered) → overpayment excess 3,478,260; unchanged.
- GL: two payout journals, keyed `RF-KD-26-9579:paid:TM-KD-26-2442` (3,200,000) and `…:TM-KD-26-2443` (396,400) — present.
- MX: refundable after this refund and the 19,500 credit to QT-1407 = 7,458,660 − 3,695,600 − 19,500 = **3,743,560**; overpayment consumed by the payout = 3,458,760, so QT-1384 offers no further overpayment credit.
- FG: the ₦80 remainder (staff net 396,480 vs 396,400 paid) auto-closes as rounding (it was closed by hand on 3 Oct). Both payees have a bank and a 10-digit account → payout allowed.
- AT: `same_approver_payer` (Abdulrahman approved and paid) and the staff payee is the approver — shown only when dual control is enforced.
- Current vs expected: none on the money. Stored `paid_amount_ngn` 3,695,520 = treasury 3,596,400 + cut 99,120 (the cut counted as paid: definition question B).

### 2 · RF-KD-26-9737 Aminu — second overpayment refund on the same customer, staff share held then released
- CA: cash in 3,654,630; excess 939,610 = the Overpayment line; unchanged.
- GL: expected one journal `RF-KD-26-9737:paid:TM-KD-26-3167` for 899,000 — **missing** (the line was posted by the restore script). Diff ₦899,000 of Dr 2500 / Cr 1000 not on the GL.
- MX: refundable after this refund = 3,654,630 − 942,690 = 2,711,940; overpayment consumed = min(939,610, 899,000) = 899,000; the "leftover clear" RCA row (939,610) keeps QT-1751 off the credit list.
- FG: A1 **blocks** the staff payout: payee NAZIRU ADAMU has no account number on the row (blank) — the customer share went out by a nominee the OM recorded in the note; the remaining staff share 34,952 to Bakari (HR bank, 10 digits) is allowed; under ₦5,000? no (34,952) → paid singly.
- AT: `refund_unpaid` — approved 10 days ago, 34,952 still to pay; `customer_open_refund` for Aminu Ibrahim.
- Current vs expected: retention ledger holds **two** ₦8,738 credits for this refund (RCR-KD-26-0117 under source RF-9726, RCR-KD-26-0126) and RCW-KD-26-0002 withdrew both → ₦8,738 too much retained (RA dedupes future credits; the rows are a data correction). GL diff ₦899,000. Remaining to pay 34,952 (status Partially paid is right).

### 3 · RF-KD-26-9581 Aminu — overpayment paid in three parts, admin override of the uncleared hold
- CA: cash in 3,459,250 → excess 950,605 (quote 2,508,645); credit out 296,295 to QT-1452.
- GL: three journals (597,800 / 32,688 / 13,160) — present.
- MX: refundable after this refund = 3,459,250 − 654,310 − 296,295 = **2,508,645**; consumed 643,648.
- FG: A1 allows (both accounts 10 digits). A7: nothing left to close.
- AT: nothing pending (Paid).
- Current vs expected: net due = 654,310 − 11,462 = **642,848**, treasury paid **643,648**: **₦800 paid above the approved net** (customer share 597,000 vs 597,800 paid on TM-KD-26-2455). None of the five branches recomputes a Paid refund; `assertRefundMoneyOutWithinApproved` (already on main) would refuse this today. Data correction or write-off for you.

### 4 · RF-KD-26-9781 Nasiru — overpayment 169,500 + substitution 87,570; three payees, three parts
- CA: cash in 1,256,550 (confirmed = entered); excess 169,500 = the Overpayment line exactly.
- GL: three journals (100,000 / 112,000 / 16,490) — present.
- MX: refundable after this refund = 1,256,550 − 257,070 = 999,480; consumed overpayment = min(169,500, 228,490) = 169,500 → no credit left.
- FG: A1 — the driver line is paid to AS-002 "Kankiya" whose profile has the **account number in the name field and "Ibrahim Shtu" in the account field**; A1 refuses an account with letters, so this payout would have been blocked (RA swaps the two fields on read and passes it). A7: the ₦56 remainder auto-closes (done by hand 17 Oct).
- AT: approver (Abdulrahman) is the staff payee (HR bank line 140,070 → 112,056); `same_approver_payer` is not raised (paid by Mansur).
- Current vs expected: none on the money; retention 28,524 still open (not yet withdrawn).

### 5 · RF-KD-26-9684 Adamuaibrahim — overpayment 96,975 + unproduced 1,725; customer has no profile bank
- CA: 2,158,350; excess 96,975.
- GL: two journals — present.
- MX: refundable after = 2,059,650; consumed 93,557.
- FG: A1 — customer profile has no account; the refund row carries umar muhammed · opay ******8526 (typed on the form, which also wrote it onto the profile? no: profile still null) — pay allowed on the row's account. A7: ₦4 remainder auto-closes.
- AT: nothing (Paid).
- Current vs expected: treasury lines named "Adamuaibrahim" though paid to umar muhammed (73,000) and Bakari (20,557) — RA names the payee on new lines; old lines are data.

### 6 · RF-KD-26-9580 Ayuba — overpayment 165,930 + transport 15,000; reversed, re-posted, on hold
- CA: 1,425,900; excess 165,930.
- GL: expected two journals; **only TM-KD-26-2954 (52,744) has one**; TM-KD-26-3065 (115,000, re-posted after the 1 Oct reversal) has **no journal** — the gl-key branch gives re-posts a `#<correction>` key so they are not skipped as duplicates; this line predates it. Diff ₦115,000.
- MX: refundable after = 1,244,970; consumed 165,930 (the 17,500 credit to QT-1445 was reversed on 21 Sep).
- FG: A1 allows; nothing to close.
- AT: payout hold "Possible double payment: ₦115,000 to Saddam Adamu 5 Sep + ₦115,000 to Suleiman" — shown on the pay dialog; `same_approver_payer` (Abdulrahman both).
- Current vs expected: GL diff ₦115,000; otherwise paid = net due.

### 7 · RF-KD-26-9752 Ibrahim Zaria — three payees, two accounts, one line reversed 19 Oct
- CA: 1,200,000; excess 483,050 = the line.
- GL: journals for 84,840 / 33,950 / 342,000 and the reversal journal for 33,950 — present (reversal keyed `full:TM-KD-26-3399`).
- MX: refundable after = 716,950; consumed 426,840.
- FG: A1 **blocks** the driver line: AS-001's profile has "Ahmed Ibrahim" in the account field (RA reads it as 0636783237 and passes). The 33,950 is what is left to pay after the reversal ("not paid — no bank line on Taj, Moniepoint or Cash").
- AT: `refund_unpaid` 33,950; the reversal note explains why.
- Current vs expected: remaining to pay **33,950** (RA dialog: approved 483,050 − cut 22,260 − paid 426,840); stored status Partially paid is right. The 19 Oct reversal GL used the cash figure (33,950) — same as RA would.

### 8 · RF-KD-26-9726 Aminu — first of the two Aminu overpayment refunds
- CA: 3,654,630; excess 939,610.
- GL: two journals (899,000 / 34,952) — present.
- MX: refundable after = 2,711,940; consumed 933,952; the 930,872 "leftover clear" RCA keeps QT-1739 off the credit list.
- FG: allowed; nothing to close.
- AT: nothing.
- Current vs expected: the retention row RCR-KD-26-0117 carries this refund's id as `source_id` but RF-9737's as `refund_id` (see case 2).

### 9 · RF-KD-26-9796 Adam Suleiman — approval restored to ₦303,120 after the confirmed-amount fix
- CA: this is the branch's own case. Cash in with the confirmed field = **1,714,000** (bank lines 1,250,000 + 464,000); without it the engine double-counts the OVERPAY_ADVANCE row and reads 1,988,960. Overpayment = 1,714,000 − 1,439,040 = **274,960** = the line. Refundable after this refund = 1,410,880.
- GL: no payout yet, so no journal expected.
- MX: cap 1,410,880 after approval; commission 28,160 inside the floor-exempt set.
- FG: A1 allows (customer moniepoint ******0992; staff HR bank). A7: no remainder yet.
- AT: `refund_unpaid` — approved 19 Oct, 292,696 net to pay (251,000 + 41,696).
- Current vs expected: approved 303,120 = 274,960 + 28,160; retention 10,424 open; nothing paid. Matches.

### 10 · RF-KD-26-9790 Gabdo — nails shortfall after the text-sum fix, paid to a non-profile account
- CA: 12,000,000; excess 1,781,800; credit out 29,200.
- GL: one journal (140,000) — present.
- MX: refundable after RF-9776 (1,913,200), this refund (140,000) and the credit (29,200) = **9,917,600**; the text-sum bug would have made it 0.
- FG: A1 — paid to GABDO MUSA ADAMU First Bank ****6183, not the profile ****1830 (OM note); the guard checks shape, not profile match, so allowed.
- AT: nothing (Paid).
- Current vs expected: the treasury line names "abbas gabdo" while the money went to GABDO MUSA ADAMU — RA would book the payee. Preview on the restored copy (read-only): suggested 150,000; floor cap 237,500 (MD-approved ₦5,700 on 1,590.4 m + 0.24mm list ₦4,700 on 160.6 m → floor value 9,820,100; 12,000,000 − 9,820,100 − 1,942,400), so the shortfall passes; approved at 140,000 on 14 Oct.

## Does any case show a problem the current fixes do not cover?

Yes: RF-KD-26-9581 was paid ₦800 above its approved net (historic; no branch recomputes a Paid refund), the two
script-posted payout lines (RF-9737 ₦899,000, RF-9580 ₦115,000) have no GL journal, and the two drivers' profiles with
name/account swapped (AS-001, AS-002) are only handled on feat/refund-audit, not on the five branches.

## Selection SQL (rerunnable, read-only)

```sql
-- see exports/refund-pick-selection-2026-10-19.sql (same text)
```
