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
   - Read **Attention** notes and **Logic & integrity warnings** in the refund modal; bundled transport/installation often needs a **manual split** of amounts.
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
| **Cancelled job + overpayment** | Preview uses **Order cancellation only** for full refundable cash (overpay is context, not a second line). Quick overpay disabled. Lab: `npm run preview:refund-lab`. |
| **Overpayment + Order cancellation (same request)** | Submit blocked — cannot stack both categories on the same cash. |
| **Partner wallet split payout** | No customer bank → split to staff wallets; finance releases via **Partner withdrawals** desk (requires `ZAREWA_PARTNER_WALLET_V1=1`). |
| Duplicate category | Second refund **same category** on same quote rejected; different category allowed. |
| Lifecycle | Pending → approved → finance payout; payout cannot exceed approved balance; staged payouts OK. |

**Automated coverage:** `server/refundSecurity.test.js`, `server/refundCancelledOverpayPreview.test.js`, `server/refundPartnerWalletSplit.test.js`, `server/api.test.js` (refund sections), `e2e/sales-refund-finance-checklist.spec.js`, `e2e/refund-risk-api.spec.js`.

**Pre-deploy gate (backend):** `npm run test:refund-live` then `npm run preview:refund-lab`. **Frontend modal:** `npx vitest run src/components/sales/RefundModal.test.jsx` in the frontend repo.

**Historical overlap audit:** place `zarewa-entered-data (1).xlsx` in the backend root, then `npm run report:refund-overlap-review` — review paid rows in `refund-overlap-review.json` (no auto-reversal).

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

## 5. Go-live smoke (production, ~10 minutes)

1. **Sales** — open refund on a **cancelled job with overpay** (demo `QT-KD-26-0029` if seeded): expect **Full refund**, **Order cancellation ≈ full cash**, overpay shown as reference only.
2. **Sales** — plain overpayment quote: **Quick overpay** available when preview is overpayment-only.
3. **Finance** — **Partner withdrawals** panel shows open balances after an approved split refund; release one partial withdrawal and confirm treasury movement.
4. **Manager** — attempt to approve a refund with both Overpayment and Order cancellation on one request — must be blocked in UI and API.

Set in production env (see `.env.example`):

- `ZAREWA_ASSOCIATED_STAFF_POLICY_V1=1`
- `ZAREWA_PARTNER_WALLET_V1=1`
- `ENFORCE_DUAL_CONTROL_PAYMENTS=1` — off by default everywhere; set this only once refund approve and pay roles are staffed by different people (otherwise the approver can't pay their own approved refunds)

---

## 6. Keyboard and accessibility

Refund modals use **Radix Dialog**: **Escape** closes the dialog; focus is trapped while open. There are no custom global hotkeys inside the refund form.
