# Refund module — UI/UX review (Part 3, feat/refund-audit, 2026-10-19)

For each screen: what the person must decide, what the screen showed, what it shows now. Screenshots are on the
report page (dev gallery `/preview/refunds`, fixture data from the restored copy; excluded from the production build).

## 1. Refund form (Sales) — decide: *how much can I ask for, and who gets what?*

| Needs to decide | Showed before | Shows now |
|---|---|---|
| Is the amount inside what this quotation can still return? | "Remaining: ₦150,000" under the requested amount — actually the sum of the preview lines, not the balance; the real cap only appeared inside a refusal | **Refundable on this quotation ₦10,057,600** with "How": cash received ₦12,000,000 − refunds on file ₦1,913,200 − credit moved ₦29,200; "System suggests ₦150,000" kept as its own line; "₦9,907,600 left after this request" / "above the balance by ₦X" in red |
| Why was it refused? | "Refundable balance on this quotation is fully covered by existing refund requests." / "exceeds cash received … (max ₦X)" | "Refund ₦160,000 is above the refundable balance ₦157,600 by ₦2,400 (cash received ₦2,100,000 − existing refunds ₦1,913,200 − credit applied to other quotations ₦29,200 = refundable ₦157,600)." — same sentence on create, approve and the shared line check |
| Who gets what when the payout is split? | Footer "Refund ₦ \| Payout ₦ \| Balanced"; the cut only inside the dark split card | Footer live strip: Refund · Customer ₦730,000 · Staff ₦138,352 · Cut −₦34,588 · Net to pay ₦868,352 · Refundable left ₦0 — updates as the rows are typed |
| Which bank is paid? | Saved profile bank; AS-001 printed "0636783237 / Ahmed Ibrahim" (swapped) | Swapped name/account read the right way round and flagged `payeeFieldsSwappedOnProfile` (the profile row itself is a data correction) |

Still open (not changed): the 20 % cut on a single-payee refund whose bank is an HR account only appears at approval
(the form has no split row to preview); the quotation picker's "₦X refundable" and the form's balance are now the same
figure but computed in two places (`getEligibleRefundQuotations` and `quotationMeetsRefundEligibility`).

## 2. BM / MD approval — decide: *approve, lower, or reject?*

| Needs to decide | Showed before | Shows now |
|---|---|---|
| Is the approved amount inside the balance? | Refusal "Approved amount exceeds quotation refundable headroom (max ₦X for this request given other open refunds)"; credit moved to another quotation was not counted, and the check ran after the production/floor checks | Balance rule runs first and gives the full sentence with the three parts; credit out is counted like at create |
| What is the cut and net per payee? | Split rows with "20% company cut −₦" per row | unchanged (already clear) |

## 3. Cashier pay dialog — decide: *how much do I pay now, to whom, from which account?*

| Needs to decide | Showed before | Shows now |
|---|---|---|
| How much is left? | "Payee Cash Due ₦138,352" (sum of the lines typed) and "of ₦net"; the arithmetic lived in the Breakdown tab | **Remaining to pay ₦138,352** with "How": Approved ₦902,940 − company cut ₦34,588 − paid so far ₦730,000 (− credit applied, − closed as rounding when present) = remaining; "₦X ready now · ₦Y held" when part is blocked |
| Who is on the treasury line? | Always the quotation customer (staff share booked under the customer's name) | The payee picked in the dialog; with one payee left, that payee; cash book remark "paid to <name>" |

## 4. Refund voucher — decide (MD/auditor): *does the paper match the money?*

| Needs | Before | Now |
|---|---|---|
| Payouts made | One "Paid · by · at · ₦total" line | One line per payout: "Payout part 1 of 2 · date · account · reference · ₦" |
| Balance | "Till due now" only | "Balance left to pay" from the settlement summary, "Closed as rounding −₦" when a remainder was closed |
| Approvals, split, cut, net per payee, payee bank | already printed | unchanged |

## 5. Cash book line — decide (accounts): *which outflow is this?*

Description keeps the owner's 17 Oct layout ("<customer> refund (QT-####) – part n of m"); the remark now carries
"paid to <payee>" when the line was paid to someone other than the customer and that person is not a staff account
already shown as "via <staff> account".

## 6. Attention — unchanged here

The refund flags (pending approval, above threshold, MD discount, approver = payer, approved-not-paid) are on
`feat/attention-explain`; nothing in this branch changes which refunds are flagged.
