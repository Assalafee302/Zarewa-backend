/** Threshold (₦) — sales must re-enter amount to confirm posting. */
export const RECEIPT_AMOUNT_CONFIRM_THRESHOLD_NGN = 100_000;

/** Typed confirmation for bulk reset of finance clearance on sales receipts. */
export const RECEIPT_CLEARANCE_RESET_CONFIRM_PHRASE = 'RESET RECEIPT CLEARANCE';

/** Typed confirmation for bulk unconfirm of confirmed receipts in a date period. */
export const RECEIPT_BULK_UNCONFIRM_CONFIRM_PHRASE = 'UNCONFIRM PERIOD RECEIPTS';

/** Max inclusive span (days) for bulk unconfirm dateFrom..dateTo. */
export const RECEIPT_BULK_UNCONFIRM_MAX_SPAN_DAYS = 93;

export const RECEIPT_STATUS_PENDING_CLEARANCE = 'Pending clearance';
export const RECEIPT_STATUS_CLEARED = 'Cleared';
export const RECEIPT_STATUS_REVERSED = 'Reversed';

const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const YEAR_MONTH_RE = /^\d{4}-\d{2}$/;

/**
 * Last calendar day of a YYYY-MM month as YYYY-MM-DD.
 * @param {string} yearMonth
 */
export function lastDayOfYearMonth(yearMonth) {
  const ym = String(yearMonth || '').trim();
  if (!YEAR_MONTH_RE.test(ym)) return '';
  const [y, m] = ym.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${ym}-${String(last).padStart(2, '0')}`;
}

/**
 * Resolve bulk-unconfirm period from yearMonth or dateFrom/dateTo.
 * @param {{ dateFrom?: string, dateTo?: string, yearMonth?: string }} options
 * @returns {{ ok: true, dateFrom: string, dateTo: string, yearMonth?: string } | { ok: false, code: string, error: string }}
 */
export function resolveBulkUnconfirmDateRange(options = {}) {
  const yearMonth = String(options.yearMonth || '').trim();
  let dateFrom = String(options.dateFrom || '').trim().slice(0, 10);
  let dateTo = String(options.dateTo || '').trim().slice(0, 10);

  if (yearMonth) {
    if (!YEAR_MONTH_RE.test(yearMonth)) {
      return {
        ok: false,
        code: 'INVALID_YEAR_MONTH',
        error: 'Month must be YYYY-MM (for example 2026-05).',
      };
    }
    dateFrom = `${yearMonth}-01`;
    dateTo = lastDayOfYearMonth(yearMonth);
  }

  if (!ISO_DAY_RE.test(dateFrom) || !ISO_DAY_RE.test(dateTo)) {
    return {
      ok: false,
      code: 'DATE_RANGE_REQUIRED',
      error: 'Provide yearMonth (YYYY-MM) or dateFrom and dateTo (YYYY-MM-DD).',
    };
  }
  if (dateFrom > dateTo) {
    return {
      ok: false,
      code: 'INVALID_DATE_RANGE',
      error: 'dateFrom must be on or before dateTo.',
    };
  }

  const fromMs = Date.parse(`${dateFrom}T00:00:00.000Z`);
  const toMs = Date.parse(`${dateTo}T00:00:00.000Z`);
  const spanDays = Math.round((toMs - fromMs) / 86_400_000) + 1;
  if (!Number.isFinite(spanDays) || spanDays < 1) {
    return {
      ok: false,
      code: 'INVALID_DATE_RANGE',
      error: 'Invalid date range.',
    };
  }
  if (spanDays > RECEIPT_BULK_UNCONFIRM_MAX_SPAN_DAYS) {
    return {
      ok: false,
      code: 'DATE_RANGE_TOO_LONG',
      error: `Date range cannot exceed ${RECEIPT_BULK_UNCONFIRM_MAX_SPAN_DAYS} days. Unconfirm one month at a time.`,
    };
  }

  return {
    ok: true,
    dateFrom,
    dateTo,
    ...(yearMonth ? { yearMonth } : {}),
  };
}

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
  // Legacy "Confirmed" predates Pending clearance / Cleared and means finance already signed off.
  const s = normStatus(row?.status);
  return s === 'cleared' || s === 'confirmed';
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
