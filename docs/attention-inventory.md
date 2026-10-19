# "Needs attention" inventory (feat/attention-explain, 2026-10-19)

Every place the app flags something for a person, the rule that raises it, what the row said before this branch,
where a click went, and what it says / where it goes now. Sentences, evidence, clearing actions and deep links come
from one definition: `shared/lib/attentionRules.js` (mirrored to the frontend `src/shared/lib/attentionRules.js`).
Which records get flagged did **not** change; only the words and the click target did.

Old view stays reachable with `?legacy=1` on `/exec` and `/manager`.

## A. MD / BM attention inbox — `server/mdAttentionOps.js` `listMdAttentionInbox`

Shown in: MD Today "Needs your attention", MD Approvals (Decide) tab, CEO / exec queue table (`/exec`), BM command
inbox Attention tab, notification bell (top 3 rows), MD daily/weekly report packs. The server now attaches
`item.attention` (sentence, all flags, evidence, actions, links) to every item.

Old click: MD → in-page exec review modal (reasons only as a small bullet list); bell → `/manager?...` for everyone
(MD/CEO cannot open `/manager`). New click: MD/CEO → `/exec?tab=decide&attention=<id>` opens the record with the
banner; BM → `/manager?...&attention=<id>`.

| # | Flag (kind) | Rule that raises it | Row text before | Rule id(s) now | Sentence now (example) |
|---|---|---|---|---|---|
| 1 | Paid quote not cleared (`clearance`) | quotation `paid_ngn > 0`, not manager-cleared, not flagged | `CLEARANCE · QT-… · branch · ₦total · 11d` | `quote_overpaid`, `quote_not_cleared`, `quote_below_production_gate`, `quote_high_value` | "Paid ₦140,000 against a ₦100,000 quote — ₦40,000 above" |
| 2 | Below-floor price (`price_exception`) | below-floor flag set, paid > 0, no BM/MD approval | `Below-floor quote QT-…` | `quote_below_floor` | "QT-…: Longspan 0.45mm quoted ₦4,200/m vs floor ₦4,500/m (₦300/m below) …; ₦300,000 already paid — needs BM or MD approval — 3 days" |
| 3 | Flagged for audit (`flagged`) | `manager_flagged_at_iso` set | `QT-… · <flag reason>` | `quote_flagged` | "QT-… flagged for audit on 16 Oct: “…” — 3 days" |
| 4 | Production held (`production`) | cutting list Draft, quote < 70% paid, no override | `Production blocked — 45% paid on quote` (modal only) | `production_held_unpaid` | "Cutting list CL-… for QT-… is held: 45% paid (₦450,000 of ₦1,000,000) — ₦250,000 more needed for 70%" |
| 5 | Conversion check (`conversions`) | completed job, conversion HIGH/LOW or review flag, not signed | `CONVERSION CHECK · PRO-…` | `conversion_unsigned` | "Job PRO-… (QT-…) made 120 m from 450 kg (3.75 kg/m) — conversion HIGH, not signed off — 4 days" |
| 6 | Refund approval (`refunds`) | refund `Pending` | `REFUND · RF-… · ₦amount` | `refund_pending`, `refund_above_limit`, `refund_md_discount` | "Refund ₦1,408,453 to … (Unproduced meterage) requested 16 Oct is waiting for approval — 3 days" |
| 7 | Register withdrawal (`register_settlement`) | settlement `Pending` | `WITHDRAWAL · SET-…` | `register_withdrawal_pending`, `register_withdrawal_above_limit` | "Register withdrawal ₦120,000 to … requested 18 Oct is waiting for approval — 1 day" |
| 8 | Payment request (`payments`) | payment request open for approval | `EXPENSE REQUEST · PR-…` | `payment_request_pending`, `payment_request_above_limit` | "Payment request ₦750,000 for “Transformer repair” (Maintenance) requested 17 Oct is waiting for approval — 2 days" |
| 9 | Overtime (`overtime`) | OT pending BM | `OVERTIME · OT-…` | `overtime_pending` | "Overtime ₦15,000 for 17 Oct (production, QT-…) by Store is waiting for approval — 1 day" |
| 10 | Material exception (`material`) | incident `submitted` | `MATERIAL EXCEPTION · MI-…` | `material_incident_pending` | "Damaged coil of 12.5 m 0.45mm Bush Green reported 17 Oct is waiting for approval — 2 days" |
| 11 | Edit second approval (`edit_approvals`) | edit approval pending | `purchase_order PO-…` | `edit_second_approval` | "Musa changed purchase order PO-0070 (unit price …) — it saves only after a second approval" |
| 12 | Staff purchase credit (`staff_purchase_credit`) | `pending_approval` | `QT-… · staff · Materials on credit` | `staff_credit_pending` | "Staff purchase credit ₦240,000 for … on QT-… (₦20,000/month from payroll) needs MD approval" |
| 13 | Approver = payer / requester = approver (`governance`) | approved/paid refund where same user id did both (only when `enforceDualControlPayments` is on) | `GOVERNANCE · RF-…` (no reason on the row) | `same_approver_payer`, `same_requester_approver` | "Refund RF-… ₦52,000 was approved and paid by the same person (Abdulrahman)" |
| 14 | Payment-gate breach (`governance`) | completed job, quote < 70% paid, no override | `GOVERNANCE · QT-…` | `production_gate_breach` | "Job PRO-… completed 12 Oct with only 40% paid (₦240,000 of ₦600,000) and no manager override — ₦360,000 outstanding" |
| 15 | No Branch Manager (`governance`) | active branch without BM | `No Branch Manager — Yola` | `branch_missing_manager` | "Yola has no Branch Manager — complaints, overtime and other branch approvals have no owner" (click → Team & access) |

