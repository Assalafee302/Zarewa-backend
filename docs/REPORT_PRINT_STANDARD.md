# Report print standard (pilot reference)

This document is the **pilot reference** for printable outputs in Zarewa (excluding **customer quotation** and **cutting list** reports, which keep their own layouts).

## Page and CSS

- **Paper**: **A4 portrait** (US **Letter** is acceptable in browsers that map `size: A4` to local defaults; primary target is A4).
- **Named page**: `@page quotation-a4` — margins ~12mm × 14mm (see `src/index.css` `@media print`).
- **Root wrapper** (required for a correct printout from a modal/portal):

  `quotation-print-root quotation-print-preview-mode`

  This pair ensures:

  - Only the report body is visible when printing (`body * { visibility: hidden }` reset).
  - Preview chrome matches printed output (no gray mat / double card).
  - Color adjustment for backgrounds and borders where needed.

- **Content width**: Inner layout uses **`quotation-print-a4`** (max-width 210mm, centered).

## Layout component

Use **`StandardReportPrintShell`** from `src/components/reports/StandardReportPrintShell.jsx`:

- Company logo in **maroon** tile, **ZAREWA_DOC_BLUE** (`#1a3a5a`) accent borders.
- Optional large **watermark** (2–3 letters, e.g. `PO`, `RPT`, `RCP`).
- Header: document type label, **title**, optional **subtitle**, legal name line.
- Optional **right column** for references / status / “Printed …” metadata.
- **Footer** slot for one-line disclaimers.

Place **tables and sections** as **children** below the header (inside the shell).

## User flow

1. **Preview** in a scrollable overlay (class `print-portal-scroll` on the overlay is important so `@media print` flattens layout and avoids blank pages).
2. **Print / Save as PDF** calls `window.print()` on the preview root.

Do **not** put `no-print` on any ancestor of `*-print-root` — the printout will be blank.

## Examples in codebase

| Output | Shell / pattern |
|--------|------------------|
| PO transaction | `PurchaseOrderPrintView` → `StandardReportPrintShell` |
| Management reports (Reports page) | `ManagementReportSheet` in `ReportPrintModal.jsx` |
| Advance payment voucher | `AdvancePaymentPrintView` → `StandardReportPrintShell` |
| Payment receipts | `ReceiptPrintQuick`, `ReceiptPrintFull` → `StandardReportPrintShell` |

## Excluded

- **Quotation** (`QuotationPrintView` / `QuotationModal`) — unchanged.
- **Cutting list** (`CuttingListReportPrintView` / factory packs) — unchanged.
