/**
 * "Paid (net)" per quotation as at a date (owner definition, 2026-10-14):
 *   cash received on the quote + credit applied from earlier overpayments / advances − refunds paid.
 * - Cash = treasury RECEIPT_IN net of RECEIPT_REVERSAL_OUT for the quotation's receipts (cash that stayed;
 *   a receipt reversed in treasury is no cash).
 * - Credit = ledger OVERPAY_APPLIED + ADVANCE_APPLIED on the quotation.
 * - Refunds = treasury REFUND_PAYOUT for the quotation's refunds.
 * "Produced before fully covered" = the quotation's first job completed while coverage was below the
 * quotation value (measures the Phase 3 control).
 */

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const ngn = (v) => Math.round(num(v));
const day = (v) => String(v || '').slice(0, 10);

/**
 * @param {object} input
 * @param {object[]} input.quotations
 * @param {object[]} input.productionJobs
 * @param {object[]} input.ledgerEntries
 * @param {object[]} input.treasuryMovements
 * @param {object[]} input.refunds
 * @param {string} input.asAtISO
 * @returns {Map<string, object>} quotationRef → breakdown
 */
export function buildQuotationCoverage(input = {}) {
  const { quotations = [], productionJobs = [], ledgerEntries = [], treasuryMovements = [], refunds = [], asAtISO = '' } = input;
  const upTo = (iso) => Boolean(iso) && (!asAtISO || iso <= asAtISO);

  const quoteOfLedger = new Map();
  const events = new Map(); // qref → [{ date, kind, amount }]
  const push = (qref, date, kind, amount) => {
    if (!qref || !upTo(date)) return;
    const list = events.get(qref) || [];
    list.push({ date, kind, amount });
    events.set(qref, list);
  };
  for (const e of ledgerEntries) {
    const qref = String(e.quotationRef || '').trim();
    if (e.type === 'RECEIPT') quoteOfLedger.set(String(e.id || '').trim(), qref);
    if (e.type === 'OVERPAY_APPLIED' || e.type === 'ADVANCE_APPLIED') push(qref, day(e.atISO), 'credit', Math.abs(ngn(e.amountNgn)));
  }
  const quoteOfRefund = new Map(refunds.map((r) => [String(r.refundID || r.id || '').trim(), String(r.quotationRef || '').trim()]));
  for (const t of treasuryMovements) {
    const date = day(t.postedAtISO);
    if ((t.type === 'RECEIPT_IN' || t.type === 'RECEIPT_REVERSAL_OUT') && String(t.sourceKind || '') === 'LEDGER_RECEIPT') {
      push(quoteOfLedger.get(String(t.sourceId || '').trim()), date, 'cash', ngn(t.amountNgn));
    } else if (t.type === 'REFUND_PAYOUT') {
      push(quoteOfRefund.get(String(t.sourceId || '').trim()), date, 'refund', -ngn(t.amountNgn));
    }
  }

  const firstCompleted = new Map();
  for (const j of productionJobs) {
    if (String(j.status || '').trim() !== 'Completed') continue;
    const qref = String(j.quotationRef || '').trim();
    const d = day(j.completedAtISO || j.endDateISO);
    if (!qref || !d) continue;
    const cur = firstCompleted.get(qref);
    if (!cur || d < cur) firstCompleted.set(qref, d);
  }

  const out = new Map();
  for (const q of quotations) {
    const qref = String(q.id || '').trim();
    if (!qref) continue;
    const list = events.get(qref) || [];
    const sum = (kind, until = null) =>
      list.filter((e) => e.kind === kind && (!until || e.date <= until)).reduce((s, e) => s + e.amount, 0);
    const cashNgn = sum('cash');
    const creditNgn = sum('credit');
    const refundsNgn = sum('refund');
    const totalNgn = ngn(q.totalNgn);
    const first = firstCompleted.get(qref) || '';
    const coverageAtFirst = first ? sum('cash', first) + sum('credit', first) - sum('refund', first) : null;
    out.set(qref, {
      quotationRef: qref,
      quotationTotalNgn: totalNgn,
      cashNgn,
      creditNgn,
      refundsNgn,
      paidNetNgn: cashNgn + creditNgn - refundsNgn,
      ownOverpaymentNgn: Math.max(0, cashNgn - totalNgn),
      /** Coverage above the quotation value plus its own overpayment: credit applied on top of cash (exception). */
      overCoveredNgn: Math.max(0, cashNgn + creditNgn - refundsNgn - (totalNgn + Math.max(0, cashNgn - totalNgn))),
      firstCompletedISO: first,
      coverageAtFirstCompletionNgn: coverageAtFirst,
      producedBeforeFullyCovered: Boolean(first) && upTo(first) && coverageAtFirst < totalNgn,
    });
  }
  return out;
}
