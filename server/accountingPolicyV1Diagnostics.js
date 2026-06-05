/**
 * AP1a — read-only Policy v1 diagnostic counts (no mutations, no gates).
 * @param {import('better-sqlite3').Database} db
 * @param {'ALL' | string} [branchScope]
 */
import { isEffectivelyFullyPaid } from '../shared/lib/paymentOutstandingTolerance.js';
import { quotationHasCompletedProduction } from '../shared/lib/customerLedgerCore.js';
import { branchWhere, listProductionJobs } from './readModel.js';
import {
  deliveryReleaseWouldBeBlockedForQuotation,
  evaluateQuotationPaymentForDeliveryRelease,
} from './deliveryReleaseGate.js';

export { deliveryReleaseWouldBeBlockedForQuotation };

function tableExists(db, name) {
  const n = String(name || '').trim();
  if (!n) return false;
  try {
    const row = db
      .prepare(
        `SELECT 1 AS ok FROM information_schema.tables
         WHERE table_schema = DATABASE() AND table_name = ? LIMIT 1`
      )
      .get(n);
    if (row) return true;
  } catch {
    /* SQLite tests */
  }
  try {
    return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(n));
  } catch {
    return false;
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {'ALL' | string} [branchScope]
 */
export function countAccountingPolicyV1Diagnostics(db, branchScope = 'ALL') {
  const out = {
    receiptsOnQuoteNoProductionWithGl1200: 0,
    quotationsFullyPaidNoProduction: 0,
    quotationsPreProductionWithBalanceDue: 0,
    openDeliveriesWouldBlockOnPayment: 0,
  };
  if (!tableExists(db, 'quotations')) return out;

  const productionJobs = listProductionJobs(db, branchScope);
  const jobsByQuote = new Map();
  for (const j of productionJobs) {
    const ref = String(j.quotationRef || j.quotation_ref || '').trim();
    if (!ref) continue;
    if (!jobsByQuote.has(ref)) jobsByQuote.set(ref, []);
    jobsByQuote.get(ref).push(j);
  }

  const qb = branchWhere(db, 'quotations', branchScope);
  const quotes = db.prepare(`SELECT id, total_ngn, paid_ngn FROM quotations WHERE 1=1${qb.sql}`).all(...qb.args);

  for (const q of quotes) {
    const ref = String(q.id || '').trim();
    const jobs = jobsByQuote.get(ref) || [];
    const total = Math.round(Number(q.total_ngn) || 0);
    const paid = Math.round(Number(q.paid_ngn) || 0);
    const hasProd = quotationHasCompletedProduction(ref, jobs);
    const due = Math.max(0, total - paid);

    if (!hasProd && due > 0) out.quotationsPreProductionWithBalanceDue += 1;
    if (!hasProd && isEffectivelyFullyPaid(paid, total) && total > 0) {
      out.quotationsFullyPaidNoProduction += 1;
    }
  }

  if (tableExists(db, 'gl_journal_entries') && tableExists(db, 'gl_journal_lines') && tableExists(db, 'sales_receipts')) {
    const br = branchWhere(db, 'sales_receipts', branchScope);
    const rows = db
      .prepare(
        `SELECT DISTINCT sr.quotation_ref AS qref, sr.ledger_entry_id AS lid
         FROM sales_receipts sr
         INNER JOIN gl_journal_entries j ON j.source_kind = 'CUSTOMER_RECEIPT_GL' AND j.source_id = sr.ledger_entry_id
         INNER JOIN gl_journal_lines jl ON jl.journal_id = j.id
         INNER JOIN gl_accounts ga ON ga.id = jl.account_id AND ga.code = '1200' AND jl.credit_ngn > 0
         WHERE sr.quotation_ref IS NOT NULL AND TRIM(sr.quotation_ref) != ''
           AND (sr.status IS NULL OR TRIM(LOWER(sr.status)) NOT IN ('reversed')) ${br.sql}`
      )
      .all(...br.args);
    for (const r of rows) {
      const ref = String(r.qref || '').trim();
      if (!ref) continue;
      if (!quotationHasCompletedProduction(ref, jobsByQuote.get(ref) || [])) {
        out.receiptsOnQuoteNoProductionWithGl1200 += 1;
      }
    }
  }

  if (tableExists(db, 'deliveries')) {
    const dbw = branchWhere(db, 'deliveries', branchScope);
    const openDeliveries = db
      .prepare(
        `SELECT quotation_ref FROM deliveries
         WHERE quotation_ref IS NOT NULL AND TRIM(quotation_ref) != ''
           AND TRIM(LOWER(COALESCE(status,''))) NOT IN ('delivered','cancelled') ${dbw.sql}`
      )
      .all(...dbw.args);
    for (const d of openDeliveries) {
      const ref = String(d.quotation_ref || '').trim();
      const gate = evaluateQuotationPaymentForDeliveryRelease(db, ref, jobsByQuote.get(ref) || []);
      if (gate.wouldBlock) out.openDeliveriesWouldBlockOnPayment += 1;
    }
  }

  return out;
}
