/** Threshold (₦) — sales must re-enter amount to confirm posting. */
export const RECEIPT_AMOUNT_CONFIRM_THRESHOLD_NGN = 100_000;

/** Typed confirmation for bulk reset of finance clearance on sales receipts. */
export const RECEIPT_CLEARANCE_RESET_CONFIRM_PHRASE = 'RESET RECEIPT CLEARANCE';

export const RECEIPT_STATUS_PENDING_CLEARANCE = 'Pending clearance';
export const RECEIPT_STATUS_CLEARED = 'Cleared';
export const RECEIPT_STATUS_REVERSED = 'Reversed';

function normStatus(status) {
  return String(status || '')
    .trim()
    .toLowerCase();
}

/** Receipt row is reversed (compensating entry posted). */
export function isReceiptReversed(row) {
  const s = normStatus(row?.status);
  return s === 'reversed';
}

/** Finance has confirmed bank/cash and finalized reconciliation. */
export function isReceiptCleared(row) {
  if (!row || isReceiptReversed(row)) return false;
  const saved = row.financeReconciliationSavedAtISO ?? row.finance_reconciliation_saved_at_iso;
  if (saved != null && String(saved).trim() !== '') return true;
  return normStatus(row?.status) === 'cleared';
}

/** Finance reconciliation saved — bank-received amount is authoritative for what was paid. */
export function isReceiptFinanceReconciled(row) {
  if (!row || isReceiptReversed(row)) return false;
  const saved = row.financeReconciliationSavedAtISO ?? row.finance_reconciliation_saved_at_iso;
  return saved != null && String(saved).trim() !== '';
}

/** Positive bank-received amount when finance has recorded it. */
export function receiptBankReceivedAmountNgn(row) {
  const bank = row?.bankReceivedAmountNgn ?? row?.bank_received_amount_ngn;
  if (bank == null) return null;
  const n = Math.round(Number(bank) || 0);
  return n > 0 ? n : null;
}

/**
 * Bank-received amount is authoritative when finance saved reconciliation, the receipt is Cleared,
 * or finance recorded a bank figure that differs from the sales-posted book amount.
 * @param {object} row
 * @returns {number | null}
 */
export function receiptAuthoritativeBankCashNgn(row) {
  if (!row || isReceiptReversed(row)) return null;
  const bank = receiptBankReceivedAmountNgn(row);
  if (bank == null) return null;
  if (isReceiptFinanceReconciled(row)) return bank;
  if (isReceiptCleared(row)) return bank;
  const alloc = Math.round(Number(row.amountNgn ?? row.amount_ngn) || 0);
  if (Math.abs(bank - alloc) > 1) return bank;
  return null;
}

/** Finance-confirmed cash when bank amount is authoritative; otherwise null. */
export function receiptReconciledCashNgn(row) {
  return receiptAuthoritativeBankCashNgn(row);
}

/**
 * Cash tied to a receipt for refunds, analytics, and treasury tie-out.
 * Authoritative bank-received replaces sales-posted allocation + companion overpay.
 * @param {object} row
 * @param {{ companionOverpayNgn?: number }} [opts]
 */
export function receiptEffectiveCashNgn(row, opts = {}) {
  if (!row) return 0;
  if (row.cashReceivedNgn != null) return Math.round(Number(row.cashReceivedNgn) || 0);
  const authoritative = receiptAuthoritativeBankCashNgn(row);
  if (authoritative != null) return authoritative;
  const alloc = Math.round(Number(row.amountNgn ?? row.amount_ngn) || 0);
  const extra = Math.max(0, Math.round(Number(opts.companionOverpayNgn) || 0));
  return Math.round(alloc + extra);
}

/** Posted by sales, awaiting finance confirmation. */
export function isReceiptPendingClearance(row) {
  if (!row || isReceiptReversed(row)) return false;
  return !isReceiptCleared(row);
}

export function receiptClearanceBadgeLabel(row) {
  if (isReceiptReversed(row)) return 'Reversed';
  if (isReceiptCleared(row)) return 'Cleared';
  return 'Pending clearance';
}

/** Cash received on receipt rows that are not yet cleared (pending float). */
export function pendingClearanceTotalNgn(receipts = []) {
  return (Array.isArray(receipts) ? receipts : []).reduce((sum, r) => {
    if (!isReceiptPendingClearance(r)) return sum;
    return sum + receiptEffectiveCashNgn(r);
  }, 0);
}

/** Sum of cleared receipt cash (for display; treasury book balance may differ slightly). */
export function clearedReceiptsTotalNgn(receipts = []) {
  return (Array.isArray(receipts) ? receipts : []).reduce((sum, r) => {
    if (!isReceiptCleared(r)) return sum;
    return sum + receiptEffectiveCashNgn(r);
  }, 0);
}

/**
 * Split treasury liquidity for dashboards: book total vs uncleared customer receipts.
 * @param {object[]} treasuryAccounts
 * @param {object[]} salesReceipts
 */
export function liquidityClearanceSplit(treasuryAccounts = [], salesReceipts = []) {
  const bookTotalNgn = (Array.isArray(treasuryAccounts) ? treasuryAccounts : []).reduce(
    (s, a) => s + (Number(a.balance) || 0),
    0
  );
  const pendingClearanceNgn = pendingClearanceTotalNgn(salesReceipts);
  const clearedBookNgn = Math.max(0, bookTotalNgn - pendingClearanceNgn);
  return {
    bookTotalNgn: Math.round(bookTotalNgn),
    pendingClearanceNgn: Math.round(pendingClearanceNgn),
    clearedBookNgn: Math.round(clearedBookNgn),
  };
}
