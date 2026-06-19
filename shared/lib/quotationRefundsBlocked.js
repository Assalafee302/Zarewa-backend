/**
 * Permanent refund block on a quotation (MD / admin only to set).
 * @param {{ refunds_blocked_at_iso?: string | null; refundsBlockedAtISO?: string | null } | null | undefined} row
 */
export function quotationRefundsBlocked(row) {
  return Boolean(String(row?.refunds_blocked_at_iso ?? row?.refundsBlockedAtISO ?? '').trim());
}

/** Refund row carries quotation-level permanent block (from listRefunds join). */
export function refundQuotationRefundsBlocked(refundRow) {
  return quotationRefundsBlocked({
    refunds_blocked_at_iso:
      refundRow?.quotationRefundsBlockedAtISO ?? refundRow?.quotation_refunds_blocked_at_iso,
    refundsBlockedAtISO: refundRow?.quotationRefundsBlockedAtISO,
  });
}

/**
 * SQL predicate: refund is not tied to a quotation with permanent refunds blocked.
 * @param {string} [refundsAlias='customer_refunds']
 */
export function refundPayableQuotationWhereSql(refundsAlias = 'customer_refunds') {
  const cr = refundsAlias;
  return `(TRIM(COALESCE(${cr}.quotation_ref, '')) = '' OR NOT EXISTS (
    SELECT 1 FROM quotations q
    WHERE q.id = ${cr}.quotation_ref
      AND TRIM(COALESCE(q.refunds_blocked_at_iso, '')) != ''
  ))`;
}

export const QUOTATION_REFUNDS_BLOCK_REASON_MIN_LEN = 10;