## B. Exec work-tray extras — `server/execDashboardOps.js`

| # | Flag | Rule | Row before | Rule id now |
|---|---|---|---|---|
| 16 | Payroll awaiting MD | payroll run `draft`, no MD approval | `PAYROLL · Payroll 2026-09` | `payroll_md_signoff` — "Payroll 2026-09 is a draft waiting for MD sign-off before it can be locked — 14 days" |
| 17 | Inter-branch loan | loan `pending_md` | `Inter-branch loan L-…` | `inter_branch_loan_pending` — "Loan ₦5,000,000 from Kaduna (HQ) to Yola is waiting for MD approval — 1 day" |
| 18 | Office memo | open executive memo thread | memo subject | `office_memo_open` |
| 19 | Unified work item | executive/finance office or ≥ ₦200k pending | item title | mapped to the kinds above, else `work_item_pending` |

## C. Notification bell / badges — `src/lib/attentionRowNotifications.js`, `workspaceNotifications.js`

| # | Where | Before | Now |
|---|---|---|---|
| 20 | Bell rows (top 3 attention items) | title `Refund approval: RF-…`, detail = subtitle, link `/manager…` for every role | detail = the shared sentence; MD/CEO/Chairman link `/exec?tab=decide&attention=<id>`, BM link `/manager…&attention=<id>` |
| 21 | MD list header / group headers | none (flat list, top 7) | count + ₦ total per group from `summarizeAttention` (same function as the rows) |
| — | "Decide (N)" tab badge, mobile "N items need your sign-off" strip | count of approval tier "MD only" | **unchanged** — counts an approval tier, not a rule; it is not a problem statement |

## D. Cashier desk — `src/components/finance/FinanceDeskWorkQueues.jsx`

| # | Panel | Rule | Row before | Now |
|---|---|---|---|---|
| 22 | Awaiting credit check | receipt pending clearance, status "No bank receipt" | meta = status text `No bank receipt` | `receipt_no_bank_line` — "Receipt ₦57,750 from … has no matching bank line after 11 days"; deep link `/cashier?receipt=…&attention=receipt_no_bank_line:…` highlights the row and shows the banner |
| 23 | Under investigation | receipt suspended / has investigation case | meta = case id or `Suspended` | `receipt_under_investigation` — "Receipt ₦31,030 from … is under investigation (case INV-7) — it cannot be confirmed until the case is cleared — 4 days" |
| 24 | Hanging-refund chip on receipts to confirm | same customer has Pending / approved-unpaid refund, or unused overpay credit | chip `HANGING REFUND ₦15,350` | `customer_open_refund` / `overpay_credit_unused` — "Tahir … has refund RF-… ₦15,350 approved 16 Oct and unpaid — check this receipt is not the same money" |
| 25 | Receipts clearance table hanging icon | same as 24 | `⚠ ₦15,350` (tooltip "Hanging refund") | `Open refund ₦15,350`, tooltip = the sentence |

## E. Reports — Payment exception queue (`src/lib/liveAnalytics.js` `paymentReconciliationExceptionQueue`)

| # | Bucket | Rule | Row before | Now |
|---|---|---|---|---|
| 26 | Quotation AR | quote `paidNgn` ≠ receipts + applied credit | "Quotation paid amount differs from receipts + applied advance" | `quotation_paid_mismatch` — "QT-… shows ₦150,000 paid but receipts + applied credit come to ₦100,000 — ₦50,000 more on the quote" |
| 27 | Receipt/treasury | receipt vs treasury line mismatch | issue text | `receipt_treasury_mismatch` — "<ref> (<customer>): <issue> — ₦D difference" |

## F. Found, not converted on this branch (and why)

| Where | What | Why not |
|---|---|---|
| Refund / receipt modals — `shared/lib/customerPaymentIntegrity.js` | over-quote receipts, duplicate quotation (same customer/total/date window), settled-quote overpay | already full sentences with the numbers and related quote id |
| Operations → Inventory attention panel | stuck planned/running jobs, coil spec mismatch, WIP, partial POs, loads in transit | operations/storekeeper hygiene counts, not a person-to-clear queue; next pass |
| Finance trial exceptions panel | counts by role | counts only |
| BM health strip / aged counts | aged attention counts | counts only (now consistent with the same items) |
| Pending approvals ops report — approved-unpaid refunds | "hanging" approved refunds list | rule `refund_unpaid` is defined and tested; that report table is not wired yet |
| Printed reports (bank recon, refund report, receipts register, accrual statement) | line class `exception` / `review` | printed report classifications with their own note column, not attention queues |
| HR (discipline "under investigation", my-HR next step) | HR workflow states | out of scope |
| "Stale statement" | — | no such flag exists in the app today (the bank recon print shows a statement gap only) |

## Behaviour notes

- Clicking a banner action (Approve / Reject / Clear / Flag / Sign off / Allow production) scrolls to and focuses the
  record's own decision control; that control keeps its amount, note and acknowledgement steps, so nothing is approved
  on one tap from the banner. "Assign Branch Manager" goes to Team & access.
- The opened record highlights the offending field (`data-attention-field`: amount, paid, conversion).
- A record with several flags (e.g. refund pending **and** approver = payer) lists all of them in one banner.
- Approver = payer / requester = approver warnings have **no clearing action in the ERP**: they stay on the list for
  as long as the refund exists. Needs an owner decision (acknowledge step → Phase 3 controls).
- The quotation clearance panel shows `% paid` capped at 100% (₦140,000 of ₦100,000 shows "100%"), which hides
  overpayment; the banner now states it. Fixing the panel's percentage is a separate small change.
