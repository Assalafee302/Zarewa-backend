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

## GL target state (AP1c+, not yet enforced in AP1a)

- Customer cash on quote **before production** → liability **2500** (customer deposits).
- Earn at production → release deposit, credit **4000**, debit **1200** only for true post-production balance.
- See `docs/ACCOUNTING_POLICIES.md` for legacy Phase 0 notes superseded by this document for customer revenue timing.

## Environment flags

| Variable | Default | Effect |
|----------|---------|--------|
| `ACCOUNTING_POLICY_V1_LABELS` | `0` | UI/report policy labels via API fields |
| `ACCOUNTING_POLICY_V1_DIAGNOSTICS` | `0` | Extra counts on Finance trial-exceptions API |
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
