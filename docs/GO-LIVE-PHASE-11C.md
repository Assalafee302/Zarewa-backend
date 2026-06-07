# Phase 11C — Governance enforcement & go-live hardening

Phase 11C closes the loop from **detecting** operational risk (11B reports) to **preventing** misaligned refunds and surfacing controls on manager/exec dashboards.

## What shipped

### Refund submit enforcement

- `validateRefundProductionAlignmentAtSubmit` in `server/refundProductionAlignment.js` runs on every new refund request (`insertRefundRequest`).
- **Hard block**: `Order cancellation` when production jobs show completed output — unless a branch manager / MD / admin supplies an override note (≥10 characters).
- **Acknowledge**: partial production cancellation and multi-category overlap require explicit checkbox acknowledgement at submit.
- Audit: overrides log `refund.production_alignment.override`; acknowledgements stored in `customer_refunds.production_alignment_ack_json`.
- API check (for UI): `POST /api/refunds/production-alignment-check` with `quotationRef`, `reasonCategory`, optional ack codes and override note.
- Sales **Refund modal** shows alignment panel and disables submit until resolved.

### Operational surfacing

- **OperationalSummaryWidget** on Manager Dashboard and Executive Command Centre (users with `reports.view` / management reports access).
- Links through to **Reports → Operational control centre**.

### MD attention inbox

- `GET /api/management/attention` now includes:
  - Dual-control segregation warnings (when `ENFORCE_DUAL_CONTROL_PAYMENTS=1`).
  - Payment gate breaches (completed jobs under 70% paid without BM production override).

### Material incidents from production

- **Live production monitor** → **Report material issue** (requires `material_incidents.create`).
- Prefills job id, quotation ref, gauge/colour; saves a draft via `POST /api/material-incidents`.

### Go-live governance pack

- `GET /api/reports/governance-pack` — JSON summary aligned with `scripts/phase11-analyze-exports.py`.
- `GET /api/reports/governance-pack?format=csv` — downloadable CSV sections (summary, misaligned refunds, dual-control, payment gate).

## Pre go-live checklist

1. Set `ENFORCE_DUAL_CONTROL_PAYMENTS=1` in production once finance desk staffing supports approver ≠ payer.
2. Run governance pack export and clear or document:
   - Misaligned refunds (`Order cancellation` vs completed production).
   - Dual-control warnings on historical rows.
   - Payment gate exceptions on completed jobs.
   - Conversion QC gaps (High/Low without BM sign-off).
3. Train sales on **Unproduced meterage** vs **Order cancellation** when jobs have output.
4. Confirm branch managers know override note requirement for blocked alignment cases.

## Tests

```bash
npm run test -- server/refundProductionAlignment.test.js
```

## Related docs

- [ACCESS_CONTROL.md](./ACCESS_CONTROL.md) — Phase 11A–11C permission notes
- [REFUND_OPERATIONS.md](./REFUND_OPERATIONS.md) — refund desk workflow
