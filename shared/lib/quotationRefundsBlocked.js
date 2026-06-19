/**
 * Permanent refund block on a quotation (MD / admin only to set).
 * @param {{ refunds_blocked_at_iso?: string | null; refundsBlockedAtISO?: string | null } | null | undefined} row
 */
export function quotationRefundsBlocked(row) {
  return Boolean(String(row?.refunds_blocked_at_iso ?? row?.refundsBlockedAtISO ?? '').trim());
}

export const QUOTATION_REFUNDS_BLOCK_REASON_MIN_LEN = 10;
