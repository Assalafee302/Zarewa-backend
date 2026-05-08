# SOP: Customer Payment Posting and Correction

## Scope

Applies to Sales receipt posting, customer ledger allocation, and treasury/finance reconciliation.

## Roles

- Sales Officer: posts receipts and provides transaction evidence.
- Finance Officer: validates treasury movement and reconciliation.
- Sales/Branch Manager: approves risky overrides and corrections.

## Standard posting flow

1. Select quotation.
2. Review blue history (already posted, read-only).
3. Enter only new money in editable lines.
4. Add strong reference text (transfer/POS/deposit detail).
5. Post receipt.
6. Confirm receipt id and treasury movement alignment.

## Correction flow

1. Detect issue from Reports exception queue.
2. Capture supporting evidence.
3. Reverse wrong entry.
4. Re-post correct amount.
5. Close queue item with note and owner initials.

## Controls

- Duplicate-like posts should be blocked unless explicit override reason is captured.
- Idempotency keys are mandatory on API posting calls to avoid retry duplicates.
- Do not backdate into locked accounting periods.
- Do not manually edit paid totals to hide posting mistakes.

## KPI targets

- Open payment exceptions: 0 by week end.
- Aged exceptions > 7 days: 0.
- Duplicate override rate: monitored and minimized.
- Reversal-to-post ratio: tracked for training and process quality.
