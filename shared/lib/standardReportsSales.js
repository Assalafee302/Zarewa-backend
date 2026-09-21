/**
 * Standard sales / AR report row builders (pure; used by GET /api/reports/*).
 */

import { receivableDueOnQuotationFromEntries } from './customerLedgerCore.js';
import { receiptEffectiveCashNgn } from './receiptClearance.js';
import {
  allocatedQuotationRevenueForProductionJob,
  metersProducedByQuotationRef,
  productionOutputDateISO,
} from './liveAnalytics.js';
import { displayDocNumber } from './reportDisplayFormat.js';
import { abbreviateBankName } from './bankAbbreviation.js';
import { REFUND_CREDIT_REVERSED_STATUS } from './refundCreditApply.js';

function toIsoDate(value) {
  return String(value || '').slice(0, 10);
}

function roundMoney(n) {
  return Math.round(Number(n) || 0);
}

function productionJobIsCompleted(job) {
  return String(job?.status || '').trim() === 'Completed';
}

function isActiveRefundCreditApplication(app) {
  const st = String(app?.status || '').trim().toLowerCase();
  if (!st) return true;
  return st !== REFUND_CREDIT_REVERSED_STATUS.toLowerCase() && st !== 'cancelled';
}

/**
 * Index active refund-credit applications by the sales receipt they offset on confirm.
 * @param {Array<{ sourceReceiptId?: string, amountNgn?: number, refundId?: string, applicationId?: string, status?: string }>} creditApplications
 * @returns {Map<string, { amountNgn: number, refundIds: string[], applicationIds: string[] }>}
 */
export function refundCreditBySourceReceiptId(creditApplications = []) {
  const m = new Map();
  for (const app of creditApplications || []) {
    if (!isActiveRefundCreditApplication(app)) continue;
    const rid = String(app.sourceReceiptId || app.source_receipt_id || '').trim();
    if (!rid) continue;
    const prev = m.get(rid) || { amountNgn: 0, refundIds: [], applicationIds: [] };
    prev.amountNgn += roundMoney(app.amountNgn ?? app.amount_ngn);
    const refundId = String(app.refundId || app.refund_id || '').trim();
    if (refundId && !prev.refundIds.includes(refundId)) prev.refundIds.push(refundId);
    const appId = String(app.applicationId || app.application_id || '').trim();
    if (appId && !prev.applicationIds.includes(appId)) prev.applicationIds.push(appId);
    m.set(rid, prev);
  }
  return m;
}

/**
 * Standalone refund-fund applies in period (ledger credit with no bank clearance receipt,
 * or confirm-payment credit lines for the audit sheet).
 * @param {Array<object>} creditApplications
 * @param {string} [startDate]
 * @param {string} [endDate]
 */
export function refundCreditApplyReportRows(creditApplications = [], startDate, endDate) {
  const rows = [];
  for (const app of creditApplications || []) {
    if (!isActiveRefundCreditApplication(app)) continue;
    const iso = toIsoDate(app.createdAtISO || app.created_at_iso);
    if (!iso) continue;
    if (startDate && iso < startDate) continue;
    if (endDate && iso > endDate) continue;
    const amountNgn = roundMoney(app.amountNgn ?? app.amount_ngn);
    if (amountNgn <= 0) continue;
    const refundId = String(app.refundId || app.refund_id || '').trim();
    const sourceQ = String(app.sourceQuotationRef || app.source_quotation_ref || '').trim();
    const targetQ = String(app.targetQuotationRef || app.target_quotation_ref || '').trim();
    const sourceReceiptId = String(app.sourceReceiptId || app.source_receipt_id || '').trim();
    rows.push({
      dateISO: iso,
      customer: String(app.customerName || app.customer || app.createdByName || '').trim() || '—',
      amountNgn,
      quotationRefFull: targetQ || '—',
      quotationRefDisplay: displayDocNumber(targetQ) || '—',
      sourceQuotationRefFull: sourceQ || '—',
      sourceQuotationRefDisplay: displayDocNumber(sourceQ) || '—',
      receiptIdFull: sourceReceiptId || '—',
      receiptIdDisplay: sourceReceiptId ? displayDocNumber(sourceReceiptId) || '—' : '—',
      bankPaidTo: 'Refund credit (no bank)',
      bankReference: String(app.ledgerBankReference || app.ledger_bank_reference || '').trim() || '—',
      paymentMethod: 'Refund credit',
      fundSource: 'Refund credit',
      refundCreditAppliedNgn: amountNgn,
      refundCreditFromRefundIds: refundId || '—',
      refundCreditApplicationId: String(app.applicationId || app.application_id || '').trim() || '—',
      fundNote: refundId
        ? `₦${amountNgn.toLocaleString('en-NG')} used from refund ${displayDocNumber(refundId) || refundId}`
        : `₦${amountNgn.toLocaleString('en-NG')} used from refund fund`,
      ledgerEntryId: '',
      rowKind: 'refund_credit',
    });
  }
  rows.sort(
    (a, b) =>
      a.dateISO.localeCompare(b.dateISO) ||
      String(a.refundCreditApplicationId).localeCompare(String(b.refundCreditApplicationId))
  );
  return rows;
}

