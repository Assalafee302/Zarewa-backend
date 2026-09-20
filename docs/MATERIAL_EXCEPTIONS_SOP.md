# Material exceptions & offcut control — SOP

## Purpose

Control coil stain, production error, customer return, yard offcut, and supplier defect with:

- Branch manager approval before stock posts
- Per-incident offcut number (`MEX-…`)
- Printable register copy for the physical offcut book
- Traceability from coil → incident → quotation (stain sales) or production use

## Roles

| Role | Actions |
|------|---------|
| Storekeeper / operations | Create draft, lines, kg, evidence, submit |
| Branch manager | Approve (posts stock), reject, unlock edits, void |
| Sales | Quote **Type of material = Stain**; floor is parent workbook − ₦1,000 |
| Production | Issue **coil stain** metres on stain jobs, or allocate a matching parent-family coil (stained section can stay on a coil already in production) |
| MD / reports | Loss and pending approval counts; notified when a branch manager approves a below-stain-floor price exception |

## Workflow

1. **Operations → Material exceptions → New incident**
2. Enter type, coil/quotation/job links, roll lines (length × qty), before/after kg, storekeeper + operator names.
3. **Save draft** → **Print** (draft watermark) for yard file if needed.
4. **Submit** → branch manager queue.
5. **Approve & post** → coil kg reduced (if applicable), metres added to incident pool balance.
6. **Coil stain** metres become **sellable stain stock** (not generic production offcut). Sales quotes Type = Stain (gauge, colour, profile). Production can issue matching stain incidents **or** run the stained section from a coil (including a coil already allocated to a Planned/Running job).
7. **Production error / yard offcut** → pick incident(s) when using generic offcut stock metres; completion shows “supplied from offcut”.
8. **Customer return** → choose sellable FG or offcut pool; optional **Create refund request**.

## Incident types

- **Coil stain** — after unwind, including on a coil already in production; kg off remaining good coil (reserved kg on the linked job is released); damaged metres go to the **stain pool**. Remaining good coil stays on the job.
- **Production error** — requires production job ID; metres to generic offcut pool.
- **Customer return** — sellable restores FG metres; otherwise offcut pool.
- **Yard offcut** — generic pool inward (trim/scratch).
- **Supplier defect** — supplier resolution + optional kg remove.

## Stain quotations (frontend contract)

- Type of material **Stain** (`MAT-006`). SPA copy: `shared/lib/stainMaterialUi.js` (`STAIN_TYPE_HELP`, `stainFloorFieldLabel`, `stainFloorCaption`, `stainProfileFieldHelp`, `STAIN_QUOTATION_STEPS`).
- Profiles stay Aluminium / Aluzinc / Stone lists. Backend stamps `stainSourceMaterialTypeId` from the selected profile (`STAIN_SOURCE_MATERIAL_CODE` if missing).
- **Stock check / inventory desk:** `stainStockCheckCopy()`, `stockCheckRowsForMaterialType({ coilRows, stainInventory, materialTypeId })`. Render `lot.displayTitle`, `displayStock`, `displayOrigin` (bootstrap `stainInventory` is already decorated). Empty yard: `stainInventoryEmptyState()`.
- **Cutting lists:** `computeCuttingListMaterialReadiness(..., stainPoolRows)` — ready if stain metres **or** a matching coil exist.
- **Production:** `stainProductionCopy()`. Complete without a coil: pick yard stain metres (`STAIN_COMPLETE_NEEDS_YARD_STOCK`). Optional coil if stained steel is still on the roll.
- **Material exceptions:** dropdown `stainIncidentTypeOptions()` — label **Stain on coil**, not `coil_stain`. Form: `stainDamageFormCopy()`. Reserved-job error: `STAIN_RESERVED_KG_NEEDS_JOB`.
- **Reports:** section title `stainReportSectionTitle()`; `GET /api/reports/stock-coil-as-at` → `stainInventory.rows`.
- Refunds: commission vs the **stain** floor (stamped `floorPricePerMeter`). Quote at stain floor → commission 0.

## Anti-theft controls

- No delete — void with reason (manager).
- Pool balance = posted metres minus issues (per incident).
- Coil stain metres cannot be issued onto a full-price (non-stain) production job.
- All stock movement via audited `coil_control_events` linked to `MEX` id.
- Edit after post requires manager unlock + audit log.

## Reports

- `GET /api/material-incidents/reports/loss` — loss by type/reason
- `GET /api/material-incidents/pool-summary` — `stainMetersAvailable`, `stainKgAvailable`, `stainInventory`
- `GET /api/material-incidents/stain-inventory` — remaining stain lots (metres + kg, coil, spec)
- `GET /api/reports/stock-coil-as-at` — coil rows plus `stainInventory`
- MD operations pack includes `materialIncidentsPendingApproval`
