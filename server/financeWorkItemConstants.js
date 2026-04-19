/**
 * Canonical source_kind / document_type values for finance-driven work items.
 * Keep in sync with docs/FINANCE_WORK_ITEM_CONVENTIONS.md and server/workItems.js routing.
 */
export const FINANCE_WORK_ITEM_SOURCE_KINDS = {
  BANK_RECON_EXCEPTIONS: 'finance_bank_recon',
  PO_TRANSPORT: 'finance_po_transport',
};

export const FINANCE_WORK_ITEM_DOCUMENT_TYPES = {
  BANK_RECON_EXCEPTIONS: 'bank_recon_exceptions',
  PO_TRANSPORT: 'po_transport_payment',
};
