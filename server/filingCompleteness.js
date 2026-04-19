/**
 * Rules for "complete" filing metadata on completed work items (records lens / unfiled queue).
 */

const TYPES_REQUIRING_REFERENCE = new Set([
  'payment_request',
  'refund_request',
  'bank_recon_exceptions',
  'po_transport_payment',
]);

/**
 * @param {string | null | undefined} documentType
 * @param {{ filingReference?: string | null } | null | undefined} filing
 * @returns {{ filingIncomplete: boolean; filingIncompleteReason: string | null }}
 */
export function filingCompletenessForWorkItem(documentType, filing) {
  const dt = String(documentType || '').trim().toLowerCase();
  if (!TYPES_REQUIRING_REFERENCE.has(dt)) {
    return { filingIncomplete: false, filingIncompleteReason: null };
  }
  const ref = String(filing?.filingReference || '').trim();
  if (!ref) {
    return { filingIncomplete: true, filingIncompleteReason: 'Filing reference not assigned' };
  }
  return { filingIncomplete: false, filingIncompleteReason: null };
}
