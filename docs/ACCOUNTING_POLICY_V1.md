# Zarewa Accounting Policy v1 (approved)

Management-approved policy for customer revenue, deposits, receivables, and delivery release. **AP1a** adds documentation and read-only labels; GL and enforcement follow in AP1b–f.

## Revenue

1. **Revenue is recognized when a production job is completed** (metres-based earn, capped at quotation total).
2. **Delivery is operational tracking** — not the primary revenue trigger.

## Customer payments

3. **Payments before production completion** are **deposits / advances on account** until earned.
4. **Customer debt (accounts receivable)** begins **after production completion**.
5. Any **unpaid balance after production** is due immediately unless **approved credit terms / exception** exist.

## Delivery release

6. **Delivery / release** should be blocked unless the customer has **fully paid** or a valid **credit / exception** is approved (enforcement phased in AP1b–e).

## Credit

7. **Credit approval limits** are MD policy decisions; branch managers may approve within MD limits.

## Trial / onboarding

8. **Trial mode remains active** — exception panels and diagnostics are **warnings only** until strict flags are deliberately enabled.

## Reporting basis matrix

| View | Basis | Label in app (AP1a+) |
|------|--------|----------------------|
| Order book / pipeline | Quotation date & total | **Management order book (quotation date)** |
| Revenue (Policy v1) | Production completion | **Revenue at production completion** |
| Cash collected | Receipt / treasury date | **Cash receipts register** |
| AR as-at | Balance due after completed production | **Receivable (post-production)** |
| Pre-production balance | Total − paid on quote | **Deposit pending** (not receivable) |

## GL target state (AP1c — dry-run in AP1c-0; posting in AP1c-2+)

See **`docs/ACCOUNTING_POLICY_AP1C.md`** and `GET /api/finance/ap1c-dry-run` (when `ACCOUNTING_POLICY_V1_DIAGNOSTICS=1`).

- Customer cash on quote **before production** → liability **2500** (customer deposits).
- Earn at production → release deposit, credit **4000**, debit **1200** only for true post-production balance.
- See `docs/ACCOUNTING_POLICIES.md` for legacy Phase 0 notes superseded by this document for customer revenue timing.

### Delivery credit exceptions (AP1d)

- **Credit does not clear debt** — receivable stays until cash is received.
- **Credit allows delivery** when an approved exception covers the outstanding balance on the quotation.
- Workflow: request → approve (branch limit or MD per `CREDIT_*` env / org policy KV) → optional revoke.
- APIs: `GET/POST /api/credit-exceptions`, `POST .../decision`, `POST .../revoke`, `GET /api/quotations/:id/credit-status`.
- Delivery gate (`payment-release-check`) returns credit status; hard block remains **AP1e** (`DELIVERY_PAYMENT_GATE=enforce`).

### Receipt reversal & refunds (AP1c-4)

- **Reversal** mirrors the original receipt credit: Dr **2500** or **1200**, Cr **1000**, resolved from `gl_receipt_policy_meta` then journal-line inference; legacy default **1200** only when AP1c posting flags are off.
- **Refund payout** (treasury): Dr **2500** / Cr **1000** for deposit and overpayment refunds; **no automatic Dr 4000** for post-production revenue correction — flagged for Head of Accounts review when production revenue was recognized.
- Detail: **`docs/ACCOUNTING_POLICY_AP1C.md`** (AP1c-4 section).

## Environment flags

| Variable | Default | Effect |
|----------|---------|--------|
| `ACCOUNTING_POLICY_V1_LABELS` | `0` | UI/report policy labels via API fields |
| `ACCOUNTING_POLICY_V1_DIAGNOSTICS` | `0` | Extra counts on Finance trial-exceptions API + AP1c dry-run UI |
| `ACCOUNTING_POLICY_V1_RECEIPT_GL` | `0` | AP1c-2: status-dependent receipt GL (not in AP1c-0) |
| `ACCOUNTING_POLICY_V1_PRODUCTION_RELEASE` | `0` | AP1c-3: full deposit release at production |
| `ACCOUNTING_POLICY_V1_LEGACY_BRIDGE` | `0` | AP1c-3: legacy pre-prod 1200 bridge at production |
| *(no new flag)* | — | AP1c-4 reversal/refund hardening follows AP1c-2/3 flags; unresolvable reversals fail when any AP1c posting flag is on |
| `CREDIT_BRANCH_MANAGER_LIMIT_NGN` | *(unset)* | Branch manager may approve credit up to this amount |
| `CREDIT_MD_REQUIRED_ABOVE_NGN` | *(unset)* | Amounts above require MD/admin approval |
| `CREDIT_DEFAULT_TERMS_DAYS` | `14` | Default payment terms on new requests |
| `CREDIT_MAX_TERMS_DAYS` | `90` | Maximum terms days |
| `RECLASS_PRE_PRODUCTION_RECEIPTS` | `0` | AP1c-5+: optional reclass journals |
| `DELIVERY_PAYMENT_GATE` | `0` | `0/off` = off; `1`/`warn` = warn on confirm; `enforce` = block confirm (AP1e) |
| `DELIVERY_PAYMENT_GATE_STRICT_FINANCE` | `0` | When on, unpaid + uncleared receipts add to gate message |
| `ALLOW_MD_DELIVERY_OVERRIDE` | `0` | MD/Admin may pass `mdOverride` + reason on confirm (AP1e) |

## AP1b — Delivery payment gate (warn mode)

- **Check:** `GET /api/deliveries/:id/payment-release-check`
- **Confirm:** `POST /api/deliveries/:id/confirm` (calls `confirmDelivery` in `writeOps.js`)
- **List/create:** `GET /api/deliveries`, `POST /api/deliveries`
- When `DELIVERY_PAYMENT_GATE=1` (warn): unpaid quotations still confirm delivery but write audit `delivery.payment_gate_warning` and return `deliveryGateWarning` in JSON.
- When `DELIVERY_PAYMENT_GATE=enforce`: confirm returns `403` with `DELIVERY_PAYMENT_GATE_BLOCKED`.

---

*Signed-off internally as Policy v1 — reference in month-end and training materials.*
