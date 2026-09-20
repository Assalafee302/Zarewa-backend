/**
 * Expenses + refunds standard report payloads (pure).
 */

import { displayDocNumber } from './reportDisplayFormat.js';
import { refundApprovedAmount, refundOutstandingAmount, isRefundPayable } from './refundsStore.js';
import { abbreviateBankName } from './bankAbbreviation.js';

function toIsoDate(value) {
  return String(value || '').slice(0, 10);
}

function expenseDateIso(e) {
  return toIsoDate(e?.date || e?.dateISO);
}

function bankLabelFromMovement(t) {
  const isCash = String(t?.accountType || '').trim().toLowerCase() === 'cash';
  if (isCash) return 'Cash';
  return abbreviateBankName(t?.bankName) || String(t?.accountName || '').trim() || '';
}

function expenseIdFromCashMovement(t) {
  const kind = String(t?.sourceKind || '').trim();
  if (kind === 'EXPENSE') return String(t.sourceId || t.counterpartyId || '').trim();
  if (kind === 'PAYMENT_REQUEST') return String(t.counterpartyId || '').trim();
  return '';
}

function isExpenseCashMovement(t) {
  const kind = String(t?.sourceKind || '').trim();
  return kind === 'EXPENSE' || kind === 'PAYMENT_REQUEST';
}

function movementPostedIso(t, fallbackIso) {
  return toIsoDate(t?.postedAtISO || t?.posted_at_iso || fallbackIso);
}

function inDateRange(iso, startDate, endDate) {
  if (!iso) return false;
  if (startDate && iso < startDate) return false;
  if (endDate && iso > endDate) return false;
  return true;
}

/**
 * Net cash paid per expense in the report window (EXPENSE and PAYMENT_REQUEST_OUT,
 * including reversals so a fully reversed payout nets to zero).
 */
function cashPaidByExpenseId(treasuryMovements = [], startDate, endDate, expenseById) {
  /** @type {Map<string, { netNgn: number, bankAccount: string, dateISO: string, counterpartyName: string }>} */
  const byId = new Map();
  for (const t of treasuryMovements || []) {
    if (!isExpenseCashMovement(t)) continue;
    const id = expenseIdFromCashMovement(t);
    if (!id) continue;
    const fallback = expenseDateIso(expenseById.get(id));
    const iso = movementPostedIso(t, fallback);
    if (!inDateRange(iso, startDate, endDate)) continue;
    const amt = Math.round(Number(t.amountNgn ?? t.amount_ngn) || 0);
    const prev = byId.get(id) || { netNgn: 0, bankAccount: '', dateISO: iso, counterpartyName: '' };
    prev.netNgn += -amt;
    if (iso > prev.dateISO) prev.dateISO = iso;
    if (amt < 0 && !prev.bankAccount) prev.bankAccount = bankLabelFromMovement(t);
    if (!prev.counterpartyName) prev.counterpartyName = String(t.counterpartyName || t.note || '').trim();
    byId.set(id, prev);
  }
  return byId;
}

function summarizeExpensePack(detail) {
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
  return summaryByCategory;
}

function packDetailRow(e, id, iso, amountNgn, bankAccount) {
  const expenseType = String(e?.expenseType ?? e?.expense_type ?? '').trim();
  return {
    expenseIdDisplay: displayDocNumber(id) || '—',
    expenseIdFull: id || '—',
    dateISO: iso,
    category: String(e?.category || '').trim() || '—',
    expenseType: expenseType || '—',
    description: expenseType || String(e?.category || '').trim() || '—',
    amountNgn: Math.round(Number(amountNgn) || 0),
    paymentMethod: String(e?.paymentMethod ?? e?.payment_method ?? '').trim() || '—',
    bankAccount: bankAccount || '—',
    reference: String(e?.reference || '').trim() || '—',
  };
}

/**
 * @param {Array} treasuryMovements — cash-basis when non-empty (EXPENSE + PAYMENT_REQUEST)
 * @returns {{ detail: object[], summaryByCategory: object[], dateBasis: 'paid' | 'expense' }}
 */
export function expensesPackReport(expenses = [], startDate, endDate, treasuryMovements = []) {
  const movements = Array.isArray(treasuryMovements) ? treasuryMovements : [];
  const expenseById = new Map();
  for (const e of expenses || []) {
    const id = String(e.expenseID ?? e.expense_id ?? '').trim();
    if (id) expenseById.set(id, e);
  }

  const detail = [];
  if (movements.length) {
    const cash = cashPaidByExpenseId(movements, startDate, endDate, expenseById);
    for (const [id, paid] of cash) {
      if (paid.netNgn <= 0) continue;
      const e = expenseById.get(id);
      detail.push(
        packDetailRow(
          e || { category: paid.counterpartyName, expenseType: paid.counterpartyName, paymentMethod: 'Treasury' },
          id,
          paid.dateISO,
          paid.netNgn,
          paid.bankAccount
        )
      );
    }
    detail.sort((a, b) => a.dateISO.localeCompare(b.dateISO) || a.expenseIdFull.localeCompare(b.expenseIdFull));
    return { detail, summaryByCategory: summarizeExpensePack(detail), dateBasis: 'paid' };
  }

  for (const e of expenses || []) {
    const iso = expenseDateIso(e);
    if (!inDateRange(iso, startDate, endDate)) continue;
    const id = String(e.expenseID ?? e.expense_id ?? '').trim();
    detail.push(packDetailRow(e, id, iso, e.amountNgn ?? e.amount_ngn, ''));
  }
  detail.sort((a, b) => a.dateISO.localeCompare(b.dateISO) || a.expenseIdFull.localeCompare(b.expenseIdFull));
  return { detail, summaryByCategory: summarizeExpensePack(detail), dateBasis: 'expense' };
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
      const isCash = String(p.accountType || '').trim().toLowerCase() === 'cash';
      paidInPeriod.push({
        payoutDateISO: iso,
        refundIdDisplay: displayDocNumber(id) || '—',
        refundIdFull: id || '—',
        customer: String(r.customer || '').trim() || '—',
        quotationRefDisplay: displayDocNumber(r.quotationRef) || '—',
        amountNgn,
        bankAccount: isCash
          ? 'Cash'
          : abbreviateBankName(p.bankName) || String(p.accountName || '').trim() || '—',
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
