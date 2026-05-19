# Material exceptions & offcut control — SOP

## Purpose

Control coil stain, production error, customer return, yard offcut, and supplier defect with:

- Branch manager approval before stock posts
- Per-incident offcut number (`MEX-…`)
- Printable register copy for the physical offcut book
- Traceability from coil → incident → production use

## Roles

| Role | Actions |
|------|---------|
| Storekeeper / operations | Create draft, lines, kg, evidence, submit |
| Branch manager | Approve (posts stock), reject, unlock edits, void |
| Production | Issue metres from posted incidents on job complete |
| Sales | View offcut availability on quotation (guidance only) |
| MD / reports | Loss and pending approval counts |

## Workflow

1. **Operations → Material exceptions → New incident**
2. Enter type, coil/quotation/job links, roll lines (length × qty), before/after kg, storekeeper + operator names.
3. **Save draft** → **Print** (draft watermark) for yard file if needed.
4. **Submit** → branch manager queue.
5. **Approve & post** → coil kg reduced (if applicable), metres added to incident pool balance.
6. **Production** → pick incident(s) when using offcut stock metres; completion shows “supplied from offcut”.
7. **Customer return** → choose sellable FG or offcut pool; optional **Create refund request**.

## Incident types

- **Coil stain** — after unwind; kg off coil + metres to offcut pool.
- **Production error** — requires production job ID.
- **Customer return** — sellable restores FG metres; otherwise offcut pool.
- **Yard offcut** — pool inward (trim/scratch).
- **Supplier defect** — supplier resolution + optional kg remove.

## Anti-theft controls

- No delete — void with reason (manager).
- Pool balance = posted metres minus issues (per incident).
- All stock movement via audited `coil_control_events` linked to `MEX` id.
- Edit after post requires manager unlock + audit log.

## Reports

- `GET /api/material-incidents/reports/loss` — loss by type/reason
- MD operations pack includes `materialIncidentsPendingApproval`
