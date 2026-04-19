# Finance work item conventions

Use these values when registering finance exceptions in the **workspace registry** (`work_items`) so they appear in the unified inbox and notifications without duplicating Office threads.

## Source kind and document type

| Use case | `source_kind` | `source_id` | `document_type` | Default office |
|----------|---------------|-------------|-----------------|----------------|
| Bank lines in **Review** or **PendingManager** for a branch | `finance_bank_recon` | Branch id string (same as `branch_id`) | `bank_recon_exceptions` | `finance` |

## Rules

- **One upsert per branch** for bank recon exceptions: `source_id` must equal the branch id so `upsertWorkItemBySource` merges updates.
- **Deep link**: set `data.routePath` to `/accounts` and `data.routeState` to `{ accountsTab: 'receipts' }` so finance lands on **Receipts & recon**.
- When there are **no** pending lines, set `status` to `closed`, `requiresResponse` to `false`, and a neutral title so the item drops out of “needs action” views.
- Do **not** create parallel notification tables; optional discussion uses `POST /api/work-items/:workItemId/link-thread/:threadId` only.

## Code

- Constants: [`server/financeWorkItemConstants.js`](../server/financeWorkItemConstants.js)
- Sync helper: [`server/financeWorkItems.js`](../server/financeWorkItems.js)
