# Owner note — refund fixes and two PO haulage gaps (17 Oct 2026)

Found during the Moniepoint Oct 2026 reconciliation. Code only: no database writes, nothing deployed or pushed.
Branch `fix/refund-cap-and-mixed-overpay` in both repos (backend and frontend).

## Fix 1 — refund form wrongly says "fully covered by existing refund requests"

- **Where:** `server/controlOps.js` → `quotationActiveRefundedTotalNgn`.
- **Cause:** on MySQL, `SUM(amount_ngn)` comes back as text. The code added it to the unlinked-credit total with `+`, so
  "1913200" + 29200 became 191,320,029,200. The refund cap (cash in − refunded) went to zero and the form refused.
- **Live case:** QT-KD-26-1777 (Gabdo nails, accessory shortfall ₦140,000–150,000).
- **Fix:** both parts are turned into numbers before adding.
- **Sweep:** searched the whole server for the same pattern (SUM/COUNT results added with `+` without a number
  conversion). No other live case found; the others already convert.
- **Test:** `server/quotationActiveRefundedTotalMysqlString.test.js` feeds text SUMs like MySQL does.

## Fix 2 — a paid mixed refund kept its overpayment on offer as credit

- **Where:** `shared/lib/refundCreditApply.js` → `refundOverpayConsumedNgn` (mirrored in the frontend).
- **Cause:** only overpayment-only refunds counted as "used up". A mixed refund (Overpayment + Installation +
  Transport) that was paid in cash never reduced the overpayment pool, so the ERP offered the same money again.
- **Live case:** Mahadi Turunku QT-KD-26-1697 / RF-KD-26-9734 — overpayment ₦47,450 refunded in cash (₦72,000 paid of
  ₦74,450), yet credit `overpay:QT-KD-26-1697` ₦42,766 was still offered.
- **Rule used (your accounting rule):** in a mixed refund only the part above the overpayment reduces value, so the
  refund's **Overpayment line is the part used up**, capped by what was actually paid out.
  Paid mixed → Overpayment line used up. Partly paid → up to the amount paid. Pending, approved-not-paid, cancelled,
  rejected → nothing used up. Overpayment-only refunds work as before.
- **Tests:** `shared/lib/refundCreditApply.mixedOverpay.test.js` (same file in both repos).
- **After deploy:** QT-KD-26-1697 should stop offering the ₦42,766 credit. Nothing to correct in data.

## Gap A — no way to RAISE an agreed haulage fee on a received PO (recorded, not built)

- `agreePoHaulageFeeTx` (server/procurement/poHaulageLinkOps.js) only allows lowering the fee
  ("cannot be higher than the fee already on the PO"). `linkTransport` (server/writeOps.js) on a received PO only
  allows linking when there is no haulier or fee yet.
- **Live case:** PO-KD-26-0092 paid ₦140,000 against a ₦100,000 fee; the ERP has no path to record the ₦40,000 rise.
- **Suggested design:** a "revise haulage fee" action for received POs, by a finance/MD role, with a reason and an
  audit entry, that also updates the PO's landed cost. Needs your decision on who approves it.

## Gap B — PO transport payouts post no GL journal (recorded, not built)

- Supplier payments post a GL journal (`tryPostSupplierPaymentGlTx`); haulage paid through `linkTransport`
  (treasury type `TRANSPORT_PAYMENT`) posts only the treasury line — no journal.
- **Live cases:** PO-KD-26-0089, 0090, 0091, 0092 have no GL entry for their haulage.
- **Suggested design:** post Dr inventory / freight-in, Cr bank on each transport payout, plus a one-off backfill for
  past payouts (that is a data round — needs your go-ahead).

## Release checklist

- DB-backed refund tests need a real MySQL (this PC has none; they fail with "connection refused", not on the fix).
  Run `server/quotationRefundHeadroom.test.js`, `server/refundAccessoryShortfallApproveCap.test.js` and the other
  refund suites against MySQL before shipping.
