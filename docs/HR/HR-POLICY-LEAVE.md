# HR Policy: Leave and Entitlements

## Scope
- Leave requests, approvals, accruals, usage, and balances.

## Required Controls
- Leave requests must include leave type and date range.
- Approved leave must reconcile to monthly balance movements.
- Negative balances are blocked unless explicitly adjusted with approval.

## System Rules
- Request detail stored in `hr_request_leave`.
- Balance ledger maintained in `hr_leave_balances` and `hr_leave_accrual_ledger`.
- Recompute utilities must write an HR audit event.
