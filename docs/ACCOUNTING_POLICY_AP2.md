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

## AP2b (current) — received-basis correction with approval

### Feature flags (default off)

| Flag | Purpose |
|------|---------|
| `AP_RECEIVED_BASIS_ENABLED=0` | When `1`, `syncAccountsPayableFromPurchaseOrder` uses received goods value for `AP-PO-%` rows. |
| `AP_RECEIVED_BASIS_REBUILD_ENABLED=0` | When `1`, allows `POST /api/finance/ap2-ap-rebuild` after preview hash + HoA note. |

### API

- `GET /api/finance/ap2-ap-rebuild-preview` — SELECT-only preview + `previewHash`
- `POST /api/finance/ap2-ap-rebuild` — updates only `AP-PO-%` rows; manual AP untouched

### Audit actions

- `ap.received_basis.previewed`
- `ap.received_basis.rebuilt`

### Rules

- `amount_ngn` on rebuild/sync (received basis) = received value, or `0` if paid > received or no receipt
- Supplier advance journals **not** created in AP2b (AP2c)
- No rebuild on app boot

## AP2c (current) — advances, valuation, GL alignment

### Feature flags

| Flag | Default | Purpose |
|------|---------|---------|
| `SUPPLIER_ADVANCE_ACCOUNTING_ENABLED` | `0` | Optional GL for prepayment (not wired to Treasury payments) |
| `INVENTORY_VALUATION_REPORTS_ENABLED` | `1` | Coil accounting value reports |
| `AP_GL_ALIGNMENT_DIAGNOSTICS_ENABLED` | `1` | Management tie-out warnings |

### APIs (read-only)

- `GET /api/finance/supplier-advance-report`
- `GET /api/finance/inventory-valuation-report`
- `GET /api/finance/ap-inventory-gl-alignment`

### Settlement classes

`normal_payable`, `fully_paid`, `supplier_advance`, `partially_received_advance`, `missing_grn`, plus `missing_cost` label.

### GL account 1400

Seeded as **Supplier advances / prepayments** when missing. Posting only via explicit helper when flag on — no retroactive supplier payment reclassification.