/**
 * Map ledger entry id → treasury bank label (first LEDGER_RECEIPT split per entry).
 * Prefers the receiving bank's short code (e.g. "GTB") over the internal
 * treasury account name, so a printed report can be reconciled against a
 * bank statement at a glance. Falls back to the account name when no bank
 * name is on record (e.g. cash tills, or older data missing the bank field).
 * @param {Array<{ sourceKind?: string, sourceId?: string, accountName?: string, accountNo?: string, bankName?: string }>} treasuryMovements
 * @returns {Map<string, string>}
 */
export function treasuryAccountLabelByLedgerEntryId(treasuryMovements = []) {
  const m = new Map();
  for (const t of treasuryMovements || []) {
    if (String(t.sourceKind || '') !== 'LEDGER_RECEIPT') continue;
    const id = String(t.sourceId || '').trim();
    if (!id) continue;
    const bankCode = abbreviateBankName(t.bankName);
    const label = bankCode
      ? [bankCode, t.accountNo].filter(Boolean).join(' · ')
      : [t.accountName, t.accountNo].filter(Boolean).join(' · ');
    if (!m.has(id)) m.set(id, label || '—');
  }
  return m;
}

/**
 * @param {Array<{ id?: string, bankReference?: string, paymentMethod?: string }>} ledgerEntries
 * @param {Array<{ sourceKind?: string, sourceId?: string, accountName?: string, accountNo?: string }>} treasuryMovements
 * @param {Array<object>} [creditApplications] active/reversed refund_credit_applications for fundSource audit
 */
export function receiptsRegisterReportRows(
  salesReceipts = [],
  ledgerEntries = [],
  treasuryMovements = [],
  startDate,
  endDate,
  creditApplications = []
) {
  const ledgerMap = new Map(
    (ledgerEntries || []).map((e) => [String(e.id || '').trim(), e]).filter(([k]) => k)
  );
  const tmMap = treasuryAccountLabelByLedgerEntryId(treasuryMovements);
  const creditByReceipt = refundCreditBySourceReceiptId(creditApplications);

  const rows = [];
  for (const r of salesReceipts || []) {
    const iso = toIsoDate(r.dateISO);
    if (!iso) continue;
    if (startDate && iso < startDate) continue;
    if (endDate && iso > endDate) continue;
    const lid = r.ledgerEntryId != null ? String(r.ledgerEntryId).trim() : '';
    const le = lid ? ledgerMap.get(lid) : null;
    const cashNgn = receiptEffectiveCashNgn(r);
    const receiptId = String(r.id || '').trim();
    const creditInfo = receiptId ? creditByReceipt.get(receiptId) : null;
    const refundCreditAppliedNgn = roundMoney(creditInfo?.amountNgn);
    const refundIds = Array.isArray(creditInfo?.refundIds) ? creditInfo.refundIds : [];
    let fundSource = 'Bank/Cash';
    if (refundCreditAppliedNgn > 0 && cashNgn > 0) fundSource = 'Mixed';
    else if (refundCreditAppliedNgn > 0) fundSource = 'Refund credit';
    const methodRaw = String(r.method || le?.paymentMethod || '').trim();
    const paymentMethod =
      fundSource === 'Refund credit'
        ? 'Refund credit'
        : fundSource === 'Mixed'
          ? methodRaw
            ? `${methodRaw} + Refund credit`
            : 'Mixed (bank/cash + refund credit)'
          : methodRaw || '—';
    const bankPaidToRaw = (lid && tmMap.get(lid)) || le?.paymentMethod || r.method || '—';
    const bankPaidTo =
      fundSource === 'Refund credit'
        ? 'Refund credit (no bank)'
        : fundSource === 'Mixed'
          ? `${String(bankPaidToRaw).trim() || '—'} + Refund credit`
          : String(bankPaidToRaw).trim() || '—';
    const qref = String(r.quotationRef || '').trim();
    const fundNote =
      refundCreditAppliedNgn > 0
        ? `₦${refundCreditAppliedNgn.toLocaleString('en-NG')} from refund${
            refundIds.length ? ` ${refundIds.map((id) => displayDocNumber(id) || id).join(', ')}` : ''
          }`
        : '';
    rows.push({
      dateISO: iso,
      customer: String(r.customer || '').trim() || '—',
      amountNgn: cashNgn,
      refundCreditAppliedNgn,
      settledAmountNgn: cashNgn + refundCreditAppliedNgn,
      quotationRefFull: qref || '—',
      quotationRefDisplay: displayDocNumber(qref) || '—',
      receiptIdFull: receiptId || '—',
      receiptIdDisplay: displayDocNumber(r.id) || '—',
      bankPaidTo,
      bankReference: String(le?.bankReference || r.bankReference || '').trim() || '—',
      paymentMethod,
      fundSource,
      refundCreditFromRefundIds: refundIds.length ? refundIds.join(', ') : '',
      fundNote,
      ledgerEntryId: lid || '',
      rowKind: 'receipt',
    });
  }
  rows.sort((a, b) => a.dateISO.localeCompare(b.dateISO) || a.receiptIdFull.localeCompare(b.receiptIdFull));
  return rows;
}

