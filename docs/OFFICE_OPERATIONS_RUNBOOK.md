# Office operations runbook (roles)

This complements the in-app workspace and Settings. It reflects the approval and filing behaviour implemented for multi-branch office control.

## Branch manager (`sales_manager`)

- Approves **payment requests** up to the **expense threshold** (default ₦200,000) when you have `finance.approve`.
- Above that amount, **MD/CEO** (or admin) must approve.
- Use **Workspace → Unfiled** to clear items missing a **filing reference** after completion.
- **Inter-branch requests**: create via `POST /api/office/inter-branch-requests` (UI can be wired later); only branch managers create them.

## Finance manager (`finance_manager`)

- **Pays** approved payment requests (`finance.pay`).
- **Does not** final-approve routine branch expenses under the threshold unless you are also an executive or branch manager role (segregation).
- Refunds: follow existing `refunds.approve` / `finance.approve` gates; amounts **above** the refund threshold (default ₦1,000,000) need executive sign-off.

## Managing Director (`md`)

- Approves high-value payment requests and large refunds per thresholds.
- **Reports**: `GET /api/reports/md-operations-pack?month=YYYY-MM` (requires `hq.view_all_branches`, `*`, or `md` role) for exception-oriented monthly counts.
- **Governance**: thresholds are editable under **Settings → Governance → Office approval thresholds** (`settings.view`).

## Cashier

- **No disbursement** without an **Approved** payment request (unchanged server rule). Petty cash must still go through the request workflow.

## Administrator

- Maintains org-wide limits and full audit export from Settings where permitted.

## Filing references

- On **Approve** for payment and refund work items, the API issues a **`ZR/{branch}/{domain}/{year}/{seq}`** reference into `work_item_filing` when a persisted work item exists.

## Backdating

- Approval dates **before today** return **warnings** in the API response; they do not block unless period lock rules apply.
