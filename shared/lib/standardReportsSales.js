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

function uniqueIds(ids) {
  const out = [];
  for (const id of ids || []) {
    const s = String(id || '').trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

function displayReportDoc(ref) {
  const s = String(ref || '').trim();
  if (!s || s === '—') return '';
  return displayDocNumber(s) || s;
}

function formatReportNgn(amountNgn) {
  return `₦${roundMoney(amountNgn).toLocaleString('en-NG')}`;
}

function quotationRefOfReceipt(row) {
  return String(row?.quotationRef || row?.quotation_ref || '').trim();
}

function receiptIdOf(row) {
  return String(row?.id || '').trim();
}

function appText(app, camel, snake) {
  return String(app?.[camel] ?? app?.[snake] ?? '').trim();
}

/**
 * Receipts that originally brought the money in on the refund's quotation.
 * Skips the receipt that later consumed the refund.
 * @param {object} app
 * @param {Array<object>} [salesReceipts]
 * @returns {string[]}
 */
export function originReceiptIdsForApplication(app, salesReceipts = []) {
  const consuming = appText(app, 'sourceReceiptId', 'source_receipt_id');
  const explicit = uniqueIds(app?.originReceiptIds || app?.origin_receipt_ids).filter((id) => id !== consuming);
  if (explicit.length) return explicit;
  const sourceQ = appText(app, 'sourceQuotationRef', 'source_quotation_ref');
  if (!sourceQ) return [];
  return uniqueIds(
    (salesReceipts || [])
      .filter((row) => {
        if (quotationRefOfReceipt(row) !== sourceQ) return false;
        const id = receiptIdOf(row);
        if (!id || id === consuming) return false;
        return String(row?.status || '').trim().toLowerCase() !== 'reversed';
      })
      .map(receiptIdOf)
  );
}

/**
 * Printed method once finance has confirmed the receipt from a refund.
 * Cashier till names stay off this phrase. Amount is included only for a split line.
 * @param {{ refundIds?: string[], originReceiptIds?: string[], sourceQuotationRefs?: string[], amountNgn?: number | null }} parts
 */
export function formatFromRefundPaymentMethod(parts = {}) {
  const refunds = uniqueIds(parts.refundIds).map(displayReportDoc).filter(Boolean);
  const origins = uniqueIds(parts.originReceiptIds).map(displayReportDoc).filter(Boolean);
  const quotes = uniqueIds(parts.sourceQuotationRefs).map(displayReportDoc).filter(Boolean);
  let text = 'From refund';
  if (refunds.length) text += ` ${refunds.join(', ')}`;
  if (origins.length) text += ` · receipt ${origins.join(', ')}`;
  else if (quotes.length) text += ` · quotation ${quotes.join(', ')}`;
  if (parts.amountNgn != null) text += ` ${formatReportNgn(parts.amountNgn)}`;
  return text;
}

/**
 * Refund-report line: which new receipt used the refund, and which receipt the money came from.
 * @param {{ amountNgn?: number, consumingReceiptId?: string, targetQuotationRef?: string, originReceiptIds?: string[], sourceQuotationRef?: string }} parts
 */
export function formatRefundReceiptUsageNote(parts = {}) {
  const usedReceipt = displayReportDoc(parts.consumingReceiptId);
  const targetQ = displayReportDoc(parts.targetQuotationRef);
  const origins = uniqueIds(parts.originReceiptIds).map(displayReportDoc).filter(Boolean);
  const sourceQ = displayReportDoc(parts.sourceQuotationRef);
  let used = 'another quotation';
  if (usedReceipt && targetQ) used = `receipt ${usedReceipt} (${targetQ})`;
  else if (usedReceipt) used = `receipt ${usedReceipt}`;
  else if (targetQ) used = `quotation ${targetQ}`;
  let from = '';
  if (origins.length && sourceQ) from = `, from receipt ${origins.join(', ')} (${sourceQ})`;
  else if (origins.length) from = `, from receipt ${origins.join(', ')}`;
  else if (sourceQ) from = `, from quotation ${sourceQ}`;
  return `${formatReportNgn(parts.amountNgn)} used on ${used}${from}`;
}

/**
 * Active credit applications that settled this receipt.
 * Direct link is the receipt stored at confirm. If that link was never stored and the
 * target quotation has exactly one receipt, that receipt is the one.
 * @param {object} receipt
 * @param {Array<object>} creditApplications
 * @param {Array<object>} [salesReceipts]
 */
export function refundCreditApplicationsForReceipt(receipt, creditApplications = [], salesReceipts = []) {
  const id = receiptIdOf(receipt);
  const ledgerId = String(receipt?.ledgerEntryId || receipt?.ledger_entry_id || '').trim();
  const active = (creditApplications || []).filter(isActiveRefundCreditApplication);
  const direct = active.filter((app) => {
    const src = appText(app, 'sourceReceiptId', 'source_receipt_id');
    return Boolean(src) && (src === id || (ledgerId && src === ledgerId));
  });
  if (direct.length) return direct;
  const target = quotationRefOfReceipt(receipt);
  if (!target || !id) return [];
  const unlinked = active.filter((app) => {
    const src = appText(app, 'sourceReceiptId', 'source_receipt_id');
    return !src && appText(app, 'targetQuotationRef', 'target_quotation_ref') === target;
  });
  if (!unlinked.length) return [];
  const mates = (salesReceipts || []).filter((row) => {
    if (quotationRefOfReceipt(row) !== target) return false;
    return String(row?.status || '').trim().toLowerCase() !== 'reversed';
  });
  if (mates.length === 1 && receiptIdOf(mates[0]) === id) return unlinked;
  return [];
}

/**
 * @param {Array<object>} apps
 * @param {Array<object>} [salesReceipts]
 */
export function summarizeRefundCreditApplications(apps = [], salesReceipts = []) {
  const refundIds = [];
  const applicationIds = [];
  const sourceQuotationRefs = [];
  const originReceiptIds = [];
  let amountNgn = 0;
  for (const app of apps || []) {
    amountNgn += roundMoney(app.amountNgn ?? app.amount_ngn);
    const refundId = appText(app, 'refundId', 'refund_id');
    if (refundId && !refundIds.includes(refundId)) refundIds.push(refundId);
    const appId = appText(app, 'applicationId', 'application_id');
    if (appId && !applicationIds.includes(appId)) applicationIds.push(appId);
    const sourceQ = appText(app, 'sourceQuotationRef', 'source_quotation_ref');
    if (sourceQ && !sourceQuotationRefs.includes(sourceQ)) sourceQuotationRefs.push(sourceQ);
    for (const originId of originReceiptIdsForApplication(app, salesReceipts)) {
      if (!originReceiptIds.includes(originId)) originReceiptIds.push(originId);
    }
  }
  return { amountNgn: roundMoney(amountNgn), refundIds, applicationIds, sourceQuotationRefs, originReceiptIds };
}

/**
 * Till name stays only for money that actually hit that account.
 * @param {{ methodRaw?: string, cashNgn?: number, credit?: { amountNgn?: number, refundIds?: string[], originReceiptIds?: string[], sourceQuotationRefs?: string[] } | null }} parts
 */
export function paymentMethodLabelForReceiptFund(parts = {}) {
  const credit = parts.credit;
  const cashNgn = roundMoney(parts.cashNgn);
  const methodRaw = String(parts.methodRaw || '').trim();
  if (!credit || roundMoney(credit.amountNgn) <= 0) return methodRaw || '—';
  const phrase = {
    refundIds: credit.refundIds,
    originReceiptIds: credit.originReceiptIds,
    sourceQuotationRefs: credit.sourceQuotationRefs,
  };
  if (cashNgn <= 0) return formatFromRefundPaymentMethod(phrase);
  const cashLabel = formatReportNgn(cashNgn);
  const cashPart = methodRaw ? `${methodRaw} ${cashLabel}` : cashLabel;
  const creditPart = formatFromRefundPaymentMethod({ ...phrase, amountNgn: credit.amountNgn });
  return `${cashPart} · ${creditPart}`;
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
    const rid = appText(app, 'sourceReceiptId', 'source_receipt_id');
    if (!rid) continue;
    const prev = m.get(rid) || { amountNgn: 0, refundIds: [], applicationIds: [] };
    prev.amountNgn += roundMoney(app.amountNgn ?? app.amount_ngn);
    const refundId = appText(app, 'refundId', 'refund_id');
    if (refundId && !prev.refundIds.includes(refundId)) prev.refundIds.push(refundId);
    const appId = appText(app, 'applicationId', 'application_id');
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
export function refundCreditApplyReportRows(creditApplications = [], startDate, endDate, salesReceipts = []) {
  const rows = [];
  for (const app of creditApplications || []) {
    if (!isActiveRefundCreditApplication(app)) continue;
    const iso = toIsoDate(app.createdAtISO || app.created_at_iso);
    if (!iso) continue;
    if (startDate && iso < startDate) continue;
    if (endDate && iso > endDate) continue;
    const amountNgn = roundMoney(app.amountNgn ?? app.amount_ngn);
    if (amountNgn <= 0) continue;
    const refundId = appText(app, 'refundId', 'refund_id');
    const sourceQ = appText(app, 'sourceQuotationRef', 'source_quotation_ref');
    const targetQ = appText(app, 'targetQuotationRef', 'target_quotation_ref');
    const sourceReceiptId = appText(app, 'sourceReceiptId', 'source_receipt_id');
    const originReceiptIds = originReceiptIdsForApplication(app, salesReceipts);
    const paymentMethod = formatFromRefundPaymentMethod({
      refundIds: refundId ? [refundId] : [],
      originReceiptIds,
      sourceQuotationRefs: sourceQ ? [sourceQ] : [],
    });
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
      originReceiptIds: originReceiptIds.join(', '),
      originReceiptDisplay: originReceiptIds.map(displayReportDoc).filter(Boolean).join(', ') || '—',
      bankPaidTo: paymentMethod,
      bankReference: String(app.ledgerBankReference || app.ledger_bank_reference || '').trim() || '—',
      paymentMethod,
      fundSource: 'Refund credit',
      refundCreditAppliedNgn: amountNgn,
      refundCreditFromRefundIds: refundId || '—',
      refundCreditApplicationId: appText(app, 'applicationId', 'application_id') || '—',
      fundNote: formatRefundReceiptUsageNote({
        amountNgn,
        consumingReceiptId: sourceReceiptId,
        targetQuotationRef: targetQ,
        originReceiptIds,
        sourceQuotationRef: sourceQ,
      }),
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
    if (t.amountNgn != null && roundMoney(t.amountNgn) === 0) continue;
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
    const creditApps = refundCreditApplicationsForReceipt(r, creditApplications, salesReceipts);
    const creditInfo = summarizeRefundCreditApplications(creditApps, salesReceipts);
    const refundCreditAppliedNgn = roundMoney(creditInfo.amountNgn);
    const refundIds = creditInfo.refundIds;
    let fundSource = 'Bank/Cash';
    if (refundCreditAppliedNgn > 0 && cashNgn > 0) fundSource = 'Mixed';
    else if (refundCreditAppliedNgn > 0) fundSource = 'Refund credit';
    const methodRaw = String(r.method || le?.paymentMethod || '').trim();
    const paymentMethod = paymentMethodLabelForReceiptFund({
      methodRaw,
      cashNgn,
      credit: refundCreditAppliedNgn > 0 ? creditInfo : null,
    });
    const bankPaidToRaw = (lid && tmMap.get(lid)) || le?.paymentMethod || r.method || '—';
    const bankPaidTo = refundCreditAppliedNgn > 0 ? paymentMethod : String(bankPaidToRaw).trim() || '—';
    const qref = String(r.quotationRef || '').trim();
    const fundNote =
      refundCreditAppliedNgn > 0
        ? creditApps
            .map((app) =>
              formatRefundReceiptUsageNote({
                amountNgn: app.amountNgn ?? app.amount_ngn,
                consumingReceiptId: receiptId,
                targetQuotationRef: qref || appText(app, 'targetQuotationRef', 'target_quotation_ref'),
                originReceiptIds: originReceiptIdsForApplication(app, salesReceipts),
                sourceQuotationRef: appText(app, 'sourceQuotationRef', 'source_quotation_ref'),
              })
            )
            .join('; ')
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
