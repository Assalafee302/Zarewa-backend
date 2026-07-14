/**
 * Expenses + refunds standard report payloads (pure).
 */

import { displayDocNumber } from './reportDisplayFormat.js';
import { refundApprovedAmount, refundOutstandingAmount, isRefundPayable } from './refundsStore.js';

function toIsoDate(value) {
  return String(value || '').slice(0, 10);
}

function expenseDateIso(e) {
  return toIsoDate(e?.date || e?.dateISO);
}

/**
 * @returns {{ detail: object[], summaryByCategory: object[] }}
 */
export function expensesPackReport(expenses = [], startDate, endDate) {
  const detail = [];
  for (const e of expenses || []) {
    const iso = expenseDateIso(e);
    if (!iso) continue;
    if (startDate && iso < startDate) continue;
    if (endDate && iso > endDate) continue;
    const id = String(e.expenseID ?? e.expense_id ?? '').trim();
    detail.push({
      expenseIdDisplay: displayDocNumber(id) || '—',
      expenseIdFull: id || '—',
      dateISO: iso,
      category: String(e.category || '').trim() || '—',
      expenseType: String(e.expenseType ?? e.expense_type ?? '').trim() || '—',
      amountNgn: Math.round(Number(e.amountNgn ?? e.amount_ngn) || 0),
      paymentMethod: String(e.paymentMethod ?? e.payment_method ?? '').trim() || '—',
      reference: String(e.reference || '').trim() || '—',
    });
  }
  detail.sort((a, b) => a.dateISO.localeCompare(b.dateISO) || a.expenseIdFull.localeCompare(b.expenseIdFull));

  const totals = new Map();
  const counts = new Map();
  for (const r of detail) {
    const k = r.category;
    totals.set(k, (totals.get(k) || 0) + r.amountNgn);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const summaryByCategory = [...totals.entries()]
    .map(([category, totalNgn]) => ({
      category,
      totalNgn: Math.round(totalNgn),
      rowCount: counts.get(category) || 0,
    }))
    .sort((a, b) => b.totalNgn - a.totalNgn || a.category.localeCompare(b.category));

  return { detail, summaryByCategory };
}

/**
 * @returns {{ paidInPeriod: object[], pipeline: object[], summary: object }}
 */
export function refundsPackReport(refunds = [], startDate, endDate) {
  const paidInPeriod = [];
  for (const r of refunds || []) {
    const id = String(r.refundID ?? r.refund_id ?? '').trim();
    const hist = Array.isArray(r.payoutHistory) ? r.payoutHistory : [];
    let linesFromHistory = 0;
    for (const p of hist) {
      const iso = toIsoDate(p.postedAtISO || p.posted_at_iso || p.paidAtISO || p.atISO);
      if (!iso) continue;
      if (startDate && iso < startDate) continue;
      if (endDate && iso > endDate) continue;
      const amountNgn = Math.round(Number(p.amountNgn) || 0);
      if (amountNgn <= 0) continue;
      linesFromHistory += 1;
      paidInPeriod.push({
        payoutDateISO: iso,
        refundIdDisplay: displayDocNumber(id) || '—',
        refundIdFull: id || '—',
        customer: String(r.customer || '').trim() || '—',
        quotationRefDisplay: displayDocNumber(r.quotationRef) || '—',
        amountNgn,
        bankAccount: String(p.accountName || '').trim() || '—',
        reference: String(p.reference || '').trim() || '—',
      });
    }
    if (linesFromHistory > 0) continue;
    const iso = toIsoDate(r.paidAtISO || r.paid_at_iso);
    if (iso && (!startDate || iso >= startDate) && (!endDate || iso <= endDate)) {
      const paid = Math.round(Number(r.paidAmountNgn) || 0);
      if (paid > 0) {
        paidInPeriod.push({
          payoutDateISO: iso,
          refundIdDisplay: displayDocNumber(id) || '—',
          refundIdFull: id || '—',
          customer: String(r.customer || '').trim() || '—',
          quotationRefDisplay: displayDocNumber(r.quotationRef) || '—',
          amountNgn: paid,
          bankAccount: '—',
          reference: String(r.paymentNote || '').trim() || '—',
        });
      }
    }
  }
  paidInPeriod.sort((a, b) => a.payoutDateISO.localeCompare(b.payoutDateISO));

  const pipeline = [];
  for (const r of refunds || []) {
    const st = String(r.status || '').trim();
    if (st === 'Paid') continue;
    if (st === 'Approved' && !isRefundPayable(r)) continue;
    const id = String(r.refundID ?? r.refund_id ?? '').trim();
    const approved = refundApprovedAmount(r);
    const paid = Math.round(Number(r.paidAmountNgn) || 0);
    const out = refundOutstandingAmount(r);
    pipeline.push({
      refundIdDisplay: displayDocNumber(id) || '—',
      refundIdFull: id || '—',
      customer: String(r.customer || '').trim() || '—',
      quotationRefDisplay: displayDocNumber(r.quotationRef) || '—',
      status: st || 'Pending',
      requestedNgn: Math.round(Number(r.amountNgn) || 0),
      approvedNgn: Math.round(approved),
      paidNgn: paid,
      outstandingNgn: Math.round(out),
      requestedAtISO: toIsoDate(r.requestedAtISO) || '',
    });
  }
  pipeline.sort((a, b) => (b.outstandingNgn || 0) - (a.outstandingNgn || 0));

  const summary = {
    paidLinesInPeriod: paidInPeriod.length,
    paidTotalNgn: Math.round(paidInPeriod.reduce((s, x) => s + (Number(x.amountNgn) || 0), 0)),
    pipelineRows: pipeline.length,
    pipelineOutstandingNgn: Math.round(pipeline.reduce((s, x) => s + (Number(x.outstandingNgn) || 0), 0)),
  };

  return { paidInPeriod, pipeline, summary };
}
