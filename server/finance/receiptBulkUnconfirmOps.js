/**
 * Bulk unconfirm finance-cleared sales receipts for a branch + date period.
 * Uses the same per-receipt unconfirm path (split flags + refund-credit reverse) so the desk
 * can reconfirm a whole month cleanly.
 */
import { branchWhere } from '../readModel.js';
import { appendAuditLog } from '../controlOps.js';
import { unconfirmSalesReceiptFinanceClearance } from '../writeOps.js';
import {
  RECEIPT_BULK_UNCONFIRM_CONFIRM_PHRASE,
  resolveBulkUnconfirmDateRange,
} from '../../shared/lib/receiptClearance.js';

const MAX_BULK_UNCONFIRM = 2_000;

/** Confirmed / cleared (non-reversed) receipts awaiting bulk unconfirm. */
function confirmedReceiptWhereSql() {
  return `
       AND TRIM(LOWER(COALESCE(status, ''))) NOT IN ('reversed')
       AND (
         (finance_reconciliation_saved_at_iso IS NOT NULL AND TRIM(finance_reconciliation_saved_at_iso) != '')
         OR TRIM(LOWER(COALESCE(status, ''))) IN ('cleared', 'confirmed')
         OR (bank_confirmed_at_iso IS NOT NULL AND TRIM(bank_confirmed_at_iso) != '')
       )`;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} branchScope
 * @param {{ dateFrom?: string, dateTo?: string, yearMonth?: string }} options
 */
export function listConfirmedReceiptIdsForBulkUnconfirm(db, branchScope, options = {}) {
  const scope = String(branchScope || '').trim();
  if (!scope || scope === 'ALL') {
    return {
      ok: false,
      code: 'BRANCH_REQUIRED',
      error: 'Open a specific branch workspace before bulk-unconfirming receipts (not All branches).',
    };
  }

  const range = resolveBulkUnconfirmDateRange(options);
  if (!range.ok) return range;

  const b = branchWhere(db, 'sales_receipts', scope);
  const rows = db
    .prepare(
      `SELECT id, date_iso, amount_ngn, status, quotation_ref
       FROM sales_receipts
       WHERE 1=1${b.sql}
         AND date_iso >= ? AND date_iso <= ?
         ${confirmedReceiptWhereSql()}
       ORDER BY date_iso ASC, id ASC
       LIMIT ?`
    )
    .all(...b.args, range.dateFrom, range.dateTo, MAX_BULK_UNCONFIRM + 1);

  const truncated = rows.length > MAX_BULK_UNCONFIRM;
  const list = truncated ? rows.slice(0, MAX_BULK_UNCONFIRM) : rows;
  const totalAmountNgn = list.reduce((s, r) => s + (Number(r.amount_ngn) || 0), 0);

  return {
    ok: true,
    dateFrom: range.dateFrom,
    dateTo: range.dateTo,
    yearMonth: range.yearMonth || null,
    branchScope: scope,
    count: list.length,
    truncated,
    maxCount: MAX_BULK_UNCONFIRM,
    totalAmountNgn,
    sampleIds: list.slice(0, 25).map((r) => r.id),
    receiptIds: list.map((r) => r.id),
  };
}

/**
 * Preview how many confirmed receipts would be unconfirmed for the period.
 * @param {import('better-sqlite3').Database} db
 * @param {string} branchScope
 * @param {{ dateFrom?: string, dateTo?: string, yearMonth?: string }} options
 */
export function previewBulkUnconfirmSalesReceipts(db, branchScope, options = {}) {
  const listed = listConfirmedReceiptIdsForBulkUnconfirm(db, branchScope, options);
  if (!listed.ok) return listed;
  const { receiptIds: _ids, ...preview } = listed;
  return preview;
}

