# Customer refunds — operations, UAT, and governance

Refunds move money out of the business. Treat **server-suggested lines as starting points only**; approvers must confirm amounts against evidence and policy.

Role separation is documented in [ACCESS_CONTROL.md](./ACCESS_CONTROL.md) (**request** → **approve** → **pay**).

**Who may approve:** branch manager (`refunds.approve`), Managing Director (`refunds.approve`), administrator (`*`), or finance roles that hold `finance.approve` (the decision endpoint accepts either permission). **Only finance** (treasury / `finance.pay`) should post the payout.

---

## 1. Approver checklist (before Save Decision)

Use this every time, even when the UI looks “obvious.”

1. **Quotation and money**
   - Quote total matches the commercial agreement (and line items where relevant).
   - **Paid on quotation** plus any **customer advance (overage)** matches receipts and ledger; use **Sync paid from receipts** if the quote list looks wrong.
2. **Operational facts**
   - **Produced metres** and **delivery / cutting lists** match the customer’s story (cancellation after delivery is blocked by design).
   - **Accessories**: ordered vs supplied matches any accessory shortfall claim.
3. **System flags**
   - Read **System audit flags** and **Logic & integrity warnings** in the refund modal; bundled transport/installation often needs a **manual split** of amounts.
   - **Substitution** credits need correct FG product, gauge/colour, and price list; missing data triggers warnings—do not approve blind.
4. **Arithmetic**
   - **Calculated total** (line items) should align with **requested** / **approved** amount; use **Apply total** then adjust if policy allows.
5. **Evidence**
   - Notes, photos, signed acknowledgements, or internal memos are on file per your branch rules (see governance below).

---

## 2. Risk-focused UAT scenarios

Run these in a **non-production** database before go-live or after major changes.

| Scenario | What to verify |
|----------|----------------|
| Overpayment | Preview suggests excess of cash-in over quote total; amount matches receipts + advance. |
| Unproduced metres | Preview uses quoted vs completed production; price/meter is reasonable (watch 5% variance warning). |
| Substitution | Breakdown shows per-job delta; list price resolves or override is intentional. |
| Transport / installation | Single bundled line: warning appears; partial refund amounts are manually adjusted. |
| Calculation error | Header total vs line sum mismatch surfaced when applicable. |
| Order cancellation after delivery | Category blocked; create request returns error. |
| Duplicate category | Second refund **same category** on same quote rejected; different category allowed. |
| Lifecycle | Pending → approved → finance payout; payout cannot exceed approved balance; staged payouts OK. |

**Automated coverage:** `server/refundSecurity.test.js`, `server/api.test.js` (refund sections), `e2e/sales-refund-finance-checklist.spec.js`, `e2e/refund-risk-api.spec.js`.

---

## 3. Reconciliation (sample cadence)

Pick a **week** and spot-check:

1. **Approved / paid refunds** vs treasury movements (`REFUND` / `REFUND_PAYOUT` sources) and bank/cash records.
2. **Customer ledger** for the same customers: no unexplained double payouts.
3. **Audit log** entries for `refund.create`, `refund.review`, `refund.pay` for the sample.

Escalate any mismatch before closing the period.

---

## 4. Governance (default baseline — tighten locally)

| Topic | Baseline (adjust per branch) |
|-------|------------------------------|
| Evidence required | Reason notes in the refund modal are mandatory; attach or file photos, signed customer notes, or delivery/POD references for **Order cancellation**, **Transport/installation**, and **Substitution** cases. |
| Who approves | **Branch manager** or **MD** for commercial sign-off; **admin** for break-glass; **finance** may also record approval where `finance.approve` is granted. Escalate to MD when amount exceeds your local cap (suggested: **₦500,000** single approval unless MD already acting). |
| Second pair of eyes | **Finance** pays out only after approval; monthly sample: reconcile **all** refunds above **₦1,000,000** to bank/treasury. |
| Currency / rounding | **NGN**, whole naira in UI; rounding follows system `roundMoney` rules. |

Document named signatories in [STAFF_APPROVALS.md](./STAFF_APPROVALS.md) if you need legal-style accountability.

---

## 5. Keyboard and accessibility

Refund modals use **Radix Dialog**: **Escape** closes the dialog; focus is trapped while open. There are no custom global hotkeys inside the refund form.
