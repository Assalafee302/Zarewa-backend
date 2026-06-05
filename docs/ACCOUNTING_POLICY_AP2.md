# Accounting Policy — AP2 (Supplier, GRN, Payables & Inventory)

## AP2a (current) — diagnostics only

Read-only management reports. **No** changes to:

- `syncAccountsPayableFromPurchaseOrder`
- `accounts_payable` balances
- Supplier payment posting
- Inventory / coil cost logic
- GL journals

### Expected AP (received basis)

For each purchase order:

- **Ordered value** — Σ ordered qty × unit price (commitment only).
- **Received value** — coil `landed_cost_ngn` when present; else estimated from received qty × PO unit price (flagged estimated).
- **Supplier paid** — `purchase_orders.supplier_paid_ngn` (treasury movements noted when they differ).
- **Current AP** — `accounts_payable.amount_ngn` as stored today.
- **Expected AP** — `max(received − paid, 0)`.
- **AP difference** — `current AP − expected AP`.

### Risk flags

| Flag | Condition |
|------|-----------|
| Supplier advance | paid > received |
| Received not paid | received > paid |
| Payable without GRN | AP > 0 and (no received, or AP ≫ received) |
| GRN without payable | received > 0, expected AP > 0, current AP = 0 |
| Missing cost | coil / line without unit or landed cost |

### API

`GET /api/finance/ap2-supplier-diagnostics` — finance_manager, Head of Accounts, MD/admin, `finance.view`, `accounting.reconciliation.view`, `procurement.view` (not cashier-only).

### UI

- **Accounting Desk** → tab **Supplier & AP**
- **Executive Command Centre** — compact exposure strip
- **Reports** — AP2a report cards (link to Accounting Desk)
- **Procurement** — compact diagnostic card (optional)

Head of Accounts must review diagnostics before any AP basis change in **AP2b**.

## AP2b (planned)

Received-goods AP basis correction with HoA approval workflow.

## AP2c (planned)

Supplier advance journals and inventory/GL alignment.
