# Role → dashboard matrix (Phase 10)

Canonical role keys live in `server/auth.js` → `ROLE_DEFINITIONS`. UI labels may differ from keys (e.g. `finance_manager` = **Accountant / Head of Accounts**).

## Primary dashboards

| Role key | Label | Primary route | Also uses |
|----------|-------|---------------|-----------|
| `md` | Managing Director | `/manager` | `/exec`, `/procurement`, `/accounting`, `/accounts` (oversight), Executive HR `/hr/executive` |
| `sales_manager` | Branch manager | `/manager` | `/team-hr`, `/sales`, `/operations` — **not** `/hr`, `/accounting`, `/accounts` |
| `finance_manager` | Accountant / Head of Accounts | `/accounting` | `/accounts` (reconciliation tabs), `/reports` |
| `cashier` | Cashier | `/cashier` | Limited `/accounts` tabs only — **not** `/accounting` |
| `hr_admin` | HR / Admin | `/hr` | `/reports` |
| `gmhr` | GM HR | `/hr` | `/reports` |
| `sales_staff` | Sales officer | `/` (workspace) | `/sales`, `/my-profile` |
| `operations_officer` | Operations officer | `/operations` | `/procurement` (floor) |
| `ceo` | CEO | `/exec` | `/reports` (read-only) |
| `admin` | Administrator | All modules | Break-glass `*` |
| `viewer` | Read-only viewer | `/` | Workspace only |

## Restricted modules (default seed)

| Role | Must NOT access |
|------|-----------------|
| Branch manager | Main `/hr`, `/accounting`, broad `/accounts`, org payroll/bank |
| Cashier | `/accounting`, GL/audit tabs on `/accounts` |
| Accountant | Branch production ops, cashier desk (default), HR admin |
| Staff | `/hr`, `/team-hr` (unless granted), finance desks |
| MD | Full HR **admin** shell (uses Executive HR + approvals only) |

## Approvals (summary)

| Area | MD | Branch manager | Accountant | HR admin | GM HR |
|------|----|----------------|------------|----------|-------|
| Payroll MD sign-off | ✓ | — | — | prepare | GM approve |
| Refunds (branch) | ✓ | ✓ (limit) | — | — | — |
| Leave/loan endorse | — | ✓ (team) | — | HR review | GM final |
| Procurement / PO | ✓ (central) | view branch ops | AP diagnostics | — | — |

## Legacy `/accounts` (Phase 10)

- **Hidden** from cashier and branch manager navigation.
- **Tab RBAC**: cashier → receipts/movements/disbursements/treasury; accountant → includes audit; MD/admin → all.
- **Redirects**: cashier → `/cashier`; BM → `/manager`; denied GL tab → desk or home.

## Custom permission overrides

Users with `permissions_json` are listed in **Settings → Team → Custom permission overrides**. Changes audit as `user.update_permissions`. Extra HR/finance/payroll keys are flagged by risk level.

## UI preservation (Phase 10)

**Do not redesign** without explicit approval: Sales, Cashier Desk, Accounting Desk, Treasury desk visual patterns.
