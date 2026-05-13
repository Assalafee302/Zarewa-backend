# Role-based UAT — Tracks A–G (staging)

Use a **staging** database cloned from production (anonymised if required). Sign in as each role and complete the rows.

| Role | Login (staging) | Accounts — treasury | Receipts & daily recon | Payments | Audit / GL journal | Reports — GL pilot | Dashboard checklist | Customer — collections queue | Settings — integration keys |
|------|-----------------|---------------------|-------------------------|-----------|--------------------|--------------------|----------------------|------------------------------|----------------------------|
| `admin` | (staging admin) | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ |
| `finance_manager` | finance.manager | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ (if `settings.view`) |
| `sales_manager` | (pilot user) | ☐ view-only / N/A | ☐ | ☐ | ☐ | ☐ reports access per matrix | ☐ | ☐ | ☐ |
| `cashier` | (pilot user) | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ |
| `viewer` | (pilot user) | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ |

## Integration API (Track G)

1. As admin (or any user with `settings.view`), **Governance** → create integration key; copy bearer token.
2. `curl -H "Authorization: Bearer <token>" "http://<host>/api/integration/v1/trial-balance?startDate=2026-01-01&endDate=2026-01-31"` → `200`, `ok: true`.
3. Confirm **Audit log** contains `integration_api.read` entries without token material.
4. Revoke key; repeat call → `401`.

## Collections work item

1. As `finance.post`, open a customer with outstanding quotations; **Queue for collections**.
2. As finance/office user, confirm work item appears with branch visibility rules.
