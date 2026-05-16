/**
 * Payment / quotation duplicate detection for alerts (staff entry errors).
 */
import {
  customerPaymentIntegritySummary,
  findDuplicateQuotationCandidateIds,
  paymentIntegrityIssuesForQuotation,
} from '../shared/lib/customerPaymentIntegrity.js';
import { quotationPaymentCashBreakdown } from './quotationPaymentCash.js';
import { branchWhere } from './readModel.js';

function roundMoney(value) {
  return Math.round(Number(value) || 0);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} customerID
 * @param {string} [branchScope]
 */
export function collectCustomerPaymentIntegrityIssues(db, customerID, branchScope = 'ALL') {
  const cid = String(customerID || '').trim();
  if (!cid) return [];

  const b = branchWhere(db, 'quotations', branchScope);
  const quotations = db
    .prepare(
      `SELECT id, customer_id, total_ngn, date_iso, status, paid_ngn
       FROM quotations WHERE customer_id = ?${b.sql}
       ORDER BY date_iso DESC, id DESC`
    )
    .all(cid, ...b.args)
    .map((row) => ({
      id: row.id,
      customerID: row.customer_id,
      totalNgn: row.total_ngn,
      dateISO: row.date_iso,
      status: row.status,
      paidNgn: row.paid_ngn,
    }));

  /** @type {import('../shared/lib/customerPaymentIntegrity.js').paymentIntegrityIssuesForQuotation extends Function ? ReturnType<typeof paymentIntegrityIssuesForQuotation> : never} */
  const allIssues = [];

  for (const q of quotations) {
    const cash = quotationPaymentCashBreakdown(db, q.id);
    const dupIds = findDuplicateQuotationCandidateIds(quotations, {
      customerId: cid,
      quotationId: q.id,
      totalNgn: q.totalNgn,
      dateISO: q.dateISO,
    });

    let customerReceiptCountSameAmount = 0;
    const qd = String(q.dateISO || '').slice(0, 10);
    if (qd) {
      const row = db
        .prepare(
          `SELECT COUNT(DISTINCT sr.id) AS c
           FROM sales_receipts sr
           INNER JOIN quotations qq ON qq.id = sr.quotation_ref
           WHERE sr.customer_id = ?
             AND qq.customer_id = ?
             AND qq.date_iso = ?
             AND (sr.status IS NULL OR TRIM(LOWER(sr.status)) NOT IN ('reversed'))
             ${b.sql.replace(/\bbranch_id\b/g, 'qq.branch_id')}`
        )
        .get(cid, cid, qd, ...b.args);
      customerReceiptCountSameAmount = roundMoney(row?.c);
    }

    const issues = paymentIntegrityIssuesForQuotation({
      quotationId: q.id,
      quoteTotalNgn: q.totalNgn,
      receiptCashNgn: cash.receiptCashNgn,
      cashInNgn: cash.cashInNgn,
      settledQuoteFullOverpayNgn: cash.settledQuoteFullOverpayNgn,
      duplicateQuotationIds: dupIds,
      customerReceiptCountSameAmount,
    });
    for (const iss of issues) {
      allIssues.push({ ...iss, quotationId: q.id });
    }
  }

  return allIssues;
}

export { customerPaymentIntegritySummary };

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} quotationRef
 */
export function refundPaymentIntegrityIssues(db, quotationRef) {
  const ref = String(quotationRef || '').trim();
  if (!ref) return [];
  const q = db
    .prepare(`SELECT id, customer_id, total_ngn, date_iso, status, branch_id FROM quotations WHERE id = ?`)
    .get(ref);
  if (!q) return [];

  const customerID = String(q.customer_id || '').trim();
  const branchScope =
    q.branch_id != null && String(q.branch_id).trim() ? String(q.branch_id).trim() : 'ALL';

  const b = branchWhere(db, 'quotations', branchScope);
  const quotations = db
    .prepare(`SELECT id, customer_id, total_ngn, date_iso, status FROM quotations WHERE customer_id = ?${b.sql}`)
    .all(customerID, ...b.args)
    .map((row) => ({
      id: row.id,
      customerID: row.customer_id,
      totalNgn: row.total_ngn,
      dateISO: row.date_iso,
      status: row.status,
    }));

  const cash = quotationPaymentCashBreakdown(db, ref);
  const dupIds = findDuplicateQuotationCandidateIds(quotations, {
    customerId: customerID,
    quotationId: ref,
    totalNgn: q.total_ngn,
    dateISO: q.date_iso,
  });

  let customerReceiptCountSameAmount = 0;
  if (cash.receiptCashNgn > 0 && customerID) {
    const row = db
      .prepare(
        `SELECT COUNT(DISTINCT sr.id) AS c
         FROM sales_receipts sr
         WHERE sr.customer_id = ?
           AND ROUND(sr.amount_ngn) >= ?
           AND (sr.status IS NULL OR TRIM(LOWER(sr.status)) NOT IN ('reversed'))`
      )
      .get(customerID, Math.max(cash.receiptCashNgn - 1, 0));
    customerReceiptCountSameAmount = roundMoney(row?.c);
  }

  return paymentIntegrityIssuesForQuotation({
    quotationId: ref,
    quoteTotalNgn: q.total_ngn,
    receiptCashNgn: cash.receiptCashNgn,
    cashInNgn: cash.cashInNgn,
    settledQuoteFullOverpayNgn: cash.settledQuoteFullOverpayNgn,
    duplicateQuotationIds: dupIds,
    customerReceiptCountSameAmount,
  });
}

/**
 * Warn when creating a quotation that mirrors an existing one.
 * @param {import('better-sqlite3').Database} db
 * @param {{ customerID: string, totalNgn: number, dateISO: string, branchId?: string }} payload
 */
export function duplicateQuotationCreateSignals(db, payload) {
  const customerID = String(payload.customerID || '').trim();
  const totalNgn = roundMoney(payload.totalNgn);
  const dateISO = String(payload.dateISO || '').slice(0, 10);
  if (!customerID || totalNgn <= 0) return [];

  const branchScope = payload.branchId != null ? String(payload.branchId) : 'ALL';
  const b = branchWhere(db, 'quotations', branchScope);
  const quotations = db
    .prepare(
      `SELECT id, customer_id, total_ngn, date_iso, status FROM quotations
       WHERE customer_id = ?${b.sql}`
    )
    .all(customerID, ...b.args)
    .map((row) => ({
      id: row.id,
      customerID: row.customer_id,
      totalNgn: row.total_ngn,
      dateISO: row.date_iso,
      status: row.status,
    }));

  const dupIds = findDuplicateQuotationCandidateIds(quotations, {
    customerId: customerID,
    quotationId: '__new__',
    totalNgn,
    dateISO,
    windowDays: 14,
  });

  return dupIds.map((id) => ({
    code: 'DUPLICATE_QUOTATION_CANDIDATE',
    message: `Existing quotation ${id} has the same total (₦${totalNgn.toLocaleString('en-NG')}) and similar date — confirm this is not a duplicate entry.`,
    relatedQuotationId: id,
  }));
}