function earliestCompletedProductionIsoForQuote(quotationRef, productionJobs) {
  const ref = String(quotationRef || '').trim();
  if (!ref) return null;
  let min = null;
  for (const j of productionJobs || []) {
    if (!productionJobIsCompleted(j)) continue;
    const jr = String(j.quotationRef ?? j.quotation_ref ?? '').trim();
    if (jr !== ref) continue;
    const iso = productionOutputDateISO(j);
    if (!iso) continue;
    if (!min || iso < min) min = iso;
  }
  return min;
}

/**
 * Bridge: receipts in period with production timing vs report end.
 * @param {string} asAtISO — typically period end date YYYY-MM-DD
 */
export function salesBridgeReportRows(salesReceipts = [], productionJobs = [], startDate, endDate, asAtISO) {
  const asAt = toIsoDate(asAtISO || endDate);
  const rows = [];
  for (const r of salesReceipts || []) {
    const iso = toIsoDate(r.dateISO);
    if (!iso) continue;
    if (startDate && iso < startDate) continue;
    if (endDate && iso > endDate) continue;
    const qref = String(r.quotationRef || '').trim();
    const firstProd = earliestCompletedProductionIsoForQuote(qref, productionJobs);
    let bridgeCategory = 'Not_produced_by_period_end';
    if (firstProd && asAt && firstProd <= asAt) {
      const rm = iso.slice(0, 7);
      const pm = firstProd.slice(0, 7);
      bridgeCategory = rm === pm ? 'Produced_same_month_as_receipt' : 'Produced_later_than_receipt_month';
    } else if (firstProd && asAt && firstProd > asAt) {
      bridgeCategory = 'Not_produced_by_period_end';
    }
    rows.push({
      receiptDate: iso,
      customer: String(r.customer || '').trim() || '—',
      amountNgn: Math.round(Number(r.amountNgn) || 0),
      quotationRefDisplay: displayDocNumber(qref) || '—',
      quotationRefFull: qref || '—',
      firstProductionDate: firstProd || '',
      bridgeCategory,
    });
  }
  rows.sort((a, b) => a.receiptDate.localeCompare(b.receiptDate));
  return rows;
}

/**
 * Accrual revenue lines: completed jobs in range with metre-share allocation.
 */
export function revenueProductionReportRows(quotations = [], productionJobs = [], startDate, endDate) {
  const qById = new Map((quotations || []).map((q) => [String(q.id ?? '').trim(), q]));
  const metersByRef = metersProducedByQuotationRef(productionJobs);
  const rows = [];
  for (const j of productionJobs || []) {
    if (!productionJobIsCompleted(j)) continue;
    const prodIso = productionOutputDateISO(j);
    if (!prodIso) continue;
    if (startDate && prodIso < startDate) continue;
    if (endDate && prodIso > endDate) continue;
    const ref = String(j.quotationRef ?? j.quotation_ref ?? '').trim();
    const q = ref ? qById.get(ref) : null;
    const revenueNgn = Math.round(allocatedQuotationRevenueForProductionJob(j, q, metersByRef));
    if (revenueNgn <= 0 && !ref) continue;
    rows.push({
      productionDate: prodIso,
      quotationRefDisplay: displayDocNumber(ref) || '—',
      quotationRefFull: ref || '—',
      customer: String(j.customerName ?? j.customer_name ?? q?.customer ?? '').trim() || '—',
      jobIdDisplay: displayDocNumber(j.jobID ?? j.job_id) || '—',
      jobIdFull: String(j.jobID ?? j.job_id ?? '').trim() || '—',
      revenueNgn,
      metres: Number(j.actualMeters ?? j.actual_meters) || 0,
    });
  }
  rows.sort((a, b) => a.productionDate.localeCompare(b.productionDate) || a.jobIdFull.localeCompare(b.jobIdFull));
  return rows;
}

/**
 * AR listing: balance due only on quotations with completed production (pending balance on delivered work).
 */
export function arAsAtReportRows(quotations = [], ledgerEntries = [], productionJobs = []) {
  const rows = [];
  for (const q of quotations || []) {
    const due = receivableDueOnQuotationFromEntries(ledgerEntries, q, productionJobs);
    if (due <= 0) continue;
    const id = String(q.id ?? '').trim();
    rows.push({
      quotationRefDisplay: displayDocNumber(id) || '—',
      quotationRefFull: id || '—',
      customer: String(q.customer || '').trim() || '—',
      totalNgn: Math.round(Number(q.totalNgn) || 0),
      paidNgn: Math.round(Number(q.paidNgn) || 0),
      balanceDueNgn: Math.round(due),
      status: String(q.status || '').trim() || '—',
    });
  }
  rows.sort((a, b) => b.balanceDueNgn - a.balanceDueNgn || a.quotationRefFull.localeCompare(b.quotationRefFull));
  return rows;
}
