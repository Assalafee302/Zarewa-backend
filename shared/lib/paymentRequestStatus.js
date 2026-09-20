/**
 * Payment-request workflow statuses.
 *
 * Stored approval_status is one of Pending / Approved / Rejected / Cancelled.
 * Legacy rows may still use Submitted, Awaiting approval, blank, or Paid.
 * Payout words (Partially paid / Paid) are derived from amounts — do not persist them.
 */

export const PAYMENT_REQUEST_APPROVAL_PENDING = 'Pending';
export const PAYMENT_REQUEST_APPROVAL_APPROVED = 'Approved';
export const PAYMENT_REQUEST_APPROVAL_REJECTED = 'Rejected';
export const PAYMENT_REQUEST_APPROVAL_CANCELLED = 'Cancelled';

export const PAYMENT_REQUEST_LIFECYCLE_PARTIAL = 'Partially paid';
export const PAYMENT_REQUEST_LIFECYCLE_PAID = 'Paid';

const OPEN_ALIASES = new Set(['', 'pending', 'submitted', 'awaiting approval']);

/**
 * SQL fragment: open (awaiting review) requests, including legacy aliases.
 * @param {string} [columnSql='approval_status']
 */
export function paymentRequestOpenApprovalSql(columnSql = 'approval_status') {
  return `TRIM(IFNULL(${columnSql},'')) IN ('Pending','Submitted','Awaiting approval','')`;
}

/**
 * @param {string | null | undefined} status
 */
export function canonicalPaymentRequestApprovalStatus(status) {
  const s = String(status || '').trim();
  if (OPEN_ALIASES.has(s.toLowerCase())) return PAYMENT_REQUEST_APPROVAL_PENDING;
  if (s === PAYMENT_REQUEST_LIFECYCLE_PAID) return PAYMENT_REQUEST_APPROVAL_APPROVED;
  return s;
}

/**
 * @param {string | null | undefined} status
 */
export function isPaymentRequestOpenForReview(status) {
  return canonicalPaymentRequestApprovalStatus(status) === PAYMENT_REQUEST_APPROVAL_PENDING;
}

/**
 * Pending aliases or Rejected may be edited and resubmitted.
 * @param {string | null | undefined} status
 */
export function isPaymentRequestEditable(status) {
  const canonical = canonicalPaymentRequestApprovalStatus(status);
  return canonical === PAYMENT_REQUEST_APPROVAL_PENDING || canonical === PAYMENT_REQUEST_APPROVAL_REJECTED;
}

/**
 * @param {string | null | undefined} status
 */
export function isPaymentRequestApprovedForPayout(status) {
  return canonicalPaymentRequestApprovalStatus(status) === PAYMENT_REQUEST_APPROVAL_APPROVED;
}

/**
 * Desk-facing status: approval word, or Paid / Partially paid from amounts.
 * @param {{
 *   approvalStatus?: string | null;
 *   amountRequestedNgn?: number | null;
 *   paidAmountNgn?: number | null;
 * }} row
 */
export function paymentRequestLifecycleStatus(row = {}) {
  const approval = canonicalPaymentRequestApprovalStatus(row.approvalStatus);
  if (
    approval === PAYMENT_REQUEST_APPROVAL_REJECTED ||
    approval === PAYMENT_REQUEST_APPROVAL_CANCELLED
  ) {
    return approval;
  }
  if (approval !== PAYMENT_REQUEST_APPROVAL_APPROVED) return PAYMENT_REQUEST_APPROVAL_PENDING;
  const requested = Math.round(Number(row.amountRequestedNgn) || 0);
  const paid = Math.round(Number(row.paidAmountNgn) || 0);
  if (paid <= 0) return PAYMENT_REQUEST_APPROVAL_APPROVED;
  if (requested > 0 && paid >= requested) return PAYMENT_REQUEST_LIFECYCLE_PAID;
  return PAYMENT_REQUEST_LIFECYCLE_PARTIAL;
}

/**
 * Exception-report cash bucket.
 * @param {{
 *   approvalStatus?: string | null;
 *   amountRequestedNgn?: number | null;
 *   paidAmountNgn?: number | null;
 * }} row
 * @returns {'pending' | 'approved_unpaid' | 'paid' | 'other'}
 */
export function paymentRequestCashStage(row = {}) {
  const life = paymentRequestLifecycleStatus(row);
  if (life === PAYMENT_REQUEST_LIFECYCLE_PAID) return 'paid';
  if (life === PAYMENT_REQUEST_LIFECYCLE_PARTIAL || life === PAYMENT_REQUEST_APPROVAL_APPROVED) {
    return 'approved_unpaid';
  }
  if (life === PAYMENT_REQUEST_APPROVAL_PENDING) return 'pending';
  return 'other';
}

/**
 * API fields for list/detail rows (DB snake_case in).
 * @param {{ approval_status?: string | null; amount_requested_ngn?: number | null; paid_amount_ngn?: number | null }} row
 */
export function paymentRequestStatusApiFields(row = {}) {
  return {
    approvalStatus: canonicalPaymentRequestApprovalStatus(row.approval_status),
    lifecycleStatus: paymentRequestLifecycleStatus({
      approvalStatus: row.approval_status,
      amountRequestedNgn: row.amount_requested_ngn,
      paidAmountNgn: row.paid_amount_ngn,
    }),
  };
}