/**
 * Unconfirm every finance-confirmed sales receipt in branch scope for the date period.
 * @param {import('better-sqlite3').Database} db
 * @param {string} branchScope
 * @param {object | null} actor
 * @param {{
 *   dateFrom?: string,
 *   dateTo?: string,
 *   yearMonth?: string,
 *   reason?: string,
 *   note?: string,
 *   confirmPhrase?: string,
 *   dryRun?: boolean,
 * }} [options]
 */
export function bulkUnconfirmSalesReceiptsFinanceClearance(db, branchScope, actor = null, options = {}) {
  const phrase = String(options.confirmPhrase || '').trim();
  if (phrase !== RECEIPT_BULK_UNCONFIRM_CONFIRM_PHRASE) {
    return {
      ok: false,
      code: 'CONFIRM_PHRASE_REQUIRED',
      error: `Type ${RECEIPT_BULK_UNCONFIRM_CONFIRM_PHRASE} to confirm.`,
      confirmPhraseRequired: RECEIPT_BULK_UNCONFIRM_CONFIRM_PHRASE,
    };
  }

  const reason = String(options.reason || options.note || '').trim();
  if (reason.length < 3) {
    return {
      ok: false,
      code: 'REASON_REQUIRED',
      error: 'Enter a short reason (at least 3 characters) for bulk unconfirming these payments.',
    };
  }

  const listed = listConfirmedReceiptIdsForBulkUnconfirm(db, branchScope, options);
  if (!listed.ok) return listed;

  if (listed.truncated) {
    return {
      ok: false,
      code: 'TOO_MANY_RECEIPTS',
      error: `More than ${MAX_BULK_UNCONFIRM} confirmed receipts match this period. Narrow the date range and try again.`,
      count: listed.count,
      maxCount: MAX_BULK_UNCONFIRM,
    };
  }

  if (options.dryRun) {
    const { receiptIds: _ids, ...preview } = listed;
    return { ok: true, dryRun: true, ...preview };
  }

  if (listed.count <= 0) {
    return {
      ok: true,
      unconfirmedCount: 0,
      failedCount: 0,
      dateFrom: listed.dateFrom,
      dateTo: listed.dateTo,
      yearMonth: listed.yearMonth,
      branchScope: listed.branchScope,
      sampleIds: [],
      failures: [],
    };
  }

  const failures = [];
  const unconfirmedIds = [];
  let reversedRefundCreditCount = 0;

  for (const receiptId of listed.receiptIds) {
    const r = unconfirmSalesReceiptFinanceClearance(db, receiptId, actor, { reason });
    if (!r.ok) {
      failures.push({
        receiptId,
        error: r.error || 'Unconfirm failed.',
        ...(r.code ? { code: r.code } : {}),
      });
      continue;
    }
    unconfirmedIds.push(receiptId);
    reversedRefundCreditCount += Array.isArray(r.reversedRefundCreditApplications)
      ? r.reversedRefundCreditApplications.length
      : 0;
  }

  appendAuditLog(db, {
    actor,
    action: 'receipt.finance_bulk_unconfirm',
    entityKind: 'sales_receipt',
    entityId: '*',
    note: reason,
    details: {
      dateFrom: listed.dateFrom,
      dateTo: listed.dateTo,
      yearMonth: listed.yearMonth,
      branchScope: listed.branchScope,
      unconfirmedCount: unconfirmedIds.length,
      failedCount: failures.length,
      reversedRefundCreditCount,
      sampleIds: unconfirmedIds.slice(0, 25),
      failureSample: failures.slice(0, 10),
    },
  });

  return {
    ok: failures.length === 0,
    ...(failures.length ? { code: 'PARTIAL_FAILURE', error: `${failures.length} receipt(s) could not be unconfirmed.` } : {}),
    unconfirmedCount: unconfirmedIds.length,
    failedCount: failures.length,
    reversedRefundCreditCount,
    dateFrom: listed.dateFrom,
    dateTo: listed.dateTo,
    yearMonth: listed.yearMonth,
    branchScope: listed.branchScope,
    sampleIds: unconfirmedIds.slice(0, 25),
    failures,
  };
}
