# Payment Posting Runbook (Sales + Finance)

This runbook is for correcting wrong or duplicate customer receipt postings while protecting audit trail and finance balances.

## 1) When to use this runbook

Use this flow when any of these happen:

- Same payment was posted twice.
- Receipt amount does not match treasury movement total.
- Quotation paid amount does not match receipts plus applied advance.
- A user re-entered history money as new money.

## 2) Detection queue

Daily (or at minimum weekly), open Reports and review:

- Receipt/Treasury exception rows.
- Quotation paid discrepancy rows.

Prioritize by:

1. Highest absolute delta.
2. Oldest unresolved row.
3. High-value customers or high-risk quotations.

## 3) Correction workflow (required order)

1. Identify the bad posting id (receipt id / ledger entry id / quotation id).
2. Confirm the real-world bank/cash evidence for what actually came in.
3. Reverse the mistaken posting (do not silently overwrite history).
4. Verify treasury net is corrected for that source id.
5. Re-post only the true amount for new money received.
6. Confirm quotation paid and balance due match expected values.
7. Add a closure note in the reconciliation queue.

## 4) Approval controls

- Sales can identify and propose correction.
- Finance validates evidence and confirms treasury impact.
- Manager role approves high-risk reversals where policy requires.

## 5) Posting discipline (operator checklist)

Before clicking Post:

- Blue history section is read-only; never re-enter those amounts.
- Gray rows must contain only new cash/bank inflow received now.
- Confirm voucher total equals today's real inflow.
- Ensure reference/remarks is specific (transfer ref/POS/deposit evidence).

## 6) Duplicate override policy

If duplicate safeguards block a post:

- Do not bypass by default.
- Only force post when you have a valid business reason.
- Enter a clear override reason; this is retained in audit metadata.

## 7) Cadence and ownership

- Daily: Sales + Finance clear new exceptions.
- Weekly: Finance lead reviews unresolved/aged exceptions.
- Month-end: unresolved queue must be zero or have approved carry-forward notes.
