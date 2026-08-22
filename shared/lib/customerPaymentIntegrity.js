/**
 * Detect duplicate quotations / double-posted payments (staff entry errors).
 * Pure helpers — safe for browser + server.
 * Frontend copies via `npm run sync:shared` → src/shared/lib/customerPaymentIntegrity.js
 */

export const SETTLED_QUOTE_OVERPAY_NOTE_SNIP = 'already settled in records';

function normYmd(iso) {
  const s = String(iso || '').trim();
  if (!s) return '';
  return s.slice(0, 10);
}

function daysBetweenYmd(a, b) {
  const da = normYmd(a);
  const db = normYmd(b);
  if (!da || !db) return 999;
  const t0 = Date.parse(`${da}T12:00:00.000Z`);
  const t1 = Date.parse(`${db}T12:00:00.000Z`);
  if (!Number.isFinite(t0) || !Number.isFinite(t1)) return 999;
  return Math.abs(Math.round((t1 - t0) / 86400000));
}

/**
 * @param {Array<{ id: string, customerId?: string, customerID?: string, totalNgn?: number, total_ngn?: number, dateISO?: string, date_iso?: string, status?: string }>} quotations
 * @param {{ customerId: string, quotationId: string, totalNgn: number, dateISO: string, windowDays?: number }} focus
 * @returns {string[]} other quotation ids that look like duplicates
 */
export function findDuplicateQuotationCandidateIds(quotations, focus) {
  const customerId = String(focus.customerId || '').trim();
  const quotationId = String(focus.quotationId || '').trim();
  const total = Math.round(Number(focus.totalNgn) || 0);
  const dateISO = normYmd(focus.dateISO);
  const windowDays = focus.windowDays ?? 14;
  if (!customerId || !quotationId || total <= 0) return [];

  const out = [];
  for (const q of quotations || []) {
    const id = String(q.id || '').trim();
    if (!id || id === quotationId) continue;
    const cid = String(q.customerId ?? q.customerID ?? '').trim();
    if (cid !== customerId) continue;
    const st = String(q.status || '').trim().toLowerCase();
    if (st === 'void') continue;
    const qt = Math.round(Number(q.totalNgn ?? q.total_ngn) || 0);
    if (qt !== total) continue;
    const qd = normYmd(q.dateISO ?? q.date_iso);
    if (dateISO && qd && daysBetweenYmd(dateISO, qd) > windowDays) continue;
    out.push(id);
  }
  return out;
}

/**
 * @param {{
 *   quotationId: string,
 *   quoteTotalNgn: number,
 *   receiptCashNgn: number,
 *   cashInNgn: number,
 *   settledQuoteFullOverpayNgn?: number,
 *   duplicateQuotationIds?: string[],
 *   customerReceiptCountSameAmount?: number,
 * }} ctx
 * @returns {{ code: string, severity: 'warning' | 'critical', message: string, relatedQuotationId?: string }[]}
 */
export function paymentIntegrityIssuesForQuotation(ctx) {
  /** @type {{ code: string, severity: 'warning' | 'critical', message: string, relatedQuotationId?: string }[]} */
  const issues = [];
  const quoteTotal = Math.round(Number(ctx.quoteTotalNgn) || 0);
  const receiptCash = Math.round(Number(ctx.receiptCashNgn) || 0);
  const cashIn = Math.round(Number(ctx.cashInNgn) || 0);
  const settledFull = Math.round(Number(ctx.settledQuoteFullOverpayNgn) || 0);
  const dupIds = Array.isArray(ctx.duplicateQuotationIds) ? ctx.duplicateQuotationIds : [];

  for (const otherId of dupIds) {
    issues.push({
      code: 'duplicate_quotation_same_total',
      severity: 'critical',
      message: `Another quotation (${otherId}) has the same customer, date window, and total (₦${quoteTotal.toLocaleString('en-NG')}). Confirm this is a separate job before refunding or paying again.`,
      relatedQuotationId: otherId,
    });
  }

  if (settledFull > 0 && receiptCash > 0) {
    issues.push({
      code: 'settled_quote_repeat_payment',
      severity: 'critical',
      message: `₦${settledFull.toLocaleString('en-NG')} was posted as overpayment credit after this quote was already settled, while receipt cash (₦${receiptCash.toLocaleString('en-NG')}) is on file. Refunds use receipt cash only — finance should reverse the duplicate ledger row if the customer did not pay twice.`,
    });
  }

  const ledgerInflated = cashIn > 0 && receiptCash > 0 && cashIn > receiptCash + Math.max(quoteTotal, settledFull) * 0.25;
  if (ledgerInflated && settledFull <= 0) {
    issues.push({
      code: 'cash_in_overstated',
      severity: 'warning',
      message: `Recorded cash in (₦${cashIn.toLocaleString('en-NG')}) is much higher than receipt cash (₦${receiptCash.toLocaleString('en-NG')}) on this quotation. Use Sync paid from receipts and review ledger before approving a refund.`,
    });
  }

  const sameAmtCount = Math.round(Number(ctx.customerReceiptCountSameAmount) || 0);
  if (sameAmtCount >= 2 && dupIds.length > 0) {
    issues.push({
      code: 'duplicate_customer_receipt_pattern',
      severity: 'critical',
      message: `This customer has ${sameAmtCount} receipt(s) for the same amount near the same time across similar quotations — likely a duplicate till entry.`,
    });
  }

  return issues;
}

/**
 * Customer-level rollup for dashboard banner.
 * @param {Array<{ code: string, severity: string, message: string, relatedQuotationId?: string }>} quotationIssues
 */
export function customerPaymentIntegritySummary(quotationIssues) {
  const list = Array.isArray(quotationIssues) ? quotationIssues : [];
  const critical = list.filter((i) => i.severity === 'critical');
  return {
    hasIssues: list.length > 0,
    criticalCount: critical.length,
    issues: list,
  };
}
