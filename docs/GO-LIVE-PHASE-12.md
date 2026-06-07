# Phase 12 — Go-Live Cutover & Continuous Governance

Phase 12 extends Phase 11C enforcement to **manager approval**, closes the **production payment gate** loop in Operations, and makes the **attention inbox** actionable.

## What shipped

### 12B — Approval-stage alignment enforcement

- `decideRefundRequest` re-runs `validateRefundProductionAlignmentAtSubmit` when status is **Approved**.
- Merges submit-time acknowledgements from `production_alignment_ack_json` with approval-time ack/override from the payload.
- Updates `production_alignment_ack_json` on approval; audits new BM/MD override notes at approval (`refund.production_alignment.override`, phase `approval`).
- **RefundManagerApprovalPreview** shows alignment gate with acknowledge checkboxes and override note before Approve is enabled.

### 12C — Production payment gate UX

- **ProductionPaymentGateOverridePanel** in Live Production Monitor (Job intelligence section).
- Requires `quotations.manage`; calls `POST /api/management/review` with `approve_production` and audited reason (≥8 chars).
- Refreshes job intel and workspace after override.

### 12D — Actionable attention inbox

- `governance` items from `GET /api/management/attention` open:
  - Dual-control warnings → refund approval modal (`/manager?refundId=…`)
  - Payment gate breaches → production gate quotation review (`?quoteRef=…`)
- Deep link: **`/manager?refundId=RF-…`** opens pending refund review.

## Cutover checklist (12A — operational)

1. Export governance pack (Reports → Operational control centre → CSV).
2. Resolve or document each misaligned refund and dual-control warning.
3. Set `ENFORCE_DUAL_CONTROL_PAYMENTS=1` when finance desk supports segregated approve/pay roles.
4. Run role UAT: sales submit blocked alignment, BM override, manager approval gate, production gate override from monitor.
5. Train managers: approval panel requires acknowledgement for partial-production / overlap warnings.

## Tests

```bash
npm run test -- server/refundProductionAlignment.test.js
```

## Related

- [GO-LIVE-PHASE-11C.md](./GO-LIVE-PHASE-11C.md)
- [ACCESS_CONTROL.md](./ACCESS_CONTROL.md) — Phase 12 section
